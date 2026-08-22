import assert from "node:assert/strict";
import test from "node:test";

import { appendReportEvent, compactReportDocument, createReportRun, createReportRunResult, getStoredReport, loadReportMatchBatchCheckpoints, markReportDispatched, MAX_REPORT_DOCUMENT_BYTES, MAX_REPORT_MATCH_BATCH_RESULT_BYTES, recoverInterruptedReport, reportStorageDiagnosticCode, ReportStorageError, saveReportDocument, saveReportMatchBatchCheckpoint } from "../app/lib/report-store.ts";
import { MAX_REPORT_ATTEMPTS } from "../src/shared/report-orchestration-contract.ts";

class FakeStatement {
  constructor(database, query) { this.database = database; this.query = query; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { this.database.queries.push(this.query); return {}; }
  async all() {
    if (this.query.startsWith("SELECT key FROM report_runtime_schema_markers")) return { results: [{ key: "evaluation-feedback-pending-backfill-v1" }] };
    if (this.query.startsWith("SELECT * FROM report_runs")) {
      const key = this.values[0];
      return { results: this.database.runs.filter((run) => run.public_id === key || run.id === key).slice(0, 1) };
    }
    if (this.query.startsWith("SELECT sequence")) {
      return { results: this.database.events.filter((event) => event.run_id === this.values[0]).sort((a, b) => a.sequence - b.sequence).slice(0, 1_000) };
    }
    if (this.query.startsWith("SELECT schema_version")) {
      return { results: this.database.documents.filter((document) => document.run_id === this.values[0]).slice(0, 1) };
    }
    if (this.query.startsWith("SELECT idempotency_key FROM report_events")) {
      return { results: this.database.events.filter((event) => event.run_id === this.values[0] && event.idempotency_key === this.values[1]).slice(0, 1) };
    }
    return { results: [] };
  }
}

class FakeDatabase {
  constructor() { this.runs = []; this.events = []; this.documents = []; this.queries = []; }
  prepare(query) { return new FakeStatement(this, query); }
  async batch(statements) {
    for (const statement of statements) {
      this.queries.push(statement.query);
      const q = statement.query;
      const v = statement.values;
      if (q.startsWith("CREATE")) continue;
      if (q.startsWith("INSERT INTO report_runs")) {
        this.runs.push({ id: v[0], public_id: v[1], primary_domain: v[2], locale: v[3], status: "queued", current_phase: "queued", attempt_count: 1, created_at: v[4], updated_at: v[5], heartbeat_at: v[6], expires_at: v[7], error_code: "", error_message: "" });
      } else if (q.includes("'run-created'")) {
        this.events.push({ run_id: v[0], sequence: 1, idempotency_key: "run-created", phase: "queued", status: "queued", message: "Report queued for public-source collection.", metadata_json: "{}", observed_at: v[1] });
      } else if (q.includes("'stale-worker-interrupted'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === "stale-worker-interrupted")) this.events.push({ run_id: v[0], sequence: Math.max(...this.events.map((event) => event.sequence)) + 1, idempotency_key: "stale-worker-interrupted", phase: "interrupted", status: "interrupted", message: v[2], metadata_json: "{}", observed_at: v[3] });
      } else if (q.includes("'queued-dispatch-timeout'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === "queued-dispatch-timeout")) this.events.push({ run_id: v[0], sequence: Math.max(...this.events.map((event) => event.sequence)) + 1, idempotency_key: "queued-dispatch-timeout", phase: "failed", status: "failed", message: v[2], metadata_json: "{}", observed_at: v[3] });
      } else if (q.includes("'The interrupted background report was authorized")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === v[2])) this.events.push({ run_id: v[0], sequence: Math.max(...this.events.map((event) => event.sequence)) + 1, idempotency_key: v[2], phase: "queued", status: "queued", message: "The interrupted background report was authorized for another attempt.", metadata_json: v[3], observed_at: v[4] });
      } else if (q.startsWith("INSERT INTO report_events") && q.includes("COALESCE") && !q.includes("'report-saved'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === v[2])) {
          this.events.push({ run_id: v[0], sequence: Math.max(0, ...this.events.filter((event) => event.run_id === v[0]).map((event) => event.sequence)) + 1, idempotency_key: v[2], phase: v[3], status: v[4], message: v[5], metadata_json: v[6], observed_at: v[7] });
        }
      } else if (q.startsWith("UPDATE report_runs SET status = ?, current_phase = ?")) {
        const latest = this.events.filter((event) => event.run_id === v[9]).sort((a, b) => b.sequence - a.sequence)[0];
        if (latest?.idempotency_key === v[8]) Object.assign(this.runs.find((run) => run.id === v[6]), { status: v[0], current_phase: v[1], updated_at: v[2], heartbeat_at: v[3], error_code: v[4], error_message: v[5] });
      } else if (q.startsWith("INSERT INTO report_documents")) {
        const existing = this.documents.find((document) => document.run_id === v[0]);
        const row = { run_id: v[0], schema_version: v[1], document_json: v[2], observed_at: v[3], updated_at: v[4] };
        if (existing) Object.assign(existing, row); else this.documents.push(row);
      } else if (q.startsWith("UPDATE report_runs SET status = ?, current_phase = 'complete'")) {
        Object.assign(this.runs.find((run) => run.id === v[3]), { status: v[0], current_phase: "complete", updated_at: v[1], heartbeat_at: v[2], error_code: "", error_message: "" });
      } else if (q.includes("'report-saved'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === "report-saved")) this.events.push({ run_id: v[0], sequence: Math.max(...this.events.map((event) => event.sequence)) + 1, idempotency_key: "report-saved", phase: "complete", status: v[2], message: "Report saved from the completed public-source phases.", metadata_json: "{}", observed_at: v[3] });
      } else if (q.startsWith("UPDATE report_runs SET status = 'interrupted'")) {
        Object.assign(this.runs.find((run) => run.id === v[2]), { status: "interrupted", current_phase: "interrupted", updated_at: v[0], error_code: "stale-worker", error_message: v[1] });
      } else if (q.startsWith("UPDATE report_runs SET status = 'failed'")) {
        Object.assign(this.runs.find((run) => run.id === v[2]), { status: "failed", current_phase: "failed", updated_at: v[0], error_code: "dispatch-timeout", error_message: v[1] });
      } else if (q.startsWith("UPDATE report_runs SET status = 'queued'")) {
        Object.assign(this.runs.find((run) => run.id === v[3]), { status: "queued", current_phase: "queued", attempt_count: v[0], updated_at: v[1], heartbeat_at: v[2], error_code: "", error_message: "" });
      }
    }
    return statements.map(() => ({}));
  }
}

class CheckpointStatement {
  constructor(database, query) { this.database = database; this.query = query; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async all() {
    if (this.query.startsWith("SELECT key FROM report_runtime_schema_markers")) return { results: [{ key: "evaluation-feedback-pending-backfill-v1" }] };
    if (this.query.startsWith("SELECT * FROM report_runs")) {
      const key = this.values[0];
      return { results: this.database.runs.filter((run) => run.public_id === key || run.id === key).slice(0, 1) };
    }
    if (this.query.includes("FROM report_match_batch_checkpoints")) {
      const [runId, attemptNumber, batchIndex] = this.values;
      return { results: this.database.checkpoints.filter((row) => row.run_id === runId && row.attempt_number === attemptNumber && (batchIndex === undefined || row.batch_index === batchIndex)).sort((left, right) => left.batch_index - right.batch_index) };
    }
    return { results: [] };
  }
  async run() {
    this.database.queries.push(this.query);
    if (this.query.startsWith("INSERT INTO report_match_batch_checkpoints")) {
      const v = this.values;
      const run = this.database.runs.find((row) => row.id === v[8] && row.attempt_count === v[9] && !["complete", "limited", "failed", "interrupted"].includes(row.status));
      const existing = this.database.checkpoints.find((row) => row.run_id === v[0] && row.attempt_number === v[1] && row.batch_index === v[2]);
      if (run && !existing) this.database.checkpoints.push({ run_id: v[0], attempt_number: v[1], batch_index: v[2], input_hash: v[3], result_json: v[4], result_hash: v[5], created_at: v[6], updated_at: v[7] });
    }
    return {};
  }
}

class CheckpointDatabase {
  constructor(status = "running", attemptCount = 1) {
    this.publicId = "a".repeat(32);
    this.runs = [{ id: "run-checkpoint", public_id: this.publicId, primary_domain: "example.com", locale: "en", status, current_phase: "matching", attempt_count: attemptCount, created_at: "2026-08-07T00:00:00.000Z", updated_at: "2026-08-07T00:00:00.000Z", heartbeat_at: "2026-08-07T00:00:00.000Z", expires_at: "2026-11-07T00:00:00.000Z", error_code: "", error_message: "" }];
    this.checkpoints = [];
    this.queries = [];
  }
  prepare(query) { return new CheckpointStatement(this, query); }
  async batch() { throw new Error("checkpoint tests do not use database batches"); }
}

test("match batch checkpoints persist bounded canonical results and replay idempotently", async () => {
  const database = new CheckpointDatabase();
  const inputHash = "1".repeat(64);
  const first = await saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 0, inputHash, result: { matches: [{ score: 0.9, id: "p-1" }], usage: { output: 12, input: 34 } } }, new Date("2026-08-07T00:01:00.000Z"), database);
  assert.equal(first.replayed, false);
  assert.match(first.checkpoint.resultHash, /^[a-f0-9]{64}$/);

