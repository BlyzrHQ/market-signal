import {
  composeProductMatchAttempts,
  hasProductMatchCoverageDefect,
  publishPricedProductComparison,
  shouldRetryProductMatch,
  upsertProductComparisonBlock,
} from "../../app/lib/product-match-lifecycle.ts";
import {
  applyFinalProductEnrichment,
  planFinalProductEnrichmentTargets,
  type ProductComparison,
  type ProductRecord,
} from "../../app/lib/product-intelligence.ts";
import {
  applyProductActionPlans,
  collectProductActionInputs,
  deterministicProductActionResult,
  type ProductActionInput,
  type ProductActionPlanningResult,
} from "../../app/lib/ai-action-planner.ts";
import {
  PermanentOrchestrationError,
  REPORT_ORCHESTRATION_CONTRACT_VERSION,
  parseReportOrchestrationPayload,
  type ReportOrchestrationPayload,
  type ReportOrchestrationSummary,
} from "../shared/report-orchestration-contract.ts";
import { buildReportFactBundle } from "../shared/report-facts.ts";
import { compactTerminalReportDocument } from "../shared/report-document-compaction.ts";
import type { ReportFactChunkInput, ReportFactManifestInput } from "../../app/lib/report-store.ts";

export const MAX_OPERATION_TIMEOUT_MS = 13 * 60 * 1000;
export const FINAL_ENRICHMENT_BATCH_SIZE = 64;
export const FINAL_ENRICHMENT_BATCH_CONCURRENCY = 2;
export const MAX_FINAL_ENRICHMENT_TARGETS = 1_000;
export const MAX_FINAL_ENRICHMENT_BATCH_WAVES = Math.ceil(MAX_FINAL_ENRICHMENT_TARGETS / FINAL_ENRICHMENT_BATCH_SIZE / FINAL_ENRICHMENT_BATCH_CONCURRENCY);

type RunStatus = "queued" | "running" | "complete" | "limited" | "failed" | "interrupted";
type ReportEvent = { idempotencyKey: string; phase: string; status: RunStatus; message: string; metadata?: Record<string, unknown> };
type StoredReport = {
  run: { publicId: string; primaryDomain: string; locale: "en" | "ar"; status: RunStatus; attemptCount: number; createdAt: string; updatedAt: string };
  events: Array<{ idempotencyKey?: string; phase: string; status: RunStatus }>;
  factManifest?: { manifestId: string; attemptNumber: number; manifestHash: string; counts: Record<"companies" | "products" | "matches" | "ads", number>; status: string; completedAt: string } | null;
};
type JsonBlock = { type: string; id: string } & Record<string, unknown>;
type JsonDocument = { blocks: JsonBlock[] } & Record<string, unknown>;
type CrawlResult = { domain: string; homepage?: unknown; products: ProductRecord[]; role?: string; discovery?: { verificationScore?: number } };
type CrawlSuccess = { ok: true; primaryDomain: string; results: CrawlResult[]; adRequest: unknown; document: JsonDocument };
type ParkedDomainOutcome = { ok: false; code: "parked-domain"; primaryDomain: string; error: string; document: JsonDocument };
type UnavailableDomainOutcome = { ok: false; code: "unavailable-domain"; primaryDomain: string; error: string; document: JsonDocument };
type CrawlOutcome = CrawlSuccess | ParkedDomainOutcome | UnavailableDomainOutcome;

export type ReportAttemptContext = { attemptNumber: number; taskAttemptNumber?: number; isFinalAttempt: boolean };

export interface ReportOrchestrationPort {
  preflight(): Promise<void>;
  loadReport(publicId: string): Promise<StoredReport | null>;
  appendEvent(publicId: string, event: ReportEvent & { attemptNumber?: number }): Promise<void>;
  crawl(input: { primary: string; domains: string[] }): Promise<CrawlOutcome>;
  brief(input: { primary: string; domains: string[] }): Promise<unknown>;
  ads(input: unknown): Promise<{ ok: true; block: JsonBlock }>;
  match(input: { publicId: string; reportAttempt: number; primaryDomain: string; productLimit: number; catalogs: Array<{ domain: string; products: ProductRecord[] }> }): Promise<{ ok: true; comparison: ProductComparison }>;
  enrich(input: { targets: unknown[] }): Promise<{ ok: true; products: ProductRecord[]; coverage: NonNullable<ProductComparison["enrichment"]> }>;
  actions(input: { inputs: ProductActionInput[] }): Promise<{ ok: true; result: ProductActionPlanningResult }>;
  persistFactChunk(publicId: string, input: ReportFactChunkInput): Promise<void>;
  finalizeFactManifest(publicId: string, input: ReportFactManifestInput): Promise<void>;
  saveDocument(publicId: string, input: { attemptNumber?: number; status: "complete" | "limited"; observedAt: string; document: unknown }): Promise<void>;
}

