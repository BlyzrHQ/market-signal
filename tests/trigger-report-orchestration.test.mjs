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
import { deterministicProductActionResult } from "../app/lib/ai-action-planner.ts";

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
    rows: withPair ? [{ primary, matches: [{
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
    }] }] : [],
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
    async actions({ inputs }) { return { ok: true, result: deterministicProductActionResult(inputs) }; },
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
  assert.deepEqual(result.limitedPhases, ["crawl", "brief", "ads", "matching"]);
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
  assert.deepEqual(result.limitedPhases, ["crawl", "brief", "ads", "matching"]);
  assert.deepEqual(calls, { brief: 0, ads: 0, match: 0, enrich: 0 });
  assert.equal(port.saves.length, 1);
  assert.equal(port.saves[0].status, "limited");
  assert.match(port.events.find((item) => item.idempotencyKey === "crawl-limited").message, /did not return a public network response/i);
});

test("a parked-domain retry replays partial event writes without an idempotency conflict", async () => {
  const storedEvents = new Map();
  let saveAttempts = 0;
  const port = mockPort({
    async loadReport() {
      return {
        run: { publicId: payload.publicId, primaryDomain: payload.primaryDomain, locale: payload.locale, status: "running", createdAt: "2026-07-20T09:00:00.000Z", updatedAt: "2026-07-20T09:00:00.000Z" },
        events: [...storedEvents.values()],
      };
    },
    async appendEvent(_publicId, value) {
      const existing = storedEvents.get(value.idempotencyKey);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`idempotency conflict: ${value.idempotencyKey}`);
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
  const result = await orchestrateReport(payload, { attemptNumber: 2, isFinalAttempt: true }, port);
  assert.equal(result.reportStatus, "limited");
  assert.equal(saveAttempts, 2);
  assert.equal(storedEvents.get("crawl-limited").metadata.attempt, undefined);
  assert.equal([...storedEvents.keys()].filter((key) => key.endsWith("-limited")).length, 4);
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
  const result = await orchestrateReport(payload, { attemptNumber: 2, isFinalAttempt: true }, port);
  assert.deepEqual(result.completedPhases, ["persistence"]);
  assert.deepEqual(result.limitedPhases, ["crawl", "brief", "ads", "matching"]);
  assert.equal(port.events.length, 0);
  assert.equal(port.saves.length, 0);
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
        coverage: { pagesRequested: targets.length, pagesFetched: 2, maxPages: 64, gaps: [] },
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
  assert.equal(block.actionPlanning.fallbackActions, 1);
  assert.equal(block.rows[0].matches[0].decision.actionPlan.source, "deterministic");
});

test("AI action transport failure retains deterministic moves without limiting the report", async () => {
  const port = mockPort({
    async match() { return { ok: true, comparison: comparison({ withPair: true }) }; },
    async enrich({ targets }) { return { ok: true, products: [], coverage: { pagesRequested: targets.length, pagesFetched: 0, maxPages: 64, gaps: [] } }; },
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
