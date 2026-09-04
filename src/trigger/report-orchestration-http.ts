import { MAX_FINAL_ENRICHMENT_BATCHES, MAX_FINAL_ENRICHMENT_BATCH_WAVES, MAX_RIVAL_BENCHMARK_DOMAINS, RIVAL_BENCHMARK_CONCURRENCY, type ReportOrchestrationPort } from "./report-orchestration-core.ts";
import { parkingProvider } from "../../app/lib/domain-recovery.ts";
import { MAX_REPORT_ATTEMPTS, MAX_REPORT_MATCH_CHECKPOINTS_PER_ATTEMPT, PermanentOrchestrationError } from "../shared/report-orchestration-contract.ts";
import { parseWorkerApiManifest, WorkerApiContractError } from "../shared/worker-api-contract.ts";
import { compactTerminalReportDocument, encodedJsonBytes, REPORT_CALLBACK_ENVELOPE_BYTES } from "../shared/report-document-compaction.ts";
import { MAX_REPORT_FACT_CHUNKS } from "../shared/report-facts.ts";
import { Agent, fetch as undiciFetch } from "undici";

type FetchLike = typeof fetch;
const MAX_ACCEPTED_ERROR_BODY_BYTES = 1_000_000;
export const MAX_SUCCESS_BODY_BYTES = 64 * 1_024 * 1_024;

export function checkpointReadPageBound(attemptNumber: number, pageLimit: number, batchIndexStart?: number, batchIndexEnd?: number, latestPerBatch = false) {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > MAX_REPORT_ATTEMPTS || !Number.isSafeInteger(pageLimit) || pageLimit < 1) throw new Error("Invalid checkpoint paging bound.");
  if (latestPerBatch) {
    if (!Number.isSafeInteger(batchIndexStart) || !Number.isSafeInteger(batchIndexEnd) || Number(batchIndexStart) < 0 || Number(batchIndexEnd) < Number(batchIndexStart)) throw new Error("Invalid checkpoint paging range.");
    return Math.ceil((Number(batchIndexEnd) - Number(batchIndexStart) + 1) / pageLimit) + 1;
  }
  return Math.ceil((attemptNumber * MAX_REPORT_MATCH_CHECKPOINTS_PER_ATTEMPT) / pageLimit) + 1;
}

// Node's built-in fetch gives up while waiting for response headers after five
// minutes, independently of a longer AbortSignal. Discovery and matching are
// The crawl can search 200 products and verify the complete bounded seller
// evidence set. Keep Undici above its 2,400-second deadline while Caddy remains
// the outermost 2,460-second boundary.
export const ORCHESTRATION_FETCH_TIMEOUT_MS = 2_410_000;

export function createOrchestrationFetch(timeoutMs = ORCHESTRATION_FETCH_TIMEOUT_MS) {
  const boundedTimeout = Math.max(1_000, Math.floor(timeoutMs));
  const dispatcher = new Agent({ headersTimeout: boundedTimeout, bodyTimeout: boundedTimeout });
  const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Response;
  }) as FetchLike & { close: () => Promise<void> };
  fetchImpl.close = async () => { await dispatcher.close(); };
  return fetchImpl;
}

const orchestrationFetch = createOrchestrationFetch();

function stableCheckpointValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCheckpointValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableCheckpointValue(item)]));
}

function sameCheckpointValue(left: unknown, right: unknown) {
  return JSON.stringify(stableCheckpointValue(left)) === JSON.stringify(stableCheckpointValue(right));
}

const PATHS = {
  capabilities: "/api/internal/capabilities",
  report: (publicId: string) => `/api/internal/reports/${publicId}`,
  crawl: "/api/crawl",
  brief: "/api/report",
  match: "/api/match",
  enrich: "/api/enrich-products",
  actions: "/api/actions",
} as const;

export const OPERATION_BUDGETS_MS = {
  preflight: 10_000,
  report: 10_000,
  factCallback: 2_000,
  crawl: 2_400_000,
  rivalBenchmark: 90_000,
  brief: 90_000,
  match: 750_000,
  matchRepair: 240_000,
  enrich: 120_000,
  actions: 35_000,
} as const;

