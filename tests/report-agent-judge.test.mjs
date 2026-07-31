import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_AGENT_LIMITS,
  REPORT_AGENT_PRICING_VERSION,
  buildReportAgentJudgeRequest,
  buildReportAgentPacket,
  calculateReportAgentCost,
  canonicalReportAgentJSON,
  computeHybridReportScore,
  parseReportAgentJudgeResponse,
  reserveReportAgentCost,
  validateReportAgentOutput,
} from "../app/lib/report-agent-judge.ts";

function evidence() {
  return [
    { id: "evidence-1", claimType: "observed", excerpt: "Observed competitor offer and useful product comparison.", sourceRole: "competitor", sourceDomain: "rival.example", observedDate: "2026-07-31" },
    { id: "evidence-2", claimType: "observed", excerpt: "Observed action evidence with price 12.50.", sourceRole: "primary", sourceDomain: "shop.example", observedDate: "2026-07-31" },
  ];
}

function score(points, reason = "The supplied evidence supports this conclusion.", evidenceIds = ["evidence-1"]) {
  return { points, reason, evidenceIds };
}

function validOutput() {
  return {
    scores: {
      userValue: {
        competitorUsefulness: score(8),
        commercialComparisonUsefulness: score(12),
        actionSpecificityAndPriority: score(11),
      },
      evidenceIntegrity: {
        uncertaintyAndClaimTypeHonesty: score(9),
        evidenceBoundedRecommendations: score(8),
      },
      presentationUtility: {
        prioritizationAndHierarchy: score(20),
        decisionClarity: score(21),
        topThreeActionClarity: score(16),
      },
    },
    findings: [{ code: "comparison-utility", severity: "warning", reason: "The comparison is useful but could be more specific.", evidenceIds: ["evidence-1"] }],
    proposals: [{ priority: "high", reason: "Prioritize the evidence-backed product comparison.", evidenceIds: ["evidence-1"] }],
  };
}

function response(output = validOutput(), usage = { input_tokens: 1_000, output_tokens: 200, input_tokens_details: { cached_tokens: 100 } }) {
  return { status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }], usage };
}

function formula(scoreValue, points = scoreValue) {
  return { score: scoreValue, points };
}

function perfectDeterministicProfile(hardCaps = []) {
  return {
    components: {
      userValue: { facts: formula(60, 60) },
      evidenceIntegrity: { facts: formula(80, 80) },
      evidenceYield: { facts: formula(100, 100) },
      presentation: { facts: formula(30, 30) },
    },
    hardCaps,
  };
}

function perfectJudge() {
  const output = validOutput();
  output.scores.userValue.competitorUsefulness.points = 10;
  output.scores.userValue.commercialComparisonUsefulness.points = 15;
  output.scores.userValue.actionSpecificityAndPriority.points = 15;
  output.scores.evidenceIntegrity.uncertaintyAndClaimTypeHonesty.points = 10;
  output.scores.evidenceIntegrity.evidenceBoundedRecommendations.points = 10;
  output.scores.presentationUtility.prioritizationAndHierarchy.points = 25;
  output.scores.presentationUtility.decisionClarity.points = 25;
  output.scores.presentationUtility.topThreeActionClarity.points = 20;
  return output;
}

test("the canonical allowlist packet enforces record, excerpt, URL, ordering, and byte bounds", () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    id: `evidence-${String(100 - index).padStart(3, "0")}`,
    claimType: "observed",
    excerpt: `See https://secret.example/path, ftp://files.example/private, mailto:user@example.com, //cdn.example/private, and www.hidden.example ${"x".repeat(900)}`,
    sourceRole: "competitor",
    sourceDomain: `https://rival${index}.example/products/private`,
    observedAt: "2026-07-31T00:00:00.000Z",
    relevance: { rank: index, accepted: true, ignoredObject: { unsafe: true } },
  }));
  const input = {
    report: { businessType: "ecommerce", terminalStatus: "complete", summary: `Summary https://shop.example/private ${"s".repeat(2_000)}` },
    deterministicProfile: { evaluatorVersion: "v1", components: {}, raw: { competitors: 3 }, hardCaps: [] },
    evidence: records,
    comparisons: Array.from({ length: 20 }, (_, index) => ({ id: `comparison-${index}`, text: "Comparison", evidenceIds: ["evidence-001"] })),
    actions: Array.from({ length: 20 }, (_, index) => ({ id: `action-${index}`, text: "Action", evidenceIds: ["evidence-001"] })),
    gaps: Array.from({ length: 25 }, (_, index) => ({ id: `gap-${index}`, phase: "crawl", reason: "Unavailable" })),
  };

  const first = buildReportAgentPacket(input);
  const second = buildReportAgentPacket({ ...input, evidence: [...records].reverse() });
  assert.equal(first.packet.evidence.length <= 80, true);
  assert.equal(first.packet.candidates.length, 30);
  assert.equal(first.packet.gaps.length, 20);
  assert.equal(first.packet.evidence.every((item) => item.excerpt.length <= 500), true);
  assert.deepEqual(first.packet.evidence.map((item) => item.id), [...first.packet.evidence.map((item) => item.id)].sort());
  assert.equal(first.byteLength <= REPORT_AGENT_LIMITS.packetBytes, true);
  assert.equal(first.canonicalJson.includes("https://"), false);
  assert.equal(first.canonicalJson.includes("ftp://"), false);
  assert.equal(first.canonicalJson.includes("mailto:"), false);
  assert.equal(first.canonicalJson.includes("//cdn.example"), false);
  assert.equal(first.canonicalJson.includes("www.hidden.example"), false);
  assert.equal(first.canonicalJson.includes("/products/private"), false);
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.canonicalJson, canonicalReportAgentJSON(first.packet));
});

