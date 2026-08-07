import assert from "node:assert/strict";
import test from "node:test";

import { createInternalReportHandlers } from "../app/api/internal/reports/[publicId]/route.ts";

const token = "checkpoint-test-token";
const publicId = "b".repeat(32);

function report(status = "running", attemptCount = 2) {
  return {
    run: { id: "run-api", publicId, primaryDomain: "example.com", locale: "en", status, currentPhase: "matching", attemptCount, createdAt: "", updatedAt: "", heartbeatAt: "", expiresAt: "", errorCode: "", errorMessage: "" },
    events: [], document: null, documentSchemaVersion: 0, documentObservedAt: "",
  };
}

function request(body, authorization = `Bearer ${token}`) {
  return new Request(`https://example.test/api/internal/reports/${publicId}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
}

function storeFor(storedReport) {
  const calls = [];
  return {
    calls,
    async get() { return storedReport; },
    async append() { throw new Error("unexpected append"); },
    async save() { throw new Error("unexpected document save"); },
    async saveFactChunk() { throw new Error("unexpected fact chunk save"); },
    async finalizeFacts() { throw new Error("unexpected fact finalization"); },
    async loadMatchBatchCheckpoints(id, input) { calls.push(["load", id, input]); return [{ batchIndex: input.batchIndex ?? 0 }]; },
    async saveMatchBatchCheckpoint(id, input) { calls.push(["save", id, input]); return { checkpoint: { batchIndex: input.batchIndex, result: input.result }, replayed: false }; },
  };
}

test("internal report API authenticates and routes match batch checkpoint load/save actions", async () => {
  const store = storeFor(report());
  const handlers = createInternalReportHandlers(store, token);
  const context = { params: { publicId } };

  const unauthorized = await handlers.post(request({ action: "match-batch-checkpoints-load", attemptNumber: 2 }, "Bearer wrong"), context);
  assert.equal(unauthorized.status, 401);

  const saved = await handlers.post(request({ action: "match-batch-checkpoint-save", attemptNumber: 2, batchIndex: 3, inputHash: "a".repeat(64), result: { matches: [] } }), context);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).checkpoint.batchIndex, 3);

  const loaded = await handlers.post(request({ action: "match-batch-checkpoints-load", attemptNumber: 2, batchIndex: 3 }), context);
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json()).checkpoints, [{ batchIndex: 3 }]);
  assert.deepEqual(store.calls.map((call) => call[0]), ["save", "load"]);
});

test("internal report API rejects stale and terminal checkpoint callbacks", async () => {
  const context = { params: { publicId } };
  const activeStore = storeFor(report());
  const activeHandlers = createInternalReportHandlers(activeStore, token);
  const stale = await activeHandlers.post(request({ action: "match-batch-checkpoints-load", attemptNumber: 1 }), context);
  assert.equal(stale.status, 409);
  assert.equal(activeStore.calls.length, 0);

  const terminalStore = storeFor(report("complete"));
  const terminalHandlers = createInternalReportHandlers(terminalStore, token);
  const terminal = await terminalHandlers.post(request({ action: "match-batch-checkpoint-save", attemptNumber: 2, batchIndex: 0, inputHash: "a".repeat(64), result: {} }), context);
  assert.equal(terminal.status, 409);
  assert.equal(terminalStore.calls.length, 0);
});
