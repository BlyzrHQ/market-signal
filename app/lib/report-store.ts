import { canonicalDomain } from "./domain.ts";
import type { ApplicationDatabase, DatabasePreparedStatement } from "./database-contract.ts";
import { runtimeDatabaseResult } from "./runtime-database.ts";

export type ReportRunStatus = "queued" | "running" | "complete" | "limited" | "failed" | "interrupted";
export type ReportPhase = "queued" | "crawl" | "competitors" | "brief" | "products" | "matching" | "enrichment" | "actions" | "ads" | "persistence" | "complete" | "failed" | "interrupted";

export type D1PreparedStatementLike = DatabasePreparedStatement;
export type D1DatabaseLike = ApplicationDatabase;

export type StoredReportRun = {
  id: string;
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  status: ReportRunStatus;
  currentPhase: ReportPhase;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  errorCode: string;
  errorMessage: string;
};

export type StoredReportEvent = {
  sequence: number;
  idempotencyKey: string;
  phase: ReportPhase;
  status: ReportRunStatus;
  message: string;
  metadata: Record<string, unknown>;
  observedAt: string;
};

export type ReportCreateDiagnostic =
  | "invalid-domain"
  | "storage-unavailable"
  | "database-import-failed"
  | "database-binding-missing"
  | `schema-statement-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18}-failed`
  | `run-create-batch-${"schema-mismatch" | "constraint" | "binding-count" | "transaction" | "batch-api"}`
  | "run-create-unclassified";