  const replay = await saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 0, inputHash, result: { usage: { input: 34, output: 12 }, matches: [{ id: "p-1", score: 0.9 }] } }, new Date("2026-08-07T00:02:00.000Z"), database);
  assert.equal(replay.replayed, true);
  assert.equal(database.checkpoints.length, 1);
  const loaded = await loadReportMatchBatchCheckpoints(database.publicId, { attemptNumber: 1, batchIndex: 0 }, database);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].result, { matches: [{ id: "p-1", score: 0.9 }], usage: { input: 34, output: 12 } });
  database.checkpoints[0].result_json = JSON.stringify({ matches: [{ id: "tampered" }] });
  await assert.rejects(() => loadReportMatchBatchCheckpoints(database.publicId, { attemptNumber: 1, batchIndex: 0 }, database), /integrity validation/);
});

test("match batch checkpoints reject conflicts, invalid hashes, stale attempts, terminal reports, and oversized results", async () => {
  const database = new CheckpointDatabase();
  const inputHash = "2".repeat(64);
  await saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 4, inputHash, result: { accepted: ["p-1"] } }, new Date(), database);
  await assert.rejects(() => saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 4, inputHash, result: { accepted: ["p-2"] } }, new Date(), database), /conflicts/);
  await assert.rejects(() => saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 4, inputHash: "3".repeat(64), result: { accepted: ["p-1"] } }, new Date(), database), /conflicts/);
  await assert.rejects(() => saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 5, inputHash, result: {}, resultHash: "4".repeat(64) }, new Date(), database), /does not match/);
  await assert.rejects(() => saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 5, inputHash, result: { value: "x".repeat(MAX_REPORT_MATCH_BATCH_RESULT_BYTES) } }, new Date(), database), /too large/);

  database.runs[0].attempt_count = 2;
  await assert.rejects(() => loadReportMatchBatchCheckpoints(database.publicId, { attemptNumber: 1 }, database), /stale/);
  await assert.rejects(() => saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 1, batchIndex: 5, inputHash, result: {} }, new Date(), database), /stale/);
  database.runs[0].status = "complete";
  await assert.rejects(() => loadReportMatchBatchCheckpoints(database.publicId, { attemptNumber: 2 }, database), /terminal report/);
  await assert.rejects(() => saveReportMatchBatchCheckpoint(database.publicId, { attemptNumber: 2, batchIndex: 5, inputHash, result: {} }, new Date(), database), /terminal report/);
});

