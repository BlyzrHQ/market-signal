import { REPORT_SEARCH_CHALLENGE_CAPABILITY, type ReportSearchChallengeReservation, type ReportSearchChallengeReservationDeclined } from "../shared/report-search-challenge-contract.ts";
import { parseWorkerApiManifest } from "../shared/worker-api-contract.ts";
import type { ReportSearchChallengePort } from "./report-search-challenge-core.ts";

type FetchLike = typeof fetch;
function origin(value: string) { const url = new URL(value); if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("MARKET_SIGNAL_APP_ORIGIN must be an HTTPS origin."); return url.origin; }
function token(value: string) { if (!value || value.length < 32 || /\s/.test(value)) throw new Error("MARKET_SIGNAL_CALLBACK_TOKEN is not configured correctly."); return value; }
function object(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Search challenge worker API returned an invalid response."); return value as Record<string, unknown>; }
async function json(fetchImpl: FetchLike, url: string, authorization: string, method: "GET" | "POST", body?: unknown) {
  const response = await fetchImpl(url, { method, headers: { Accept: "application/json", Authorization: `Bearer ${authorization}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")) throw new Error(`Search challenge worker API request failed with HTTP ${response.status}.`);
  return await response.json() as unknown;
}
export function createReportSearchChallengeHttpPort(configuration: { appOrigin: string; callbackToken: string; fetchImpl?: FetchLike }): ReportSearchChallengePort & { preflight(): Promise<void> } {
  const appOrigin = origin(configuration.appOrigin); const authorization = token(configuration.callbackToken); const fetchImpl = configuration.fetchImpl || fetch;
  return {
    async preflight() { const manifest = parseWorkerApiManifest(await json(fetchImpl, `${appOrigin}/api/internal/capabilities`, authorization, "GET")); if (!manifest.capabilities.includes(REPORT_SEARCH_CHALLENGE_CAPABILITY)) throw new Error("The application does not support report search challenges."); },
    async reserve(payload, reservationOwner, clientRequestId) {
      const value = object(await json(fetchImpl, `${appOrigin}/api/internal/search-challenges/${encodeURIComponent(payload.challengeId)}`, authorization, "POST", { action: "reserve", challengerVersion: payload.challengerVersion, dispatchAttempt: payload.dispatchAttempt, reservationOwner, clientRequestId }));
      if (value.ok === false && ["already_reserved", "terminal", "stale_attempt", "ineligible"].includes(String(value.code))) return value as ReportSearchChallengeReservationDeclined;
      if (value.ok !== true || typeof value.reservationId !== "string" || value.clientRequestId !== clientRequestId || typeof value.canonicalInput !== "string") throw new Error("Search challenge reservation response is invalid.");
      return value as ReportSearchChallengeReservation;
    },
    async terminal(challengeId, callback) { const value = object(await json(fetchImpl, `${appOrigin}/api/internal/search-challenges/${encodeURIComponent(challengeId)}`, authorization, "POST", callback)); if (value.ok !== true) throw new Error("Search challenge terminal callback was not accepted."); },
  };
}
