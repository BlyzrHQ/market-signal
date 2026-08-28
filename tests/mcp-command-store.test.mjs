import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";

import {
  claimMcpConfirmation,
  completeMcpConfirmation,
  consumeMcpRateLimit,
  ensureMcpCommandSchema,
  getMcpCommandReceipt,
  issueMcpConfirmation,
  McpCommandStoreError,
  recordMcpCommandReceipt,
} from "../app/lib/mcp-command-store.ts";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const PRINCIPAL = { workspaceId: "workspace-1", userId: "user-1", clientId: "https://client.example/mcp.json" };

function database() {
  const value = new Database(":memory:");
  ensureMcpCommandSchema(value);
  return value;
}

test("confirmation tokens are hashed, identity-bound, claimable once, and replay terminal outcomes", () => {
  const db = database();
  try {
    const issued = issueMcpConfirmation(db, PRINCIPAL, "report_create_confirm", { domain: "shop.example", locale: "en" }, { reports: 1 }, NOW);
    assert.match(issued.confirmationToken, /^[A-Za-z0-9_-]{43}$/);
    const stored = db.prepare(`SELECT token_hash, state FROM mcp_confirmation_intents WHERE command_id = ?`).get(issued.commandId);
    assert.equal(stored.state, "ready");
    assert.equal(stored.token_hash.length, 64);
    assert.notEqual(stored.token_hash, issued.confirmationToken);
    assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT * FROM mcp_confirmation_intents`).all()), new RegExp(issued.confirmationToken));

    assert.throws(() => claimMcpConfirmation(db, { ...PRINCIPAL, clientId: "https://other.example/mcp.json" }, "report_create_confirm", issued.confirmationToken, NOW), (error) => error instanceof McpCommandStoreError && error.code === "invalid-confirmation");
    const claimed = claimMcpConfirmation(db, PRINCIPAL, "report_create_confirm", issued.confirmationToken, NOW);
    assert.equal(claimed.kind, "claimed");
    assert.equal(claimed.input.domain, "shop.example");
    assert.equal(claimMcpConfirmation(db, PRINCIPAL, "report_create_confirm", issued.confirmationToken, new Date(NOW.getTime() + 1_000)).kind, "in_progress");

    const outcome = { ok: true, report: { publicReportId: "a".repeat(32) } };
    completeMcpConfirmation(db, PRINCIPAL, "report_create_confirm", issued.commandId, "succeeded", outcome, "", new Date(NOW.getTime() + 2_000));
    const losingCompletion = completeMcpConfirmation(db, PRINCIPAL, "report_create_confirm", issued.commandId, "failed", { ok: false }, "late-racer", new Date(NOW.getTime() + 2_500));
    assert.deepEqual(losingCompletion, outcome, "a losing completion race returns the durable terminal outcome");
    const replay = claimMcpConfirmation(db, PRINCIPAL, "report_create_confirm", issued.confirmationToken, new Date(NOW.getTime() + 3_000));
    assert.equal(replay.kind, "terminal");
    assert.equal(replay.state, "succeeded");
    assert.deepEqual(replay.outcome, outcome);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM mcp_command_audit_log`).get().count, 4);
  } finally {
    db.close();
  }
});

test("expired confirmations fail closed and stale in-progress leases are reclaimable", () => {
  const db = database();
  try {
    const expired = issueMcpConfirmation(db, PRINCIPAL, "price_watch_confirm", { watcher: "one" }, { credits: 1 }, NOW);
    const expiry = claimMcpConfirmation(db, PRINCIPAL, "price_watch_confirm", expired.confirmationToken, new Date(NOW.getTime() + 5 * 60 * 1_000 + 1));
    assert.equal(expiry.kind, "terminal");
    assert.equal(expiry.state, "failed");
    assert.equal(expiry.outcome.error.code, "confirmation-expired");

    const reclaimable = issueMcpConfirmation(db, PRINCIPAL, "price_watch_update_confirm", { watcherId: "watch-1" }, { credits: 0 }, NOW);
    assert.equal(claimMcpConfirmation(db, PRINCIPAL, "price_watch_update_confirm", reclaimable.confirmationToken, NOW).kind, "claimed");
    const reclaimed = claimMcpConfirmation(db, PRINCIPAL, "price_watch_update_confirm", reclaimable.confirmationToken, new Date(NOW.getTime() + 61_000));
    assert.equal(reclaimed.kind, "claimed");
    assert.equal(reclaimed.commandId, reclaimable.commandId);
    const reclaimedAfterTokenExpiry = claimMcpConfirmation(db, PRINCIPAL, "price_watch_update_confirm", reclaimable.confirmationToken, new Date(NOW.getTime() + 301_000));
    assert.equal(reclaimedAfterTokenExpiry.kind, "claimed");
    assert.equal(reclaimedAfterTokenExpiry.commandId, reclaimable.commandId);
  } finally {
    db.close();
  }
});

