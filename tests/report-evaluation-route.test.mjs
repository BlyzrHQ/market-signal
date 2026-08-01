import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluationHandler } from "../app/api/internal/evaluations/route.ts";
import { createWorkerApiManifest } from "../src/shared/worker-api-contract.ts";
import { createReportEvaluationDispatchHttpPort } from "../src/trigger/report-evaluation-http.ts";

const TOKEN = "evaluation_secret_with_sufficient_entropy_123";
const payload = {
  contractVersion: "1",
  evaluationId: "evaluation_1234567890abcdef",
  evaluatorVersion: "bounded-report-agent-judge-v1",
  inputHash: "a".repeat(64),
  factManifestHash: "b".repeat(64),
  dispatchGeneration: 1,
  dispatchToken: "c".repeat(64),
};
const workerLease = { ...payload, leaseToken: payload.dispatchToken, leaseGeneration: 2 };

function request(body, token = TOKEN, headers = {}) {
  return new Request("https://market.example/api/internal/evaluations", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function services(calls) {
  return {
    lease: async (...args) => { calls.push(["lease", ...args]); return { accepted: true }; },
    prepare: async (...args) => { calls.push(["prepare", ...args]); return { accepted: true }; },
    beginJudging: async (...args) => { calls.push(["begin", ...args]); return { accepted: true }; },
    complete: async (...args) => { calls.push(["complete", ...args]); return { accepted: true }; },
    reject: async (...args) => { calls.push(["reject", ...args]); return { accepted: true }; },
    claimDispatches: async (...args) => { calls.push(["claim", ...args]); return [payload]; },
    acknowledgeDispatch: async (...args) => { calls.push(["ack", ...args]); return { accepted: true }; },
    markAmbiguousDispatch: async (...args) => { calls.push(["ambiguous", ...args]); return { accepted: true }; },
    dryRunBacklog: async (...args) => { calls.push(["dry-run", ...args]); return { count: 1, nextBatch: 1 }; },
  };
}

test("the evaluation endpoint requires its separate bearer token and rejects oversized or open-ended input", async () => {
  const calls = [];
  const handler = createEvaluationHandler(TOKEN, services(calls));
  assert.equal((await handler(request({ action: "dry-run-backlog" }, "wrong"))).status, 401);
  assert.equal((await handler(request({ action: "unknown" }))).status, 400);
  assert.equal((await handler(request({ action: "dry-run-backlog", callerControl: true }))).status, 400);
  assert.equal((await handler(request({ action: "dry-run-backlog" }, TOKEN, { "Content-Length": String(128 * 1024 + 1) }))).status, 400);
  const reusedCredential = createEvaluationHandler(TOKEN, services(calls), TOKEN);
  assert.equal((await reusedCredential(request({ action: "dry-run-backlog" }))).status, 401);
  assert.equal(calls.length, 0);
});

test("the evaluation endpoint maps every closed lifecycle and dispatch action", async () => {
  const calls = [];
  const handler = createEvaluationHandler(TOKEN, services(calls));
  const cases = [
    { body: { action: "lease", ...payload }, call: "lease" },
    { body: { action: "prepare", ...workerLease }, call: "prepare" },
    { body: { action: "begin-judging", ...workerLease, packetHash: "d".repeat(64) }, call: "begin" },
    { body: { action: "complete", ...workerLease, packetHash: "d".repeat(64), model: "gpt-5.6-luna", judge: {}, hybrid: {}, usage: {} }, call: "complete" },
    { body: { action: "reject", ...workerLease, packetHash: "d".repeat(64), phase: "judging", errorCode: "agent-rejected" }, call: "reject" },
    { body: { action: "claim-dispatches", limit: 25 }, call: "claim" },
    { body: { action: "claim-dispatches", limit: 1, evaluationId: payload.evaluationId }, call: "claim" },
    { body: { action: "acknowledge-dispatch", ...payload, runId: "run_123" }, call: "ack" },
    { body: { action: "ambiguous-dispatch", ...payload }, call: "ambiguous" },
    { body: { action: "dry-run-backlog" }, call: "dry-run" },
  ];
  for (const item of cases) {
    const response = await handler(request(item.body));
    assert.equal(response.status, 200, item.call);
    assert.equal((await response.json()).ok, true);
  }
  assert.deepEqual(calls.map(([name]) => name), cases.map((item) => item.call));
  assert.deepEqual(calls[5], ["claim", 25, undefined]);
  assert.deepEqual(calls[6], ["claim", 1, payload.evaluationId]);
});

test("the evaluation endpoint preserves conflict and service-unavailable boundaries", async () => {
  const conflict = createEvaluationHandler(TOKEN, { ...services([]), lease: async () => { throw new Error("Evaluation binding conflicts with frozen evidence."); } });
  const unavailable = createEvaluationHandler(TOKEN, { ...services([]), lease: async () => { throw new Error("Persistent report storage is unavailable."); } });
  assert.equal((await conflict(request({ action: "lease", ...payload }))).status, 409);
  assert.equal((await unavailable(request({ action: "lease", ...payload }))).status, 503);
});

test("the Trigger HTTP adapter and application route share the same wire contract", async () => {
  const calls = [];
  const handler = createEvaluationHandler(TOKEN, services(calls));
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/capabilities")) return Response.json(createWorkerApiManifest());
    return handler(new Request(url, init));
  };
  const port = createReportEvaluationDispatchHttpPort({ appOrigin: "https://market.example", evaluationToken: TOKEN, fetchImpl });
  await port.preflight();
  assert.deepEqual(await port.claim(1, payload.evaluationId), [payload]);
  await port.acknowledge(payload, "run_123");
  await port.ambiguous(payload);
  assert.deepEqual(calls.map(([name]) => name), ["claim", "ack", "ambiguous"]);
});
