import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  PermanentOrchestrationError,
  parseReportOrchestrationPayload,
} from "../src/trigger/contracts/report-orchestration.ts";
import {
  MAX_FINAL_ENRICHMENT_TARGETS,
  MAX_FINAL_ENRICHMENT_BATCHES,
  CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE,
  CRAWL_RESULT_CHECKPOINT_BATCH_INDEX,
  PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX,
  MAX_OPERATION_TIMEOUT_MS,
  comparisonWithinPrimaryCatalog,
  orchestrateReport,
  pricedResultEnrichmentBudget,
  productEvidenceReferenceTimeMs,
  validEnrichmentCheckpoint,
  validPublishedResultCheckpoint,
} from "../src/trigger/report-orchestration-core.ts";
import {
  checkpointReadPageBound,
  OPERATION_BUDGETS_MS,
  ORCHESTRATION_FETCH_TIMEOUT_MS,
  MAX_SUCCESS_BODY_BYTES,
  OrchestrationHttpError,
  WORST_CASE_CRITICAL_PATH_MS,
  createOrchestrationFetch,
  createReportOrchestrationHttpPort,
  isRetryableHttpStatus,
} from "../src/trigger/report-orchestration-http.ts";
import { planFinalProductEnrichmentTargets } from "../app/lib/product-intelligence.ts";
import { encodedJsonBytes, REPORT_CALLBACK_ENVELOPE_BYTES, REPORT_PRESENTATION_TARGET_BYTES } from "../src/shared/report-document-compaction.ts";
import { babanujScaleDocument } from "./fixtures/babanuj-report-document.mjs";
import { createWorkerApiManifest } from "../src/shared/worker-api-contract.ts";
import { AI_ACTION_PLANNER_LIMITS, deterministicProductActionResult } from "../app/lib/ai-action-planner.ts";
import { publishPricedProductComparison } from "../app/lib/product-match-lifecycle.ts";
import { judgeBatchKey } from "../app/lib/ai-product-matching.ts";

const payload = {
  contractVersion: "4",
  publicId: "a".repeat(32),
  primaryDomain: "shop.example",
  locale: "en",
  reportAttempt: 1,
  productPlan: "starter",
  productLimit: 20,
};

test("priced-result enrichment can exhaust the full bounded catalog regardless of publication target", () => {
  assert.equal(MAX_FINAL_ENRICHMENT_TARGETS, 7_000);
  assert.equal(MAX_FINAL_ENRICHMENT_BATCHES, 110);
  assert.equal(pricedResultEnrichmentBudget(20), MAX_FINAL_ENRICHMENT_TARGETS);
  assert.equal(pricedResultEnrichmentBudget(200), MAX_FINAL_ENRICHMENT_TARGETS);
  assert.equal(pricedResultEnrichmentBudget(1_000), MAX_FINAL_ENRICHMENT_TARGETS);
});

test("a late recovery validates prices against the fresh crawl observation rather than report creation", () => {
  const current = product("shop.example", "fresh-price");
  current.observedAt = "2026-08-22T12:00:00.000Z";
  assert.equal(productEvidenceReferenceTimeMs(
    [{ products: [current] }],
    "2026-08-19T12:00:00.000Z",
    Date.parse("2026-08-22T12:05:00.000Z"),
  ), Date.parse(current.observedAt));
});

test("a late recovery reference never advances beyond its production wall clock", () => {
  const wallClock = Date.parse("2026-08-22T12:05:00.000Z");
  const future = product("shop.example", "future-price");
  future.observedAt = "2026-08-23T12:05:00.000Z";
  assert.equal(productEvidenceReferenceTimeMs(
    [{ products: [future] }],
    "2026-08-19T12:00:00.000Z",
    wallClock,
  ), Date.parse("2026-08-19T12:00:00.000Z"));
  assert.ok(productEvidenceReferenceTimeMs(
    [{ products: [future] }],
    "2026-08-24T12:00:00.000Z",
    wallClock,
  ) <= wallClock);
});

test("a late recovery does not use a stale stored heartbeat as its wall clock", () => {
  const fresh = product("shop.example", "fresh-after-stale-heartbeat");
  fresh.observedAt = "2026-08-22T12:00:00.000Z";
  assert.equal(productEvidenceReferenceTimeMs(
    [{ products: [fresh] }],
    "2026-08-20T11:00:00.000Z",
    Date.parse("2026-08-22T12:05:00.000Z"),
  ), Date.parse(fresh.observedAt));
});

test("orchestration recovers judge checkpoints from every task-attempt namespace", async () => {
  const reads = [];
  const port = mockPort({
    async loadCheckpoint(_publicId, input) {
      reads.push(input);
      return [];
    },
  });
  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port);
  const judgeReads = reads.filter((input) => input.batchIndexStart >= 1_400);
  for (let taskAttemptOffset = 0; taskAttemptOffset < 10; taskAttemptOffset += 1) {
    const start = 1_400 + (taskAttemptOffset * 250);
    assert.ok(judgeReads.some((input) => input.batchIndexStart === start && input.batchIndexEnd === start + 249 && input.latestPerBatch === true), JSON.stringify(judgeReads));
  }
});

test("adopted judge evidence requires the exact current primary product identity", () => {
  const current = product("shop.example", "stable-id");
  current.quantity = { value: 500, unit: "g", normalized: "500g" };
  const adopted = comparison({ withPair: true, count: 1 });
  adopted.rows[0].primary = { ...current, quantity: { value: 1_000, unit: "g", normalized: "1000g" } };
  assert.equal(comparisonWithinPrimaryCatalog(adopted, [current]), null);
  adopted.rows[0].primary = structuredClone(current);
  assert.equal(comparisonWithinPrimaryCatalog(adopted, [current]).rows.length, 1);
});
const recoveryPayload = { ...payload, reportAttempt: 2 };

function product(domain = "shop.example", id = "p1") {
  return {
    id,
    domain,
    name: "Honey 500g",
    normalizedName: "honey 500g",
    description: "",
    category: "honey",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://${domain}/products/honey`,
    imageUrl: "",
    observedAt: "2026-07-20T10:00:00.000Z",
    claimIds: ["claim-p1"],
  };
}

function comparison({ withPair = false, count = withPair ? 20 : 1 } = {}) {
  const pairs = Array.from({ length: count }, (_, index) => {
    const suffix = index ? `-${index + 1}` : "";
    const primary = { ...product("shop.example", `p1${suffix}`), name: `Honey ${index + 1} 500g`, normalizedName: `honey ${index + 1} 500g`, sourceUrl: `https://shop.example/products/honey${suffix}?country=GB`, priceSignals: withPair ? [{ raw: "GBP 10", currency: "GBP", amount: 10 }] : [] };
    const rival = { ...product("rival.example", `r1${suffix}`), name: primary.name, normalizedName: primary.normalizedName, sourceUrl: `https://rival.example/products/honey${suffix}?country=GB`, priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
    return { primary, rival };
  });
  return {
    primaryDomain: "shop.example",
    marketCountryCode: "GB",
    comparisonDomains: ["rival.example"],
    rows: withPair ? pairs.map(({ primary, rival }) => ({ primary, matches: [{
      domain: rival.domain,
      product: rival,
      score: 0.9,
      confidence: "Medium",
      sharedTerms: ["honey"],
      claimIds: rival.claimIds,
      assessment: { verdict: "same_product", priceComparable: false, reasons: ["Observed product identity aligns."], contradictions: [], claimType: "Inferred" },
      decision: {
        priceVerdict: "No direct price comparison is available.",
        whyTheyMayWin: "The observed product identity aligns.",
        recommendedMove: "Compare the attributable offer before acting.",
        priceComparison: null,
      },
    }] })) : [],
    unmatched: [],
    coverage: {
      primaryProductsAvailable: count,
      primaryProductsScanned: count,
      primaryProductFamiliesCompared: withPair ? count : 0,
      competitorProductsAvailable: withPair ? count : 0,
      competitorProductsScanned: withPair ? count : 0,
      assignedPairCount: withPair ? count : 0,
      verifiedPairCount: withPair ? count : 0,
      rowsReturned: withPair ? count : 0,
      rowLimit: 30,
      truncated: false,
    },
    matching: {
      method: "ai-hybrid",
      available: true,
      model: "gpt-5.4-mini",
      embeddingModel: "text-embedding-3-small",
      promptVersion: "test",
      primaryProductsAssessed: withPair ? count : 0,
      candidatePairsAssessed: withPair ? count : 0,
      retrievalPairsScored: withPair ? count : 0,
      judgeCalls: withPair ? count : 0,
      embeddingCalls: withPair ? count : 0,
      durationMs: 1,
      gaps: [],
      selectedPrimaryIds: withPair ? pairs.map(({ primary }) => primary.id) : [],
      assessedPrimaryIds: withPair ? pairs.map(({ primary }) => primary.id) : [],
      attempts: 1,
    },
  };
}

async function persistJudgeEvidence(port, value, envelopeBatchIndex = 1_400) {
  const row = value.rows.find((candidate) => candidate.matches.some((match) => match.product));
  const rival = row?.matches.find((match) => match.product)?.product;
  assert.ok(row && rival);
  const groups = [{ primary: row.primary, candidates: [{ product: rival, retrievalScore: 1, lexicalScore: 1, lexicalEligible: true, semanticScore: 1, identitySignal: true }] }];
  const key = judgeBatchKey(value.matching.model, groups, 0, 1);
  await port.saveCheckpoint(payload.publicId, {
    attemptNumber: 1,
    batchIndex: envelopeBatchIndex,
    inputHash: key.batchHash,
    result: {
      version: 2,
      batchHash: key.batchHash,
      batchIndex: key.batchIndex,
      batchCount: key.batchCount,
      model: key.model,
      promptVersion: key.promptVersion,
      evidenceGroups: [{ primary: row.primary, candidates: [rival] }],
      assessments: [{ primaryId: row.primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.98, reason: "Observed product identity aligns.", contradiction: "" }],
    },
  });
}

test("published checkpoint validation rejects any evidence edge lost during revalidation", () => {
  const referenceTimeMs = Date.parse("2026-07-20T10:01:00.000Z");
  const recoveryIdentityHash = "a".repeat(64);
  const published = publishPricedProductComparison(comparison({ withPair: true, count: 1 }), referenceTimeMs);
  published.rows[0].primary.recoveryIdentityHash = recoveryIdentityHash;
  const evidence = structuredClone(published);
  const invalidBackup = structuredClone(evidence.rows[0].matches[0]);
  invalidBackup.product.id = "rival-invalid-backup";
  invalidBackup.product.sourceUrl = "https://other.example/products/honey?country=GB";
  invalidBackup.publication = { priceEligible: true };
  evidence.rows[0].matches.push(invalidBackup);

  const key = `${published.rows[0].primary.id}\nshop.example`;
  assert.equal(validPublishedResultCheckpoint(
    { version: 3, comparison: published, evidence },
    20,
    referenceTimeMs,
    new Set([key]),
    new Map([[key, recoveryIdentityHash]]),
  ), null);
});

test("enrichment checkpoint validation rejects an outcome from a different explicit market", () => {
  const target = { domain: "rival.example", productId: "r1", sourceUrl: "https://rival.example/en-US/products/honey", expectedName: "Honey", role: "rival" };
  const outcome = { ...product("rival.example", "r1"), sourceUrl: "https://rival.example/ar-SA/products/honey", priceSignals: [{ raw: "SAR 30", currency: "SAR", amount: 30 }] };
  const checkpoint = { ok: true, products: [outcome], coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] } };

  assert.equal(validEnrichmentCheckpoint(checkpoint, [target]), null);
});