test("the request is tool-free, strict-schema, frozen, and output bounded", () => {
  const packet = buildReportAgentPacket({ evidence: evidence() });
  const built = buildReportAgentJudgeRequest({ packet });
  assert.equal(built.accepted, true);
  assert.equal(built.request.max_output_tokens, 2_000);
  assert.equal("tools" in built.request, false);
  assert.equal(built.request.text.format.type, "json_schema");
  assert.equal(built.request.text.format.strict, true);
  assert.equal(built.request.text.format.schema.additionalProperties, false);
  assert.equal(built.timeoutMs, 45_000);
  assert.equal(built.responseByteLimit, 64 * 1024);

  const unpriced = buildReportAgentJudgeRequest({ model: "other-model", packet });
  assert.equal(unpriced.accepted, false);
  assert.equal(unpriced.errorCode, "unpriced-evaluator-model");
});

test("the request rejects arbitrary, noncanonical, and URL-bearing packet shapes", () => {
  const arbitrary = buildReportAgentJudgeRequest({ packet: "{\"rawUrl\":\"https://secret.example/private\"}" });
  assert.equal(arbitrary.accepted, false);
  assert.equal(arbitrary.errorCode, "invalid-agent-packet");

  const built = buildReportAgentPacket({ evidence: evidence() });
  const mismatched = buildReportAgentJudgeRequest({ packet: { ...built, byteLength: built.byteLength + 1 } });
  assert.equal(mismatched.accepted, false);
  assert.equal(mismatched.errorCode, "invalid-agent-packet");

  const urlPacket = structuredClone(built);
  urlPacket.packet.report.summary = "Read ftp://secret.example/private";
  urlPacket.canonicalJson = canonicalReportAgentJSON(urlPacket.packet);
  urlPacket.byteLength = new TextEncoder().encode(urlPacket.canonicalJson).byteLength;
  const urlResult = buildReportAgentJudgeRequest({ packet: urlPacket });
  assert.equal(urlResult.accepted, false);
  assert.equal(urlResult.errorCode, "invalid-agent-packet");
});

test("frozen Luna reservation and actual cached-token cost use microusd math", () => {
  const reservation = reserveReportAgentCost();
  assert.deepEqual(reservation, {
    accepted: true,
    pricingVersion: REPORT_AGENT_PRICING_VERSION,
    costMicrousd: 14_400,
    costWithRegionalUpliftMicrousd: 15_840,
  });
  assert.equal(reservation.costWithRegionalUpliftMicrousd <= 20_000, true);
  assert.deepEqual(calculateReportAgentCost(60_000, 2_000, 0), { costMicrousd: 14_400, costWithRegionalUpliftMicrousd: 15_840 });
  assert.deepEqual(calculateReportAgentCost(1_000, 200, 100), { costMicrousd: 422, costWithRegionalUpliftMicrousd: 465 });
});

test("Responses output and usage parse from nested output text", () => {
  const parsed = parseReportAgentJudgeResponse(response(), evidence());
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.result.findings.length, 1);
  assert.deepEqual(parsed.usage, {
    inputTokens: 1_000,
    cachedInputTokens: 100,
    uncachedInputTokens: 900,
    outputTokens: 200,
    totalTokens: 1_200,
    costMicrousd: 422,
    costWithRegionalUpliftMicrousd: 465,
  });
});

test("unknown evidence IDs reject without throwing", () => {
  const output = validOutput();
  output.findings[0].evidenceIds = ["unknown-id"];
  const parsed = parseReportAgentJudgeResponse(response(output), evidence());
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.errorCode, "unknown-evidence-id");
});

test("malformed and incomplete output return explicit rejection codes", () => {
  const malformed = parseReportAgentJudgeResponse({ status: "completed", output_text: "{bad", usage: { input_tokens: 10, output_tokens: 10 } }, evidence());
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.errorCode, "malformed-agent-output");
  const incomplete = parseReportAgentJudgeResponse({ status: "incomplete", usage: { input_tokens: 10, output_tokens: 10 } }, evidence());
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.errorCode, "incomplete-agent-output");
});

