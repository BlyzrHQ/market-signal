import { reportOrchestrationWireVersion } from "./report-orchestration-contract.ts";

export const MARKET_SIGNAL_LOOP_CONTRACT_VERSION = "1" as const;
export const MARKET_SIGNAL_FUNCTION_ID = "market-signal.report" as const;
export const MARKET_SIGNAL_FUNCTION_VERSION = "1" as const;

export const MARKET_SIGNAL_COMPARISON_TARGETS = {
  starter: 20,
  solo: 50,
  growth: 500,
  agency: 1_000,
} as const;

export type MarketSignalProductPlan = keyof typeof MARKET_SIGNAL_COMPARISON_TARGETS;

export type MarketSignalLoopInput = {
  contractVersion: typeof MARKET_SIGNAL_LOOP_CONTRACT_VERSION;
  functionId: typeof MARKET_SIGNAL_FUNCTION_ID;
  functionVersion: typeof MARKET_SIGNAL_FUNCTION_VERSION;
  requestId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  productPlan: MarketSignalProductPlan;
  comparisonTarget: number;
};

export type MarketSignalLoopArtifact = {
  kind: "report" | "comparisons" | "competitor_scores" | "evidence" | "evaluation";
  schemaVersion: string;
  reference: string;
  contentHash: string;
  mediaType: "application/json";
  recordCount: number | null;
};

export type MarketSignalLoopOutput = {
  contractVersion: typeof MARKET_SIGNAL_LOOP_CONTRACT_VERSION;
  functionId: typeof MARKET_SIGNAL_FUNCTION_ID;
  functionVersion: typeof MARKET_SIGNAL_FUNCTION_VERSION;
  requestId: string;
  primaryDomain: string;
  productPlan: MarketSignalProductPlan;
  runId: string;
  status: "complete" | "limited" | "failed" | "outcome_unknown";
  report: {
    publicId: string;
    ownerPath: string;
    status: "complete" | "limited";
    completedPhases: string[];
    limitedPhases: string[];
  } | null;
  artifacts: MarketSignalLoopArtifact[];
  metrics: {
    comparisonTarget: number;
    publishedComparisons: number;
    pricedComparisons: number;
    competitorCount: number;
    repairRounds: number;
    usageStatus: "not_called" | "known" | "unknown";
    costMicrousd: number | null;
    durationMs: number;
  };
  evaluation: {
    status: "pending" | "complete" | "needs_human_review" | "unavailable";
    evaluationId: string | null;
    evaluatorVersion: string | null;
    resultHash: string | null;
  };
  failure: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string;
};

const INPUT_KEYS = ["comparisonTarget", "contractVersion", "functionId", "functionVersion", "locale", "primaryDomain", "productPlan", "requestId"].sort();
const OUTPUT_KEYS = ["artifacts", "contractVersion", "evaluation", "failure", "finishedAt", "functionId", "functionVersion", "metrics", "primaryDomain", "productPlan", "report", "requestId", "runId", "startedAt", "status"].sort();
const REPORT_KEYS = ["completedPhases", "limitedPhases", "ownerPath", "publicId", "status"].sort();
const ARTIFACT_KEYS = ["contentHash", "kind", "mediaType", "recordCount", "reference", "schemaVersion"].sort();
const METRIC_KEYS = ["comparisonTarget", "competitorCount", "costMicrousd", "durationMs", "pricedComparisons", "publishedComparisons", "repairRounds", "usageStatus"].sort();
const EVALUATION_KEYS = ["evaluationId", "evaluatorVersion", "resultHash", "status"].sort();
const FAILURE_KEYS = ["code", "message"].sort();
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/;
const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REFERENCE_PATTERN = /^[a-z][a-z0-9+.-]*:[^\s]{1,500}$/;
const PHASE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export class MarketSignalLoopContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketSignalLoopContractError";
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MarketSignalLoopContractError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], name: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) throw new MarketSignalLoopContractError(`${name} contains unsupported fields.`);
}

function canonicalTimestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new MarketSignalLoopContractError(`${name} must be a canonical ISO timestamp.`);
  }
}

function nonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new MarketSignalLoopContractError(`${name} must be a non-negative integer.`);
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && PHASE_PATTERN.test(item)) || new Set(value).size !== value.length) {
    throw new MarketSignalLoopContractError(`${name} must contain unique phase ids.`);
  }
}

