import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKET_SIGNAL_FUNCTION_ID,
  MARKET_SIGNAL_FUNCTION_VERSION,
  MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
  parseMarketSignalLoopInput,
  parseMarketSignalLoopOutput,
} from "../src/shared/market-signal-loop-contract.ts";
import { MARKET_SIGNAL_LOOP_GRAPH, validateMarketSignalLoopGraph } from "../src/shared/market-signal-loop-graph.ts";
import { callMarketSignalLoop } from "../src/shared/market-signal-loop-runtime.ts";
import {
  MARKET_SIGNAL_IMPROVEMENT_GATE_VERSION,
  MARKET_SIGNAL_METRIC_DEFINITIONS,
  MARKET_SIGNAL_REQUIRED_GUARDRAILS,
  decideMarketSignalImprovement,
} from "../src/shared/market-signal-improvement-gate.ts";

const hash = (character) => character.repeat(64);

function validInput(overrides = {}) {
  return {
    contractVersion: MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
    functionId: MARKET_SIGNAL_FUNCTION_ID,
    functionVersion: MARKET_SIGNAL_FUNCTION_VERSION,
    requestId: "request:myjam:1",
    primaryDomain: "myjam.co.uk",
    locale: "en",
    productPlan: "starter",
    comparisonTarget: 20,
    ...overrides,
  };
}

function validOutput(overrides = {}) {
  return {
    contractVersion: MARKET_SIGNAL_LOOP_CONTRACT_VERSION,
    functionId: MARKET_SIGNAL_FUNCTION_ID,
    functionVersion: MARKET_SIGNAL_FUNCTION_VERSION,
    requestId: "request:myjam:1",
    primaryDomain: "myjam.co.uk",
    productPlan: "starter",
    runId: "run:myjam:1",
    status: "complete",
    report: {
      publicId: "a".repeat(32),
      ownerPath: `/reports/${"a".repeat(32)}`,
      status: "complete",
      completedPhases: ["crawl", "matching", "persistence"],
      limitedPhases: [],
    },
    artifacts: [
      { kind: "report", schemaVersion: "report_v1", reference: `report:${"a".repeat(32)}`, contentHash: hash("b"), mediaType: "application/json", recordCount: 1 },
      { kind: "comparisons", schemaVersion: "comparisons_v1", reference: `report-matches:${"a".repeat(32)}`, contentHash: hash("c"), mediaType: "application/json", recordCount: 20 },
    ],
    metrics: { comparisonTarget: 20, publishedComparisons: 20, pricedComparisons: 20, competitorCount: 5, repairRounds: 0, usageStatus: "known", costMicrousd: 20_000, durationMs: 120_000 },
    evaluation: { status: "pending", evaluationId: null, evaluatorVersion: null, resultHash: null },
    failure: null,
    startedAt: "2026-09-02T00:00:00.000Z",
    finishedAt: "2026-09-02T00:02:00.000Z",
    ...overrides,
  };
}