const REPORT_SCHEMA_VERSION = 1;
const REPORT_RETENTION_DAYS = 90;
const STALE_RUN_MS = 10 * 60 * 1000;
const QUEUED_DISPATCH_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_REPORT_DOCUMENT_BYTES = 750_000;
const MAX_SNAPSHOT_CATALOG_PRODUCTS = 40;
const MAX_SNAPSHOT_UNMATCHED_PRODUCTS = 20;
const INVALID_DOMAIN_MESSAGE = "A valid public domain is required.";
const STORAGE_UNAVAILABLE_MESSAGE = "Persistent report storage is unavailable.";
const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
const PHASES = new Set<ReportPhase>(["queued", "crawl", "competitors", "brief", "products", "matching", "enrichment", "actions", "ads", "persistence", "complete", "failed", "interrupted"]);
const STATUSES = new Set<ReportRunStatus>(["queued", "running", "complete", "limited", "failed", "interrupted"]);
const schemaInitialization = new WeakMap<object, Promise<void>>();
const emittedStorageDiagnostics = new Set<string>();
const REPORT_STORAGE_DIAGNOSTIC = /^(?:database-(?:import-failed|binding-missing)|schema-statement-(?:[1-9]|1[0-8])-failed|run-create-batch-(?:schema-mismatch|constraint|binding-count|transaction|batch-api))$/;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS report_runs (id text PRIMARY KEY NOT NULL, public_id text NOT NULL, primary_domain text NOT NULL, locale text DEFAULT 'en' NOT NULL, status text NOT NULL, current_phase text NOT NULL, attempt_count integer DEFAULT 1 NOT NULL, created_at text NOT NULL, updated_at text NOT NULL, heartbeat_at text NOT NULL, expires_at text NOT NULL, error_code text DEFAULT '' NOT NULL, error_message text DEFAULT '' NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_runs_public_id_uidx ON report_runs (public_id)`,
  `CREATE INDEX IF NOT EXISTS report_runs_domain_recent_idx ON report_runs (primary_domain, created_at)`,
  `CREATE INDEX IF NOT EXISTS report_runs_expiry_idx ON report_runs (expires_at)`,
  `CREATE TABLE IF NOT EXISTS report_events (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, run_id text NOT NULL, sequence integer NOT NULL, idempotency_key text NOT NULL, phase text NOT NULL, status text NOT NULL, message text NOT NULL, metadata_json text DEFAULT '{}' NOT NULL, observed_at text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_events_run_sequence_uidx ON report_events (run_id, sequence)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_events_run_idempotency_uidx ON report_events (run_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS report_events_run_order_idx ON report_events (run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS report_documents (run_id text PRIMARY KEY NOT NULL, schema_version integer NOT NULL, document_json text NOT NULL, observed_at text NOT NULL, updated_at text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_companies (run_id text NOT NULL, domain text NOT NULL, role text NOT NULL, company_name text DEFAULT '' NOT NULL, evidence_url text DEFAULT '' NOT NULL, evidence_json text DEFAULT '{}' NOT NULL, observed_at text NOT NULL, PRIMARY KEY (run_id, domain))`,
  `CREATE INDEX IF NOT EXISTS report_companies_run_role_idx ON report_companies (run_id, role)`,
  `CREATE TABLE IF NOT EXISTS report_products (run_id text NOT NULL, domain text NOT NULL, product_id text NOT NULL, name text NOT NULL, normalized_name text DEFAULT '' NOT NULL, source_url text NOT NULL, image_url text DEFAULT '' NOT NULL, price_json text DEFAULT '[]' NOT NULL, metadata_json text DEFAULT '{}' NOT NULL, observed_at text NOT NULL, PRIMARY KEY (run_id, domain, product_id))`,
  `CREATE INDEX IF NOT EXISTS report_products_run_domain_idx ON report_products (run_id, domain)`,
  `CREATE TABLE IF NOT EXISTS report_matches (id text PRIMARY KEY NOT NULL, run_id text NOT NULL, primary_product_id text NOT NULL, rival_product_id text NOT NULL, rival_domain text NOT NULL, verdict text NOT NULL, confidence text NOT NULL, claim_type text NOT NULL, model text DEFAULT '' NOT NULL, prompt_version text DEFAULT '' NOT NULL, evidence_json text NOT NULL, observed_at text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS report_matches_run_rival_idx ON report_matches (run_id, rival_domain)`,
  `CREATE TABLE IF NOT EXISTS report_ads (id text PRIMARY KEY NOT NULL, run_id text NOT NULL, domain text NOT NULL, platform text NOT NULL, status text NOT NULL, evidence_json text NOT NULL, observed_at text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS report_ads_run_domain_idx ON report_ads (run_id, domain)`,
];

async function getDatabase(): Promise<D1DatabaseLike | null> {
  try {
    const result = await runtimeDatabaseResult();
    if (result.diagnosticCode) logStorageDiagnostic(result.diagnosticCode);
    return result.database;
  } catch {
    logStorageDiagnostic("database-import-failed");
    return null;
  }
}

function logStorageDiagnostic(diagnosticCode: string) {
  if (!REPORT_STORAGE_DIAGNOSTIC.test(diagnosticCode) || emittedStorageDiagnostics.has(diagnosticCode)) return;
  emittedStorageDiagnostics.add(diagnosticCode);
  console.error("report storage diagnostic", { diagnosticCode });
}

function cleanText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function publicId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function internalId() {
  return crypto.randomUUID();
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 86_400_000).toISOString();
}

function safeMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 8_000) throw new Error("Report event metadata is too large.");
  return JSON.parse(json) as Record<string, unknown>;
}

export function compactReportDocument(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const nested = root.document && typeof root.document === "object" && !Array.isArray(root.document) ? root.document as Record<string, unknown> : root;
  if (!Array.isArray(nested.blocks)) return value;
  const blocks = nested.blocks.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const block = raw as Record<string, unknown>;
    const products = Array.isArray(block.products) ? block.products : null;
    const declaredTotal = Number(block.totalProductCount);
    const totalProductCount = Number.isFinite(declaredTotal) && declaredTotal >= (products?.length || 0) ? Math.floor(declaredTotal) : products?.length || 0;
    if (block.type === "product-catalog" && products) {
      const compactProducts = products.slice(0, MAX_SNAPSHOT_CATALOG_PRODUCTS);
      return { ...block, products: compactProducts, persistedProductCount: compactProducts.length, totalProductCount, productsTruncated: totalProductCount > compactProducts.length };
    }
    if (block.type === "product-unmatched" && products) {
      const compactProducts = products.slice(0, MAX_SNAPSHOT_UNMATCHED_PRODUCTS);
      return { ...block, products: compactProducts, persistedProductCount: compactProducts.length, totalProductCount, productsTruncated: totalProductCount > compactProducts.length };
    }
    return block;
  });
  const compactNested = { ...nested, blocks };
  return nested === root ? compactNested : { ...root, document: compactNested };
}

function rowRun(row: Record<string, unknown>): StoredReportRun {
  return {
    id: String(row.id || ""),
    publicId: String(row.public_id || ""),
    primaryDomain: String(row.primary_domain || ""),
    locale: row.locale === "ar" ? "ar" : "en",
    status: STATUSES.has(row.status as ReportRunStatus) ? row.status as ReportRunStatus : "failed",
    currentPhase: PHASES.has(row.current_phase as ReportPhase) ? row.current_phase as ReportPhase : "failed",
    attemptCount: Number(row.attempt_count || 1),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    heartbeatAt: String(row.heartbeat_at || ""),
    expiresAt: String(row.expires_at || ""),
    errorCode: String(row.error_code || ""),
    errorMessage: String(row.error_message || ""),
  };
}

export class ReportStorageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Persistent report storage could not be initialized.");
    this.name = "ReportStorageError";
    this.code = code;
  }
}

export function reportStorageDiagnosticCode(error: unknown) {
  try {
    if (!error || typeof error !== "object") return null;
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name !== "ReportStorageError" || typeof candidate.code !== "string") return null;
    return REPORT_STORAGE_DIAGNOSTIC.test(candidate.code) ? candidate.code : null;
  } catch {
    return null;
  }
}

function safeErrorMessage(error: unknown) {
  try {
    return error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  } catch {
    return "";
  }
}

function batchFailureClass(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/no such (?:table|column)|has no column named/i.test(message)) return "schema-mismatch";
  if (/(?:unique|not null|check|foreign key) constraint/i.test(message)) return "constraint";
  if (/wrong number of parameter bindings|parameter.{0,20}(?:count|binding)|bind.{0,20}(?:count|parameter)/i.test(message)) return "binding-count";
  if (/transaction|database is locked/i.test(message)) return "transaction";
  return "batch-api";
}

async function initializeSchema(database: D1DatabaseLike) {
  for (let index = 0; index < SCHEMA_STATEMENTS.length; index += 1) {
    try {
      await database.prepare(SCHEMA_STATEMENTS[index]).run();
    } catch {
      const diagnosticCode = `schema-statement-${index + 1}-failed`;
      logStorageDiagnostic(diagnosticCode);
      throw new ReportStorageError(diagnosticCode);
    }
  }
}

async function ensureSchema(database: D1DatabaseLike) {
  const key = database as object;
  let pending = schemaInitialization.get(key);
  if (!pending) {
    pending = initializeSchema(database);
    schemaInitialization.set(key, pending);
  }
  try {
    await pending;
  } catch (error) {
    schemaInitialization.delete(key);
    throw error;
  }
}

async function findRun(database: D1DatabaseLike, id: string) {
  const result = await database.prepare(`SELECT * FROM report_runs WHERE ${PUBLIC_ID_PATTERN.test(id) ? "public_id" : "id"} = ? LIMIT 1`).bind(id).all<Record<string, unknown>>();
  return result.results?.[0] ? rowRun(result.results[0]) : null;
}

export async function createReportRun(input: { primaryDomain: string; locale?: string }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  const primaryDomain = canonicalDomain(input.primaryDomain);
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(primaryDomain)) throw new Error(INVALID_DOMAIN_MESSAGE);
  const locale: "en" | "ar" = input.locale === "ar" ? "ar" : "en";
  const id = internalId();
  const shareId = publicId();
  const observedAt = now.toISOString();
  const expiresAt = addDays(now, REPORT_RETENTION_DAYS);
  await ensureSchema(database);
  try {
    await database.batch([
      database.prepare(`INSERT INTO report_runs (id, public_id, primary_domain, locale, status, current_phase, attempt_count, created_at, updated_at, heartbeat_at, expires_at, error_code, error_message) VALUES (?, ?, ?, ?, 'queued', 'queued', 1, ?, ?, ?, ?, '', '')`).bind(id, shareId, primaryDomain, locale, observedAt, observedAt, observedAt, expiresAt),
      database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) VALUES (?, 1, 'run-created', 'queued', 'queued', 'Report queued for public-source collection.', '{}', ?)`).bind(id, observedAt),
    ]);
  } catch (error) {
    const diagnosticCode = `run-create-batch-${batchFailureClass(error)}`;
    logStorageDiagnostic(diagnosticCode);
    throw new ReportStorageError(diagnosticCode);
  }
  return { id, publicId: shareId, primaryDomain, locale, status: "queued" as const, currentPhase: "queued" as const, attemptCount: 1, createdAt: observedAt, expiresAt };
}

export async function createReportRunResult(input: { primaryDomain: string; locale?: string }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  try {
    return { ok: true as const, report: await createReportRun(input, now, databaseOverride) };
  } catch (error) {
    let diagnosticCode: ReportCreateDiagnostic = "run-create-unclassified";
    const message = safeErrorMessage(error);
    if (message === INVALID_DOMAIN_MESSAGE) diagnosticCode = "invalid-domain";
    else if (message === STORAGE_UNAVAILABLE_MESSAGE) diagnosticCode = "storage-unavailable";
    else {
      const knownCode = reportStorageDiagnosticCode(error);
      if (knownCode && REPORT_STORAGE_DIAGNOSTIC.test(knownCode)) diagnosticCode = knownCode as ReportCreateDiagnostic;
    }
    return { ok: false as const, diagnosticCode };
  }
}

export async function appendReportEvent(publicReportId: string, input: { idempotencyKey: string; phase: ReportPhase; status: ReportRunStatus; message: string; metadata?: unknown; errorCode?: string }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  const key = cleanText(input.idempotencyKey, 120);
  const message = cleanText(input.message, 280);
  if (!key || !message || !PHASES.has(input.phase) || !STATUSES.has(input.status)) throw new Error("Invalid report event.");
  if (input.status === "complete") throw new Error("Only a saved report document can complete a report.");
  const metadata = safeMetadata(input.metadata);
  const observedAt = now.toISOString();
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot accept another progress event.");
  await database.batch([
    database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ? FROM report_events WHERE run_id = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, key, input.phase, input.status, message, JSON.stringify(metadata), observedAt, run.id),
    database.prepare(`UPDATE report_runs SET status = ?, current_phase = ?, updated_at = ?, heartbeat_at = ?, error_code = ?, error_message = ? WHERE id = ? AND ? = (SELECT idempotency_key FROM report_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1)`).bind(input.status === "limited" ? "running" : input.status, input.phase, observedAt, observedAt, cleanText(input.errorCode, 80), input.status === "failed" ? message : "", run.id, key, run.id),
  ]);
  return { publicId: run.publicId, phase: input.phase, status: input.status, observedAt };
}

export async function saveReportDocument(publicReportId: string, document: unknown, options: { status?: "complete" | "limited"; observedAt?: string } = {}, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId) || !document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid report document.");
  const compactedDocument = compactReportDocument(document);
  const documentJson = JSON.stringify(compactedDocument);
  if (new TextEncoder().encode(documentJson).byteLength > MAX_REPORT_DOCUMENT_BYTES) throw new Error("The presentation snapshot is too large; store catalogs as relational report products.");
  const requestedObservedAt = cleanText(options.observedAt, 40);
  const observedAt = requestedObservedAt && Number.isFinite(Date.parse(requestedObservedAt)) ? new Date(requestedObservedAt).toISOString() : now.toISOString();
  const status = options.status === "limited" ? "limited" : "complete";
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot be overwritten.");
  await database.batch([
    database.prepare(`INSERT INTO report_documents (run_id, schema_version, document_json, observed_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET schema_version = excluded.schema_version, document_json = excluded.document_json, observed_at = excluded.observed_at, updated_at = excluded.updated_at`).bind(run.id, REPORT_SCHEMA_VERSION, documentJson, observedAt, now.toISOString()),
    database.prepare(`UPDATE report_runs SET status = ?, current_phase = 'complete', updated_at = ?, heartbeat_at = ?, error_code = '', error_message = '' WHERE id = ?`).bind(status, now.toISOString(), now.toISOString(), run.id),
    database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'report-saved', 'complete', ?, 'Report saved from the completed public-source phases.', '{}', ? FROM report_events WHERE run_id = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, status, now.toISOString(), run.id),
  ]);
  return { publicId: run.publicId, status, schemaVersion: REPORT_SCHEMA_VERSION, bytes: new TextEncoder().encode(documentJson).byteLength };
}

