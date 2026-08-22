import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  PermanentOrchestrationError,
  parseReportOrchestrationPayload,
} from "../src/trigger/contracts/report-orchestration.ts";
import {
  MAX_FINAL_ENRICHMENT_TARGETS,
  MAX_FINAL_ENRICHMENT_BATCHES,
  MAX_OPERATION_TIMEOUT_MS,
  orchestrateReport,
  pricedResultEnrichmentBudget,
  validEnrichmentCheckpoint,
} from "../src/trigger/report-orchestration-core.ts";
import {
  OPERATION_BUDGETS_MS,
  ORCHESTRATION_FETCH_TIMEOUT_MS,
  OrchestrationHttpError,
  WORST_CASE_CRITICAL_PATH_MS,
  createOrchestrationFetch,
  createReportOrchestrationHttpPort,
  isRetryableHttpStatus,
} from "../src/trigger/report-orchestration-http.ts";
import { encodedJsonBytes, REPORT_CALLBACK_ENVELOPE_BYTES, REPORT_PRESENTATION_TARGET_BYTES } from "../src/shared/report-document-compaction.ts";
import { babanujScaleDocument } from "./fixtures/babanuj-report-document.mjs";
import { createWorkerApiManifest } from "../src/shared/worker-api-contract.ts";
import { AI_ACTION_PLANNER_LIMITS, deterministicProductActionResult } from "../app/lib/ai-action-planner.ts";
import { publishPricedProductComparison } from "../app/lib/product-match-lifecycle.ts";

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
  assert.equal(pricedResultEnrichmentBudget(20), MAX_FINAL_ENRICHMENT_TARGETS);
  assert.equal(pricedResultEnrichmentBudget(200), MAX_FINAL_ENRICHMENT_TARGETS);
  assert.equal(pricedResultEnrichmentBudget(1_000), MAX_FINAL_ENRICHMENT_TARGETS);
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
      return {
        ok: true,
        primaryDomain: payload.primaryDomain,
        results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example" }, products: [product()] }],
        discovery: { productSearchCoverage: { eligibleAnchors: 1, searchedAnchors: 1, startIndex: 0, endIndex: 1, truncated: false, searchesComplete: true, candidateDomainsFound: 1, candidateDomainsInvestigated: 1, candidateTruncated: false, verificationComplete: true, batchComplete: true, complete: true } },
        adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" },
        document: { version: "1", blocks: [] },
      };
    },
    async brief() { return { ok: true, summary: "Observed market" }; },
    async ads() { return { ok: true, block: { type: "ad-intelligence", id: "ad-intelligence" } }; },
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich({ targets }) { return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: targets.length, gaps: targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Test fixture did not fetch this page." })) } }; },
    async loadCheckpoint(_publicId, input) { return checkpoints.has(input.batchIndex) ? [checkpoints.get(input.batchIndex)] : []; },
    async saveCheckpoint(_publicId, input) {
      const existing = checkpoints.get(input.batchIndex);
      if (existing && (existing.inputHash !== input.inputHash || JSON.stringify(existing.result) !== JSON.stringify(input.result))) throw new Error("checkpoint conflict");
      checkpoints.set(input.batchIndex, { batchIndex: input.batchIndex, inputHash: input.inputHash, result: input.result });
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

test("a retry advances to the next discovery anchor batch only after a complete prior batch", async () => {
  const base = mockPort();
  let crawlInput;
  const port = mockPort({
    async loadReport() {
      const stored = await base.loadReport();
      return {
        ...stored,
        events: [
          { idempotencyKey: "prior", phase: "competitors", status: "running", metadata: { discoveryStartIndex: 0, discoveryEndIndex: 20, discoveryBatchComplete: true, discoveryAnchorSetHash: "a".repeat(64) } },
          { idempotencyKey: "failed-next", phase: "competitors", status: "running", metadata: { discoveryStartIndex: 20, discoveryEndIndex: 40, discoveryBatchComplete: false } },
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

test("the matcher can publish a valid pair found after the first 20 primary catalog products", async () => {
  const primaryProducts = Array.from({ length: 25 }, (_, index) => ({
    ...product("shop.example", `p-${index + 1}`),
    name: `Catalog product ${index + 1}`,
    normalizedName: `catalog product ${index + 1}`,
    sourceUrl: `https://shop.example/products/catalog-${index + 1}?country=GB`,
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

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port), /remained incomplete after the final task attempt/);
  assert.equal(port.saves.length, 0);
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
  const gap = { url: targets[1].sourceUrl, productId: targets[1].productId, role: "rival", reason: "Unavailable." };
  assert.ok(validEnrichmentCheckpoint({ ...complete, products: [products[0]], coverage: { ...complete.coverage, pagesFetched: 1, gaps: [gap] } }, targets));
  assert.equal(validEnrichmentCheckpoint({ ...complete, coverage: { ...complete.coverage, gaps: [gap] } }, targets), null);
  assert.equal(validEnrichmentCheckpoint({ ...complete, products: [products[0]], coverage: { ...complete.coverage, pagesFetched: 1, gaps: [gap, gap] } }, targets), null);
  const allGaps = targets.map((target) => ({ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "Unavailable." }));
  assert.ok(validEnrichmentCheckpoint({ ...complete, products: [], coverage: { ...complete.coverage, pagesFetched: 0, gaps: allGaps } }, targets));
});

test("the priced table is capped while suppressed screened evidence remains in relational facts", async () => {
  const screened = comparison({ withPair: true, count: 22 });
  screened.rows[21].matches[0].product.priceSignals = [];
  const port = mockPort({
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
  assert.ok(matchFacts.some((fact) => fact.evidence.publication?.priceEligible === false && fact.evidence.publication?.reason === "outside-result-target"));
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

test("relational fact persistence failure stays visible while the dashboard snapshot is still saved", async () => {
  const port = mockPort({ async persistFactChunk() { throw new Error("database temporarily unavailable"); } });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.limitedPhases, ["persistence"]);
  assert.equal(port.saves.length, 1);
  assert.match(port.events.find((item) => item.idempotencyKey.endsWith("-facts-limited")).metadata.reason, /database temporarily unavailable/);
  assert.equal(port.saves[0].document.document.blocks.find((block) => block.type === "presentation-compaction").relationalFactsAuthoritative, false);
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
    async actions({ inputs }) {
      const result = deterministicProductActionResult(inputs);
      return { ok: true, result: { ...result, plans: result.plans.map((entry) => ({ ...entry, plan: { ...entry.plan, actionEn: `Retry presentation: ${entry.plan.actionEn}` } })) } };
    },
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(port.factChunks.length, 0);
  assert.equal(port.factManifests.length, 0);
  assert.deepEqual(port.events.find((item) => item.idempotencyKey.endsWith("-facts-complete")).metadata, manifest.counts);
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

test("fact telemetry callback failures never prevent the terminal document", async () => {
  const port = mockPort({
    async persistFactChunk() { throw new Error("fact database unavailable"); },
    async appendEvent(_publicId, value) {
      if (value.idempotencyKey.endsWith("-facts-limited")) throw new Error("telemetry unavailable");
      port.events.push(value);
    },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(port.saves.length, 1);
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
  assert.equal(MAX_OPERATION_TIMEOUT_MS, 780_000);
  for (const timeout of Object.values(OPERATION_BUDGETS_MS)) assert.ok(timeout <= MAX_OPERATION_TIMEOUT_MS);
  assert.ok(ORCHESTRATION_FETCH_TIMEOUT_MS > OPERATION_BUDGETS_MS.match, "Undici must not preempt the match operation deadline");
  assert.ok(ORCHESTRATION_FETCH_TIMEOUT_MS < MAX_OPERATION_TIMEOUT_MS, "the worker deadline must remain inside the outer edge window");
  assert.equal(WORST_CASE_CRITICAL_PATH_MS, 12_445_000);
  assert.ok(WORST_CASE_CRITICAL_PATH_MS <= 12_480_000, "critical path must preserve a two-minute task-ceiling margin");
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

test("partial and failed selected enrichment fail closed even on the final task attempt", async () => {
  let successfulCalls = 0;
  const success = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true, count: 1 }) }; },
    async enrich({ targets }) {
      successfulCalls += 1;
      return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 24, gaps: [] } };
    },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, success), /remained incomplete after the final task attempt/);
  assert.equal(successfulCalls, 1);
  assert.equal(success.saves.length, 0);
  assert.equal(success.events.some((item) => item.idempotencyKey === "orchestration-failed"), false);

  const failure = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true, count: 1 }) }; },
    async enrich() { throw new Error("selected page timeout"); },
  });
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, failure), /remained incomplete after the final task attempt/);
  assert.equal(failure.saves.length, 0);
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
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port), /remained incomplete after the final task attempt/);
  assert.equal(enrichCalls, 0);
  assert.equal(port.saves.length, 0);
  assert.ok(port.events.some((item) => item.idempotencyKey.endsWith("-limited") && item.phase === "enrichment" && item.metadata?.pagesPlanned === 0));
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

test("publication-ineligible pairs are re-read on both sides and successful batches survive a failure", async () => {
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
  await assert.rejects(() => orchestrateReport({ ...payload, contractVersion: "3", productPlan: "growth", productLimit: 500 }, { attemptNumber: 1, isFinalAttempt: true }, port), /remained incomplete after the final task attempt/);
  assert.deepEqual(batchSizes, [64, 64, 12]);
  assert.equal(port.saves.length, 0);
  const checkpoints = port.events.filter((event) => /^enrichment-report-\d+-task-\d+-wave-\d+-checkpoint$/.test(event.idempotencyKey));
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[1].metadata.pagesRequested, 140);
});

test("a task retry reuses durable enrichment batches instead of fetching product pages again", async () => {
  let enrichCalls = 0;
  let saveCalls = 0;
  let matchCalls = 0;
  const port = mockPort({
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
  assert.equal(port.checkpoints.size, 2);
  assert.ok(port.checkpoints.has(299));
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
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port), /remained incomplete after the final task attempt/);
  assert.equal(enrichCalls, 2);
  assert.equal(port.saves.length, 0);
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
  const checkpoint = [...port.checkpoints.values()].find((value) => value.result?.coverage);
  assert.ok(checkpoint);
  checkpoint.result.coverage.gaps = [];
  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port), /remained incomplete after the final task attempt/);
  assert.equal(enrichCalls, 1);
  assert.equal(port.saves.length, 0);
});

