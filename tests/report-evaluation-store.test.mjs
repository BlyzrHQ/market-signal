import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import {
  beginReportEvaluationDispatch,
  beginReportSearchChallengeDispatch,
  acknowledgeEvaluationFeedback,
  claimEvaluationFeedback,
  completeReportAgentEvaluation,
  completeReportSearchChallenge,
  createReportSearchChallenge,
  createReportRun,
  finalizeReportFactManifest,
  getReportEvaluation,
  listHumanReviewRequests,
  markReportEvaluationDispatchFailed,
  reconcileReportEvaluations,
  reconcileRequestedReportEvaluations,
  reconcileRequestedReportSearchChallenges,
  reserveReportAgentEvaluation,
  reserveReportSearchChallenge,
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
import { REPORT_FEEDBACK_CONSUMER } from "../src/shared/report-feedback-contract.ts";
import {
  REPORT_SEARCH_CHALLENGER_VERSION,
  REPORT_SEARCH_CHALLENGE_MODEL,
  REPORT_SEARCH_CHALLENGE_PRICING_VERSION,
  REPORT_SEARCH_CHALLENGE_PROMPT_VERSION,
} from "../src/shared/report-search-challenge-contract.ts";

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
  const path = join(directory, "market-signal.sqlite");
  const database = await NodeSqliteDatabase.open(path);
  return { directory, path, database };
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
          publication: { priceEligible: true },
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
  }, { status: "complete", expectedFactManifestHash: bundle.manifest.manifestHash }, now, database);
  const evaluation = await getReportEvaluation(created.publicId, database);
  assert.equal(evaluation.status, "deterministic");
  return { created, evaluation };
}

function challengeTerminal(reservation, overrides = {}) {
  return {
    action: "terminal",
    challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION,
    dispatchAttempt: 1,
    reservationOwner: "worker:challenge",
    reservationId: reservation.reservationId,
    clientRequestId: reservation.clientRequestId,
    status: "agent_rejected",
    errorCode: "provider-rejected",
    providerResponseId: null,
    providerRequestId: null,
    usageStatus: "unknown",
    usage: null,
    candidates: null,
    model: REPORT_SEARCH_CHALLENGE_MODEL,
    promptVersion: REPORT_SEARCH_CHALLENGE_PROMPT_VERSION,
    pricingVersion: REPORT_SEARCH_CHALLENGE_PRICING_VERSION,
    ...overrides,
  };
}

test("a terminal report creates one immutable bounded search challenge and reserves its exact fact snapshot", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "search-challenge", now);
    const first = await createReportSearchChallenge(created.publicId, now, value.database);
    const replay = await createReportSearchChallenge(created.publicId, new Date(now.getTime() + 1_000), value.database);
    assert.equal(first.id, replay.id);
    assert.equal(first.evaluationType, "search_challenge");
    assert.equal(first.status, "deterministic");
    const dispatch = await beginReportSearchChallengeDispatch(first.id, now, value.database);
    assert.equal(dispatch.challengerVersion, REPORT_SEARCH_CHALLENGER_VERSION);
    const reservation = await reserveReportSearchChallenge(first.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:challenge" }, now, value.database);
    assert.equal(reservation.ok, true);
    const input = JSON.parse(reservation.canonicalInput);
    assert.equal(input.publicReportId, created.publicId);
    assert.equal(input.factManifestHash, first.factManifestHash);
    assert.equal(input.products.length, 1);
    assert.equal(input.products[0].name, "Observed product");
    assert.equal(input.products[0].knownComparisonUrls.length, 1);
  } finally {
    await closeFixture(value);
  }
});

test("a lost search-challenge reservation write is declined instead of authorizing a paid call", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-race", now);
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(challenge.id, now, value.database);
    const guardedPrefix = "UPDATE report_evaluations SET status = 'reserved', reservation_id = ?";
    const losingDatabase = {
      prepare(query) {
        if (!query.startsWith(guardedPrefix)) return value.database.prepare(query);
        return { bind() { return { async run() { return { changes: 0 }; } }; } };
      },
      batch(statements) { return value.database.batch(statements); },
    };
    const reservation = await reserveReportSearchChallenge(challenge.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:loser" }, now, losingDatabase);
    assert.equal(reservation.ok, false);
    assert.equal(reservation.code, "already_reserved");
  } finally {
    await closeFixture(value);
  }
});

