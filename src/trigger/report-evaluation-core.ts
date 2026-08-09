import {
  REPORT_EVALUATION_DEVELOPER_PROMPT,
  REPORT_EVALUATION_MAX_OUTPUT_TOKENS,
  REPORT_EVALUATION_MAX_REQUEST_BYTES,
  REPORT_EVALUATION_MODEL,
  REPORT_EVALUATION_OUTPUT_SCHEMA,
  REPORT_EVALUATION_PRICING_VERSION,
  REPORT_EVALUATION_PROMPT_VERSION,
  REPORT_EVALUATION_TIMEOUT_MS,
  type ReportEvaluationPayload,
  type ReportEvaluationReservation,
  type ReportEvaluationReservationDeclined,
  type ReportEvaluationTerminalCallback,
  type ReportEvaluationUsage,
} from "../shared/report-evaluation-contract.ts";

type FetchLike = typeof fetch;

export type ReportEvaluationPort = {
  reserve(payload: ReportEvaluationPayload, reservationOwner: string, clientRequestId: string): Promise<ReportEvaluationReservation | ReportEvaluationReservationDeclined>;
  terminal(evaluationId: string, callback: ReportEvaluationTerminalCallback): Promise<void>;
};

export type ReportEvaluationRuntime = {
  apiKey: string;
  fetchImpl?: FetchLike;
  randomUUID?: () => string;
  timeoutMs?: number;
};

class ProviderHttpError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly errorCode: string;
  constructor(status: number, requestId: string | null, errorCode: string) {
    super(`OpenAI Responses request failed with HTTP ${status}.`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.requestId = requestId;
    this.errorCode = errorCode;
  }
}

async function providerHttpErrorCode(response: Response) {
  if (response.status === 401) return "provider-auth-invalid";
  if (response.status === 403) return "provider-permission-denied";
  if (response.status === 429) return "provider-rate-limited";
  if (response.status < 400 || response.status >= 500) return `provider-http-${Math.floor(response.status / 100)}xx`;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 4_096) return "provider-request-rejected";
  let body: unknown;
  try {
    if (!response.body) return "provider-request-rejected";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 4_096) {
        await reader.cancel().catch(() => undefined);
        return "provider-request-rejected";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    body = JSON.parse(text);
  } catch {
    return "provider-request-rejected";
  }
  const root = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : {};
  const type = typeof error.type === "string" ? error.type : "";
  const code = typeof error.code === "string" ? error.code : "";
  const param = typeof error.param === "string" ? error.param : "";
  if (code === "model_not_found" || (type === "invalid_request_error" && param === "model")) return "provider-model-unavailable";
  if (type === "authentication_error") return "provider-auth-invalid";
  if (type === "permission_error" || type === "permissions_error") return "provider-permission-denied";
  if (type === "rate_limit_error") return "provider-rate-limited";
  return "provider-request-rejected";
}

class ProviderResultError extends Error {
  readonly code: string;
  readonly responseId: string | null;
  readonly requestId: string | null;
  readonly measuredUsage: ReportEvaluationUsage | null;
  constructor(code: string, responseId: string | null, requestId: string | null, measuredUsage: ReportEvaluationUsage | null = null) {
    super(code);
    this.name = "ProviderResultError";
    this.code = code;
    this.responseId = responseId;
    this.requestId = requestId;
    this.measuredUsage = measuredUsage;
  }
}

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

function configuredApiKey(value: string) {
  if (!value || value.length < 20 || /\s/.test(value)) throw new Error("OPENAI_API_KEY is not configured correctly.");
  return value;
}

function buildRequest(canonicalInput: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalInput); } catch { throw new Error("The reserved evaluation input is not canonical JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The reserved evaluation input is invalid.");
  const body = {
    model: REPORT_EVALUATION_MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: REPORT_EVALUATION_MAX_OUTPUT_TOKENS,
    input: [
      { role: "developer", content: [{ type: "input_text", text: REPORT_EVALUATION_DEVELOPER_PROMPT }] },
      { role: "user", content: [{ type: "input_text", text: canonicalInput }] },
    ],
    text: { format: { type: "json_schema", name: "market_signal_report_evaluation", strict: true, schema: REPORT_EVALUATION_OUTPUT_SCHEMA } },
  };
  if (jsonBytes(REPORT_EVALUATION_DEVELOPER_PROMPT) + jsonBytes(REPORT_EVALUATION_OUTPUT_SCHEMA) + jsonBytes(canonicalInput) > REPORT_EVALUATION_MAX_REQUEST_BYTES) throw new Error("The reserved evaluation input exceeds the model request budget.");
  return body;
}

