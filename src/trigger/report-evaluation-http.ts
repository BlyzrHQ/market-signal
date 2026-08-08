import {
  REPORT_EVALUATION_CAPABILITY,
  type ReportEvaluationReservation,
  type ReportEvaluationReservationDeclined,
} from "../shared/report-evaluation-contract.ts";
import { parseWorkerApiManifest } from "../shared/worker-api-contract.ts";
import type { ReportEvaluationPort } from "./report-evaluation-core.ts";

type FetchLike = typeof fetch;
const HTTP_TIMEOUT_MS = 30_000;

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("MARKET_SIGNAL_APP_ORIGIN must be an HTTPS origin without a path or credentials.");
  return url.origin;
}

function configuredToken(value: string) {
  if (!value || value.length < 32 || /\s/.test(value)) throw new Error("MARKET_SIGNAL_CALLBACK_TOKEN is not configured correctly.");
  return value;
}

async function requestJson(fetchImpl: FetchLike, url: string, token: string, method: "GET" | "POST", body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")) throw new Error(`Evaluation worker API request failed with HTTP ${response.status}.`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evaluation worker API returned an invalid response.");
  return value as Record<string, unknown>;
}

export function createReportEvaluationHttpPort(configuration: { appOrigin: string; callbackToken: string; fetchImpl?: FetchLike }): ReportEvaluationPort & { preflight(): Promise<void> } {
  const appOrigin = configuredOrigin(configuration.appOrigin);
  const token = configuredToken(configuration.callbackToken);
  const fetchImpl = configuration.fetchImpl || fetch;
  return {
    async preflight() {
      const manifest = parseWorkerApiManifest(await requestJson(fetchImpl, `${appOrigin}/api/internal/capabilities`, token, "GET"));
      if (!manifest.capabilities.includes(REPORT_EVALUATION_CAPABILITY)) throw new Error("The application does not support report evaluation execution.");
    },
    async reserve(payload, reservationOwner, clientRequestId) {
      const value = object(await requestJson(fetchImpl, `${appOrigin}/api/internal/evaluations/${encodeURIComponent(payload.evaluationId)}`, token, "POST", {
        action: "reserve",
        evaluatorVersion: payload.evaluatorVersion,
        dispatchAttempt: payload.dispatchAttempt,
        reservationOwner,
        clientRequestId,
      }));
      if (value.ok === false && ["already_reserved", "terminal", "stale_attempt", "ineligible"].includes(String(value.code))) return { ok: false, code: value.code } as ReportEvaluationReservationDeclined;
      if (value.ok !== true || typeof value.reservationId !== "string" || !value.reservationId || value.clientRequestId !== clientRequestId || typeof value.canonicalInput !== "string" || !value.canonicalInput) throw new Error("Evaluation reservation response is invalid.");
      return value as ReportEvaluationReservation;
    },
    async terminal(evaluationId, callback) {
      const value = object(await requestJson(fetchImpl, `${appOrigin}/api/internal/evaluations/${encodeURIComponent(evaluationId)}`, token, "POST", callback));
      if (value.ok !== true) throw new Error("Evaluation terminal callback was not accepted.");
    },
  };
}
