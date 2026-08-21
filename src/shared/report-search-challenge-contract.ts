import { REPORT_SEARCH_CHALLENGE_CAPABILITY } from "./worker-api-contract.ts";

export { REPORT_SEARCH_CHALLENGE_CAPABILITY };

export const REPORT_SEARCH_CHALLENGE_TASK_ID = "market-signal-report-search-challenge" as const;
export const REPORT_SEARCH_CHALLENGER_VERSION = "independent-recall-v2" as const;
export const REPORT_SEARCH_CHALLENGE_MODEL = "gpt-5.6-luna" as const;
export const REPORT_SEARCH_CHALLENGE_PROMPT_VERSION = "search-challenge-2026-08-21-v1" as const;
export const REPORT_SEARCH_CHALLENGE_PRICING_VERSION = "openai-gpt-5.6-luna-web-search-2026-08-21-v1" as const;
export const REPORT_SEARCH_CHALLENGE_MAX_PRODUCTS = 5;
export const REPORT_SEARCH_CHALLENGE_MAX_CANDIDATES = 30;
export const REPORT_SEARCH_CHALLENGE_TIMEOUT_MS = 90_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

export type ReportSearchChallengePayload = { challengeId: string; challengerVersion: string; dispatchAttempt: number };
export type ReportSearchChallengeUsage = { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; webSearchCalls: number };
export type ReportSearchChallengeCandidate = { productId: string; query: string; title: string; url: string };
export type ReportSearchChallengeReservation = { ok: true; reservationId: string; clientRequestId: string; canonicalInput: string };
export type ReportSearchChallengeReservationDeclined = { ok: false; code: "already_reserved" | "terminal" | "stale_attempt" | "ineligible" | "daily_budget_exceeded" };
export type ReportSearchChallengeTerminalCallback = {
  action: "terminal";
  challengerVersion: string;
  dispatchAttempt: number;
  reservationOwner: string;
  reservationId: string;
  clientRequestId: string;
  status: "complete" | "agent_rejected" | "call_outcome_unknown";
  errorCode: string | null;
  providerResponseId: string | null;
  providerRequestId: string | null;
  usageStatus: "known" | "unknown";
  usage: ReportSearchChallengeUsage | null;
  candidates: ReportSearchChallengeCandidate[] | null;
  model: typeof REPORT_SEARCH_CHALLENGE_MODEL;
  promptVersion: typeof REPORT_SEARCH_CHALLENGE_PROMPT_VERSION;
  pricingVersion: typeof REPORT_SEARCH_CHALLENGE_PRICING_VERSION;
};