test("report runs persist ordered idempotent events and a reloadable document", async () => {
  const database = new FakeDatabase();
  const createdAt = new Date("2026-07-16T00:00:00.000Z");
  const created = await createReportRun({ primaryDomain: "https://NOORORGANICFOOD.com/", locale: "ar" }, createdAt, database);
  assert.match(created.publicId, /^[a-f0-9]{32}$/);
  assert.equal(created.primaryDomain, "noororganicfood.com");
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages.", metadata: { pages: 5 } }, new Date("2026-07-16T00:01:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Duplicate transport retry.", metadata: { pages: 5 } }, new Date("2026-07-16T00:01:01.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "ads-started", phase: "ads", status: "running", message: "Checking attributable ads." }, new Date("2026-07-16T00:01:02.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "actions-started", phase: "actions", status: "running", message: "Drafting evidence-grounded next moves." }, new Date("2026-07-16T00:01:02.500Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Late duplicate transport retry." }, new Date("2026-07-16T00:01:03.000Z"), database);
  await saveReportDocument(created.publicId, { blocks: [{ type: "market-profile", id: "profile" }, { type: "presentation-compaction", id: "presentation-compaction", relationalFactsAuthoritative: true, factCounts: { companies: 99, products: 99, matches: 99, ads: 99 } }] }, { status: "complete", expectedFactManifestHash: "" }, new Date("2026-07-16T00:02:00.000Z"), database);
  const reloaded = await getStoredReport(created.publicId, new Date("2026-07-16T00:03:00.000Z"), database);
  assert.equal(reloaded.run.status, "complete");
  assert.deepEqual(reloaded.events.map((event) => event.idempotencyKey), ["run-created", "crawl-started", "ads-started", "actions-started", "report-saved"]);
  assert.deepEqual(reloaded.events[1].metadata, { pages: 5 });
  assert.equal(reloaded.document.blocks[0].type, "market-profile");
  assert.equal(reloaded.document.blocks[0].id, "profile");
  assert.equal(reloaded.document.blocks[1].type, "presentation-compaction");
  assert.equal(reloaded.document.blocks[1].relationalFactsAuthoritative, false);
  assert.equal(reloaded.document.blocks[1].factCounts, null);
  assert.equal(reloaded.documentSchemaVersion, 1);
});