test("enrichment checkpoint validation rejects forged retry metadata", () => {
  const target = { domain: "rival.example", productId: "r1", sourceUrl: "https://rival.example/products/honey", expectedName: "Honey", role: "rival" };
  const base = { ok: true, products: [], coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: 1, gaps: [{ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Temporary network failure.", code: "fetch_failed", failureKind: "network", httpStatus: 0 }] } };
  assert.ok(validEnrichmentCheckpoint(base, [target]));
  for (const gap of [
    { ...base.coverage.gaps[0], role: "primary" },
    { ...base.coverage.gaps[0], reason: 42 },
    { ...base.coverage.gaps[0], code: "paid_retry_please" },
    { ...base.coverage.gaps[0], failureKind: "forged" },
    { ...base.coverage.gaps[0], httpStatus: 999 },
    { ...base.coverage.gaps[0], code: undefined },
    { ...base.coverage.gaps[0], failureKind: undefined },
  ]) assert.equal(validEnrichmentCheckpoint({ ...base, coverage: { ...base.coverage, gaps: [gap] } }, [target]), null);
});

function mockPort(overrides = {}) {
  const events = [];
  const saves = [];
  const factChunks = [];
  const factManifests = [];
  const checkpoints = new Map();
  const port = {
    events,
    saves,
    factChunks,
    factManifests,
    checkpoints,
    async preflight() {},
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 1, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z", productPlan: "starter", productLimit: 20 },
        events: [],
      };
    },
    async appendEvent(_publicId, value) { events.push(value); },
    async crawl() {
      const primaryProducts = comparison({ withPair: true }).rows.map((row) => row.primary);
      return {
        ok: true,
        primaryDomain: payload.primaryDomain,
        results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example" }, products: primaryProducts }],
        discovery: { productSearchCoverage: { eligibleAnchors: 1, searchedAnchors: 1, startIndex: 0, endIndex: 1, truncated: false, searchesComplete: true, candidateDomainsFound: 1, candidateDomainsInvestigated: 1, candidateTruncated: false, verificationComplete: true, batchComplete: true, complete: true } },
        adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" },
        document: { version: "1", blocks: [] },
      };
    },
    async brief() { return { ok: true, summary: "Observed market" }; },
    async ads() { return { ok: true, block: { type: "ad-intelligence", id: "ad-intelligence" } }; },
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich({ targets }) { return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: targets.length, gaps: targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Test fixture did not fetch this page.", code: "fetch_failed", failureKind: "content" })) } }; },
    async loadCheckpoint(_publicId, input) {
      let values = input.batchIndex === undefined ? [...checkpoints.values()] : checkpoints.has(input.batchIndex) ? [checkpoints.get(input.batchIndex)] : [];
      if (input.batchIndexStart !== undefined) values = values.filter((item) => item.batchIndex >= input.batchIndexStart && item.batchIndex <= input.batchIndexEnd);
      if (input.latestPerBatch) {
        const latest = new Map();
        for (const item of values) if (!latest.has(item.batchIndex) || latest.get(item.batchIndex).attemptNumber < item.attemptNumber) latest.set(item.batchIndex, item);
        values = [...latest.values()];
      }
      values.sort((left, right) => right.attemptNumber - left.attemptNumber || left.batchIndex - right.batchIndex);
      return input.limit === undefined ? values : values.slice(0, input.limit);
    },
    async saveCheckpoint(_publicId, input) {
      const existing = checkpoints.get(input.batchIndex);
      if (existing && (existing.inputHash !== input.inputHash || JSON.stringify(existing.result) !== JSON.stringify(input.result))) throw new Error("checkpoint conflict");
      checkpoints.set(input.batchIndex, { attemptNumber: input.attemptNumber, batchIndex: input.batchIndex, inputHash: input.inputHash, result: input.result });
    },
    async actions({ inputs }) { return { ok: true, result: deterministicProductActionResult(inputs) }; },
    async persistFactChunk(_publicId, value) { factChunks.push(value); },
    async finalizeFactManifest(_publicId, value) { factManifests.push(value); },
    async saveDocument(_publicId, value) { saves.push(value); },
    ...overrides,
  };
  return port;
}

test("payload contract accepts only a canonical, exact, versioned payload", () => {
  assert.deepEqual(parseReportOrchestrationPayload(payload), payload);
  assert.deepEqual(parseReportOrchestrationPayload({ contractVersion: "2", publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, reportAttempt: 1 }), { ...payload, productPlan: "starter", productLimit: 20 });
  assert.deepEqual(parseReportOrchestrationPayload({ ...payload, contractVersion: "3", productPlan: "agency", productLimit: 1_000 }), { ...payload, productPlan: "agency", productLimit: 1_000 });
  for (const invalid of [
    { ...payload, primaryDomain: "https://shop.example" },
    { ...payload, primaryDomain: "Shop.example" },
    { ...payload, publicId: "nope" },
    { ...payload, locale: "fr" },
    { ...payload, callbackUrl: "https://attacker.example" },
    { ...payload, contractVersion: "1" },
    { ...payload, reportAttempt: 0 },
    { ...payload, productPlan: "agency", productLimit: 1_000 },
    { ...payload, productPlan: "unlimited", productLimit: 1_000 },
  ]) assert.throws(() => parseReportOrchestrationPayload(invalid), PermanentOrchestrationError);
});

test("successful orchestration persists ordered heartbeats and a complete document", async () => {
  const base = mockPort();
  const port = mockPort({
    async crawl(input) {
      assert.equal(input.productLimit, 20);
      assert.equal(input.catalogProductLimit, 1_000);
      assert.equal(input.discoverySearchOffset, 0);
      assert.equal(input.discoveryPriorCoverageComplete, true);
      return base.crawl();
    },
    async match(input) {
    assert.equal(input.productLimit, 20);
    return { ok: true, comparison: comparison({ withPair: true }) };
  } });
  const dates = ["2026-07-20T10:00:00.000Z", "2026-07-20T10:01:00.000Z"];
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port, () => new Date(dates.shift()));

  assert.equal(result.reportStatus, "complete");
  assert.deepEqual(result.limitedPhases, []);
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].status, "complete");
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-crawl-started")));
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-ads-complete")));
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-matching-complete")));
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-facts-complete")));
  assert.equal(port.factChunks.length, 4);
  assert.deepEqual(port.factManifests[0].counts, { companies: 2, products: 40, matches: 20, ads: 0 });
  assert.equal(port.events.some((item) => item.idempotencyKey.startsWith("brief-")), false);
  assert.equal(port.saves[0].document.marketBrief, null);
  const compaction = port.saves[0].document.document.blocks.find((block) => block.type === "presentation-compaction");
  assert.equal(compaction.relationalFactsAuthoritative, true);
  assert.deepEqual(compaction.factCounts, { companies: 2, products: 40, matches: 20, ads: 0 });
});

test("a task retry resumes the durable successful crawl without another network crawl", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() { crawlCalls += 1; return base.crawl(); },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port);
  assert.equal(crawlCalls, 1);
  assert.ok(port.checkpoints.has(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE));
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"));
});

test("a large noisy crawl is compacted into a durable checkpoint before a task retry", async () => {
  let crawlCalls = 0;
  const base = mockPort();
  let rawWireBytes = 0;
  let expectedCatalogs = null;
  let expectedBaseline = null;
  const matchedCatalogs = [];
  const port = mockPort({
    async crawl() {
      crawlCalls += 1;
      const value = await base.crawl();
      value.results[0].products[0] = {
        ...value.results[0].products[0],
        imageUrl: "https://cdn.shop.example/images/honey-500g.webp",
        aliases: [{ name: "عسل 500 جرام", normalizedName: "عسل 500 جرام", locale: "ar", sourceUrl: "https://shop.example/ar/honey", extraction: "sitemap" }],
        claimIds: ["claim-identity-1", "claim-identity-2"],
      };
      const baseline = { type: "product-comparison", id: "product-comparison", ...comparison({ withPair: true, count: 1 }) };
      baseline.rows[0].primary = structuredClone(value.results[0].products[0]);
      value.document.blocks.push(baseline);
      expectedCatalogs = value.results.map((result) => ({ domain: result.domain, products: structuredClone(result.products) }));
      expectedBaseline = structuredClone(baseline);
      value.results[0].pages = Array.from({ length: 1_200 }, (_, pageIndex) => ({
        url: `https://shop.example/products/page-${pageIndex}`,
        sourceUrl: `https://shop.example/products/page-${pageIndex}`,
        internalLinks: Array.from({ length: 20 }, (__, linkIndex) => `https://shop.example/products/${pageIndex}-${linkIndex}-${createHash("sha256").update(`link:${pageIndex}:${linkIndex}`).digest("hex")}`),
        claims: Array.from({ length: 20 }, (__, claimIndex) => ({
          id: `claim-${pageIndex}-${claimIndex}`,
          text: Array.from({ length: 4 }, (___, part) => createHash("sha256").update(`claim:${pageIndex}:${claimIndex}:${part}`).digest("hex")).join(""),
          sourceUrl: `https://shop.example/products/page-${pageIndex}`,
        })),
        products: value.results[0].products,
      }));
      value.results[0].enrichmentPages = value.results[0].pages.slice(0, 16);
      rawWireBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      return value;
    },
    async match(input) {
      matchedCatalogs.push(structuredClone(input.catalogs));
      return { ok: true, comparison: comparison({ withPair: false }) };
    },
    async persistFactChunk() { throw new Error("test persistence interruption"); },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /Relational fact persistence remained incomplete/);
  assert.ok(rawWireBytes > 4_000_000);
  const checkpoint = port.checkpoints.get(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE);
  assert.ok(checkpoint);
  assert.ok(JSON.stringify(checkpoint.result).length < 3_900_000);
  const recovered = JSON.parse(gunzipSync(Buffer.from(checkpoint.result.data, "base64")).toString("utf8"));
  assert.deepEqual(recovered.results.map((result) => ({ domain: result.domain, products: result.products })), expectedCatalogs);
  assert.deepEqual(recovered.document.blocks.find((block) => block.type === "product-comparison"), expectedBaseline);
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port), /Relational fact persistence remained incomplete/);
  assert.equal(crawlCalls, 1);
  assert.deepEqual(matchedCatalogs.at(-1), expectedCatalogs);
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"));
});

test("a later task attempt cannot replace a durable successful crawl with an HTTP 403", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      crawlCalls += 1;
      if (crawlCalls > 1) throw Object.assign(new Error("homepage returned HTTP 403"), { errorCode: "primary-page-unavailable" });
      const value = await base.crawl();
      return { ...value, discovery: { productSearchCoverage: { ...value.discovery.productSearchCoverage, complete: false } } };
    },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(crawlCalls, 2);
  assert.equal(port.events.some((item) => item.idempotencyKey === "crawl-failed"), false);
});

test("a corrupt active-attempt crawl checkpoint fails closed before another network crawl", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() { crawlCalls += 1; return base.crawl(); },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  port.checkpoints.get(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE).result.data = "not-gzip";
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /active report attempt contains an invalid crawl checkpoint/,
  );
  assert.equal(crawlCalls, 1);
  assert.equal(port.checkpoints.has(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1), false);
});

test("crawl checkpoint recovery validates newest-first and never expands older history after a valid hit", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() { crawlCalls += 1; return base.crawl(); },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const valid = port.checkpoints.get(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE);
  const taskTwoInputHash = createHash("sha256").update(JSON.stringify({
    version: 1,
    publicId: payload.publicId,
    primaryDomain: payload.primaryDomain,
    reportAttempt: payload.reportAttempt,
    productPlan: payload.productPlan,
    productLimit: payload.productLimit,
    taskAttemptNumber: 2,
  })).digest("hex");
  port.checkpoints.set(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1, { ...valid, batchIndex: CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1, inputHash: taskTwoInputHash });
  Object.defineProperty(valid, "result", { get() { throw new Error("older checkpoint must not be expanded"); } });
  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port);
  assert.equal(crawlCalls, 1);
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"));
});

test("a pre-existing active-attempt crawl conflict cannot resume an older complete crawl", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() { crawlCalls += 1; return base.crawl(); },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const older = port.checkpoints.get(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE);
  port.checkpoints.set(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1, {
    ...older,
    attemptNumber: 1,
    batchIndex: CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1,
    inputHash: "f".repeat(64),
  });

  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /active report attempt contains a conflicting crawl checkpoint/,
  );
  assert.equal(crawlCalls, 1);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"), false);
});

test("lossless crawl checkpoint overflow fails closed before downstream processing", async () => {
  let matchCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      const value = await base.crawl();
      value.results[0].products[0].claimIds = Array.from({ length: 100_000 }, (_, index) => createHash("sha256").update(`oversized-claim:${index}`).digest("hex"));
      return value;
    },
    async match() { matchCalls += 1; return { ok: true, comparison: comparison({ withPair: true }) }; },
  });
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port),
    /durable checkpoint budget/,
  );
  assert.equal(matchCalls, 0);
  assert.equal(port.checkpoints.has(CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE), false);
});

test("a newer successful crawl overflow cannot silently fall back to an older durable crawl", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      crawlCalls += 1;
      const value = await base.crawl();
      value.discovery.productSearchCoverage.complete = false;
      if (crawlCalls > 1) value.results[0].products[0].claimIds = Array.from({ length: 100_000 }, (_, index) => createHash("sha256").update(`newer-oversized-claim:${index}`).digest("hex"));
      return value;
    },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /durable checkpoint budget/,
  );
  assert.equal(crawlCalls, 2);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"), false);
});

test("unconfirmed crawl checkpoint storage failure stops before downstream processing", async () => {
  let matchCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() { return base.crawl(); },
    async saveCheckpoint(_publicId, input) {
      if (input.batchIndex === CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE) throw new Error("checkpoint store unavailable");
      port.checkpoints.set(input.batchIndex, { attemptNumber: input.attemptNumber, batchIndex: input.batchIndex, inputHash: input.inputHash, result: input.result });
    },
    async match() { matchCalls += 1; return { ok: true, comparison: comparison({ withPair: true }) }; },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true }, port), /checkpoint store unavailable/);
  assert.equal(matchCalls, 0);
  assert.equal(port.events.some((item) => item.idempotencyKey === "crawl-failed"), false);
});

test("ambiguous crawl checkpoint save rejects different committed content in the same slot", async () => {
  let matchCalls = 0;
  let port;
  port = mockPort({
    async saveCheckpoint(_publicId, input) {
      if (input.batchIndex !== CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE) return;
      const different = JSON.parse(gunzipSync(Buffer.from(input.result.data, "base64")).toString("utf8"));
      different.results[0].products[0].name = "Different committed crawl product";
      port.checkpoints.set(input.batchIndex, {
        attemptNumber: input.attemptNumber,
        batchIndex: input.batchIndex,
        inputHash: input.inputHash,
        result: { ...input.result, data: gzipSync(JSON.stringify(different), { level: 9 }).toString("base64") },
      });
      throw new Error("ambiguous crawl checkpoint save");
    },
    async match() { matchCalls += 1; return { ok: true, comparison: comparison({ withPair: true }) }; },
  });
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port),
    /ambiguous crawl checkpoint save/,
  );
  assert.equal(matchCalls, 0);
});

test("a same-attempt crawl checkpoint conflict cannot fall back to an older durable crawl", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  let port;
  const base = mockPort();
  port = mockPort({
    async crawl() {
      crawlCalls += 1;
      const value = await base.crawl();
      value.discovery.productSearchCoverage.complete = false;
      return value;
    },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const ordinarySave = port.saveCheckpoint.bind(port);
  port.saveCheckpoint = async (publicId, input) => {
    if (input.batchIndex !== CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1) return ordinarySave(publicId, input);
    const different = JSON.parse(gunzipSync(Buffer.from(input.result.data, "base64")).toString("utf8"));
    different.results[0].products[0].name = "Conflicting second-wave product";
    port.checkpoints.set(input.batchIndex, {
      attemptNumber: input.attemptNumber,
      batchIndex: input.batchIndex,
      inputHash: input.inputHash,
      result: { ...input.result, data: gzipSync(JSON.stringify(different), { level: 9 }).toString("base64") },
    });
    throw new Error("second-wave checkpoint conflict");
  };
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /second-wave checkpoint conflict/,
  );
  assert.equal(crawlCalls, 2);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"), false);
});

test("a missing confirmation after an ambiguous checkpoint save cannot fall back to an older crawl", async () => {
  let saveCalls = 0;
  let matchCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      const value = await base.crawl();
      value.discovery.productSearchCoverage.complete = false;
      return value;
    },
    async match() { matchCalls += 1; return { ok: true, comparison: comparison({ withPair: true }) }; },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const matchesBeforeRetry = matchCalls;
  const ordinarySave = port.saveCheckpoint.bind(port);
  port.saveCheckpoint = async (publicId, input) => {
    if (input.batchIndex === CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1) throw new Error("new checkpoint response lost");
    return ordinarySave(publicId, input);
  };
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /new checkpoint response lost/,
  );
  assert.equal(matchCalls, matchesBeforeRetry);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"), false);
});

test("a failed confirmation read after an ambiguous checkpoint save cannot fall back to an older crawl", async () => {
  let saveCalls = 0;
  let matchCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      const value = await base.crawl();
      value.discovery.productSearchCoverage.complete = false;
      return value;
    },
    async match() { matchCalls += 1; return { ok: true, comparison: comparison({ withPair: true }) }; },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const matchesBeforeRetry = matchCalls;
  const ordinarySave = port.saveCheckpoint.bind(port);
  const ordinaryLoad = port.loadCheckpoint.bind(port);
  port.saveCheckpoint = async (publicId, input) => {
    if (input.batchIndex === CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1) throw new Error("new checkpoint response lost");
    return ordinarySave(publicId, input);
  };
  port.loadCheckpoint = async (publicId, input) => {
    if (input.batchIndex === CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1) throw new Error("confirmation read unavailable");
    return ordinaryLoad(publicId, input);
  };
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /new checkpoint response lost/,
  );
  assert.equal(matchCalls, matchesBeforeRetry);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"), false);
});

