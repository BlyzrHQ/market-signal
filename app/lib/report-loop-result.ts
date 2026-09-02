import {
  MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
  MARKET_SIGNAL_FUNCTION_ID,
  MARKET_SIGNAL_FUNCTION_VERSION,
  parseMarketSignalLoopOutput,
  type MarketSignalLoopOutput,
} from "../../src/shared/market-signal-loop-contract.ts";
import { reportFactHash } from "../../src/shared/report-facts.ts";
import type {
  StoredReportEvaluation,
  StoredReportMatchPage,
  StoredReportSnapshot,
} from "./report-store.ts";

export type MarketSignalLoopPending = {
  state: "pending";
  requestId: string;
  publicReportId: string;
  primaryDomain: string;
  status: "queued" | "running";
  phase: string;
  attempt: number;
  heartbeatAt: string;
  pollAfterSeconds: number;
};

export type MarketSignalLoopTerminal = {
  state: "terminal";
  output: MarketSignalLoopOutput;
  decision: {
    headline: string;
    coverage: { target: number; delivered: number; percent: number };
    competitorDomains: string[];
    limitations: string[];
    recommendedActions: string[];
  };
  comparisons: {
    inline: StoredReportMatchPage["items"];
    totalCount: number;
    manifestHash: string;
    nextCursor: string | null;
    pageUrl: string;
  };
};

export type MarketSignalLoopResult = MarketSignalLoopPending | MarketSignalLoopTerminal;

const successful = new Set(["complete", "limited"]);

function uniquePhases(report: StoredReportSnapshot, status: "complete" | "limited") {
  const completed = new Set<string>();
  const limited = new Set<string>();
  for (const event of report.events) {
    if (event.phase === "ads") continue;
    if (event.status === "complete" || event.idempotencyKey.endsWith("-complete") || event.idempotencyKey === "report-saved") completed.add(event.phase === "complete" ? "persistence" : event.phase);
    if (event.status === "limited" || event.idempotencyKey.endsWith("-limited")) limited.add(event.phase);
  }
  if (status === "limited" && limited.size === 0) limited.add("matching");
  return { completedPhases: [...completed], limitedPhases: [...limited] };
}

function repairRounds(report: StoredReportSnapshot) {
  let repairs = 0;
  for (const event of report.events) {
    if (event.phase !== "quality") continue;
    const candidate = Number(event.metadata.repairs ?? event.metadata.repairRounds ?? 0);
    if (Number.isInteger(candidate)) repairs = Math.max(repairs, candidate);
  }
  return Math.min(3, Math.max(0, repairs));
}

async function evaluationResult(evaluation: StoredReportEvaluation | null) {
  if (!evaluation) return { status: "unavailable" as const, evaluationId: null, evaluatorVersion: null, resultHash: null };
  const status = evaluation.status === "complete"
    ? "complete" as const
    : evaluation.status === "needs_human_review"
      ? "needs_human_review" as const
      : ["pending", "deterministic", "dispatching", "reserved"].includes(evaluation.status)
        ? "pending" as const
        : "unavailable" as const;
  if (status !== "complete" && status !== "needs_human_review") {
    return { status, evaluationId: null, evaluatorVersion: null, resultHash: null };
  }
  const resultHash = await reportFactHash({
    id: evaluation.id,
    status: evaluation.status,
    evaluatorVersion: evaluation.evaluatorVersion,
    ratingBasis: evaluation.ratingBasis,
    grade: evaluation.grade,
    overallScore: evaluation.overallScore,
    findings: evaluation.findings,
    proposals: evaluation.proposals,
    completedAt: evaluation.completedAt,
  });
  return { status, evaluationId: evaluation.id, evaluatorVersion: evaluation.evaluatorVersion, resultHash };
}

function boundedFailure(report: StoredReportSnapshot, status: "failed" | "outcome_unknown") {
  const fallbackCode = status === "outcome_unknown" ? "worker-outcome-unknown" : "report-failed";
  const fallbackMessage = status === "outcome_unknown"
    ? "The worker stopped reporting before the report reached a known terminal outcome."
    : "The report could not be completed.";
  const code = /^[a-z][a-z0-9_-]{0,79}$/.test(report.run.errorCode) ? report.run.errorCode : fallbackCode;
  const message = String(report.run.errorMessage || fallbackMessage).trim().slice(0, 240) || fallbackMessage;
  return { code, message };
}

