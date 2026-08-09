import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import {
  beginReportEvaluationDispatch,
  completeReportAgentEvaluation,
  createReportRun,
  finalizeReportFactManifest,
  getReportEvaluation,
  listHumanReviewRequests,
  reconcileReportEvaluations,
  reserveReportAgentEvaluation,
  saveReportDocument,
  saveReportFactChunk,
  submitHumanReviewResponse,
} from "../app/lib/report-store.ts";
import {
  REPORT_EVALUATION_MODEL,
  REPORT_EVALUATION_PRICING_VERSION,
  REPORT_EVALUATION_PROMPT_VERSION,
} from "../src/shared/report-evaluation-contract.ts";
import { buildReportFactBundle } from "../src/shared/report-facts.ts";

const LEGACY_EVALUATIONS_SCHEMA = `CREATE TABLE report_evaluations (
  id text PRIMARY KEY NOT NULL, run_id text NOT NULL, evaluation_type text NOT NULL,
  input_hash text NOT NULL, fact_manifest_hash text DEFAULT '' NOT NULL,
  evaluator_version text NOT NULL, rubric_version text NOT NULL, status text NOT NULL,
  rating_basis text NOT NULL, overall_score integer, user_value_score integer,
  evidence_integrity_score integer, evidence_yield_score integer, presentation_score integer,
  deterministic_score integer, grade text, deterministic_json text DEFAULT '{}' NOT NULL,
  agent_json text DEFAULT '{}' NOT NULL, findings_json text DEFAULT '[]' NOT NULL,
  proposals_json text DEFAULT '[]' NOT NULL, model text DEFAULT '' NOT NULL,
  prompt_version text DEFAULT '' NOT NULL, pricing_version text DEFAULT '' NOT NULL,
  cost_microusd integer DEFAULT 0 NOT NULL, input_tokens integer DEFAULT 0 NOT NULL,
  output_tokens integer DEFAULT 0 NOT NULL, error_code text DEFAULT '' NOT NULL,
  dispatch_attempts integer DEFAULT 0 NOT NULL, created_at text NOT NULL,
  started_at text DEFAULT '' NOT NULL, completed_at text DEFAULT '' NOT NULL
)`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-evaluation-store-"));
  const database = await NodeSqliteDatabase.open(join(directory, "market-signal.sqlite"));
  return { directory, database };
}

async function closeFixture(value) {
  value.database.close();
  await rm(value.directory, { recursive: true, force: true });
}