test("search-challenge reservations atomically include same-day in-flight cost even when the committed reservation has a later timestamp", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const firstRun = await preparedEvaluation(value.database, "challenge-budget-one", now);
    const secondRun = await preparedEvaluation(value.database, "challenge-budget-two", now);
    const first = await createReportSearchChallenge(firstRun.created.publicId, now, value.database);
    const second = await createReportSearchChallenge(secondRun.created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(first.id, now, value.database);
    await beginReportSearchChallengeDispatch(second.id, now, value.database);
    const firstReservation = await reserveReportSearchChallenge(first.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:budget-one" }, new Date("2026-08-21T10:00:00.002Z"), value.database);
    assert.equal(firstReservation.ok, true);
    const secondReservation = await reserveReportSearchChallenge(second.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:budget-two" }, new Date("2026-08-21T10:00:00.001Z"), value.database);
    assert.deepEqual(secondReservation, { ok: false, code: "daily_budget_exceeded" });
  } finally {
    await closeFixture(value);
  }
});

test("unknown completed evaluation cost suppresses a new daily search challenge", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created, evaluation } = await preparedEvaluation(value.database, "challenge-unknown-budget", now);
    await value.database.prepare("UPDATE report_evaluations SET status = 'agent_rejected', usage_status = 'unknown', completed_at = ? WHERE id = ?").bind(now.toISOString(), evaluation.id).run();
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    assert.equal(challenge.status, "insufficient_facts");
    assert.equal(challenge.errorCode, "search-challenge-daily-budget");
    assert.equal(challenge.deterministic.budget.unknownDailyCost, true);
  } finally {
    await closeFixture(value);
  }
});

test("failed search-challenge callbacks retain canonical input and expose challenge identity in feedback", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-failure", now);
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(challenge.id, now, value.database);
    const reservation = await reserveReportSearchChallenge(challenge.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:challenge" }, now, value.database);
    assert.equal(reservation.ok, true);
    const before = (await value.database.prepare("SELECT deterministic_json FROM report_evaluations WHERE id = ?").bind(challenge.id).all()).results[0].deterministic_json;
    await completeReportSearchChallenge(challenge.id, challengeTerminal(reservation), now, value.database);
    const after = (await value.database.prepare("SELECT deterministic_json FROM report_evaluations WHERE id = ?").bind(challenge.id).all()).results[0].deterministic_json;
    assert.deepEqual(JSON.parse(after), JSON.parse(before));
    const claimed = await claimEvaluationFeedback(new Date(now.getTime() + 1_000), value.database);
    assert.equal(claimed.item.evaluationType, "search_challenge");
    assert.equal(claimed.item.evaluatorVersion, REPORT_SEARCH_CHALLENGER_VERSION);
  } finally {
    await closeFixture(value);
  }
});

test("a complete search challenge verifies candidates, exclusions, recall, cost, and provider provenance", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-complete", now);
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(challenge.id, now, value.database);
    const reservation = await reserveReportSearchChallenge(challenge.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:challenge" }, now, value.database);
    assert.equal(reservation.ok, true);
    const input = JSON.parse(reservation.canonicalInput);
    const productId = input.products[0].productId;
    const knownUrl = input.products[0].knownComparisonUrls[0];
    const missedUrl = "https://independent-rival.example/products/observed";
    const blockedUrl = "https://blocked-rival.example/products/observed";
    const candidates = [
      { productId, query: "observed product", title: "Known", url: knownUrl },
      { productId, query: "observed product", title: "Missed", url: missedUrl },
      { productId, query: "observed product", title: "Blocked", url: blockedUrl },
      { productId, query: "observed product", title: "Marketplace", url: "https://amazon.co.uk/dp/example" },
      { productId, query: "observed product", title: "Listing", url: "https://another-rival.example/search/observed" },
      { productId, query: "observed product", title: "Primary", url: input.products[0].sourceUrl },
    ];
    const enrich = async (targets, maxPages) => ({
      products: targets.filter((target) => target.sourceUrl !== blockedUrl).map((target) => ({ id: target.productId, domain: target.domain, name: "Observed product", normalizedName: "observed product", priceSignals: [{ raw: "GBP 8.00", currency: "GBP", amount: 8 }], sourceUrl: target.sourceUrl, imageUrl: "https://images.example/observed.jpg", observedAt: now.toISOString(), jsonLdType: "Product", attributes: [] })),
      coverage: { pagesRequested: targets.length, pagesFetched: targets.length - 1, maxPages, gaps: [{ url: blockedUrl, productId: targets.find((target) => target.sourceUrl === blockedUrl).productId, role: "rival", reason: "robots disallowed", code: "robots_disallowed", failureKind: "robots" }] },
    });
    const completed = await completeReportSearchChallenge(challenge.id, challengeTerminal(reservation, {
      status: "complete",
      errorCode: null,
      providerResponseId: "response:challenge",
      providerRequestId: "request:challenge",
      usageStatus: "known",
      usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, webSearchCalls: 1 },
      candidates,
    }), now, value.database, { enrich });
    assert.equal(completed.status, "complete");
    assert.equal(completed.overallScore, 50);
    assert.equal(completed.grade, "D");
    assert.equal(completed.costMicrousd, 10_080);
    assert.equal(completed.deterministic.candidateCount, 3);
    assert.equal(completed.deterministic.verifiedCandidateCount, 2);
    assert.equal(completed.deterministic.missedValidComparisonCount, 1);
    assert.deepEqual(completed.deterministic.missedDomains, ["independent-rival.example"]);
    assert.deepEqual(completed.deterministic.rootCauseCounts, { notDiscovered: 1 });
    assert.deepEqual(completed.deterministic.verificationGapCounts, { robots_disallowed: 1 });
    const row = (await value.database.prepare("SELECT cached_input_tokens, provider_response_id FROM report_evaluations WHERE id = ?").bind(challenge.id).all()).results[0];
    assert.equal(row.cached_input_tokens, 0);
    assert.equal(row.provider_response_id, "response:challenge");
  } finally {
    await closeFixture(value);
  }
});

