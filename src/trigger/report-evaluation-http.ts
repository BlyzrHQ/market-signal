import type { ReportAgentPacket } from "../../app/lib/report-agent-judge.ts";
import { REPORT_EVALUATION_CAPABILITIES, type ReportEvaluationPayload } from "../shared/report-evaluation-contract.ts";
import { parseWorkerApiManifest } from "../shared/worker-api-contract.ts";
import type {
  EvaluationDispatchPort,
  EvaluationLease,
  EvaluationWorkerPort,
  PreparedEvaluation,
} from "./report-evaluation-core.ts";

type FetchLike = typeof fetch;
const APPLICATION_RESPONSE_LIMIT = 128 * 1024;
const APPLICATION_REQUEST_LIMIT = 128 * 1024;
const APPLICATION_TIMEOUT_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;

const PATHS = {
  capabilities: "/api/internal/capabilities",
  evaluations: "/api/internal/evaluations",
  responses: "https://api.openai.com/v1/responses",
} as const;

export class ReportEvaluationHttpError extends Error {
  readonly status: number;

  constructor(operation: string, status = 0) {
    super(status ? `${operation} failed with HTTP ${status}.` : `${operation} could not be completed.`);
    this.name = "ReportEvaluationHttpError";
    this.status = status;
  }
}

function configuredOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new Error("MARKET_SIGNAL_APP_ORIGIN must be an HTTPS origin without a path or credentials.");
  }
}

function configuredEvaluationToken(value: string) {
  if (!value || value.length < 32 || value.length > 512 || /\s/.test(value)) throw new Error("MARKET_SIGNAL_EVALUATION_TOKEN is not configured correctly.");
  return value;
}

function configuredOpenAIKey(value: string) {
  if (!value || value.length < 20 || value.length > 512 || /\s/.test(value)) throw new Error("OPENAI_API_KEY is not configured correctly.");
  return value;
}

async function readBoundedJson(response: Response, limit: number, operation: string) {
  if (!/application\/json/i.test(response.headers.get("content-type") || "")) throw new ReportEvaluationHttpError(operation, response.status || 502);
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) throw new ReportEvaluationHttpError(operation, 502);
  if (!response.body) throw new ReportEvaluationHttpError(operation, 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ReportEvaluationHttpError(operation, 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ReportEvaluationHttpError) throw error;
    throw new ReportEvaluationHttpError(operation, 502);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReportEvaluationHttpError(operation, 502);
  }
}

function boundedBody(value: unknown, operation: string) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > APPLICATION_REQUEST_LIMIT) throw new ReportEvaluationHttpError(operation, 413);
  return body;
}

async function requestJson(input: {
  fetchImpl: FetchLike;
  url: string;
  token: string;
  operation: string;
  timeoutMs?: number;
  body?: unknown;
  responseLimit?: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs || APPLICATION_TIMEOUT_MS);
  try {
    const response = await input.fetchImpl(input.url, {
      method: input.body === undefined ? "GET" : "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: boundedBody(input.body, input.operation) }),
    });
    if (!response.ok) throw new ReportEvaluationHttpError(input.operation, response.status);
    return await readBoundedJson(response, input.responseLimit || APPLICATION_RESPONSE_LIMIT, input.operation);
  } catch (error) {
    if (error instanceof ReportEvaluationHttpError) throw error;
    throw new ReportEvaluationHttpError(input.operation);
  } finally {
    clearTimeout(timeout);
  }
}

function object(value: unknown, operation: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportEvaluationHttpError(operation, 502);
  return value as Record<string, unknown>;
}

function assertOk(value: unknown, operation: string) {
  const result = object(value, operation);
  if (result.ok !== true) throw new ReportEvaluationHttpError(operation, 502);
  return result;
}

function createApplicationClient(configuration: { appOrigin: string; evaluationToken: string; fetchImpl?: FetchLike }) {
  const appOrigin = configuredOrigin(configuration.appOrigin);
  const token = configuredEvaluationToken(configuration.evaluationToken);
  const fetchImpl = configuration.fetchImpl || fetch;
  const call = (operation: string, body?: unknown, timeoutMs?: number) => requestJson({
    fetchImpl,
    url: new URL(PATHS.evaluations, appOrigin).toString(),
    token,
    operation,
    body,
    timeoutMs,
  });
  return {
    async preflight() {
      const manifest = parseWorkerApiManifest(await requestJson({
        fetchImpl,
        url: new URL(PATHS.capabilities, appOrigin).toString(),
        token,
        operation: "Evaluation capability preflight",
      }));
      if (REPORT_EVALUATION_CAPABILITIES.some((capability) => !manifest.capabilities.includes(capability))) {
        throw new Error("The application does not support report evaluation.");
      }
    },
    call,
  };
}

