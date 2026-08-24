import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { canonicalNodeSqlitePath } from "./node-sqlite-database.ts";

const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
export const REPORT_SHARE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type ReportShareState = {
  shared: boolean;
  token: string;
  rotation: number;
  sharedAt: string;
  revokedAt: string;
};

export type ActiveReportShare = {
  runId: string;
  privatePublicId: string;
};

export class ReportShareStoreError extends Error {
  readonly code: "not-found" | "report-not-shareable" | "storage-unavailable";
  readonly httpStatus: 404 | 409 | 503;

  constructor(code: ReportShareStoreError["code"], message: string, httpStatus: ReportShareStoreError["httpStatus"]) {
    super(message);
    this.name = "ReportShareStoreError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function openReportSharingDatabase(databasePath = String(process.env.MARKET_SIGNAL_SQLITE_PATH || "").trim()) {
  if (!databasePath) throw new ReportShareStoreError("storage-unavailable", "Report sharing storage is not configured.", 503);
  const canonicalPath = await canonicalNodeSqlitePath(databasePath);
  const database = new Database(canonicalPath);
  database.pragma("busy_timeout = 10000");
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  ensureReportSharingSchema(database);
  return database;
}

export function ensureReportSharingSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS report_share_links (
      run_id text PRIMARY KEY NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE CHECK(length(token) = 64 AND token NOT GLOB '*[^0-9a-f]*'),
      active integer NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      rotation integer NOT NULL DEFAULT 1 CHECK(rotation >= 1),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      revoked_at text NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS report_share_links_active_idx ON report_share_links(active, updated_at);

    CREATE TABLE IF NOT EXISTS report_share_audits (
      id text PRIMARY KEY NOT NULL,
      run_id text NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
      workspace_id text NOT NULL,
      actor_user_id text NOT NULL,
      action text NOT NULL CHECK(action IN ('share', 'unshare')),
      rotation integer NOT NULL CHECK(rotation >= 1),
      created_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS report_share_audits_run_idx ON report_share_audits(run_id, created_at);
    CREATE INDEX IF NOT EXISTS report_share_audits_workspace_idx ON report_share_audits(workspace_id, created_at);
    CREATE TRIGGER IF NOT EXISTS report_share_audits_no_update
      BEFORE UPDATE ON report_share_audits
      BEGIN SELECT RAISE(ABORT, 'report share audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS report_share_audits_no_direct_delete
      BEFORE DELETE ON report_share_audits
      WHEN EXISTS (SELECT 1 FROM report_runs WHERE id = OLD.run_id)
      BEGIN SELECT RAISE(ABORT, 'report share audit rows are immutable'); END;
  `);
}

function validDate(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new ReportShareStoreError("report-not-shareable", "A valid share time is required.", 409);
  return now.toISOString();
}

function assertIdentifiers(publicReportId: string, workspaceId: string) {
  if (!PUBLIC_ID_PATTERN.test(publicReportId) || !workspaceId) {
    throw new ReportShareStoreError("not-found", "Report not found.", 404);
  }
}

function ownedRun(database: Database.Database, publicReportId: string, workspaceId: string) {
  return database.prepare(`
    SELECT runs.id, runs.status, runs.expires_at,
      CASE WHEN documents.run_id IS NULL THEN 0 ELSE 1 END AS has_document
    FROM report_runs AS runs
    LEFT JOIN report_documents AS documents ON documents.run_id = runs.id
    WHERE runs.public_id = ? AND runs.workspace_id = ?
    LIMIT 1
  `).get(publicReportId, workspaceId) as Record<string, unknown> | undefined;
}

function shareStateRow(database: Database.Database, runId: string) {
  return database.prepare(`SELECT token, active, rotation, created_at, updated_at, revoked_at FROM report_share_links WHERE run_id = ? LIMIT 1`).get(runId) as Record<string, unknown> | undefined;
}

function shareState(row: Record<string, unknown> | undefined): ReportShareState {
  const shared = Number(row?.active || 0) === 1 && REPORT_SHARE_TOKEN_PATTERN.test(String(row?.token || ""));
  return {
    shared,
    token: shared ? String(row?.token || "") : "",
    rotation: Math.max(0, Number(row?.rotation || 0)),
    sharedAt: shared ? String(row?.updated_at || row?.created_at || "") : "",
    revokedAt: String(row?.revoked_at || ""),
  };
}

function requireShareableRun(database: Database.Database, publicReportId: string, workspaceId: string, now: Date) {
  assertIdentifiers(publicReportId, workspaceId);
  const row = ownedRun(database, publicReportId, workspaceId);
  if (!row) throw new ReportShareStoreError("not-found", "Report not found.", 404);
  const expiry = Date.parse(String(row.expires_at || ""));
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) throw new ReportShareStoreError("not-found", "Report not found.", 404);
  if (!["complete", "limited"].includes(String(row.status || "")) || Number(row.has_document || 0) !== 1) {
    throw new ReportShareStoreError("report-not-shareable", "Only a completed saved report can be shared.", 409);
  }
  return String(row.id || "");
}

export function getReportShareState(database: Database.Database, publicReportId: string, workspaceId: string, now = new Date()): ReportShareState {
  ensureReportSharingSchema(database);
  const runId = requireShareableRun(database, publicReportId, workspaceId, now);
  return shareState(shareStateRow(database, runId));
}

export function shareReport(
  database: Database.Database,
  publicReportId: string,
  workspaceId: string,
  actorUserId: string,
  now = new Date(),
  createToken: () => string = () => randomBytes(32).toString("hex"),
): ReportShareState {
  ensureReportSharingSchema(database);
  assertIdentifiers(publicReportId, workspaceId);
  if (!actorUserId) throw new ReportShareStoreError("not-found", "Report not found.", 404);
  const observedAt = validDate(now);
  const transaction = database.transaction(() => {
    const runId = requireShareableRun(database, publicReportId, workspaceId, now);
    const existing = shareStateRow(database, runId);
    const current = shareState(existing);
    if (current.shared) return current;
    const token = createToken();
    if (!REPORT_SHARE_TOKEN_PATTERN.test(token)) throw new ReportShareStoreError("storage-unavailable", "A secure share token could not be created.", 503);
    const rotation = Math.max(0, Number(existing?.rotation || 0)) + 1;
    database.prepare(`
      INSERT INTO report_share_links (run_id, token, active, rotation, created_by_user_id, created_at, updated_at, revoked_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, '')
      ON CONFLICT(run_id) DO UPDATE SET
        token = excluded.token,
        active = 1,
        rotation = excluded.rotation,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = excluded.updated_at,
        revoked_at = ''
    `).run(runId, token, rotation, actorUserId, observedAt, observedAt);
    database.prepare(`INSERT INTO report_share_audits (id, run_id, workspace_id, actor_user_id, action, rotation, created_at) VALUES (?, ?, ?, ?, 'share', ?, ?)`)
      .run(randomUUID(), runId, workspaceId, actorUserId, rotation, observedAt);
    return shareState(shareStateRow(database, runId));
  });
  try {
    return transaction.immediate();
  } catch (error) {
    if (error instanceof ReportShareStoreError) throw error;
    throw new ReportShareStoreError("storage-unavailable", "Report sharing is temporarily unavailable.", 503);
  }
}

export function unshareReport(database: Database.Database, publicReportId: string, workspaceId: string, actorUserId: string, now = new Date()): ReportShareState {
  ensureReportSharingSchema(database);
  assertIdentifiers(publicReportId, workspaceId);
  if (!actorUserId) throw new ReportShareStoreError("not-found", "Report not found.", 404);
  const observedAt = validDate(now);
  const transaction = database.transaction(() => {
    const row = ownedRun(database, publicReportId, workspaceId);
    if (!row) throw new ReportShareStoreError("not-found", "Report not found.", 404);
    const runId = String(row.id || "");
    const existing = shareStateRow(database, runId);
    const current = shareState(existing);
    if (!current.shared) return current;
    database.prepare(`UPDATE report_share_links SET active = 0, updated_at = ?, revoked_at = ? WHERE run_id = ? AND active = 1`)
      .run(observedAt, observedAt, runId);
    database.prepare(`INSERT INTO report_share_audits (id, run_id, workspace_id, actor_user_id, action, rotation, created_at) VALUES (?, ?, ?, ?, 'unshare', ?, ?)`)
      .run(randomUUID(), runId, workspaceId, actorUserId, current.rotation, observedAt);
    return shareState(shareStateRow(database, runId));
  });
  try {
    return transaction.immediate();
  } catch (error) {
    if (error instanceof ReportShareStoreError) throw error;
    throw new ReportShareStoreError("storage-unavailable", "Report sharing is temporarily unavailable.", 503);
  }
}

export function resolveActiveReportShare(database: Database.Database, token: string, now = new Date()): ActiveReportShare | null {
  if (!REPORT_SHARE_TOKEN_PATTERN.test(token) || !Number.isFinite(now.getTime())) return null;
  ensureReportSharingSchema(database);
  const row = database.prepare(`
    SELECT links.run_id, runs.public_id
    FROM report_share_links AS links
    JOIN report_runs AS runs ON runs.id = links.run_id
    JOIN report_documents AS documents ON documents.run_id = runs.id
    WHERE links.token = ? AND links.active = 1
      AND runs.status IN ('complete', 'limited')
      AND runs.expires_at > ?
    LIMIT 1
  `).get(token, now.toISOString()) as Record<string, unknown> | undefined;
  return row ? { runId: String(row.run_id || ""), privatePublicId: String(row.public_id || "") } : null;
}