function usage(value: unknown): ReportEvaluationUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const details = item.input_tokens_details && typeof item.input_tokens_details === "object" && !Array.isArray(item.input_tokens_details) ? item.input_tokens_details as Record<string, unknown> : {};
  const inputTokens = Number(item.input_tokens);
  const outputTokens = Number(item.output_tokens);
  const cachedInputTokens = details.cached_tokens === undefined ? 0 : Number(details.cached_tokens);
  const cacheWriteInputTokens = details.cache_write_tokens === undefined ? 0 : Number(details.cache_write_tokens);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0 || !Number.isSafeInteger(cachedInputTokens) || cachedInputTokens < 0 || !Number.isSafeInteger(cacheWriteInputTokens) || cacheWriteInputTokens < 0 || cachedInputTokens + cacheWriteInputTokens > inputTokens) return null;
  return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens };
}

function outputText(value: Record<string, unknown>) {
  if (!Array.isArray(value.output)) return null;
  const texts: string[] = [];
  for (const output of value.output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "refusal") return null;
      if (record.type === "output_text" && typeof record.text === "string") texts.push(record.text);
    }
  }
  return texts.length === 1 ? texts[0] : null;
}

const OUTPUT_ID = /^[a-z][a-z0-9:_-]{0,119}$/;
const SUBJECT_KINDS = new Set(["report", "company", "product", "match", "recommendation"]);
const SCORE_LIMITS = {
  competitorUsefulness: 10,
  productComparisonUsefulness: 15,
  recommendationSpecificity: 15,
  uncertaintyHonesty: 10,
  recommendationGrounding: 10,
  prioritizationHierarchy: 25,
  decisionClarity: 25,
  topActionsIdentifiable: 20,
} as const;
const FINDING_CODES = {
  strengths: new Set(["useful_competitors", "useful_product_pairs", "actionable_recommendations", "honest_uncertainty", "clear_priorities", "presentation_clarity"]),
  weaknesses: new Set(["weak_competitor_fit", "weak_product_pairs", "generic_recommendations", "unsupported_certainty", "data_dumping", "evidence_gap"]),
  proposals: new Set(["improve_competitor_verification", "improve_product_matching", "improve_price_coverage", "improve_image_coverage", "improve_recommendation_specificity", "improve_evidence_linking", "improve_gap_explanation", "improve_information_hierarchy"]),
} as const;
const UNCERTAINTY_CODES = new Set(["conflicting_evidence", "subjective_usefulness", "insufficient_context", "suspected_factual_error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function evidenceIds(value: unknown) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 5 && new Set(value).size === value.length && value.every((item) => typeof item === "string" && OUTPUT_ID.test(item));
}

function validAgentOutput(value: unknown) {
  if (!isRecord(value) || !exactKeys(value, ["scores", "strengths", "weaknesses", "proposals", "humanReview"])) return false;
  if (!isRecord(value.scores) || !exactKeys(value.scores, Object.keys(SCORE_LIMITS))) return false;
  for (const [key, maximum] of Object.entries(SCORE_LIMITS)) {
    const item = value.scores[key];
    if (!isRecord(item) || !exactKeys(item, ["score", "reason", "evidenceIds"]) || !Number.isInteger(item.score) || Number(item.score) < 0 || Number(item.score) > maximum || !boundedText(item.reason, 200) || !evidenceIds(item.evidenceIds)) return false;
  }
  const seenCodes = new Set<string>();
  for (const category of ["strengths", "weaknesses", "proposals"] as const) {
    const items = value[category];
    if (!Array.isArray(items) || items.length > 3) return false;
    for (const item of items) {
      if (!isRecord(item) || !exactKeys(item, ["issueCode", "subjectKind", "subjectId", "explanation", "evidenceIds"]) || typeof item.issueCode !== "string" || !FINDING_CODES[category].has(item.issueCode) || seenCodes.has(item.issueCode) || typeof item.subjectKind !== "string" || !SUBJECT_KINDS.has(item.subjectKind) || typeof item.subjectId !== "string" || !OUTPUT_ID.test(item.subjectId) || !boundedText(item.explanation, 240) || !evidenceIds(item.evidenceIds)) return false;
      seenCodes.add(item.issueCode);
    }
  }
  if (value.humanReview === null) return true;
  return isRecord(value.humanReview)
    && exactKeys(value.humanReview, ["uncertaintyCode", "question", "evidenceIds"])
    && typeof value.humanReview.uncertaintyCode === "string"
    && UNCERTAINTY_CODES.has(value.humanReview.uncertaintyCode)
    && boundedText(value.humanReview.question, 240)
    && evidenceIds(value.humanReview.evidenceIds);
}

async function callOpenAI(fetchImpl: FetchLike, apiKey: string, clientRequestId: string, body: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "X-Client-Request-Id": clientRequestId },
      body: JSON.stringify(body),
    });
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) throw new ProviderHttpError(response.status, requestId, await providerHttpErrorCode(response));
    let value: unknown;
    try { value = await response.json(); } catch { throw new ProviderResultError("provider-invalid-json", null, requestId); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderResultError("provider-invalid-response", null, requestId);
    const result = value as Record<string, unknown>;
    const responseId = typeof result.id === "string" && result.id ? result.id : null;
    const measuredUsage = usage(result.usage);
    if (result.status !== "completed") throw new ProviderResultError("provider-incomplete", responseId, requestId, measuredUsage);
    const text = outputText(result);
    if (!responseId || !text || !measuredUsage) throw new ProviderResultError(!responseId ? "provider-response-id-missing" : !text ? "provider-output-rejected" : "provider-usage-missing", responseId, requestId, measuredUsage);
    let agentOutput: unknown;
    try { agentOutput = JSON.parse(text); } catch { throw new ProviderResultError("provider-output-invalid-json", responseId, requestId, measuredUsage); }
    if (!validAgentOutput(agentOutput)) throw new ProviderResultError("provider-output-invalid", responseId, requestId, measuredUsage);
    return { responseId, requestId, measuredUsage, agentOutput };
  } finally {
    clearTimeout(timer);
  }
}