export function createReportEvaluationHttpPort(configuration: {
  appOrigin: string;
  evaluationToken: string;
  openaiApiKey: string;
  fetchImpl?: FetchLike;
}): EvaluationWorkerPort {
  const client = createApplicationClient(configuration);
  const fetchImpl = configuration.fetchImpl || fetch;
  const openaiApiKey = configuredOpenAIKey(configuration.openaiApiKey);
  return {
    preflight: client.preflight,
    async lease(payload) {
      const result = assertOk(await client.call("Evaluation lease", { action: "lease", ...payload }), "Evaluation lease");
      if (result.accepted !== true) return { accepted: false, state: typeof result.state === "string" ? result.state : "unavailable" };
      return { accepted: true, leaseToken: String(result.leaseToken || ""), leaseGeneration: Number(result.leaseGeneration) };
    },
    async prepare(lease) {
      const result = assertOk(await client.call("Evaluation preparation", { action: "prepare", ...lease }, PREPARE_TIMEOUT_MS), "Evaluation preparation");
      if (result.accepted !== true) return { accepted: false, state: typeof result.state === "string" ? result.state : "unavailable" };
      const prepared = object(result.prepared, "Evaluation preparation");
      const packet = object(prepared.packet, "Evaluation preparation") as ReportAgentPacket;
      if (!Array.isArray(packet.evidence) || !Array.isArray(packet.candidates) || !Array.isArray(packet.gaps)) throw new ReportEvaluationHttpError("Evaluation preparation", 502);
      return {
        accepted: true,
        prepared: {
          model: String(prepared.model || ""),
          packetHash: String(prepared.packetHash || ""),
          packet,
          deterministicProfile: prepared.deterministicProfile,
        } satisfies PreparedEvaluation,
      };
    },
    async beginJudging(lease, packetHash) {
      const result = assertOk(await client.call("Evaluation judging barrier", { action: "begin-judging", ...lease, packetHash }), "Evaluation judging barrier");
      return { accepted: result.accepted === true, state: typeof result.state === "string" ? result.state : "unavailable" };
    },
    async requestJudge(input) {
      return requestJson({
        fetchImpl,
        url: PATHS.responses,
        token: openaiApiKey,
        operation: "Bounded evaluator request",
        timeoutMs: input.timeoutMs,
        body: input.body,
        responseLimit: input.responseByteLimit,
      });
    },
    async commitAccepted(input) {
      const result = assertOk(await client.call("Evaluation result commit", { action: "complete", ...input.lease, packetHash: input.packetHash, model: input.model, judge: input.judge, hybrid: input.hybrid, usage: input.usage }), "Evaluation result commit");
      if (result.accepted !== true || result.state !== "complete") throw new ReportEvaluationHttpError("Evaluation result commit", 409);
    },
    async commitRejected(input) {
      const result = assertOk(await client.call("Evaluation rejection commit", { action: "reject", ...input.lease, packetHash: input.packetHash, phase: input.phase, errorCode: input.errorCode, ...(input.usage ? { usage: input.usage } : {}) }), "Evaluation rejection commit");
      if (result.accepted !== true || result.state !== "agent_rejected") throw new ReportEvaluationHttpError("Evaluation rejection commit", 409);
    },
  };
}

export function createReportEvaluationDispatchHttpPort(configuration: {
  appOrigin: string;
  evaluationToken: string;
  fetchImpl?: FetchLike;
}): EvaluationDispatchPort {
  const client = createApplicationClient(configuration);
  return {
    preflight: client.preflight,
    async claim(limit, evaluationId) {
      const result = assertOk(await client.call("Evaluation dispatch claim", { action: "claim-dispatches", limit, ...(evaluationId ? { evaluationId } : {}) }), "Evaluation dispatch claim");
      if (!Array.isArray(result.claims)) throw new ReportEvaluationHttpError("Evaluation dispatch claim", 502);
      return result.claims;
    },
    async acknowledge(payload: ReportEvaluationPayload, runId: string) {
      assertOk(await client.call("Evaluation dispatch acknowledgement", { action: "acknowledge-dispatch", ...payload, runId }), "Evaluation dispatch acknowledgement");
    },
    async ambiguous(payload: ReportEvaluationPayload) {
      assertOk(await client.call("Evaluation ambiguous dispatch", { action: "ambiguous-dispatch", ...payload }), "Evaluation ambiguous dispatch");
    },
  };
}

export type { EvaluationLease };