test("stored reports retain cursor checkpoints beyond the former 100-event window", async () => {
  const database = new FakeDatabase();
  const observedAt = "2026-07-16T00:00:00.000Z";
  const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date(observedAt), database);
  for (let sequence = 2; sequence <= 151; sequence += 1) database.events.push({
    run_id: created.id,
    sequence,
    idempotency_key: `event-${sequence}`,
    phase: "competitors",
    status: "running",
    message: "Bounded progress event.",
    metadata_json: sequence === 151 ? JSON.stringify({ discoveryStartIndex: 800, discoveryEndIndex: 1_000, discoveryBatchComplete: true, discoveryAnchorSetHash: "a".repeat(64) }) : "{}",
    observed_at: observedAt,
  });

  const reloaded = await getStoredReport(created.publicId, new Date("2026-07-16T00:01:00.000Z"), database);
  assert.equal(reloaded.events.length, 151);
  assert.equal(reloaded.events.at(-1)?.metadata.discoveryEndIndex, 1_000);
});

test("limited phase events remain visible without making the run terminal before document persistence", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "parked.example" }, new Date("2026-07-20T10:00:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-limited", phase: "crawl", status: "limited", message: "The submitted domain is parked." }, new Date("2026-07-20T10:01:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "ads-limited", phase: "ads", status: "limited", message: "Ads were skipped because the primary crawl was limited." }, new Date("2026-07-20T10:01:01.000Z"), database);
  const progressing = await getStoredReport(created.publicId, new Date("2026-07-20T10:01:02.000Z"), database);
  assert.equal(progressing.run.status, "running");
  assert.equal(progressing.events.find((event) => event.idempotencyKey === "crawl-limited").status, "limited");
  assert.equal(progressing.events.find((event) => event.idempotencyKey === "ads-limited").status, "limited");
  await saveReportDocument(created.publicId, { primaryDomain: "parked.example", document: { version: "1", blocks: [] } }, { status: "limited", expectedFactManifestHash: "" }, new Date("2026-07-20T10:02:00.000Z"), database);
  const saved = await getStoredReport(created.publicId, new Date("2026-07-20T10:02:01.000Z"), database);
  assert.equal(saved.run.status, "limited");
});