function callbackBase(payload: ReportEvaluationPayload, reservationOwner: string, reservation: ReportEvaluationReservation) {
  return {
    action: "terminal" as const,
    evaluatorVersion: payload.evaluatorVersion,
    dispatchAttempt: payload.dispatchAttempt,
    reservationOwner,
    reservationId: reservation.reservationId,
    clientRequestId: reservation.clientRequestId,
    model: REPORT_EVALUATION_MODEL,
    promptVersion: REPORT_EVALUATION_PROMPT_VERSION,
    pricingVersion: REPORT_EVALUATION_PRICING_VERSION,
  };
}

export async function runReportEvaluation(payload: ReportEvaluationPayload, port: ReportEvaluationPort, runtime: ReportEvaluationRuntime) {
  const apiKey = configuredApiKey(runtime.apiKey);
  const randomUUID = runtime.randomUUID || crypto.randomUUID.bind(crypto);
  const reservationOwner = `worker:${randomUUID()}`;
  const clientRequestId = randomUUID();
  const reservation = await port.reserve(payload, reservationOwner, clientRequestId);
  if (reservation.ok === false) return { ok: true, called: false, reason: reservation.code };
  const base = callbackBase(payload, reservationOwner, reservation);
  let requestBody: unknown;
  try {
    requestBody = buildRequest(reservation.canonicalInput);
  } catch {
    await port.terminal(payload.evaluationId, { ...base, status: "agent_rejected", errorCode: "input-contract-rejected", providerResponseId: null, providerRequestId: null, usageStatus: "unknown", usage: null, agentOutput: null });
    return { ok: false, called: false, status: "agent_rejected" as const };
  }
  let callback: ReportEvaluationTerminalCallback;
  try {
    const result = await callOpenAI(runtime.fetchImpl || fetch, apiKey, reservation.clientRequestId, requestBody, runtime.timeoutMs || REPORT_EVALUATION_TIMEOUT_MS);
    const humanReview = (result.agentOutput as Record<string, unknown>).humanReview;
    const status = humanReview === null ? "complete" : "needs_human_review";
    callback = { ...base, status, errorCode: null, providerResponseId: result.responseId, providerRequestId: result.requestId, usageStatus: "known", usage: result.measuredUsage, agentOutput: result.agentOutput };
  } catch (error) {
    if (error instanceof ProviderHttpError || error instanceof ProviderResultError) {
      callback = {
        ...base,
        status: "agent_rejected",
        errorCode: error instanceof ProviderHttpError ? error.errorCode : error.code,
        providerResponseId: error instanceof ProviderResultError ? error.responseId : null,
        providerRequestId: error.requestId,
        usageStatus: error instanceof ProviderResultError && error.measuredUsage ? "known" : "unknown",
        usage: error instanceof ProviderResultError ? error.measuredUsage : null,
        agentOutput: null,
      };
    } else {
      callback = { ...base, status: "call_outcome_unknown", errorCode: "provider-transport-unknown", providerResponseId: null, providerRequestId: null, usageStatus: "unknown", usage: null, agentOutput: null };
    }
  }
  await port.terminal(payload.evaluationId, callback);
  return { ok: callback.status === "complete" || callback.status === "needs_human_review", called: true, status: callback.status };
}
