import assert from "node:assert/strict";
import test from "node:test";

import { appendReportEvent, compactReportDocument, createReportRun, getStoredReport, MAX_REPORT_DOCUMENT_BYTES, saveReportDocument } from "../app/lib/report-store.ts";
import { mutateReport, PATCH, POST } from "../app/api/reports/[publicId]/route.ts";

class FakeStatement {
  constructor(database, query) { this.database = database; this.query = query; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { return {}; }
  async all() {
    if (this.query.startsWith("SELECT * FROM report_runs")) {
      const key = this.values[0];
      return { results: this.database.runs.filter((run) => run.public_id === key || run.id === key).slice(0, 1) };
    }
    if (this.query.startsWith("SELECT sequence")) {
      return { results: this.database.events.filter((event) => event.run_id === this.values[0]).sort((a, b) => a.sequence - b.sequence).slice(0, 100) };
    }
    if (this.query.startsWith("SELECT schema_version")) {
      return { results: this.database.documents.filter((document) => document.run_id === this.values[0]).slice(0, 1) };
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
      } else if (q.startsWith("INSERT INTO report_events") && q.includes("COALESCE") && !q.includes("'report-saved'") && !q.includes("'stale-run-interrupted'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === v[1])) {
          this.events.push({ run_id: v[0], sequence: Math.max(0, ...this.events.filter((event) => event.run_id === v[0]).map((event) => event.sequence)) + 1, idempotency_key: v[1], phase: v[2], status: v[3], message: v[4], metadata_json: v[5], observed_at: v[6] });
        }
      } else if (q.startsWith("UPDATE report_runs SET status = ?, current_phase = ?")) {
        const latest = this.events.filter((event) => event.run_id === v[8]).sort((a, b) => b.sequence - a.sequence)[0];
        if (latest?.idempotency_key === v[7]) Object.assign(this.runs.find((run) => run.id === v[6]), { status: v[0], current_phase: v[1], updated_at: v[2], heartbeat_at: v[3], error_code: v[4], error_message: v[5] });
      } else if (q.startsWith("INSERT INTO report_documents")) {
        const existing = this.documents.find((document) => document.run_id === v[0]);
        const row = { run_id: v[0], schema_version: v[1], document_json: v[2], observed_at: v[3], updated_at: v[4] };
        if (existing) Object.assign(existing, row); else this.documents.push(row);
      } else if (q.startsWith("UPDATE report_runs SET status = ?, current_phase = 'complete'")) {
        Object.assign(this.runs.find((run) => run.id === v[3]), { status: v[0], current_phase: "complete", updated_at: v[1], heartbeat_at: v[2], error_code: "", error_message: "" });
      } else if (q.includes("'report-saved'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === "report-saved")) this.events.push({ run_id: v[0], sequence: Math.max(...this.events.map((event) => event.sequence)) + 1, idempotency_key: "report-saved", phase: "complete", status: v[1], message: "Report saved from the completed public-source phases.", metadata_json: "{}", observed_at: v[2] });
      } else if (q.startsWith("UPDATE report_runs SET status = 'interrupted'")) {
        Object.assign(this.runs.find((run) => run.id === v[1]), { status: "interrupted", current_phase: "interrupted", updated_at: v[0], error_code: "stale-run", error_message: "The previous browser session stopped before this phase completed." });
      } else if (q.includes("'stale-run-interrupted'")) {
        if (!this.events.some((event) => event.run_id === v[0] && event.idempotency_key === "stale-run-interrupted")) this.events.push({ run_id: v[0], sequence: Math.max(...this.events.map((event) => event.sequence)) + 1, idempotency_key: "stale-run-interrupted", phase: "interrupted", status: "interrupted", message: "The previous browser session stopped before this phase completed.", metadata_json: "{}", observed_at: v[1] });
      }
    }
    return statements.map(() => ({}));
  }
}

test("report runs persist ordered idempotent events and a reloadable document", async () => {
  const database = new FakeDatabase();
  const createdAt = new Date("2026-07-16T00:00:00.000Z");
  const created = await createReportRun({ primaryDomain: "https://NOORORGANICFOOD.com/", locale: "ar" }, createdAt, database);
  assert.match(created.publicId, /^[a-f0-9]{32}$/);
  assert.equal(created.primaryDomain, "noororganicfood.com");
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages.", metadata: { pages: 5 } }, new Date("2026-07-16T00:01:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Duplicate transport retry.", metadata: { pages: 5 } }, new Date("2026-07-16T00:01:01.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "ads-started", phase: "ads", status: "running", message: "Checking attributable ads." }, new Date("2026-07-16T00:01:02.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Late duplicate transport retry." }, new Date("2026-07-16T00:01:03.000Z"), database);
  await saveReportDocument(created.publicId, { blocks: [{ type: "market-profile", id: "profile" }] }, { status: "complete" }, new Date("2026-07-16T00:02:00.000Z"), database);
  const reloaded = await getStoredReport(created.publicId, new Date("2026-07-16T00:03:00.000Z"), database);
  assert.equal(reloaded.run.status, "complete");
  assert.deepEqual(reloaded.events.map((event) => event.idempotencyKey), ["run-created", "crawl-started", "ads-started", "report-saved"]);
  assert.deepEqual(reloaded.events[1].metadata, { pages: 5 });
  assert.deepEqual(reloaded.document, { blocks: [{ type: "market-profile", id: "profile" }] });
  assert.equal(reloaded.documentSchemaVersion, 1);
});