test("stale active report becomes interrupted with a visible event", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-16T00:00:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages." }, new Date("2026-07-16T00:01:00.000Z"), database);
  const report = await getStoredReport(created.publicId, new Date("2026-07-16T00:45:00.000Z"), database);
  assert.equal(report.run.status, "interrupted");
  assert.equal(report.events.at(-1).idempotencyKey, "stale-worker-interrupted");
  assert.match(report.run.errorMessage, /background worker/i);
});

test("queued jobs use a separate dispatch timeout only after confirmed dispatch", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-16T00:00:00.000Z"), database);
  const unconfirmed = await getStoredReport(created.publicId, new Date("2026-07-16T02:00:00.000Z"), database);
  assert.equal(unconfirmed.run.status, "queued");
  await markReportDispatched(created.publicId, "run_confirmed123", new Date("2026-07-16T02:01:00.000Z"), database);
  const waiting = await getStoredReport(created.publicId, new Date("2026-07-16T02:45:00.000Z"), database);
  assert.equal(waiting.run.status, "queued");
  const timedOut = await getStoredReport(created.publicId, new Date("2026-07-16T03:02:00.000Z"), database);
  assert.equal(timedOut.run.status, "failed");
  assert.equal(timedOut.run.errorCode, "dispatch-timeout");
  assert.equal(timedOut.events.at(-1).idempotencyKey, "queued-dispatch-timeout");
});

test("dispatch telemetry cannot regress a report whose worker already started", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-16T00:00:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages." }, new Date("2026-07-16T00:00:01.000Z"), database);
  const result = await markReportDispatched(created.publicId, "run_faststart1", new Date("2026-07-16T00:00:02.000Z"), database);
  const stored = await getStoredReport(created.publicId, new Date("2026-07-16T00:00:03.000Z"), database);
  assert.equal(result.skipped, true);
  assert.equal(stored.run.status, "running");
  assert.equal(stored.run.currentPhase, "crawl");
  assert.deepEqual(stored.events.map((event) => event.idempotencyKey), ["run-created", "crawl-started"]);
});

test("interrupted jobs require an explicit recovery that increments the dispatch attempt", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-16T00:00:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages." }, new Date("2026-07-16T00:01:00.000Z"), database);
  await getStoredReport(created.publicId, new Date("2026-07-16T00:45:00.000Z"), database);
  const recovered = await recoverInterruptedReport(created.publicId, new Date("2026-07-16T00:46:00.000Z"), database);
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.attemptCount, 2);
  const report = await getStoredReport(created.publicId, new Date("2026-07-16T00:47:00.000Z"), database);
  assert.equal(report.events.at(-1).idempotencyKey, "recovery-attempt-2");
  await assert.rejects(() => recoverInterruptedReport(created.publicId, new Date(), database), /Only an interrupted report/);

  database.runs[0].status = "interrupted";
  database.runs[0].attempt_count = MAX_REPORT_ATTEMPTS;
  await assert.rejects(() => recoverInterruptedReport(created.publicId, new Date(), database), /recovery-attempt limit/);
});