test("checkpoint presentation projection failure cannot fall back to an older durable crawl", async () => {
  let crawlCalls = 0;
  let saveCalls = 0;
  let matchCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      crawlCalls += 1;
      const value = await base.crawl();
      value.discovery.productSearchCoverage.complete = false;
      if (crawlCalls > 1) value.document.blocks = Array.from({ length: 100 }, (_, index) => ({ type: "summary", id: `oversized-summary-${index}`, body: "مرحبا".repeat(2_000) }));
      return value;
    },
    async match() { matchCalls += 1; return { ok: true, comparison: comparison({ withPair: true }) }; },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  const matchesBeforeRetry = matchCalls;
  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port),
    /could not be projected into a durable checkpoint/,
  );
  assert.equal(matchCalls, matchesBeforeRetry);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-2-crawl-resumed"), false);
});

test("an exact committed crawl after a lost save response keeps rich live facts in memory", async () => {
  const base = mockPort();
  let port;
  let lost = false;
  let freshProduct = null;
  port = mockPort({
    async crawl() {
      const value = await base.crawl();
      freshProduct = value.results[0].products[0];
      return value;
    },
    async match(input) {
      assert.equal(input.catalogs[0].products[0], freshProduct);
      return { ok: true, comparison: comparison({ withPair: true }) };
    },
  });
  const ordinarySave = port.saveCheckpoint.bind(port);
  port.saveCheckpoint = async (publicId, input) => {
    await ordinarySave(publicId, input);
    if (!lost && input.batchIndex === CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE) {
      lost = true;
      throw new Error("crawl checkpoint response lost");
    }
  };
  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true }, port);
  assert.equal(lost, true);
});

test("a retry advances to the next discovery anchor batch only after a complete prior batch", async () => {
  const base = mockPort();
  let crawlInput;
  const port = mockPort({
    async loadReport() {
      const stored = await base.loadReport();
      return {
        ...stored,
        events: [
          { idempotencyKey: "report-1-task-1-crawl-complete", phase: "competitors", status: "running", metadata: { discoveryStartIndex: 0, discoveryEndIndex: 20, discoveryBatchComplete: true, discoveryAnchorSetHash: "a".repeat(64) } },
          { idempotencyKey: "report-1-task-2-crawl-complete", phase: "competitors", status: "running", metadata: { discoveryStartIndex: 20, discoveryEndIndex: 40, discoveryBatchComplete: false } },
        ],
      };
    },
    async crawl(input) { crawlInput = input; return base.crawl(); },
  });
  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port);
  assert.equal(crawlInput.discoverySearchOffset, 20);
  assert.equal(crawlInput.discoveryPriorCoverageComplete, true);
  assert.equal(crawlInput.discoveryExpectedAnchorSetHash, "a".repeat(64));
});

test("report recovery starts a fresh discovery cursor instead of reusing prior-attempt events", async () => {
  const base = mockPort();
  let crawlInput;
  const port = mockPort({
    async loadReport() {
      const stored = await base.loadReport();
      return {
        ...stored,
        run: { ...stored.run, attemptCount: 2 },
        events: [{ idempotencyKey: "report-1-task-5-crawl-complete", phase: "competitors", status: "running", metadata: { discoveryStartIndex: 0, discoveryEndIndex: 1_000, discoveryBatchComplete: true, discoveryAnchorSetHash: "a".repeat(64) } }],
      };
    },
    async crawl(input) { crawlInput = input; return base.crawl(); },
  });

  await orchestrateReport(recoveryPayload, { attemptNumber: 2, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(crawlInput.discoverySearchOffset, 0);
  assert.equal(crawlInput.discoveryExpectedAnchorSetHash, "");
});

test("explicit report recovery adopts the prior attempt's completed discovery cursor", async () => {
  const base = mockPort();
  let crawlInput;
  const port = mockPort({
    async loadReport() {
      const stored = await base.loadReport();
      return {
        ...stored,
        run: { ...stored.run, attemptCount: 2 },
        events: [
          { idempotencyKey: "report-1-task-5-crawl-complete", phase: "competitors", status: "running", metadata: { discoveryStartIndex: 0, discoveryEndIndex: 200, discoveryBatchComplete: true, discoveryAnchorSetHash: "a".repeat(64) } },
          { idempotencyKey: "recovery-attempt-2", phase: "competitors", status: "running", metadata: { attempt: 2, adoptedAttempt: 1 } },
        ],
      };
    },
    async crawl(input) { crawlInput = input; return base.crawl(); },
  });

  await orchestrateReport(recoveryPayload, { attemptNumber: 2, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(crawlInput.discoverySearchOffset, 200);
  assert.equal(crawlInput.discoveryPriorCoverageComplete, true);
  assert.equal(crawlInput.discoveryExpectedAnchorSetHash, "a".repeat(64));
});

test("the matcher can publish a valid pair found after the first 20 primary catalog products", async () => {
  const primaryProducts = Array.from({ length: 25 }, (_, index) => ({
    ...product("shop.example", index === 0 ? "p1" : index < 19 ? `p1-${index + 1}` : `p-${index + 1}`),
    name: index < 19 ? `Honey ${index + 1} 500g` : `Catalog product ${index + 1}`,
    normalizedName: index < 19 ? `honey ${index + 1} 500g` : `catalog product ${index + 1}`,
    sourceUrl: index === 0 ? "https://shop.example/products/honey?country=GB" : index < 19 ? `https://shop.example/products/honey-${index + 1}?country=GB` : `https://shop.example/products/catalog-${index + 1}?country=GB`,
    priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }],
  }));
  const latePrimary = { ...primaryProducts[24], name: "Honey 20 500g", normalizedName: "honey 20 500g" };
  const base = mockPort();
  const port = mockPort({
    async crawl(input) {
      assert.equal(input.productLimit, 20);
      assert.equal(input.catalogProductLimit, 1_000);
      const value = await base.crawl();
      return { ...value, results: [{ ...value.results[0], products: primaryProducts }] };
    },
    async match(input) {
      assert.equal(input.catalogs.find((catalog) => catalog.domain === "shop.example").products.length, 25);
      const value = comparison({ withPair: true, count: 20 });
      value.rows[19].primary = latePrimary;
      value.rows[19].matches[0].assessment.primarySourceUrl = latePrimary.sourceUrl;
      value.coverage = { ...value.coverage, primaryProductsAvailable: 25, primaryProductsScanned: 25, primaryProductFamiliesCompared: 25, truncated: false };
      value.matching = { ...value.matching, primaryProductsAssessed: 25, selectedPrimaryIds: value.rows.map((row) => row.primary.id), assessedPrimaryIds: [...value.rows.map((row) => row.primary.id), ...primaryProducts.slice(19, 24).map((item) => item.id)] };
      assert.equal(publishPricedProductComparison(value, Date.parse("2026-07-20T09:00:00.000Z")).rows.filter((row) => row.matches.some((match) => match.publication?.priceEligible)).length, 20);
      return { ok: true, comparison: value };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.ok(block.rows.some((row) => row.primary.id === "p-25"));
  assert.equal(block.rows.flatMap((row) => row.matches).filter((match) => match.product).length, 20);
});

test("a priced shortfall cannot claim exhaustion while competitor discovery left primary anchors unsearched", async () => {
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      const value = await base.crawl();
      return { ...value, discovery: { productSearchCoverage: { eligibleAnchors: 25, searchedAnchors: 20, truncated: true, complete: false } } };
    },
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.matching.resultShortfallReason = "bounded-candidate-pool-exhausted";
      return { ok: true, comparison: value };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(port.saves.length, 1);
  assert.equal(port.events.some((item) => item.idempotencyKey === "orchestration-failed"), false);
});

test("enrichment checkpoints require one exact source-bound outcome per target", () => {
  const targets = [
    { domain: "shop.example", sourceUrl: "https://shop.example/products/one?country=GB", productId: "p1", expectedName: "One", expectedType: "Product", pairScore: 1, role: "primary" },
    { domain: "rival.example", sourceUrl: "https://rival.example/products/two?country=GB", productId: "r2", expectedName: "Two", expectedType: "Product", pairScore: 1, role: "rival" },
  ];
  const products = targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl }));
  const complete = { ok: true, products, coverage: { pagesRequested: 2, pagesFetched: 2, maxPages: 64, gaps: [] } };
  assert.ok(validEnrichmentCheckpoint(complete, targets));
  assert.equal(validEnrichmentCheckpoint({ ...complete, products: [products[0], products[0]] }, targets), null);
  assert.equal(validEnrichmentCheckpoint({ ...complete, products: [products[0], { ...products[1], sourceUrl: "https://rival.example/products/wrong-page" }] }, targets), null);
  assert.equal(validEnrichmentCheckpoint({ ...complete, products: [products[0], { ...products[1], sourceUrl: "https://rival.example/products/two?country=US" }] }, targets), null);
  assert.equal(validEnrichmentCheckpoint({ ...complete, products: [products[0]], coverage: { ...complete.coverage, pagesFetched: 1 } }, targets), null);
  const gap = { url: targets[1].sourceUrl, productId: targets[1].productId, role: "rival", reason: "Unavailable.", code: "fetch_failed", failureKind: "content" };
  assert.ok(validEnrichmentCheckpoint({ ...complete, products: [products[0]], coverage: { ...complete.coverage, pagesFetched: 1, gaps: [gap] } }, targets));
  assert.equal(validEnrichmentCheckpoint({ ...complete, coverage: { ...complete.coverage, gaps: [gap] } }, targets), null);
  assert.equal(validEnrichmentCheckpoint({ ...complete, products: [products[0]], coverage: { ...complete.coverage, pagesFetched: 1, gaps: [gap, gap] } }, targets), null);
  const allGaps = targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Unavailable.", code: "fetch_failed", failureKind: "content" }));
  assert.ok(validEnrichmentCheckpoint({ ...complete, products: [], coverage: { ...complete.coverage, pagesFetched: 0, gaps: allGaps } }, targets));
});

test("the priced table is capped while suppressed screened evidence remains in relational facts", async () => {
  const screened = comparison({ withPair: true, count: 22 });
  screened.rows[21].matches[0].product.priceSignals = [];
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      const value = await base.crawl();
      return { ...value, results: [{ ...value.results[0], products: screened.rows.map((row) => row.primary) }] };
    },
    async match() { return { ok: true, comparison: screened }; },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "complete");
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.rows.length, 20);
  assert.equal(block.matching.primaryProductsAssessed, 22);
  assert.equal(block.matching.publishedPrimaryProducts, 20);
  assert.equal(block.matching.publication.suppressedAcceptedPairs, 1);
  const matchFacts = port.factChunks.filter((chunk) => chunk.kind === "matches").flatMap((chunk) => chunk.items);
  assert.equal(matchFacts.length, 22);
  assert.equal(matchFacts.filter((fact) => fact.evidence.publication?.priceEligible === true).length, 20);
  assert.ok(matchFacts.some((fact) => fact.evidence.publication?.priceEligible === false && fact.evidence.publication?.reason === "outside-result-target"), JSON.stringify(matchFacts.map((fact) => fact.evidence.publication)));
  assert.ok(matchFacts.some((fact) => fact.evidence.publication?.priceEligible === false && fact.evidence.publication?.reason === "missing-valid-rival-price"));
});

test("orchestration forwards crawl-validated exact product pins to every match attempt", async () => {
  const pin = { primaryId: "p1", rivalDomain: "rival.example", rivalId: "r1" };
  const seen = [];
  const base = mockPort();
  const port = mockPort({
    async crawl() { return { ...await base.crawl(), matchHints: [pin] }; },
    async match(input) { seen.push(input.pinnedPairs); return { ok: true, comparison: comparison() }; },
  });
  await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port, () => new Date("2026-07-20T10:00:00.000Z"));
  assert.deepEqual(seen, [[pin]]);
});

test("non-terminal orchestration preflights before its first mutation", async () => {
  const order = [];
  const port = mockPort({
    async preflight() { order.push("preflight"); },
    async appendEvent(_publicId, value) {
      order.push(`event:${value.idempotencyKey}`);
      port.events.push(value);
    },
  });
  await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(order[0], "preflight");
  assert.equal(order[1], "event:report-1-task-1-crawl-started");
});

test("independent phase failures remain visible and produce a limited report", async () => {
  const port = mockPort({ async ads() { throw new Error("provider unavailable"); } });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.limitedPhases, ["ads"]);
  assert.equal(port.saves[0].status, "limited");
  assert.match(port.events.find((item) => item.idempotencyKey.endsWith("-ads-limited")).metadata.reason, /provider unavailable/);
});

test("Trigger task retries keep the same database report-attempt ownership", async () => {
  const port = mockPort();
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.ok(port.events.every((item) => item.attemptNumber === 1));
  assert.ok(port.factChunks.every((item) => item.attemptNumber === 1));
  assert.ok(port.factManifests.every((item) => item.attemptNumber === 1));
  assert.ok(port.saves.every((item) => item.attemptNumber === 1));
});

test("relational fact persistence failure prevents a terminal dashboard snapshot", async () => {
  const port = mockPort({ async persistFactChunk() { throw new Error("database temporarily unavailable"); } });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port), /persistence remained incomplete/i);
  assert.equal(port.saves.length, 0);
  assert.match(port.events.find((item) => item.idempotencyKey.endsWith("-facts-incomplete")).metadata.reason, /database temporarily unavailable/);
});

test("a retry fails closed before replacing a completed fact manifest or saving a mismatched document", async () => {
  const counts = { companies: 2, products: 63, matches: 4, ads: 1 };
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "running", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z" },
        events: [],
        factManifest: { manifestId: "a".repeat(64), manifestHash: "b".repeat(64), counts, status: "complete", completedAt: "2026-07-20T09:59:00.000Z" },
      };
    },
  });
  await assert.rejects(orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port), /completed relational fact snapshot differs/i);
  assert.equal(port.factChunks.length, 0);
  assert.equal(port.factManifests.length, 0);
  assert.equal(port.saves.length, 0);
});