function event(idempotencyKey: string, phase: string, message: string, metadata?: Record<string, unknown>): ReportEvent {
  return { idempotencyKey, phase, status: "running", message, ...(metadata ? { metadata } : {}) };
}

function limitedEvent(idempotencyKey: string, phase: string, message: string, metadata?: Record<string, unknown>): ReportEvent {
  return { idempotencyKey, phase, status: "limited", message, ...(metadata ? { metadata } : {}) };
}

function phasesFromStored(report: StoredReport) {
  return [...new Set(report.events.flatMap((item) => item.idempotencyKey === "report-saved" ? ["persistence"] : /-complete$/.test(item.idempotencyKey || "") ? [item.phase] : []).filter(Boolean))];
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
  if (payload.reportAttempt !== attempt.attemptNumber) throw new PermanentOrchestrationError("Dispatch payload attempt does not match the active report attempt.");
  const stored = await port.loadReport(payload.publicId);
  if (!stored) throw new PermanentOrchestrationError("Stored report was not found.");
  if (stored.run.primaryDomain !== payload.primaryDomain || stored.run.locale !== payload.locale) {
    throw new PermanentOrchestrationError("Stored report identity does not match the orchestration payload.");
  }
  if (stored.run.status === "complete" || stored.run.status === "limited") return replaySummary(stored, now);
  if (stored.run.status === "failed" || stored.run.status === "interrupted") throw new PermanentOrchestrationError(`Stored report is already ${stored.run.status}.`);
  if (stored.run.attemptCount !== attempt.attemptNumber) throw new PermanentOrchestrationError("Stored report attempt does not match the active worker attempt.");
  const workerPort = port;
  port = {
    ...workerPort,
    appendEvent: (publicId, reportEvent) => workerPort.appendEvent(publicId, { ...reportEvent, attemptNumber: attempt.attemptNumber }),
    saveDocument: (publicId, input) => workerPort.saveDocument(publicId, { ...input, attemptNumber: attempt.attemptNumber }),
  };
  await port.preflight();

  let terminalFailureRecorded = false;
  try {
  const startedAt = now().toISOString();
  const completedPhases: string[] = [];
  const limitedPhases: string[] = [];
  await port.appendEvent(payload.publicId, event("crawl-started", "crawl", "Crawling the submitted website and collecting public product pages."));

  let crawl: CrawlOutcome;
  try {
    crawl = await port.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain] });
    if (!crawl || (crawl.ok !== true && crawl.code !== "parked-domain" && crawl.code !== "unavailable-domain")) throw new Error("The public crawl could not be completed.");
  } catch (error) {
    const detail = message(error, "The public crawl could not be completed.");
    await port.appendEvent(payload.publicId, attempt.isFinalAttempt
      ? { idempotencyKey: "crawl-failed", phase: "failed", status: "failed", message: detail, metadata: { attempt: attempt.attemptNumber } }
      : event(`crawl-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-failed`, "crawl", "The crawl attempt failed and is eligible for one bounded retry.", { reportAttempt: attempt.attemptNumber, taskAttempt: attempt.taskAttemptNumber || 1 }));
    terminalFailureRecorded = attempt.isFinalAttempt;
    throw error;
  }

  if (crawl.ok === false) {
    const document = ensureDocument(crawl.document);
    const unavailable = crawl.code === "unavailable-domain";
    const domainStatus = document.blocks.find((block) => block.type === "domain-status" && block.status === (unavailable ? "unavailable" : "parked"));
    const targetUrl = typeof domainStatus?.attemptedUrl === "string" ? domainStatus.attemptedUrl : typeof domainStatus?.evidenceUrl === "string" ? domainStatus.evidenceUrl : "";
    const reason = crawl.error || (unavailable ? `${payload.primaryDomain} did not return a public network response.` : `${payload.primaryDomain} is parked, so market analysis could not run.`);
    await port.appendEvent(payload.publicId, limitedEvent("crawl-limited", "crawl", unavailable ? "The submitted domain did not return a public network response after bounded attempts, so the company crawl ended with a visible limitation." : "The submitted domain is parked, so the company crawl ended with a source-linked limitation.", unavailable ? { reason, targetUrl, attemptedUrl: targetUrl } : { reason, targetUrl, evidenceUrl: targetUrl }));
    await port.appendEvent(payload.publicId, limitedEvent("ads-limited", "ads", "Ad-library checks did not run because the primary crawl was terminally limited.", { upstream: "crawl", reason }));
    await port.appendEvent(payload.publicId, limitedEvent("matching-limited", "matching", "Product matching did not run because the primary crawl was terminally limited.", { upstream: "crawl", reason }));
    const finishedAt = now().toISOString();
    await port.saveDocument(payload.publicId, {
      status: "limited",
      observedAt: finishedAt,
      document: compactTerminalReportDocument({ primaryDomain: crawl.primaryDomain, document, marketBrief: null }, undefined, { factsAuthoritative: false, factCounts: null }),
    });
    return {
      ok: true,
      contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION,
      publicId: payload.publicId,
      reportStatus: "limited",
      completedPhases: ["persistence"],
      limitedPhases: ["crawl", "ads", "matching"],
      startedAt,
      finishedAt,
    };
  }

  const primary = crawl.results.find((result) => result.domain === crawl.primaryDomain && result.homepage);
  if (!primary) {
    const error = new Error(`Primary domain ${payload.primaryDomain} did not return a live crawl result.`);
    await port.appendEvent(payload.publicId, attempt.isFinalAttempt
      ? { idempotencyKey: "crawl-failed", phase: "failed", status: "failed", message: error.message, metadata: { attempt: attempt.attemptNumber } }
      : event(`crawl-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-failed`, "crawl", "The primary crawl result was unavailable and is eligible for one bounded retry.", { reportAttempt: attempt.attemptNumber, taskAttempt: attempt.taskAttemptNumber || 1 }));
    terminalFailureRecorded = attempt.isFinalAttempt;
    throw error;
  }
  completedPhases.push("crawl");
  await port.appendEvent(payload.publicId, event("crawl-complete", "competitors", "The primary catalog was collected and competitor websites were verified.", {
    primaryProducts: primary.products.length,
    verifiedCompetitors: crawl.results.filter((result) => result.role === "discovered-competitor" && result.homepage && (result.discovery?.verificationScore || 0) >= 55).length,
  }));

  let document = ensureDocument(crawl.document);
  let comparison: ProductComparison | null = null;
  let adBlock: JsonBlock | null = null;

  const adsWork = (async () => {
    await port.appendEvent(payload.publicId, event("ads-started", "ads", "Checking attributable public advertiser records for the verified companies."));
    try {
      const result = await port.ads(crawl.adRequest);
      if (!result?.ok || !result.block) throw new Error("The public ad-library scan was unavailable.");
      adBlock = result.block;
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
      const first = await port.match({ publicId: payload.publicId, reportAttempt: attempt.attemptNumber, primaryDomain: crawl.primaryDomain, productLimit: payload.productLimit, catalogs });
      attempts.push(first.comparison);
    } catch {
      transportFailed = true;
    }
    if (shouldRetryProductMatch(attempts[0], transportFailed)) {
      try {
        await port.appendEvent(payload.publicId, event("matching-retry-started", "matching", "Resuming only incomplete product judge batches from durable checkpoints."));
        requestCount += 1;
        const retry = await port.match({ publicId: payload.publicId, reportAttempt: attempt.attemptNumber, primaryDomain: crawl.primaryDomain, productLimit: payload.productLimit, catalogs });
        attempts.push(retry.comparison);
      } catch { /* the bounded second application attempt remains a visible gap */ }
    }
    comparison = composeProductMatchAttempts(baseline, attempts, requestCount);
    if (comparison) {
      const enrichmentPlan = planFinalProductEnrichmentTargets(comparison, Math.min(payload.productLimit, MAX_FINAL_ENRICHMENT_TARGETS));
      const targets = enrichmentPlan.targets;
      if (targets.length) {
        const batches = Array.from({ length: Math.ceil(targets.length / FINAL_ENRICHMENT_BATCH_SIZE) }, (_, index) => targets.slice(index * FINAL_ENRICHMENT_BATCH_SIZE, (index + 1) * FINAL_ENRICHMENT_BATCH_SIZE));
        await port.appendEvent(payload.publicId, event("enrichment-started", "enrichment", "Re-reading accepted product pages in bounded batches for attributable prices and images.", {
          pagesEligible: enrichmentPlan.totalEligible,
          pagesPlanned: targets.length,
          batches: batches.length,
          truncated: enrichmentPlan.truncated,
        }));
        const products: ProductRecord[] = [];
        const gaps: NonNullable<ProductComparison["enrichment"]>["gaps"] = [];
        let pagesFetched = 0;
        let failedBatchCount = 0;
        for (let waveStart = 0; waveStart < batches.length; waveStart += FINAL_ENRICHMENT_BATCH_CONCURRENCY) {
          const wave = batches.slice(waveStart, waveStart + FINAL_ENRICHMENT_BATCH_CONCURRENCY);
          const results = await Promise.allSettled(wave.map((batch) => port.enrich({ targets: batch })));
          results.forEach((result, index) => {
            if (result.status === "fulfilled") {
              products.push(...result.value.products);
              pagesFetched += result.value.coverage.pagesFetched;
              gaps.push(...result.value.coverage.gaps);
              return;
            }
            failedBatchCount += 1;
            const batch = wave[index];
            const first = batch[0] as { sourceUrl?: string; productId?: string; role?: "primary" | "rival" } | undefined;
            gaps.push({
              url: first?.sourceUrl || "",
              ...(first?.productId ? { productId: first.productId } : {}),
              ...(first?.role ? { role: first.role } : {}),
              reason: `A ${batch.length}-page enrichment batch failed: ${message(result.reason, "Selected product enrichment was unavailable.")}`,
              code: "batch_failed",
            });
          });
          const waveNumber = Math.floor(waveStart / FINAL_ENRICHMENT_BATCH_CONCURRENCY) + 1;
          await port.appendEvent(payload.publicId, event(`enrichment-wave-${waveNumber}-checkpoint`, "enrichment", "A bounded selected-product enrichment wave finished.", {
            wave: waveNumber,
            waves: Math.ceil(batches.length / FINAL_ENRICHMENT_BATCH_CONCURRENCY),
            pagesRequested: batches.slice(0, waveStart + wave.length).reduce((sum, batch) => sum + batch.length, 0),
            pagesFetched,
            failedBatches: failedBatchCount,
          }));
        }
        if (enrichmentPlan.truncated) gaps.push({ url: "", reason: `${enrichmentPlan.totalEligible - targets.length} eligible product pages were outside the plan-bounded enrichment budget.`, code: "plan_limit" });
        comparison = applyFinalProductEnrichment(comparison, products, {
          pagesRequested: targets.length,
          pagesFetched,
          maxPages: targets.length,
          pagesEligible: enrichmentPlan.totalEligible,
          pagesTruncated: enrichmentPlan.truncated,
          batchCount: batches.length,
          failedBatchCount,
          gaps,
        });
        if (failedBatchCount || enrichmentPlan.truncated) {
          limitedPhases.push("enrichment");
          await port.appendEvent(payload.publicId, event("enrichment-limited", "enrichment", "Selected product enrichment finished with explicit batch or plan coverage gaps.", {
            pagesRequested: targets.length,
            pagesFetched,
            batches: batches.length,
            failedBatches: failedBatchCount,
            truncated: enrichmentPlan.truncated,
          }));
        } else {
          completedPhases.push("enrichment");
          await port.appendEvent(payload.publicId, event("enrichment-complete", "enrichment", "Selected product enrichment finished across all bounded batches.", {
            pagesRequested: targets.length,
            pagesFetched,
            batches: batches.length,
          }));
        }
      }
      comparison = publishPricedProductComparison(comparison);
      const actionInputs = collectProductActionInputs(comparison);
      if (actionInputs.length) {
        await port.appendEvent(payload.publicId, event("actions-started", "actions", "Drafting evidence-grounded next moves for the accepted product pairs.", { pairs: actionInputs.length }));
        try {
          const planned = await port.actions({ inputs: actionInputs });
          comparison = applyProductActionPlans(comparison, planned.result);
          completedPhases.push("actions");
          await port.appendEvent(payload.publicId, event("actions-complete", "actions", "Next moves were drafted and checked against saved product evidence.", {
            requested: planned.result.metadata.actionsRequested,
            aiAccepted: planned.result.metadata.aiActionsAccepted,
            deterministicFallbacks: planned.result.metadata.fallbackActions,
          }));
        } catch (error) {
          const fallback = deterministicProductActionResult(actionInputs, undefined, [message(error, "AI action planning was unavailable; deterministic recommendations were retained.")]);
          comparison = applyProductActionPlans(comparison, fallback);
          completedPhases.push("actions");
          await port.appendEvent(payload.publicId, event("actions-complete", "actions", "AI action drafting was unavailable, so the report retained its deterministic next moves.", {
            requested: actionInputs.length,
            aiAccepted: 0,
            deterministicFallbacks: actionInputs.length,
          }));
        }
      }
      document = upsertProductComparisonBlock(document, comparison) as JsonDocument;
    }
    const limited = attempts.length === 0 || hasProductMatchCoverageDefect(comparison);
    (limited ? limitedPhases : completedPhases).push("matching");
    await port.appendEvent(payload.publicId, event("matching-complete", "matching", limited ? "Product matching finished with a visible coverage limitation." : "Product matching finished and accepted comparisons were source-linked.", { limited, attempts: requestCount }));
  })();

  await Promise.all([adsWork, matchWork]);
  const finishedAt = now().toISOString();
  let persistedCounts: Record<"companies" | "products" | "matches" | "ads", number> | null = null;
  try {
    let priorManifest = stored.factManifest || null;
    if (priorManifest?.status === "finalizing") {
      try {
        await port.finalizeFactManifest(payload.publicId, { attemptNumber: priorManifest.attemptNumber, manifestId: priorManifest.manifestId, manifestHash: priorManifest.manifestHash, counts: priorManifest.counts });
        priorManifest = { ...priorManifest, status: "complete" };
      } catch {
        const refreshed = await port.loadReport(payload.publicId);
        priorManifest = refreshed?.factManifest || null;
      }
    }
    const counts = priorManifest?.status === "complete" ? priorManifest.counts : null;
    if (!counts) {
      const facts = await buildReportFactBundle({ publicId: payload.publicId, crawlResults: crawl.results, comparison, adBlock, observedAt: stored.run.createdAt, attemptNumber: attempt.attemptNumber });
      for (const chunk of facts.chunks) await port.persistFactChunk(payload.publicId, chunk);
      await port.finalizeFactManifest(payload.publicId, facts.manifest);
      persistedCounts = facts.manifest.counts;
    } else {
      persistedCounts = counts;
    }
  } catch (error) {
    limitedPhases.push("persistence");
    try { await port.appendEvent(payload.publicId, event("facts-limited", "persistence", "The presentation can be saved, but the complete relational fact set was not available for evaluation.", { reason: message(error, "Relational fact persistence was unavailable.") })); } catch { /* quality telemetry must not block the terminal document */ }
  }
  if (persistedCounts) try { await port.appendEvent(payload.publicId, event("facts-complete", "persistence", "The complete company, product, match, and attributable ad facts were saved for evaluation.", persistedCounts)); } catch { /* the manifest is authoritative and the terminal document still saves */ }
  const reportStatus = limitedPhases.length ? "limited" : "complete";
  await port.saveDocument(payload.publicId, {
    status: reportStatus,
    observedAt: finishedAt,
    document: compactTerminalReportDocument({ primaryDomain: crawl.primaryDomain, document, marketBrief: null }, undefined, { factsAuthoritative: Boolean(persistedCounts), factCounts: persistedCounts }),
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
