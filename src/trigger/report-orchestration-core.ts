import {
  composeProductMatchAttempts,
  hasProductMatchCoverageDefect,
  shouldRetryProductMatch,
  upsertProductComparisonBlock,
} from "../../app/lib/product-match-lifecycle.ts";
import {
  applyFinalProductEnrichment,
  selectFinalProductEnrichmentTargets,
  type ProductComparison,
  type ProductRecord,
} from "../../app/lib/product-intelligence.ts";
import {
  PermanentOrchestrationError,
  REPORT_ORCHESTRATION_CONTRACT_VERSION,
  parseReportOrchestrationPayload,
  type ReportOrchestrationPayload,
  type ReportOrchestrationSummary,
} from "./contracts/report-orchestration.ts";

export const MAX_OPERATION_TIMEOUT_MS = 8 * 60 * 1000;

type RunStatus = "queued" | "running" | "complete" | "limited" | "failed" | "interrupted";
type ReportEvent = { idempotencyKey: string; phase: string; status: RunStatus; message: string; metadata?: Record<string, unknown> };
type StoredReport = {
  run: { publicId: string; primaryDomain: string; locale: "en" | "ar"; status: RunStatus; createdAt: string; updatedAt: string };
  events: Array<{ idempotencyKey?: string; phase: string; status: RunStatus }>;
};
type JsonBlock = { type: string; id: string } & Record<string, unknown>;
type JsonDocument = { blocks: JsonBlock[] } & Record<string, unknown>;
type CrawlResult = { domain: string; homepage?: unknown; products: ProductRecord[]; role?: string; discovery?: { verificationScore?: number } };
type CrawlSuccess = { ok: true; primaryDomain: string; results: CrawlResult[]; adRequest: unknown; document: JsonDocument };

export type ReportAttemptContext = { attemptNumber: number; isFinalAttempt: boolean };

export interface ReportOrchestrationPort {
  loadReport(publicId: string): Promise<StoredReport | null>;
  appendEvent(publicId: string, event: ReportEvent): Promise<void>;
  crawl(input: { primary: string; domains: string[] }): Promise<CrawlSuccess>;
  brief(input: { primary: string; domains: string[] }): Promise<unknown>;
  ads(input: unknown): Promise<{ ok: true; block: JsonBlock }>;
  match(input: { primaryDomain: string; catalogs: Array<{ domain: string; products: ProductRecord[] }> }): Promise<{ ok: true; comparison: ProductComparison }>;
  enrich(input: { targets: unknown[] }): Promise<{ ok: true; products: ProductRecord[]; coverage: NonNullable<ProductComparison["enrichment"]> }>;
  saveDocument(publicId: string, input: { status: "complete" | "limited"; observedAt: string; document: unknown }): Promise<void>;
}

function event(idempotencyKey: string, phase: string, message: string, metadata?: Record<string, unknown>): ReportEvent {
  return { idempotencyKey, phase, status: "running", message, ...(metadata ? { metadata } : {}) };
}

function phasesFromStored(report: StoredReport) {
  return [...new Set(report.events.filter((item) => /-complete$/.test(item.idempotencyKey || "")).map((item) => item.phase).filter(Boolean))];
}

function limitedPhasesFromStored(report: StoredReport) {
  return [...new Set(report.events.filter((item) => /-limited$/.test(item.idempotencyKey || "")).map((item) => item.phase).filter(Boolean))];
}

function replaySummary(report: StoredReport, now: () => Date): ReportOrchestrationSummary {
  const finishedAt = report.run.updatedAt || now().toISOString();
  return {
    ok: true,
    contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION,
    publicId: report.run.publicId,
    reportStatus: report.run.status as "complete" | "limited",
    completedPhases: phasesFromStored(report),
    limitedPhases: limitedPhasesFromStored(report),
    startedAt: report.run.createdAt,
    finishedAt,
  };
}

function ensureDocument(value: unknown): JsonDocument {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as JsonDocument).blocks)) {
    throw new Error("The crawl did not return a report document.");
  }
  return value as JsonDocument;
}