test("a retry reuses a completed fact manifest only when its current bundle hashes match", async () => {
  const first = mockPort();
  await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, first);
  const manifest = first.factManifests[0];
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "running", attemptCount: 1, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z" },
        events: [],
        factManifest: { ...manifest, status: "complete", completedAt: "2026-07-20T09:59:00.000Z" },
      };
    },
    async loadCheckpoint(_publicId, input) {
      if (input.batchIndex !== undefined) return [];
      return [...first.checkpoints.values()];
    },
    async actions({ inputs }) {
      const result = deterministicProductActionResult(inputs);
      return { ok: true, result: { ...result, plans: result.plans.map((entry) => ({ ...entry, plan: { ...entry.plan, actionEn: `Retry presentation: ${entry.plan.actionEn}` } })) } };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(port.factChunks.length, 0);
  assert.equal(port.factManifests.length, 0);
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].expectedFactManifestHash, manifest.manifestHash);
});

test("completed fact recovery selects the newest owned terminal presentation", async () => {
  const manifestHash = "b".repeat(64);
  const presentation = (version, taskAttemptNumber, status, observedAt, marker) => ({
    version,
    ...(version === 2 ? { taskAttemptNumber } : {}),
    manifestHash,
    status,
    observedAt,
    document: { primaryDomain: payload.primaryDomain, marker, document: { blocks: [{ type: "presentation-compaction", id: "presentation-compaction" }] }, marketBrief: null },
  });
  const checkpoint = (attemptNumber, batchIndex, result) => ({
    attemptNumber,
    batchIndex,
    inputHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    result,
  });
  const oldPresentation = presentation(2, 1, "limited", "2026-07-20T09:58:00.000Z", "old");
  const newPresentation = presentation(2, 2, "complete", "2026-07-20T10:00:00.000Z", "new");
  const tamperedPresentation = presentation(2, 3, "limited", "2026-07-20T10:00:30.000Z", "tampered");
  const malformedPresentation = { ...presentation(1, 0, "limited", "2026-07-20T10:01:00.000Z", "unowned-newer"), document: { marker: "not-a-report-document" } };
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, productPlan: payload.productPlan, productLimit: payload.productLimit, status: "running", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z" },
        events: [],
        factManifest: { manifestId: "a".repeat(64), manifestHash, counts: { companies: 2, products: 2, matches: 1, ads: 0 }, status: "complete", completedAt: "2026-07-20T09:59:00.000Z" },
      };
    },
    async loadCheckpoint() {
      return [
        checkpoint(1, 280, oldPresentation),
        checkpoint(2, 281, newPresentation),
        { attemptNumber: 2, batchIndex: 282, inputHash: "0".repeat(64), result: tamperedPresentation },
        checkpoint(3, 289, malformedPresentation),
      ];
    },
  });

  const result = await orchestrateReport(recoveryPayload, { attemptNumber: 2, taskAttemptNumber: 3, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(port.saves[0].document.marker, "new");
});

test("terminal replay validates attempt and entitlement before returning without mutations", async () => {
  const port = mockPort({
    async loadReport() {
      return { run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "complete", attemptCount: 1, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:05:00.000Z", productPlan: "starter", productLimit: 20 }, events: [] };
    },
  });
  await assert.rejects(orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port), /attempt does not match/i);
  await assert.rejects(orchestrateReport({ ...payload, contractVersion: "3", productPlan: "solo", productLimit: 50 }, { attemptNumber: 1, isFinalAttempt: true }, port), /entitlement does not match/i);
  assert.equal(port.events.length, 0);
  assert.equal(port.saves.length, 0);
});

test("fact persistence failures block terminalization while post-manifest telemetry remains non-blocking", async () => {
  const port = mockPort({
    async persistFactChunk() { throw new Error("fact database unavailable"); },
    async appendEvent(_publicId, value) {
      if (value.idempotencyKey.endsWith("-facts-incomplete")) throw new Error("telemetry unavailable");
      port.events.push(value);
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port), /persistence remained incomplete/i);
  assert.equal(port.saves.length, 0);
  const completePort = mockPort({
    async appendEvent(_publicId, value) {
      if (value.idempotencyKey.endsWith("-facts-complete")) throw new Error("telemetry unavailable");
      completePort.events.push(value);
    },
  });
  const complete = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, completePort);
  assert.equal(complete.reportStatus, "complete");
  assert.equal(completePort.saves.length, 1);
});

test("a lost finalization response fails closed when the reloaded authoritative manifest differs", async () => {
  const counts = { companies: 2, products: 20, matches: 3, ads: 0 };
  let loads = 0;
  const port = mockPort({
    async loadReport() {
      loads += 1;
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "running", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z" },
        events: [],
        factManifest: { manifestId: "a".repeat(64), attemptNumber: 2, manifestHash: "b".repeat(64), counts, status: loads === 1 ? "finalizing" : "complete", completedAt: "2026-07-20T09:59:00.000Z" },
      };
    },
    async finalizeFactManifest() { throw new Error("response lost after commit"); },
  });
  await assert.rejects(orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port), /completed relational fact snapshot differs/i);
  assert.equal(loads, 2);
  assert.equal(port.factChunks.length, 0);
  assert.equal(port.saves.length, 0);
});

test("a completed manifest resumes its exact checkpointed presentation after document-save failure", async () => {
  let completeManifest = null;
  let saveAttempts = 0;
  let crawlCalls = 0;
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "running", attemptCount: 1, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z", productPlan: "starter", productLimit: 20 },
        events: port.events,
        factManifest: completeManifest,
      };
    },
    async crawl() { crawlCalls += 1; return mockPort().crawl(); },
    async finalizeFactManifest(_publicId, manifest) {
      port.factManifests.push(manifest);
      completeManifest = { ...manifest, status: "complete", completedAt: "2026-07-20T10:05:00.000Z" };
    },
    async saveDocument(_publicId, value) {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("document callback unavailable");
      port.saves.push(value);
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /document callback unavailable/);
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(crawlCalls, 1);
  assert.equal(saveAttempts, 2);
  assert.equal(port.saves[0].expectedFactManifestHash, completeManifest.manifestHash);
});

test("crawl failure remains non-terminal before the final task attempt", async () => {
  const port = mockPort({ async crawl() { throw new Error("timeout"); } });
  await assert.rejects(orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port), /timeout/);
  const failure = port.events.at(-1);
  assert.equal(failure.idempotencyKey, "crawl-report-1-task-1-failed");
  assert.equal(failure.status, "running");
  assert.equal(failure.phase, "crawl");
});

test("crawl failure becomes terminal only on the final task attempt", async () => {
  const port = mockPort({
    async loadReport() {
      return { run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" }, events: [] };
    },
    async crawl() { throw new Error("still unavailable"); },
  });
  await assert.rejects(orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port), /still unavailable/);
  const failure = port.events.at(-1);
  assert.equal(failure.idempotencyKey, "crawl-failed");
  assert.equal(failure.status, "failed");
  assert.equal(failure.phase, "failed");
});

test("a source-linked parked domain persists one terminal limited report without downstream work", async () => {
  const calls = { brief: 0, ads: 0, match: 0, enrich: 0 };
  const port = mockPort({
    async crawl() {
      return {
        ok: false,
        code: "parked-domain",
        primaryDomain: payload.primaryDomain,
        error: "shop.example redirects to a domain-for-sale service.",
        document: {
          version: "1",
          blocks: [
            { type: "domain-status", id: "primary-domain-status", domain: payload.primaryDomain, status: "parked", provider: "GoDaddy/Afternic", evidenceUrl: "https://shop.example/lander", observedAt: "2026-07-20T10:00:00.000Z", alternatives: [] },
            { type: "gap", id: "gap-parked", domain: payload.primaryDomain, url: "https://shop.example/lander", reason: "Redirects to a domain-for-sale service.", observedAt: "2026-07-20T10:00:00.000Z" },
          ],
        },
      };
    },
    async brief() { calls.brief += 1; throw new Error("must not run"); },
    async ads() { calls.ads += 1; throw new Error("must not run"); },
    async match() { calls.match += 1; throw new Error("must not run"); },
    async enrich() { calls.enrich += 1; throw new Error("must not run"); },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.completedPhases, ["persistence"]);
  assert.deepEqual(result.limitedPhases, ["crawl", "ads", "matching"]);
  assert.deepEqual(calls, { brief: 0, ads: 0, match: 0, enrich: 0 });
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].status, "limited");
  for (const phase of result.limitedPhases) {
    const savedEvent = port.events.find((item) => item.idempotencyKey === `${phase === "crawl" ? "crawl" : phase}-limited`);
    assert.equal(savedEvent.phase, phase);
    assert.equal(savedEvent.status, "limited");
  }
});

test("a bounded unavailable domain persists one terminal limited report without downstream work", async () => {
  const calls = { brief: 0, ads: 0, match: 0, enrich: 0 };
  const observedAt = "2026-07-20T10:00:00.000Z";
  const port = mockPort({
    async crawl() {
      return {
        ok: false,
        code: "unavailable-domain",
        primaryDomain: payload.primaryDomain,
        error: "shop.example did not return a public network response after two bounded attempts.",
        document: { version: "1", blocks: [
          { type: "domain-status", id: "primary-domain-status", domain: payload.primaryDomain, status: "unavailable", attemptedUrl: "https://shop.example/", attempts: 2, observedAt },
          { type: "gap", id: "gap-unavailable", domain: payload.primaryDomain, url: "https://shop.example/", reason: "request failed", observedAt },
        ] },
      };
    },
    async brief() { calls.brief += 1; throw new Error("must not run"); },
    async ads() { calls.ads += 1; throw new Error("must not run"); },
    async match() { calls.match += 1; throw new Error("must not run"); },
    async enrich() { calls.enrich += 1; throw new Error("must not run"); },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.completedPhases, ["persistence"]);
  assert.deepEqual(result.limitedPhases, ["crawl", "ads", "matching"]);
  assert.deepEqual(calls, { brief: 0, ads: 0, match: 0, enrich: 0 });
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].status, "limited");
  assert.match(port.events.find((item) => item.idempotencyKey === "crawl-limited").message, /did not return a public network response/i);
});

test("a parked-domain retry replays partial event writes without an idempotency conflict", async () => {
  const storedEvents = new Map();
  let saveAttempts = 0;
  let currentAttempt = 1;
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "running", attemptCount: currentAttempt, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
        events: [...storedEvents.values()],
      };
    },
    async appendEvent(_publicId, value) {
      const existing = storedEvents.get(value.idempotencyKey);
      const withoutAttempt = (item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "attemptNumber"));
      if (existing && JSON.stringify(withoutAttempt(existing)) !== JSON.stringify(withoutAttempt(value))) throw new Error(`idempotency conflict: ${value.idempotencyKey}`);
      storedEvents.set(value.idempotencyKey, structuredClone(value));
    },
    async crawl() {
      return {
        ok: false,
        code: "parked-domain",
        primaryDomain: payload.primaryDomain,
        error: "shop.example redirects to a domain-for-sale service.",
        document: { version: "1", blocks: [
          { type: "domain-status", id: "primary-domain-status", domain: payload.primaryDomain, status: "parked", provider: "GoDaddy/Afternic", evidenceUrl: "https://shop.example/lander", observedAt: "2026-07-20T10:00:00.000Z", alternatives: [] },
          { type: "gap", id: "gap-parked", domain: payload.primaryDomain, url: "https://shop.example/lander", reason: "Redirects to a domain-for-sale service.", observedAt: "2026-07-20T10:00:00.000Z" },
        ] },
      };
    },
    async saveDocument(_publicId, value) {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("transient save failure");
      this.saves.push(value);
    },
  });
  await assert.rejects(orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port), /transient save failure/);
  currentAttempt = 2;
  const result = await orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(saveAttempts, 2);
  assert.equal(storedEvents.get("crawl-limited").metadata.attempt, undefined);
  assert.equal([...storedEvents.keys()].filter((key) => key.endsWith("-limited")).length, 3);
});

test("the HTTP crawl adapter accepts only a bounded source-linked parked-domain 409", async () => {
  const parked = {
    ok: false,
    code: "parked-domain",
    primaryDomain: payload.primaryDomain,
    error: "Parked domain.",
    document: { version: "1", blocks: [
      { type: "domain-status", id: "primary-domain-status", domain: payload.primaryDomain, status: "parked", provider: "GoDaddy/Afternic", redirectDomain: "forsale.godaddy.com", evidenceUrl: "https://shop.example/lander", observedAt: "2026-07-20T10:00:00.000Z" },
      { type: "gap", id: "parked-gap", domain: payload.primaryDomain, url: "https://shop.example/lander", reason: "Parked.", observedAt: "2026-07-20T10:00:00.000Z" },
    ] },
  };
  const accepted = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl() { return Response.json(parked, { status: 409 }); },
  });
  assert.deepEqual(await accepted.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] }), parked);

  for (const body of [
    { ...parked, primaryDomain: "attacker.example" },
    { ...parked, error: "" },
    { ...parked, document: { version: "1", blocks: [] } },
    { ...parked, document: { version: "1", blocks: parked.document.blocks.map((block) => block.type === "domain-status" ? { ...block, redirectDomain: "forsale.godaddy.com.evil.example" } : block) } },
  ]) {
    const rejected = createReportOrchestrationHttpPort({
      appOrigin: "https://market.example",
      callbackToken: "callback_secret_with_enough_entropy_123456",
      async fetchImpl() { return Response.json(body, { status: 409 }); },
    });
    await assert.rejects(rejected.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] }), /HTTP 409/);
  }

  const oversized = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl() { return new Response(JSON.stringify(parked), { status: 409, headers: { "content-type": "application/json", "content-length": "1000001" } }); },
  });
  await assert.rejects(oversized.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] }), /HTTP 409/);
});

test("the HTTP crawl adapter accepts only a bounded same-domain unavailable-domain 409", async () => {
  const observedAt = "2026-07-20T10:00:00.000Z";
  const unavailable = {
    ok: false,
    code: "unavailable-domain",
    primaryDomain: payload.primaryDomain,
    error: "No public network response.",
    document: { version: "1", blocks: [
      { type: "domain-status", id: "primary-domain-status", domain: payload.primaryDomain, status: "unavailable", attemptedUrl: "https://shop.example/", attempts: 2, observedAt },
      { type: "gap", id: "unavailable-gap", domain: payload.primaryDomain, url: "https://shop.example/", reason: "request failed", observedAt },
    ] },
  };
  const accepted = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl() { return Response.json(unavailable, { status: 409 }); },
  });
  assert.deepEqual(await accepted.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] }), unavailable);

  for (const body of [
    { ...unavailable, primaryDomain: "attacker.example" },
    { ...unavailable, error: "" },
    { ...unavailable, document: { version: "1", blocks: [] } },
    { ...unavailable, document: { version: "1", blocks: unavailable.document.blocks.map((block) => block.type === "domain-status" ? { ...block, attempts: 1 } : block) } },
    { ...unavailable, document: { version: "1", blocks: unavailable.document.blocks.map((block) => block.type === "domain-status" ? { ...block, attemptedUrl: "https://attacker.example/" } : block) } },
    { ...unavailable, document: { version: "1", blocks: unavailable.document.blocks.map((block) => block.type === "gap" ? { ...block, observedAt: "2026-07-20T10:00:02.000Z" } : block) } },
  ]) {
    const rejected = createReportOrchestrationHttpPort({
      appOrigin: "https://market.example",
      callbackToken: "callback_secret_with_enough_entropy_123456",
      async fetchImpl() { return Response.json(body, { status: 409 }); },
    });
    await assert.rejects(rejected.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] }), /HTTP 409/);
  }
});