test("a mismatched search-challenge callback cannot mutate its reservation", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-binding", now);
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(challenge.id, now, value.database);
    const reservation = await reserveReportSearchChallenge(challenge.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:challenge" }, now, value.database);
    await assert.rejects(() => completeReportSearchChallenge(challenge.id, challengeTerminal(reservation, { reservationId: "reservation:wrong" }), now, value.database), /binding conflicts/);
    const persisted = (await value.database.prepare("SELECT status, reservation_id FROM report_evaluations WHERE id = ?").bind(challenge.id).all()).results[0];
    assert.equal(persisted.status, "reserved");
    assert.equal(persisted.reservation_id, reservation.reservationId);
  } finally {
    await closeFixture(value);
  }
});

test("a complete search challenge without provider provenance is rejected before verification", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-provider", now);
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(challenge.id, now, value.database);
    const reservation = await reserveReportSearchChallenge(challenge.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:challenge" }, now, value.database);
    let enrichmentCalled = false;
    const completed = await completeReportSearchChallenge(challenge.id, challengeTerminal(reservation, { status: "complete", errorCode: null, usageStatus: "known", usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, webSearchCalls: 1 }, candidates: [] }), now, value.database, { enrich: async () => { enrichmentCalled = true; throw new Error("must not run"); } });
    assert.equal(completed.status, "agent_rejected");
    assert.equal(completed.errorCode, "provider-response-id-missing");
    assert.equal(enrichmentCalled, false);
  } finally {
    await closeFixture(value);
  }
});

test("scoped recovery terminalizes stale challenger reservations and emits feedback", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-stale-recovery", now);
    const challenge = await createReportSearchChallenge(created.publicId, now, value.database);
    await beginReportSearchChallengeDispatch(challenge.id, now, value.database);
    const reservation = await reserveReportSearchChallenge(challenge.id, { challengerVersion: REPORT_SEARCH_CHALLENGER_VERSION, dispatchAttempt: 1, reservationOwner: "worker:challenge", clientRequestId: "client:challenge" }, now, value.database);
    assert.equal(reservation.ok, true);

    const recovery = await reconcileRequestedReportSearchChallenges([created.publicId], new Date(now.getTime() + 11 * 60_000), value.database);
    assert.deepEqual(recovery.candidates, []);
    const persisted = (await value.database.prepare("SELECT status, usage_status, error_code FROM report_evaluations WHERE id = ?").bind(challenge.id).all()).results[0];
    assert.deepEqual(persisted, { status: "call_outcome_unknown", usage_status: "unknown", error_code: "evaluation-reservation-expired" });
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_outbox WHERE evaluation_id = ?").bind(challenge.id).all()).results[0].count, 1);
  } finally {
    await closeFixture(value);
  }
});

test("the corrected challenger version can evaluate a report after an older terminal challenger", async () => {
  const value = await fixture();
  try {
    const previousDay = new Date("2026-08-20T10:00:00.000Z");
    const now = new Date("2026-08-21T10:00:00.000Z");
    const { created, evaluation } = await preparedEvaluation(value.database, "challenge-version-recovery", previousDay);
    await value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, usage_status, error_code, created_at, completed_at) VALUES ('old-search-challenge', ?, 'search_challenge', 'old-search-input', ?, 'independent-recall-v1', 'independent-recall-v1', 'call_outcome_unknown', 'none', 'unknown', 'evaluation-reservation-expired', ?, ?)").bind(evaluation.runId, evaluation.factManifestHash, previousDay.toISOString(), previousDay.toISOString()).run();
    const recovery = await reconcileRequestedReportSearchChallenges([created.publicId], now, value.database);
    assert.equal(recovery.candidates.length, 1);
    const current = (await value.database.prepare("SELECT evaluator_version, status FROM report_evaluations WHERE id = ?").bind(recovery.candidates[0]).all()).results[0];
    assert.deepEqual(current, { evaluator_version: REPORT_SEARCH_CHALLENGER_VERSION, status: "deterministic" });
  } finally {
    await closeFixture(value);
  }
});

