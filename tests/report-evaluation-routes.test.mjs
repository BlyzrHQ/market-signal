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

test("recovery always reconciles while pilot-off prevents every dispatch", async () => {
  const calls = [];
  const post = createReportEvaluationRecoveryHandler({
    async reconcile() { calls.push("reconcile"); return { candidates: [evaluationId] }; },
    async enabled() { calls.push("enabled"); return false; },
    async begin() { calls.push("begin"); throw new Error("must not dispatch"); },
    async dispatch() { calls.push("dispatch"); throw new Error("must not dispatch"); },
    async markFailed() { calls.push("markFailed"); throw new Error("must not dispatch"); },
  }, token);
  const response = await post(new Request("https://example.test/api/internal/evaluations/recovery", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["reconcile", "enabled"]);
  assert.deepEqual(await response.json(), { ok: true, enabled: false, candidates: 1, dispatched: 0, failed: 0 });
});
