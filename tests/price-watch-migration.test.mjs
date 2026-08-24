import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";

import { openPriceWatchFixture } from "./helpers/price-watch-fixture.mjs";

const migration = readFileSync(new URL("../drizzle/0016_next_nighthawk.sql", import.meta.url), "utf8");
const statements = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);

function applyMigration(database) {
  for (const statement of statements) database.exec(statement);
}

test("the price-watch migration installs constrained tables and immutable workspace-scoped audit rows", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    database.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY NOT NULL);
      CREATE TABLE workspaces (id text PRIMARY KEY NOT NULL);
      CREATE TABLE report_runs (id text PRIMARY KEY NOT NULL);
      CREATE TABLE report_matches (id text PRIMARY KEY NOT NULL);
    `);
    applyMigration(database);
    for (const table of [
      "price_watchers",
      "price_watch_credit_reservations",
      "price_watch_observations",
      "price_watch_events",
      "workspace_notifications",
      "workspace_notification_reads",
      "price_watch_email_outbox",
      "price_watch_audit_log",
      "price_watcher_report_links",
    ]) assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table), table);

    const watcherSql = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'price_watchers'`).get().sql;
    assert.match(watcherSql, /cadence.*hourly.*daily/is);
    assert.match(watcherSql, /failure_streak.*>= 0/is);
    database.prepare(`INSERT INTO "user" (id) VALUES ('user-1')`).run();
    database.prepare(`INSERT INTO workspaces (id) VALUES ('workspace-1')`).run();
    database.prepare(`INSERT INTO price_watch_audit_log (id, workspace_id, actor_user_id, action, target_tombstone, detail_json, created_at) VALUES ('audit-1', 'workspace-1', 'user-1', 'watcher.disable', 'random-tombstone', '{}', '2026-08-24T12:00:00.000Z')`).run();
    assert.throws(() => database.prepare(`UPDATE price_watch_audit_log SET action = 'tampered'`).run(), /immutable/);
    assert.throws(() => database.prepare(`DELETE FROM price_watch_audit_log`).run(), /immutable/);
    database.prepare(`DELETE FROM workspaces WHERE id = 'workspace-1'`).run();
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_audit_log`).get().count, 0);
  } finally { database.close(); }
});

test("the generated migration is safe after runtime bootstrap has already created the same tables", () => {
  const database = openPriceWatchFixture();
  try {
    assert.doesNotThrow(() => applyMigration(database));
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('price_watchers') WHERE name = 'resolved_url'`).get().count, 1);
  } finally { database.close(); }
});