test("same-day unknown recovery defers v2 without permanently consuming its version slot", async () => {
  const value = await fixture();
  try {
    const reservedAt = new Date("2026-08-21T10:00:00.000Z");
    const sameDay = new Date("2026-08-21T10:11:00.000Z");
    const nextDay = new Date("2026-08-22T10:00:00.000Z");
    const { created, evaluation } = await preparedEvaluation(value.database, "challenge-same-day-version-recovery", reservedAt);
    await value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, usage_status, reserved_cost_microusd, reservation_id, reservation_owner, reserved_at, client_request_id, created_at, started_at) VALUES ('old-reserved-search-challenge', ?, 'search_challenge', 'old-reserved-search-input', ?, 'independent-recall-v1', 'independent-recall-v1', 'reserved', 'none', 'reserved', 60000, 'old-reservation', 'old-worker', ?, 'old-request', ?, ?)").bind(evaluation.runId, evaluation.factManifestHash, reservedAt.toISOString(), reservedAt.toISOString(), reservedAt.toISOString()).run();

    const deferred = await reconcileRequestedReportSearchChallenges([created.publicId], sameDay, value.database);
    assert.deepEqual(deferred.candidates, []);
    assert.deepEqual(deferred.deferred, [created.publicId]);
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluations WHERE run_id = ? AND evaluation_type = 'search_challenge' AND evaluator_version = ?").bind(evaluation.runId, REPORT_SEARCH_CHALLENGER_VERSION).all()).results[0].count, 0);

    const retry = await reconcileRequestedReportSearchChallenges([created.publicId], nextDay, value.database);
    assert.equal(retry.candidates.length, 1);
    const current = (await value.database.prepare("SELECT evaluator_version, rubric_version, status FROM report_evaluations WHERE id = ?").bind(retry.candidates[0]).all()).results[0];
    assert.deepEqual(current, { evaluator_version: REPORT_SEARCH_CHALLENGER_VERSION, rubric_version: REPORT_SEARCH_CHALLENGER_VERSION, status: "deterministic" });
  } finally {
    await closeFixture(value);
  }
});

test("scoped search recovery skips ineligible report IDs without blocking eligible ones", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-22T10:00:00.000Z");
    const { created } = await preparedEvaluation(value.database, "challenge-partial-scope", now);
    const missing = "f".repeat(32);
    const recovery = await reconcileRequestedReportSearchChallenges([missing, created.publicId], now, value.database);
    assert.equal(recovery.candidates.length, 1);
    assert.deepEqual(recovery.skipped, [missing]);
  } finally {
    await closeFixture(value);
  }
});

test("agent evaluation labels excluded matches without promoting their recommendations", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const { evaluation } = await preparedEvaluation(value.database, "excluded", now);
    const stored = (await value.database.prepare("SELECT id, evidence_json FROM report_matches WHERE run_id = ?").bind(evaluation.runId).all()).results[0];
    const evidence = JSON.parse(String(stored.evidence_json));
    evidence.publication = { priceEligible: false, reason: "currency-mismatch" };
    await value.database.prepare("UPDATE report_matches SET evidence_json = ? WHERE id = ?").bind(JSON.stringify(evidence), stored.id).run();

    const { reservation } = await dispatchAndReserve(value.database, evaluation, now);
    const envelope = JSON.parse(reservation.canonicalInput);
    const match = envelope.evidence.find((item) => item.type === "match");
    assert.match(match.text, /excluded from public price comparison: currency-mismatch/);
    assert.equal(envelope.evidence.some((item) => item.type === "recommendation"), false);
  } finally {
    await closeFixture(value);
  }
});

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
    strengths: [{
      issueCode: "useful_competitors",
      subjectKind: "report",
      subjectId: "report",
      explanation: "The competitor evidence gives the owner a useful market reference.",
      evidenceIds: [company.id],
    }],
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
    usage: { inputTokens: 1_000, cachedInputTokens: 400, cacheWriteInputTokens: 100, outputTokens: 200 },
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
    for (const name of ["cached_input_tokens", "cache_write_input_tokens", "usage_status", "reserved_cost_microusd", "deterministic_at", "dispatch_started_at", "dispatch_token", "dispatch_failed_at", "watchdog_expired_at", "reservation_id", "reservation_owner", "reserved_at", "client_request_id", "provider_response_id", "provider_request_id"]) {
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
    const feedbackMigration = await readFile(new URL("../drizzle/0011_smart_naoko.sql", import.meta.url), "utf8");
    const feedbackBindingMigration = await readFile(new URL("../drizzle/0012_peaceful_salo.sql", import.meta.url), "utf8");
    assert.match(feedbackMigration, /report_evaluations_terminal_outbox_update/);
    assert.match(feedbackMigration, /report_evaluation_feedback_receipts_immutable/);
    assert.match(feedbackMigration, /CHECK \(`event_kind` = 'terminal_report_evaluation'\)/);
    assert.match(feedbackBindingMigration, /payload_hash.*CHECK \(length\(`payload_hash`\) = 64\)/);
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
    assert.deepEqual({ input: completed.inputTokens, cached: completed.cachedInputTokens, cacheWrite: completed.cacheWriteInputTokens, output: completed.outputTokens, cost: completed.costMicrousd }, { input: 1_000, cached: 400, cacheWrite: 100, output: 200, cost: 373 });
  } finally {
    await closeFixture(value);
  }
});

