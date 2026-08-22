import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  PermanentOrchestrationError,
  parseReportOrchestrationPayload,
} from "../src/trigger/contracts/report-orchestration.ts";
import {
  MAX_OPERATION_TIMEOUT_MS,
  orchestrateReport,
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

const payload = {
  contractVersion: "4",
  publicId: "a".repeat(32),
  primaryDomain: "shop.example",
  locale: "en",
  reportAttempt: 1,
  productPlan: "starter",
  productLimit: 20,
};
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
    const primary = { ...product("shop.example", `p1${suffix}`), name: `Honey ${index + 1} 500g`, normalizedName: `honey ${index + 1} 500g`, sourceUrl: `https://shop.example/products/honey${suffix}`, priceSignals: withPair ? [{ raw: "GBP 10", currency: "GBP", amount: 10 }] : [] };
    const rival = { ...product("rival.example", `r1${suffix}`), name: primary.name, normalizedName: primary.normalizedName, sourceUrl: `https://rival.example/products/honey${suffix}`, priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
    return { primary, rival };
  });
  return {
    primaryDomain: "shop.example",
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
  const port = {
    events,
    saves,
    factChunks,
    factManifests,
    async preflight() {},
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", attemptCount: 1, createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
        events: [],
      };
    },
    async appendEvent(_publicId, value) { events.push(value); },
    async crawl() {
      return {
        ok: true,
        primaryDomain: payload.primaryDomain,
        results: [{ domain: payload.primaryDomain, homepage: { sourceUrl: "https://shop.example" }, products: [product()] }],
        adRequest: { companies: [{ domain: payload.primaryDomain }], region: "GB" },
        document: { version: "1", blocks: [] },
      };
    },
    async brief() { return { ok: true, summary: "Observed market" }; },
    async ads() { return { ok: true, block: { type: "ad-intelligence", id: "ad-intelligence" } }; },
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich({ targets }) { return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] } }; },
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
  const port = mockPort({ async match(input) {
    assert.equal(input.productLimit, 20);
    return { ok: true, comparison: comparison({ withPair: true }) };
  } });
  const dates = ["2026-07-20T10:00:00.000Z", "2026-07-20T10:01:00.000Z"];
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port, () => new Date(dates.shift()));

  assert.equal(result.reportStatus, "complete");
  assert.deepEqual(result.limitedPhases, []);
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].status, "complete");
  assert.ok(port.events.some((item) => item.idempotencyKey === "crawl-started"));
  assert.ok(port.events.some((item) => item.idempotencyKey === "ads-complete"));
  assert.ok(port.events.some((item) => item.idempotencyKey === "matching-complete"));
  assert.ok(port.events.some((item) => item.idempotencyKey === "facts-complete"));
  assert.equal(port.factChunks.length, 4);
  assert.deepEqual(port.factManifests[0].counts, { companies: 2, products: 40, matches: 20, ads: 0 });
  assert.equal(port.events.some((item) => item.idempotencyKey.startsWith("brief-")), false);
  assert.equal(port.saves[0].document.marketBrief, null);
  const compaction = port.saves[0].document.document.blocks.find((block) => block.type === "presentation-compaction");
  assert.equal(compaction.relationalFactsAuthoritative, true);
  assert.deepEqual(compaction.factCounts, { companies: 2, products: 40, matches: 20, ads: 0 });
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
  assert.equal(order[1], "event:crawl-started");
});

test("independent phase failures remain visible and produce a limited report", async () => {
  const port = mockPort({ async ads() { throw new Error("provider unavailable"); } });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.limitedPhases, ["ads"]);
  assert.equal(port.saves[0].status, "limited");
  assert.match(port.events.find((item) => item.idempotencyKey === "ads-limited").metadata.reason, /provider unavailable/);
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
  assert.match(port.events.find((item) => item.idempotencyKey === "facts-limited").metadata.reason, /database temporarily unavailable/);
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
  });

  const result = await orchestrateReport(payload, { attemptNumber: 1, taskAttemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "complete");
  assert.equal(port.factChunks.length, 0);
  assert.equal(port.factManifests.length, 0);
  assert.deepEqual(port.events.find((item) => item.idempotencyKey === "facts-complete").metadata, manifest.counts);
});