test("report persistence rejects missing databases, invalid ids, and oversized documents", async () => {
  await assert.rejects(() => createReportRun({ primaryDomain: "example.com" }, new Date(), null), /unavailable/);
  await assert.rejects(() => createReportRun({ primaryDomain: "not a domain" }, new Date(), new FakeDatabase()), /valid public domain/);
  await assert.rejects(() => getStoredReport("enumerate-me", new Date(), new FakeDatabase()), /Invalid report id/);
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "example.com" }, new Date(), database);
  await assert.rejects(() => saveReportDocument(created.publicId, { value: "x".repeat(MAX_REPORT_DOCUMENT_BYTES) }, { expectedFactManifestHash: "" }, new Date(), database), /budget|too large/);
});

test("terminal reports cannot regress or be overwritten", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "example.com" }, new Date("2026-07-16T00:00:00.000Z"), database);
  await saveReportDocument(created.publicId, { blocks: [] }, { expectedFactManifestHash: "" }, new Date("2026-07-16T00:01:00.000Z"), database);
  await assert.rejects(() => appendReportEvent(created.publicId, { idempotencyKey: "late", phase: "crawl", status: "running", message: "Late event." }, new Date(), database), /terminal report/);
  await assert.rejects(() => saveReportDocument(created.publicId, { blocks: [{ id: "replacement" }] }, { expectedFactManifestHash: "" }, new Date(), database), /terminal report/);
});

test("only a persisted document can declare a report complete", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "example.com" }, new Date(), database);
  await assert.rejects(() => appendReportEvent(created.publicId, { idempotencyKey: "false-complete", phase: "complete", status: "complete", message: "Done without a document." }, new Date(), database), /saved report document/);
});

test("large catalogs become a bounded truthful presentation snapshot", () => {
  const products = Array.from({ length: 500 }, (_, index) => ({ id: `p-${index}`, name: `Product ${index}`, description: "x".repeat(1800) }));
  const compacted = compactReportDocument({ primaryDomain: "example.com", document: { version: "1", blocks: [{ type: "product-catalog", id: "catalog", products }, { type: "product-unmatched", id: "unmatched", products }] } });
  assert.equal(compacted.document.blocks[0].products.length, 12);
  assert.equal(compacted.document.blocks[0].totalProductCount, 500);
  assert.equal(compacted.document.blocks[0].productsTruncated, true);
  assert.equal(compacted.document.blocks[1].products.length, 6);
  assert.ok(new TextEncoder().encode(JSON.stringify(compacted)).byteLength < MAX_REPORT_DOCUMENT_BYTES);
});

test("persistence preserves original counts on an already compacted transport snapshot", () => {
  const products = Array.from({ length: 40 }, (_, index) => ({ id: `p-${index}` }));
  const compacted = compactReportDocument({ version: "1", blocks: [{ type: "product-catalog", id: "catalog", products, persistedProductCount: 40, totalProductCount: 312, productsTruncated: true }] });
  const catalog = compacted.blocks[0];

  assert.equal(catalog.products.length, 12);
  assert.equal(catalog.persistedProductCount, 12);
  assert.equal(catalog.totalProductCount, 312);
  assert.equal(catalog.productsTruncated, true);
});

test("runtime schema materializes every declared report artifact table", async () => {
  const database = new FakeDatabase();
  await createReportRun({ primaryDomain: "example.com" }, new Date(), database);
  const schema = database.queries.join("\n");
  for (const table of ["report_runs", "report_events", "report_documents", "report_companies", "report_products", "report_matches", "report_ads", "report_match_batch_checkpoints", "report_evaluations", "report_quality_signals", "report_human_review_requests", "report_human_review_responses", "report_human_review_open", "report_purge_audits"]) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});

test("database acquisition diagnostics are closed and deduplicated", async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(() => createReportRun({ primaryDomain: "example.com" }), /unavailable/);
    await assert.rejects(() => createReportRun({ primaryDomain: "example.com" }), /unavailable/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged, [["report storage diagnostic", { diagnosticCode: "database-path-missing" }]]);
  assert.doesNotMatch(JSON.stringify(logged), /cloudflare:workers|stack|SQL|D1/i);
});