test("an ambiguously accepted stale worker cannot reserve cost after a bounded dispatch retry", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T10:30:00.000Z");
    const { evaluation } = await preparedEvaluation(value.database, "dispatch-retry", now);
    const first = await beginReportEvaluationDispatch(evaluation.id, new Date(now.getTime() + 1_000), value.database);
    await markReportEvaluationDispatchFailed(evaluation.id, first.dispatchAttempt, new Date(now.getTime() + 2_000), value.database);
    const retry = await beginReportEvaluationDispatch(evaluation.id, new Date(now.getTime() + 3_000), value.database);
    assert.equal(retry.dispatchAttempt, first.dispatchAttempt + 1);

    assert.deepEqual(await reserveReportAgentEvaluation(evaluation.id, {
      evaluatorVersion: first.evaluatorVersion,
      dispatchAttempt: first.dispatchAttempt,
      reservationOwner: "ambiguously-accepted-stale-worker",
      clientRequestId: "stale-dispatch-request",
    }, new Date(now.getTime() + 4_000), value.database), { ok: false, code: "stale_attempt" });

    const reservation = await reserveReportAgentEvaluation(evaluation.id, {
      evaluatorVersion: retry.evaluatorVersion,
      dispatchAttempt: retry.dispatchAttempt,
      reservationOwner: "current-retry-worker",
      clientRequestId: "current-dispatch-request",
    }, new Date(now.getTime() + 5_000), value.database);
    assert.equal(reservation.ok, true);
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
    assert.equal(unknown.cacheWriteInputTokens, null);
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
    assert.equal(provisional.costMicrousd, 373);
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

test("runtime database reopen skips the one-time feedback history backfill", async () => {
  const value = await fixture();
  await createReportRun({ primaryDomain: "initialized-feedback.example" }, new Date("2026-08-08T00:00:00.000Z"), value.database);
  const reopened = await NodeSqliteDatabase.open(value.path);
  const queries = [];
  const observed = {
    prepare(query) { queries.push(query); return reopened.prepare(query); },
    batch(statements) { return reopened.batch(statements); },
  };
  try {
    await createReportRun({ primaryDomain: "reopened-feedback.example" }, new Date("2026-08-09T00:00:00.000Z"), observed);
    assert.ok(queries.some((query) => query.includes("report_runtime_schema_markers") && query.startsWith("SELECT key")));
    assert.equal(queries.some((query) => query.startsWith("INSERT INTO report_evaluation_feedback_pending") && query.includes("SELECT outbox.id")), false);
  } finally {
    reopened.close();
    await closeFixture(value);
  }
});

test("runtime database reopen recovers an interrupted feedback backfill using its durable marker", async () => {
  const value = await fixture();
  const now = new Date("2026-08-09T00:00:00.000Z");
  const run = await createReportRun({ primaryDomain: "interrupted-feedback.example" }, now, value.database);
  await value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, deterministic_at, created_at, completed_at) VALUES ('interrupted-feedback', ?, 'report', 'interrupted-input', 'interrupted-manifest', 'ecommerce-agent-v1', 'r1', 'failed', 'none', ?, ?, ?)").bind(run.id, now.toISOString(), now.toISOString(), now.toISOString()).run();
  await value.database.prepare("DELETE FROM report_evaluation_feedback_pending").run();
  await value.database.prepare("DELETE FROM report_runtime_schema_markers WHERE key = 'evaluation-feedback-pending-backfill-v1'").run();
  const reopened = await NodeSqliteDatabase.open(value.path);
  try {
    await createReportRun({ primaryDomain: "recovery-trigger.example" }, now, reopened);
    assert.equal((await reopened.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_pending WHERE outbox_id = (SELECT id FROM report_evaluation_feedback_outbox WHERE evaluation_id = 'interrupted-feedback')").all()).results[0].count, 1);
    assert.equal((await reopened.prepare("SELECT COUNT(*) AS count FROM report_runtime_schema_markers WHERE key = 'evaluation-feedback-pending-backfill-v1'").all()).results[0].count, 1);
  } finally {
    reopened.close();
    await closeFixture(value);
  }
});

test("feedback migrations apply in order and install the atomic terminal trigger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-feedback-migration-"));
  const path = join(directory, "migration.sqlite");
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.exec("CREATE TABLE report_runs (id text PRIMARY KEY NOT NULL); CREATE TABLE report_evaluations (id text PRIMARY KEY NOT NULL, run_id text NOT NULL, status text NOT NULL, completed_at text DEFAULT '' NOT NULL, created_at text NOT NULL); CREATE TABLE report_purge_audits (id text PRIMARY KEY NOT NULL);");
    for (const name of ["0011_smart_naoko.sql", "0012_peaceful_salo.sql"]) {
      const migration = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
    }
    database.prepare("INSERT INTO report_runs (id) VALUES ('run-1')").run();
    database.prepare("INSERT INTO report_evaluations (id, run_id, status, completed_at, created_at) VALUES ('evaluation-acked', 'run-1', 'complete', '2026-08-09T00:00:01.000Z', '2026-08-09T00:00:00.000Z')").run();
    database.prepare("INSERT INTO report_evaluation_feedback_receipts (id, outbox_id, evaluation_id, run_id, consumer_key, idempotency_key, payload_hash, receipt_hash, acknowledged_at) SELECT 'receipt-acked', id, evaluation_id, run_id, 'codex-task-feedback-v1', 'migration-acked', ?, ?, '2026-08-09T00:00:02.000Z' FROM report_evaluation_feedback_outbox WHERE evaluation_id = 'evaluation-acked'").run("a".repeat(64), "b".repeat(64));
    const pendingMigration = await readFile(new URL("../drizzle/0013_icy_boom_boom.sql", import.meta.url), "utf8");
    for (const statement of pendingMigration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
    const markerMigration = await readFile(new URL("../drizzle/0014_brainy_wrecker.sql", import.meta.url), "utf8");
    for (const statement of markerMigration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM report_runtime_schema_markers WHERE key = 'evaluation-feedback-pending-backfill-v1'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_pending").get().count, 0);
    database.prepare("INSERT INTO report_evaluations (id, run_id, status, completed_at, created_at) VALUES ('evaluation-pending', 'run-1', 'failed', '2026-08-09T00:00:03.000Z', '2026-08-09T00:00:03.000Z')").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_outbox").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_pending WHERE outbox_id = (SELECT id FROM report_evaluation_feedback_outbox WHERE evaluation_id = 'evaluation-pending')").get().count, 1);
    const claims = database.pragma("table_info(report_evaluation_feedback_claims)");
    assert.equal(claims.some((column) => column.name === "payload_hash" && column.notnull === 1), true);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal evaluations create one atomic feedback delivery with leased at-least-once acknowledgement", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:05:00.000Z");
    const { evaluation } = await preparedEvaluation(value.database, "feedback", now);
    const { dispatch, reservation } = await dispatchAndReserve(value.database, evaluation, new Date(now.getTime() + 1_000));
    await value.database.prepare("CREATE TRIGGER reject_feedback_outbox BEFORE INSERT ON report_evaluation_feedback_outbox BEGIN SELECT RAISE(ABORT, 'injected feedback failure'); END").run();
    await assert.rejects(() => completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch), new Date(now.getTime() + 2_000), value.database), /injected feedback failure/);
    assert.equal((await getReportEvaluation((await value.database.prepare("SELECT public_id FROM report_runs WHERE id = ?").bind(evaluation.runId).all()).results[0].public_id, value.database)).status, "reserved");
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_outbox WHERE evaluation_id = ?").bind(evaluation.id).all()).results[0].count, 0);
    await value.database.prepare("DROP TRIGGER reject_feedback_outbox").run();

    await completeReportAgentEvaluation(evaluation.id, terminalCallback(reservation, dispatch), new Date(now.getTime() + 3_000), value.database);
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_outbox WHERE evaluation_id = ?").bind(evaluation.id).all()).results[0].count, 1);
    const claimed = await claimEvaluationFeedback(new Date(now.getTime() + 4_000), value.database);
    assert.equal(claimed.item.evaluationId, evaluation.id);
    assert.equal(claimed.item.status, "complete");
    assert.equal(claimed.item.strengths[0].issueCode, "useful_competitors");
    assert.match(claimed.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal((await claimEvaluationFeedback(new Date(now.getTime() + 5_000), value.database)).item, null);
    const ack = {
      deliveryId: claimed.item.deliveryId,
      leaseId: claimed.leaseId,
      payloadHash: claimed.payloadHash,
      idempotencyKey: "codex:feedback:one",
      consumer: REPORT_FEEDBACK_CONSUMER,
    };
    assert.equal((await acknowledgeEvaluationFeedback(ack, new Date(now.getTime() + 6_000), value.database)).replayed, false);
    assert.equal((await acknowledgeEvaluationFeedback(ack, new Date(now.getTime() + 7_000), value.database)).replayed, true);
    await assert.rejects(() => acknowledgeEvaluationFeedback({ ...ack, idempotencyKey: "codex:feedback:changed" }, new Date(now.getTime() + 7_250), value.database), /immutable evaluation feedback acknowledgement/);
    await value.database.prepare("UPDATE report_runs SET expires_at = ? WHERE id = ?").bind(new Date(now.getTime() + 7_500).toISOString(), evaluation.runId).run();
    await assert.rejects(() => acknowledgeEvaluationFeedback(ack, new Date(now.getTime() + 8_000), value.database), /expired with its report/);
    assert.equal((await claimEvaluationFeedback(new Date(now.getTime() + 9_000), value.database)).item, null);
    await assert.rejects(() => value.database.prepare("UPDATE report_evaluation_feedback_outbox SET event_kind = 'changed' WHERE evaluation_id = ?").bind(evaluation.id).run(), /immutable evaluation feedback outbox/);
    await assert.rejects(() => value.database.prepare("UPDATE report_evaluation_feedback_receipts SET consumer_key = 'changed' WHERE evaluation_id = ?").bind(evaluation.id).run(), /immutable evaluation feedback receipt/);
    await assert.rejects(() => value.database.prepare("UPDATE report_evaluations SET error_code = 'changed' WHERE id = ?").bind(evaluation.id).run(), /immutable terminal report evaluation/);
  } finally { await closeFixture(value); }
});