export const MAX_REPORT_FACT_CALLBACKS = MAX_REPORT_FACT_CHUNKS;
// The ordinary path reads the 270..1399 state range (57 pages plus terminal
// empty page) and then refreshes one 250-slot judge namespace (13 pages plus
// terminal empty page). The initial judge/state reads are parallel.
export const MAX_BOUNDED_CHECKPOINT_READ_PAGES_ON_CRITICAL_PATH = 72;

// Read + preflight + crawl events + crawl + longest parallel lane
// (matching-start + two bounded match calls, where the second replays durable
// judge checkpoints and only requests missing work, + enrichment-start + bounded
// three bounded quality-repair calls, +
// bounded range-projected durable-checkpoint reads + enrichment batch waves and their bounded
// save/ambiguous-save recovery callbacks +
// enrichment-complete + actions-start + actions + actions-complete +
// matching-complete) + bounded relational-fact chunks, manifest, and final save.
export const WORST_CASE_CRITICAL_PATH_MS = (OPERATION_BUDGETS_MS.report * (24 + MAX_BOUNDED_CHECKPOINT_READ_PAGES_ON_CRITICAL_PATH + MAX_FINAL_ENRICHMENT_BATCH_WAVES + (MAX_FINAL_ENRICHMENT_BATCHES * 2)))
  + (OPERATION_BUDGETS_MS.factCallback * (MAX_REPORT_FACT_CALLBACKS + 1))
  + OPERATION_BUDGETS_MS.preflight
  + OPERATION_BUDGETS_MS.crawl
  + (OPERATION_BUDGETS_MS.rivalBenchmark * Math.ceil(MAX_RIVAL_BENCHMARK_DOMAINS / RIVAL_BENCHMARK_CONCURRENCY))
  + (OPERATION_BUDGETS_MS.match * 2)
  + (OPERATION_BUDGETS_MS.matchRepair * 3)
  + (OPERATION_BUDGETS_MS.enrich * MAX_FINAL_ENRICHMENT_BATCH_WAVES)
  + OPERATION_BUDGETS_MS.actions;

export class OrchestrationHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly errorCode: string;

  constructor(operation: string, status = 0, retryable = false, detail = "", errorCode = "") {
    const cleanDetail = detail.replace(/\s+/g, " ").trim().slice(0, 280);
    super(cleanDetail || (status ? `${operation} request failed with HTTP ${status}.` : `${operation} request could not be completed.`));
    this.name = "OrchestrationHttpError";
    this.status = status;
    this.retryable = retryable;
    this.errorCode = errorCode.replace(/[^a-z0-9-]/gi, "").slice(0, 80);
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

const MAX_LEASE_WAIT_RETRIES = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;

function retryAfterMs(value: string | null, nowMs = Date.now()) {
  const retryAfter = (value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(Number(retryAfter) * 1_000)));
  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAt - nowMs));
  return 1_000;
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

export async function acceptedParkedDomainResponse(response: Response, expectedPrimaryDomain: string) {
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

export async function acceptedUnavailableDomainResponse(response: Response, expectedPrimaryDomain: string) {
  if (response.status !== 409 || !/application\/json/i.test(response.headers.get("content-type") || "")) return undefined;
  const text = await readBoundedText(response);
  if (text === null) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const payload = record(value);
  const document = record(payload?.document);
  const blocks = Array.isArray(document?.blocks) ? document.blocks.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const domainStatus = blocks.find((item) => item.type === "domain-status" && item.status === "unavailable");
  const attemptedUrl = typeof domainStatus?.attemptedUrl === "string" ? domainStatus.attemptedUrl : "";
  const sourceGap = blocks.find((item) => item.type === "gap" && item.domain === expectedPrimaryDomain && item.url === attemptedUrl && typeof item.reason === "string" && item.reason.trim() && item.observedAt === domainStatus?.observedAt && typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt)));
  let attemptedDomain = "";
  try {
    const parsed = new URL(attemptedUrl);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return undefined;
    attemptedDomain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch { return undefined; }
  if (payload?.ok !== false
    || payload.code !== "unavailable-domain"
    || payload.primaryDomain !== expectedPrimaryDomain
    || typeof payload.error !== "string"
    || !payload.error.trim()
    || domainStatus?.domain !== expectedPrimaryDomain
    || attemptedDomain !== expectedPrimaryDomain.toLowerCase().replace(/^www\./, "")
    || domainStatus?.attempts !== 2
    || typeof domainStatus.observedAt !== "string"
    || !Number.isFinite(Date.parse(domainStatus.observedAt))
    || sourceGap?.observedAt !== domainStatus.observedAt
    || !sourceGap) return undefined;
  return value;
}

