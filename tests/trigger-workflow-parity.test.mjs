import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowStore, initialState, encodeState, decodeState, hash } from "../src/trigger-direct/workflow-state.ts";
import { createWorkflowPort } from "../src/trigger-direct/workflow-port.ts";
import { workflowOutput } from "../src/trigger-direct/workflow-output.ts";
import { orchestrateValidatedReport, orchestrateReport } from "../src/trigger/report-orchestration-core.ts";
import { buildDirectProductSearchComparison } from "../app/lib/direct-product-search.ts";
import { deterministicProductActionResult } from "../app/lib/ai-action-planner.ts";
import { buildReportFactBundle } from "../src/shared/report-facts.ts";

// Synthetic fixtures only; no public website/provider requests in this suite.
const request = { contractVersion: "1", domain: "shop.example", comparisons: 1, rivals: 1, requestId: "parity-fixture" };
function product(domain, id, amount = 10, currency = "GBP") {
  return { id, domain, name: "Honey 500g", normalizedName: "honey 500g", description: "Raw honey", category: "honey", jsonLdType: "Product",
    priceSignals: [{ raw: `${currency} ${amount}`, currency, amount }], attributes: [], ownership: "self-declared-brand", extraction: "json-ld", confidence: "High",
    sourceUrl: `https://${domain}/products/${id}?country=GB`, imageUrl: "", observedAt: new Date().toISOString(), claimIds: [id] };
}
function memoryStore() {
  let packet = encodeState(initialState("run_fixture", request));
  const save = async (value) => { packet = structuredClone(value); };
  return { get store() { return new WorkflowStore(decodeState(packet, "run_fixture", request), save); }, packet: () => packet };
}
test("durable state restores, binds request/run, and rejects corruption", async () => {
  const memory = memoryStore(), store = memory.store;
  await store.appendEvent(store.read().report.run.publicId, { idempotencyKey: "event-1", phase: "crawl", status: "running", message: "fixture" });
  assert.equal(memory.store.read().report.events.length, 1);
  assert.throws(() => decodeState(memory.packet(), "run_other", request), /INVALID_STATE/);
  assert.throws(() => decodeState(memory.packet(), "run_fixture", { ...request, comparisons: 20 }), /INTEGRITY/);
  assert.throws(() => decodeState({ ...memory.packet(), hash: "0".repeat(64) }, "run_fixture", request), /INTEGRITY/);
});
test("concurrent writes serialize and checkpoints enforce compare-and-swap", async () => {
  const memory = memoryStore(), store = memory.store, id = store.read().report.run.publicId;
  await Promise.all([1, 2, 3].map((batchIndex) => store.saveCheckpoint(id, { attemptNumber: 1, batchIndex, inputHash: hash(batchIndex), result: { batchIndex } })));
  assert.equal(memory.store.read().checkpoints.length, 3);
  const before = store.read().checkpoints[0];
  await assert.rejects(store.saveCheckpoint(id, { ...before, resultHash: undefined, expectedResultHash: "0".repeat(64), result: { changed: true } }), /REVISION/);
  await store.saveCheckpoint(id, { ...before, resultHash: undefined, expectedResultHash: before.resultHash, result: { changed: true } });
  assert.equal(memory.store.read().checkpoints[0].result.changed, true);
});
test("ambiguous durable writes stop the attempt before more paid research", async () => {
  const store = new WorkflowStore(initialState("run_fixture", request), async () => { throw Error("simulated lost commit receipt"); });
  let calls = 0;
  await assert.rejects(store.operation("paid", async () => { calls++; }), /DURABLE_STATE/);
  await assert.rejects(store.operation("paid-again", async () => { calls++; }), /DURABLE_STATE/);
  assert.equal(calls, 0);
});
test("completed provider operations replay; interrupted ones never silently rebill", async () => {
  const memory = memoryStore(); let calls = 0;
  const result = await memory.store.operation("search-a", async () => { calls++; return { candidates: [] }; });
  assert.deepEqual(await memory.store.operation("search-a", async () => { calls++; }), result);
  await assert.rejects(memory.store.operation("search-b", async () => { calls++; throw Error("lost provider response"); }), /lost provider/);
  await assert.rejects(memory.store.operation("search-b", async () => { calls++; }), /AMBIGUOUS_PROVIDER/);
  assert.equal(calls, 2);
});
test("unsupported-price candidates never consume an admitted rival slot", async () => {
  const primary = product(request.domain, "p"), bad = product("bad.example", "bad", 10, "ZZZ"), good = product("good.example", "good");
  const comparison = await buildDirectProductSearchComparison(request.domain, [{ domain: request.domain, products: [primary] }], {
    resultTarget: 1, maxRivalDomains: 1, marketCountryCode: "GB",
    search: async () => ({ completed: true, queries: ["fixture"], candidates: [bad, good].map((p) => ({ domain: p.domain, sourceUrl: p.sourceUrl, title: p.name })) }),
    enrich: async () => ({ products: [bad, good], coverage: { pagesRequested: 2, pagesFetched: 2, maxPages: 2, gaps: [] } }),
  });
  assert.equal(comparison.rows[0].matches[0].domain, "good.example");
});
test("real orchestration and native match handler produce full facts and replay without research", async () => {
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "synthetic-fixture-not-a-key";
  try {
    const memory = memoryStore(); const store = memory.store;
    const primary = product(request.domain, "p"), rival = product("rival.example", "r");
    let searches = 0, crawls = 0, actions = 0;
    const research = {
      crawl: async (input) => { crawls++; return { ok: true, primaryDomain: input.primary, results: [{ domain: input.primary, products: input.primary === request.domain ? [primary] : [rival], homepage: { regionCountryCode: "GB" }, fetchedAt: primary.observedAt }], document: { version: "1", blocks: [] } }; },
      search: async () => { searches++; return { completed: true, queries: ["fixture honey"], candidates: [{ domain: rival.domain, sourceUrl: rival.sourceUrl, title: rival.name }] }; },
      enrich: async (targets) => ({ products: targets.map((target) => ({ ...(target.domain === request.domain ? primary : rival), id: target.productId })), coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] } }),
      actions: async (inputs) => { actions++; return deterministicProductActionResult(inputs); },
    };
    const run = store.read().report.run;
    const payload = { contractVersion: "6", publicId: run.publicId, primaryDomain: request.domain, locale: "en", reportAttempt: 1, productPlan: "starter", productLimit: 1 };
    const attempt = { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true };
    // Website plan validation remains unchanged.
    await assert.rejects(orchestrateReport(payload, attempt, createWorkflowPort(store, research)), /plan/);
    await orchestrateValidatedReport(payload, attempt, createWorkflowPort(store, research));
    const output = workflowOutput(store);
    assert.equal(output.comparisons.length, 1, JSON.stringify(output.progress));
    assert.equal(output.competitors.length, 1);
    assert.equal(output.comparisons[0].rivalProduct.priceSignals[0].amount, 10);
    assert.ok(output.facts.manifest.manifestHash);
    assert.ok(output.progress.some((event) => event.phase === "quality"));
    assert.ok(actions > 0);
    const counts = { searches, crawls, actions };
    await orchestrateValidatedReport(payload, attempt, createWorkflowPort(memory.store, research));
    assert.deepEqual({ searches, crawls, actions }, counts);
    assert.equal(output.costMicrousd, null);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
test("facts cannot finalize until all hashed chunks are present", async () => {
  const store = memoryStore().store, id = store.read().report.run.publicId;
  const bundle = await buildReportFactBundle({ publicId: id, crawlResults: [], comparison: null, adBlock: null, observedAt: new Date().toISOString(), attemptNumber: 1 });
  await assert.rejects(store.finalizeFactManifest(id, bundle.manifest), /MANIFEST/);
  for (const chunk of bundle.chunks) await store.persistFactChunk(id, chunk);
  await store.finalizeFactManifest(id, bundle.manifest);
  await assert.rejects(store.saveDocument(id, { status: "complete", observedAt: new Date().toISOString(), expectedFactManifestHash: "0".repeat(64), document: {} }), /DOCUMENT_MANIFEST/);
});

test("a lost match-checkpoint commit reuses the already durable paid search result", async () => {
  const initial = initialState("run_fixture", request);
  let saved = encodeState(initial), failOnce = true, searches = 0;
  const persist = async (packet) => {
    const next = decodeState(packet, "run_fixture", request);
    if (failOnce && next.checkpoints.length) { failOnce = false; throw Error("simulated checkpoint transport failure"); }
    saved = packet;
  };
  const primary = product(request.domain, "p"), rival = product("rival.example", "r");
  const research = {
    search: async () => { searches++; return { completed: true, queries: ["fixture"], candidates: [{ domain: rival.domain, sourceUrl: rival.sourceUrl, title: rival.name }] }; },
    enrich: async (targets) => ({ products: targets.map((target) => ({ ...rival, id: target.productId })), coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] } }),
  };
  const input = { publicId: initial.report.run.publicId, reportAttempt: 1, taskAttemptNumber: 1, reportObservedAt: initial.report.run.createdAt, primaryDomain: request.domain, marketCountryCode: "GB", productLimit: 1, catalogs: [{ domain: request.domain, products: [primary] }], matchingMode: "direct-product-search" };
  await assert.rejects(createWorkflowPort(new WorkflowStore(initial, persist), research).match(input), /RESEARCH_STAGE_FAILED/);
  const result = await createWorkflowPort(new WorkflowStore(decodeState(saved, "run_fixture", request), persist), research).match({ ...input, taskAttemptNumber: 2 });
  assert.equal(result.comparison.coverage.assignedPairCount, 1);
  assert.equal(searches, 1);
});
