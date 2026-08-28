import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const COMMAND_LEASE_MS = 60 * 1_000;
const MAX_ACTIVE_CONFIRMATIONS = 40;
const MAX_JSON_BYTES = 64 * 1_024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type McpCommandPrincipal = {
  workspaceId: string;
  userId: string;
  clientId: string;
};

export type McpConfirmationState = "ready" | "in_progress" | "succeeded" | "failed";

export type McpIssuedConfirmation = {
  confirmationToken: string;
  expiresAt: string;
  commandId: string;
  inputHash: string;
  impactHash: string;
};

export type McpClaimedConfirmation = {
  kind: "claimed";
  commandId: string;
  input: Record<string, unknown>;
  impact: Record<string, unknown>;
  inputHash: string;
  impactHash: string;
};

export type McpConfirmationClaim = McpClaimedConfirmation | {
  kind: "in_progress";
  commandId: string;
} | {
  kind: "terminal";
  commandId: string;
  state: "succeeded" | "failed";
  outcome: Record<string, unknown>;
};

export class McpCommandStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpCommandStoreError";
    this.code = code;
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortedValue(item)]));
}

export function canonicalMcpJson(value: Record<string, unknown>) {
  const serialized = JSON.stringify(sortedValue(value));
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    throw new McpCommandStoreError("input-too-large", "The MCP command input is too large.");
  }
  return serialized;
}

function parsedRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function validIdentity(principal: McpCommandPrincipal) {
  return Boolean(principal.workspaceId && principal.userId && principal.clientId
    && principal.workspaceId.length <= 200 && principal.userId.length <= 200 && principal.clientId.length <= 2_048);
}

function validToolName(toolName: string) {
  return /^[a-z][a-z0-9_]{1,79}$/.test(toolName);
}