export async function acceptedCrawlFailureError(response: Response, expectedPrimaryDomain: string) {
  if (response.status !== 422 || !/application\/json/i.test(response.headers.get("content-type") || "")) return undefined;
  const text = await readBoundedText(response, 250_000);
  if (text === null) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const payload = record(value);
  const code = typeof payload?.code === "string" ? payload.code : "";
  const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : "";
  const detail = typeof payload?.error === "string" ? payload.error.replace(/\s+/g, " ").trim() : "";
  if (payload?.ok !== false
    || payload.live !== false
    || payload.primaryDomain !== expectedPrimaryDomain
    || !["blocked-page-recovery-failed", "primary-page-unavailable"].includes(code)
    || !/^(?:edge-(?:request-failed|http-rejected|content-type-invalid|response-too-large|response-invalid)|primary-page-unavailable)$/.test(errorCode)
    || !detail
    || detail.length > 280) return undefined;
  return new OrchestrationHttpError("Public crawl", response.status, false, detail, errorCode);
}

async function requestJson(fetchImpl: FetchLike, url: string, token: string, operation: string, timeoutMs: number, body?: unknown, acceptError?: (response: Response) => Promise<unknown | undefined>, maxAttempts = 2) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new Error("The orchestration HTTP attempt bound is invalid.");
  const deadline = Date.now() + timeoutMs;
  let transientFailures = 0;
  let leaseWaitRetries = 0;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new OrchestrationHttpError(operation, 0, true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let leaseDelayMs: number | null = null;
    let retryTransient = false;
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
      if (response.ok) {
        const responseText = await readBoundedText(response, MAX_SUCCESS_BODY_BYTES);
        if (responseText === null) throw new OrchestrationHttpError(operation, 502, true, "The successful worker response exceeded the orchestration transport bound.");
        try { return JSON.parse(responseText) as unknown; } catch { throw new OrchestrationHttpError(operation, 502, true, "The successful worker response was not valid JSON."); }
      }
      const accepted = acceptError ? await acceptError(response) : undefined;
      if (accepted !== undefined) return accepted;
      const retryable = isRetryableHttpStatus(response.status);
      if (response.status === 425) {
        void response.body?.cancel().catch(() => { /* response cleanup is best effort */ });
        leaseWaitRetries += 1;
        if (leaseWaitRetries > MAX_LEASE_WAIT_RETRIES) throw new OrchestrationHttpError(operation, response.status, true);
        leaseDelayMs = retryAfterMs(response.headers.get("retry-after"));
      } else {
        void response.body?.cancel().catch(() => { /* response cleanup is best effort */ });
        transientFailures += 1;
        if (!retryable || transientFailures >= maxAttempts) throw new OrchestrationHttpError(operation, response.status, retryable);
        retryTransient = true;
      }
    } catch (error) {
      if (error instanceof OrchestrationHttpError) throw error;
      transientFailures += 1;
      if (transientFailures >= maxAttempts) throw new OrchestrationHttpError(operation, 0, true);
      retryTransient = true;
    } finally {
      clearTimeout(timeout);
    }
    if (leaseDelayMs !== null) {
      const leaseRemainingMs = deadline - Date.now();
      const boundedDelayMs = Math.max(1, leaseDelayMs);
      if (boundedDelayMs >= leaseRemainingMs) throw new OrchestrationHttpError(operation, 425, true);
      await new Promise((resolve) => setTimeout(resolve, boundedDelayMs));
      continue;
    }
    if (retryTransient) continue;
  }
}

function requiredObject<T>(value: unknown, operation: string): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrchestrationHttpError(operation, 502, true);
  return value as T;
}

