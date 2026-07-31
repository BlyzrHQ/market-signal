import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_AGENT_DEFAULT_MODEL,
  REPORT_AGENT_JUDGE_VERSION,
  buildReportAgentPacket,
  canonicalReportAgentJSON,
} from "../app/lib/report-agent-judge.ts";
import {
  REPORT_EVALUATION_CAPABILITIES,
  REPORT_EVALUATION_CONTRACT_VERSION,
  parseReportEvaluationPayload,
} from "../src/shared/report-evaluation-contract.ts";
import { REQUIRED_WORKER_API_CAPABILITIES, WORKER_API_PROTOCOL_VERSION, WORKER_API_SERVICE } from "../src/shared/worker-api-contract.ts";
import { dispatchClaimedEvaluations, evaluateReport, recoverReportEvaluations } from "../src/trigger/report-evaluation-core.ts";
import { createReportEvaluationDispatchHttpPort, createReportEvaluationHttpPort } from "../src/trigger/report-evaluation-http.ts";

const payload = Object.freeze({
  contractVersion: REPORT_EVALUATION_CONTRACT_VERSION,
  evaluationId: "evaluation_1234567890abcdef",
  evaluatorVersion: REPORT_AGENT_JUDGE_VERSION,
  inputHash: "a".repeat(64),
  factManifestHash: "b".repeat(64),
  dispatchGeneration: 2,
  dispatchToken: "dispatch-token-1234567890-abcdefghij",
});

const deterministicProfile = Object.freeze({
  evaluatorVersion: "deterministic-v1",
  terminalStatus: "complete",
  schemaValid: true,
  components: { userValue: {}, evidenceIntegrity: {}, evidenceYield: {}, presentation: {} },
  hardCaps: [],
});

const packet = Object.freeze(buildReportAgentPacket({
  report: { terminalStatus: "complete" },
  deterministicProfile,
  evidence: [{ id: "evidence-1", excerpt: "Public catalog evidence supports this conclusion." }],
}).packet);

const score = (points = 0) => ({ points, reason: "The supplied evidence supports this conclusion.", evidenceIds: ["evidence-1"] });
const judge = Object.freeze({
  scores: {
    userValue: {
      competitorUsefulness: score(),
      commercialComparisonUsefulness: score(),
      actionSpecificityAndPriority: score(),
    },
    evidenceIntegrity: {
      uncertaintyAndClaimTypeHonesty: score(),
      evidenceBoundedRecommendations: score(),
    },
    presentationUtility: {
      prioritizationAndHierarchy: score(),
      decisionClarity: score(),
      topThreeActionClarity: score(),
    },
  },
  findings: [],
  proposals: [],
});

async function packetHash(value = packet) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalReportAgentJSON(value)));
  return Buffer.from(digest).toString("hex");
}

async function workerPort(overrides = {}) {
  const order = [];
  const state = { modelCalls: 0, accepted: [], rejected: [] };
  const hash = await packetHash();
  return {
    order,
    state,
    port: {
      async preflight() { order.push("preflight"); },
      async lease() { order.push("lease"); return { accepted: true, leaseToken: "lease-token-1234567890-abcdefghijklm", leaseGeneration: 4 }; },
      async prepare() { order.push("prepare"); return { accepted: true, prepared: { model: REPORT_AGENT_DEFAULT_MODEL, packetHash: hash, packet, deterministicProfile } }; },
      async beginJudging() { order.push("judging"); return { accepted: true, state: "judging" }; },
      async requestJudge() {
        order.push("model");
        state.modelCalls += 1;
        return { status: "completed", output_text: JSON.stringify(judge), usage: { input_tokens: 900, output_tokens: 100, input_tokens_details: { cached_tokens: 100 } } };
      },
      async commitAccepted(input) { order.push("complete"); state.accepted.push(input); },
      async commitRejected(input) { order.push("reject"); state.rejected.push(input); },
      ...overrides,
    },
  };
}

test("the versioned dispatch payload is exact and binds the frozen evidence", () => {
  assert.deepEqual(parseReportEvaluationPayload(payload), payload);
  assert.throws(() => parseReportEvaluationPayload({ ...payload, customerToken: "not-allowed" }), /unsupported fields/);
  assert.throws(() => parseReportEvaluationPayload({ ...payload, dispatchGeneration: 4 }), /dispatch generation/);
  assert.throws(() => parseReportEvaluationPayload({ ...payload, inputHash: "short" }), /input hash/);
});

