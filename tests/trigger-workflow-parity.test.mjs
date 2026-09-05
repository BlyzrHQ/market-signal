import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowStore, initialState, encodeState, decodeState, hash, commitStatePointer, inlineStatePointer } from "../src/trigger-direct/workflow-state.ts";
import { createWorkflowPort, durableActionFetch } from "../src/trigger-direct/workflow-port.ts";
import { workflowOutput } from "../src/trigger-direct/workflow-output.ts";
import { orchestrateValidatedReport, orchestrateReport } from "../src/trigger/report-orchestration-core.ts";
import { buildDirectProductSearchComparison } from "../app/lib/direct-product-search.ts";
import { deterministicProductActionResult, buildAIProductActions } from "../app/lib/ai-action-planner.ts";
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

test("small durable states fit inline while larger states or other metadata keep the snapshot path", () => {
  const packet = encodeState(initialState("run_fixture",request));
  const pointer = inlineStatePointer(packet,{});
  assert.equal(pointer.runId,"run_fixture");
  assert.deepEqual(decodeState(pointer.inline,"run_fixture",request),decodeState(packet,"run_fixture",request));
  assert.equal(inlineStatePointer({...packet,gzip:"x".repeat(224*1024)},{}),null);
  assert.equal(inlineStatePointer(packet,{unrelated:"x".repeat(224*1024)}),null);
  assert.ok(inlineStatePointer(packet,{marketSignalWorkflowStateV1:{inline:{gzip:"x".repeat(256*1024)}}}));
});