test("every Responses status except completed is rejected", () => {
  for (const status of ["failed", "cancelled", "queued", "in_progress", undefined]) {
    const parsed = parseReportAgentJudgeResponse({ ...response(), status }, evidence());
    assert.equal(parsed.accepted, false);
    assert.equal(parsed.errorCode, "agent-response-not-completed");
  }
});

test("uncited conclusions and unsupported numeric assertions are rejected", () => {
  const uncited = validOutput();
  uncited.proposals[0].evidenceIds = [];
  const uncitedResult = validateReportAgentOutput(uncited, evidence());
  assert.equal(uncitedResult.accepted, false);
  assert.equal(uncitedResult.errorCode, "uncited-conclusion");

  const numeric = validOutput();
  numeric.findings[0].reason = "The report claims a 45 percent advantage.";
  const numericResult = validateReportAgentOutput(numeric, evidence());
  assert.equal(numericResult.accepted, false);
  assert.equal(numericResult.errorCode, "unsupported-numeric-claim");

  const collision = validOutput();
  collision.scores.userValue.competitorUsefulness.reason = "The offer is 2 times better.";
  collision.scores.userValue.competitorUsefulness.evidenceIds = ["evidence-2"];
  const collisionResult = validateReportAgentOutput(collision, evidence());
  assert.equal(collisionResult.accepted, false);
  assert.equal(collisionResult.errorCode, "unsupported-numeric-claim");
});

test("finding, proposal, citation, reason, and score-allocation bounds are enforced", () => {
  const tooManyFindings = validOutput();
  tooManyFindings.findings = Array.from({ length: 13 }, () => structuredClone(tooManyFindings.findings[0]));
  assert.equal(validateReportAgentOutput(tooManyFindings, evidence()).accepted, false);

  const tooManyProposals = validOutput();
  tooManyProposals.proposals = Array.from({ length: 4 }, () => structuredClone(tooManyProposals.proposals[0]));
  assert.equal(validateReportAgentOutput(tooManyProposals, evidence()).accepted, false);

  const tooManyCitations = validOutput();
  tooManyCitations.findings[0].evidenceIds = ["evidence-1", "evidence-2", "evidence-3", "evidence-4", "evidence-5", "evidence-6"];
  assert.equal(validateReportAgentOutput(tooManyCitations, evidence()).errorCode, "uncited-conclusion");

  const longReason = validOutput();
  longReason.findings[0].reason = "x".repeat(501);
  assert.equal(validateReportAgentOutput(longReason, evidence()).errorCode, "agent-schema-invalid");

  const excessiveScore = validOutput();
  excessiveScore.scores.userValue.competitorUsefulness.points = 10.0001;
  const scoreResult = validateReportAgentOutput(excessiveScore, evidence());
  assert.equal(scoreResult.accepted, false);
  assert.equal(scoreResult.errorCode, "score-allocation-exceeded");
});

test("hybrid dimensions use Task 086 weights and the lowest hard cap", () => {
  const result = computeHybridReportScore({
    deterministicProfile: perfectDeterministicProfile([
      { issueKey: "no-defensible-product-pair", maximumOverallScore: 55 },
      { issueKey: "unsupported-material-claims", maximumOverallScore: 30 },
    ]),
    judge: perfectJudge(),
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.dimensions, { userValue: 100, evidenceIntegrity: 100, evidenceYield: 100, presentationUtility: 100 });
  assert.equal(result.weightedOverall, 100);
  assert.equal(result.appliedHardCap, 30);
  assert.equal(result.overallScore, 30);
  assert.equal(result.grade, "F");
});

test("overall scoring rounds half-up before assigning the frozen grade", () => {
  const judge = perfectJudge();
  judge.scores.userValue.competitorUsefulness.points = 10;
  judge.scores.userValue.commercialComparisonUsefulness.points = 3.75;
  judge.scores.userValue.actionSpecificityAndPriority.points = 0;
  const result = computeHybridReportScore({ deterministicProfile: perfectDeterministicProfile(), judge });
  assert.equal(result.accepted, true);
  assert.equal(result.dimensions.userValue, 73.75);
  assert.equal(result.weightedOverall, 89.5);
  assert.equal(result.overallScore, 90);
  assert.equal(result.grade, "A");
});

test("weighted totals immediately below a half boundary are not rounded prematurely", () => {
  const judge = perfectJudge();
  judge.scores.userValue.competitorUsefulness.points = 10;
  judge.scores.userValue.commercialComparisonUsefulness.points = 3.7499;
  judge.scores.userValue.actionSpecificityAndPriority.points = 0;
  const result = computeHybridReportScore({ deterministicProfile: perfectDeterministicProfile(), judge });
  assert.equal(result.accepted, true);
  assert.equal(result.dimensions.userValue, 73.7499);
  assert.equal(result.weightedOverall, 89.49996);
  assert.equal(result.overallScore, 89);
  assert.equal(result.grade, "B");
});