function improvementAttempt(attemptNumber, overrides = {}) {
  const earlier = [hash("c"), hash("d")].slice(0, attemptNumber - 1);
  return {
    contractVersion: "1",
    metricGateVersion: MARKET_SIGNAL_IMPROVEMENT_GATE_VERSION,
    cycleId: "cycle:price-comparisons",
    issueFingerprint: hash("a"),
    attemptNumber,
    baselineVersion: "market-signal-v1",
    candidateVersion: `market-signal-v1-candidate-${attemptNumber}`,
    baselineArtifactHash: hash("b"),
    candidateArtifactHash: [hash("e"), hash("f"), hash("1")][attemptNumber - 1],
    priorCandidateArtifactHashes: earlier,
    baselineBenchmarkVersion: "benchmark-v1",
    candidateBenchmarkVersion: "benchmark-v1",
    maximumCycleCostMicrousd: 100_000,
    spentCycleCostMicrousd: 20_000,
    deadlineAt: "2026-09-03T00:00:00.000Z",
    guardrails: MARKET_SIGNAL_REQUIRED_GUARDRAILS.map((key) => ({ key, passed: true, detail: "passed" })),
    metrics: Object.keys(MARKET_SIGNAL_METRIC_DEFINITIONS).map((key) => ({
      key,
      baseline: key.endsWith("_rate") ? 0.8 : key === "cost_per_valid_comparison_microusd" ? 1_000 : 100_000,
      candidate: key === "comparison_target_fill_rate" ? 0.9 : key.endsWith("_rate") ? 0.8 : key === "cost_per_valid_comparison_microusd" ? 1_000 : 100_000,
    })),
    evaluatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

test("the callable function input is exact, plan-bound, and versioned", () => {
  assert.deepEqual(parseMarketSignalLoopInput(validInput()), validInput());
  assert.throws(() => parseMarketSignalLoopInput(validInput({ comparisonTarget: 19 })), /Product limit does not match/);
  assert.throws(() => parseMarketSignalLoopInput({ ...validInput(), surprise: true }), /unsupported fields/);
});

test("terminal output is private, hash-bound, and contains only priced comparisons", () => {
  const output = validOutput();
  assert.deepEqual(parseMarketSignalLoopOutput(output), output);
  const emptyPriceLeak = validOutput({ metrics: { ...output.metrics, pricedComparisons: 19 } });
  assert.throws(() => parseMarketSignalLoopOutput(emptyPriceLeak), /Every published comparison must have a supported price/);
  const publicPath = validOutput({ report: { ...output.report, ownerPath: `/shared/${"f".repeat(32)}` } });
  assert.throws(() => parseMarketSignalLoopOutput(publicPath), /private owner path/);
  assert.throws(() => parseMarketSignalLoopOutput(validOutput({ productPlan: "solo" })), /target does not match/);
  assert.throws(() => parseMarketSignalLoopOutput(validOutput({ artifacts: output.artifacts.slice(0, 1) })), /comparison artifact/);
});

test("another agent can call the finite function through one injected workflow adapter", async () => {
  const calls = [];
  const output = await callMarketSignalLoop(validInput(), {
    async run(input) {
      calls.push(input);
      const { contractVersion, functionId, functionVersion, requestId, ...result } = validOutput();
      assert.equal(contractVersion, "1");
      assert.equal(functionId, "market-signal.report");
      assert.equal(functionVersion, "1");
      assert.equal(requestId, input.requestId);
      return result;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(output.status, "complete");
  assert.equal(output.metrics.publishedComparisons, 20);
  assert.equal(output.primaryDomain, "myjam.co.uk");
  assert.equal(output.productPlan, "starter");
});

test("the adapter binds identity, domain, plan, and comparison target to the accepted input", async () => {
  await assert.rejects(() => callMarketSignalLoop(validInput(), {
    async run() {
      const { contractVersion, functionId, functionVersion, requestId, ...result } = validOutput({
        requestId: "spoofed-request",
        primaryDomain: "spoofed.example",
        metrics: { ...validOutput().metrics, comparisonTarget: 50 },
      });
      assert.equal(contractVersion, "1");
      assert.equal(functionId, "market-signal.report");
      assert.equal(functionVersion, "1");
      assert.equal(requestId, "spoofed-request");
      return result;
    },
  }), /different comparison target/);
});

test("stored production evidence for a real limited report maps into the callable output", () => {
  const evidence = JSON.parse(readFileSync(new URL("../docs/tasks/134-twenty-brand-production-results.json", import.meta.url), "utf8"));
  const report = evidence.reports.find((candidate) => candidate.domain === "wearform.com");
  assert.ok(report);
  assert.equal(report.documentAvailable, true);
  assert.equal(report.missingRivalPriceViolations, 0);
  const acceptedCompetitorCount = new Set(report.acceptedPairEvidence.map((pair) => pair.rivalDomain)).size;
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const output = parseMarketSignalLoopOutput(validOutput({
    requestId: "validation:wearform:production",
    primaryDomain: report.domain,
    runId: "validation:wearform:production",
    status: report.status,
    report: {
      publicId: report.reportId,
      ownerPath: `/reports/${report.reportId}`,
      status: report.status,
      completedPhases: ["crawl", "matching", "persistence"],
      limitedPhases: ["comparison_target"],
    },
    artifacts: [
      { kind: "report", schemaVersion: "production_evidence_v1", reference: `evidence-file:wearform-report-${report.reportId}`, contentHash: digest(report), mediaType: "application/json", recordCount: 1 },
      { kind: "comparisons", schemaVersion: "production_evidence_v1", reference: `evidence-file:wearform-comparisons-${report.reportId}`, contentHash: digest(report.acceptedPairEvidence), mediaType: "application/json", recordCount: report.acceptedPricedMatches },
    ],
    metrics: {
      comparisonTarget: report.productLimit,
      publishedComparisons: report.acceptedPricedMatches,
      pricedComparisons: report.acceptedPricedMatches,
      competitorCount: acceptedCompetitorCount,
      repairRounds: 0,
      usageStatus: "unknown",
      costMicrousd: null,
      durationMs: report.runtimeSeconds * 1_000,
    },
    startedAt: report.createdAt,
    finishedAt: report.completedAt,
  }));
  assert.equal(output.status, "limited");
  assert.equal(output.metrics.publishedComparisons, 17);
  assert.equal(output.metrics.competitorCount, 1);
});

test("the graph has two independently bounded back-edges", () => {
  assert.deepEqual(validateMarketSignalLoopGraph(), { valid: true, issues: [] });
  assert.equal(MARKET_SIGNAL_LOOP_GRAPH.maximumReportRepairRounds, 3);
  assert.equal(MARKET_SIGNAL_LOOP_GRAPH.maximumImprovementAttempts, 3);
  assert.deepEqual(MARKET_SIGNAL_LOOP_GRAPH.edges.filter((edge) => edge.loopBack).map((edge) => [edge.from, edge.to, edge.guard]), [
    ["report.quality_feedback", "comparison.search", "repairRound <= 3 and feedbackHash is distinct"],
    ["candidate.revert", "candidate.implement", "attemptNumber < 3 and next candidateHash is distinct"],
  ]);
});

test("callable outputs expose a bounded report repair count", () => {
  assert.equal(parseMarketSignalLoopOutput(validOutput({ metrics: { ...validOutput().metrics, repairRounds: 3 } })).metrics.repairRounds, 3);
  assert.throws(() => parseMarketSignalLoopOutput(validOutput({ metrics: { ...validOutput().metrics, repairRounds: 4 } })), /cannot exceed three/);
});

test("a measurably better candidate is kept and ends the cycle", () => {
  const result = decideMarketSignalImprovement(improvementAttempt(1));
  assert.equal(result.decision, "keep");
  assert.equal(result.stateAction, "keep_candidate");
  assert.equal(result.terminal, true);
  assert.deepEqual(result.improvedMetrics, ["comparison_target_fill_rate"]);
});

test("a failed first candidate restores baseline and allows attempt two", () => {
  const input = improvementAttempt(1);
  input.metrics = input.metrics.map((metric) => ({ ...metric, candidate: metric.baseline }));
  const result = decideMarketSignalImprovement(input);
  assert.equal(result.decision, "revert");
  assert.equal(result.stateAction, "restore_baseline");
  assert.equal(result.retryAllowed, true);
  assert.equal(result.nextAttemptNumber, 2);
  assert.equal(result.remainingAttempts, 2);
});

test("the third failed candidate restores baseline and cannot create attempt four", () => {
  const input = improvementAttempt(3);
  input.metrics = input.metrics.map((metric) => ({ ...metric, candidate: metric.baseline }));
  const result = decideMarketSignalImprovement(input);
  assert.equal(result.decision, "revert");
  assert.equal(result.terminal, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(result.nextAttemptNumber, null);
  assert.equal(result.remainingAttempts, 0);
  assert.throws(() => decideMarketSignalImprovement(improvementAttempt(4)), /between one and three/);
});

test("hard regressions revert and incomparable evidence stops for human review", () => {
  const guardrailFailure = improvementAttempt(1);
  guardrailFailure.guardrails = guardrailFailure.guardrails.map((guardrail) => guardrail.key === "zero_empty_prices" ? { ...guardrail, passed: false, detail: "one empty price" } : guardrail);
  assert.deepEqual(decideMarketSignalImprovement(guardrailFailure).failedGuardrails, ["zero_empty_prices"]);

  const incomparable = improvementAttempt(1, { candidateBenchmarkVersion: "benchmark-v2" });
  const result = decideMarketSignalImprovement(incomparable);
  assert.equal(result.decision, "human_review");
  assert.equal(result.reasonCode, "incomparable_benchmark");
  assert.equal(result.terminal, true);
});

test("repeating a prior candidate cannot satisfy the improvement loop", () => {
  const input = improvementAttempt(2, { candidateArtifactHash: hash("c") });
  const result = decideMarketSignalImprovement(input);
  assert.equal(result.decision, "revert");
  assert.equal(result.reasonCode, "duplicate_candidate");
  assert.equal(result.nextAttemptNumber, 3);
});

test("cycle cost and deadline bounds stop retries even before attempt three", () => {
  const budget = decideMarketSignalImprovement(improvementAttempt(1, { spentCycleCostMicrousd: 100_000 }));
  assert.equal(budget.reasonCode, "cycle_budget_exhausted");
  assert.equal(budget.terminal, true);
  assert.equal(budget.retryAllowed, false);

  const deadline = decideMarketSignalImprovement(improvementAttempt(1, { evaluatedAt: "2026-09-03T00:00:00.000Z" }));
  assert.equal(deadline.reasonCode, "cycle_deadline_reached");
  assert.equal(deadline.terminal, true);
});