export function createReportOrchestrationHttpPort(configuration: { appOrigin: string; callbackToken: string; fetchImpl?: FetchLike }): ReportOrchestrationPort {
  const appOrigin = origin(configuration.appOrigin);
  const token = callbackToken(configuration.callbackToken);
  const fetchImpl = configuration.fetchImpl || orchestrationFetch;
  const call = (path: string, operation: string, timeoutMs: number, body?: unknown) => requestJson(fetchImpl, new URL(path, appOrigin).toString(), token, operation, timeoutMs, body);

  return {
    async preflight() {
      try {
        parseWorkerApiManifest(await call(PATHS.capabilities, "Worker API preflight", OPERATION_BUDGETS_MS.preflight));
      } catch (error) {
        if (error instanceof WorkerApiContractError || (error instanceof OrchestrationHttpError && !error.retryable)) {
          throw new PermanentOrchestrationError("The configured application origin does not provide a compatible worker API.");
        }
        throw error;
      }
    },
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
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["crawl"]>>>(await requestJson(fetchImpl, new URL(PATHS.crawl, appOrigin).toString(), token, "Public crawl", OPERATION_BUDGETS_MS.crawl, input, async (response) => {
        const parked = await acceptedParkedDomainResponse(response.clone(), input.primary);
        if (parked !== undefined) return parked;
        const unavailable = await acceptedUnavailableDomainResponse(response.clone(), input.primary);
        if (unavailable !== undefined) return unavailable;
        const failure = await acceptedCrawlFailureError(response, input.primary);
        if (failure) throw failure;
        return undefined;
      }), "Public crawl");
      if (payload.ok !== true && payload.code !== "parked-domain" && payload.code !== "unavailable-domain") throw new OrchestrationHttpError("Public crawl", 422, false);
      return payload;
    },
    async benchmark(input) {
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["benchmark"]>>>(await requestJson(fetchImpl, new URL(PATHS.crawl, appOrigin).toString(), token, "Rival experience crawl", OPERATION_BUDGETS_MS.rivalBenchmark, input, async (response) => {
        const parked = await acceptedParkedDomainResponse(response.clone(), input.primary);
        if (parked !== undefined) return parked;
        const unavailable = await acceptedUnavailableDomainResponse(response.clone(), input.primary);
        if (unavailable !== undefined) return unavailable;
        const failure = await acceptedCrawlFailureError(response, input.primary);
        if (failure) throw failure;
        return undefined;
      }), "Rival experience crawl");
      if (payload.ok !== true && payload.code !== "parked-domain" && payload.code !== "unavailable-domain") throw new OrchestrationHttpError("Rival experience crawl", 422, false);
      return payload;
    },
    async brief(input) {
      return await call(PATHS.brief, "Market brief", OPERATION_BUDGETS_MS.brief, input);
    },
    async match(input) {
      const timeoutMs = input.repairFeedback ? OPERATION_BUDGETS_MS.matchRepair : OPERATION_BUDGETS_MS.match;
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["match"]>>>(await call(PATHS.match, "Product matching", timeoutMs, input), "Product matching");
      if (payload.ok !== true) throw new OrchestrationHttpError("Product matching", 422, false);
      return payload;
    },
    async enrich(input) {
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["enrich"]>>>(await call(PATHS.enrich, "Product enrichment", OPERATION_BUDGETS_MS.enrich, input), "Product enrichment");
      if (payload.ok !== true) throw new OrchestrationHttpError("Product enrichment", 422, false);
      return payload;
    },
    async loadCheckpoint(publicId, input) {
      const checkpoints: Awaited<ReturnType<ReportOrchestrationPort["loadCheckpoint"]>> = [];
      const requestedLimit = input.limit;
      const pageLimit = Math.min(20, requestedLimit ?? 20);
      const maxPages = checkpointReadPageBound(input.attemptNumber, pageLimit, input.batchIndexStart, input.batchIndexEnd, input.latestPerBatch === true);
      let afterAttemptNumber: number | undefined;
      let afterBatchIndex: number | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const cursor = afterAttemptNumber === undefined ? {} : { afterAttemptNumber, afterBatchIndex };
        const payload = requiredObject<{ ok?: boolean; checkpoints?: unknown }>(await call(PATHS.report(publicId), "Report checkpoint read", OPERATION_BUDGETS_MS.report, { action: "match-batch-checkpoints-load", ...input, ...cursor, limit: pageLimit }), "Report checkpoint read");
        if (payload.ok !== true || !Array.isArray(payload.checkpoints)) throw new OrchestrationHttpError("Report checkpoint read", 502, true);
        const batch = payload.checkpoints as Awaited<ReturnType<ReportOrchestrationPort["loadCheckpoint"]>>;
        checkpoints.push(...batch);
        if (requestedLimit !== undefined && checkpoints.length >= requestedLimit) return checkpoints.slice(0, requestedLimit);
        if (batch.length < pageLimit) return checkpoints;
        const last = batch.at(-1);
        if (!last || !Number.isInteger(last.attemptNumber) || !Number.isInteger(last.batchIndex)
          || (last.attemptNumber === afterAttemptNumber && last.batchIndex === afterBatchIndex)) throw new OrchestrationHttpError("Report checkpoint read", 502, true);
        afterAttemptNumber = last.attemptNumber;
        afterBatchIndex = last.batchIndex;
      }
      throw new OrchestrationHttpError("Report checkpoint read", 502, true);
    },
    async saveCheckpoint(publicId, input) {
      const payload = requiredObject<{ ok?: boolean; checkpoint?: { attemptNumber?: unknown; batchIndex?: unknown; inputHash?: unknown; result?: unknown } }>(await call(PATHS.report(publicId), "Report checkpoint callback", OPERATION_BUDGETS_MS.report, { action: "match-batch-checkpoint-save", ...input }), "Report checkpoint callback");
      const checkpoint = payload.checkpoint;
      if (payload.ok !== true || !checkpoint || checkpoint.attemptNumber !== input.attemptNumber || checkpoint.batchIndex !== input.batchIndex
        || checkpoint.inputHash !== input.inputHash || !sameCheckpointValue(checkpoint.result, input.result)) throw new OrchestrationHttpError("Report checkpoint callback", 502, true);
    },
    async actions(input) {
      // A response can be lost after the paid action request was accepted.
      // Do not blindly POST it again; orchestration adopts a deterministic
      // fallback and durably checkpoints that outcome for later task attempts.
      const payload = requiredObject<Awaited<ReturnType<ReportOrchestrationPort["actions"]>>>(await requestJson(fetchImpl, new URL(PATHS.actions, appOrigin).toString(), token, "Product action planning", OPERATION_BUDGETS_MS.actions, input, undefined, 1), "Product action planning");
      if (payload.ok !== true) throw new OrchestrationHttpError("Product action planning", 422, false);
      return payload;
    },
    async persistFactChunk(publicId, input) {
      const payload = requiredObject<{ ok?: boolean }>(await call(PATHS.report(publicId), "Report fact chunk callback", OPERATION_BUDGETS_MS.factCallback, { action: "fact-chunk", ...input }), "Report fact chunk callback");
      if (payload.ok !== true) throw new OrchestrationHttpError("Report fact chunk callback", 502, true);
    },
    async finalizeFactManifest(publicId, input) {
      const payload = requiredObject<{ ok?: boolean }>(await call(PATHS.report(publicId), "Report fact manifest callback", OPERATION_BUDGETS_MS.factCallback, { action: "fact-manifest", ...input }), "Report fact manifest callback");
      if (payload.ok !== true) throw new OrchestrationHttpError("Report fact manifest callback", 502, true);
    },
    async saveDocument(publicId, input) {
      const body = { action: "document", ...input, document: compactTerminalReportDocument(input.document) };
      if (encodedJsonBytes(body) >= REPORT_CALLBACK_ENVELOPE_BYTES) throw new PermanentOrchestrationError("The compacted report callback exceeds the internal transport budget.");
      const payload = requiredObject<{ ok?: boolean }>(await call(PATHS.report(publicId), "Completed report callback", OPERATION_BUDGETS_MS.report, body), "Completed report callback");
      if (payload.ok !== true) throw new OrchestrationHttpError("Completed report callback", 502, true);
    },
  };
}