export class ReportSearchChallengeContractError extends Error {
  constructor(message = "The report search challenge payload is invalid.") { super(message); this.name = "ReportSearchChallengeContractError"; }
}

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function exact(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function identifier(value: unknown) { return typeof value === "string" && ID.test(value); }
function boundedText(value: unknown, max: number) { return typeof value === "string" && value.length > 0 && value.length <= max; }
function providerMetadata(value: unknown) { return value === null || (typeof value === "string" && boundedText(value, 120) && !/[\u0000-\u001f\u007f]/u.test(value)); }

export function parseReportSearchChallengePayload(value: unknown): ReportSearchChallengePayload {
  const input = record(value);
  if (!input || !exact(input, ["challengeId", "challengerVersion", "dispatchAttempt"]) || !identifier(input.challengeId) || input.challengerVersion !== REPORT_SEARCH_CHALLENGER_VERSION || !Number.isInteger(input.dispatchAttempt) || Number(input.dispatchAttempt) < 1 || Number(input.dispatchAttempt) > 3) throw new ReportSearchChallengeContractError();
  return input as ReportSearchChallengePayload;
}

export function parseReportSearchChallengeReservation(value: unknown) {
  const input = record(value);
  if (!input || !exact(input, ["action", "challengerVersion", "dispatchAttempt", "reservationOwner", "clientRequestId"]) || input.action !== "reserve" || input.challengerVersion !== REPORT_SEARCH_CHALLENGER_VERSION || !Number.isInteger(input.dispatchAttempt) || Number(input.dispatchAttempt) < 1 || Number(input.dispatchAttempt) > 3 || !identifier(input.reservationOwner) || !identifier(input.clientRequestId)) throw new ReportSearchChallengeContractError("The report search challenge reservation is invalid.");
  return input as { action: "reserve"; challengerVersion: string; dispatchAttempt: number; reservationOwner: string; clientRequestId: string };
}

export function parseReportSearchChallengeTerminal(value: unknown): ReportSearchChallengeTerminalCallback {
  const input = record(value);
  const keys = ["action", "challengerVersion", "dispatchAttempt", "reservationOwner", "reservationId", "clientRequestId", "status", "errorCode", "providerResponseId", "providerRequestId", "usageStatus", "usage", "candidates", "model", "promptVersion", "pricingVersion"] as const;
  if (!input || !exact(input, keys) || input.action !== "terminal" || input.challengerVersion !== REPORT_SEARCH_CHALLENGER_VERSION || input.model !== REPORT_SEARCH_CHALLENGE_MODEL || input.promptVersion !== REPORT_SEARCH_CHALLENGE_PROMPT_VERSION || input.pricingVersion !== REPORT_SEARCH_CHALLENGE_PRICING_VERSION) throw new ReportSearchChallengeContractError("The report search challenge callback is invalid.");
  if (!Number.isInteger(input.dispatchAttempt) || Number(input.dispatchAttempt) < 1 || Number(input.dispatchAttempt) > 3 || ![input.reservationOwner, input.reservationId, input.clientRequestId].every(identifier)) throw new ReportSearchChallengeContractError("The report search challenge callback binding is invalid.");
  if (!["complete", "agent_rejected", "call_outcome_unknown"].includes(String(input.status)) || !["known", "unknown"].includes(String(input.usageStatus))) throw new ReportSearchChallengeContractError("The report search challenge callback status is invalid.");
  if ((input.errorCode !== null && !identifier(input.errorCode)) || !providerMetadata(input.providerResponseId) || !providerMetadata(input.providerRequestId)) throw new ReportSearchChallengeContractError("The report search challenge callback metadata is invalid.");
  const usage = record(input.usage);
  if (input.usageStatus === "known") {
    if (!usage || !exact(usage, ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "webSearchCalls"])) throw new ReportSearchChallengeContractError("The report search challenge usage is invalid.");
    const numbers = [usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.outputTokens, usage.webSearchCalls].map(Number);
    if (numbers.some((item) => !Number.isSafeInteger(item) || item < 0) || numbers[1] + numbers[2] > numbers[0] || numbers[4] > REPORT_SEARCH_CHALLENGE_MAX_PRODUCTS) throw new ReportSearchChallengeContractError("The report search challenge usage is invalid.");
  } else if (input.usage !== null) throw new ReportSearchChallengeContractError("Unknown report search challenge usage must be null.");
  if (input.status === "complete") {
    if (!Array.isArray(input.candidates) || input.candidates.length > REPORT_SEARCH_CHALLENGE_MAX_CANDIDATES) throw new ReportSearchChallengeContractError("The report search challenge candidates are invalid.");
    for (const candidate of input.candidates) {
      const item = record(candidate);
      if (!item || !exact(item, ["productId", "query", "title", "url"]) || !boundedText(item.productId, 128) || !boundedText(item.query, 300) || !boundedText(item.title, 300) || !boundedText(item.url, 2_000)) throw new ReportSearchChallengeContractError("The report search challenge candidates are invalid.");
      try { const url = new URL(String(item.url)); if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(); } catch { throw new ReportSearchChallengeContractError("The report search challenge candidate URL is invalid."); }
    }
  } else if (input.candidates !== null) throw new ReportSearchChallengeContractError("A failed search challenge cannot return candidates.");
  return input as unknown as ReportSearchChallengeTerminalCallback;
}
