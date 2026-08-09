import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REPORT_EVALUATION_CAPABILITY,
  REPORT_EVALUATION_MODEL,
  REPORT_EVALUATOR_VERSION,
  parseReportEvaluationPayload,
  parseReportEvaluationReservationRequest,
  parseReportEvaluationTerminalCallback,
} from "../src/shared/report-evaluation-contract.ts";
import { runReportEvaluation } from "../src/trigger/report-evaluation-core.ts";
import { createReportEvaluationHttpPort } from "../src/trigger/report-evaluation-http.ts";

const PAYLOAD = { evaluationId: "evaluation_test-1", evaluatorVersion: REPORT_EVALUATOR_VERSION, dispatchAttempt: 1 };
const TOKEN = "evaluation_callback_token_that_is_long_enough";

function reservation() {
  return { ok: true, reservationId: "reservation-1", clientRequestId: "client-2", canonicalInput: JSON.stringify({ report: { id: "report-1" }, evidence: [] }) };
}

function agentOutput(humanReview = null) {
  const score = (value) => ({ score: value, reason: "Supported by the supplied report evidence.", evidenceIds: ["report:evidence-1"] });
  return {
    scores: {
      competitorUsefulness: score(8), productComparisonUsefulness: score(12), recommendationSpecificity: score(10), uncertaintyHonesty: score(8),
      recommendationGrounding: score(8), prioritizationHierarchy: score(20), decisionClarity: score(20), topActionsIdentifiable: score(15),
    },
    strengths: [], weaknesses: [], proposals: [], humanReview,
  };
}

function providerResponse(output = agentOutput(), overrides = {}) {
  return Response.json({
    id: "resp_1",
    status: "completed",
    service_tier: "default",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } },
    ...overrides,
  }, { headers: { "x-request-id": "req_1" } });
}

function portFixture(reserved = reservation()) {
  const state = { reserves: [], terminals: [] };
  return {
    state,
    port: {
      async reserve(payload, owner, clientRequestId) { state.reserves.push({ payload, owner, clientRequestId }); return { ...reserved, clientRequestId }; },
      async terminal(id, callback) { state.terminals.push({ id, callback }); },
    },
  };
}

test("payload parsing is closed, versioned, and bounds dispatch attempts", () => {
  assert.deepEqual(parseReportEvaluationPayload(PAYLOAD), PAYLOAD);
  assert.throws(() => parseReportEvaluationPayload({ ...PAYLOAD, extra: true }));
  assert.throws(() => parseReportEvaluationPayload({ ...PAYLOAD, evaluatorVersion: "old" }), /unsupported/);
  assert.throws(() => parseReportEvaluationPayload({ ...PAYLOAD, dispatchAttempt: 4 }));
});

test("reservation and terminal callbacks reject open or inconsistent wire payloads", () => {
  const reserve = { action: "reserve", evaluatorVersion: REPORT_EVALUATOR_VERSION, dispatchAttempt: 1, reservationOwner: "worker:owner-1", clientRequestId: "client-2" };
  assert.deepEqual(parseReportEvaluationReservationRequest(reserve), reserve);
  assert.throws(() => parseReportEvaluationReservationRequest({ ...reserve, extra: true }));

  const terminal = {
    action: "terminal", evaluatorVersion: REPORT_EVALUATOR_VERSION, dispatchAttempt: 1,
    reservationOwner: "worker:owner-1", reservationId: "reservation-1", clientRequestId: "client-2",
    status: "complete", errorCode: null, providerResponseId: "resp_1", providerRequestId: "req_1",
    usageStatus: "known", usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 50 }, agentOutput: agentOutput(),
    model: REPORT_EVALUATION_MODEL, promptVersion: "report-agent-judge-2026-08-09-v2", pricingVersion: "openai-gpt-5.6-luna-2026-08-09",
  };
  assert.deepEqual(parseReportEvaluationTerminalCallback(terminal), terminal);
  assert.throws(() => parseReportEvaluationTerminalCallback({ ...terminal, status: "complete", usageStatus: "unknown", usage: terminal.usage }));
  assert.throws(() => parseReportEvaluationTerminalCallback({ ...terminal, usage: { ...terminal.usage, cachedInputTokens: 120 } }));
  assert.throws(() => parseReportEvaluationTerminalCallback({ ...terminal, usage: { ...terminal.usage, cacheWriteInputTokens: -1 } }));
  assert.throws(() => parseReportEvaluationTerminalCallback({ ...terminal, usage: { ...terminal.usage, cachedInputTokens: 60, cacheWriteInputTokens: 50 } }));
  assert.throws(() => parseReportEvaluationTerminalCallback({ ...terminal, agentOutput: null }));
  assert.throws(() => parseReportEvaluationTerminalCallback({ ...terminal, extra: true }));
});

