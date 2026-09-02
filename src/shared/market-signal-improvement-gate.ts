import { MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS } from "./market-signal-loop-graph.ts";

export const MARKET_SIGNAL_IMPROVEMENT_GATE_VERSION = "market-signal-metric-gate-v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9:_-]{0,119}$/;

export const MARKET_SIGNAL_REQUIRED_GUARDRAILS = [
  "tests_passed",
  "typecheck_passed",
  "security_checks_passed",
  "output_contract_passed",
  "zero_empty_prices",
  "source_evidence_complete",
  "within_cost_ceiling",
  "within_runtime_ceiling",
] as const;

export type MarketSignalGuardrailKey = typeof MARKET_SIGNAL_REQUIRED_GUARDRAILS[number];

export const MARKET_SIGNAL_METRIC_DEFINITIONS = {
  comparison_target_fill_rate: { direction: "higher", role: "primary", minimumImprovement: 0.01, maximumRegression: 0 },
  match_relevance_rate: { direction: "higher", role: "primary", minimumImprovement: 0.01, maximumRegression: 0 },
  price_validity_rate: { direction: "higher", role: "guardrail", minimumImprovement: 0.01, maximumRegression: 0 },
  source_evidence_rate: { direction: "higher", role: "guardrail", minimumImprovement: 0.01, maximumRegression: 0 },
  cost_per_valid_comparison_microusd: { direction: "lower", role: "primary", minimumImprovement: 0.05, maximumRegression: 0.10 },
  duration_ms: { direction: "lower", role: "primary", minimumImprovement: 0.05, maximumRegression: 0.20 },
} as const;

export type MarketSignalMetricKey = keyof typeof MARKET_SIGNAL_METRIC_DEFINITIONS;

export type MarketSignalImprovementAttempt = {
  contractVersion: "1";
  metricGateVersion: typeof MARKET_SIGNAL_IMPROVEMENT_GATE_VERSION;
  cycleId: string;
  issueFingerprint: string;
  attemptNumber: number;
  baselineVersion: string;
  candidateVersion: string;
  baselineArtifactHash: string;
  candidateArtifactHash: string;
  priorCandidateArtifactHashes: string[];
  baselineBenchmarkVersion: string;
  candidateBenchmarkVersion: string;
  maximumCycleCostMicrousd: number;
  spentCycleCostMicrousd: number;
  deadlineAt: string;
  guardrails: Array<{ key: MarketSignalGuardrailKey; passed: boolean; detail: string }>;
  metrics: Array<{ key: MarketSignalMetricKey; baseline: number | null; candidate: number | null }>;
  evaluatedAt: string;
};

export type MarketSignalImprovementDecision = {
  decision: "keep" | "revert" | "human_review";
  stateAction: "keep_candidate" | "restore_baseline" | "hold_for_human";
  reasonCode: "better" | "guardrail_failed" | "metric_regression" | "no_measurable_improvement" | "duplicate_candidate" | "incomparable_benchmark" | "unknown_metric" | "cycle_budget_exhausted" | "cycle_deadline_reached";
  terminal: boolean;
  retryAllowed: boolean;
  nextAttemptNumber: number | null;
  remainingAttempts: number;
  failedGuardrails: MarketSignalGuardrailKey[];
  improvedMetrics: MarketSignalMetricKey[];
  regressedMetrics: MarketSignalMetricKey[];
};

export class MarketSignalImprovementGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketSignalImprovementGateError";
  }
}

const ATTEMPT_KEYS = ["attemptNumber", "baselineArtifactHash", "baselineBenchmarkVersion", "baselineVersion", "candidateArtifactHash", "candidateBenchmarkVersion", "candidateVersion", "contractVersion", "cycleId", "deadlineAt", "evaluatedAt", "guardrails", "issueFingerprint", "maximumCycleCostMicrousd", "metricGateVersion", "metrics", "priorCandidateArtifactHashes", "spentCycleCostMicrousd"].sort();
const GUARDRAIL_KEYS = ["detail", "key", "passed"].sort();
const METRIC_KEYS = ["baseline", "candidate", "key"].sort();