async function preparedEvaluation(database, suffix, now = new Date("2026-08-09T10:00:00.000Z")) {
  const primaryDomain = `shop-${suffix}.example`;
  const rivalDomain = `rival-${suffix}.example`;
  const created = await createReportRun({ primaryDomain }, now, database);
  const primary = {
    id: `primary-${suffix}`,
    domain: primaryDomain,
    name: "Observed product",
    normalizedName: "observed product",
    priceSignals: [{ raw: "GBP 10.00", currency: "GBP", amount: 10 }],
    sourceUrl: `https://${primaryDomain}/products/observed`,
    imageUrl: `https://${primaryDomain}/images/observed.jpg`,
    observedAt: now.toISOString(),
  };
  const rival = {
    ...primary,
    id: `rival-${suffix}`,
    domain: rivalDomain,
    priceSignals: [{ raw: "GBP 9.00", currency: "GBP", amount: 9 }],
    sourceUrl: `https://${rivalDomain}/products/observed`,
    imageUrl: `https://${rivalDomain}/images/observed.jpg`,
  };
  const bundle = await buildReportFactBundle({
    publicId: created.publicId,
    crawlResults: [
      { domain: primaryDomain, role: "primary", homepage: { sourceUrl: `https://${primaryDomain}/`, title: "Primary shop" }, products: [primary], fetchedAt: now.toISOString() },
      { domain: rivalDomain, role: "discovered-competitor", homepage: { sourceUrl: `https://${rivalDomain}/`, title: "Rival shop" }, products: [rival], fetchedAt: now.toISOString() },
    ],
    comparison: {
      primaryDomain,
      comparisonDomains: [rivalDomain],
      rows: [{
        primary,
        matches: [{
          domain: rivalDomain,
          product: rival,
          score: 0.95,
          confidence: "High",
          sharedTerms: ["observed", "product"],
          claimIds: [],
          decision: { recommendedMove: "Compare the observed public prices." },
          assessment: {
            method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.95,
            model: "test-model", promptVersion: "test-v1", reasons: ["Names and variants align."],
            contradictions: [], normalizedCategory: "test", normalizedVariant: "", normalizedSize: "",
            primarySourceUrl: primary.sourceUrl, rivalSourceUrl: rival.sourceUrl,
          },
        }],
      }],
      unmatched: [],
      coverage: {
        primaryProductsAvailable: 1, primaryProductsScanned: 1, primaryProductFamiliesCompared: 1,
        competitorProductsAvailable: 1, competitorProductsScanned: 1, assignedPairCount: 1,
        verifiedPairCount: 1, rowsReturned: 1, rowLimit: 1, truncated: false,
      },
    },
    adBlock: { observedAt: now.toISOString(), companies: [] },
    observedAt: now.toISOString(),
  });
  for (const chunk of bundle.chunks) await saveReportFactChunk(created.publicId, chunk, now, database);
  await finalizeReportFactManifest(created.publicId, bundle.manifest, now, database);
  await saveReportDocument(created.publicId, {
    blocks: [
      { type: "summary", id: "summary", title: "Observed market comparison", body: "A concise public-source report." },
      { type: "product-comparison", id: "products", title: "Products" },
    ],
  }, { status: "complete" }, now, database);
  const evaluation = await getReportEvaluation(created.publicId, database);
  assert.equal(evaluation.status, "deterministic");
  return { created, evaluation };
}

function evidenceOf(envelope, ...types) {
  const record = envelope.evidence.find((item) => types.includes(item.type));
  assert.ok(record, `expected evidence of type ${types.join(" or ")}`);
  return record;
}

function validAgentOutput(canonicalInput, humanReview = null) {
  const envelope = JSON.parse(canonicalInput);
  const company = evidenceOf(envelope, "company", "gap");
  const product = evidenceOf(envelope, "match", "product");
  const recommendation = evidenceOf(envelope, "recommendation", "match", "product", "company");
  const uncertainty = evidenceOf(envelope, "gap", "company", "product", "match");
  const presentation = evidenceOf(envelope, "presentation", "recommendation", "gap");
  const scored = (score, reason, evidence) => ({ score, reason, evidenceIds: [evidence.id] });
  return {
    scores: {
      competitorUsefulness: scored(8, "The competitor evidence is useful.", company),
      productComparisonUsefulness: scored(12, "The product comparison is useful.", product),
      recommendationSpecificity: scored(12, "The recommendation is specific.", recommendation),
      uncertaintyHonesty: scored(8, "The evidence boundary is clear.", uncertainty),
      recommendationGrounding: scored(8, "The recommendation is grounded.", recommendation),
      prioritizationHierarchy: scored(20, "The report hierarchy is clear.", presentation),
      decisionClarity: scored(20, "The decision path is clear.", presentation),
      topActionsIdentifiable: scored(16, "The main action is identifiable.", presentation),
    },
    strengths: [],
    weaknesses: [],
    proposals: [],
    humanReview: humanReview ? {
      uncertaintyCode: "subjective_usefulness",
      question: "Is this comparison useful for your decision?",
      evidenceIds: [company.id],
    } : null,
  };
}

function terminalCallback(reservation, dispatch, overrides = {}) {
  return {
    action: "terminal",
    evaluatorVersion: dispatch.evaluatorVersion,
    dispatchAttempt: dispatch.dispatchAttempt,
    reservationOwner: "trigger-worker",
    reservationId: reservation.reservationId,
    clientRequestId: reservation.clientRequestId,
    status: "complete",
    errorCode: null,
    providerResponseId: "resp_test",
    providerRequestId: "req_test",
    usageStatus: "known",
    usage: { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200 },
    agentOutput: validAgentOutput(reservation.canonicalInput),
    model: REPORT_EVALUATION_MODEL,
    promptVersion: REPORT_EVALUATION_PROMPT_VERSION,
    pricingVersion: REPORT_EVALUATION_PRICING_VERSION,
    ...overrides,
  };
}

