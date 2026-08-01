import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import { runtimeEnvironmentValue } from "../../../lib/runtime-env.ts";
import {
  acknowledgeDispatch,
  beginJudging,
  claimDispatches,
  complete,
  dryRunBacklog,
  lease,
  markAmbiguousDispatch,
  prepare,
  reject,
  type CompleteInput,
  type RejectInput,
  type ReportEvaluationLease,
} from "../../../lib/report-evaluation-service.ts";
import type { ReportEvaluationPayload } from "../../../../src/shared/report-evaluation-contract.ts";

const MAX_EVALUATION_BODY_BYTES = 128 * 1024;

type EvaluationServices = {
  lease(payload: ReportEvaluationPayload): Promise<unknown>;
  prepare(workerLease: ReportEvaluationLease): Promise<unknown>;
  beginJudging(workerLease: ReportEvaluationLease, packetHash: string): Promise<unknown>;
  complete(input: CompleteInput): Promise<unknown>;
  reject(input: RejectInput): Promise<unknown>;
  claimDispatches(limit: number, evaluationId?: string): Promise<unknown>;
  acknowledgeDispatch(payload: ReportEvaluationPayload, runId: string): Promise<unknown>;
  markAmbiguousDispatch(payload: ReportEvaluationPayload): Promise<unknown>;
  dryRunBacklog(): Promise<unknown>;
};

const liveServices: EvaluationServices = {
  lease: (payload) => lease(payload),
  prepare: (workerLease) => prepare(workerLease),
  beginJudging: (workerLease, packetHash) => beginJudging(workerLease, packetHash),
  complete: (input) => complete(input),
  reject: (input) => reject(input),
  claimDispatches: (limit, evaluationId) => claimDispatches(limit, evaluationId),
  acknowledgeDispatch: (payload, runId) => acknowledgeDispatch(payload, runId),
  markAmbiguousDispatch: (payload) => markAmbiguousDispatch(payload),
  dryRunBacklog: () => dryRunBacklog(),
};

async function boundedJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (!request.body || declared > MAX_EVALUATION_BODY_BYTES) throw new Error("Invalid evaluation request.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_EVALUATION_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Invalid evaluation request.");
    }
    json += decoder.decode(value, { stream: true });
  }
  const parsed = JSON.parse(json + decoder.decode()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid evaluation request.");
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Evaluation request contains unsupported fields.");
  }
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid evaluation request.");
  return value as Record<string, unknown>;
}

const PAYLOAD_KEYS = ["contractVersion", "dispatchGeneration", "dispatchToken", "evaluationId", "evaluatorVersion", "factManifestHash", "inputHash"];
const LEASE_KEYS = [...PAYLOAD_KEYS, "leaseGeneration", "leaseToken"];

function payload(body: Record<string, unknown>) {
  return Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, body[key]])) as ReportEvaluationPayload;
}

function workerLease(body: Record<string, unknown>) {
  return Object.fromEntries(LEASE_KEYS.map((key) => [key, body[key]])) as ReportEvaluationLease;
}

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "The report evaluation request failed.";
  const status = /conflict|binding|lease/i.test(message) ? 409 : /invalid|unsupported|required/i.test(message) ? 400 : 503;
  return Response.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function createEvaluationHandler(expectedToken?: string, services: EvaluationServices = liveServices, expectedCallbackToken?: string) {
  return async function POST(request: Request) {
    const [token, callbackToken] = await Promise.all([
      runtimeEnvironmentValue("MARKET_SIGNAL_EVALUATION_TOKEN", expectedToken),
      runtimeEnvironmentValue("MARKET_SIGNAL_CALLBACK_TOKEN", expectedCallbackToken),
    ]);
    if (!token || (callbackToken && token === callbackToken) || !await hasValidInternalAuthorization(request.headers.get("authorization"), token)) return unauthorizedInternalResponse();
    try {
      const body = await boundedJson(request);
      const action = body.action;
      let result: unknown;
      if (action === "lease") {
        exactKeys(body, ["action", ...PAYLOAD_KEYS]);
        result = await services.lease(payload(body));
      } else if (action === "prepare") {
        exactKeys(body, ["action", ...LEASE_KEYS]);
        result = await services.prepare(workerLease(body));
      } else if (action === "begin-judging") {
        exactKeys(body, ["action", ...LEASE_KEYS, "packetHash"]);
        if (typeof body.packetHash !== "string") throw new Error("Invalid evaluation packet hash.");
        result = await services.beginJudging(workerLease(body), body.packetHash);
      } else if (action === "complete") {
        exactKeys(body, ["action", ...LEASE_KEYS, "packetHash", "model", "judge", "hybrid", "usage"]);
        result = await services.complete({
          lease: workerLease(body),
          packetHash: body.packetHash as string,
          model: body.model as string,
          judge: body.judge,
          hybrid: body.hybrid,
          usage: object(body.usage) as CompleteInput["usage"],
        });
      } else if (action === "reject") {
        exactKeys(body, body.usage === undefined
          ? ["action", ...LEASE_KEYS, "packetHash", "phase", "errorCode"]
          : ["action", ...LEASE_KEYS, "packetHash", "phase", "errorCode", "usage"]);
        result = await services.reject({
          lease: workerLease(body),
          packetHash: body.packetHash as string,
          phase: body.phase as RejectInput["phase"],
          errorCode: body.errorCode as string,
          ...(body.usage === undefined ? {} : { usage: object(body.usage) as NonNullable<RejectInput["usage"]> }),
        });
      } else if (action === "claim-dispatches") {
        const keys = body.evaluationId === undefined ? ["action", "limit"] : ["action", "evaluationId", "limit"];
        exactKeys(body, keys);
        if (!Number.isInteger(body.limit)) throw new Error("Invalid evaluation dispatch claim limit.");
        if (body.evaluationId !== undefined && typeof body.evaluationId !== "string") throw new Error("Invalid evaluation id.");
        result = await services.claimDispatches(Number(body.limit), body.evaluationId as string | undefined);
      } else if (action === "acknowledge-dispatch") {
        exactKeys(body, ["action", ...PAYLOAD_KEYS, "runId"]);
        if (typeof body.runId !== "string") throw new Error("Invalid Trigger run id.");
        result = await services.acknowledgeDispatch(payload(body), body.runId);
      } else if (action === "ambiguous-dispatch") {
        exactKeys(body, ["action", ...PAYLOAD_KEYS]);
        result = await services.markAmbiguousDispatch(payload(body));
      } else if (action === "dry-run-backlog") {
        exactKeys(body, ["action"]);
        result = await services.dryRunBacklog();
      } else {
        throw new Error("Unsupported evaluation action.");
      }
      const response = action === "claim-dispatches"
        ? { ok: true, claims: result }
        : { ok: true, ...object(result) };
      return Response.json(response, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return routeError(error);
    }
  };
}

export const POST = createEvaluationHandler();