test("typed crawl diagnostics reach the terminal orchestration event", async () => {
  const port = mockPort({
    async loadReport() {
      return { run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" }, events: [] };
    },
    async crawl() { throw new OrchestrationHttpError("Public crawl", 422, false, "Edge validation failed.", "edge-response-invalid"); },
  });
  await assert.rejects(orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port), /Edge validation failed/);
  assert.equal(port.events.at(-1).errorCode, "edge-response-invalid");
});

test("the HTTP crawl adapter preserves a validated blocked-page recovery diagnostic", async () => {
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(input) {
      if (String(input).endsWith("/api/crawl")) return Response.json({
        ok: false,
        live: false,
        code: "blocked-page-recovery-failed",
        errorCode: "edge-response-invalid",
        error: "The blocked-page recovery result failed source and identity validation.",
        primaryDomain: "shop.example",
        results: [],
        document: { blocks: [] },
      }, { status: 422 });
      return Response.json({ ok: true });
    },
  });
  await assert.rejects(port.crawl({ primary: "shop.example", domains: ["shop.example"] }), /blocked-page recovery result failed source and identity validation/i);
});

test("a replayed parked report preserves the live canonical phase summary", async () => {
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "limited", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:05:00.000Z", productPlan: "starter", productLimit: 20 },
        events: [
          { idempotencyKey: "crawl-limited", phase: "crawl", status: "limited" },
          { idempotencyKey: "brief-limited", phase: "brief", status: "limited" },
          { idempotencyKey: "ads-limited", phase: "ads", status: "limited" },
          { idempotencyKey: "matching-limited", phase: "matching", status: "limited" },
          { idempotencyKey: "report-saved", phase: "complete", status: "limited" },
        ],
      };
    },
  });
  const result = await orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port);
  assert.deepEqual(result.completedPhases, ["persistence"]);
  assert.deepEqual(result.limitedPhases, ["crawl", "brief", "ads", "matching"]);
  assert.equal(port.events.length, 0);
  assert.equal(port.saves.length, 0);
});

test("terminal success replay derives its summary and issues no mutations", async () => {
  let preflights = 0;
  const port = mockPort({
    async preflight() { preflights += 1; },
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "limited", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:05:00.000Z", productPlan: "starter", productLimit: 20 },
        events: [{ idempotencyKey: "crawl-complete", phase: "competitors", status: "running" }, { idempotencyKey: "ads-limited", phase: "ads", status: "running" }],
      };
    },
  });
  const result = await orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.completedPhases, ["competitors"]);
  assert.deepEqual(result.limitedPhases, ["ads"]);
  assert.equal(port.events.length, 0);
  assert.equal(port.saves.length, 0);
  assert.equal(preflights, 0);
});

test("stored run identity drift hard-fails before any mutation", async () => {
  const port = mockPort({
    async loadReport() {
      return { run: { publicId: payload.publicId, primaryDomain: "other.example", locale: "en", status: "queued", createdAt: "now", updatedAt: "now" }, events: [] };
    },
  });
  await assert.rejects(orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port), PermanentOrchestrationError);
  assert.equal(port.events.length, 0);
});

test("all operation deadlines keep a two-minute margin below the stale marker", () => {
  assert.equal(MAX_SUCCESS_BODY_BYTES, 64 * 1_024 * 1_024);
  assert.equal(MAX_OPERATION_TIMEOUT_MS, 2_460_000);
  for (const timeout of Object.values(OPERATION_BUDGETS_MS)) assert.ok(timeout <= MAX_OPERATION_TIMEOUT_MS);
  assert.ok(ORCHESTRATION_FETCH_TIMEOUT_MS > OPERATION_BUDGETS_MS.match, "Undici must not preempt the match operation deadline");
  assert.ok(ORCHESTRATION_FETCH_TIMEOUT_MS < MAX_OPERATION_TIMEOUT_MS, "the worker deadline must remain inside the outer edge window");
  assert.equal(WORST_CASE_CRITICAL_PATH_MS, 12_941_000);
  assert.ok(WORST_CASE_CRITICAL_PATH_MS <= 14_580_000, "critical path must preserve a two-minute task-ceiling margin");
});

test("the managed orchestration fetch controls the response-header deadline", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    }, 2_500);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/slow-headers`;
  const shortFetch = createOrchestrationFetch(1_000);
  const patientFetch = createOrchestrationFetch(5_000);
  try {
    const [response] = await Promise.all([
      patientFetch(url),
      assert.rejects(shortFetch(url), /fetch failed/i),
    ]);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await shortFetch.close();
    await patientFetch.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the retry loop shares one total operation deadline instead of doubling it", async () => {
  const originalNow = Date.now;
  let current = 1_000;
  Date.now = () => current;
  let calls = 0;
  try {
    const port = createReportOrchestrationHttpPort({
      appOrigin: "https://market.example",
      callbackToken: "callback_secret_with_enough_entropy_123456",
      async fetchImpl() {
        calls += 1;
        current += OPERATION_BUDGETS_MS.report;
        return new Response("slow transient", { status: 503 });
      },
    });
    await assert.rejects(port.loadReport(payload.publicId), /could not be completed/i);
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("a second match attempt refreshes the report heartbeat before another long operation", async () => {
  let calls = 0;
  const port = mockPort({
    async match() {
      calls += 1;
      if (calls === 1) throw new Error("temporary match transport failure");
      return { ok: true, comparison: comparison({ withPair: true }) };
    },
    async enrich() { return { ok: true, products: [], coverage: { pagesRequested: 2, pagesFetched: 0, maxPages: 64, gaps: [] } }; },
  });
  await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(calls, 2);
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-matching-retry-started")));
});

test("partial and failed selected enrichment publish verified rows as limited on the final task attempt", async () => {
  let successfulCalls = 0;
  const success = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true, count: 1 }) }; },
    async enrich({ targets }) {
      successfulCalls += 1;
      return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 24, gaps: [] } };
    },
  });
  assert.equal((await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, success)).reportStatus, "limited");
  assert.equal(successfulCalls, 1);
  assert.equal(success.saves.length, 1);
  assert.equal(success.checkpoints.has(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX), false);
  assert.equal(success.events.some((item) => item.idempotencyKey === "orchestration-failed"), false);

  const failure = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true, count: 1 }) }; },
    async enrich() { throw new Error("selected page timeout"); },
  });
  assert.equal((await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, failure)).reportStatus, "limited");
  assert.equal(failure.saves.length, 1);
  assert.equal(failure.events.some((item) => item.idempotencyKey === "orchestration-failed"), false);
  assert.ok(failure.events.some((item) => item.idempotencyKey.endsWith("-limited") && item.phase === "enrichment"));
});

test("unschedulable accepted price gaps remain processing-incomplete instead of claiming exhaustion", async () => {
  const accepted = comparison({ withPair: true, count: 1 });
  accepted.rows[0].primary = { ...accepted.rows[0].primary, jsonLdType: "Service", priceSignals: [] };
  accepted.rows[0].matches[0].product = { ...accepted.rows[0].matches[0].product, jsonLdType: "Service", priceSignals: [] };
  let enrichCalls = 0;
  const port = mockPort({
    async match() { return { ok: true, comparison: accepted }; },
    async enrich() { enrichCalls += 1; throw new Error("unschedulable targets must not be fetched"); },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/);
  assert.equal(port.saves.length, 0);
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-1-matching-task-retry"));
  const terminal = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(terminal.reportStatus, "limited");
  assert.equal(enrichCalls, 0);
  assert.equal(port.saves.length, 1);
  const terminalBlock = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(terminalBlock.rows.length, 0);
  assert.equal(terminalBlock.matching.resultShortfallReason, "processing-incomplete");
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-2-matching-limited"));
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-limited") && item.phase === "enrichment" && item.metadata?.pagesPlanned === 0));
});

test("the final bounded task publishes a limited report when processing has zero verified rows", async () => {
  const empty = comparison({ withPair: false, count: 20 });
  empty.matching.resultShortfall = 20;
  empty.matching.resultShortfallReason = "processing-incomplete";
  empty.matching.gaps = ["Candidate processing remained incomplete within the bounded worker attempts."];
  const port = mockPort({
    async match() { return { ok: true, comparison: empty }; },
    async enrich() { throw new Error("zero-row processing must not schedule enrichment"); },
  });

  const terminal = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 10, isFinalAttempt: true }, port);

  assert.equal(terminal.reportStatus, "limited");
  assert.equal(port.saves.length, 1);
  const terminalBlock = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(terminalBlock.rows.length, 0);
  assert.equal(terminalBlock.matching.resultShortfallReason, "processing-incomplete");
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-10-matching-limited"));
  assert.equal(port.events.some((item) => item.idempotencyKey === "orchestration-failed"), false);
  assert.equal(port.factChunks.filter((chunk) => chunk.kind === "matches").flatMap((chunk) => chunk.items).length, 0);
  assert.equal(port.factManifests.length, 1);
  assert.equal(port.factManifests[0].counts.matches, 0);
  assert.equal(port.saves[0].expectedFactManifestHash, port.factManifests[0].manifestHash);
  const compaction = port.saves[0].document.document.blocks.find((block) => block.type === "presentation-compaction");
  assert.equal(compaction.relationalFactsAuthoritative, true);
  assert.deepEqual(compaction.factCounts, port.factManifests[0].counts);
});

test("the final bounded task does not misreport total matcher failure as zero-row exhaustion", async () => {
  const port = mockPort({ async match() { throw new Error("matcher contract authorization failed"); } });

  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 10, isFinalAttempt: true }, port),
    /remained incomplete after the final task attempt/,
  );
  assert.equal(port.saves.length, 0);
  assert.equal(port.factChunks.length, 0);
  assert.ok(port.events.some((event) => event.idempotencyKey === "orchestration-failed" && event.status === "failed"));
});

test("the final bounded task publishes a validated durable matcher result when both live matcher calls fail", async () => {
  const base = mockPort();
  let matcherAvailable = true;
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 1, createdAt: "2026-07-18T09:00:00.000Z", updatedAt: "2026-07-18T09:00:00.000Z", productPlan: "starter", productLimit: 20 },
        events: [],
      };
    },
    async crawl() {
      const result = await base.crawl();
      result.discovery.productSearchCoverage = {
        ...result.discovery.productSearchCoverage,
        searchedAnchors: 1,
        eligibleAnchors: 20,
        truncated: true,
        searchesComplete: false,
        complete: false,
      };
      return result;
    },
    async match() {
      if (!matcherAvailable) throw new Error("matcher transport unavailable");
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.imageUrl = "https://shop.example/images/honey.jpg";
      value.rows[0].matches[0].product.imageUrl = "https://rival.example/images/honey.jpg";
      value.rows[0].matches[0].assessment.priceComparable = true;
      value.matching.processedPrimaryIds = [...value.matching.assessedPrimaryIds];
      return { ok: true, comparison: value };
    },
  });

  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port),
    /remained incomplete before the final task attempt/,
  );
  assert.ok(port.checkpoints.has(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX));
  for (const [index, checkpoint] of port.checkpoints) port.checkpoints.set(index, JSON.parse(JSON.stringify(checkpoint)));

  matcherAvailable = false;
  const terminal = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 10, isFinalAttempt: true }, port);

  assert.equal(terminal.reportStatus, "limited");
  assert.equal(port.saves.length, 1);
  const terminalBlock = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(terminalBlock.rows.length, 1);
  assert.equal(terminalBlock.matching.resultShortfallReason, "processing-incomplete");
  assert.equal(port.factManifests[0].counts.matches, 1);
  const productFacts = port.factChunks.filter((chunk) => chunk.kind === "products").flatMap((chunk) => chunk.items);
  const primaryFact = productFacts.find((item) => item.domain === "shop.example" && item.productId === "p1");
  assert.equal(primaryFact.normalizedName, "honey 1 500g");
  assert.equal(primaryFact.prices.length, 1);
  assert.ok(port.events.some((item) => item.idempotencyKey === "report-1-task-10-matching-limited"));
  assert.equal(port.events.some((item) => item.idempotencyKey === "orchestration-failed"), false);
});

test("terminal product-page rejections permit truthful bounded exhaustion while preserving their gaps", async () => {
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      return {
        ok: true,
        products: [],
        coverage: {
          pagesRequested: targets.length,
          pagesFetched: 0,
          maxPages: 64,
          gaps: targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Product page was removed.", code: "fetch_failed", httpStatus: 404, failureKind: "http" })),
        },
      };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(result.limitedPhases.includes("enrichment"), false);
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.matching.resultShortfallReason, "bounded-candidate-pool-exhausted");
  assert.equal(block.enrichment.pagesTruncated, false);
  assert.equal(block.enrichment.gaps.length, 2);
});

test("complete discovery with no verified rival catalog publishes truthful bounded exhaustion", async () => {
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: false, count: 1 });
      value.matching.primaryProductsScreened = 1;
      value.matching.selectedPrimaryIds = ["p1"];
      value.matching.processedPrimaryIds = ["p1"];
      return { ok: true, comparison: value };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(result.reportStatus, "limited");
  assert.equal(block.matching.resultShortfallReason, "bounded-candidate-pool-exhausted");
  assert.equal(block.matching.resultShortfall, 20);
});

test("access-blocked product pages remain processing-incomplete", async () => {
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 64, gaps: targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Product page denied automated access.", code: "fetch_failed", httpStatus: 403, failureKind: "http" })) } };
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/);
  assert.equal(port.saves.length, 0);
});

test("successful enrichment batches can satisfy the twenty-row target despite a later batch failure", async () => {
  const batched = comparison({ withPair: true });
  const template = batched.rows[0];
  batched.rows = Array.from({ length: 70 }, (_, index) => {
    const primary = { ...template.primary, id: `p-${index}`, name: `Honey ${index} 500g`, normalizedName: `honey ${index} 500g`, sourceUrl: `https://shop.example/products/honey-${index}?country=GB`, imageUrl: "https://shop.example/images/honey.jpg", priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] };
    const rival = { ...template.matches[0].product, id: `r-${index}`, name: `Honey ${index} 500g`, normalizedName: `honey ${index} 500g`, sourceUrl: `https://rival.example/products/honey-${index}?country=GB`, imageUrl: "", priceSignals: [] };
    return { primary, matches: [{ ...template.matches[0], product: rival, assessment: { ...template.matches[0].assessment, primarySourceUrl: primary.sourceUrl, rivalSourceUrl: rival.sourceUrl } }] };
  });
  batched.coverage = { ...batched.coverage, primaryProductsAvailable: 70, primaryProductsScanned: 70, primaryProductFamiliesCompared: 70, competitorProductsAvailable: 70, competitorProductsScanned: 70, assignedPairCount: 70, verifiedPairCount: 70, rowsReturned: 70, rowLimit: 70 };
  batched.matching = { ...batched.matching, primaryProductsAssessed: 70, candidatePairsAssessed: 70, retrievalPairsScored: 70, selectedPrimaryIds: batched.rows.map((row) => row.primary.id), assessedPrimaryIds: batched.rows.map((row) => row.primary.id) };
  const batchSizes = [];
  const port = mockPort({
    async loadReport() {
      return { run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 1, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z", productPlan: "growth", productLimit: 500 }, events: [] };
    },
    async match() { return { ok: true, comparison: batched }; },
    async enrich({ targets }) {
      batchSizes.push(targets.length);
      if (batchSizes.length === 2) throw new Error("second batch unavailable");
      return { ok: true, products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: "GBP 7", currency: "GBP", amount: 7 }] })), coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] } };
    },
  });
  const result = await orchestrateReport({ ...payload, contractVersion: "3", productPlan: "growth", productLimit: 500 }, { attemptNumber: 1, isFinalAttempt: true }, port);
  assert.deepEqual(batchSizes, [64, 64, 12]);
  assert.equal(result.reportStatus, "limited");
  assert.equal(port.saves.at(-1).document.document.blocks.find((item) => item.type === "product-comparison").rows.length, 20);
  const durablePlan = port.checkpoints.get(299)?.result;
  assert.equal(durablePlan?.version, 2);
  assert.equal(Array.isArray(durablePlan?.targets), false);
  assert.equal(durablePlan?.targetHashes.length, 140);
  const checkpoints = port.events.filter((event) => /^enrichment-report-\d+-task-\d+-wave-\d+-checkpoint$/.test(event.idempotencyKey));
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].metadata.pagesRequested, 140);
});

