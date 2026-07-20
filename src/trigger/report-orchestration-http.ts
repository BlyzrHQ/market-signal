import type { ReportOrchestrationPort } from "./report-orchestration-core.ts";
import { parkingProvider } from "../../app/lib/domain-recovery.ts";

type FetchLike = typeof fetch;
const MAX_ACCEPTED_ERROR_BODY_BYTES = 1_000_000;

const PATHS = {
  report: (publicId: string) => `/api/internal/reports/${publicId}`,
  crawl: "/api/crawl",
  brief: "/api/report",
  ads: "/api/ads",
  match: "/api/match",
  enrich: "/api/enrich-products",
} as const;

export const OPERATION_BUDGETS_MS = {
  report: 10_000,
  crawl: 300_000,
  brief: 90_000,
  ads: 90_000,
  match: 90_000,
  enrich: 120_000,
} as const;

// read + crawl-start + crawl + crawl-complete + longest parallel lane
// (matching-start + two match calls + enrichment-start + enrichment +
// enrichment-complete + matching-complete) + final save.
export const WORST_CASE_CRITICAL_PATH_MS = (OPERATION_BUDGETS_MS.report * 8)
  + OPERATION_BUDGETS_MS.crawl
  + (OPERATION_BUDGETS_MS.match * 2)
  + OPERATION_BUDGETS_MS.enrich;

export class OrchestrationHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(operation: string, status = 0, retryable = false) {
    super(status ? `${operation} request failed with HTTP ${status}.` : `${operation} request could not be completed.`);
    this.name = "OrchestrationHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

function origin(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error();
    return parsed.origin;
  } catch {
    throw new Error("MARKET_SIGNAL_APP_ORIGIN must be an HTTPS origin without a path or credentials.");
  }
}

function callbackToken(value: string) {
  if (!value || value.length < 32 || /\s/.test(value)) throw new Error("MARKET_SIGNAL_CALLBACK_TOKEN is not configured correctly.");
  return value;
}

