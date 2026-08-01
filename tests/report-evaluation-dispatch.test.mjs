import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { ensureReportStorageSchema } from "../app/lib/report-store.ts";
import { REPORT_AGENT_DEFAULT_MODEL, REPORT_AGENT_JUDGE_VERSION, REPORT_AGENT_PRICING_VERSION, REPORT_AGENT_PROMPT_VERSION, REPORT_AGENT_RUBRIC_VERSION } from "../app/lib/report-agent-judge.ts";
import { acknowledgeDispatch, claimDispatches, dryRunBacklog, lease, markAmbiguousDispatch } from "../app/lib/report-evaluation-service.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const OLD = "2026-07-31T11:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-dispatch-"));
  const path = join(directory, "dispatch.sqlite");
  const database = await NodeSqliteDatabase.open(path);
  await ensureReportStorageSchema(database);
  return { directory, path, database };
}

async function withFixture(run) {
  const item = await fixture();
  try { await run(item); } finally { item.database.close(); await rm(item.directory, { recursive: true, force: true }); }
}

async function insertEvaluation(database, id, overrides = {}) {
  const row = {
    runId: `run_${id}`,
    inputHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    status: "pending",
    createdAt: OLD,
    leaseToken: "",
    leaseGeneration: 0,
    leaseExpiresAt: "",
    dispatchGeneration: 0,
    dispatchAttempts: 0,
    transportAttempts: 0,
    dispatchOutcome: "",
    triggerRunId: "",
    deterministicJson: "{}",
    deterministicScore: null,
    packetHash: "",
    ...overrides,
  };
  await database.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, deterministic_score, deterministic_json, model, prompt_version, pricing_version, evaluated_at, max_input_tokens, max_output_tokens, reserved_cost_microusd, packet_hash, lease_token, lease_generation, lease_expires_at, dispatch_generation, dispatch_attempts, dispatch_transport_attempts, dispatch_outcome, trigger_run_id, created_at) VALUES (?, ?, 'report', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, 60000, 2000, 15840, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, row.runId, row.inputHash, row.manifestHash, REPORT_AGENT_JUDGE_VERSION, REPORT_AGENT_RUBRIC_VERSION, row.status, row.deterministicScore, row.deterministicJson, REPORT_AGENT_DEFAULT_MODEL, REPORT_AGENT_PROMPT_VERSION, REPORT_AGENT_PRICING_VERSION, OLD, row.packetHash, row.leaseToken, row.leaseGeneration, row.leaseExpiresAt, row.dispatchGeneration, row.dispatchAttempts, row.transportAttempts, row.dispatchOutcome, row.triggerRunId, row.createdAt).run();
  return row;
}

test("exact-target claiming never falls back and concurrent claimers have one winner", async () => withFixture(async ({ database, path }) => {
  const target = "evaluation_exact_target_0001";
  const other = "evaluation_unrelated_00002";
  await insertEvaluation(database, target, { createdAt: NOW.toISOString() });
  await insertEvaluation(database, other);
  const second = await NodeSqliteDatabase.open(path);
  try {
    const results = await Promise.all([claimDispatches(1, target, NOW, database), claimDispatches(1, target, NOW, second)]);
    assert.equal(results.filter((claims) => claims.length === 1).length, 1);
    assert.equal(results.filter((claims) => claims.length === 0).length, 1);
    assert.equal(results.flat()[0].evaluationId, target);
    assert.deepEqual(await claimDispatches(1, target, NOW, database), []);
    assert.equal((await database.prepare("SELECT status FROM report_evaluations WHERE id = ?").bind(other).all()).results[0].status, "pending");
  } finally { second.close(); }
}));

test("ambiguous retries retain one generation and exhaust after three transports", async () => withFixture(async ({ database }) => {
  const id = "evaluation_unknown_replay_01";
  await insertEvaluation(database, id);
  let claim = (await claimDispatches(1, id, NOW, database))[0];
  const generationToken = claim.dispatchToken;
  assert.equal(claim.dispatchGeneration, 1);
  assert.deepEqual(await markAmbiguousDispatch(claim, NOW, database), { accepted: true, state: "dispatching", transportAttempts: 1 });
  await database.prepare("UPDATE report_evaluations SET status = 'dispatch_failed' WHERE id = ?").bind(id).run();
  claim = (await claimDispatches(1, id, new Date("2026-07-31T12:03:00.000Z"), database))[0];
  assert.equal(claim.dispatchGeneration, 1);
  assert.equal(claim.dispatchToken, generationToken);
  assert.deepEqual(await markAmbiguousDispatch(claim, NOW, database), { accepted: true, state: "dispatching", transportAttempts: 2 });
  claim = (await claimDispatches(1, id, new Date("2026-07-31T12:06:00.000Z"), database))[0];
  assert.equal(claim.dispatchGeneration, 1);
  assert.equal(claim.dispatchToken, generationToken);
  assert.deepEqual(await markAmbiguousDispatch(claim, NOW, database), { accepted: true, state: "failed", transportAttempts: 3 });
  const row = (await database.prepare("SELECT status, dispatch_generation, dispatch_attempts, dispatch_transport_attempts, error_code FROM report_evaluations WHERE id = ?").bind(id).all()).results[0];
  assert.deepEqual(row, { status: "failed", dispatch_generation: 1, dispatch_attempts: 1, dispatch_transport_attempts: 3, error_code: "evaluation-dispatch-transport-exhausted" });
}));

