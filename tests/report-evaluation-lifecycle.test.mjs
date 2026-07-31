import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { ensureReportStorageSchema } from "../app/lib/report-store.ts";
import {
  REPORT_AGENT_DEFAULT_MODEL,
  REPORT_AGENT_JUDGE_VERSION,
  REPORT_AGENT_PRICING_VERSION,
  REPORT_AGENT_PROMPT_VERSION,
  REPORT_AGENT_RUBRIC_VERSION,
  calculateReportAgentCost,
  computeHybridReportScore,
} from "../app/lib/report-agent-judge.ts";
import { beginJudging, complete, lease, prepare, reject } from "../app/lib/report-evaluation-service.ts";
import { REPORT_EVALUATION_CONTRACT_VERSION } from "../src/shared/report-evaluation-contract.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const DISPATCH_TOKEN = "dispatch-token-1234567890-abcdefghijklmnop";

async function hash(value) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-evaluation-"));
  const path = join(directory, "evaluation.sqlite");
  const database = await NodeSqliteDatabase.open(path);
  await ensureReportStorageSchema(database);
  const document = { title: "Evaluation fixture", blocks: [{ type: "evidence", claimId: "claim-one", claimType: "Observed", text: "Observed public product evidence.", sourceUrl: "https://shop.example/product", observedAt: NOW.toISOString() }] };
  const documentJson = JSON.stringify(document);
  const inputHash = await hash(documentJson);
  const manifestHash = "b".repeat(64);
  const evaluationId = "evaluation_1234567890abcdef";
  const runId = "run-evaluation-fixture";
  await database.batch([
    database.prepare("INSERT INTO report_runs (id, public_id, primary_domain, locale, status, current_phase, attempt_count, created_at, updated_at, heartbeat_at, expires_at, error_code, error_message) VALUES (?, ?, 'shop.example', 'en', 'complete', 'complete', 1, ?, ?, ?, ?, '', '')").bind(runId, "a".repeat(32), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), "2026-10-31T00:00:00.000Z"),
    database.prepare("INSERT INTO report_documents (run_id, schema_version, document_json, observed_at, updated_at) VALUES (?, 1, ?, ?, ?)").bind(runId, documentJson, NOW.toISOString(), NOW.toISOString()),
    database.prepare("INSERT INTO report_companies (run_id, domain, role, company_name, evidence_url, evidence_json, observed_at) VALUES (?, 'shop.example', 'primary', 'Shop', 'https://shop.example/', '{}', ?)").bind(runId, NOW.toISOString()),
    database.prepare("INSERT INTO report_products (run_id, domain, product_id, name, normalized_name, source_url, image_url, price_json, metadata_json, observed_at) VALUES (?, 'shop.example', 'p1', 'Product', 'product', 'https://shop.example/product', '', '[]', '{}', ?)").bind(runId, NOW.toISOString()),
    database.prepare("INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) VALUES (?, ?, 1, ?, 1, 1, 0, 0, 'complete', '', '', ?)").bind(runId, "m".repeat(64), manifestHash, NOW.toISOString()),
    database.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, model, prompt_version, pricing_version, evaluated_at, max_input_tokens, max_output_tokens, reserved_cost_microusd, lease_token, lease_generation, lease_expires_at, dispatch_generation, dispatch_attempts, created_at) VALUES (?, ?, 'report', ?, ?, ?, ?, 'dispatching', 'none', ?, ?, ?, ?, 60000, 2000, 15840, ?, 0, ?, 1, 1, ?)`)
      .bind(evaluationId, runId, inputHash, manifestHash, REPORT_AGENT_JUDGE_VERSION, REPORT_AGENT_RUBRIC_VERSION, REPORT_AGENT_DEFAULT_MODEL, REPORT_AGENT_PROMPT_VERSION, REPORT_AGENT_PRICING_VERSION, NOW.toISOString(), DISPATCH_TOKEN, "2026-07-31T12:05:00.000Z", NOW.toISOString()),
  ]);
  const payload = { contractVersion: REPORT_EVALUATION_CONTRACT_VERSION, evaluationId, evaluatorVersion: REPORT_AGENT_JUDGE_VERSION, inputHash, factManifestHash: manifestHash, dispatchGeneration: 1, dispatchToken: DISPATCH_TOKEN };
  return { directory, path, database, payload, runId };
}

async function withFixture(run) {
  const item = await fixture();
  try { await run(item); } finally { item.database.close(); await rm(item.directory, { recursive: true, force: true }); }
}

function judge(evidenceId) {
  const score = () => ({ points: 0, reason: "The supplied evidence supports this conclusion.", evidenceIds: [evidenceId] });
  return { scores: { userValue: { competitorUsefulness: score(), commercialComparisonUsefulness: score(), actionSpecificityAndPriority: score() }, evidenceIntegrity: { uncertaintyAndClaimTypeHonesty: score(), evidenceBoundedRecommendations: score() }, presentationUtility: { prioritizationAndHierarchy: score(), decisionClarity: score(), topThreeActionClarity: score() } }, findings: [], proposals: [] };
}

test("dispatch lease is consumed once and refreshes the parent heartbeat", async () => withFixture(async ({ database, payload, runId }) => {
  const leaseNow = new Date(NOW.getTime() + 60_000);
  const result = await lease(payload, leaseNow, database);
  assert.equal(result.accepted, true);
  assert.equal(result.leaseToken, DISPATCH_TOKEN);
  assert.equal(result.leaseGeneration, 1);
  const replay = await lease(payload, leaseNow, database);
  assert.deepEqual(replay, { accepted: false, state: "profiling" });
  const rows = await database.prepare("SELECT status, dispatch_outcome FROM report_evaluations WHERE id = ?").bind(payload.evaluationId).all();
  assert.deepEqual(rows.results, [{ status: "profiling", dispatch_outcome: "accepted" }]);
  const run = (await database.prepare("SELECT heartbeat_at, updated_at FROM report_runs WHERE id = ?").bind(runId).all()).results[0];
  assert.deepEqual(run, { heartbeat_at: leaseNow.toISOString(), updated_at: NOW.toISOString() });
}));

test("wrong frozen hash, dispatch token, and generation fail closed", async () => withFixture(async ({ database, payload }) => {
  await assert.rejects(() => lease({ ...payload, inputHash: "c".repeat(64) }, NOW, database), /binding conflicts/);
  await assert.rejects(() => lease({ ...payload, dispatchToken: "wrong-token-1234567890-abcdefghijklmnop" }, NOW, database), /binding conflicts/);
  await assert.rejects(() => lease({ ...payload, dispatchGeneration: 2 }, NOW, database), /binding conflicts/);
  assert.equal((await database.prepare("SELECT status FROM report_evaluations").all()).results[0].status, "dispatching");
}));

test("concurrent lease consumers have one CAS winner", async () => withFixture(async ({ database, path, payload }) => {
  const second = await NodeSqliteDatabase.open(path);
  try {
    const results = await Promise.all([lease(payload, NOW, database), lease(payload, NOW, second)]);
    assert.equal(results.filter((item) => item.accepted).length, 1);
    assert.equal(results.filter((item) => !item.accepted && item.state === "profiling").length, 1);
  } finally { second.close(); }
}));

test("prepare freezes deterministic inputs, persists ready state, and replays the canonical packet", async () => withFixture(async ({ database, payload }) => {
  const leased = await lease(payload, NOW, database);
  const worker = { ...payload, leaseToken: leased.leaseToken, leaseGeneration: leased.leaseGeneration };
  const first = await prepare(worker, NOW, database);
  assert.equal(first.accepted, true);
  assert.equal(first.replayed, false);
  assert.ok(first.prepared.packet.evidence.length > 0);
  const row = (await database.prepare("SELECT status, deterministic_score, deterministic_json, packet_hash FROM report_evaluations").all()).results[0];
  assert.equal(row.status, "ready_for_judge");
  assert.equal(typeof row.deterministic_score, "number");
  assert.notEqual(row.deterministic_json, "{}");
  assert.equal(row.packet_hash, first.prepared.packetHash);
  const replay = await prepare(worker, new Date("2026-07-31T12:01:00.000Z"), database);
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.prepared.packet, first.prepared.packet);
}));

test("rubric-unavailable preparation retains only the deterministic score", async () => withFixture(async ({ database, payload }) => {
  await database.batch([
    database.prepare("DELETE FROM report_products WHERE run_id = (SELECT run_id FROM report_evaluations WHERE id = ?)").bind(payload.evaluationId),
    database.prepare("UPDATE report_fact_manifests SET product_count = 0 WHERE run_id = (SELECT run_id FROM report_evaluations WHERE id = ?)").bind(payload.evaluationId),
  ]);
  const leased = await lease(payload, NOW, database);
  const worker = { ...payload, leaseToken: leased.leaseToken, leaseGeneration: leased.leaseGeneration };
  assert.deepEqual(await prepare(worker, NOW, database), { accepted: false, state: "rubric_unavailable" });
  const row = (await database.prepare("SELECT status, rating_basis, deterministic_score, overall_score, grade FROM report_evaluations").all()).results[0];
  assert.equal(row.status, "rubric_unavailable");
  assert.equal(row.rating_basis, "deterministic_only");
  assert.equal(typeof row.deterministic_score, "number");
  assert.equal(row.overall_score, null);
  assert.equal(row.grade, null);
}));

test("an unpriced evaluator model keeps deterministic diagnostics and never reaches judging", async () => withFixture(async ({ database, payload }) => {
  await database.prepare("UPDATE report_evaluations SET model = 'unsupported-model', pricing_version = '', reserved_cost_microusd = 0, error_code = 'unpriced-evaluator-model' WHERE id = ?").bind(payload.evaluationId).run();
  const leased = await lease(payload, NOW, database);
  const worker = { ...payload, leaseToken: leased.leaseToken, leaseGeneration: leased.leaseGeneration };
  assert.deepEqual(await prepare(worker, NOW, database), { accepted: false, state: "agent_rejected" });
  const row = (await database.prepare("SELECT status, rating_basis, deterministic_score, overall_score, grade, error_code FROM report_evaluations WHERE id = ?").bind(payload.evaluationId).all()).results[0];
  assert.equal(row.status, "agent_rejected");
  assert.equal(row.rating_basis, "deterministic_only");
  assert.equal(typeof row.deterministic_score, "number");
  assert.equal(row.overall_score, null);
  assert.equal(row.grade, null);
  assert.equal(row.error_code, "unpriced-evaluator-model");
}));

test("judging is a durable at-most-once barrier and complete is immutable", async () => withFixture(async ({ database, payload }) => {
  const leased = await lease(payload, NOW, database);
  const worker = { ...payload, leaseToken: leased.leaseToken, leaseGeneration: leased.leaseGeneration };
  const prepared = await prepare(worker, NOW, database);
  assert.deepEqual(await beginJudging(worker, prepared.prepared.packetHash, NOW, database), { accepted: true, state: "judging" });
  assert.deepEqual(await beginJudging(worker, prepared.prepared.packetHash, NOW, database), { accepted: false, state: "judging" });
  const output = judge(prepared.prepared.packet.evidence[0].id);
  const hybrid = computeHybridReportScore({ deterministicProfile: prepared.prepared.deterministicProfile, judge: output });
  const costs = calculateReportAgentCost(100, 50, 10);
  const usage = { inputTokens: 100, cachedInputTokens: 10, uncachedInputTokens: 90, outputTokens: 50, totalTokens: 150, ...costs };
  const input = { lease: worker, packetHash: prepared.prepared.packetHash, model: REPORT_AGENT_DEFAULT_MODEL, judge: output, hybrid, usage };
  const result = await complete(input, NOW, database);
  assert.equal(result.accepted, true);
  assert.equal(result.state, "complete");
  assert.deepEqual(await complete(input, NOW, database), { accepted: false, state: "complete" });
  const row = (await database.prepare("SELECT status, rating_basis, overall_score, grade, input_tokens, output_tokens FROM report_evaluations").all()).results[0];
  assert.equal(row.status, "complete");
  assert.equal(row.rating_basis, "hybrid");
  assert.equal(row.overall_score, hybrid.overallScore);
  assert.equal(row.grade, hybrid.grade);
  assert.equal(row.input_tokens, 100);
  assert.equal(row.output_tokens, 50);
}));

test("ready and judging rejection preserve deterministic-only terminal results", async () => {
  for (const phase of ["ready_for_judge", "judging"]) await withFixture(async ({ database, payload }) => {
    const leased = await lease(payload, NOW, database);
    const worker = { ...payload, leaseToken: leased.leaseToken, leaseGeneration: leased.leaseGeneration };
    const prepared = await prepare(worker, NOW, database);
    if (phase === "judging") await beginJudging(worker, prepared.prepared.packetHash, NOW, database);
    const result = await reject({ lease: worker, packetHash: prepared.prepared.packetHash, phase, errorCode: phase === "judging" ? "agent-call-outcome-unknown" : "agent-packet-rejected" }, NOW, database);
    assert.equal(result.accepted, true);
    const row = (await database.prepare("SELECT status, rating_basis, overall_score, deterministic_score, grade, error_code FROM report_evaluations").all()).results[0];
    assert.equal(row.status, "agent_rejected");
    assert.equal(row.rating_basis, "deterministic_only");
    assert.equal(typeof row.deterministic_score, "number");
    assert.equal(row.overall_score, null);
    assert.equal(row.grade, null);
    assert.equal(row.error_code, phase === "judging" ? "agent-call-outcome-unknown" : "agent-packet-rejected");
  });
});