test("inline read-back must confirm the full packet before any paid operation", async () => {
  let committed, calls=0;
  const persist = packet => commitStatePointer(inlineStatePointer(packet,{}),{
    set:pointer=>{committed=structuredClone(pointer);},flush:async()=>{},read:async()=>committed,
  });
  const store = new WorkflowStore(initialState("run_fixture",request),persist);
  await store.operation("search:inline",async()=>{calls++;assert.equal(Object.values(decodeState(committed.inline,"run_fixture",request).operations)[0].status,"started");return {fixture:true};});
  const restored=new WorkflowStore(decodeState(committed.inline,"run_fixture",request),persist);
  assert.deepEqual(await restored.operation("search:inline",async()=>{calls++;}),{fixture:true});
  assert.equal(calls,1);
  const pointer=inlineStatePointer(encodeState(initialState("run_fixture",request)),{});
  await assert.rejects(commitStatePointer(pointer,{set:()=>{},flush:async()=>{},read:async()=>({...pointer,inline:{...pointer.inline,gzip:"corrupted"}})}),/NOT_CONFIRMED/);
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

test("parallel operation starts share a confirmed snapshot before any paid call", async () => {
  let saves = 0, calls = 0, lastPacket;
  const store = new WorkflowStore(initialState("run_fixture", request), async packet => { saves++; lastPacket = packet; });
  await Promise.all(Array.from({length:8},(_,i)=>store.operation(`search-${i}`,async()=>{
    assert.equal(saves,1);
    const saved = decodeState(lastPacket,"run_fixture",request);
    assert.equal(Object.values(saved.operations).filter(o=>o.status==="started").length,8);
    calls++; return {id:i};
  })));
  assert.equal(calls,8);
  assert.equal(saves,2);
  assert.equal(Object.values(store.read().operations).filter(o=>o.status==="complete").length,8);
});

test("a failed batch commit rejects all callers without starting paid work", async () => {
  let calls = 0;
  const store = new WorkflowStore(initialState("run_fixture",request),async()=>{throw Error("receipt lost");});
  const results = await Promise.allSettled(Array.from({length:8},(_,i)=>store.operation(`search-${i}`,async()=>{calls++;})));
  assert.equal(calls,0);
  assert.ok(results.every(r=>r.status==="rejected"));
  assert.throws(()=>store.read(),/DURABLE_STATE/);
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
    assert.ok(output.comparisons[0].recommendation.actionEn.trim(), "Final action must reach authoritative facts and comparison output");
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

test("swallowed metadata flush failure cannot acknowledge a checkpoint or start paid work", async () => {
  const pointer = { runId: "run_snapshot", ownerRunId: "run_fixture", revision: 1, hash: "a".repeat(64) };
  let calls = 0;
  const store = new WorkflowStore(initialState("run_fixture", request), async () => commitStatePointer(pointer, {
    set: () => {}, flush: async () => {}, read: async () => undefined,
  }));
  await assert.rejects(store.operation("paid", async () => { calls++; }), /DURABLE_STATE/);
  assert.equal(calls, 0);
  await assert.rejects(commitStatePointer(pointer, { set: () => {}, flush: async () => {}, read: async () => ({ ...pointer, revision: 0 }) }), /NOT_CONFIRMED/);
  await commitStatePointer(pointer, { set: () => {}, flush: async () => {}, read: async () => pointer });
});

test("an incomplete provider response drains its bounded wave and stops before the next wave", async () => {
  const store = memoryStore().store, run = store.read().report.run;
  let calls = 0;
  const port = createWorkflowPort(store, { search: async () => { calls++; return { completed: false, queries: [], candidates: [], gap: "Synthetic response loss" }; } });
  await assert.rejects(port.match({ publicId: run.publicId, reportAttempt: 1, taskAttemptNumber: 1, reportObservedAt: run.createdAt, primaryDomain: request.domain, marketCountryCode: "GB", productLimit: 1,
    catalogs: [{ domain: request.domain, products: Array.from({length:16},(_,i)=>product(request.domain,String(i))) }], matchingMode: "direct-product-search" }), /RESEARCH_STAGE/);
  assert.equal(calls, 8);
  await assert.rejects(store.operation("another-paid-operation", async () => { calls++; }), /DURABLE_STATE/);
  assert.equal(calls, 8);
});

async function executeFixture(research, input = { ...request, comparisons: 2 }) {
  const store = new WorkflowStore(initialState("run_fixture", input), async () => {});
  const port = createWorkflowPort(store, research); port.preflight = async () => {};
  await orchestrateValidatedReport({ contractVersion: "6", publicId: store.read().report.run.publicId, primaryDomain: input.domain, locale: "en", reportAttempt: 1, productPlan: "starter", productLimit: input.comparisons },
    { attemptNumber: 1, taskAttemptNumber: 1, isFinalAttempt: true }, port);
  return workflowOutput(store);
}

test("quality repairs and merged facts retain a report-wide seller limit", async () => {
  const primary = product(request.domain, "p"); let repairs = 0;
  const result = await executeFixture({
    crawl: async (input) => ({ ok: true, primaryDomain: input.primary, results: [{ domain: input.primary, products: [input.primary === request.domain ? primary : product(input.primary, "r")], homepage: { regionCountryCode: "GB" }, fetchedAt: primary.observedAt }], discovery: { productSearchCoverage: { complete: true } }, document: { version: "1", blocks: [] } }),
    search: async (_domain, _primary, _region, feedback) => { if (feedback) repairs++; const rival = product(feedback ? "second.example" : "first.example", feedback ? "r2" : "r1"); return { completed: true, queries: ["fixture"], candidates: [{ domain: rival.domain, sourceUrl: rival.sourceUrl, title: rival.name }] }; },
    enrich: async (targets) => ({ products: targets.map((target) => ({ ...product(target.domain, target.productId), sourceUrl: target.sourceUrl })), coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] } }),
    actions: async (inputs) => deterministicProductActionResult(inputs),
  });
  assert.ok(repairs > 0);
  assert.equal(result.competitors.length, 1);
  assert.equal(result.comparisons.length, 1);
  assert.equal(result.status, "limited");
  assert.equal(new Set(result.facts.matches.map((match) => match.rivalDomain)).size, 1);
});

for (const status of ["parked", "unavailable"]) test(`${status} primary keeps its factless terminal limitation`, async () => {
  const output = await executeFixture({ crawl: async () => ({ ok: false, code: `${status}-domain`, primaryDomain: request.domain, error: "Synthetic source limitation", document: { version: "1", blocks: [{ type: "domain-status", id: "primary-domain-status", domain: request.domain, status, evidenceUrl: `https://${request.domain}/`, attemptedUrl: `https://${request.domain}/` }] } }) });
  assert.equal(output.status, "limited"); assert.equal(output.comparisons.length, 0); assert.ok(output.report);
});

test("action planner's internal retry cannot repeat an uncertain provider request", async () => {
  const store = memoryStore().store; let calls = 0;
  const inputs = [{ pairKey: "fixture", fallbackActionEn: "Compare honey", fallbackActionAr: "قارن العسل", fallbackRationaleEn: "Observed honey", fallbackRationaleAr: "عسل موثق", fallbackLeverType: "positioning", hasComparablePrice: true,
    facts: [{ key: "primary.name", text: "Honey 500g", kind: "identity" }, { key: "primary.price", text: "GBP 10", kind: "price" }] }];
  await buildAIProductActions(inputs, { apiKey: "synthetic-fixture-not-a-key", concurrency: 1, fetch: durableActionFetch(store, async () => { calls++; throw Error("response lost after provider accepted request"); }) });
  assert.equal(calls, 1);
  assert.throws(() => store.assertHealthy(), /DURABLE_STATE/);
});

test("oversized action requests preserve deterministic fallback without poisoning state", async () => {
  const store = memoryStore().store; let calls = 0;
  const port = createWorkflowPort(store, { actions: async () => { calls++; } });
  await assert.rejects(port.actions({ inputs: Array.from({ length: 481 }, (_, i) => ({ pairKey: String(i) })) }), /Between 1 and 480/);
  store.assertHealthy();
  await store.saveCheckpoint(store.read().report.run.publicId, { attemptNumber: 1, batchIndex: 1, inputHash: hash("fallback"), result: { fallback: true } });
  assert.equal(calls, 0); assert.equal(store.read().checkpoints.length, 1);
});