async function dispatchAndReserve(database, evaluation, now) {
  const dispatch = await beginReportEvaluationDispatch(evaluation.id, now, database);
  const reservation = await reserveReportAgentEvaluation(evaluation.id, {
    evaluatorVersion: dispatch.evaluatorVersion,
    dispatchAttempt: dispatch.dispatchAttempt,
    reservationOwner: "trigger-worker",
    clientRequestId: `request-${evaluation.id}`,
  }, now, database);
  assert.equal(reservation.ok, true);
  return { dispatch, reservation };
}

test("runtime schema initialization upgrades legacy report_evaluations in place", async () => {
  const value = await fixture();
  try {
    await value.database.prepare(LEGACY_EVALUATIONS_SCHEMA).run();
    await value.database.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, evaluator_version, rubric_version, status, rating_basis, cost_microusd, input_tokens, output_tokens, created_at, completed_at) VALUES ('legacy-evaluation', 'legacy-run', 'report', 'legacy-hash', 'ecommerce-deterministic-v1', 'ecommerce-v1', 'deterministic', 'deterministic_only', 1200, 800, 100, '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z')`).run();
    await createReportRun({ primaryDomain: "legacy.example" }, new Date("2026-08-09T09:00:00.000Z"), value.database);
    const columns = await value.database.prepare("PRAGMA table_info(report_evaluations)").all();
    const names = new Set(columns.results.map((column) => column.name));
    for (const name of ["cached_input_tokens", "usage_status", "reserved_cost_microusd", "deterministic_at", "dispatch_started_at", "dispatch_token", "dispatch_failed_at", "watchdog_expired_at", "reservation_id", "reservation_owner", "reserved_at", "client_request_id", "provider_response_id", "provider_request_id"]) {
      assert.equal(names.has(name), true, `legacy schema should gain ${name}`);
    }
    const migrated = (await value.database.prepare("SELECT deterministic_at, usage_status, cost_microusd, input_tokens, output_tokens FROM report_evaluations WHERE id = 'legacy-evaluation'").all()).results[0];
    assert.deepEqual(migrated, { deterministic_at: "2026-08-01T00:01:00.000Z", usage_status: "known", cost_microusd: 1200, input_tokens: 800, output_tokens: 100 });
    const artifacts = await value.database.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'report_human_review_%' ORDER BY type, name").all();
    for (const name of ["report_human_review_requests", "report_human_review_responses", "report_human_review_open", "report_human_review_requests_immutable", "report_human_review_responses_immutable"]) assert.ok(artifacts.results.some((item) => item.name === name), name);
    const migration = await readFile(new URL("../drizzle/0010_slimy_jack_power.sql", import.meta.url), "utf8");
    assert.match(migration, /report_human_review_open/);
    assert.match(migration, /report_human_review_requests_immutable/);
    assert.match(migration, /CHECK \(`resolution_code` IN/);
  } finally {
    await closeFixture(value);
  }
});

test("evaluation persists deterministic, dispatching, reserved, and complete states and declines duplicate reservation", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const { created, evaluation } = await preparedEvaluation(value.database, "complete", now);
    const dispatch = await beginReportEvaluationDispatch(evaluation.id, new Date(now.getTime() + 1_000), value.database);
    assert.equal((await getReportEvaluation(created.publicId, value.database)).status, "dispatching");
    const reservation = await reserveReportAgentEvaluation(evaluation.id, {
      evaluatorVersion: dispatch.evaluatorVersion,
      dispatchAttempt: dispatch.dispatchAttempt,
      reservationOwner: "trigger-worker",
      clientRequestId: "request-complete",
    }, new Date(now.getTime() + 2_000), value.database);
    assert.equal(reservation.ok, true);
    assert.equal((await getReportEvaluation(created.publicId, value.database)).status, "reserved");
    assert.deepEqual(await reserveReportAgentEvaluation(evaluation.id, {
      evaluatorVersion: dispatch.evaluatorVersion,
      dispatchAttempt: dispatch.dispatchAttempt,
      reservationOwner: "other-worker",
      clientRequestId: "request-duplicate",
    }, new Date(now.getTime() + 3_000), value.database), { ok: false, code: "already_reserved" });

    const completed = await completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch), new Date(now.getTime() + 4_000), value.database);
    assert.equal(completed.status, "complete");
    assert.equal(completed.ratingBasis, "hybrid");
    assert.ok(Number.isFinite(completed.overallScore));
    assert.ok(completed.grade);
    assert.equal(completed.usageStatus, "known");
    assert.deepEqual({ input: completed.inputTokens, cached: completed.cachedInputTokens, output: completed.outputTokens, cost: completed.costMicrousd }, { input: 1_000, cached: 400, output: 200, cost: 1_380 });
  } finally {
    await closeFixture(value);
  }
});

test("invalid evidence callback is terminally rejected and unknown usage maps to null actuals", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T11:00:00.000Z");
    const { created, evaluation } = await preparedEvaluation(value.database, "rejected", now);
    const { dispatch, reservation } = await dispatchAndReserve(value.database, evaluation, new Date(now.getTime() + 1_000));
    const invalid = validAgentOutput(reservation.canonicalInput);
    invalid.scores.competitorUsefulness.evidenceIds = ["evidence:missing"];
    const rejected = await completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch, {
      agentOutput: invalid,
    }), new Date(now.getTime() + 2_000), value.database);
    assert.equal(rejected.status, "agent_rejected");
    assert.equal(rejected.errorCode, "invalid-agent-result");
    assert.equal(rejected.usageStatus, "known");

    const unknownFixture = await preparedEvaluation(value.database, "unknown-usage", new Date(now.getTime() + 3_000));
    const unknownReservation = await dispatchAndReserve(value.database, unknownFixture.evaluation, new Date(now.getTime() + 4_000));
    const unknown = await completeReportAgentEvaluation(unknownFixture.evaluation.id, terminalCallback(unknownReservation.reservation, unknownReservation.dispatch, {
      status: "agent_rejected", errorCode: "provider-http-5xx", usageStatus: "unknown", usage: null, agentOutput: null,
    }), new Date(now.getTime() + 5_000), value.database);
    assert.equal(unknown.usageStatus, "unknown");
    assert.equal(unknown.status, "agent_rejected");
    assert.equal(unknown.costMicrousd, null);
    assert.equal(unknown.inputTokens, null);
    assert.equal(unknown.cachedInputTokens, null);
    assert.equal(unknown.outputTokens, null);

    const malformedFixture = await preparedEvaluation(value.database, "malformed-usage", new Date(now.getTime() + 6_000));
    const malformedReservation = await dispatchAndReserve(value.database, malformedFixture.evaluation, new Date(now.getTime() + 7_000));
    const malformed = await completeReportAgentEvaluation(malformedFixture.evaluation.id, terminalCallback(malformedReservation.reservation, malformedReservation.dispatch, {
      status: "agent_rejected", errorCode: "provider-output-rejected", usageStatus: "known", usage: null, agentOutput: null,
    }), new Date(now.getTime() + 8_000), value.database);
    assert.equal(malformed.usageStatus, "unknown");
    assert.equal(malformed.costMicrousd, null);
    assert.equal((await getReportEvaluation(created.publicId, value.database)).status, "agent_rejected");
  } finally {
    await closeFixture(value);
  }
});

test("needs-human evaluation creates an immutable owner queue item and response without changing the provisional score", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const { evaluation } = await preparedEvaluation(value.database, "human", now);
    const { dispatch, reservation } = await dispatchAndReserve(value.database, evaluation, new Date(now.getTime() + 1_000));
    const provisional = await completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch, {
      status: "needs_human_review",
      agentOutput: validAgentOutput(reservation.canonicalInput, true),
    }), new Date(now.getTime() + 2_000), value.database);
    assert.equal(provisional.status, "needs_human_review");
    assert.equal(provisional.ratingBasis, "deterministic_only");
    assert.equal(provisional.overallScore, null);
    assert.equal(provisional.grade, null);
    assert.ok(provisional.agent.humanReview);
    assert.equal(provisional.usageStatus, "known");
    assert.equal(provisional.costMicrousd, 1_380);
    const pending = await listHumanReviewRequests({}, value.database);
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0].evaluationId, evaluation.id);
    assert.equal(pending.items[0].question, "Is this comparison useful for your decision?");
    assert.equal(pending.items[0].response, null);
    const agentBefore = structuredClone(provisional.agent);

    const answered = await submitHumanReviewResponse(pending.items[0].id, {
      idempotencyKey: "owner:human-test-1",
      resolutionCode: "answered",
      answerText: "Yes. This comparison is useful for the pricing decision.",
    }, new Date(now.getTime() + 3_000), value.database);
    assert.equal(answered.replayed, false);
    const replay = await submitHumanReviewResponse(pending.items[0].id, {
      idempotencyKey: "owner:human-test-1",
      resolutionCode: "answered",
      answerText: "Yes. This comparison is useful for the pricing decision.",
    }, new Date(now.getTime() + 4_000), value.database);
    assert.equal(replay.replayed, true);
    await assert.rejects(() => submitHumanReviewResponse(pending.items[0].id, {
      idempotencyKey: "owner:malformed-unicode",
      resolutionCode: "answered",
      answerText: "\ud800",
    }, new Date(now.getTime() + 4_250), value.database), /answer is invalid/);
    await assert.rejects(() => submitHumanReviewResponse(pending.items[0].id, {
      idempotencyKey: "owner:human-test-1",
      resolutionCode: "answered",
      answerText: " Yes.  This comparison is useful for the pricing decision. ",
    }, new Date(now.getTime() + 4_500), value.database), /immutable human-review response/);
    await assert.rejects(() => submitHumanReviewResponse(pending.items[0].id, {
      idempotencyKey: "owner:human-test-2",
      resolutionCode: "answered",
      answerText: "No. This is a different answer.",
    }, new Date(now.getTime() + 5_000), value.database), /immutable human-review response/);
    assert.equal((await listHumanReviewRequests({}, value.database)).items.length, 0);
    const savedResponse = (await value.database.prepare("SELECT resolution_code FROM report_human_review_responses WHERE request_id = ?").bind(pending.items[0].id).all()).results[0];
    assert.equal(savedResponse.resolution_code, "answered");
    const unchanged = await getReportEvaluation((await value.database.prepare("SELECT public_id FROM report_runs WHERE id = ?").bind(evaluation.runId).all()).results[0].public_id, value.database);
    assert.equal(unchanged.status, "needs_human_review");
    assert.equal(unchanged.ratingBasis, "deterministic_only");
    assert.equal(unchanged.overallScore, null);
    assert.deepEqual(unchanged.agent, agentBefore);
  } finally {
    await closeFixture(value);
  }
});

test("human-review queue is bounded, keyset-paged, and rejects ineligible responses", async () => {
  const value = await fixture();
  try {
    const first = await preparedEvaluation(value.database, "page-a", new Date("2026-08-09T12:10:00.000Z"));
    const firstCall = await dispatchAndReserve(value.database, first.evaluation, new Date("2026-08-09T12:10:01.000Z"));
    await completeReportAgentEvaluation(first.evaluation.id, terminalCallback(firstCall.reservation, firstCall.dispatch, { status: "needs_human_review", agentOutput: validAgentOutput(firstCall.reservation.canonicalInput, true) }), new Date("2026-08-09T12:10:02.000Z"), value.database);
    const second = await preparedEvaluation(value.database, "page-b", new Date("2026-08-09T12:11:00.000Z"));
    const secondCall = await dispatchAndReserve(value.database, second.evaluation, new Date("2026-08-09T12:11:01.000Z"));
    await completeReportAgentEvaluation(second.evaluation.id, terminalCallback(secondCall.reservation, secondCall.dispatch, { status: "needs_human_review", agentOutput: validAgentOutput(secondCall.reservation.canonicalInput, true) }), new Date("2026-08-09T12:11:02.000Z"), value.database);
    const page = await listHumanReviewRequests({ limit: 1 }, value.database);
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = await listHumanReviewRequests({ limit: 1, afterQueueSeq: page.nextCursor.queueSeq }, value.database);
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, page.items[0].id);
    await assert.rejects(() => listHumanReviewRequests({ limit: 51 }, value.database), /Invalid human-review queue/);
    await assert.rejects(() => submitHumanReviewResponse("missing-request", { idempotencyKey: "owner:missing", resolutionCode: "unable_to_determine", answerText: "" }, new Date(), value.database), /not found/);
  } finally { await closeFixture(value); }
});

test("human-review callback is atomic, records are database-immutable, and concurrent decisions choose one winner", async () => {
  const value = await fixture();
  try {
    const base = new Date("2026-08-09T12:20:00.000Z");
    const failing = await preparedEvaluation(value.database, "atomic-failure", base);
    const failingCall = await dispatchAndReserve(value.database, failing.evaluation, new Date(base.getTime() + 1_000));
    await value.database.prepare("CREATE TRIGGER reject_human_review_request BEFORE INSERT ON report_human_review_requests BEGIN SELECT RAISE(ABORT, 'injected request failure'); END").run();
    await assert.rejects(() => completeReportAgentEvaluation(failing.evaluation.id, terminalCallback(failingCall.reservation, failingCall.dispatch, { status: "needs_human_review", agentOutput: validAgentOutput(failingCall.reservation.canonicalInput, true) }), new Date(base.getTime() + 2_000), value.database), /injected request failure/);
    assert.equal((await getReportEvaluation(failing.created.publicId, value.database)).status, "reserved");
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_human_review_requests WHERE evaluation_id = ?").bind(failing.evaluation.id).all()).results[0].count, 0);
    await value.database.prepare("DROP TRIGGER reject_human_review_request").run();

    const winner = await preparedEvaluation(value.database, "concurrent", new Date(base.getTime() + 3_000));
    const winnerCall = await dispatchAndReserve(value.database, winner.evaluation, new Date(base.getTime() + 4_000));
    await completeReportAgentEvaluation(winner.evaluation.id, terminalCallback(winnerCall.reservation, winnerCall.dispatch, { status: "needs_human_review", agentOutput: validAgentOutput(winnerCall.reservation.canonicalInput, true) }), new Date(base.getTime() + 5_000), value.database);
    const request = (await listHumanReviewRequests({}, value.database)).items[0];
    await assert.rejects(() => value.database.prepare("UPDATE report_human_review_requests SET question = 'changed' WHERE id = ?").bind(request.id).run(), /immutable human review request/);
    const decisions = await Promise.allSettled([
      submitHumanReviewResponse(request.id, { idempotencyKey: "owner:concurrent-a", resolutionCode: "answered", answerText: "Yes." }, new Date(base.getTime() + 6_000), value.database),
      submitHumanReviewResponse(request.id, { idempotencyKey: "owner:concurrent-b", resolutionCode: "answered", answerText: "No." }, new Date(base.getTime() + 6_000), value.database),
    ]);
    assert.deepEqual(decisions.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_human_review_responses WHERE request_id = ?").bind(request.id).all()).results[0].count, 1);
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_human_review_open WHERE request_id = ?").bind(request.id).all()).results[0].count, 0);
    await assert.rejects(() => value.database.prepare("UPDATE report_human_review_responses SET answer_text = 'changed' WHERE request_id = ?").bind(request.id).run(), /immutable human review response/);
  } finally { await closeFixture(value); }
});

test("an over-budget provider response preserves actual usage but cannot produce a hybrid grade", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:30:00.000Z");
    const { evaluation } = await preparedEvaluation(value.database, "over-budget", now);
    const { dispatch, reservation } = await dispatchAndReserve(value.database, evaluation, new Date(now.getTime() + 1_000));
    const rejected = await completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch, {
      usage: { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 100_000 },
    }), new Date(now.getTime() + 2_000), value.database);
    assert.equal(rejected.status, "agent_rejected");
    assert.equal(rejected.errorCode, "evaluation-cost-budget-exceeded");
    assert.equal(rejected.ratingBasis, "deterministic_only");
    assert.equal(rejected.overallScore, null);
    assert.equal(rejected.usageStatus, "known");
    assert.equal(rejected.costMicrousd, 525_000);
  } finally {
    await closeFixture(value);
  }
});

test("a nominally successful callback without a provider response ID is rejected with known usage preserved", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:45:00.000Z");
    const { evaluation } = await preparedEvaluation(value.database, "missing-provider-id", now);
    const { dispatch, reservation } = await dispatchAndReserve(value.database, evaluation, new Date(now.getTime() + 1_000));
    const rejected = await completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch, {
      providerResponseId: null,
    }), new Date(now.getTime() + 2_000), value.database);
    assert.equal(rejected.status, "agent_rejected");
    assert.equal(rejected.errorCode, "provider-response-id-missing");
    assert.equal(rejected.ratingBasis, "deterministic_only");
    assert.equal(rejected.overallScore, null);
    assert.equal(rejected.usageStatus, "known");
    assert.equal(rejected.costMicrousd, 1_380);
  } finally {
    await closeFixture(value);
  }
});

test("reconciliation recovers stale dispatch and expires stale reservation without inventing usage", async () => {
  const value = await fixture();
  try {
    const base = new Date("2026-08-09T13:00:00.000Z");
    const staleDispatch = await preparedEvaluation(value.database, "stale-dispatch", base);
    await beginReportEvaluationDispatch(staleDispatch.evaluation.id, base, value.database);
    await value.database.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, created_at) SELECT 'legacy-pending', run_id, 'report', 'legacy-pending-hash', fact_manifest_hash, 'ecommerce-deterministic-v1', rubric_version, 'pending', 'none', ? FROM report_evaluations WHERE id = ?`).bind(new Date(base.getTime() - 20 * 60_000).toISOString(), staleDispatch.evaluation.id).run();

    const staleReservation = await preparedEvaluation(value.database, "stale-reserved", new Date(base.getTime() + 1_000));
    await dispatchAndReserve(value.database, staleReservation.evaluation, new Date(base.getTime() + 1_000));

    const reconciled = await reconcileReportEvaluations(new Date(base.getTime() + 11 * 60_000), value.database);
    const dispatchState = await getReportEvaluation(staleDispatch.created.publicId, value.database);
    assert.equal(dispatchState.status, "dispatch_failed");
    assert.equal(dispatchState.errorCode, "evaluation-dispatch-stale");
    assert.ok(reconciled.candidates.includes(staleDispatch.evaluation.id));
    const legacyPending = (await value.database.prepare("SELECT status FROM report_evaluations WHERE id = 'legacy-pending'").all()).results[0];
    assert.equal(legacyPending.status, "pending");

    const unknown = await getReportEvaluation(staleReservation.created.publicId, value.database);
    assert.equal(unknown.status, "call_outcome_unknown");
    assert.equal(unknown.errorCode, "evaluation-reservation-expired");
    assert.equal(unknown.usageStatus, "unknown");
    assert.equal(unknown.costMicrousd, null);
    assert.equal(unknown.inputTokens, null);
    assert.equal(unknown.cachedInputTokens, null);
    assert.equal(unknown.outputTokens, null);
    assert.ok(unknown.watchdogExpiredAt);
  } finally {
    await closeFixture(value);
  }
});