test("worker persists deterministic preparation before the judging CAS and makes one strict model call", async () => {
  const fixture = await workerPort();
  const result = await evaluateReport(payload, fixture.port);
  assert.deepEqual(fixture.order, ["preflight", "lease", "prepare", "judging", "model", "complete"]);
  assert.equal(fixture.state.modelCalls, 1);
  assert.equal(fixture.state.accepted.length, 1);
  assert.equal(fixture.state.accepted[0].lease.dispatchToken, payload.dispatchToken);
  assert.equal(fixture.state.accepted[0].hybrid.overallScore, 0);
  assert.deepEqual(result, { ok: true, state: "complete", overallScore: 0, grade: "F" });
});

test("a replay that cannot cross the judging barrier never calls the model", async () => {
  const fixture = await workerPort({
    async beginJudging() { fixture.order.push("judging"); return { accepted: false, state: "judging" }; },
  });
  const result = await evaluateReport(payload, fixture.port);
  assert.equal(fixture.state.modelCalls, 0);
  assert.equal(fixture.state.accepted.length, 0);
  assert.equal(result.replayed, true);
  assert.equal(result.state, "judging");
});

test("an ambiguous model transport becomes terminal deterministic-only and is not retried", async () => {
  const fixture = await workerPort({
    async requestJudge() { fixture.order.push("model"); fixture.state.modelCalls += 1; throw new Error("transport detail must not escape"); },
  });
  const first = await evaluateReport(payload, fixture.port);
  assert.equal(first.errorCode, "agent-call-outcome-unknown");
  assert.equal(fixture.state.rejected[0].phase, "judging");
  fixture.port.lease = async () => ({ accepted: false, state: "agent_rejected" });
  const replay = await evaluateReport(payload, fixture.port);
  assert.equal(replay.replayed, true);
  assert.equal(fixture.state.modelCalls, 1);
});

test("a packet hash conflict rejects before judging or model dispatch", async () => {
  const fixture = await workerPort({
    async prepare() { fixture.order.push("prepare"); return { accepted: true, prepared: { model: REPORT_AGENT_DEFAULT_MODEL, packetHash: "c".repeat(64), packet, deterministicProfile } }; },
  });
  const result = await evaluateReport(payload, fixture.port);
  assert.equal(result.errorCode, "agent-packet-hash-conflict");
  assert.deepEqual(fixture.order, ["preflight", "lease", "prepare", "reject"]);
  assert.equal(fixture.state.modelCalls, 0);
});

test("a deterministic profile that conflicts with the hashed packet rejects before judging", async () => {
  const fixture = await workerPort({
    async prepare() {
      fixture.order.push("prepare");
      return { accepted: true, prepared: { model: REPORT_AGENT_DEFAULT_MODEL, packetHash: await packetHash(), packet, deterministicProfile: { ...deterministicProfile, hardCaps: [{ issueKey: "coverage", maximumOverallScore: 40 }] } } };
    },
  });
  const result = await evaluateReport(payload, fixture.port);
  assert.equal(result.errorCode, "deterministic-profile-packet-conflict");
  assert.deepEqual(fixture.order, ["preflight", "lease", "prepare", "reject"]);
  assert.equal(fixture.state.modelCalls, 0);
});

test("recovery exits without preflight or claims while dispatch is disabled", async () => {
  const dispatch = {
    async preflight() { throw new Error("must not run"); },
    async claim() { throw new Error("must not run"); },
    async acknowledge() {},
    async ambiguous() {},
  };
  const result = await recoverReportEvaluations(false, dispatch, { async trigger() { throw new Error("must not run"); } });
  assert.deepEqual(result, { ok: true, enabled: false, claimed: 0, triggered: 0, ambiguous: 0 });
});

test("disabled exact dispatch exits without preflight or claiming the target", async () => {
  const dispatch = {
    async preflight() { throw new Error("must not run"); },
    async claim() { throw new Error("must not run"); },
    async acknowledge() {},
    async ambiguous() {},
  };
  const result = await dispatchClaimedEvaluations(false, dispatch, { async trigger() { throw new Error("must not run"); } }, { evaluationId: payload.evaluationId });
  assert.deepEqual(result, { ok: true, enabled: false, claimed: 0, triggered: 0, ambiguous: 0 });
});

test("exact dispatch claims and triggers only the requested evaluation", async () => {
  const observed = { claims: [], triggers: [], acknowledgements: [] };
  const dispatch = {
    async preflight() {},
    async claim(limit, evaluationId) { observed.claims.push({ limit, evaluationId }); return [payload]; },
    async acknowledge(claim, runId) { observed.acknowledgements.push({ claim, runId }); },
    async ambiguous() { throw new Error("must not be ambiguous"); },
  };
  const result = await dispatchClaimedEvaluations(true, dispatch, {
    async trigger(claim, options) { observed.triggers.push({ claim, options }); return { id: "run_exact" }; },
  }, { evaluationId: payload.evaluationId, limit: 25 });
  assert.deepEqual(observed.claims, [{ limit: 1, evaluationId: payload.evaluationId }]);
  assert.equal(observed.triggers.length, 1);
  assert.equal(observed.triggers[0].claim.evaluationId, payload.evaluationId);
  assert.deepEqual(observed.acknowledgements, [{ claim: payload, runId: "run_exact" }]);
  assert.deepEqual(result, { ok: true, enabled: true, claimed: 1, triggered: 1, ambiguous: 0 });
});