function replaceBlock(document: JsonDocument, block: JsonBlock) {
  return { ...document, blocks: [...document.blocks.filter((item) => item.type !== block.type), block] };
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function orchestrateReport(
  rawPayload: unknown,
  attempt: ReportAttemptContext,
  port: ReportOrchestrationPort,
  now: () => Date = () => new Date(),
): Promise<ReportOrchestrationSummary> {
  const payload: ReportOrchestrationPayload = parseReportOrchestrationPayload(rawPayload);
  const stored = await port.loadReport(payload.publicId);
  if (!stored) throw new PermanentOrchestrationError("Stored report was not found.");
  if (stored.run.primaryDomain !== payload.primaryDomain || stored.run.locale !== payload.locale) {
    throw new PermanentOrchestrationError("Stored report identity does not match the orchestration payload.");
  }
  if (stored.run.status === "complete" || stored.run.status === "limited") return replaySummary(stored, now);
  if (stored.run.status === "failed" || stored.run.status === "interrupted") throw new PermanentOrchestrationError(`Stored report is already ${stored.run.status}.`);

  let terminalFailureRecorded = false;
  try {
  const startedAt = now().toISOString();
  const completedPhases: string[] = [];
  const limitedPhases: string[] = [];
  await port.appendEvent(payload.publicId, event("crawl-started", "crawl", "Crawling the submitted website and collecting public product pages."));

  let crawl: CrawlSuccess;
  try {
    crawl = await port.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] });
    if (!crawl?.ok) throw new Error("The public crawl could not be completed.");
  } catch (error) {
    const detail = message(error, "The public crawl could not be completed.");
    await port.appendEvent(payload.publicId, attempt.isFinalAttempt
      ? { idempotencyKey: "crawl-failed", phase: "failed", status: "failed", message: detail, metadata: { attempt: attempt.attemptNumber } }
      : event(`crawl-attempt-${attempt.attemptNumber}-failed`, "crawl", "The crawl attempt failed and is eligible for one bounded retry.", { attempt: attempt.attemptNumber }));
    terminalFailureRecorded = attempt.isFinalAttempt;
    throw error;
  }

  const primary = crawl.results.find((result) => result.domain === crawl.primaryDomain && result.homepage);
  if (!primary) {
    const error = new Error(`Primary domain ${payload.primaryDomain} did not return a live crawl result.`);
    await port.appendEvent(payload.publicId, attempt.isFinalAttempt
      ? { idempotencyKey: "crawl-failed", phase: "failed", status: "failed", message: error.message, metadata: { attempt: attempt.attemptNumber } }
      : event(`crawl-attempt-${attempt.attemptNumber}-failed`, "crawl", "The primary crawl result was unavailable and is eligible for one bounded retry.", { attempt: attempt.attemptNumber }));
    terminalFailureRecorded = attempt.isFinalAttempt;
    throw error;
  }
  completedPhases.push("crawl");
  await port.appendEvent(payload.publicId, event("crawl-complete", "competitors", "The primary catalog was collected and competitor websites were verified.", {
    primaryProducts: primary.products.length,
    verifiedCompetitors: crawl.results.filter((result) => result.role === "discovered-competitor" && result.homepage && (result.discovery?.verificationScore || 0) >= 55).length,
  }));

  let document = ensureDocument(crawl.document);
  let marketBrief: unknown = null;
  let comparison: ProductComparison | null = null;

  const briefWork = (async () => {
    await port.appendEvent(payload.publicId, event("brief-started", "competitors", "Building the source-linked market brief."));
    try {
      const result = await port.brief({ primary: primary.domain, domains: crawl.results.filter((item) => item.homepage).map((item) => item.domain) });
      if (!result || typeof result !== "object" || (result as { ok?: boolean }).ok === false) throw new Error("The market brief was unavailable.");
      marketBrief = result;
      completedPhases.push("brief");
      await port.appendEvent(payload.publicId, event("brief-complete", "competitors", "The source-linked market brief is ready."));
    } catch (error) {
      limitedPhases.push("brief");
      await port.appendEvent(payload.publicId, event("brief-limited", "competitors", "The crawl succeeded, but the market brief has a visible coverage gap.", { reason: message(error, "Market brief unavailable.") }));
    }
  })();

  const adsWork = (async () => {
    await port.appendEvent(payload.publicId, event("ads-started", "ads", "Checking attributable public advertiser records for the verified companies."));
    try {
      const result = await port.ads(crawl.adRequest);
      if (!result?.ok || !result.block) throw new Error("The public ad-library scan was unavailable.");
      document = replaceBlock(document, result.block);
      completedPhases.push("ads");
      await port.appendEvent(payload.publicId, event("ads-complete", "ads", "The public ad-library phase finished with explicit advertiser coverage states."));
    } catch (error) {
      limitedPhases.push("ads");
      await port.appendEvent(payload.publicId, event("ads-limited", "ads", "Advertiser coverage is limited and no ad activity was invented.", { reason: message(error, "Ad scan unavailable.") }));
    }
  })();

  const matchWork = (async () => {
    await port.appendEvent(payload.publicId, event("matching-started", "matching", "Comparing the strongest product families across the synchronized catalogs."));
    if (!primary.products.length) {
      limitedPhases.push("matching");
      await port.appendEvent(payload.publicId, event("matching-limited", "matching", "No attributable primary product pages were found, so semantic matching could not run."));
      return;
    }
    const baselineBlock = document.blocks.find((block) => block.type === "product-comparison");
    const baseline = baselineBlock ? baselineBlock as unknown as ProductComparison : null;
    const catalogs = crawl.results.map((result) => ({ domain: result.domain, products: result.products }));
    const attempts: ProductComparison[] = [];
    let requestCount = 0;
    let transportFailed = false;
    try {
      requestCount += 1;
      const first = await port.match({ primaryDomain: crawl.primaryDomain, catalogs });
      attempts.push(first.comparison);
    } catch {
      transportFailed = true;
    }
    if (shouldRetryProductMatch(attempts[0], transportFailed)) {
      try {
        requestCount += 1;
        const retry = await port.match({ primaryDomain: crawl.primaryDomain, catalogs });
        attempts.push(retry.comparison);
      } catch { /* the bounded second application attempt remains a visible gap */ }
    }
    comparison = composeProductMatchAttempts(baseline, attempts, requestCount);
    if (comparison) {
      const targets = selectFinalProductEnrichmentTargets(comparison, 24);
      if (targets.length) {
        await port.appendEvent(payload.publicId, event("enrichment-started", "enrichment", "Re-reading selected product pages for attributable prices and images."));
        try {
          const enriched = await port.enrich({ targets });
          comparison = applyFinalProductEnrichment(comparison, enriched.products, enriched.coverage);
          completedPhases.push("enrichment");
          await port.appendEvent(payload.publicId, event("enrichment-complete", "enrichment", "Selected product enrichment finished with explicit source coverage."));
        } catch (error) {
          limitedPhases.push("enrichment");
          comparison = applyFinalProductEnrichment(comparison, [], { pagesRequested: targets.length, pagesFetched: 0, maxPages: 24, gaps: [{ url: "", reason: message(error, "Selected product enrichment was unavailable.") }] });
          await port.appendEvent(payload.publicId, event("enrichment-limited", "enrichment", "Selected product enrichment ended with a visible coverage gap."));
        }
      }
      document = upsertProductComparisonBlock(document, comparison) as JsonDocument;
    }
    const limited = attempts.length === 0 || hasProductMatchCoverageDefect(comparison);
    (limited ? limitedPhases : completedPhases).push("matching");
    await port.appendEvent(payload.publicId, event("matching-complete", "matching", limited ? "Product matching finished with a visible coverage limitation." : "Product matching finished and accepted comparisons were source-linked.", { limited, attempts: requestCount }));
  })();

  await Promise.all([briefWork, adsWork, matchWork]);
  const reportStatus = limitedPhases.length ? "limited" : "complete";
  const finishedAt = now().toISOString();
  await port.saveDocument(payload.publicId, {
    status: reportStatus,
    observedAt: finishedAt,
    document: { primaryDomain: crawl.primaryDomain, document, marketBrief },
  });
  completedPhases.push("persistence");
  return { ok: true, contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION, publicId: payload.publicId, reportStatus, completedPhases: [...new Set(completedPhases)], limitedPhases: [...new Set(limitedPhases)], startedAt, finishedAt };
  } catch (error) {
    if (attempt.isFinalAttempt && !terminalFailureRecorded) {
      try {
        await port.appendEvent(payload.publicId, {
          idempotencyKey: "orchestration-failed",
          phase: "failed",
          status: "failed",
          message: "The report could not be completed after the bounded retry.",
          metadata: { attempt: attempt.attemptNumber, reason: message(error, "Orchestration failed.") },
        });
      } catch { /* callback failure is already represented by the thrown task error */ }
    }
    throw error;
  }
}