export function isRetryableHttpStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readBoundedText(response: Response, maxBytes = MAX_ACCEPTED_ERROR_BODY_BYTES) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function acceptedParkedDomainResponse(response: Response, expectedPrimaryDomain: string) {
  if (response.status !== 409 || !/application\/json/i.test(response.headers.get("content-type") || "")) return undefined;
  const text = await readBoundedText(response);
  if (text === null) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const payload = record(value);
  const document = record(payload?.document);
  const blocks = Array.isArray(document?.blocks) ? document.blocks.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const domainStatus = blocks.find((item) => item.type === "domain-status" && item.status === "parked");
  const sourceGap = blocks.find((item) => item.type === "gap" && item.domain === expectedPrimaryDomain && typeof item.url === "string" && /^https:\/\//i.test(item.url) && typeof item.reason === "string" && typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt)));
  const redirectDomain = typeof domainStatus?.redirectDomain === "string" ? domainStatus.redirectDomain : "";
  const classifiedProvider = parkingProvider(redirectDomain);
  if (payload?.ok !== false
    || payload.code !== "parked-domain"
    || payload.primaryDomain !== expectedPrimaryDomain
    || typeof payload.error !== "string"
    || !payload.error.trim()
    || domainStatus?.domain !== expectedPrimaryDomain
    || typeof domainStatus.observedAt !== "string"
    || !Number.isFinite(Date.parse(domainStatus.observedAt))
    || typeof domainStatus.provider !== "string"
    || !classifiedProvider
    || domainStatus.provider !== classifiedProvider
    || typeof domainStatus.evidenceUrl !== "string"
    || !/^https:\/\//i.test(domainStatus.evidenceUrl)
    || sourceGap?.url !== domainStatus.evidenceUrl
    || !sourceGap) return undefined;
  return value;
}

async function requestJson(fetchImpl: FetchLike, url: string, token: string, operation: string, timeoutMs: number, body?: unknown, acceptError?: (response: Response) => Promise<unknown | undefined>) {
  const deadline = Date.now() + timeoutMs;
  for (let requestAttempt = 1; requestAttempt <= 2; requestAttempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new OrchestrationHttpError(operation, 0, true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.ok) return await response.json() as unknown;
      const accepted = acceptError ? await acceptError(response) : undefined;
      if (accepted !== undefined) return accepted;
      const retryable = isRetryableHttpStatus(response.status);
      if (!retryable || requestAttempt === 2) throw new OrchestrationHttpError(operation, response.status, retryable);
    } catch (error) {
      if (error instanceof OrchestrationHttpError) throw error;
      if (requestAttempt === 2) throw new OrchestrationHttpError(operation, 0, true);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new OrchestrationHttpError(operation, 0, true);
}

function requiredObject<T>(value: unknown, operation: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrchestrationHttpError(operation, 502, true);
  return value as T;
}

export function createReportOrchestrationHttpPort(configuration: { appOrigin: string; callbackToken: string; fetchImpl?: FetchLike }): ReportOrchestrationPort {
  const appOrigin = origin(configuration.appOrigin);
  const token = callbackToken(configuration.callbackToken);
  const fetchImpl = configuration.fetchImpl || fetch;
  const call = (path: string, operation: string, timeoutMs: number, body?: unknown) => requestJson(fetchImpl, new URL(path, appOrigin).toString(), token, operation, timeoutMs, body);

  return {
    async loadReport(publicId) {
      try {
        const payload = requiredObject<{ ok?: boolean; report?: unknown }>(await call(PATHS.report(publicId), "Stored report read", OPERATION_BUDGETS_MS.report), "Stored report read");
        if (payload.ok !== true) return null;
        return requiredObject<Awaited<ReturnType<ReportOrchestrationPort["loadReport"]>>>(payload.report, "Stored report read");
      } catch (error) {
        if (error instanceof OrchestrationHttpError && error.status === 404) return null;
        throw error;
      }
    },
    async appendEvent(publicId, reportEvent) {
      const payload = requiredObject<{ ok?: boolean }>(await call(PATHS.report(publicId), "Report progress callback", OPERATION_BUDGETS_MS.report, { action: "event", ...reportEvent }), "Report progress callback");
      if (payload.ok !== true) throw new OrchestrationHttpError("Report progress callback", 502, true);
    },
    async crawl(input) {
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["crawl"]>>>(await requestJson(fetchImpl, new URL(PATHS.crawl, appOrigin).toString(), token, "Public crawl", OPERATION_BUDGETS_MS.crawl, input, (response) => acceptedParkedDomainResponse(response, input.primary)), "Public crawl");
      if (payload.ok !== true && payload.code !== "parked-domain") throw new OrchestrationHttpError("Public crawl", 422, false);
      return payload;
    },
    async brief(input) {
      return await call(PATHS.brief, "Market brief", OPERATION_BUDGETS_MS.brief, input);
    },
    async ads(input) {
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["ads"]>>>(await call(PATHS.ads, "Ad intelligence", OPERATION_BUDGETS_MS.ads, input), "Ad intelligence");
      if (payload.ok !== true) throw new OrchestrationHttpError("Ad intelligence", 422, false);
      return payload;
    },
    async match(input) {
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["match"]>>>(await call(PATHS.match, "Product matching", OPERATION_BUDGETS_MS.match, input), "Product matching");
      if (payload.ok !== true) throw new OrchestrationHttpError("Product matching", 422, false);
      return payload;
    },
    async enrich(input) {
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["enrich"]>>>(await call(PATHS.enrich, "Product enrichment", OPERATION_BUDGETS_MS.enrich, input), "Product enrichment");
      if (payload.ok !== true) throw new OrchestrationHttpError("Product enrichment", 422, false);
      return payload;
    },
    async saveDocument(publicId, input) {
      const payload = requiredObject<{ ok?: boolean }>(await call(PATHS.report(publicId), "Completed report callback", OPERATION_BUDGETS_MS.report, { action: "document", ...input }), "Completed report callback");
      if (payload.ok !== true) throw new OrchestrationHttpError("Completed report callback", 502, true);
    },
  };
}
