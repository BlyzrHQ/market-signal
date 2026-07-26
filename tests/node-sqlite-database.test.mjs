import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { loadRememberedCompetitors, rememberVerifiedCompetitors } from "../app/lib/competitor-memory.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { appendReportEvent, createReportRun, getStoredReport, saveReportDocument } from "../app/lib/report-store.ts";
import { closeRuntimeDatabases, runtimeDatabase } from "../app/lib/runtime-database.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-sqlite-"));
  return { directory, databasePath: join(directory, "market-signal.sqlite") };
}

test("Node SQLite preserves reports and competitor memory after reopening", async () => {
  const { directory, databasePath } = await fixture();
  let database;
  try {
    database = await NodeSqliteDatabase.open(databasePath);
    const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-27T00:00:00.000Z"), database);
    await appendReportEvent(created.publicId, {
      idempotencyKey: "crawl-started",
      phase: "crawl",
      status: "running",
      message: "Collecting public pages.",
    }, new Date("2026-07-27T00:01:00.000Z"), database);
    await appendReportEvent(created.publicId, {
      idempotencyKey: "crawl-started",
      phase: "crawl",
      status: "running",
      message: "Duplicate transport retry.",
    }, new Date("2026-07-27T00:01:01.000Z"), database);
    await saveReportDocument(created.publicId, { blocks: [{ type: "summary", id: "summary", title: "Saved on the VPS" }] }, { status: "complete" }, new Date("2026-07-27T00:02:00.000Z"), database);
    const remembered = await rememberVerifiedCompetitors("myjam.co.uk", [{
      candidate: {
        domain: "oasismarket.co.uk",
        companyName: "Oasis Market",
        reason: "Observed overlapping halal grocery products.",
        searchQuery: "UK halal grocery products",
        sourceUrl: "https://oasismarket.co.uk/product/example",
        websiteUrl: "https://oasismarket.co.uk/",
        marketCategory: "halal grocery",
        relationship: "direct",
        sharedOfferings: ["halal grocery"],
        evidence: [{ url: "https://oasismarket.co.uk/product/example", title: "Example product", method: "product-search" }],
        mentionCount: 1,
        evidenceMethod: "search-source",
        provenance: "discovered-this-run",
      },
      verificationScore: 91,
    }], "2026-07-27T00:02:30.000Z", database);
    assert.deepEqual(remembered, { available: true, stored: 1 });
    database.close();

    database = await NodeSqliteDatabase.open(databasePath);
    const report = await getStoredReport(created.publicId, new Date("2026-07-27T00:03:00.000Z"), database);
    assert.equal(report.run.status, "complete");
    assert.equal(report.events.filter((event) => event.idempotencyKey === "crawl-started").length, 1);
    assert.equal(report.events.at(-1).idempotencyKey, "report-saved");
    assert.equal(report.document.blocks[0].title, "Saved on the VPS");
    const memory = await loadRememberedCompetitors("myjam.co.uk", new Date("2026-07-28T00:00:00.000Z"), database);
    assert.equal(memory.available, true);
    assert.equal(memory.candidates[0].domain, "oasismarket.co.uk");
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node SQLite configures WAL and rolls back a failed batch atomically", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    const journal = await database.prepare("PRAGMA journal_mode").all();
    const foreignKeys = await database.prepare("PRAGMA foreign_keys").all();
    const busyTimeout = await database.prepare("PRAGMA busy_timeout").all();
    assert.equal(journal.results[0].journal_mode, "wal");
    assert.equal(foreignKeys.results[0].foreign_keys, 1);
    assert.equal(busyTimeout.results[0].timeout, 10_000);

    await database.prepare("CREATE TABLE atomic_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)").run();
    await assert.rejects(database.batch([
      database.prepare("INSERT INTO atomic_probe (id, value) VALUES (?, ?)").bind(1, "first"),
      database.prepare("INSERT INTO atomic_probe (id, value) VALUES (?, ?)").bind(1, "duplicate"),
    ]), /UNIQUE constraint failed/);
    const rows = await database.prepare("SELECT id, value FROM atomic_probe").all();
    assert.deepEqual(rows.results, []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node SQLite rejects relative paths and statements prepared by another connection", async () => {
  await assert.rejects(NodeSqliteDatabase.open("./market-signal.sqlite"), /absolute filesystem path/);
  const firstFixture = await fixture();
  const secondFixture = await fixture();
  const first = await NodeSqliteDatabase.open(firstFixture.databasePath);
  const second = await NodeSqliteDatabase.open(secondFixture.databasePath);
  try {
    await assert.rejects(first.batch([second.prepare("CREATE TABLE wrong_connection (id INTEGER)")]), /same Node adapter/);
  } finally {
    first.close();
    second.close();
    await rm(firstFixture.directory, { recursive: true, force: true });
    await rm(secondFixture.directory, { recursive: true, force: true });
  }
});

test("two SQLite connections complete a write after real lock contention", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    await database.prepare("CREATE TABLE contention_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)").run();
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require("better-sqlite3");
      const database = new Database(workerData.databasePath);
      database.pragma("busy_timeout = 10000");
      database.exec("BEGIN IMMEDIATE");
      database.prepare("INSERT INTO contention_probe (id, value) VALUES (?, ?)").run(1, "worker");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
        parentPort.postMessage("committed");
      }, 150);
    `, { eval: true, workerData: { databasePath } });
    assert.deepEqual(await once(worker, "message"), ["locked"]);
    await database.batch([
      database.prepare("INSERT INTO contention_probe (id, value) VALUES (?, ?)").bind(2, "main"),
    ]);
    assert.deepEqual(await once(worker, "message"), ["committed"]);
    await once(worker, "exit");
    const rows = await database.prepare("SELECT id, value FROM contention_probe ORDER BY id").all();
    assert.deepEqual(rows.results, [{ id: 1, value: "worker" }, { id: 2, value: "main" }]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MARKET_SIGNAL_SQLITE_PATH selects durable SQLite without a database override", async () => {
  const { directory, databasePath } = await fixture();
  const previousPath = process.env.MARKET_SIGNAL_SQLITE_PATH;
  process.env.MARKET_SIGNAL_SQLITE_PATH = databasePath;
  try {
    const firstConnection = await runtimeDatabase();
    process.env.MARKET_SIGNAL_SQLITE_PATH = `${directory}${sep}.${sep}market-signal.sqlite`;
    const equivalentConnection = await runtimeDatabase();
    assert.equal(equivalentConnection, firstConnection);
    const created = await createReportRun({ primaryDomain: "noororganic.com" }, new Date("2026-07-27T02:00:00.000Z"));
    const stored = await getStoredReport(created.publicId, new Date("2026-07-27T02:01:00.000Z"));
    assert.equal(stored.run.primaryDomain, "noororganic.com");
    assert.equal(stored.run.status, "queued");
  } finally {
    await closeRuntimeDatabases();
    if (previousPath === undefined) delete process.env.MARKET_SIGNAL_SQLITE_PATH;
    else process.env.MARKET_SIGNAL_SQLITE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("competitor memory degrades safely when the SQLite path is invalid", async () => {
  const previousPath = process.env.MARKET_SIGNAL_SQLITE_PATH;
  process.env.MARKET_SIGNAL_SQLITE_PATH = "./relative.sqlite";
  try {
    const memory = await loadRememberedCompetitors("myjam.co.uk");
    assert.equal(memory.available, false);
    assert.deepEqual(memory.candidates, []);
    assert.match(memory.gap, /not configured/i);
  } finally {
    await closeRuntimeDatabases();
    if (previousPath === undefined) delete process.env.MARKET_SIGNAL_SQLITE_PATH;
    else process.env.MARKET_SIGNAL_SQLITE_PATH = previousPath;
  }
});
