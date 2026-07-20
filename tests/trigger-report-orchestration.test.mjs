import assert from "node:assert/strict";
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
  WORST_CASE_CRITICAL_PATH_MS,
  createReportOrchestrationHttpPort,
  isRetryableHttpStatus,
} from "../src/trigger/report-orchestration-http.ts";

const payload = {
  contractVersion: "1",
  publicId: "a".repeat(32),
  primaryDomain: "shop.example",
  locale: "en",
};

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

function comparison({ withPair = false } = {}) {
  const primary = product();
  const rival = product("rival.example", "r1");
  return {
    primaryDomain: "shop.example",
    comparisonDomains: ["rival.example"],
    rows: withPair ? [{ primary, matches: [{ domain: rival.domain, product: rival, score: 0.9, confidence: "Medium", sharedTerms: ["honey"], claimIds: rival.claimIds, decision: { verdict: "same_product", priceComparable: false, reasons: ["Observed product identity aligns."], action: "Compare the attributable offer." } }] }] : [],
    unmatched: [],
    coverage: {
      primaryProductsAvailable: 1,
      primaryProductsScanned: 1,
      primaryProductFamiliesCompared: withPair ? 1 : 0,
      competitorProductsAvailable: withPair ? 1 : 0,
      competitorProductsScanned: withPair ? 1 : 0,
      assignedPairCount: withPair ? 1 : 0,
      verifiedPairCount: withPair ? 1 : 0,
      rowsReturned: withPair ? 1 : 0,
      rowLimit: 30,
      truncated: false,
    },
    matching: {
      method: "ai-hybrid",
      available: true,
      model: "gpt-5.4-mini",
      embeddingModel: "text-embedding-3-small",
      promptVersion: "test",
      primaryProductsAssessed: withPair ? 1 : 0,
      candidatePairsAssessed: withPair ? 1 : 0,
      retrievalPairsScored: withPair ? 1 : 0,
      judgeCalls: withPair ? 1 : 0,
      embeddingCalls: withPair ? 1 : 0,
      durationMs: 1,
      gaps: [],
      selectedPrimaryIds: withPair ? [primary.id] : [],
      assessedPrimaryIds: withPair ? [primary.id] : [],
      attempts: 1,
    },
  };
}

function mockPort(overrides = {}) {
  const events = [];
  const saves = [];
  const port = {
    events,
    saves,
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "queued", createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
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
    async match() { return { ok: true, comparison: comparison() }; },
    async enrich() { throw new Error("not expected"); },
    async saveDocument(_publicId, value) { saves.push(value); },
    ...overrides,
  };
  return port;
}

test("payload contract accepts only a canonical, exact, versioned payload", () => {
  assert.deepEqual(parseReportOrchestrationPayload(payload), payload);
  for (const invalid of [
    { ...payload, primaryDomain: "https://shop.example" },
    { ...payload, primaryDomain: "Shop.example" },
    { ...payload, publicId: "nope" },
    { ...payload, locale: "fr" },
    { ...payload, callbackUrl: "https://attacker.example" },
    { ...payload, contractVersion: "2" },
  ]) assert.throws(() => parseReportOrchestrationPayload(invalid), PermanentOrchestrationError);
});

test("successful orchestration persists ordered heartbeats and a complete document", async () => {
  const port = mockPort();
  const dates = ["2026-07-20T10:00:00.000Z", "2026-07-20T10:01:00.000Z"];
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port, () => new Date(dates.shift()));

  assert.equal(result.reportStatus, "complete");
  assert.deepEqual(result.limitedPhases, []);
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].status, "complete");
  assert.ok(port.events.some((item) => item.idempotencyKey === "crawl-started"));
  assert.ok(port.events.some((item) => item.idempotencyKey === "ads-complete"));
  assert.ok(port.events.some((item) => item.idempotencyKey === "matching-complete"));
});

test("independent phase failures remain visible and produce a limited report", async () => {
  const port = mockPort({ async ads() { throw new Error("provider unavailable"); } });
  const result = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.limitedPhases, ["ads"]);
  assert.equal(port.saves[0].status, "limited");
  assert.match(port.events.find((item) => item.idempotencyKey === "ads-limited").metadata.reason, /provider unavailable/);
});

test("crawl failure remains non-terminal before the final task attempt", async () => {
  const port = mockPort({ async crawl() { throw new Error("timeout"); } });
  await assert.rejects(orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, port), /timeout/);
  const failure = port.events.at(-1);
  assert.equal(failure.idempotencyKey, "crawl-attempt-1-failed");
  assert.equal(failure.status, "running");
  assert.equal(failure.phase, "crawl");
});

test("crawl failure becomes terminal only on the final task attempt", async () => {
  const port = mockPort({ async crawl() { throw new Error("still unavailable"); } });
  await assert.rejects(orchestrateReport(payload, { attemptNumber: 2, isFinalAttempt: true }, port), /still unavailable/);
  const failure = port.events.at(-1);
  assert.equal(failure.idempotencyKey, "crawl-failed");
  assert.equal(failure.status, "failed");
  assert.equal(failure.phase, "failed");
});

test("terminal success replay derives its summary and issues no mutations", async () => {
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "limited", createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:05:00.000Z" },
        events: [{ idempotencyKey: "crawl-complete", phase: "competitors", status: "running" }, { idempotencyKey: "ads-limited", phase: "ads", status: "running" }],
      };
    },
  });
  const result = await orchestrateReport(payload, { attemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "limited");
  assert.deepEqual(result.completedPhases, ["competitors"]);
  assert.deepEqual(result.limitedPhases, ["ads"]);
  assert.equal(port.events.length, 0);
  assert.equal(port.saves.length, 0);
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
  assert.equal(MAX_OPERATION_TIMEOUT_MS, 480_000);
  for (const timeout of Object.values(OPERATION_BUDGETS_MS)) assert.ok(timeout <= MAX_OPERATION_TIMEOUT_MS);
  assert.ok(WORST_CASE_CRITICAL_PATH_MS <= 780_000, "critical path must preserve a two-minute task-ceiling margin");
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

test("selected enrichment is applied and an enrichment failure remains visibly limited", async () => {
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
  assert.ok(successResult.completedPhases.includes("enrichment"));

  const failure = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich() { throw new Error("selected page timeout"); },
  });
  const failureResult = await orchestrateReport(payload, { attemptNumber: 1, isFinalAttempt: false }, failure);
  assert.equal(failureResult.reportStatus, "limited");
  assert.ok(failureResult.limitedPhases.includes("enrichment"));
  assert.ok(failure.events.some((item) => item.idempotencyKey === "enrichment-limited"));
});

test("a final non-crawl failure records one terminal orchestration event", async () => {
  const port = mockPort({ async saveDocument() { throw new Error("storage unavailable"); } });
  await assert.rejects(orchestrateReport(payload, { attemptNumber: 2, isFinalAttempt: true }, port), /storage unavailable/);
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