test("recovery uses generation-specific 90-day keys and retains ambiguous generations", async () => {
  const second = { ...payload, evaluationId: "evaluation_abcdef1234567890", dispatchGeneration: 3, dispatchToken: "dispatch-token-abcdef-1234567890ghij" };
  const acknowledged = [];
  const ambiguous = [];
  const triggerCalls = [];
  const dispatch = {
    async preflight() {},
    async claim(limit) { assert.equal(limit, 25); return [payload, second]; },
    async acknowledge(claim, runId) { acknowledged.push({ claim, runId }); },
    async ambiguous(claim) { ambiguous.push(claim); },
  };
  const result = await recoverReportEvaluations(true, dispatch, {
    async trigger(claim, options) {
      triggerCalls.push({ claim, options });
      if (claim.evaluationId === second.evaluationId) throw new Error("ambiguous Trigger transport");
      return { id: "run_123" };
    },
  });
  assert.equal(triggerCalls[0].options.idempotencyKey, `evaluation:${payload.evaluationId}:${payload.evaluatorVersion}:2`);
  assert.equal(triggerCalls[0].options.idempotencyKeyTTL, "90d");
  assert.deepEqual(acknowledged, [{ claim: payload, runId: "run_123" }]);
  assert.deepEqual(ambiguous, [second]);
  assert.deepEqual(result, { ok: true, enabled: true, claimed: 2, triggered: 1, ambiguous: 1 });
});

test("evaluation HTTP preflight uses the separate token and requires additive capabilities", async () => {
  const requests = [];
  const manifest = {
    ok: true,
    service: WORKER_API_SERVICE,
    protocolVersion: WORKER_API_PROTOCOL_VERSION,
    capabilities: [...REQUIRED_WORKER_API_CAPABILITIES, ...REPORT_EVALUATION_CAPABILITIES],
    observedAt: "2026-07-31T12:00:00.000Z",
  };
  const port = createReportEvaluationDispatchHttpPort({
    appOrigin: "https://market-signal.example",
    evaluationToken: "evaluation-secret-token-1234567890",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const body = init?.body ? JSON.parse(init.body) : null;
      const response = body?.action === "claim-dispatches" ? { ok: true, claims: [] } : manifest;
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await port.preflight();
  await port.claim(1, payload.evaluationId);
  assert.equal(requests[0].url, "https://market-signal.example/api/internal/capabilities");
  assert.equal(requests[0].init.headers.Authorization, "Bearer evaluation-secret-token-1234567890");
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: "claim-dispatches", limit: 1, evaluationId: payload.evaluationId });

  const incompatible = createReportEvaluationDispatchHttpPort({
    appOrigin: "https://market-signal.example",
    evaluationToken: "evaluation-secret-token-1234567890",
    fetchImpl: async () => new Response(JSON.stringify({ ...manifest, capabilities: [...REQUIRED_WORKER_API_CAPABILITIES] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(() => incompatible.preflight(), /does not support report evaluation/);
  assert.throws(() => createReportEvaluationDispatchHttpPort({ appOrigin: "http://market-signal.example", evaluationToken: "evaluation-secret-token-1234567890" }), /HTTPS origin/);
});

test("evaluation HTTP terminal commits fail when the application did not accept the CAS", async () => {
  const port = createReportEvaluationHttpPort({
    appOrigin: "https://market-signal.example",
    evaluationToken: "evaluation-secret-token-1234567890",
    openaiApiKey: "sk-test-evaluation-key-1234567890",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ ok: true, accepted: false, state: body.action === "complete" ? "judging" : "ready_for_judge" });
    },
  });
  const lease = { ...payload, leaseToken: payload.dispatchToken, leaseGeneration: 2 };
  await assert.rejects(() => port.commitAccepted({ lease, packetHash: "c".repeat(64), model: REPORT_AGENT_DEFAULT_MODEL, judge: {}, hybrid: {}, usage: {} }), /HTTP 409/);
  await assert.rejects(() => port.commitRejected({ lease, packetHash: "c".repeat(64), phase: "judging", errorCode: "agent-call-outcome-unknown" }), /HTTP 409/);
});