function canonicalTimestamp(value: string) {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateAttempt(input: MarketSignalImprovementAttempt) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MarketSignalImprovementGateError("Improvement attempt must be an object.");
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(ATTEMPT_KEYS)) throw new MarketSignalImprovementGateError("Improvement attempt contains unsupported fields.");
  if (input.contractVersion !== "1" || input.metricGateVersion !== MARKET_SIGNAL_IMPROVEMENT_GATE_VERSION) throw new MarketSignalImprovementGateError("Unsupported improvement gate contract.");
  if (!ID_PATTERN.test(input.cycleId) || !HASH_PATTERN.test(input.issueFingerprint)) throw new MarketSignalImprovementGateError("Invalid improvement cycle identity.");
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1 || input.attemptNumber > MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS) throw new MarketSignalImprovementGateError("Improvement attempt must be between one and three.");
  if (!ID_PATTERN.test(input.baselineVersion) || !ID_PATTERN.test(input.candidateVersion) || input.baselineVersion === input.candidateVersion) throw new MarketSignalImprovementGateError("Candidate and baseline versions must be distinct.");
  if (!HASH_PATTERN.test(input.baselineArtifactHash) || !HASH_PATTERN.test(input.candidateArtifactHash)) throw new MarketSignalImprovementGateError("Candidate and baseline artifacts require SHA-256 hashes.");
  if (!Array.isArray(input.priorCandidateArtifactHashes) || input.priorCandidateArtifactHashes.length !== input.attemptNumber - 1 || input.priorCandidateArtifactHashes.some((hash) => !HASH_PATTERN.test(hash)) || new Set(input.priorCandidateArtifactHashes).size !== input.priorCandidateArtifactHashes.length) {
    throw new MarketSignalImprovementGateError("Prior candidate hashes must describe every earlier distinct attempt exactly once.");
  }
  if (!ID_PATTERN.test(input.baselineBenchmarkVersion) || !ID_PATTERN.test(input.candidateBenchmarkVersion)) throw new MarketSignalImprovementGateError("Invalid benchmark version.");
  if (!Number.isInteger(input.maximumCycleCostMicrousd) || input.maximumCycleCostMicrousd < 1 || !Number.isInteger(input.spentCycleCostMicrousd) || input.spentCycleCostMicrousd < 0) throw new MarketSignalImprovementGateError("Improvement cycle costs must be bounded non-negative micro-USD integers.");
  if (!canonicalTimestamp(input.deadlineAt) || !canonicalTimestamp(input.evaluatedAt)) throw new MarketSignalImprovementGateError("Improvement cycle timestamps must be canonical ISO timestamps.");

  if (!Array.isArray(input.guardrails) || input.guardrails.length !== MARKET_SIGNAL_REQUIRED_GUARDRAILS.length) throw new MarketSignalImprovementGateError("Every hard guardrail is required.");
  const guardrailKeys = input.guardrails.map((guardrail) => guardrail.key).sort();
  if (JSON.stringify(guardrailKeys) !== JSON.stringify([...MARKET_SIGNAL_REQUIRED_GUARDRAILS].sort())) throw new MarketSignalImprovementGateError("Hard guardrails must be complete and unique.");
  if (input.guardrails.some((guardrail) => JSON.stringify(Object.keys(guardrail).sort()) !== JSON.stringify(GUARDRAIL_KEYS) || typeof guardrail.passed !== "boolean" || typeof guardrail.detail !== "string" || guardrail.detail.length > 240)) throw new MarketSignalImprovementGateError("Invalid hard guardrail result.");

  const requiredMetricKeys = Object.keys(MARKET_SIGNAL_METRIC_DEFINITIONS).sort();
  if (!Array.isArray(input.metrics) || JSON.stringify(input.metrics.map((metric) => metric.key).sort()) !== JSON.stringify(requiredMetricKeys)) throw new MarketSignalImprovementGateError("Every metric must be supplied exactly once.");
  for (const metric of input.metrics) {
    if (JSON.stringify(Object.keys(metric).sort()) !== JSON.stringify(METRIC_KEYS)) throw new MarketSignalImprovementGateError("Metric result contains unsupported fields.");
    if (!(metric.key in MARKET_SIGNAL_METRIC_DEFINITIONS)) throw new MarketSignalImprovementGateError("Unknown metric.");
    for (const value of [metric.baseline, metric.candidate]) if (value !== null && (!Number.isFinite(value) || value < 0)) throw new MarketSignalImprovementGateError("Metric values must be finite non-negative numbers or null.");
    if (["comparison_target_fill_rate", "match_relevance_rate", "price_validity_rate", "source_evidence_rate"].includes(metric.key) && [metric.baseline, metric.candidate].some((value) => value !== null && value > 1)) {
      throw new MarketSignalImprovementGateError("Rate metrics must be between zero and one.");
    }
  }
}

