import type { D1DatabaseLike, StoredReportSnapshot } from "./report-store.ts";
import { getStoredReport, importStoredReportSnapshot } from "./report-store.ts";
import { runtimeEnvironmentValue } from "./runtime-env.ts";

const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_LEGACY_RESPONSE_BYTES = 1_000_000;
const LEGACY_TIMEOUT_MS = 10_000;
const inFlight = new Map<string, Promise<Awaited<ReturnType<typeof getStoredReport>>>>();

type RecoveryOptions = {
  now?: Date;
  requestUrl?: string;
  fetchImpl?: typeof fetch;
  database?: D1DatabaseLike | null;
  enabled?: string;
  baseUrl?: string;
  sunsetAt?: string;
};

function legacyOrigin(value: string, requestUrl = "") {
  try {
    const url = new URL(value);
    const requestOrigin = requestUrl ? new URL(requestUrl).origin : "";
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname || !["", "/"].includes(url.pathname) || url.origin === requestOrigin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_LEGACY_RESPONSE_BYTES) throw new Error("Legacy report response is too large.");
  if (!response.body) throw new Error("Legacy report response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_LEGACY_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Legacy report response is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

function snapshotFromPayload(payload: Record<string, unknown>, publicId: string, now: Date): StoredReportSnapshot {
  const report = payload.report as Record<string, unknown> | null;
  const run = report?.run as Record<string, unknown> | null;
  const expiresAt = Date.parse(String(run?.expiresAt || ""));
  if (payload.ok !== true || !report || !run || run.publicId !== publicId || !["complete", "limited"].includes(String(run.status)) || run.currentPhase !== "complete" || Number(report.documentSchemaVersion) !== 1 || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw new Error("Legacy report payload failed validation.");
  return report as unknown as StoredReportSnapshot;
}

export async function recoverLegacyReport(publicId: string, options: RecoveryOptions = {}) {
  if (!PUBLIC_ID_PATTERN.test(publicId)) throw new Error("Invalid report id.");
  const now = options.now || new Date();
  const enabled = await runtimeEnvironmentValue("MARKET_SIGNAL_LEGACY_REPORT_RECOVERY_ENABLED", options.enabled);
  const baseValue = await runtimeEnvironmentValue("MARKET_SIGNAL_LEGACY_REPORT_BASE_URL", options.baseUrl);
  const sunsetValue = await runtimeEnvironmentValue("MARKET_SIGNAL_LEGACY_REPORT_SUNSET_AT", options.sunsetAt);
  const sunset = Date.parse(sunsetValue);
  const origin = legacyOrigin(baseValue, options.requestUrl);
  if (enabled !== "true" || !origin || !Number.isFinite(sunset) || now.getTime() >= sunset) return null;
  const local = await getStoredReport(publicId, now, options.database);
  if (local) return local;
  const existing = inFlight.get(publicId);
  if (existing) return existing;

  const recovery = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LEGACY_TIMEOUT_MS);
    try {
      const response = await (options.fetchImpl || fetch)(`${origin}/api/reports/${publicId}`, { headers: { accept: "application/json" }, cache: "no-store", redirect: "error", signal: controller.signal });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw new Error("Legacy report origin is unavailable.");
      const payload = await boundedJson(response);
      const snapshot = snapshotFromPayload(payload, publicId, now);
      return await importStoredReportSnapshot(snapshot, now, options.database);
    } finally {
      clearTimeout(timeout);
    }
  })();
  inFlight.set(publicId, recovery);
  try { return await recovery; } finally { inFlight.delete(publicId); }
}