test("every terminal evaluation state creates an outbox event on insert", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:07:00.000Z");
    const run = await createReportRun({ primaryDomain: "terminal-states.example" }, now, value.database);
    const statuses = ["complete", "agent_rejected", "needs_human_review", "call_outcome_unknown", "insufficient_facts", "rubric_unavailable", "failed"];
    for (const [index, status] of statuses.entries()) {
      await value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, created_at, completed_at) VALUES (?, ?, 'report', ?, ?, ?, 'r1', ?, 'deterministic_only', ?, ?)").bind(`terminal-${index}`, run.id, `input-${index}`, `manifest-${index}`, `version-${index}`, status, now.toISOString(), now.toISOString()).run();
    }
    const rows = await value.database.prepare("SELECT evaluation_id FROM report_evaluation_feedback_outbox ORDER BY queue_seq").all();
    assert.deepEqual(rows.results.map((row) => row.evaluation_id), statuses.map((_, index) => `terminal-${index}`));
  } finally { await closeFixture(value); }
});

test("concurrent feedback claims have one winner and an expired lease is safely recovered", async () => {
  const value = await fixture();
  const second = await NodeSqliteDatabase.open(value.path);
  try {
    const now = new Date("2026-08-09T12:08:00.000Z");
    const run = await createReportRun({ primaryDomain: "feedback-race.example" }, now, value.database);
    await value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, error_code, dispatch_attempts, deterministic_at, created_at, completed_at) VALUES ('feedback-race', ?, 'report', 'input-race', 'manifest-race', 'ecommerce-agent-v1', 'r1', 'failed', 'none', 'dispatch-failed', 3, ?, ?, ?)").bind(run.id, now.toISOString(), now.toISOString(), now.toISOString()).run();
    const claims = await Promise.all([
      claimEvaluationFeedback(new Date(now.getTime() + 1_000), value.database),
      claimEvaluationFeedback(new Date(now.getTime() + 1_000), second),
    ]);
    assert.deepEqual(claims.map((claim) => Boolean(claim.item)).sort(), [false, true]);
    const first = claims.find((claim) => claim.item);
    const recovered = await claimEvaluationFeedback(new Date(now.getTime() + 302_000), second);
    assert.equal(recovered.item.deliveryId, first.item.deliveryId);
    assert.notEqual(recovered.leaseId, first.leaseId);
    await assert.rejects(() => acknowledgeEvaluationFeedback({ deliveryId: first.item.deliveryId, leaseId: first.leaseId, payloadHash: first.payloadHash, idempotencyKey: "codex:stale-lease", consumer: REPORT_FEEDBACK_CONSUMER }, new Date(now.getTime() + 303_000), value.database), /lease is missing, expired, or conflicting/);
    assert.equal((await acknowledgeEvaluationFeedback({ deliveryId: recovered.item.deliveryId, leaseId: recovered.leaseId, payloadHash: recovered.payloadHash, idempotencyKey: "codex:recovered-lease", consumer: REPORT_FEEDBACK_CONSUMER }, new Date(now.getTime() + 303_000), value.database)).replayed, false);
  } finally {
    second.close();
    await closeFixture(value);
  }
});