test("fact telemetry callback failures never prevent the terminal document", async () => {
  const port = mockPort({
    async persistFactChunk() { throw new Error("fact database unavailable"); },
    async appendEvent(_publicId, value) {
      if (value.idempotencyKey === "facts-limited") throw new Error("telemetry unavailable");
      port.events.push(value);
    },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(port.saves.length, 1);
  const completePort = mockPort({
    async appendEvent(_publicId, value) {
      if (value.idempotencyKey === "facts-complete") throw new Error("telemetry unavailable");
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
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "limited", createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:05:00.000Z" },
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
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "limited", createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:05:00.000Z" },
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
  assert.equal(WORST_CASE_CRITICAL_PATH_MS, 2_995_000);
  assert.ok(WORST_CASE_CRITICAL_PATH_MS <= 3_000_000, "critical path must preserve a two-minute task-ceiling margin");
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
  assert.ok(port.events.some((item) => item.idempotencyKey === "matching-retry-started"));
});

test("partial and failed selected enrichment remain visibly limited", async () => {
  let successfulCalls = 0;
  const success = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich({ targets }) {
      successfulCalls += 1;
      return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 24, gaps: [] } };
    },
  });
  const successResult = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, success);
  assert.equal(successfulCalls, 1);
  assert.equal(successResult.reportStatus, "limited");
  assert.ok(successResult.limitedPhases.includes("enrichment"));

  const failure = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich() { throw new Error("selected page timeout"); },
  });
  const failureResult = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, failure);
  assert.equal(failureResult.reportStatus, "limited");
  assert.ok(failureResult.limitedPhases.includes("enrichment"));
  assert.ok(failure.events.some((item) => item.idempotencyKey === "enrichment-limited"));
});

test("accepted rivals are enriched in 64-page batches and successful batches survive a later failure", async () => {
  const batched = comparison({ withPair: true });
  const template = batched.rows[0];
  batched.rows = Array.from({ length: 70 }, (_, index) => {
    const primary = { ...template.primary, id: `p-${index}`, name: `Honey ${index} 500g`, normalizedName: `honey ${index} 500g`, sourceUrl: `https://shop.example/products/honey-${index}`, imageUrl: "https://shop.example/images/honey.jpg", priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] };
    const rival = { ...template.matches[0].product, id: `r-${index}`, name: `Honey ${index} 500g`, normalizedName: `honey ${index} 500g`, sourceUrl: `https://rival.example/products/honey-${index}`, imageUrl: "", priceSignals: [] };
    return { primary, matches: [{ ...template.matches[0], product: rival, assessment: { ...template.matches[0].assessment, primarySourceUrl: primary.sourceUrl, rivalSourceUrl: rival.sourceUrl } }] };
  });
  batched.coverage = { ...batched.coverage, primaryProductsAvailable: 70, primaryProductsScanned: 70, primaryProductFamiliesCompared: 70, competitorProductsAvailable: 70, competitorProductsScanned: 70, assignedPairCount: 70, verifiedPairCount: 70, rowsReturned: 70, rowLimit: 70 };
  batched.matching = { ...batched.matching, primaryProductsAssessed: 70, candidatePairsAssessed: 70, retrievalPairsScored: 70, selectedPrimaryIds: batched.rows.map((row) => row.primary.id), assessedPrimaryIds: batched.rows.map((row) => row.primary.id) };
  const batchSizes = [];
  const port = mockPort({
    async match() { return { ok: true, comparison: batched }; },
    async enrich({ targets }) {
      batchSizes.push(targets.length);
      if (batchSizes.length === 2) throw new Error("second batch unavailable");
      return { ok: true, products: targets.map((target) => ({ ...product(target.domain, target.productId), name: target.expectedName, normalizedName: target.expectedName.toLowerCase(), sourceUrl: target.sourceUrl, priceSignals: [{ raw: "GBP 7", currency: "GBP", amount: 7 }] })), coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: 64, gaps: [] } };
    },
  });
  const result = await orchestrateReport({ ...payload, contractVersion: "3", productPlan: "growth", productLimit: 500 }, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.deepEqual(batchSizes, [64, 6]);
  assert.equal(result.reportStatus, "limited");
  const block = port.saves[0].document.document.blocks.find((item) => item.type === "product-comparison");
  assert.equal(block.rows.flatMap((row) => row.matches).filter((match) => match.product).length, 64);
  assert.equal(block.enrichment.pagesRequested, 70);
  assert.equal(block.enrichment.pagesFetched, 64);
  assert.equal(block.enrichment.failedBatchCount, 1);
  const checkpoints = port.events.filter((event) => /^enrichment-wave-\d+-checkpoint$/.test(event.idempotencyKey));
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].metadata.pagesRequested, 70);
});

test("action planning runs after final enrichment and persists source-labelled plans", async () => {
  let sawEnrichedPrice = false;
  const port = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich({ targets }) {
      return {
        ok: true,
        products: [
          { ...product(), priceSignals: [{ raw: "GBP 9", currency: "GBP", amount: 9 }] },
          { ...product("rival.example", "r1"), priceSignals: [{ raw: "GBP 7", currency: "GBP", amount: 7 }] },
        ],
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
  assert.ok(eventKeys.indexOf("enrichment-complete") < eventKeys.indexOf("actions-started"));
  assert.ok(eventKeys.indexOf("actions-complete") < eventKeys.indexOf("matching-complete"));
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