test("schema initialization identifies a failing DDL statement without exposing SQL", async () => {
  const database = {
    prepare(query) {
      return { bind() { return this; }, async all() { return { results: [] }; }, async run() { if (query.includes("report_runs_domain_recent_idx")) throw new Error("raw D1 SQL detail"); return {}; } };
    },
    async batch() { throw new Error("writes must not begin after schema failure"); },
  };
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        createReportRun({ primaryDomain: "example.com" }, new Date(), database),
        (error) => error instanceof ReportStorageError && error.code === "schema-statement-3-failed" && !/D1|SQL/i.test(error.message),
      );
    }
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged, [["report storage diagnostic", { diagnosticCode: "schema-statement-3-failed" }]]);
  assert.doesNotMatch(JSON.stringify(logged), /raw|D1|SQL/i);
});

test("atomic report creation classifies D1 batch failures without exposing raw details", async () => {
  const cases = [
    ["D1_ERROR: table report_runs has no column named attempt_count", "run-create-batch-schema-mismatch"],
    ["D1_ERROR: NOT NULL constraint failed", "run-create-batch-constraint"],
    ["Wrong number of parameter bindings", "run-create-batch-binding-count"],
    ["D1_ERROR: cannot start a transaction", "run-create-batch-transaction"],
    ["private backend detail", "run-create-batch-batch-api"],
  ];
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    for (const [message, expected] of [...cases, cases[3]]) {
      const database = new FakeDatabase();
      database.batch = async () => { throw new Error(message); };
      await assert.rejects(
        createReportRun({ primaryDomain: "example.com" }, new Date(), database),
        (error) => error instanceof ReportStorageError && error.code === expected && !/D1|backend|column|constraint/i.test(error.message),
      );
    }
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged.map((entry) => entry[1].diagnosticCode), cases.map((entry) => entry[1]));
  assert.doesNotMatch(JSON.stringify(logged), /D1_ERROR|private backend|no column named|parameter bindings|database is locked/i);
});

test("storage diagnostics survive a bundled error boundary but remain closed", () => {
  assert.equal(reportStorageDiagnosticCode(new ReportStorageError("run-create-batch-transaction")), "run-create-batch-transaction");
  assert.equal(reportStorageDiagnosticCode({ name: "ReportStorageError", code: "run-create-batch-schema-mismatch" }), "run-create-batch-schema-mismatch");
  assert.equal(reportStorageDiagnosticCode({ name: "ReportStorageError", code: "raw-private-detail" }), null);
  assert.equal(reportStorageDiagnosticCode(new Error("run-create-batch-constraint")), null);
});

test("report creation result carries only closed diagnostics across the route boundary", async () => {
  const database = new FakeDatabase();
  database.batch = async () => { throw new Error("D1_ERROR: table report_runs has no column named attempt_count"); };
  const classified = await createReportRunResult({ primaryDomain: "example.com" }, new Date(), database);
  assert.deepEqual(classified, { ok: false, diagnosticCode: "run-create-batch-schema-mismatch" });

  const foreign = await createReportRunResult({ primaryDomain: "example.com" }, { toISOString() { throw new Error("private detail"); } }, new FakeDatabase());
  assert.deepEqual(foreign, { ok: false, diagnosticCode: "run-create-unclassified" });
  assert.doesNotMatch(JSON.stringify(foreign), /private|detail/i);

  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("prototype trap"); }, get() { throw new Error("property trap"); } });
  const hostileResult = await createReportRunResult({ primaryDomain: "example.com" }, { toISOString() { throw hostile; } }, new FakeDatabase());
  assert.deepEqual(hostileResult, { ok: false, diagnosticCode: "run-create-unclassified" });

  const successful = await createReportRunResult({ primaryDomain: "example.com" }, new Date(), new FakeDatabase());
  assert.equal(successful.ok, true);
  assert.equal(successful.report.primaryDomain, "example.com");
});