export async function getStoredReport(publicReportId: string, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  await ensureSchema(database);
  let run = await findRun(database, publicReportId);
  if (!run) return null;
  const heartbeatTime = Date.parse(run.heartbeatAt);
  if (run.status === "running" && (!Number.isFinite(heartbeatTime) || now.getTime() - heartbeatTime > STALE_RUN_MS)) {
    const observedAt = now.toISOString();
    const message = "The background worker stopped reporting progress before this phase completed.";
    await database.batch([
      database.prepare(`UPDATE report_runs SET status = 'interrupted', current_phase = 'interrupted', updated_at = ?, error_code = 'stale-worker', error_message = ? WHERE id = ?`).bind(observedAt, message, run.id),
      database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'stale-worker-interrupted', 'interrupted', 'interrupted', ?, '{}', ? FROM report_events WHERE run_id = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, message, observedAt, run.id),
    ]);
    run = { ...run, status: "interrupted", currentPhase: "interrupted", updatedAt: observedAt, errorCode: "stale-worker", errorMessage: message };
  } else if (run.status === "queued" && Number.isFinite(heartbeatTime) && now.getTime() - heartbeatTime > QUEUED_DISPATCH_TIMEOUT_MS) {
    const dispatchKey = `job-dispatched-attempt-${run.attemptCount}`;
    const dispatchResult = await database.prepare(`SELECT idempotency_key FROM report_events WHERE run_id = ? AND idempotency_key = ? LIMIT 1`).bind(run.id, dispatchKey).all<Record<string, unknown>>();
    if (dispatchResult.results?.length) {
      const observedAt = now.toISOString();
      const message = "The background report job was accepted but did not start within the expected time.";
      await database.batch([
        database.prepare(`UPDATE report_runs SET status = 'failed', current_phase = 'failed', updated_at = ?, error_code = 'dispatch-timeout', error_message = ? WHERE id = ? AND status = 'queued'`).bind(observedAt, message, run.id),
        database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'queued-dispatch-timeout', 'failed', 'failed', ?, '{}', ? FROM report_events WHERE run_id = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, message, observedAt, run.id),
      ]);
      run = { ...run, status: "failed", currentPhase: "failed", updatedAt: observedAt, errorCode: "dispatch-timeout", errorMessage: message };
    }
  }
  const [eventsResult, documentResult] = await Promise.all([
    database.prepare(`SELECT sequence, idempotency_key, phase, status, message, metadata_json, observed_at FROM report_events WHERE run_id = ? ORDER BY sequence ASC LIMIT 100`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT schema_version, document_json, observed_at, updated_at FROM report_documents WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>(),
  ]);
  const events = (eventsResult.results || []).map((row): StoredReportEvent => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(String(row.metadata_json || "{}")); } catch { metadata = {}; }
    return { sequence: Number(row.sequence || 0), idempotencyKey: String(row.idempotency_key || ""), phase: PHASES.has(row.phase as ReportPhase) ? row.phase as ReportPhase : "failed", status: STATUSES.has(row.status as ReportRunStatus) ? row.status as ReportRunStatus : "failed", message: String(row.message || ""), metadata, observedAt: String(row.observed_at || "") };
  });
  const documentRow = documentResult.results?.[0];
  let document: unknown = null;
  try { document = documentRow ? JSON.parse(String(documentRow.document_json || "null")) : null; } catch { document = null; }
  return { run, events, document, documentSchemaVersion: Number(documentRow?.schema_version || 0), documentObservedAt: String(documentRow?.observed_at || "") };
}