test("stale active report becomes interrupted with a visible event", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-16T00:00:00.000Z"), database);
  await appendReportEvent(created.publicId, { idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages." }, new Date("2026-07-16T00:01:00.000Z"), database);
  const report = await getStoredReport(created.publicId, new Date("2026-07-16T00:20:00.000Z"), database);
  assert.equal(report.run.status, "interrupted");
  assert.equal(report.events.at(-1).idempotencyKey, "stale-run-interrupted");
});

test("report persistence rejects missing databases, invalid ids, and oversized documents", async () => {
  await assert.rejects(() => createReportRun({ primaryDomain: "example.com" }, new Date(), null), /unavailable/);
  await assert.rejects(() => createReportRun({ primaryDomain: "not a domain" }, new Date(), new FakeDatabase()), /valid public domain/);
  await assert.rejects(() => getStoredReport("enumerate-me", new Date(), new FakeDatabase()), /Invalid report id/);
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "example.com" }, new Date(), database);
  await assert.rejects(() => saveReportDocument(created.publicId, { value: "x".repeat(MAX_REPORT_DOCUMENT_BYTES) }, {}, new Date(), database), /too large/);
});

test("terminal reports cannot regress or be overwritten", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "example.com" }, new Date("2026-07-16T00:00:00.000Z"), database);
  await saveReportDocument(created.publicId, { blocks: [] }, {}, new Date("2026-07-16T00:01:00.000Z"), database);
  await assert.rejects(() => appendReportEvent(created.publicId, { idempotencyKey: "late", phase: "crawl", status: "running", message: "Late event." }, new Date(), database), /terminal report/);
  await assert.rejects(() => saveReportDocument(created.publicId, { blocks: [{ id: "replacement" }] }, {}, new Date(), database), /terminal report/);
});

test("only a persisted document can declare a report complete", async () => {
  const database = new FakeDatabase();
  const created = await createReportRun({ primaryDomain: "example.com" }, new Date(), database);
  await assert.rejects(() => appendReportEvent(created.publicId, { idempotencyKey: "false-complete", phase: "complete", status: "complete", message: "Done without a document." }, new Date(), database), /saved report document/);
});

test("large catalogs become a bounded truthful presentation snapshot", () => {
  const products = Array.from({ length: 500 }, (_, index) => ({ id: `p-${index}`, name: `Product ${index}`, description: "x".repeat(1800) }));
  const compacted = compactReportDocument({ primaryDomain: "example.com", document: { version: "1", blocks: [{ type: "product-catalog", id: "catalog", products }, { type: "product-unmatched", id: "unmatched", products }] } });
  assert.equal(compacted.document.blocks[0].products.length, 40);
  assert.equal(compacted.document.blocks[0].totalProductCount, 500);
  assert.equal(compacted.document.blocks[0].productsTruncated, true);
  assert.equal(compacted.document.blocks[1].products.length, 20);
  assert.ok(new TextEncoder().encode(JSON.stringify(compacted)).byteLength < MAX_REPORT_DOCUMENT_BYTES);
});

test("the deployed mutation route accepts the POST method used by postJson", () => {
  assert.equal(POST, mutateReport);
  assert.equal(PATCH, mutateReport);
});

test("runtime schema materializes every declared report artifact table", async () => {
  const database = new FakeDatabase();
  await createReportRun({ primaryDomain: "example.com" }, new Date(), database);
  const schema = database.queries.join("\n");
  for (const table of ["report_runs", "report_events", "report_documents", "report_companies", "report_products", "report_matches", "report_ads"]) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});
