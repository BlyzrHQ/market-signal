import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

import { ensureReportSharingSchema } from "../app/lib/report-sharing-store.ts";

const migration = readFileSync(new URL("../drizzle/0017_clumsy_wildside.sql", import.meta.url), "utf8");
const statements = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);

function applyMigration(database) {
  for (const statement of statements) database.exec(statement);
}

function baseDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`CREATE TABLE report_runs (id text PRIMARY KEY NOT NULL);`);
  return database;
}

test("the report-sharing migration installs constrained capability links and immutable token-free audits", () => {
  const database = baseDatabase();
  try {
    applyMigration(database);
    const linkSql = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'report_share_links'`).get().sql;
    assert.match(linkSql, /length\(.+token.+\) = 64/is);
    assert.match(linkSql, /active.+IN \(0, 1\)/is);
    assert.match(linkSql, /rotation.+>= 1/is);

    database.prepare(`INSERT INTO report_runs (id) VALUES ('run-1')`).run();
    database.prepare(`INSERT INTO report_share_links (run_id, token, active, rotation, created_by_user_id, created_at, updated_at, revoked_at) VALUES (?, ?, 1, 1, 'user-1', '2026-08-24T12:00:00.000Z', '2026-08-24T12:00:00.000Z', '')`).run("run-1", "a".repeat(64));
    database.prepare(`INSERT INTO report_share_audits (id, run_id, workspace_id, actor_user_id, action, rotation, created_at) VALUES ('audit-1', 'run-1', 'workspace-1', 'user-1', 'share', 1, '2026-08-24T12:00:00.000Z')`).run();
    assert.equal(Object.hasOwn(database.prepare(`SELECT * FROM report_share_audits`).get(), "token"), false);
    assert.throws(() => database.prepare(`UPDATE report_share_audits SET action = 'unshare'`).run(), /immutable/);
    assert.throws(() => database.prepare(`DELETE FROM report_share_audits`).run(), /immutable/);
    database.prepare(`DELETE FROM report_runs WHERE id = 'run-1'`).run();
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM report_share_audits`).get().count, 0);
  } finally { database.close(); }
});

test("the generated report-sharing migration is safe after runtime bootstrap", () => {
  const database = baseDatabase();
  try {
    ensureReportSharingSchema(database);
    assert.doesNotThrow(() => applyMigration(database));
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('report_share_links') WHERE name = 'token'`).get().count, 1);
  } finally { database.close(); }
});