test("task retries accumulate distinct priced results from earlier discovery waves", async () => {
  let matchCall = 0;
  const waveComparison = (offset) => {
    const value = comparison({ withPair: true, count: 10 });
    value.rows.forEach((item, index) => {
      const number = offset + index + 1;
      item.primary.id = `wave-p${number}`;
      item.primary.sourceUrl = `https://shop.example/products/wave-${number}?country=GB`;
      item.primary.imageUrl = `https://shop.example/images/wave-${number}.jpg`;
      item.matches[0].product.id = `wave-r${number}`;
      item.matches[0].product.sourceUrl = `https://rival.example/products/wave-${number}?country=GB`;
      item.matches[0].product.imageUrl = `https://rival.example/images/wave-${number}.jpg`;
    });
    value.matching.selectedPrimaryIds = value.rows.map((item) => item.primary.id);
    value.matching.assessedPrimaryIds = [...value.matching.selectedPrimaryIds];
    value.matching.processedPrimaryIds = [...value.matching.selectedPrimaryIds];
    return value;
  };
  const port = mockPort({
    async crawl() {
      const primaryProducts = Array.from({ length: 20 }, (_, index) => {
        const number = index + 1;
        return { ...product("shop.example", `wave-p${number}`), name: `Honey ${number} 500g`, normalizedName: `honey ${number} 500g`, sourceUrl: `https://shop.example/products/wave-${number}?country=GB` };
      });
      return {
        ok: true,
        primaryDomain: payload.primaryDomain,
        results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example", regionCountryCode: "GB" }, products: primaryProducts }],
        discovery: { productSearchCoverage: { eligibleAnchors: 1_000, searchedAnchors: 200, startIndex: 0, endIndex: 200, anchorSetHash: "stable-primary-catalog", truncated: true, searchesComplete: true, candidateDomainsFound: 1, candidateDomainsInvestigated: 1, candidateTruncated: false, verificationComplete: true, batchComplete: true, complete: false } },
        adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" },
        document: { version: "1", blocks: [] },
      };
    },
    async match() { const value = waveComparison(matchCall * 10); matchCall += 1; return { ok: true, comparison: value }; },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/i);
  assert.ok(port.checkpoints.has(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX));
  assert.equal(port.saves.length, 0);
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(port.saves.at(-1).document.document.blocks.find((block) => block.type === "product-comparison").rows.length, 20);
  assert.ok(port.checkpoints.has(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX - 1));
});

test("report recovery restores priced results accumulated by a later task attempt", async () => {
  let matchCall = 0;
  const waveComparison = (offset) => {
    const value = comparison({ withPair: true, count: 10 });
    value.rows.forEach((item, index) => {
      const number = offset + index + 1;
      item.primary.id = `recovered-p${number}`;
      item.primary.sourceUrl = `https://shop.example/products/recovered-${number}?country=GB`;
      item.primary.imageUrl = `https://shop.example/images/recovered-${number}.jpg`;
      item.matches[0].product.id = `recovered-r${number}`;
      item.matches[0].product.sourceUrl = `https://rival.example/products/recovered-${number}?country=GB`;
      item.matches[0].product.imageUrl = `https://rival.example/images/recovered-${number}.jpg`;
    });
    value.matching.selectedPrimaryIds = value.rows.map((item) => item.primary.id);
    value.matching.assessedPrimaryIds = [...value.matching.selectedPrimaryIds];
    value.matching.processedPrimaryIds = [...value.matching.selectedPrimaryIds];
    return value;
  };
  const port = mockPort({
    async crawl() {
      const primaryProducts = Array.from({ length: 20 }, (_, index) => {
        const number = index + 1;
        return { ...product("shop.example", `recovered-p${number}`), name: `Honey ${number} 500g`, normalizedName: `honey ${number} 500g`, sourceUrl: `https://shop.example/products/recovered-${number}?country=GB` };
      });
      return {
        ok: true,
        primaryDomain: payload.primaryDomain,
        results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example", regionCountryCode: "GB" }, products: primaryProducts }],
        discovery: { productSearchCoverage: { eligibleAnchors: 1_000, searchedAnchors: 200, startIndex: 0, endIndex: 200, anchorSetHash: "stable-recovery-catalog", truncated: true, searchesComplete: true, candidateDomainsFound: 1, candidateDomainsInvestigated: 1, candidateTruncated: false, verificationComplete: true, batchComplete: true, complete: false } },
        adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" },
        document: { version: "1", blocks: [] },
      };
    },
    async match() { const value = waveComparison(matchCall * 10); matchCall += 1; return { ok: true, comparison: value }; },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/i);
  const accumulated = port.checkpoints.get(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX);
  assert.ok(accumulated, `expected a published checkpoint after ${matchCall} match calls; keys=${[...port.checkpoints.keys()].join(",")}`);
  port.checkpoints.set(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX - 1, { ...accumulated, batchIndex: PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX - 1 });
  port.checkpoints.delete(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX);
  for (let index = CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE; index <= CRAWL_RESULT_CHECKPOINT_BATCH_INDEX; index += 1) port.checkpoints.delete(index);
  for (let index = 290; index <= 299; index += 1) port.checkpoints.delete(index);
  const loadPriorReport = port.loadReport.bind(port);
  port.loadReport = async () => {
    const stored = await loadPriorReport();
    return { ...stored, run: { ...stored.run, attemptCount: 2 } };
  };
  const result = await orchestrateReport(recoveryPayload, { attemptNumber: 2, taskAttemptNumber: 1, isFinalAttempt: true }, port);
  const block = port.saves.at(-1).document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(result.reportStatus, "complete");
  assert.equal(block.rows.length, 20);
  assert.deepEqual(block.rows.map((item) => item.primary.id).sort(), Array.from({ length: 20 }, (_, index) => `recovered-p${index + 1}`).sort());
});

test("a committed publication checkpoint with a lost response retains rich decisions and actions", async () => {
  const port = mockPort();
  const saveCheckpoint = port.saveCheckpoint.bind(port);
  let lostResponse = false;
  port.saveCheckpoint = async (publicId, input) => {
    await saveCheckpoint(publicId, input);
    if (!lostResponse && input.batchIndex === PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX) {
      const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
        : value;
      port.checkpoints.get(input.batchIndex).result = stable(structuredClone(input.result));
      lostResponse = true;
      throw new Error("publication checkpoint response lost");
    }
  };

  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true }, port);
  const block = port.saves.at(-1).document.document.blocks.find((item) => item.type === "product-comparison");
  const selected = block.rows.flatMap((item) => item.matches.filter((match) => match.product));
  assert.ok(lostResponse);
  assert.ok(selected.length > 0);
  assert.ok(selected.every((match) => match.decision?.recommendedMove));
  assert.ok(selected.every((match) => match.decision?.actionPlan));
});

test("an ambiguous publication save rejects different same-slot content with the same input hash", async () => {
  const port = mockPort();
  port.saveCheckpoint = async (_publicId, input) => {
    if (input.batchIndex !== PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX) {
      port.checkpoints.set(input.batchIndex, { attemptNumber: input.attemptNumber, batchIndex: input.batchIndex, inputHash: input.inputHash, result: input.result });
      return;
    }
    const conflicting = structuredClone(input.result);
    conflicting.comparison.matching.gaps = ["different committed result"];
    port.checkpoints.set(input.batchIndex, { attemptNumber: input.attemptNumber, batchIndex: input.batchIndex, inputHash: input.inputHash, result: conflicting });
    throw new Error("publication checkpoint conflict");
  };

  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true }, port),
    /publication checkpoint conflict/,
  );
  assert.equal(port.saves.length, 0);
});

test("an ambiguous publication save cannot adopt an older report attempt checkpoint", async () => {
  let matchCall = 0;
  const wave = (offset) => {
    const value = comparison({ withPair: true, count: 10 });
    value.rows.forEach((item, index) => {
      const number = offset + index + 1;
      item.primary.id = `owned-p${number}`;
      item.primary.sourceUrl = `https://shop.example/products/owned-${number}?country=GB`;
      item.primary.imageUrl = `https://shop.example/images/owned-${number}.jpg`;
      item.matches[0].product.id = `owned-r${number}`;
      item.matches[0].product.sourceUrl = `https://rival.example/products/owned-${number}?country=GB`;
      item.matches[0].product.imageUrl = `https://rival.example/images/owned-${number}.jpg`;
    });
    value.matching.selectedPrimaryIds = value.rows.map((item) => item.primary.id);
    value.matching.assessedPrimaryIds = [...value.matching.selectedPrimaryIds];
    value.matching.processedPrimaryIds = [...value.matching.selectedPrimaryIds];
    return value;
  };
  const port = mockPort({
    async crawl() {
      const products = Array.from({ length: 20 }, (_, index) => ({ ...product("shop.example", `owned-p${index + 1}`), name: `Honey ${index + 1} 500g`, normalizedName: `honey ${index + 1} 500g`, sourceUrl: `https://shop.example/products/owned-${index + 1}?country=GB` }));
      return { ok: true, primaryDomain: payload.primaryDomain, results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example", regionCountryCode: "GB" }, products }], discovery: { productSearchCoverage: { eligibleAnchors: 1_000, searchedAnchors: 200, startIndex: 0, endIndex: 200, anchorSetHash: "owned-catalog", truncated: true, searchesComplete: true, candidateDomainsFound: 1, candidateDomainsInvestigated: 1, candidateTruncated: false, verificationComplete: true, batchComplete: true, complete: false } }, adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" }, document: { version: "1", blocks: [] } };
    },
    async match() { const value = wave(matchCall * 10); matchCall += 1; return { ok: true, comparison: value }; },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/i);
  assert.equal(port.checkpoints.get(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX).attemptNumber, 1);
  for (let index = CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE; index <= CRAWL_RESULT_CHECKPOINT_BATCH_INDEX; index += 1) port.checkpoints.delete(index);
  for (let index = 290; index <= 299; index += 1) port.checkpoints.delete(index);
  const loadPriorReport = port.loadReport.bind(port);
  port.loadReport = async () => { const stored = await loadPriorReport(); return { ...stored, run: { ...stored.run, attemptCount: 2 } }; };
  const saveCheckpoint = port.saveCheckpoint.bind(port);
  port.saveCheckpoint = async (publicId, input) => {
    if (input.attemptNumber === 2 && input.batchIndex === PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX) throw new Error("current checkpoint write failed");
    return saveCheckpoint(publicId, input);
  };

  await assert.rejects(() => orchestrateReport(recoveryPayload, { attemptNumber: 2, taskAttemptNumber: 1, isFinalAttempt: true }, port), /current checkpoint write failed/);
  assert.equal(port.saves.length, 0);
});

test("catalog drift prevents stale priced-result accumulation", async () => {
  let matchCall = 0;
  let crawlCall = 0;
  const waveComparison = (offset) => {
    const value = comparison({ withPair: true, count: 10 });
    value.rows.forEach((item, index) => {
      const number = offset + index + 1;
      item.primary.id = `drift-p${number}`;
      item.primary.sourceUrl = `https://shop.example/products/drift-${number}?country=GB`;
      item.primary.imageUrl = `https://shop.example/images/drift-${number}.jpg`;
      item.matches[0].product.id = `drift-r${number}`;
      item.matches[0].product.sourceUrl = `https://rival.example/products/drift-${number}?country=GB`;
      item.matches[0].product.imageUrl = `https://rival.example/images/drift-${number}.jpg`;
    });
    value.matching.selectedPrimaryIds = value.rows.map((item) => item.primary.id);
    value.matching.assessedPrimaryIds = [...value.matching.selectedPrimaryIds];
    value.matching.processedPrimaryIds = [...value.matching.selectedPrimaryIds];
    return value;
  };
  const port = mockPort({
    async crawl() {
      crawlCall += 1;
      const count = crawlCall === 1 ? 20 : 21;
      const primaryProducts = Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        return { ...product("shop.example", `drift-p${number}`), name: `Honey ${number} 500g`, normalizedName: `honey ${number} 500g`, sourceUrl: `https://shop.example/products/drift-${number}?country=GB` };
      });
      return {
        ok: true,
        primaryDomain: payload.primaryDomain,
        results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example", regionCountryCode: "GB" }, products: primaryProducts }],
        discovery: { productSearchCoverage: { eligibleAnchors: count, searchedAnchors: count, startIndex: 0, endIndex: count, anchorSetHash: crawlCall === 1 ? "catalog-v1" : "catalog-v2", truncated: crawlCall === 1, searchesComplete: true, candidateDomainsFound: 1, candidateDomainsInvestigated: 1, candidateTruncated: false, verificationComplete: true, batchComplete: true, complete: crawlCall > 1 } },
        adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" },
        document: { version: "1", blocks: [] },
      };
    },
    async match() { const value = waveComparison(matchCall * 10); matchCall += 1; return { ok: true, comparison: value }; },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/i);
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  const block = port.saves.at(-1).document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(result.reportStatus, "limited");
  assert.equal(block.rows.length, 10);
  assert.equal(block.matching.resultShortfall, 10);
  assert.equal(crawlCall, 2);
});

