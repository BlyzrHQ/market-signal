import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_SEARCH_CHALLENGE_MODEL,
  REPORT_SEARCH_CHALLENGE_PRICING_VERSION,
  REPORT_SEARCH_CHALLENGE_PROMPT_VERSION,
  REPORT_SEARCH_CHALLENGER_VERSION,
  parseReportSearchChallengePayload,
  parseReportSearchChallengeTerminal,
} from "../src/shared/report-search-challenge-contract.ts";
import { runReportSearchChallenge } from "../src/trigger/report-search-challenge-core.ts";
import { createReportSearchChallengeHttpPort, SearchChallengeWorkerApiError } from "../src/trigger/report-search-challenge-http.ts";
import { reportSearchChallengeDispatchKey, reportSearchChallengeEnabled } from "../app/lib/report-search-challenge-dispatch.ts";
import { sampleReportSearchChallengeProducts } from "../app/lib/report-store.ts";

const PAYLOAD = { challengeId: "challenge-1", challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1 };
const CANONICAL = JSON.stringify({ schemaVersion: "report-search-challenge-input-v1", primaryDomain: "myjam.co.uk", marketCountryCode: "GB", products: [{ productId: "beef-cubes", name: "Beef Cubes Halal 500g", knownComparisonUrls: [] }] });

function providerResponse(url = "https://butcher.example/products/halal-beef-cubes-500g") {
  return Response.json({
    id: "resp_search_1", status: "completed",
    output: [
      { type: "web_search_call", action: { query: "UK Beef Cubes Halal 500g", sources: [{ title: "Halal Beef Cubes 500g", url }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [{ productId: "beef-cubes", query: "UK Beef Cubes Halal 500g", candidates: [{ title: "Halal Beef Cubes 500g", url }] }] }) }] },
    ],
    usage: { input_tokens: 120, output_tokens: 40, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } },
  }, { headers: { "x-request-id": "req_search_1" } });
}

test("search challenge wire contracts are closed and versioned", () => {
  assert.deepEqual(parseReportSearchChallengePayload(PAYLOAD), PAYLOAD);
  assert.throws(() => parseReportSearchChallengePayload({ ...PAYLOAD, extra: true }));
  const terminal = { action: "terminal", challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:owner-1", reservationId: "reservation-1", clientRequestId: "client-1", status: "complete", errorCode: null, providerResponseId: "resp_search_1", providerRequestId: "req_search_1", usageStatus: "known", usage: { inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 40, webSearchCalls: 1 }, candidates: [{ productId: "beef-cubes", query: "UK Beef Cubes Halal 500g", title: "Halal Beef Cubes 500g", url: "https://butcher.example/products/halal-beef-cubes-500g" }], model: REPORT_SEARCH_CHALLENGE_MODEL, promptVersion: REPORT_SEARCH_CHALLENGE_PROMPT_VERSION, pricingVersion: REPORT_SEARCH_CHALLENGE_PRICING_VERSION };
  assert.deepEqual(parseReportSearchChallengeTerminal(terminal), terminal);
  assert.throws(() => parseReportSearchChallengeTerminal({ ...terminal, usage: { ...terminal.usage, webSearchCalls: 6 } }));
  assert.throws(() => parseReportSearchChallengeTerminal({ ...terminal, candidates: [...terminal.candidates, { ...terminal.candidates[0], url: "file:///secret" }] }));
});

test("one reservation makes one bounded web-search response call and only emits source-backed URLs", async () => {
  const terminals = []; const calls = [];
  const port = { async reserve(_payload, _owner, clientRequestId) { return { ok: true, reservationId: "reservation-1", clientRequestId, canonicalInput: CANONICAL }; }, async terminal(id, callback) { terminals.push({ id, callback }); } };
  const result = await runReportSearchChallenge(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: (() => { const values = ["owner-1", "client-1"]; return () => values.shift(); })(), fetchImpl: async (url, init) => { calls.push({ url, init }); return providerResponse(); } });
  assert.deepEqual(result, { ok: true, called: true, status: "complete" });
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].init.body);
  assert.deepEqual(request.tools, [{ type: "web_search" }]);
  assert.equal(request.tool_choice, "required");
  assert.equal(request.max_tool_calls, 5);
  assert.deepEqual(request.include, ["web_search_call.action.sources"]);
  assert.equal(terminals[0].callback.candidates.length, 1);
  assert.equal(terminals[0].callback.usage.webSearchCalls, 1);
});