export function ensureMcpCommandSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mcp_confirmation_intents (
      id text PRIMARY KEY NOT NULL,
      token_hash text NOT NULL UNIQUE CHECK(length(token_hash) = 64),
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      client_id text NOT NULL,
      tool_name text NOT NULL,
      canonical_input_json text NOT NULL,
      input_hash text NOT NULL CHECK(length(input_hash) = 64),
      impact_json text NOT NULL,
      impact_hash text NOT NULL CHECK(length(impact_hash) = 64),
      command_id text NOT NULL UNIQUE,
      state text NOT NULL CHECK(state IN ('ready','in_progress','succeeded','failed')),
      outcome_json text NOT NULL DEFAULT '{}',
      error_code text NOT NULL DEFAULT '',
      created_at text NOT NULL,
      expires_at text NOT NULL,
      claimed_at text NOT NULL DEFAULT '',
      lease_expires_at text NOT NULL DEFAULT '',
      completed_at text NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS mcp_confirmation_identity_idx
      ON mcp_confirmation_intents(workspace_id, client_id, tool_name, expires_at);
    CREATE INDEX IF NOT EXISTS mcp_confirmation_state_idx
      ON mcp_confirmation_intents(state, lease_expires_at);

    CREATE TABLE IF NOT EXISTS mcp_command_receipts (
      command_id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      operation text NOT NULL,
      outcome_json text NOT NULL,
      created_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_command_receipts_workspace_idx
      ON mcp_command_receipts(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS mcp_rate_limit_windows (
      workspace_id text NOT NULL,
      client_id text NOT NULL,
      bucket text NOT NULL,
      window_start_epoch integer NOT NULL,
      request_count integer NOT NULL CHECK(request_count >= 0),
      updated_at text NOT NULL,
      PRIMARY KEY(workspace_id, client_id, bucket, window_start_epoch)
    );
    CREATE INDEX IF NOT EXISTS mcp_rate_limit_recent_idx
      ON mcp_rate_limit_windows(updated_at);

    CREATE TABLE IF NOT EXISTS mcp_command_audit_log (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      client_id text NOT NULL,
      tool_name text NOT NULL,
      command_id text NOT NULL DEFAULT '',
      event_type text NOT NULL,
      input_hash text NOT NULL DEFAULT '',
      impact_hash text NOT NULL DEFAULT '',
      error_code text NOT NULL DEFAULT '',
      detail_json text NOT NULL DEFAULT '{}',
      created_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_command_audit_workspace_idx
      ON mcp_command_audit_log(workspace_id, created_at);
    CREATE TRIGGER IF NOT EXISTS mcp_command_audit_no_update
      BEFORE UPDATE ON mcp_command_audit_log
      BEGIN SELECT RAISE(ABORT, 'MCP command audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mcp_command_audit_no_delete
      BEFORE DELETE ON mcp_command_audit_log
      BEGIN SELECT RAISE(ABORT, 'MCP command audit rows are immutable'); END;
  `);
}

export function recordMcpCommandAudit(
  database: Database.Database,
  principal: McpCommandPrincipal,
  input: {
    toolName: string;
    eventType: string;
    commandId?: string;
    inputHash?: string;
    impactHash?: string;
    errorCode?: string;
    detail?: Record<string, unknown>;
  },
  now = new Date(),
) {
  ensureMcpCommandSchema(database);
  const detailJson = canonicalMcpJson(input.detail || {});
  database.prepare(`INSERT INTO mcp_command_audit_log (
    id, workspace_id, user_id, client_id, tool_name, command_id, event_type,
    input_hash, impact_hash, error_code, detail_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(), principal.workspaceId, principal.userId, principal.clientId,
      input.toolName, input.commandId || "", input.eventType, input.inputHash || "",
      input.impactHash || "", input.errorCode || "", detailJson, now.toISOString(),
    );
}

export function consumeMcpRateLimit(
  database: Database.Database,
  principal: McpCommandPrincipal,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now = new Date(),
) {
  if (!validIdentity(principal) || !/^[a-z][a-z0-9:_-]{1,79}$/.test(bucket)
    || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new McpCommandStoreError("invalid-rate-limit", "The MCP rate-limit configuration is invalid.");
  }
  ensureMcpCommandSchema(database);
  return database.transaction(() => {
    const staleWindowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    database.prepare(`DELETE FROM mcp_rate_limit_windows WHERE updated_at < ?`).run(staleWindowCutoff);
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const limits = [{ clientId: principal.clientId, limit }, { clientId: "*", limit: limit * 3 }];
    const counts = limits.map((item) => {
      const existing = database.prepare(`SELECT request_count FROM mcp_rate_limit_windows WHERE workspace_id = ? AND client_id = ? AND bucket = ? AND window_start_epoch = ?`)
        .get(principal.workspaceId, item.clientId, bucket, windowStart) as { request_count?: number } | undefined;
      return { ...item, count: Number(existing?.request_count || 0) };
    });
    if (counts.some((item) => item.count >= item.limit)) {
      throw new McpCommandStoreError("rate-limit-exceeded", "Too many MCP requests. Try again shortly.");
    }
    for (const item of counts) {
      database.prepare(`INSERT INTO mcp_rate_limit_windows (workspace_id, client_id, bucket, window_start_epoch, request_count, updated_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(workspace_id, client_id, bucket, window_start_epoch)
        DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at`)
        .run(principal.workspaceId, item.clientId, bucket, windowStart, now.toISOString());
    }
    const clientCount = counts[0].count;
    return { remaining: Math.max(0, limit - clientCount - 1), resetsAt: new Date((windowStart + windowSeconds) * 1_000).toISOString() };
  }).immediate();
}

export function issueMcpConfirmation(
  database: Database.Database,
  principal: McpCommandPrincipal,
  toolName: string,
  input: Record<string, unknown>,
  impact: Record<string, unknown>,
  now = new Date(),
): McpIssuedConfirmation {
  if (!validIdentity(principal) || !validToolName(toolName) || !Number.isFinite(now.getTime())) {
    throw new McpCommandStoreError("invalid-confirmation", "The confirmation request is invalid.");
  }
  ensureMcpCommandSchema(database);
  const canonicalInput = canonicalMcpJson(input);
  const canonicalImpact = canonicalMcpJson(impact);
  const inputHash = sha256(canonicalInput);
  const impactHash = sha256(canonicalImpact);
  const confirmationToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(confirmationToken);
  const commandId = randomUUID();
  const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString();
  database.transaction(() => {
    const retentionCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    database.prepare(`DELETE FROM mcp_confirmation_intents WHERE (completed_at != '' AND completed_at < ?) OR (completed_at = '' AND expires_at < ?)`)
      .run(retentionCutoff, retentionCutoff);
    database.prepare(`DELETE FROM mcp_command_receipts WHERE created_at < ?`).run(retentionCutoff);
    const active = database.prepare(`SELECT COUNT(*) AS count FROM mcp_confirmation_intents WHERE workspace_id = ? AND client_id = ? AND state IN ('ready','in_progress') AND expires_at > ?`)
      .get(principal.workspaceId, principal.clientId, now.toISOString()) as { count?: number } | undefined;
    if (Number(active?.count || 0) >= MAX_ACTIVE_CONFIRMATIONS) {
      throw new McpCommandStoreError("too-many-confirmations", "Too many confirmations are awaiting completion.");
    }
    database.prepare(`INSERT INTO mcp_confirmation_intents (
      id, token_hash, workspace_id, user_id, client_id, tool_name, canonical_input_json,
      input_hash, impact_json, impact_hash, command_id, state, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`)
      .run(
        randomUUID(), tokenHash, principal.workspaceId, principal.userId, principal.clientId,
        toolName, canonicalInput, inputHash, canonicalImpact, impactHash, commandId,
        now.toISOString(), expiresAt,
      );
    recordMcpCommandAudit(database, principal, {
      toolName, eventType: "confirmation.issued", commandId, inputHash, impactHash,
    }, now);
  }).immediate();
  return { confirmationToken, expiresAt, commandId, inputHash, impactHash };
}

export function claimMcpConfirmation(
  database: Database.Database,
  principal: McpCommandPrincipal,
  toolName: string,
  confirmationToken: string,
  now = new Date(),
): McpConfirmationClaim {
  if (!validIdentity(principal) || !validToolName(toolName) || !TOKEN_PATTERN.test(confirmationToken) || !Number.isFinite(now.getTime())) {
    throw new McpCommandStoreError("invalid-confirmation", "The confirmation token is invalid.");
  }
  ensureMcpCommandSchema(database);
  const tokenHash = sha256(confirmationToken);
  return database.transaction((): McpConfirmationClaim => {
    const row = database.prepare(`SELECT * FROM mcp_confirmation_intents WHERE token_hash = ? LIMIT 1`).get(tokenHash) as Record<string, unknown> | undefined;
    if (!row || row.workspace_id !== principal.workspaceId || row.user_id !== principal.userId
      || row.client_id !== principal.clientId || row.tool_name !== toolName) {
      throw new McpCommandStoreError("invalid-confirmation", "The confirmation token is invalid.");
    }
    const commandId = String(row.command_id || "");
    const state = String(row.state || "") as McpConfirmationState;
    if (state === "succeeded" || state === "failed") {
      recordMcpCommandAudit(database, principal, {
        toolName, eventType: "confirmation.replayed", commandId,
        inputHash: String(row.input_hash || ""), impactHash: String(row.impact_hash || ""),
        errorCode: String(row.error_code || ""), detail: { state },
      }, now);
      return { kind: "terminal", commandId, state, outcome: parsedRecord(row.outcome_json) };
    }
    if (state === "ready" && String(row.expires_at || "") <= now.toISOString()) {
      const outcome = { ok: false, error: { code: "confirmation-expired", message: "The confirmation expired. Preview the action again." } };
      database.prepare(`UPDATE mcp_confirmation_intents SET state = 'failed', outcome_json = ?, error_code = 'confirmation-expired', completed_at = ?, lease_expires_at = '' WHERE id = ? AND state = 'ready'`)
        .run(canonicalMcpJson(outcome), now.toISOString(), row.id);
      recordMcpCommandAudit(database, principal, {
        toolName, eventType: "confirmation.expired", commandId,
        inputHash: String(row.input_hash || ""), impactHash: String(row.impact_hash || ""), errorCode: "confirmation-expired",
      }, now);
      return { kind: "terminal", commandId, state: "failed", outcome };
    }
    const leaseExpiresAt = String(row.lease_expires_at || "");
    if (state === "in_progress" && leaseExpiresAt > now.toISOString()) return { kind: "in_progress", commandId };
    const nextLease = new Date(now.getTime() + COMMAND_LEASE_MS).toISOString();
    const updated = database.prepare(`UPDATE mcp_confirmation_intents SET state = 'in_progress', claimed_at = ?, lease_expires_at = ? WHERE id = ? AND ((state = 'ready' AND expires_at > ?) OR (state = 'in_progress' AND lease_expires_at <= ?))`)
      .run(now.toISOString(), nextLease, row.id, now.toISOString(), now.toISOString());
    if (updated.changes !== 1) return { kind: "in_progress", commandId };
    recordMcpCommandAudit(database, principal, {
      toolName, eventType: state === "ready" ? "confirmation.claimed" : "confirmation.reclaimed", commandId,
      inputHash: String(row.input_hash || ""), impactHash: String(row.impact_hash || ""),
    }, now);
    return {
      kind: "claimed", commandId,
      input: parsedRecord(row.canonical_input_json), impact: parsedRecord(row.impact_json),
      inputHash: String(row.input_hash || ""), impactHash: String(row.impact_hash || ""),
    };
  }).immediate();
}

export function completeMcpConfirmation(
  database: Database.Database,
  principal: McpCommandPrincipal,
  toolName: string,
  commandId: string,
  state: "succeeded" | "failed",
  outcome: Record<string, unknown>,
  errorCode = "",
  now = new Date(),
) {
  if (!validIdentity(principal) || !validToolName(toolName) || !commandId) {
    throw new McpCommandStoreError("invalid-command", "The MCP command is invalid.");
  }
  ensureMcpCommandSchema(database);
  const outcomeJson = canonicalMcpJson(outcome);
  return database.transaction(() => {
    const row = database.prepare(`SELECT * FROM mcp_confirmation_intents WHERE command_id = ? LIMIT 1`).get(commandId) as Record<string, unknown> | undefined;
    if (!row || row.workspace_id !== principal.workspaceId || row.user_id !== principal.userId
      || row.client_id !== principal.clientId || row.tool_name !== toolName) {
      throw new McpCommandStoreError("invalid-command", "The MCP command is invalid.");
    }
    if (row.state === "succeeded" || row.state === "failed") return parsedRecord(row.outcome_json);
    const updated = database.prepare(`UPDATE mcp_confirmation_intents SET state = ?, outcome_json = ?, error_code = ?, completed_at = ?, lease_expires_at = '' WHERE command_id = ? AND state = 'in_progress'`)
      .run(state, outcomeJson, errorCode, now.toISOString(), commandId);
    if (updated.changes !== 1) throw new McpCommandStoreError("command-not-claimed", "The MCP command is not claimable.");
    recordMcpCommandAudit(database, principal, {
      toolName, eventType: state === "succeeded" ? "command.succeeded" : "command.failed", commandId,
      inputHash: String(row.input_hash || ""), impactHash: String(row.impact_hash || ""), errorCode,
    }, now);
    return outcome;
  }).immediate();
}

export function getMcpCommandReceipt(
  database: Database.Database,
  workspaceId: string,
  operation: string,
  commandId: string,
) {
  if (!commandId) return null;
  ensureMcpCommandSchema(database);
  const row = database.prepare(`SELECT outcome_json FROM mcp_command_receipts WHERE command_id = ? AND workspace_id = ? AND operation = ? LIMIT 1`)
    .get(commandId, workspaceId, operation) as { outcome_json?: string } | undefined;
  return row ? parsedRecord(row.outcome_json) : null;
}

export function recordMcpCommandReceipt(
  database: Database.Database,
  workspaceId: string,
  operation: string,
  commandId: string,
  outcome: Record<string, unknown>,
  now = new Date(),
) {
  if (!commandId) return;
  ensureMcpCommandSchema(database);
  const outcomeJson = canonicalMcpJson(outcome);
  const inserted = database.prepare(`INSERT OR IGNORE INTO mcp_command_receipts (command_id, workspace_id, operation, outcome_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(commandId, workspaceId, operation, outcomeJson, now.toISOString());
  if (inserted.changes === 0) {
    const existing = getMcpCommandReceipt(database, workspaceId, operation, commandId);
    if (!existing || canonicalMcpJson(existing) !== outcomeJson) {
      throw new McpCommandStoreError("command-receipt-conflict", "The MCP command receipt conflicts with an existing command.");
    }
  }
}