test("one reservation produces one bounded Responses call and a complete callback", async () => {
  const { port, state } = portFixture();
  const calls = [];
  const result = await runReportEvaluation(PAYLOAD, port, {
    apiKey: "test_api_key_long_enough_for_validation",
    randomUUID: (() => { const ids = ["owner-1", "client-2"]; return () => ids.shift(); })(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return providerResponse(); },
  });
  assert.deepEqual(result, { ok: true, called: true, status: "complete" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init.headers["X-Client-Request-Id"], "client-2");
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.model, REPORT_EVALUATION_MODEL);
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.service_tier, "default");
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(request.max_output_tokens, 1_200);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(request.input[1].content[0].text, reservation().canonicalInput);
  assert.equal(state.terminals.length, 1);
  assert.equal(state.terminals[0].callback.status, "complete");
  assert.deepEqual(state.terminals[0].callback.usage, { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 50 });
});

test("a human question is terminal but remains explicitly needs_human_review", async () => {
  const { port, state } = portFixture();
  const humanReview = { uncertaintyCode: "subjective_usefulness", question: "Is this recommendation useful to an operator?", evidenceIds: ["report:evidence-1"] };
  const result = await runReportEvaluation(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-2", fetchImpl: async () => providerResponse(agentOutput(humanReview)) });
  assert.equal(result.status, "needs_human_review");
  assert.equal(state.terminals[0].callback.status, "needs_human_review");
});

test("declined reservation never calls OpenAI or emits a terminal callback", async () => {
  const { port, state } = portFixture({ ok: false, code: "terminal" });
  let calls = 0;
  const result = await runReportEvaluation(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-2", fetchImpl: async () => { calls += 1; return providerResponse(); } });
  assert.deepEqual(result, { ok: true, called: false, reason: "terminal" });
  assert.equal(calls, 0);
  assert.equal(state.terminals.length, 0);
});

test("missing provider configuration fails before reservation", async () => {
  const { port, state } = portFixture();
  await assert.rejects(() => runReportEvaluation(PAYLOAD, port, { apiKey: "", randomUUID: () => "unused" }), /OPENAI_API_KEY/);
  assert.equal(state.reserves.length, 0);
  assert.equal(state.terminals.length, 0);
});

test("provider HTTP and malformed completed results reject; billable failures retain usage and transport uncertainty is never retried", async () => {
  for (const [fetchImpl, expectedStatus, expectedCode, expectedUsageStatus] of [
    [async () => Response.json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status: 429, headers: { "x-request-id": "req_429" } }), "agent_rejected", "provider-rate-limited", "unknown"],
    [async () => Response.json({ error: { type: "invalid_request_error", code: "model_not_found", param: "model" } }, { status: 400, headers: { "x-request-id": "req_model" } }), "agent_rejected", "provider-model-unavailable", "unknown"],
    [async () => Response.json({ error: { type: "invalid_request_error", code: null, param: "text.format.schema" } }, { status: 400, headers: { "x-request-id": "req_schema" } }), "agent_rejected", "provider-request-rejected", "unknown"],
    [async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "x".repeat(5_000) } }), { status: 400, headers: { "x-request-id": "req_large" } }), "agent_rejected", "provider-request-rejected", "unknown"],
    [async () => providerResponse(agentOutput(), { service_tier: "priority" }), "agent_rejected", "provider-service-tier-unverified", "unknown"],
    [async () => providerResponse(agentOutput(), { service_tier: undefined }), "agent_rejected", "provider-service-tier-unverified", "unknown"],
    [async () => providerResponse(agentOutput(), { usage: null }), "agent_rejected", "provider-usage-missing", "unknown"],
    [async () => providerResponse({ ...agentOutput(), humanReview: undefined }), "agent_rejected", "provider-output-invalid", "known"],
    [async () => { throw new TypeError("network down"); }, "call_outcome_unknown", "provider-transport-unknown", "unknown"],
  ]) {
    const { port, state } = portFixture();
    let calls = 0;
    const result = await runReportEvaluation(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-2", fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); } });
    assert.equal(calls, 1);
    assert.equal(result.status, expectedStatus);
    assert.equal(state.terminals[0].callback.status, expectedStatus);
    assert.equal(state.terminals[0].callback.errorCode, expectedCode);
    assert.equal(state.terminals[0].callback.usageStatus, expectedUsageStatus);
    if (expectedUsageStatus === "known") assert.deepEqual(state.terminals[0].callback.usage, { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 50 });
  }
});