test("a conflicting enrichment checkpoint fails closed without fetching or publishing it", async () => {
  let enrichCalls = 0;
  const port = mockPort({
    async match() {
      const value = comparison({ withPair: true, count: 1 });
      value.rows[0].primary.priceSignals = [];
      value.rows[0].matches[0].product.priceSignals = [];
      return { ok: true, comparison: value };
    },
    async enrich() { enrichCalls += 1; throw new Error("must not fetch after a checkpoint conflict"); },
  });
  const loadCheckpoint = port.loadCheckpoint.bind(port);
  port.loadCheckpoint = async (publicId, input) => input.batchIndex >= 300
    ? [{ batchIndex: input.batchIndex, inputHash: "0".repeat(64), result: { ok: true, products: [], coverage: { pagesRequested: 2, pagesFetched: 0, maxPages: 64, gaps: [] } } }]
    : loadCheckpoint(publicId, input);

  await assert.rejects(() => orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: true }, port), /remained incomplete after the final task attempt/);
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
      return Response.json(body.action === "match-batch-checkpoints-load" ? { ok: true, checkpoints: [checkpoint] } : { ok: true });
    },
  });
  assert.deepEqual(await port.loadCheckpoint(payload.publicId, { attemptNumber: 2, batchIndex: 301 }), [checkpoint]);
  await port.saveCheckpoint(payload.publicId, { attemptNumber: 2, ...checkpoint });
  assert.deepEqual(bodies.map(({ body }) => body.action), ["match-batch-checkpoints-load", "match-batch-checkpoint-save"]);
  assert.deepEqual(bodies.map(({ body }) => [body.attemptNumber, body.batchIndex]), [[2, 301], [2, 301]]);
  assert.ok(bodies.every(({ authorization }) => authorization === "Bearer callback_secret_with_enough_entropy_123456"));
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