test("a task retry reuses durable enrichment batches instead of fetching product pages again", async () => {
  let enrichCalls = 0;
  let saveCalls = 0;
  let matchCalls = 0;
  let crawlCalls = 0;
  const base = mockPort();
  const port = mockPort({
    async crawl() {
      crawlCalls += 1;
      const result = await base.crawl();
      const observedAt = `2026-07-2${crawlCalls}T10:00:00.000Z`;
      for (const catalog of result.results) for (const item of catalog.products) item.observedAt = observedAt;
      return result;
    },
    async match() {
      matchCalls += 1;
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = matchCalls === 1 ? [] : [{ raw: "GBP 0", currency: "GBP", amount: 0 }];
      value.rows[0].primary.imageUrl = matchCalls === 1 ? "" : "https://shop.example/images/changed.jpg";
      value.rows[0].matches[0].product.priceSignals = matchCalls === 1 ? [] : [{ raw: "GBP 0", currency: "GBP", amount: 0 }];
      value.rows[0].matches[0].product.imageUrl = matchCalls === 1 ? "" : "https://rival.example/images/changed.jpg";
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: target.role === "primary" ? "GBP 9" : "GBP 7", currency: "GBP", amount: target.role === "primary" ? 9 : 7 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
    async saveDocument() {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port);
  assert.equal(enrichCalls, 1);
  assert.equal(crawlCalls, 1);
  assert.equal(port.checkpoints.size, 9);
  assert.ok(port.checkpoints.has(299));
  assert.ok(port.checkpoints.has(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX));
  assert.ok(port.checkpoints.has(PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX - 1));
});

test("a task retry can persist an expanded enrichment plan after judge progress", async () => {
  let matchCalls = 0;
  const fetchedCounts = [];
  const port = mockPort({
    async match() {
      matchCalls += 1;
      const value = comparison({ withPair: true, count: matchCalls });
      for (const row of value.rows) {
        row.primary.priceSignals = [];
        row.matches[0].product.priceSignals = [];
      }
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      fetchedCounts.push(targets.length);
      return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 64, gaps: targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: fetchedCounts.length === 1 ? "Temporary network timeout." : "Product page was removed.", code: "fetch_failed", httpStatus: fetchedCounts.length === 1 ? 0 : 404, failureKind: fetchedCounts.length === 1 ? "network" : "http" })) } };
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/);
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(fetchedCounts, [2, 4]);
  assert.ok(port.checkpoints.has(299));
  assert.ok(port.checkpoints.has(298));
});

test("a task retry preserves successful pages, re-fetches only transient gaps, and uses attempt-scoped enrichment events", async () => {
  let enrichCalls = 0;
  const fetchedRoles = [];
  const eventPayloads = new Map();
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      fetchedRoles.push(targets.map((target) => target.role));
      if (enrichCalls === 1) {
        const primaryTarget = targets.find((target) => target.role === "primary");
        const rivalTarget = targets.find((target) => target.role === "rival");
        return {
          ok: true,
          products: [{ ...product(primaryTarget.domain, primaryTarget.productId), name: primaryTarget.expectedName, normalizedName: primaryTarget.expectedName.toLowerCase(), sourceUrl: primaryTarget.sourceUrl, priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] }],
          coverage: { pagesRequested: targets.length, pagesFetched: 1, maxPages: 64, gaps: [{ url: rivalTarget.sourceUrl, productId: rivalTarget.productId, role: rivalTarget.role, reason: "Temporary network timeout.", code: "fetch_failed", httpStatus: 0, failureKind: "network" }] },
        };
      }
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: target.role === "primary" ? "GBP 9" : "GBP 7", currency: "GBP", amount: target.role === "primary" ? 9 : 7 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
    async appendEvent(_publicId, value) {
      const serialized = JSON.stringify(value);
      const prior = eventPayloads.get(value.idempotencyKey);
      if (prior && prior !== serialized) throw new Error(`event conflict: ${value.idempotencyKey}`);
      eventPayloads.set(value.idempotencyKey, serialized);
      port.events.push(value);
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/);
  assert.ok(port.checkpoints.has(300));
  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(enrichCalls, 2);
  assert.deepEqual([...fetchedRoles[0]].sort(), ["primary", "rival"]);
  assert.deepEqual(fetchedRoles[1], ["rival"]);
  assert.equal(result.reportStatus, "limited");
  assert.ok(port.checkpoints.has(300 + MAX_FINAL_ENRICHMENT_BATCHES));
  assert.ok(port.events.some((item) => item.idempotencyKey === "enrichment-report-1-task-1-wave-1-checkpoint"));
  assert.ok(port.events.some((item) => item.idempotencyKey === "enrichment-report-1-task-2-wave-1-checkpoint"));
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.rows.length, 1);
  assert.equal(block.matching.publishedPrimaryProducts, 1);
});

test("a temporary adapter-limited price gap is terminal for the report and does not trigger another paid task", async () => {
  let enrichCalls = 0;
  const fetchedRoles = [];
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      fetchedRoles.push(targets.map((target) => target.role));
      if (enrichCalls === 1) {
        const primaryTarget = targets.find((target) => target.role === "primary");
        const rivalTarget = targets.find((target) => target.role === "rival");
        return {
          ok: true,
          products: [{ ...product(primaryTarget.domain, primaryTarget.productId), name: primaryTarget.expectedName, normalizedName: primaryTarget.expectedName.toLowerCase(), sourceUrl: primaryTarget.sourceUrl, priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] }],
          coverage: { pagesRequested: targets.length, pagesFetched: 1, maxPages: 64, gaps: [{ url: rivalTarget.sourceUrl, productId: rivalTarget.productId, role: rivalTarget.role, reason: "Price adapter was temporarily unavailable.", code: "adapter_limited", failureKind: "network", httpStatus: 0 }] },
        };
      }
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: "GBP 7", currency: "GBP", amount: 7 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(enrichCalls, 1);
  assert.deepEqual(fetchedRoles[0].sort(), ["primary", "rival"]);
  assert.equal(result.reportStatus, "limited");
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.rows.length, 0);
  assert.equal(block.enrichment.gaps[0].code, "adapter_limited");
});

test("a permanent adapter limitation terminalizes without a task retry or paid action planning", async () => {
  let matchCalls = 0;
  let enrichCalls = 0;
  let actionCalls = 0;
  const port = mockPort({
    async match() {
      matchCalls += 1;
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      const primaryTarget = targets.find((target) => target.role === "primary");
      const rivalTarget = targets.find((target) => target.role === "rival");
      return {
        ok: true,
        products: [{ ...product(primaryTarget.domain, primaryTarget.productId), name: primaryTarget.expectedName, normalizedName: primaryTarget.expectedName.toLowerCase(), sourceUrl: primaryTarget.sourceUrl, priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] }],
        coverage: { pagesRequested: targets.length, pagesFetched: 1, maxPages: 64, gaps: [{ url: rivalTarget.sourceUrl, productId: rivalTarget.productId, role: rivalTarget.role, reason: "No same-page currency was confirmed.", code: "adapter_limited", failureKind: "adapter" }] },
      };
    },
    async actions() { actionCalls += 1; throw new Error("must not plan actions without a published pair"); },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(matchCalls, 1);
  assert.equal(enrichCalls, 1);
  assert.equal(actionCalls, 0);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-1-matching-task-retry"), false);
});

test("a transient adapter failure does not retry or invoke paid action planning", async () => {
  let matchCalls = 0;
  let enrichCalls = 0;
  let actionCalls = 0;
  const port = mockPort({
    async match() {
      matchCalls += 1;
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      await persistJudgeEvidence(port, value);
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      const primaryTarget = targets.find((target) => target.role === "primary");
      const rivalTarget = targets.find((target) => target.role === "rival") || targets[0];
      const products = primaryTarget
        ? [{ ...product(primaryTarget.domain, primaryTarget.productId), name: primaryTarget.expectedName, normalizedName: primaryTarget.expectedName.toLowerCase(), sourceUrl: primaryTarget.sourceUrl, priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] }]
        : [];
      return {
        ok: true,
        products,
        coverage: { pagesRequested: targets.length, pagesFetched: products.length, maxPages: 64, gaps: [{ url: rivalTarget.sourceUrl, productId: rivalTarget.productId, role: rivalTarget.role, reason: "Price adapter remains temporarily unavailable.", code: "adapter_limited", failureKind: "network", httpStatus: 0 }] },
      };
    },
    async actions() { actionCalls += 1; throw new Error("must not plan actions without a published pair"); },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(matchCalls, 1);
  assert.equal(enrichCalls, 1);
  assert.equal(actionCalls, 0);
  assert.equal(port.events.some((item) => item.idempotencyKey === "report-1-task-1-matching-task-retry"), false);
});

test("a crash after a terminal adapter checkpoint reuses matcher and enrichment state", async () => {
  let saveCalls = 0;
  let matchCalls = 0;
  let enrichCalls = 0;
  let actionCalls = 0;
  const port = mockPort({
    async match() {
      matchCalls += 1;
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      await persistJudgeEvidence(port, value);
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      const primaryTarget = targets.find((target) => target.role === "primary");
      const rivalTarget = targets.find((target) => target.role === "rival");
      return {
        ok: true,
        products: [{ ...product(primaryTarget.domain, primaryTarget.productId), name: primaryTarget.expectedName, normalizedName: primaryTarget.expectedName.toLowerCase(), sourceUrl: primaryTarget.sourceUrl, priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] }],
        coverage: { pagesRequested: targets.length, pagesFetched: 1, maxPages: 64, gaps: [{ url: rivalTarget.sourceUrl, productId: rivalTarget.productId, role: rivalTarget.role, reason: "Price adapter temporarily unavailable.", code: "adapter_limited", failureKind: "network", httpStatus: 0 }] },
      };
    },
    async actions() { actionCalls += 1; throw new Error("must not run while no pair is publishable"); },
    async saveDocument(_publicId, value) {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("terminal callback lost");
      port.saves.push(value);
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /terminal callback lost/);
  assert.equal((await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: false }, port)).reportStatus, "limited");
  assert.equal(matchCalls, 1);
  assert.equal(enrichCalls, 1);
  assert.equal(actionCalls, 0);
});

test("a failed transient retry preserves prior successful pages and published pairs", async () => {
  let enrichCalls = 0;
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 2 });
      for (const row of value.rows) {
        row.primary.priceSignals = [];
        row.matches[0].product.priceSignals = [];
      }
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      if (enrichCalls > 1) throw new Error("retry transport failed");
      const failed = targets.at(-1);
      const products = targets.slice(0, -1).map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: target.role === "primary" ? "GBP 9" : "GBP 7", currency: "GBP", amount: target.role === "primary" ? 9 : 7 }] }));
      return { ok: true, products, coverage: { pagesRequested: targets.length, pagesFetched: products.length, maxPages: 64, gaps: [{ url: failed.sourceUrl, productId: failed.productId, role: failed.role, reason: "Temporary network timeout.", code: "fetch_failed", httpStatus: 0, failureKind: "network" }] } };
    },
  });

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/);
  assert.equal((await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port)).reportStatus, "limited");
  assert.equal(enrichCalls, 2);
  assert.equal(port.saves.length, 1);
  const firstBatch = [...port.checkpoints.values()].find((item) => item.result?.coverage?.pagesFetched === 3);
  assert.ok(firstBatch);
  assert.equal(firstBatch.result.coverage.gaps[0].failureKind, "network");
});

test("an ambiguous checkpoint-save response reloads and uses the committed enrichment batch", async () => {
  let enrichCalls = 0;
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: target.role === "primary" ? "GBP 9" : "GBP 7", currency: "GBP", amount: target.role === "primary" ? 9 : 7 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
  });
  const saveCheckpoint = port.saveCheckpoint.bind(port);
  let loseResponse = true;
  port.saveCheckpoint = async (...args) => {
    await saveCheckpoint(...args);
    if (loseResponse) { loseResponse = false; throw new Error("checkpoint response lost"); }
  };

  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(enrichCalls, 1);
  assert.equal(result.reportStatus, "limited");
  assert.equal(result.limitedPhases.includes("enrichment"), false);
  const productBlock = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(productBlock.rows.flatMap((row) => row.matches).filter((match) => match.product).length, 1);
});

test("an ambiguous enrichment save rejects different same-slot observations", async () => {
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
  });
  const saveCheckpoint = port.saveCheckpoint.bind(port);
  let conflicted = false;
  port.saveCheckpoint = async (publicId, input) => {
    await saveCheckpoint(publicId, input);
    if (!conflicted && input.batchIndex >= 300 && input.batchIndex < 300 + MAX_FINAL_ENRICHMENT_BATCHES) {
      const committed = structuredClone(port.checkpoints.get(input.batchIndex));
      committed.result.products[0].priceSignals = [{ raw: "GBP 12", currency: "GBP", amount: 12 }];
      port.checkpoints.set(input.batchIndex, committed);
      conflicted = true;
      throw new Error("checkpoint response lost");
    }
  };

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, port), /checkpoint save committed conflicting content/);
  assert.equal(conflicted, true);
  assert.equal(port.saves.length, 0);
});

test("an ambiguous enrichment save fails closed when its confirmation read also fails", async () => {
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
  });
  const saveCheckpoint = port.saveCheckpoint.bind(port);
  const loadCheckpoint = port.loadCheckpoint.bind(port);
  port.saveCheckpoint = async (publicId, input) => {
    if (input.batchIndex >= 300 && input.batchIndex < 300 + MAX_FINAL_ENRICHMENT_BATCHES) throw new Error("checkpoint response lost");
    return saveCheckpoint(publicId, input);
  };
  port.loadCheckpoint = async (publicId, input) => {
    if (input.batchIndex >= 300 && input.batchIndex < 300 + MAX_FINAL_ENRICHMENT_BATCHES) throw new Error("checkpoint confirmation unavailable");
    return loadCheckpoint(publicId, input);
  };

  await assert.rejects(
    () => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, port),
    /checkpoint save could not be confirmed/,
  );
  assert.equal(port.saves.length, 0);
});