test("provider rejection bodies are cancelled on shortcut statuses and oversized chunks", async () => {
  for (const [status, bytes] of [[401, 8], [400, 5_000]]) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(bytes).fill(65)); },
      cancel() { cancelled = true; },
    });
    const { port, state } = portFixture();
    const result = await runReportEvaluation(PAYLOAD, port, {
      apiKey: "test_api_key_long_enough_for_validation",
      randomUUID: () => "client-2",
      fetchImpl: async () => new Response(stream, { status }),
    });
    assert.equal(result.status, "agent_rejected");
    assert.equal(state.terminals[0].callback.usageStatus, "unknown");
    assert.equal(cancelled, true);
  }
});

test("a failed terminal callback does not emit a second conflicting callback", async () => {
  const { port, state } = portFixture();
  port.terminal = async (id, callback) => { state.terminals.push({ id, callback }); throw new Error("callback unavailable"); };
  await assert.rejects(() => runReportEvaluation(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-2", fetchImpl: async () => providerResponse() }), /callback unavailable/);
  assert.equal(state.terminals.length, 1);
  assert.equal(state.terminals[0].callback.status, "complete");
});

test("HTTP port authenticates, checks the additive capability, reserves, and posts terminal state", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/capabilities")) return Response.json({ ok: true, service: "market-signal-worker-api", protocolVersion: "1", capabilities: ["report.read", "report.event.append", "report.document.save", "crawl.execute", "ads.execute", "products.match", "products.enrich", "products.actions", REPORT_EVALUATION_CAPABILITY], observedAt: "2026-08-09T00:00:00.000Z" });
    const body = JSON.parse(init.body);
    if (body.action === "reserve") return Response.json({ ...reservation(), clientRequestId: body.clientRequestId });
    return Response.json({ ok: true });
  };
  const port = createReportEvaluationHttpPort({ appOrigin: "https://market.example", callbackToken: TOKEN, fetchImpl });
  await port.preflight();
  const reserved = await port.reserve(PAYLOAD, "worker:owner", "client-2");
  await port.terminal(PAYLOAD.evaluationId, { action: "terminal" });
  assert.equal(reserved.ok, true);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, `https://market.example/api/internal/evaluations/${PAYLOAD.evaluationId}`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(calls[1].init.body).action, "reserve");
  assert.equal(JSON.parse(calls[2].init.body).action, "terminal");
});

test("Trigger declaration is a single-attempt bounded task", async () => {
  const source = await readFile(new URL("../src/trigger/report-evaluation.ts", import.meta.url), "utf8");
  assert.match(source, /marketSignalReportEvaluation\s*=\s*task/);
  assert.match(source, /maxDuration:\s*150/);
  assert.match(source, /maxAttempts:\s*1/);
  assert.match(source, /concurrencyLimit:\s*4/);
  assert.match(source, /OPENAI_API_KEY/);
});