test("feedback backlog visibility uses a bounded lower-bound scan", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:09:00.000Z");
    const run = await createReportRun({ primaryDomain: "feedback-backlog.example" }, now, value.database);
    const insertEvaluations = async (prefix, count) => {
      const statements = [];
      for (let index = 0; index < count; index += 1) {
        statements.push(value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, created_at, completed_at) VALUES (?, ?, 'report', ?, ?, 'ecommerce-agent-v1', 'r1', 'failed', 'none', ?, ?)").bind(`${prefix}-${index}`, run.id, `${prefix}-input-${index}`, `${prefix}-manifest-${index}`, now.toISOString(), now.toISOString()));
      }
      for (let offset = 0; offset < statements.length; offset += 100) await value.database.batch(statements.slice(offset, offset + 100));
    };
    await insertEvaluations("acknowledged-prefix", 1_000);
    const acknowledged = (await value.database.prepare("SELECT id, evaluation_id FROM report_evaluation_feedback_outbox ORDER BY queue_seq LIMIT 1000").all()).results;
    const receipts = acknowledged.map((row, index) => value.database.prepare("INSERT INTO report_evaluation_feedback_receipts (id, outbox_id, evaluation_id, run_id, consumer_key, idempotency_key, payload_hash, receipt_hash, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(`prefix-receipt-${index}`, row.id, row.evaluation_id, run.id, REPORT_FEEDBACK_CONSUMER, `prefix-idempotency-${index}`, "a".repeat(64), "b".repeat(64), now.toISOString()));
    for (let offset = 0; offset < receipts.length; offset += 100) await value.database.batch(receipts.slice(offset, offset + 100));
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_pending").all()).results[0].count, 0);
    await insertEvaluations("pending-backlog", 1_005);
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_outbox").all()).results[0].count, 2_005);
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_pending").all()).results[0].count, 1_005);
    const leasedPrefix = (await value.database.prepare("SELECT outbox_id FROM report_evaluation_feedback_pending ORDER BY queue_seq LIMIT 1000").all()).results;
    const activeClaims = leasedPrefix.map((row) => value.database.prepare("INSERT INTO report_evaluation_feedback_claims (outbox_id, run_id, consumer_key, lease_id_hash, payload_hash, leased_until, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(row.outbox_id, run.id, REPORT_FEEDBACK_CONSUMER, "c".repeat(64), "d".repeat(64), new Date(now.getTime() + 60_000).toISOString(), now.toISOString()));
    for (let offset = 0; offset < activeClaims.length; offset += 100) await value.database.batch(activeClaims.slice(offset, offset + 100));
    const claimed = await claimEvaluationFeedback(new Date(now.getTime() + 1_000), value.database);
    assert.equal(claimed.item.evaluationId, "pending-backlog-1000");
    assert.equal(claimed.backlog.pending, 1_001);
    assert.equal(claimed.backlog.pendingIsLowerBound, true);
    assert.equal(claimed.backlog.oldestAt, now.toISOString());
  } finally { await closeFixture(value); }
});

test("feedback claims remove only a bounded expired prefix before selecting work", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T12:09:00.000Z");
    const expiredRun = await createReportRun({ primaryDomain: "expired-prefix.example" }, new Date("2025-01-01T00:00:00.000Z"), value.database);
    const expired = [];
    for (let index = 0; index < 1_001; index += 1) expired.push(value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, created_at, completed_at) VALUES (?, ?, 'report', ?, ?, 'ecommerce-agent-v1', 'r1', 'failed', 'none', ?, ?)").bind(`expired-prefix-${index}`, expiredRun.id, `expired-input-${index}`, `expired-manifest-${index}`, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"));
    for (let offset = 0; offset < expired.length; offset += 100) await value.database.batch(expired.slice(offset, offset + 100));
    const validRun = await createReportRun({ primaryDomain: "valid-after-expired.example" }, now, value.database);
    await value.database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, created_at, completed_at) VALUES ('valid-after-expired', ?, 'report', 'valid-input', 'valid-manifest', 'ecommerce-agent-v1', 'r1', 'failed', 'none', ?, ?)").bind(validRun.id, now.toISOString(), now.toISOString()).run();
    const claimed = await claimEvaluationFeedback(new Date(now.getTime() + 1_000), value.database);
    assert.equal(claimed.item.evaluationId, "valid-after-expired");
    assert.equal((await value.database.prepare("SELECT COUNT(*) AS count FROM report_evaluation_feedback_pending").all()).results[0].count, 1);
  } finally { await closeFixture(value); }
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
      usage: { inputTokens: 100_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100_000 },
    }), new Date(now.getTime() + 2_000), value.database);
    assert.equal(rejected.status, "agent_rejected");
    assert.equal(rejected.errorCode, "evaluation-cost-budget-exceeded");
    assert.equal(rejected.ratingBasis, "deterministic_only");
    assert.equal(rejected.overallScore, null);
    assert.equal(rejected.usageStatus, "known");
    assert.equal(rejected.costMicrousd, 140_000);
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
    assert.equal(rejected.costMicrousd, 373);
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
    assert.equal(unknown.cacheWriteInputTokens, null);
    assert.equal(unknown.outputTokens, null);
    assert.ok(unknown.watchdogExpiredAt);
  } finally {
    await closeFixture(value);
  }
});

test("bounded recovery returns only evaluations belonging to exact requested public reports", async () => {
  const value = await fixture();
  try {
    const now = new Date("2026-08-09T14:00:00.000Z");
    const requested = await preparedEvaluation(value.database, "requested-recovery", now);
    const unrelated = await preparedEvaluation(value.database, "unrelated-recovery", new Date(now.getTime() + 1_000));
    const recovery = await reconcileRequestedReportEvaluations([requested.created.publicId], new Date(now.getTime() + 2_000), value.database);
    assert.deepEqual(recovery.candidates, [requested.evaluation.id]);
    assert.ok(!recovery.candidates.includes(unrelated.evaluation.id));
    await assert.rejects(() => reconcileRequestedReportEvaluations([], now, value.database), /Invalid report evaluation recovery scope/);
    await assert.rejects(() => reconcileRequestedReportEvaluations([requested.created.publicId, requested.created.publicId], now, value.database), /Invalid report evaluation recovery scope/);
  } finally {
    await closeFixture(value);
  }
});