test("durable rate limits are workspace-client scoped", () => {
  const db = database();
  try {
    db.prepare(`INSERT INTO mcp_rate_limit_windows (workspace_id, client_id, bucket, window_start_epoch, request_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(PRINCIPAL.workspaceId, PRINCIPAL.clientId, "stale:bucket", 1, 1, new Date(NOW.getTime() - 25 * 60 * 60 * 1_000).toISOString());
    assert.equal(consumeMcpRateLimit(db, PRINCIPAL, "write:preview", 2, 60, NOW).remaining, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM mcp_rate_limit_windows WHERE bucket = 'stale:bucket'`).get().count, 0);
    assert.equal(consumeMcpRateLimit(db, PRINCIPAL, "write:preview", 2, 60, NOW).remaining, 0);
    assert.throws(() => consumeMcpRateLimit(db, PRINCIPAL, "write:preview", 2, 60, NOW), (error) => error instanceof McpCommandStoreError && error.code === "rate-limit-exceeded");
    assert.equal(consumeMcpRateLimit(db, { ...PRINCIPAL, clientId: "client-2" }, "write:preview", 2, 60, NOW).remaining, 1);
    consumeMcpRateLimit(db, { ...PRINCIPAL, clientId: "client-2" }, "write:preview", 2, 60, NOW);
    consumeMcpRateLimit(db, { ...PRINCIPAL, clientId: "client-3" }, "write:preview", 2, 60, NOW);
    consumeMcpRateLimit(db, { ...PRINCIPAL, clientId: "client-3" }, "write:preview", 2, 60, NOW);
    assert.throws(() => consumeMcpRateLimit(db, { ...PRINCIPAL, clientId: "client-4" }, "write:preview", 2, 60, NOW), (error) => error instanceof McpCommandStoreError && error.code === "rate-limit-exceeded", "rotating client IDs cannot evade the workspace backstop");
    assert.equal(consumeMcpRateLimit(db, PRINCIPAL, "write:preview", 2, 60, new Date(NOW.getTime() + 60_000)).remaining, 1);
  } finally {
    db.close();
  }
});

test("command receipts replay atomically and MCP audit rows are immutable", () => {
  const db = database();
  try {
    recordMcpCommandReceipt(db, PRINCIPAL.workspaceId, "price_watch.activate", "old-command", { ok: true }, new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000));
    recordMcpCommandReceipt(db, PRINCIPAL.workspaceId, "price_watch.activate", "command-1", { ok: true, created: 2 }, NOW);
    assert.deepEqual(getMcpCommandReceipt(db, PRINCIPAL.workspaceId, "price_watch.activate", "command-1"), { created: 2, ok: true });
    recordMcpCommandReceipt(db, PRINCIPAL.workspaceId, "price_watch.activate", "command-1", { created: 2, ok: true }, NOW);
    assert.throws(() => recordMcpCommandReceipt(db, PRINCIPAL.workspaceId, "price_watch.activate", "command-1", { ok: true, created: 3 }, NOW), /conflicts/);

    const issued = issueMcpConfirmation(db, PRINCIPAL, "report_create_confirm", { domain: "shop.example" }, { reports: 1 }, NOW);
    assert.equal(getMcpCommandReceipt(db, PRINCIPAL.workspaceId, "price_watch.activate", "old-command"), null);
    const audit = db.prepare(`SELECT id FROM mcp_command_audit_log WHERE command_id = ?`).get(issued.commandId);
    assert.throws(() => db.prepare(`UPDATE mcp_command_audit_log SET event_type = 'tampered' WHERE id = ?`).run(audit.id), /immutable/);
    assert.throws(() => db.prepare(`DELETE FROM mcp_command_audit_log WHERE id = ?`).run(audit.id), /immutable/);
  } finally {
    db.close();
  }
});
