import assert from "node:assert/strict";
import test from "node:test";

import { createReportEvaluationCallbackHandler } from "../app/api/internal/evaluations/[evaluationId]/route.ts";
import { createReportEvaluationRecoveryHandler } from "../app/api/internal/evaluations/recovery/route.ts";
import { ReportEvaluationStateError } from "../app/lib/report-store.ts";
import { REPORT_EVALUATION_MODEL, REPORT_EVALUATION_PRICING_VERSION, REPORT_EVALUATION_PROMPT_VERSION, REPORT_EVALUATOR_VERSION } from "../src/shared/report-evaluation-contract.ts";

const token = "evaluation-route-test-token-that-is-long-enough";
const evaluationId = "evaluation-route-1";
const context = { params: { evaluationId } };

function request(body, authorization = `Bearer ${token}`) {
  return new Request(`https://example.test/api/internal/evaluations/${evaluationId}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function terminal() {
  return {
    action: "terminal", evaluatorVersion: REPORT_EVALUATOR_VERSION, dispatchAttempt: 1,
    reservationOwner: "worker:route-1", reservationId: "reservation-1", clientRequestId: "client-1",
    status: "agent_rejected", errorCode: "provider-output-rejected", providerResponseId: null, providerRequestId: "request-1",
    usageStatus: "unknown", usage: null, agentOutput: null, model: REPORT_EVALUATION_MODEL,
    promptVersion: REPORT_EVALUATION_PROMPT_VERSION, pricingVersion: REPORT_EVALUATION_PRICING_VERSION,
  };
}

test("evaluation callback route authenticates, rejects malformed contracts, and maps typed state conflicts to 409", async () => {
  const services = {
    async reserve() { throw new Error("unexpected reserve"); },
    async complete() { throw new ReportEvaluationStateError("evaluation-callback-state-conflict", "conflict", 409); },
  };
  const post = createReportEvaluationCallbackHandler(services, token);
  assert.equal((await post(request(terminal(), "Bearer wrong"), context)).status, 401);
  assert.equal((await post(request("{"), context)).status, 400);
  const conflict = await post(request(terminal()), context);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "evaluation-callback-state-conflict");
});

function recoveryRequest(body, authorization = `Bearer ${token}`) {
  return new Request("https://example.test/api/internal/evaluations/recovery", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("recovery authenticates before parsing and rejects unbounded or malformed scopes", async () => {
  const calls = [];
  const post = createReportEvaluationRecoveryHandler({
    async watchdog() { calls.push("watchdog"); throw new Error("must not reconcile"); },
    async reconcile() { calls.push("reconcile"); throw new Error("must not reconcile"); },
    async begin() { throw new Error("must not dispatch"); },
    async dispatch() { throw new Error("must not dispatch"); },
    async markFailed() { throw new Error("must not dispatch"); },
  }, token);
  assert.equal((await post(recoveryRequest("{", "Bearer wrong"))).status, 401);
  assert.equal((await post(recoveryRequest("{"))).status, 400);
  assert.equal((await post(recoveryRequest({ publicReportIds: [] }))).status, 400);
  assert.equal((await post(recoveryRequest({ publicReportIds: ["a".repeat(32), "a".repeat(32)] }))).status, 400);
  assert.equal((await post(recoveryRequest({ publicReportIds: ["a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(32)] }))).status, 400);
  assert.equal((await post(recoveryRequest({ publicReportIds: ["not-a-report"] }))).status, 400);
  const streamed = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(400)));
      controller.enqueue(new TextEncoder().encode("y".repeat(400)));
      controller.close();
    },
  });
  const oversized = new Request("https://example.test/api/internal/evaluations/recovery", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: streamed, duplex: "half" });
  assert.equal((await post(oversized)).status, 400);
  assert.deepEqual(calls, []);
});

test("scheduled recovery keeps watchdog reconciliation active without dispatching backlog", async () => {
  const calls = [];
  const post = createReportEvaluationRecoveryHandler({
    async watchdog() { calls.push("watchdog"); return { reconciled: true }; },
    async reconcile() { throw new Error("must not query dispatch candidates"); },
    async begin() { throw new Error("must not dispatch"); },
    async dispatch() { throw new Error("must not dispatch"); },
    async markFailed() { throw new Error("must not dispatch"); },
  }, token);
  const response = await post(new Request("https://example.test/api/internal/evaluations/recovery", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["watchdog"]);
  assert.deepEqual(await response.json(), { ok: true, mode: "watchdog", dispatched: 0, failed: 0 });
});

test("recovery dispatches only the exact requested report candidates", async () => {
  const calls = [];
  const reportId = "a".repeat(32);
  const post = createReportEvaluationRecoveryHandler({
    async watchdog() { throw new Error("must not run watchdog-only mode"); },
    async reconcile(ids) { calls.push(["reconcile", ids]); return { candidates: [evaluationId] }; },
    async begin(id) { calls.push(["begin", id]); return { evaluationId: id, evaluatorVersion: "agent-v1", dispatchAttempt: 1 }; },
    async dispatch(payload) { calls.push(["dispatch", payload.evaluationId]); return { runId: "run_test" }; },
    async markFailed() { calls.push("markFailed"); throw new Error("must not dispatch"); },
  }, token);
  const response = await post(recoveryRequest({ publicReportIds: [reportId] }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["reconcile", [reportId]], ["begin", evaluationId], ["dispatch", evaluationId]]);
  assert.deepEqual(await response.json(), { ok: true, requested: 1, candidates: 1, dispatched: 1, failed: 0 });
});
