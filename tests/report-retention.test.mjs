import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRetentionHandler } from "../app/api/internal/retention/route.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRun, purgeExpiredReports } from "../app/lib/report-store.ts";
import { createWorkerApiManifest, REPORT_RETENTION_CAPABILITY } from "../src/shared/worker-api-contract.ts";
import { MAX_RETENTION_PASSES, runReportRetention } from "../src/trigger/report-retention-core.ts";
import { createReportRetentionHttpPort } from "../src/trigger/report-retention-http.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const OLD = new Date("2025-01-01T00:00:00.000Z");
const TOKEN = "retention_callback_token_that_is_long_enough";
const TABLES = ["report_quality_signals", "report_evaluations", "report_ads", "report_matches", "report_products", "report_companies", "report_fact_chunks", "report_fact_manifests", "report_documents", "report_events", "report_runs"];

async function databaseFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-retention-"));
  const path = join(directory, "reports.sqlite");
  const database = await NodeSqliteDatabase.open(path);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return { database, path };
}

async function scalar(database, query, ...values) {
  const result = await database.prepare(query).bind(...values).all();
  return Number(result.results?.[0]?.count || 0);
}

async function seedCompleteReport(database, suffix, createdAt = OLD) {
  const run = await createReportRun({ primaryDomain: `${suffix}.example` }, createdAt, database);
  const id = run.id;
  const observed = createdAt.toISOString();
  await database.batch([
    database.prepare("INSERT INTO report_documents (run_id, schema_version, document_json, observed_at, updated_at) VALUES (?, 1, '{}', ?, ?)").bind(id, observed, observed),
    database.prepare("INSERT INTO report_companies (run_id, domain, role, company_name, evidence_url, evidence_json, observed_at) VALUES (?, ?, 'primary', '', '', '{}', ?)").bind(id, `${suffix}.example`, observed),
    database.prepare("INSERT INTO report_products (run_id, domain, product_id, name, normalized_name, source_url, image_url, price_json, metadata_json, observed_at) VALUES (?, ?, ?, 'Product', '', ?, '', '[]', '{}', ?)").bind(id, `${suffix}.example`, `product-${suffix}`, `https://${suffix}.example/product`, observed),
    database.prepare("INSERT INTO report_matches (id, run_id, primary_product_id, rival_product_id, rival_domain, verdict, confidence, claim_type, model, prompt_version, evidence_json, observed_at) VALUES (?, ?, ?, ?, 'rival.example', 'same_product', 'high', 'observed', '', '', '{}', ?)").bind(`match-${suffix}`, id, `product-${suffix}`, `rival-${suffix}`, observed),
    database.prepare("INSERT INTO report_ads (id, run_id, domain, platform, status, evidence_json, observed_at) VALUES (?, ?, ?, 'Meta', 'verified-active', '{}', ?)").bind(`ad-${suffix}`, id, `${suffix}.example`, observed),
    database.prepare("INSERT INTO report_fact_chunks (run_id, manifest_id, attempt_number, kind, chunk_index, chunk_count, item_count, content_hash, created_at) VALUES (?, ?, 1, 'products', 0, 1, 1, ?, ?)").bind(id, `manifest-${suffix}`, `hash-${suffix}`, observed),
    database.prepare("INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) VALUES (?, ?, 1, ?, 1, 1, 1, 1, 'complete', '', '', ?)").bind(id, `manifest-${suffix}`, `manifest-hash-${suffix}`, observed),
    database.prepare("INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, created_at) VALUES (?, ?, 'report', ?, ?, 'v1', 'r1', 'deterministic', 'deterministic_only', ?)").bind(`evaluation-${suffix}`, id, `input-${suffix}`, `manifest-hash-${suffix}`, observed),
    database.prepare("INSERT INTO report_quality_signals (id, evaluation_id, run_id, primary_domain, stage, issue_key, severity, evidence_json, observed_at) VALUES (?, ?, ?, ?, 'crawl', ?, 'medium', '{}', ?)").bind(`signal-${suffix}`, `evaluation-${suffix}`, id, `${suffix}.example`, `issue-${suffix}`, observed),
  ]);
  return run;
}

test("one atomic pass purges every report artifact and records exact anonymous counts", async (t) => {
  const { database } = await databaseFixture(t);
  await seedCompleteReport(database, "expired");
  await seedCompleteReport(database, "fresh", NOW);
  const recent = await seedCompleteReport(database, "recent");
  await database.prepare("UPDATE report_runs SET heartbeat_at = ? WHERE id = ?").bind(NOW.toISOString(), recent.id).run();

  const result = await purgeExpiredReports(NOW, database);
  assert.deepEqual(result.deleted, { runs: 1, qualitySignals: 1, evaluations: 1, ads: 1, matches: 1, products: 1, companies: 1, factChunks: 1, factManifests: 1, documents: 1, events: 1 });
  assert.equal(result.remaining, 0);
  for (const table of TABLES) assert.equal(await scalar(database, `SELECT COUNT(*) AS count FROM ${table}`), 2, table);
  const audits = await database.prepare("SELECT * FROM report_purge_audits").all();
  assert.equal(audits.results.length, 1);
  assert.equal(audits.results[0].runs_deleted, 1);
  assert.equal("run_id" in audits.results[0], false);
  assert.equal("primary_domain" in audits.results[0], false);
});