test("a model URL absent from web-search source evidence is discarded", async () => {
  const terminals = [];
  const port = { async reserve(_payload, _owner, clientRequestId) { return { ok: true, reservationId: "reservation-1", clientRequestId, canonicalInput: CANONICAL }; }, async terminal(_id, callback) { terminals.push(callback); } };
  const sourceUrl = "https://source.example/products/beef-cubes";
  const response = providerResponse(sourceUrl); const body = await response.json(); body.output[1].content[0].text = JSON.stringify({ results: [{ productId: "beef-cubes", query: "UK Beef Cubes Halal 500g", candidates: [{ title: "Invented", url: "https://invented.example/products/beef-cubes" }] }] });
  await runReportSearchChallenge(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-1", fetchImpl: async () => Response.json(body, { headers: { "x-request-id": "req_search_1" } }) });
  assert.deepEqual(terminals[0].candidates, []);
});

test("a schema-rejected terminal callback is retried once as a cost-preserving terminal failure", async () => {
  const terminals = [];
  const port = {
    async reserve(_payload, _owner, clientRequestId) { return { ok: true, reservationId: "reservation-1", clientRequestId, canonicalInput: CANONICAL }; },
    async terminal(_id, callback) {
      terminals.push(callback);
      if (terminals.length === 1) throw new SearchChallengeWorkerApiError(400, "search-challenge-contract-invalid");
    },
  };
  const result = await runReportSearchChallenge(PAYLOAD, port, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-1", fetchImpl: async () => providerResponse() });
  assert.deepEqual(result, { ok: false, called: true, status: "agent_rejected" });
  assert.equal(terminals.length, 2);
  assert.equal(terminals[1].errorCode, "terminal-callback-rejected");
  assert.equal(terminals[1].usageStatus, "known");
  assert.equal(terminals[1].usage.webSearchCalls, 1);
  assert.equal(terminals[1].providerResponseId, null);
  assert.equal(terminals[1].candidates, null);
});

test("worker HTTP failures expose only a bounded machine-readable error code", async () => {
  const port = createReportSearchChallengeHttpPort({
    appOrigin: "https://signal.example",
    callbackToken: "callback-token-that-is-long-enough-for-tests",
    fetchImpl: async () => Response.json({ ok: false, code: "search-challenge-contract-invalid", error: "sensitive details are not forwarded" }, { status: 400 }),
  });
  await assert.rejects(
    () => port.terminal(PAYLOAD.challengeId, {}),
    (error) => error instanceof SearchChallengeWorkerApiError && error.status === 400 && error.code === "search-challenge-contract-invalid" && !error.message.includes("sensitive details"),
  );
});

test("overlong provider source URLs are discarded before the terminal callback", async () => {
  const terminals = [];
  const url = `https://butcher.example/products/beef?value=${"a".repeat(2_100)}`;
  await runReportSearchChallenge(PAYLOAD, {
    async reserve(_payload, _owner, clientRequestId) { return { ok: true, reservationId: "reservation-1", clientRequestId, canonicalInput: CANONICAL }; },
    async terminal(_id, callback) { terminals.push(callback); },
  }, { apiKey: "test_api_key_long_enough_for_validation", randomUUID: () => "client-1", fetchImpl: async () => providerResponse(url) });
  assert.deepEqual(terminals[0].candidates, []);
});

test("the global challenger is controlled by one explicit kill switch and dispatch attempts are idempotent", async () => {
  assert.equal(await reportSearchChallengeEnabled("false"), false);
  assert.equal(await reportSearchChallengeEnabled("true"), true);
  assert.notEqual(reportSearchChallengeDispatchKey(PAYLOAD), reportSearchChallengeDispatchKey({ ...PAYLOAD, dispatchAttempt: 2 }));
});

test("product sampling prefers weak coverage across distinct categories before filling by rank", () => {
  const sampled = sampleReportSearchChallengeProducts([
    { productId: "meat-b", category: "Meat", knownComparisonUrls: [] },
    { productId: "meat-a", category: "MEAT", knownComparisonUrls: [] },
    { productId: "dairy", category: "Dairy", knownComparisonUrls: [] },
    { productId: "bakery", category: "Bakery", knownComparisonUrls: ["https://known.example/bakery"] },
    { productId: "produce", category: "Produce", knownComparisonUrls: ["https://known.example/produce"] },
    { productId: "pantry", category: "Pantry", knownComparisonUrls: ["https://known.example/pantry"] },
  ]);

  assert.deepEqual(sampled.map((item) => item.productId), ["dairy", "meat-a", "bakery", "pantry", "produce"]);
  assert.equal(new Set(sampled.map((item) => item.category.toLowerCase())).size, 5);
});