export function parseMarketSignalLoopInput(value: unknown): MarketSignalLoopInput {
  const input = record(value, "Market Signal loop input");
  exactKeys(input, INPUT_KEYS, "Market Signal loop input");
  if (input.contractVersion !== MARKET_SIGNAL_LOOP_CONTRACT_VERSION) throw new MarketSignalLoopContractError("Unsupported Market Signal loop contract version.");
  if (input.functionId !== MARKET_SIGNAL_FUNCTION_ID) throw new MarketSignalLoopContractError("Unsupported function id.");
  if (input.functionVersion !== MARKET_SIGNAL_FUNCTION_VERSION) throw new MarketSignalLoopContractError("Unsupported Market Signal function version.");
  if (typeof input.requestId !== "string" || !ID_PATTERN.test(input.requestId)) throw new MarketSignalLoopContractError("Invalid request id.");
  if (typeof input.primaryDomain !== "string" || input.primaryDomain !== input.primaryDomain.trim().toLowerCase() || !DOMAIN_PATTERN.test(input.primaryDomain)) {
    throw new MarketSignalLoopContractError("primaryDomain must be a canonical public hostname.");
  }
  if (input.locale !== "en" && input.locale !== "ar") throw new MarketSignalLoopContractError("Unsupported locale.");
  if (typeof input.productPlan !== "string" || !(input.productPlan in MARKET_SIGNAL_COMPARISON_TARGETS)) throw new MarketSignalLoopContractError("Unsupported product plan.");
  nonNegativeInteger(input.comparisonTarget, "comparisonTarget");
  try {
    reportOrchestrationWireVersion(input.productPlan as MarketSignalProductPlan, input.comparisonTarget, "pairs");
  } catch (error) {
    throw new MarketSignalLoopContractError(error instanceof Error ? error.message : "comparisonTarget does not match the selected plan.");
  }
  return input as MarketSignalLoopInput;
}