test("retention includes exact cutoff boundaries and is replay safe", async (t) => {
  const { database } = await databaseFixture(t);
  const run = await seedCompleteReport(database, "boundary");
  const heartbeatGuard = new Date(NOW.getTime() - 86_400_000).toISOString();
  await database.prepare("UPDATE report_runs SET expires_at = ?, heartbeat_at = ? WHERE id = ?").bind(NOW.toISOString(), heartbeatGuard, run.id).run();
  assert.equal((await purgeExpiredReports(NOW, database)).deleted.runs, 1);
  assert.equal((await purgeExpiredReports(NOW, database)).deleted.runs, 0);
  assert.equal(await scalar(database, "SELECT COUNT(*) AS count FROM report_purge_audits"), 1);
});

test("retention preserves an expired report while its evaluation lease is active", async (t) => {
  const { database } = await databaseFixture(t);
  const run = await seedCompleteReport(database, "active-evaluation");
  const oldHeartbeat = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
  const activeLease = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  await database.prepare("UPDATE report_runs SET expires_at = ?, heartbeat_at = ? WHERE id = ?").bind(NOW.toISOString(), oldHeartbeat, run.id).run();
  await database.prepare("UPDATE report_evaluations SET status = 'judging', lease_expires_at = ? WHERE run_id = ?").bind(activeLease, run.id).run();

  assert.equal((await purgeExpiredReports(NOW, database)).deleted.runs, 0);
  assert.equal(await scalar(database, "SELECT COUNT(*) AS count FROM report_runs WHERE id = ?", run.id), 1);

  await database.prepare("UPDATE report_evaluations SET lease_expires_at = ? WHERE run_id = ?").bind(NOW.toISOString(), run.id).run();
  assert.equal((await purgeExpiredReports(NOW, database)).deleted.runs, 0);
  const reconciled = (await database.prepare("SELECT status, rating_basis, error_code FROM report_evaluations WHERE run_id = ?").bind(run.id).all()).results[0];
  assert.deepEqual(reconciled, { status: "agent_rejected", rating_basis: "deterministic_only", error_code: "agent-call-outcome-unknown" });
  assert.equal((await purgeExpiredReports(new Date(NOW.getTime() + 2 * 86_400_000), database)).deleted.runs, 1);
});

test("retention makes an abandoned dispatch recoverable without changing report observation time", async (t) => {
  const { database } = await databaseFixture(t);
  const run = await seedCompleteReport(database, "expired-dispatch");
  const originalUpdatedAt = OLD.toISOString();
  const oldHeartbeat = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
  await database.prepare("UPDATE report_runs SET expires_at = ?, heartbeat_at = ? WHERE id = ?").bind(NOW.toISOString(), oldHeartbeat, run.id).run();
  await database.prepare("UPDATE report_evaluations SET status = 'dispatching', dispatch_generation = 1, dispatch_outcome = 'unknown', lease_token = ?, lease_expires_at = ? WHERE run_id = ?").bind("d".repeat(64), NOW.toISOString(), run.id).run();

  assert.equal((await purgeExpiredReports(NOW, database)).deleted.runs, 0);
  const evaluation = (await database.prepare("SELECT status, dispatch_generation, dispatch_outcome, lease_expires_at FROM report_evaluations WHERE run_id = ?").bind(run.id).all()).results[0];
  assert.deepEqual(evaluation, { status: "dispatch_failed", dispatch_generation: 1, dispatch_outcome: "unknown", lease_expires_at: "" });
  const persistedRun = (await database.prepare("SELECT heartbeat_at, updated_at FROM report_runs WHERE id = ?").bind(run.id).all()).results[0];
  assert.deepEqual(persistedRun, { heartbeat_at: NOW.toISOString(), updated_at: originalUpdatedAt });
  assert.equal((await purgeExpiredReports(new Date(NOW.getTime() + 2 * 86_400_000), database)).deleted.runs, 1);
});

test("an injected SQLite child-delete failure rolls back deletes and audit insertion", async (t) => {
  const { database } = await databaseFixture(t);
  await seedCompleteReport(database, "rollback");
  await database.prepare("CREATE TRIGGER reject_product_purge BEFORE DELETE ON report_products BEGIN SELECT RAISE(ABORT, 'injected retention failure'); END").run();
  await assert.rejects(() => purgeExpiredReports(NOW, database), /injected retention failure/);
  for (const table of TABLES) assert.equal(await scalar(database, `SELECT COUNT(*) AS count FROM ${table}`), 1, table);
  assert.equal(await scalar(database, "SELECT COUNT(*) AS count FROM report_purge_audits"), 0);
});

