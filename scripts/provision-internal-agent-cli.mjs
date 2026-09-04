import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_USER_ID = "market-signal-internal-agent-v1";
const SERVICE_USER_EMAIL = "internal-agent@market-signal.invalid";
const SERVICE_WORKSPACE_ID = "market-signal-company-internal-v1";
const SERVICE_WORKSPACE_SLUG = "market-signal-company-internal";
const KEY_NAME = "Company orchestrator";
const KEY_PREFIX = "msk_live";
const VALID_TARGETS = new Set([20, 50, 500, 1_000]);
const REQUIRED_TABLES = [
  "user",
  "workspaces",
  "workspace_members",
  "report_api_keys",
  "report_api_key_events",
  "internal_report_entitlements",
];

function exactPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function assertSchema(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
  if (missing.length) throw new Error(`Apply the current Market Signal database schema before provisioning (${missing.join(", ")}).`);
}

function writeSecretFile(path, apiKey) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${apiKey}\n`, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
}

export function provisionInternalAgent({
  databasePath,
  secretFile,
  dailyComparisonLimit = 20,
  maxComparisonTarget = 20,
  expiresInDays = 90,
  rotate = false,
  now = new Date(),
}) {
  const resolvedDatabasePath = resolve(String(databasePath || ""));
  const resolvedSecretFile = resolve(String(secretFile || ""));
  if (!databasePath || !secretFile || resolvedDatabasePath === resolvedSecretFile) {
    throw new Error("Provide distinct database and one-time credential file paths.");
  }
  const dailyLimit = exactPositiveInteger(dailyComparisonLimit, "Daily comparison limit");
  const maxTarget = exactPositiveInteger(maxComparisonTarget, "Maximum comparison target");
  const expiryDays = exactPositiveInteger(expiresInDays, "Credential expiry");
  if (!VALID_TARGETS.has(maxTarget)) throw new Error("Maximum comparison target must be 20, 50, 500, or 1000.");
  if (dailyLimit < maxTarget || dailyLimit > 100_000) throw new Error("Daily comparison limit must cover the maximum target and be at most 100000.");
  if (![30, 90, 365].includes(expiryDays)) throw new Error("Credential expiry must be 30, 90, or 365 days.");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Provisioning time is invalid.");

  const keyId = randomBytes(12).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const apiKey = `${KEY_PREFIX}_${keyId}_${secret}`;
  const secretHash = createHash("sha256").update(secret, "utf8").digest("base64url");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1_000).toISOString();

  writeSecretFile(resolvedSecretFile, apiKey);
  const database = new Database(resolvedDatabasePath);
  try {
    database.pragma("busy_timeout = 10000");
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    assertSchema(database);
    database.transaction(() => {
      const existingUser = database.prepare('SELECT id, email FROM "user" WHERE id = ? OR email = ?').all(SERVICE_USER_ID, SERVICE_USER_EMAIL);
      if (existingUser.some((row) => row.id !== SERVICE_USER_ID || row.email !== SERVICE_USER_EMAIL)) {
        throw new Error("The reserved internal service identity collides with another account.");
      }
      database.prepare(`
        INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt)
        VALUES (?, 'Market Signal Internal Agent', ?, 1, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt
      `).run(SERVICE_USER_ID, SERVICE_USER_EMAIL, createdAt, createdAt);

      const existingWorkspace = database.prepare("SELECT id, slug, kind FROM workspaces WHERE id = ? OR slug = ?").all(SERVICE_WORKSPACE_ID, SERVICE_WORKSPACE_SLUG);
      if (existingWorkspace.some((row) => row.id !== SERVICE_WORKSPACE_ID || row.slug !== SERVICE_WORKSPACE_SLUG || row.kind !== "internal")) {
        throw new Error("The reserved internal workspace identity collides with another workspace.");
      }
      database.prepare(`
        INSERT INTO workspaces (id, name, slug, kind, personal_owner_user_id, created_at, updated_at)
        VALUES (?, 'Market Signal company agents', ?, 'internal', NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `).run(SERVICE_WORKSPACE_ID, SERVICE_WORKSPACE_SLUG, createdAt, createdAt);
      database.prepare(`
        INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
        VALUES (?, ?, 'owner', ?)
      `).run(SERVICE_WORKSPACE_ID, SERVICE_USER_ID, createdAt);

      const activeKeys = database.prepare(`
        SELECT id FROM report_api_keys
        WHERE workspace_id = ? AND name = ? AND revoked_at IS NULL AND expires_at > ?
      `).all(SERVICE_WORKSPACE_ID, KEY_NAME, createdAt);
      if (activeKeys.length && !rotate) {
        throw new Error("An active company-agent credential already exists; use --rotate to replace it.");
      }
      if (rotate) {
        for (const active of activeKeys) {
          database.prepare("UPDATE report_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(createdAt, active.id);
          database.prepare(`
            INSERT INTO report_api_key_events (id, key_id, user_id, workspace_id, event_type, created_at)
            VALUES (?, ?, ?, ?, 'revoked', ?)
          `).run(randomUUID(), active.id, SERVICE_USER_ID, SERVICE_WORKSPACE_ID, createdAt);
        }
      }

      database.prepare(`
        INSERT INTO internal_report_entitlements (
          workspace_id, enabled, max_comparison_target, daily_comparison_limit, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          enabled = 1,
          max_comparison_target = excluded.max_comparison_target,
          daily_comparison_limit = excluded.daily_comparison_limit,
          updated_at = excluded.updated_at
      `).run(SERVICE_WORKSPACE_ID, maxTarget, dailyLimit, createdAt, createdAt);
      database.prepare(`
        INSERT INTO report_api_keys (
          id, user_id, workspace_id, name, secret_hash, last_four, scopes,
          created_at, expires_at, last_used_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        keyId,
        SERVICE_USER_ID,
        SERVICE_WORKSPACE_ID,
        KEY_NAME,
        secretHash,
        secret.slice(-4),
        JSON.stringify(["reports:read", "reports:create"]),
        createdAt,
        expiresAt,
      );
      database.prepare(`
        INSERT INTO report_api_key_events (id, key_id, user_id, workspace_id, event_type, created_at)
        VALUES (?, ?, ?, ?, 'created', ?)
      `).run(randomUUID(), keyId, SERVICE_USER_ID, SERVICE_WORKSPACE_ID, createdAt);
    }).immediate();
  } catch (error) {
    try { unlinkSync(resolvedSecretFile); } catch { /* best-effort cleanup of one-time material */ }
    throw error;
  } finally {
    database.close();
  }

  return {
    ok: true,
    workspaceId: SERVICE_WORKSPACE_ID,
    keyId,
    expiresAt,
    maxComparisonTarget: maxTarget,
    dailyComparisonLimit: dailyLimit,
    credentialFileWritten: true,
  };
}

function parseArguments(values) {
  const parsed = { rotate: false };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--rotate") {
      parsed.rotate = true;
      continue;
    }
    const key = {
      "--database": "databasePath",
      "--secret-file": "secretFile",
      "--daily-comparisons": "dailyComparisonLimit",
      "--max-comparisons": "maxComparisonTarget",
      "--expires-days": "expiresInDays",
    }[name];
    if (!key || index + 1 >= values.length) throw new Error(`Unknown or incomplete provisioning argument: ${name}`);
    parsed[key] = values[index + 1];
    index += 1;
  }
  return parsed;
}

async function main() {
  try {
    const result = provisionInternalAgent(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Internal agent provisioning failed."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