export async function buildMarketSignalLoopResult(input: {
  requestId: string;
  report: StoredReportSnapshot;
  matches?: StoredReportMatchPage | null;
  evaluation?: StoredReportEvaluation | null;
}): Promise<MarketSignalLoopResult> {
  const { report } = input;
  const run = report.run;
  if (run.status === "queued" || run.status === "running") {
    return {
      state: "pending",
      requestId: input.requestId,
      publicReportId: run.publicId,
      primaryDomain: run.primaryDomain,
      status: run.status,
      phase: run.currentPhase,
      attempt: run.attemptCount,
      heartbeatAt: run.heartbeatAt,
      pollAfterSeconds: 10,
    };
  }

  const isStoredSuccess = successful.has(run.status);
  if (isStoredSuccess && !input.matches) throw new Error("Authoritative report matches are unavailable.");
  const matches = input.matches || null;
  const delivered = matches?.totalCount || 0;
  const target = run.productLimit;
  const outputStatus: MarketSignalLoopOutput["status"] = run.status === "interrupted"
    ? "outcome_unknown"
    : run.status === "failed"
      ? "failed"
      : run.status === "limited" || delivered < target
        ? "limited"
        : "complete";
  const reportStatus = outputStatus === "complete" ? "complete" as const : "limited" as const;
  const phases = isStoredSuccess ? uniquePhases(report, reportStatus) : { completedPhases: [], limitedPhases: [] };
  const evaluation = await evaluationResult(input.evaluation || null);
  const reportHash = isStoredSuccess ? await reportFactHash(report.document) : "";
  const pageUrl = `/api/reports/${run.publicId}/matches`;
  const competitorDomains = matches ? Object.keys(matches.domainCounts).filter(Boolean).sort() : [];
  const limitations = outputStatus === "limited"
    ? [`The report delivered ${delivered} of ${target} requested priced comparisons.`]
    : outputStatus === "failed" || outputStatus === "outcome_unknown"
      ? [boundedFailure(report, outputStatus).message]
      : [];
  const failure = outputStatus === "failed" || outputStatus === "outcome_unknown"
    ? boundedFailure(report, outputStatus)
    : null;

  const output = parseMarketSignalLoopOutput({
    contractVersion: MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
    functionId: MARKET_SIGNAL_FUNCTION_ID,
    functionVersion: MARKET_SIGNAL_FUNCTION_VERSION,
    requestId: input.requestId,
    primaryDomain: run.primaryDomain,
    productPlan: run.productPlan,
    runId: run.id,
    status: outputStatus,
    report: isStoredSuccess ? {
      publicId: run.publicId,
      ownerPath: `/reports/${run.publicId}`,
      status: reportStatus,
      ...phases,
    } : null,
    artifacts: isStoredSuccess ? [
      { kind: "report", schemaVersion: String(report.documentSchemaVersion || 1), reference: `market-signal:report:${run.publicId}`, contentHash: reportHash, mediaType: "application/json", recordCount: 1 },
      { kind: "comparisons", schemaVersion: "1", reference: `market-signal:comparisons:${run.publicId}`, contentHash: matches?.manifestHash || "", mediaType: "application/json", recordCount: delivered },
    ] : [],
    metrics: {
      comparisonTarget: target,
      publishedComparisons: delivered,
      pricedComparisons: delivered,
      competitorCount: competitorDomains.length,
      repairRounds: repairRounds(report),
      usageStatus: "unknown",
      costMicrousd: null,
      durationMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
    },
    evaluation,
    failure,
    startedAt: run.createdAt,
    finishedAt: run.updatedAt,
  });

  return {
    state: "terminal",
    output,
    decision: {
      headline: outputStatus === "complete" || outputStatus === "limited"
        ? `${run.primaryDomain} returned ${delivered} priced product comparisons.`
        : failure?.message || "The report did not reach a usable result.",
      coverage: { target, delivered, percent: target > 0 ? Math.round((delivered / target) * 10_000) / 100 : 0 },
      competitorDomains,
      limitations,
      recommendedActions: delivered > 0
        ? ["Review the largest verified price gaps first."]
        : ["Inspect the failure or coverage limitation before submitting a new request id."],
    },
    comparisons: {
      inline: matches?.items || [],
      totalCount: delivered,
      manifestHash: matches?.manifestHash || "",
      nextCursor: matches?.nextCursor || null,
      pageUrl,
    },
  };
}