test("late acknowledgement fills the run id without regressing worker progress", async () => withFixture(async ({ database }) => {
  const id = "evaluation_late_ack_000001";
  await insertEvaluation(database, id);
  const claim = (await claimDispatches(1, id, NOW, database))[0];
  const worker = await lease(claim, NOW, database);
  assert.equal(worker.accepted, true);
  assert.deepEqual(await acknowledgeDispatch(claim, "trigger_run_123", NOW, database), { accepted: true, state: "profiling" });
  assert.deepEqual(await markAmbiguousDispatch(claim, NOW, database), { accepted: false, state: "profiling" });
  const row = (await database.prepare("SELECT status, trigger_run_id, dispatch_outcome FROM report_evaluations WHERE id = ?").bind(id).all()).results[0];
  assert.deepEqual(row, { status: "profiling", trigger_run_id: "trigger_run_123", dispatch_outcome: "accepted" });
}));

test("expired worker leases recover preserved preparation and allocate bounded generations", async () => withFixture(async ({ database }) => {
  const id = "evaluation_stale_worker_001";
  await insertEvaluation(database, id, { status: "ready_for_judge", leaseToken: "stale-token-1234567890-abcdefghijklmnop", leaseGeneration: 2, leaseExpiresAt: OLD, dispatchGeneration: 1, dispatchAttempts: 1, dispatchOutcome: "accepted", deterministicJson: '{"kept":true}', deterministicScore: 42, packetHash: "c".repeat(64) });
  const secondGeneration = (await claimDispatches(1, id, NOW, database))[0];
  assert.equal(secondGeneration.dispatchGeneration, 2);
  let row = (await database.prepare("SELECT status, deterministic_json, deterministic_score, packet_hash FROM report_evaluations WHERE id = ?").bind(id).all()).results[0];
  assert.deepEqual(row, { status: "dispatching", deterministic_json: '{"kept":true}', deterministic_score: 42, packet_hash: "c".repeat(64) });
  await acknowledgeDispatch(secondGeneration, "trigger_2", NOW, database);
  await database.prepare("UPDATE report_evaluations SET status = 'profiling', lease_expires_at = ? WHERE id = ?").bind(OLD, id).run();
  const thirdGeneration = (await claimDispatches(1, id, NOW, database))[0];
  assert.equal(thirdGeneration.dispatchGeneration, 3);
  await acknowledgeDispatch(thirdGeneration, "trigger_3", NOW, database);
  await database.prepare("UPDATE report_evaluations SET status = 'profiling', lease_expires_at = ? WHERE id = ?").bind(OLD, id).run();
  assert.deepEqual(await claimDispatches(1, id, NOW, database), []);
  row = (await database.prepare("SELECT status, error_code, dispatch_generation FROM report_evaluations WHERE id = ?").bind(id).all()).results[0];
  assert.deepEqual(row, { status: "failed", error_code: "evaluation-dispatch-exhausted", dispatch_generation: 3 });
}));

test("expired judging becomes deterministic-only unknown outcome without another dispatch", async () => withFixture(async ({ database }) => {
  const id = "evaluation_expired_judging_1";
  await insertEvaluation(database, id, { status: "judging", leaseToken: "judging-token-1234567890-abcdefghijkl", leaseGeneration: 3, leaseExpiresAt: OLD, dispatchGeneration: 1, dispatchAttempts: 1, dispatchOutcome: "accepted", deterministicScore: 37 });
  assert.deepEqual(await claimDispatches(1, id, NOW, database), []);
  const row = (await database.prepare("SELECT status, rating_basis, deterministic_score, overall_score, grade, error_code FROM report_evaluations WHERE id = ?").bind(id).all()).results[0];
  assert.deepEqual(row, { status: "agent_rejected", rating_basis: "deterministic_only", deterministic_score: 37, overall_score: null, grade: null, error_code: "agent-call-outcome-unknown" });
}));

test("backlog dry-run is non-mutating and materialization is bounded to 25", async () => withFixture(async ({ database }) => {
  const statements = [];
  for (let index = 0; index < 30; index += 1) {
    const runId = `backlog-run-${String(index).padStart(2, "0")}`;
    const publicId = index.toString(16).padStart(32, "0");
    statements.push(database.prepare("INSERT INTO report_runs (id, public_id, primary_domain, locale, status, current_phase, attempt_count, created_at, updated_at, heartbeat_at, expires_at, error_code, error_message) VALUES (?, ?, 'shop.example', 'en', 'complete', 'complete', 1, ?, ?, ?, '2026-10-31T00:00:00.000Z', '', '')").bind(runId, publicId, OLD, OLD, OLD));
    statements.push(database.prepare("INSERT INTO report_documents (run_id, schema_version, document_json, observed_at, updated_at) VALUES (?, 1, ?, ?, ?)").bind(runId, JSON.stringify({ blocks: [] }), OLD, OLD));
    if (index !== 0) statements.push(database.prepare("INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) VALUES (?, ?, 1, ?, 0, 0, 0, 0, 'complete', '', '', ?)").bind(runId, `manifest-${index}`, index.toString(16).padStart(64, "a").slice(-64), OLD));
  }
  await database.batch(statements);
  assert.deepEqual(await dryRunBacklog(NOW, database), { count: 30, nextBatch: 25 });
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM report_evaluations").all()).results[0].count, 0);
  assert.deepEqual(await claimDispatches(25, undefined, NOW, database), []);
  const rows = await database.prepare("SELECT status, COUNT(*) AS count FROM report_evaluations GROUP BY status ORDER BY status").all();
  assert.deepEqual(rows.results, [{ status: "insufficient_facts", count: 1 }, { status: "pending", count: 24 }]);
  assert.deepEqual(await dryRunBacklog(NOW, database), { count: 5, nextBatch: 5 });
}));