export async function markReportDispatched(publicReportId: string, triggerRunId: string, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const report = await getStoredReport(publicReportId, now, databaseOverride);
  if (!report) throw new Error("Report not found.");
  if (report.run.status === "running") {
    return { publicId: report.run.publicId, phase: report.run.currentPhase, status: report.run.status, observedAt: report.run.updatedAt, skipped: true as const };
  }
  if (report.run.status !== "queued") throw new Error("Only a queued or running report can record dispatch.");
  return appendReportEvent(publicReportId, {
    idempotencyKey: `job-dispatched-attempt-${report.run.attemptCount}`,
    phase: "queued",
    status: "queued",
    message: "The background report job was accepted and is waiting to start.",
    metadata: { triggerRunId: cleanText(triggerRunId, 120), attempt: report.run.attemptCount },
  }, now, databaseOverride);
}

export async function markReportDispatchFailed(publicReportId: string, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  return appendReportEvent(publicReportId, {
    idempotencyKey: "job-dispatch-failed",
    phase: "failed",
    status: "failed",
    message: "The background report job could not be started.",
    errorCode: "dispatch-failed",
  }, now, databaseOverride);
}

export async function recoverInterruptedReport(publicReportId: string, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (run.status !== "interrupted") throw new Error("Only an interrupted report can be recovered.");
  const observedAt = now.toISOString();
  const attemptCount = run.attemptCount + 1;
  const eventKey = `recovery-attempt-${attemptCount}`;
  await database.batch([
    database.prepare(`UPDATE report_runs SET status = 'queued', current_phase = 'queued', attempt_count = ?, updated_at = ?, heartbeat_at = ?, error_code = '', error_message = '' WHERE id = ? AND status = 'interrupted'`).bind(attemptCount, observedAt, observedAt, run.id),
    database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, 'queued', 'queued', 'The interrupted background report was authorized for another attempt.', ?, ? FROM report_events WHERE run_id = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, eventKey, JSON.stringify({ attempt: attemptCount }), observedAt, run.id),
  ]);
  return { ...run, status: "queued" as const, currentPhase: "queued" as const, attemptCount, updatedAt: observedAt, heartbeatAt: observedAt, errorCode: "", errorMessage: "" };
}