test("a shape-valid but semantically incomplete enrichment checkpoint is rejected", async () => {
  let enrichCalls = 0;
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich({ targets }) {
      enrichCalls += 1;
      return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 64, gaps: targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Test fixture network gap.", code: "fetch_failed", httpStatus: 0, failureKind: "network" })) } };
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: false }, port), /remained incomplete/);
  const checkpoint = [...port.checkpoints.values()].find((value) => value.batchIndex >= 300 && value.result?.coverage);
  assert.ok(checkpoint);
  checkpoint.result.coverage.gaps = [];
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port), /durable enrichment checkpoint is invalid/);
  assert.equal(enrichCalls, 1);
  assert.equal(port.saves.length, 0);
});

test("a conflicting enrichment checkpoint fails closed without fetching or publishing it", async () => {
  let enrichCalls = 0;
  const accepted = comparison({ withPair: true, count: 20 });
  for (const row of accepted.rows) {
    row.primary.priceSignals = [];
    row.matches[0].product.priceSignals = [];
  }
  const recoveredProducts = accepted.rows.flatMap((row) => [
    { ...row.primary, priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }] },
    { ...row.matches[0].product, priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] },
  ]);
  const enrichmentPlan = planFinalProductEnrichmentTargets(accepted, pricedResultEnrichmentBudget(payload.productLimit), Date.parse("2026-07-20T10:00:00.000Z"));
  const batchTargets = enrichmentPlan.targets.slice(0, 64);
  const conflictingCheckpoint = {
    batchIndex: 300,
    attemptNumber: 1,
    inputHash: createHash("sha256").update(JSON.stringify({ version: 2, targets: batchTargets })).digest("hex"),
    result: { ok: true, products: recoveredProducts, coverage: { pagesRequested: recoveredProducts.length, pagesFetched: recoveredProducts.length, maxPages: 64, gaps: [] } },
  };
  const conflictingPlan = { batchIndex: 299, attemptNumber: 1, inputHash: "0".repeat(64), result: { version: 2, contentHash: "0".repeat(64), targetHashes: [], totalEligible: 0, truncated: false } };
  const port = mockPort({
    async match() { return { ok: true, comparison: accepted }; },
    async enrich() { enrichCalls += 1; throw new Error("must not fetch after a checkpoint conflict"); },
  });
  const loadCheckpoint = port.loadCheckpoint.bind(port);
  port.loadCheckpoint = async (publicId, input) => input.batchIndex === undefined && input.batchIndexStart <= 299 && input.batchIndexEnd >= 300
    ? [conflictingPlan, conflictingCheckpoint]
    : input.batchIndex === undefined && input.batchIndexStart <= 300 && input.batchIndexEnd >= 300
      ? [conflictingCheckpoint]
    : input.batchIndex !== undefined && input.batchIndex >= 300
      ? [{ ...conflictingCheckpoint, batchIndex: input.batchIndex }]
      : loadCheckpoint(publicId, input);

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, port), /durable enrichment plan conflicts/);
  assert.equal(enrichCalls, 0);
  assert.equal(port.saves.length, 0);
});

test("action planning runs after final enrichment and persists source-labelled plans", async () => {
  let sawEnrichedPrice = false;
  const port = mockPort({
    async match() {
      const input = comparison({ withPair: true });
      for (const row of input.rows) row.primary.priceSignals = [];
      return { ok: true, comparison: input };
    },
    async enrich({ targets }) {
      return {
        ok: true,
        products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: target.role === "primary" ? "GBP 9" : "GBP 7", currency: "GBP", amount: target.role === "primary" ? 9 : 7 }] })),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] },
      };
    },
    async actions({ inputs }) {
      sawEnrichedPrice = inputs.some((input) => input.facts.some((fact) => fact.text === "GBP 9"));
      return { ok: true, result: deterministicProductActionResult(inputs) };
    },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(sawEnrichedPrice, true);
  const eventKeys = port.events.map((item) => item.idempotencyKey);
  assert.ok(eventKeys.findIndex((key) => key.endsWith("-complete") && key.startsWith("enrichment-report-")) < eventKeys.findIndex((key) => key.endsWith("-actions-started")));
  assert.ok(eventKeys.findIndex((key) => key.endsWith("-actions-complete")) < eventKeys.findIndex((key) => key.endsWith("-matching-complete")));
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.actionPlanning.fallbackActions, 20);
  assert.equal(block.rows[0].matches[0].decision.actionPlan.source, "deterministic");
});

test("AI action transport failure retains deterministic moves without limiting the report", async () => {
  const port = mockPort({
    async match() {
      const priced = comparison({ withPair: true });
      priced.rows[0].primary.priceSignals = [{ raw: "GBP 9", currency: "GBP", amount: 9 }];
      return { ok: true, comparison: priced };
    },
    async enrich({ targets }) { return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] } }; },
    async actions() { throw new Error("action provider timeout"); },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(result.limitedPhases.includes("actions"), false);
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.rows[0].matches[0].decision.actionPlan.source, "deterministic");
  assert.match(block.actionPlanning.gaps.join(" "), /provider timeout/i);
});

test("a final non-crawl failure records one terminal orchestration event", async () => {
  const port = mockPort({
    async loadReport() { return { run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 2, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" }, events: [] }; },
    async saveDocument() { throw new Error("storage unavailable"); },
  });
  await assert.rejects(orchestrateReport(recoveryPayload, { attemptNumber: 2, isFinalAttempt: true }, port), /storage unavailable/);
  const failure = port.events.at(-1);
  assert.equal(failure.idempotencyKey, "orchestration-failed");
  assert.equal(failure.status, "failed");
});

test("HTTP transport retries only bounded transient statuses and never leaks its credential", async () => {
  const token = "callback_secret_that_must_never_appear_12345";
  const calls = [];
  const responses = [
    new Response("temporary body containing " + token, { status: 503 }),
    Response.json({ ok: true, report: { run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: "en", status: "queued", createdAt: "now", updatedAt: "now" }, events: [] } }),
  ];
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: token,
    async fetchImpl(url, init) { calls.push({ url, init }); return responses.shift(); },
  });
  const stored = await port.loadReport(payload.publicId);
  assert.equal(stored.run.primaryDomain, payload.primaryDomain);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://market.example/api/internal/reports/${payload.publicId}`);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);

  const permanentCalls = [];
  const badPort = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: token,
    async fetchImpl(url) { permanentCalls.push(url); return new Response("Authorization: Bearer " + token, { status: 400 }); },
  });
  await assert.rejects(badPort.loadReport(payload.publicId), (error) => {
    assert.equal(error.message.includes(token), false);
    assert.equal(/authorization/i.test(error.message), false);
    return true;
  });
  assert.equal(permanentCalls.length, 1);
  assert.equal(isRetryableHttpStatus(408), true);
  assert.equal(isRetryableHttpStatus(425), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(400), false);
});

test("HTTP preflight validates the private worker API manifest and treats deterministic incompatibility as permanent", async () => {
  const token = "callback_secret_with_enough_entropy_123456";
  const calls = [];
  const valid = createWorkerApiManifest(() => new Date("2026-07-26T12:00:00.000Z"));
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: token,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return Response.json(valid);
    },
  });
  await port.preflight();
  assert.equal(calls[0].url, "https://market.example/api/internal/capabilities");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);

  for (const response of [
    Response.json({ ...valid, protocolVersion: "2" }),
    new Response("missing", { status: 404 }),
    new Response("unauthorized", { status: 401 }),
  ]) {
    const incompatible = createReportOrchestrationHttpPort({
      appOrigin: "https://market.example",
      callbackToken: token,
      async fetchImpl() { return response.clone(); },
    });
    await assert.rejects(incompatible.preflight(), PermanentOrchestrationError);
  }
});

test("HTTP preflight preserves bounded retries for transient readiness failures", async () => {
  let calls = 0;
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl() {
      calls += 1;
      return new Response("temporarily unavailable", { status: 503 });
    },
  });
  await assert.rejects(port.preflight(), (error) => {
    assert.equal(error instanceof OrchestrationHttpError, true);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls, 2);
});

test("the HTTP action adapter uses the internal route, bounded budget, and bearer credential", async () => {
  const calls = [];
  const result = deterministicProductActionResult([]);
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return Response.json({ ok: true, result });
    },
  });
  const response = await port.actions({ inputs: [] });
  assert.deepEqual(response.result, result);
  assert.equal(calls[0].url, "https://market.example/api/actions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer callback_secret_with_enough_entropy_123456");
  assert.equal(OPERATION_BUDGETS_MS.actions, 35_000);
  assert.ok(OPERATION_BUDGETS_MS.actions >= AI_ACTION_PLANNER_LIMITS.totalBudgetMs + 5_000, "action transport must preserve serialization headroom above the planner budget");
});

test("the HTTP report adapter sends authenticated fact chunks and the final manifest", async () => {
  const bodies = [];
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(_url, init) { bodies.push(JSON.parse(init.body)); return Response.json({ ok: true }); },
  });
  await port.persistFactChunk(payload.publicId, { manifestId: "a".repeat(64), kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: "b".repeat(64), items: [] });
  await port.finalizeFactManifest(payload.publicId, { manifestId: "a".repeat(64), manifestHash: "c".repeat(64), counts: { companies: 0, products: 0, matches: 0, ads: 0 } });
  assert.equal(bodies[0].action, "fact-chunk");
  assert.equal(bodies[1].action, "fact-manifest");
});

test("the HTTP report adapter reads and writes exact enrichment checkpoints", async () => {
  const bodies = [];
  const checkpoint = { batchIndex: 301, inputHash: "a".repeat(64), result: { ok: true, products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } } };
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body);
      bodies.push({ body, authorization: init.headers.Authorization });
      return Response.json(body.action === "match-batch-checkpoints-load" ? { ok: true, checkpoints: [checkpoint] } : { ok: true, checkpoint: { attemptNumber: body.attemptNumber, batchIndex: body.batchIndex, inputHash: body.inputHash, result: body.result } });
    },
  });
  assert.deepEqual(await port.loadCheckpoint(payload.publicId, { attemptNumber: 2, batchIndex: 301 }), [checkpoint]);
  await port.saveCheckpoint(payload.publicId, { attemptNumber: 2, ...checkpoint });
  assert.deepEqual(bodies.map(({ body }) => body.action), ["match-batch-checkpoints-load", "match-batch-checkpoint-save"]);
  assert.deepEqual(bodies.map(({ body }) => [body.attemptNumber, body.batchIndex]), [[2, 301], [2, 301]]);
  assert.ok(bodies.every(({ authorization }) => authorization === "Bearer callback_secret_with_enough_entropy_123456"));
});

test("the HTTP report adapter rejects a success response for different checkpoint content", async () => {
  const checkpoint = { attemptNumber: 2, batchIndex: 301, inputHash: "a".repeat(64), result: { ok: true } };
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl() { return Response.json({ ok: true, checkpoint: { ...checkpoint, result: { ok: false } } }); },
  });
  await assert.rejects(() => port.saveCheckpoint(payload.publicId, checkpoint), /HTTP 502/);
});

test("the HTTP report adapter pages checkpoint recovery below the response transport bound", async () => {
  const bodies = [];
  const firstPage = Array.from({ length: 20 }, (_, index) => ({ attemptNumber: 3, batchIndex: index, inputHash: `${index}`.padStart(64, "a").slice(-64), result: { index } }));
  const finalPage = [{ attemptNumber: 2, batchIndex: 40, inputHash: "b".repeat(64), result: { index: 20 } }];
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json({ ok: true, checkpoints: bodies.length === 1 ? firstPage : finalPage });
    },
  });

  const loaded = await port.loadCheckpoint(payload.publicId, { attemptNumber: 3, batchIndexStart: 1_400, batchIndexEnd: 1_649, latestPerBatch: true });

  assert.equal(loaded.length, 21);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map((body) => body.limit), [20, 20]);
  assert.equal(bodies[0].afterAttemptNumber, undefined);
  assert.equal(bodies[1].afterAttemptNumber, 3);
  assert.equal(bodies[1].afterBatchIndex, 19);
  assert.ok(bodies.every((body) => body.batchIndexStart === 1_400 && body.batchIndexEnd === 1_649 && body.latestPerBatch === true));
  assert.equal(checkpointReadPageBound(11, 20), 2_201);
  assert.equal(checkpointReadPageBound(20, 20, 1_400, 1_649, true), 14);
  assert.throws(() => checkpointReadPageBound(21, 20), /Invalid checkpoint paging bound/);
});

test("the HTTP report adapter enforces a caller checkpoint limit at the API boundary", async () => {
  const bodies = [];
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json({ ok: true, checkpoints: [{ attemptNumber: 3, batchIndex: 262, inputHash: "a".repeat(64), result: { data: "bounded" } }] });
    },
  });

  const loaded = await port.loadCheckpoint(payload.publicId, { attemptNumber: 3, batchIndexStart: 262, batchIndexEnd: 262, latestPerBatch: true, limit: 1 });

  assert.equal(loaded.length, 1);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].limit, 1);
});

test("the HTTP report adapter compacts a large terminal document before transport", async () => {
  let body;
  const source = babanujScaleDocument();
  const originalBytes = encodedJsonBytes(source);
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl(_url, init) { body = JSON.parse(init.body); return Response.json({ ok: true }); },
  });
  await port.saveDocument(payload.publicId, { status: "limited", observedAt: "2026-08-03T00:00:00.000Z", expectedFactManifestHash: "", document: source });
  assert.ok(originalBytes > REPORT_PRESENTATION_TARGET_BYTES);
  assert.ok(encodedJsonBytes(body.document) <= REPORT_PRESENTATION_TARGET_BYTES);
  assert.ok(encodedJsonBytes(body) < REPORT_CALLBACK_ENVELOPE_BYTES);
  assert.equal(body.document.document.blocks.find((block) => block.type === "presentation-compaction").relationalFactsAuthoritative, false);
});

test("the internal report port maps a missing stored report to null without retrying", async () => {
  let calls = 0;
  const port = createReportOrchestrationHttpPort({
    appOrigin: "https://market.example",
    callbackToken: "callback_secret_with_enough_entropy_123456",
    async fetchImpl() { calls += 1; return new Response("missing", { status: 404 }); },
  });
  assert.equal(await port.loadReport(payload.publicId), null);
  assert.equal(calls, 1);
});