test("two SQLite connections serialize overlapping passes without duplicate deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-retention-concurrent-"));
  const path = join(directory, "reports.sqlite");
  const database = await NodeSqliteDatabase.open(path);
  const second = await NodeSqliteDatabase.open(path);
  t.after(async () => { second.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  for (let index = 0; index < 30; index += 1) await createReportRun({ primaryDomain: `batch-${index}.example` }, OLD, database);
  const [left, right] = await Promise.all([purgeExpiredReports(NOW, database), purgeExpiredReports(NOW, second)]);
  assert.equal(left.deleted.runs + right.deleted.runs, 30);
  assert.equal(await scalar(database, "SELECT COUNT(*) AS count FROM report_runs"), 0);
  assert.equal(await scalar(database, "SELECT SUM(runs_deleted) AS count FROM report_purge_audits"), 30);
});

test("D1-compatible purge uses one guarded batch in the required child order", async () => {
  const batches = [];
  const database = {
    prepare(query) { return { query, values: [], bind(...values) { this.values = values; return this; }, async run() { return {}; }, async all() { return { results: [] }; } }; },
    async batch(statements) {
      batches.push(statements);
      return statements.map((_, index) => index === statements.length - 1 ? { results: [{ count: 0 }] } : { results: [] });
    },
  };
  await purgeExpiredReports(NOW, database);
  assert.equal(batches.length, 1);
  const deletes = batches[0].map((statement) => statement.query).filter((query) => query.startsWith("DELETE FROM report_") && !query.startsWith("DELETE FROM report_purge_audits"));
  assert.deepEqual(deletes.map((query) => /^DELETE FROM (\w+)/.exec(query)[1]), TABLES);
  for (const query of deletes) assert.match(query, /expires_at <= \? AND heartbeat_at <= \?/);
});

test("internal retention endpoint enforces auth, body bounds, and the closed action", async () => {
  let purges = 0;
  const handler = createRetentionHandler(TOKEN, { purge: async () => { purges += 1; return { cutoff: NOW.toISOString(), heartbeatGuard: NOW.toISOString(), deleted: { runs: 0 }, remaining: 0 }; } });
  const request = (body, token = TOKEN, headers = {}) => new Request("https://market.example/api/internal/retention", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await handler(request({ action: "purge-expired" }, "wrong"))).status, 401);
  assert.equal((await handler(request({ action: "other" }))).status, 400);
  assert.equal((await handler(request({ action: "purge-expired", cutoff: "caller-controlled" }))).status, 400);
  assert.equal((await handler(request({ action: "purge-expired" }, TOKEN, { "Content-Length": "1025" }))).status, 400);
  const accepted = await handler(request({ action: "purge-expired" }));
  assert.equal(accepted.status, 200);
  assert.equal(purges, 1);
});

test("retention worker requires its additive capability and uses the private endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith("/capabilities")) return Response.json(createWorkerApiManifest(() => NOW));
    return Response.json({ ok: true, deleted: { runs: 0 }, remaining: 0 });
  };
  const port = createReportRetentionHttpPort({ appOrigin: "https://market.example", callbackToken: TOKEN, fetchImpl });
  await port.preflight();
  assert.deepEqual(await port.purge(), { deleted: { runs: 0 }, remaining: 0 });
  assert.equal(calls[1].url, "https://market.example/api/internal/retention");
  assert.equal(calls[1].init.body, JSON.stringify({ action: "purge-expired" }));

  const legacy = createWorkerApiManifest(() => NOW);
  legacy.capabilities = legacy.capabilities.filter((item) => item !== REPORT_RETENTION_CAPABILITY);
  const incompatible = createReportRetentionHttpPort({ appOrigin: "https://market.example", callbackToken: TOKEN, fetchImpl: async () => Response.json(legacy) });
  await assert.rejects(() => incompatible.preflight(), /does not support report retention/);
});

test("scheduled retention stops at zero or caps at forty passes with bounded logging", async () => {
  let calls = 0;
  const logs = [];
  const completed = await runReportRetention({ preflight: async () => {}, purge: async () => ({ deleted: { runs: 1 }, remaining: calls++ === 0 ? 1 : 0 }) }, (message, metadata) => logs.push({ message, metadata }));
  assert.deepEqual(completed, { ok: true, passes: 2, deleted: { runs: 2 }, remaining: 0, capped: false });
  assert.equal(logs.length, 3);

  calls = 0;
  const capped = await runReportRetention({ preflight: async () => {}, purge: async () => { calls += 1; return { deleted: { runs: 25 }, remaining: 1 }; } }, () => {});
  assert.equal(calls, MAX_RETENTION_PASSES);
  assert.deepEqual(capped, { ok: false, passes: 40, deleted: { runs: 1_000 }, remaining: 1, capped: true });
});

test("Trigger retention declaration is daily, singleton, retried, and time bounded", async () => {
  const source = await readFile(new URL("../src/trigger/report-retention.ts", import.meta.url), "utf8");
  assert.match(source, /schedules\.task/);
  assert.match(source, /cron:\s*"17 3 \* \* \*"/);
  assert.match(source, /maxDuration:\s*120/);
  assert.match(source, /maxAttempts:\s*3/);
  assert.match(source, /concurrencyLimit:\s*1/);
});