function normalizedDelta(key: MarketSignalMetricKey, baseline: number, candidate: number) {
  const definition = MARKET_SIGNAL_METRIC_DEFINITIONS[key];
  if (definition.direction === "higher") return candidate - baseline;
  if (baseline === 0) return candidate === 0 ? 0 : -1;
  return (baseline - candidate) / baseline;
}

function revertDecision(input: MarketSignalImprovementAttempt, reasonCode: MarketSignalImprovementDecision["reasonCode"], failedGuardrails: MarketSignalGuardrailKey[] = [], improvedMetrics: MarketSignalMetricKey[] = [], regressedMetrics: MarketSignalMetricKey[] = [], forceTerminal = false): MarketSignalImprovementDecision {
  const retryAllowed = !forceTerminal && input.attemptNumber < MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS;
  return {
    decision: "revert",
    stateAction: "restore_baseline",
    reasonCode,
    terminal: !retryAllowed,
    retryAllowed,
    nextAttemptNumber: retryAllowed ? input.attemptNumber + 1 : null,
    remainingAttempts: MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS - input.attemptNumber,
    failedGuardrails,
    improvedMetrics,
    regressedMetrics,
  };
}

export function decideMarketSignalImprovement(input: MarketSignalImprovementAttempt): MarketSignalImprovementDecision {
  validateAttempt(input);
  if (input.spentCycleCostMicrousd >= input.maximumCycleCostMicrousd) return revertDecision(input, "cycle_budget_exhausted", [], [], [], true);
  if (Date.parse(input.evaluatedAt) >= Date.parse(input.deadlineAt)) return revertDecision(input, "cycle_deadline_reached", [], [], [], true);
  const duplicateCandidate = input.candidateArtifactHash === input.baselineArtifactHash || input.priorCandidateArtifactHashes.includes(input.candidateArtifactHash);
  if (duplicateCandidate) return revertDecision(input, "duplicate_candidate");

  if (input.baselineBenchmarkVersion !== input.candidateBenchmarkVersion) {
    return {
      decision: "human_review",
      stateAction: "hold_for_human",
      reasonCode: "incomparable_benchmark",
      terminal: true,
      retryAllowed: false,
      nextAttemptNumber: null,
      remainingAttempts: MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS - input.attemptNumber,
      failedGuardrails: [],
      improvedMetrics: [],
      regressedMetrics: [],
    };
  }

  const failedGuardrails = input.guardrails.filter((guardrail) => !guardrail.passed).map((guardrail) => guardrail.key);
  if (failedGuardrails.length) return revertDecision(input, "guardrail_failed", failedGuardrails);
  if (input.metrics.some((metric) => metric.baseline === null || metric.candidate === null)) {
    return {
      decision: "human_review",
      stateAction: "hold_for_human",
      reasonCode: "unknown_metric",
      terminal: true,
      retryAllowed: false,
      nextAttemptNumber: null,
      remainingAttempts: MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS - input.attemptNumber,
      failedGuardrails: [],
      improvedMetrics: [],
      regressedMetrics: [],
    };
  }

  const improvedMetrics: MarketSignalMetricKey[] = [];
  const regressedMetrics: MarketSignalMetricKey[] = [];
  for (const metric of input.metrics) {
    const key = metric.key;
    const definition = MARKET_SIGNAL_METRIC_DEFINITIONS[key];
    const delta = normalizedDelta(key, metric.baseline!, metric.candidate!);
    if (delta < -definition.maximumRegression) regressedMetrics.push(key);
    if (definition.role === "primary" && delta >= definition.minimumImprovement) improvedMetrics.push(key);
  }
  if (regressedMetrics.length) return revertDecision(input, "metric_regression", [], improvedMetrics, regressedMetrics);
  if (!improvedMetrics.length) return revertDecision(input, "no_measurable_improvement", [], [], []);
  return {
    decision: "keep",
    stateAction: "keep_candidate",
    reasonCode: "better",
    terminal: true,
    retryAllowed: false,
    nextAttemptNumber: null,
    remainingAttempts: MARKET_SIGNAL_MAX_IMPROVEMENT_ATTEMPTS - input.attemptNumber,
    failedGuardrails: [],
    improvedMetrics,
    regressedMetrics: [],
  };
}