export function parseMarketSignalLoopOutput(value: unknown): MarketSignalLoopOutput {
  const output = record(value, "Market Signal loop output");
  exactKeys(output, OUTPUT_KEYS, "Market Signal loop output");
  if (output.contractVersion !== MARKET_SIGNAL_LOOP_CONTRACT_VERSION || output.functionId !== MARKET_SIGNAL_FUNCTION_ID || output.functionVersion !== MARKET_SIGNAL_FUNCTION_VERSION) {
    throw new MarketSignalLoopContractError("Market Signal loop output identity is invalid.");
  }
  if (typeof output.requestId !== "string" || !ID_PATTERN.test(output.requestId) || typeof output.runId !== "string" || !ID_PATTERN.test(output.runId)) {
    throw new MarketSignalLoopContractError("Market Signal loop output ids are invalid.");
  }
  if (typeof output.primaryDomain !== "string" || output.primaryDomain !== output.primaryDomain.trim().toLowerCase() || !DOMAIN_PATTERN.test(output.primaryDomain)) {
    throw new MarketSignalLoopContractError("Market Signal loop output domain is invalid.");
  }
  if (typeof output.productPlan !== "string" || !(output.productPlan in MARKET_SIGNAL_COMPARISON_TARGETS)) throw new MarketSignalLoopContractError("Market Signal loop output plan is invalid.");
  if (!(["complete", "limited", "failed", "outcome_unknown"] as unknown[]).includes(output.status)) throw new MarketSignalLoopContractError("Market Signal loop status is invalid.");
  canonicalTimestamp(output.startedAt, "startedAt");
  canonicalTimestamp(output.finishedAt, "finishedAt");
  if (Date.parse(output.finishedAt) < Date.parse(output.startedAt)) throw new MarketSignalLoopContractError("finishedAt cannot precede startedAt.");

  let report: MarketSignalLoopOutput["report"] = null;
  if (output.report !== null) {
    const candidate = record(output.report, "report");
    exactKeys(candidate, REPORT_KEYS, "report");
    if (typeof candidate.publicId !== "string" || !PUBLIC_ID_PATTERN.test(candidate.publicId)) throw new MarketSignalLoopContractError("Invalid report public id.");
    if (candidate.ownerPath !== `/reports/${candidate.publicId}`) throw new MarketSignalLoopContractError("Reports must return their private owner path, not a public share URL.");
    if (candidate.status !== "complete" && candidate.status !== "limited") throw new MarketSignalLoopContractError("Invalid report status.");
    stringArray(candidate.completedPhases, "completedPhases");
    stringArray(candidate.limitedPhases, "limitedPhases");
    report = candidate as MarketSignalLoopOutput["report"];
  }
  if ((output.status === "complete" || output.status === "limited") && (!report || report.status !== output.status)) throw new MarketSignalLoopContractError("Terminal successful outputs require a matching report.");

  if (!Array.isArray(output.artifacts) || output.artifacts.length > 16) throw new MarketSignalLoopContractError("artifacts must be a bounded array.");
  const artifacts = output.artifacts.map((item) => {
    const artifact = record(item, "artifact");
    exactKeys(artifact, ARTIFACT_KEYS, "artifact");
    if (!(["report", "comparisons", "competitor_scores", "evidence", "evaluation"] as unknown[]).includes(artifact.kind)) throw new MarketSignalLoopContractError("Invalid artifact kind.");
    if (typeof artifact.schemaVersion !== "string" || !ID_PATTERN.test(artifact.schemaVersion)) throw new MarketSignalLoopContractError("Invalid artifact schema version.");
    if (typeof artifact.reference !== "string" || !REFERENCE_PATTERN.test(artifact.reference)) throw new MarketSignalLoopContractError("Invalid artifact reference.");
    if (typeof artifact.contentHash !== "string" || !HASH_PATTERN.test(artifact.contentHash)) throw new MarketSignalLoopContractError("Invalid artifact content hash.");
    if (artifact.mediaType !== "application/json") throw new MarketSignalLoopContractError("Unsupported artifact media type.");
    if (artifact.recordCount !== null) nonNegativeInteger(artifact.recordCount, "artifact recordCount");
    return artifact as MarketSignalLoopArtifact;
  });
  if (new Set(artifacts.map((item) => `${item.kind}:${item.reference}`)).size !== artifacts.length) throw new MarketSignalLoopContractError("Artifact references must be unique.");

  const metrics = record(output.metrics, "metrics");
  exactKeys(metrics, METRIC_KEYS, "metrics");
  for (const key of ["comparisonTarget", "publishedComparisons", "pricedComparisons", "competitorCount", "repairRounds", "durationMs"] as const) nonNegativeInteger(metrics[key], `metrics.${key}`);
  if (Number(metrics.repairRounds) > 3) throw new MarketSignalLoopContractError("Report quality repair rounds cannot exceed three.");
  if (metrics.publishedComparisons !== metrics.pricedComparisons) throw new MarketSignalLoopContractError("Every published comparison must have a supported price.");
  if (Number(metrics.publishedComparisons) > Number(metrics.comparisonTarget)) throw new MarketSignalLoopContractError("Published comparisons cannot exceed the requested target.");
  if (Number(metrics.competitorCount) > Number(metrics.publishedComparisons)) throw new MarketSignalLoopContractError("Competitor count cannot exceed published comparisons.");
  if (Number(metrics.comparisonTarget) !== MARKET_SIGNAL_COMPARISON_TARGETS[output.productPlan as MarketSignalProductPlan]) throw new MarketSignalLoopContractError("Output comparison target does not match the selected plan.");
  if (!(["not_called", "known", "unknown"] as unknown[]).includes(metrics.usageStatus)) throw new MarketSignalLoopContractError("Invalid usage status.");
  if (metrics.usageStatus === "known") nonNegativeInteger(metrics.costMicrousd, "metrics.costMicrousd");
  else if (metrics.costMicrousd !== null) throw new MarketSignalLoopContractError("Unknown or uncalled usage must not be represented as zero cost.");
  if (output.status === "complete" && Number(metrics.publishedComparisons) < Number(metrics.comparisonTarget)) throw new MarketSignalLoopContractError("A complete result must fill the requested comparison target.");
  if (output.status === "complete" || output.status === "limited") {
    const reportArtifacts = artifacts.filter((artifact) => artifact.kind === "report");
    const comparisonArtifacts = artifacts.filter((artifact) => artifact.kind === "comparisons");
    if (reportArtifacts.length !== 1 || reportArtifacts[0]?.recordCount !== 1) throw new MarketSignalLoopContractError("Successful outputs require exactly one report artifact.");
    if (comparisonArtifacts.length !== 1 || comparisonArtifacts[0]?.recordCount !== Number(metrics.publishedComparisons)) throw new MarketSignalLoopContractError("Successful outputs require one comparison artifact bound to the published count.");
  }

  const evaluation = record(output.evaluation, "evaluation");
  exactKeys(evaluation, EVALUATION_KEYS, "evaluation");
  if (!(["pending", "complete", "needs_human_review", "unavailable"] as unknown[]).includes(evaluation.status)) throw new MarketSignalLoopContractError("Invalid evaluation status.");
  const evaluationIdentityPresent = evaluation.evaluationId !== null || evaluation.evaluatorVersion !== null || evaluation.resultHash !== null;
  if (evaluation.status === "complete" || evaluation.status === "needs_human_review") {
    if (typeof evaluation.evaluationId !== "string" || !ID_PATTERN.test(evaluation.evaluationId) || typeof evaluation.evaluatorVersion !== "string" || !ID_PATTERN.test(evaluation.evaluatorVersion) || typeof evaluation.resultHash !== "string" || !HASH_PATTERN.test(evaluation.resultHash)) {
      throw new MarketSignalLoopContractError("Completed evaluations require a versioned, hash-bound identity.");
    }
  } else if (evaluationIdentityPresent) throw new MarketSignalLoopContractError("Pending or unavailable evaluations cannot claim a completed result identity.");

  let failure: MarketSignalLoopOutput["failure"] = null;
  if (output.failure !== null) {
    const candidate = record(output.failure, "failure");
    exactKeys(candidate, FAILURE_KEYS, "failure");
    if (typeof candidate.code !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(candidate.code) || typeof candidate.message !== "string" || candidate.message.length < 1 || candidate.message.length > 240) {
      throw new MarketSignalLoopContractError("Invalid failure detail.");
    }
    failure = candidate as MarketSignalLoopOutput["failure"];
  }
  if ((output.status === "failed" || output.status === "outcome_unknown") !== Boolean(failure)) throw new MarketSignalLoopContractError("Failure detail must match the terminal status.");

  return { ...output, report, artifacts, metrics, evaluation, failure } as MarketSignalLoopOutput;
}
