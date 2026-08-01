import { canonicalDomain } from "./domain.ts";
import type { ApplicationDatabase, DatabasePreparedStatement } from "./database-contract.ts";
import { runtimeDatabaseResult } from "./runtime-database.ts";
import { canonicalReportFact, reportFactHash } from "../../src/shared/report-facts.ts";
import { publicHttpUrl } from "./public-url.ts";
import { officialAdRecordUrl } from "./ad-intelligence.ts";
import { DETERMINISTIC_EVALUATOR_VERSION, DETERMINISTIC_RUBRIC_VERSION, profileDeterministicEvaluation } from "./report-evaluator.ts";
import { REPORT_AGENT_DEFAULT_MODEL, REPORT_AGENT_JUDGE_VERSION, REPORT_AGENT_LIMITS, REPORT_AGENT_PRICING_VERSION, REPORT_AGENT_PROMPT_VERSION, REPORT_AGENT_RUBRIC_VERSION, reserveReportAgentCost } from "./report-agent-judge.ts";

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

export type StoredReportSnapshot = {
  run: StoredReportRun;
  events: StoredReportEvent[];
  document: unknown;
  documentSchemaVersion: number;
  documentObservedAt: string;
};

export type StoredReportEvaluation = {
  id: string;
  runId: string;
  evaluationType: "report" | "run_failure";
  inputHash: string;
  factManifestHash: string;
  evaluatorVersion: string;
  rubricVersion: string;
  status: "pending" | "dispatch_failed" | "dispatching" | "profiling" | "ready_for_judge" | "judging" | "complete" | "agent_rejected" | "insufficient_facts" | "rubric_unavailable" | "failed";
  ratingBasis: "hybrid" | "deterministic_only" | "none";
  deterministicScore: number | null;
  overallScore: number | null;
  grade: string | null;
  deterministic: Record<string, unknown>;
  findings: Array<Record<string, unknown>>;
  model: string;
  promptVersion: string;
  pricingVersion: string;
  evaluatedAt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  reservedCostMicrousd: number;
  packetHash: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  dispatchGeneration: number;
  dispatchAttempts: number;
  dispatchTransportAttempts: number;
  dispatchOutcome: string;
  triggerRunId: string;
  errorCode: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
};

export type ReportFactKind = "companies" | "products" | "matches" | "ads";
export type ReportFactChunkInput = {
  attemptNumber?: number;
  manifestId: string;
  kind: ReportFactKind;
  chunkIndex: number;
  chunkCount: number;
  contentHash: string;
  items: Array<Record<string, unknown>>;
};
export type ReportFactManifestInput = {
  attemptNumber?: number;
  manifestId: string;
  manifestHash: string;
  counts: Record<ReportFactKind, number>;
};

export type ReportCreateDiagnostic =
  | "invalid-domain"
  | "storage-unavailable"
  | "database-import-failed"
  | "database-binding-missing"
  | `schema-statement-${number}-failed`
  | `evaluation-migration-${number}-failed`
  | `run-create-batch-${"schema-mismatch" | "constraint" | "binding-count" | "transaction" | "batch-api"}`
  | "run-create-unclassified";

const REPORT_SCHEMA_VERSION = 1;
const REPORT_RETENTION_DAYS = 90;
const STALE_RUN_MS = 10 * 60 * 1000;
const QUEUED_DISPATCH_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_REPORT_DOCUMENT_BYTES = 750_000;
const MAX_SNAPSHOT_CATALOG_PRODUCTS = 40;
const MAX_SNAPSHOT_UNMATCHED_PRODUCTS = 20;
const MAX_REPORT_FACT_CHUNKS = 1_000;
const MAX_REPORT_FACT_CHUNK_BYTES = 1_000_000;
const INVALID_DOMAIN_MESSAGE = "A valid public domain is required.";
const STORAGE_UNAVAILABLE_MESSAGE = "Persistent report storage is unavailable.";
const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
const PHASES = new Set<ReportPhase>(["queued", "crawl", "competitors", "brief", "products", "matching", "enrichment", "actions", "ads", "persistence", "complete", "failed", "interrupted"]);
const STATUSES = new Set<ReportRunStatus>(["queued", "running", "complete", "limited", "failed", "interrupted"]);
const schemaInitialization = new WeakMap<object, Promise<void>>();
const emittedStorageDiagnostics = new Set<string>();
const REPORT_STORAGE_DIAGNOSTIC = /^(?:database-(?:import-failed|binding-missing)|schema-statement-(?:[1-9]|[12]\d|3[01])-failed|evaluation-migration-(?:[1-9]|1[0-2])-failed|run-create-batch-(?:schema-mismatch|constraint|binding-count|transaction|batch-api))$/;

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
  `CREATE TABLE IF NOT EXISTS report_fact_chunks (run_id text NOT NULL, manifest_id text NOT NULL, attempt_number integer NOT NULL, kind text NOT NULL, chunk_index integer NOT NULL, chunk_count integer NOT NULL, item_count integer NOT NULL, content_hash text NOT NULL, created_at text NOT NULL, PRIMARY KEY (run_id, manifest_id, kind, chunk_index))`,
  `CREATE INDEX IF NOT EXISTS report_fact_chunks_run_manifest_idx ON report_fact_chunks (run_id, manifest_id)`,
  `CREATE TABLE IF NOT EXISTS report_fact_manifests (run_id text PRIMARY KEY NOT NULL, manifest_id text NOT NULL, attempt_number integer NOT NULL, manifest_hash text NOT NULL, company_count integer NOT NULL, product_count integer NOT NULL, match_count integer NOT NULL, ad_count integer NOT NULL, status text NOT NULL, lock_owner text NOT NULL, locked_at text NOT NULL, completed_at text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_evaluations (id text PRIMARY KEY NOT NULL, run_id text NOT NULL, evaluation_type text NOT NULL, input_hash text NOT NULL, fact_manifest_hash text DEFAULT '' NOT NULL, evaluator_version text NOT NULL, rubric_version text NOT NULL, status text NOT NULL, rating_basis text NOT NULL, overall_score integer, user_value_score integer, evidence_integrity_score integer, evidence_yield_score integer, presentation_score integer, deterministic_score integer, grade text, deterministic_json text DEFAULT '{}' NOT NULL, agent_json text DEFAULT '{}' NOT NULL, findings_json text DEFAULT '[]' NOT NULL, proposals_json text DEFAULT '[]' NOT NULL, model text DEFAULT '' NOT NULL, prompt_version text DEFAULT '' NOT NULL, pricing_version text DEFAULT '' NOT NULL, evaluated_at text DEFAULT '' NOT NULL, max_input_tokens integer DEFAULT 0 NOT NULL, max_output_tokens integer DEFAULT 0 NOT NULL, reserved_cost_microusd integer DEFAULT 0 NOT NULL, packet_hash text DEFAULT '' NOT NULL, cost_microusd integer DEFAULT 0 NOT NULL, input_tokens integer DEFAULT 0 NOT NULL, output_tokens integer DEFAULT 0 NOT NULL, error_code text DEFAULT '' NOT NULL, lease_token text DEFAULT '' NOT NULL, lease_generation integer DEFAULT 0 NOT NULL, lease_expires_at text DEFAULT '' NOT NULL, dispatch_generation integer DEFAULT 0 NOT NULL, dispatch_attempts integer DEFAULT 0 NOT NULL, dispatch_transport_attempts integer DEFAULT 0 NOT NULL, dispatch_outcome text DEFAULT '' NOT NULL, trigger_run_id text DEFAULT '' NOT NULL, created_at text NOT NULL, started_at text DEFAULT '' NOT NULL, completed_at text DEFAULT '' NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_evaluations_identity_uidx ON report_evaluations (run_id, input_hash, evaluator_version, evaluation_type)`,
  `CREATE INDEX IF NOT EXISTS report_evaluations_run_completed_idx ON report_evaluations (run_id, completed_at)`,
  `CREATE INDEX IF NOT EXISTS report_evaluations_score_completed_idx ON report_evaluations (overall_score, completed_at)`,
  `CREATE INDEX IF NOT EXISTS report_evaluations_status_completed_idx ON report_evaluations (status, completed_at)`,
  `CREATE TABLE IF NOT EXISTS report_quality_signals (id text PRIMARY KEY NOT NULL, evaluation_id text NOT NULL, run_id text NOT NULL, primary_domain text NOT NULL, stage text NOT NULL, issue_key text NOT NULL, severity text NOT NULL, evidence_json text DEFAULT '{}' NOT NULL, observed_at text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_quality_signals_evaluation_issue_uidx ON report_quality_signals (evaluation_id, issue_key)`,
  `CREATE INDEX IF NOT EXISTS report_quality_signals_issue_observed_idx ON report_quality_signals (issue_key, observed_at)`,
  `CREATE INDEX IF NOT EXISTS report_quality_signals_stage_severity_observed_idx ON report_quality_signals (stage, severity, observed_at)`,
  `CREATE TABLE IF NOT EXISTS report_purge_audits (id text PRIMARY KEY NOT NULL, cutoff text NOT NULL, heartbeat_guard text NOT NULL, runs_deleted integer NOT NULL, quality_signals_deleted integer NOT NULL, evaluations_deleted integer NOT NULL, ads_deleted integer NOT NULL, matches_deleted integer NOT NULL, products_deleted integer NOT NULL, companies_deleted integer NOT NULL, fact_chunks_deleted integer NOT NULL, fact_manifests_deleted integer NOT NULL, documents_deleted integer NOT NULL, events_deleted integer NOT NULL, observed_at text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS report_purge_audits_observed_idx ON report_purge_audits (observed_at)`,
];

const EVALUATION_COLUMN_MIGRATIONS = [
  `ALTER TABLE report_evaluations ADD COLUMN evaluated_at text DEFAULT '' NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN max_input_tokens integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN max_output_tokens integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN reserved_cost_microusd integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN packet_hash text DEFAULT '' NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN lease_token text DEFAULT '' NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN lease_generation integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN lease_expires_at text DEFAULT '' NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN dispatch_generation integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN dispatch_transport_attempts integer DEFAULT 0 NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN dispatch_outcome text DEFAULT '' NOT NULL`,
  `ALTER TABLE report_evaluations ADD COLUMN trigger_run_id text DEFAULT '' NOT NULL`,
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

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function parsedRecord(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function parsedRecords(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  } catch { return []; }
}

function rowEvaluation(row: Record<string, unknown>): StoredReportEvaluation {
  const status = String(row.status || "failed") as StoredReportEvaluation["status"];
  const ratingBasis = String(row.rating_basis || "none") as StoredReportEvaluation["ratingBasis"];
  return {
    id: String(row.id || ""),
    runId: String(row.run_id || ""),
    evaluationType: row.evaluation_type === "run_failure" ? "run_failure" : "report",
    inputHash: String(row.input_hash || ""),
    factManifestHash: String(row.fact_manifest_hash || ""),
    evaluatorVersion: String(row.evaluator_version || ""),
    rubricVersion: String(row.rubric_version || ""),
    status,
    ratingBasis,
    deterministicScore: row.deterministic_score === null || row.deterministic_score === undefined ? null : Number(row.deterministic_score),
    overallScore: row.overall_score === null || row.overall_score === undefined ? null : Number(row.overall_score),
    grade: row.grade === null || row.grade === undefined ? null : String(row.grade),
    deterministic: parsedRecord(row.deterministic_json),
    findings: parsedRecords(row.findings_json),
    model: String(row.model || ""),
    promptVersion: String(row.prompt_version || ""),
    pricingVersion: String(row.pricing_version || ""),
    evaluatedAt: String(row.evaluated_at || ""),
    maxInputTokens: Number(row.max_input_tokens || 0),
    maxOutputTokens: Number(row.max_output_tokens || 0),
    reservedCostMicrousd: Number(row.reserved_cost_microusd || 0),
    packetHash: String(row.packet_hash || ""),
    leaseGeneration: Number(row.lease_generation || 0),
    leaseExpiresAt: String(row.lease_expires_at || ""),
    dispatchGeneration: Number(row.dispatch_generation || 0),
    dispatchAttempts: Number(row.dispatch_attempts || 0),
    dispatchTransportAttempts: Number(row.dispatch_transport_attempts || 0),
    dispatchOutcome: String(row.dispatch_outcome || ""),
    triggerRunId: String(row.trigger_run_id || ""),
    errorCode: String(row.error_code || ""),
    createdAt: String(row.created_at || ""),
    startedAt: String(row.started_at || ""),
    completedAt: String(row.completed_at || ""),
  };
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

function safeUrl(value: unknown, allowEmpty = true) {
  return publicHttpUrl(value, allowEmpty);
}

function urlHost(value: unknown) {
  try { return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function urlBelongsToDomain(value: unknown, domain: string) {
  const host = urlHost(value);
  return Boolean(host && (host === domain || host.endsWith(`.${domain}`)));
}

function officialAdEvidence(value: unknown, platform: string) {
  return ["Meta", "Google", "TikTok"].includes(platform) && Boolean(officialAdRecordUrl(value, platform as "Meta" | "Google" | "TikTok"));
}

function requiredFactFields(kind: ReportFactKind, item: ReturnType<typeof canonicalReportFact>) {
  const value = item as Record<string, unknown>;
  const required = kind === "companies" ? ["domain", "role"] : kind === "products" ? ["domain", "productId", "name", "sourceUrl"] : kind === "matches" ? ["id", "primaryProductId", "rivalProductId", "rivalDomain", "verdict"] : ["id", "domain", "platform", "status"];
  if (required.some((key) => !value[key])) throw new Error("Report fact is missing a required field.");
  if (kind === "matches" && !["same_product", "close_substitute"].includes(String(value.verdict))) throw new Error("Invalid report match verdict.");
  if (kind === "ads") {
    const evidence = value.evidence as Record<string, unknown>;
    if (value.status !== "verified-active" || !cleanText(evidence?.providerId, 240) || !safeUrl(evidence?.evidenceUrl, false)) throw new Error("Invalid attributable ad fact.");
  }
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
  for (let index = 0; index < EVALUATION_COLUMN_MIGRATIONS.length; index += 1) {
    try {
      await database.prepare(EVALUATION_COLUMN_MIGRATIONS[index]).run();
    } catch (error) {
      if (/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) continue;
      const diagnosticCode = `evaluation-migration-${index + 1}-failed`;
      logStorageDiagnostic(diagnosticCode);
      throw new ReportStorageError(diagnosticCode);
    }
  }
}

export async function getReportDatabase() {
  return getDatabase();
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

export async function appendReportEvent(publicReportId: string, input: { attemptNumber?: number; idempotencyKey: string; phase: ReportPhase; status: ReportRunStatus; message: string; metadata?: unknown; errorCode?: string }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
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
  const attemptNumber = input.attemptNumber ?? run.attemptCount;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber !== run.attemptCount) throw new Error("Report callback attempt is stale or invalid.");
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot accept another progress event.");
  await database.batch([
    database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE((SELECT MAX(sequence) FROM report_events WHERE run_id = ?), 0) + 1, ?, ?, ?, ?, ?, ? FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted') ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, run.id, key, input.phase, input.status, message, JSON.stringify(metadata), observedAt, run.id, attemptNumber),
    database.prepare(`UPDATE report_runs SET status = ?, current_phase = ?, updated_at = ?, heartbeat_at = ?, error_code = ?, error_message = ? WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted') AND ? = (SELECT idempotency_key FROM report_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1)`).bind(input.status === "limited" ? "running" : input.status, input.phase, observedAt, observedAt, cleanText(input.errorCode, 80), input.status === "failed" ? message : "", run.id, attemptNumber, key, run.id),
  ]);
  const persistedRun = await findRun(database, publicReportId);
  if (!persistedRun || persistedRun.attemptCount !== attemptNumber) throw new Error("Report callback attempt is stale or invalid.");
  return { publicId: run.publicId, phase: input.phase, status: input.status, observedAt };
}

export async function saveReportDocument(publicReportId: string, document: unknown, options: { attemptNumber?: number; status?: "complete" | "limited"; observedAt?: string } = {}, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
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
  const attemptNumber = options.attemptNumber ?? run.attemptCount;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber !== run.attemptCount) throw new Error("Report callback attempt is stale or invalid.");
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot be overwritten.");
  const documentHash = await sha256Text(documentJson);
  const manifestRows = await database.prepare(`SELECT manifest_hash, company_count, product_count, match_count, ad_count, status FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const manifest = manifestRows.results?.[0];
  const completeManifest = manifest?.status === "complete" && /^[a-f0-9]{64}$/.test(String(manifest.manifest_hash || ""));
  const evaluatorModel = process.env.MARKET_SIGNAL_EVALUATOR_MODEL || REPORT_AGENT_DEFAULT_MODEL;
  const reservation = reserveReportAgentCost(evaluatorModel);
  const evaluationId = internalId();
  const evaluationStatus = completeManifest ? "pending" : "insufficient_facts";
  const evaluationBasis = "none";
  const evaluationCompletedAt = completeManifest ? "" : now.toISOString();
  const baseStatements = [
    database.prepare(`INSERT INTO report_documents (run_id, schema_version, document_json, observed_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted')) ON CONFLICT(run_id) DO UPDATE SET schema_version = excluded.schema_version, document_json = excluded.document_json, observed_at = excluded.observed_at, updated_at = excluded.updated_at`).bind(run.id, REPORT_SCHEMA_VERSION, documentJson, observedAt, now.toISOString(), run.id, attemptNumber),
    database.prepare(`UPDATE report_runs SET status = ?, current_phase = 'complete', updated_at = ?, heartbeat_at = ?, error_code = '', error_message = '' WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted')`).bind(status, now.toISOString(), now.toISOString(), run.id, attemptNumber),
    database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE((SELECT MAX(sequence) FROM report_events WHERE run_id = ?), 0) + 1, 'report-saved', 'complete', ?, 'Report saved from the completed public-source phases.', '{}', ? FROM report_runs WHERE id = ? AND attempt_count = ? AND status = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, run.id, status, now.toISOString(), run.id, attemptNumber, status),
  ];
  const evaluationStatements = [
    database.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, overall_score, user_value_score, evidence_integrity_score, evidence_yield_score, presentation_score, deterministic_score, grade, deterministic_json, agent_json, findings_json, proposals_json, model, prompt_version, pricing_version, evaluated_at, max_input_tokens, max_output_tokens, reserved_cost_microusd, packet_hash, cost_microusd, input_tokens, output_tokens, error_code, lease_token, lease_generation, lease_expires_at, dispatch_generation, dispatch_attempts, dispatch_transport_attempts, dispatch_outcome, trigger_run_id, created_at, started_at, completed_at) SELECT ?, ?, 'report', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', '{}', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, ?, '', 0, '', 0, 0, 0, '', '', ?, '', ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status = ?) ON CONFLICT(run_id, input_hash, evaluator_version, evaluation_type) DO NOTHING`).bind(evaluationId, run.id, documentHash, completeManifest ? String(manifest?.manifest_hash || "") : "", REPORT_AGENT_JUDGE_VERSION, REPORT_AGENT_RUBRIC_VERSION, evaluationStatus, evaluationBasis, evaluatorModel, REPORT_AGENT_PROMPT_VERSION, reservation.accepted ? REPORT_AGENT_PRICING_VERSION : "", now.toISOString(), REPORT_AGENT_LIMITS.reservedInputTokens, REPORT_AGENT_LIMITS.reservedOutputTokens, reservation.accepted ? reservation.costWithRegionalUpliftMicrousd : 0, completeManifest ? (reservation.accepted ? "" : reservation.errorCode) : "incomplete-fact-manifest", now.toISOString(), evaluationCompletedAt, run.id, attemptNumber, status),
    ...(!completeManifest ? [database.prepare(`INSERT INTO report_quality_signals (id, evaluation_id, run_id, primary_domain, stage, issue_key, severity, evidence_json, observed_at) SELECT ?, ?, ?, ?, 'persistence', 'incomplete-fact-manifest', 'critical', ?, ? WHERE EXISTS (SELECT 1 FROM report_evaluations WHERE id = ? AND status = 'insufficient_facts') ON CONFLICT(evaluation_id, issue_key) DO NOTHING`).bind(internalId(), evaluationId, run.id, run.primaryDomain, JSON.stringify({ manifestStatus: String(manifest?.status || "missing"), coverageMetricsComputed: false }), now.toISOString(), evaluationId)] : []),
  ];
  let evaluationCreated = true;
  try {
    await database.batch([...baseStatements, ...evaluationStatements]);
  } catch {
    evaluationCreated = false;
    console.error("report evaluation creation failed", { stage: "evaluation-create", diagnosticCode: "evaluation-create-failed" });
    await database.batch(baseStatements);
  }
  const persistedRun = await findRun(database, publicReportId);
  if (!persistedRun || persistedRun.attemptCount !== attemptNumber || persistedRun.status !== status) throw new Error("Report callback attempt is stale or invalid.");
  let persistedEvaluationId = "";
  if (evaluationCreated && completeManifest) {
    try {
      const rows = await database.prepare(`SELECT id FROM report_evaluations WHERE run_id = ? AND input_hash = ? AND evaluator_version = ? AND evaluation_type = 'report' LIMIT 1`).bind(run.id, documentHash, REPORT_AGENT_JUDGE_VERSION).all<Record<string, unknown>>();
      persistedEvaluationId = String(rows.results?.[0]?.id || "");
    } catch {
      console.error("report evaluation lookup failed", { stage: "evaluation-lookup", diagnosticCode: "evaluation-lookup-failed" });
    }
  }
  return { publicId: run.publicId, status, schemaVersion: REPORT_SCHEMA_VERSION, bytes: new TextEncoder().encode(documentJson).byteLength, evaluation: persistedEvaluationId ? { id: persistedEvaluationId, inputHash: documentHash, factManifestHash: String(manifest?.manifest_hash || ""), evaluatorVersion: REPORT_AGENT_JUDGE_VERSION } : null };
}

export async function ensureReportStorageSchema(database: D1DatabaseLike) {
  return ensureSchema(database);
}

export async function getReportEvaluation(publicReportId: string, databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) return null;
  const rows = await database.prepare(`SELECT * FROM report_evaluations WHERE run_id = ? AND evaluation_type = 'report' ORDER BY created_at DESC LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  return rows.results?.[0] ? rowEvaluation(rows.results[0]) : null;
}

export async function evaluateStoredReport(publicReportId: string, expected: { inputHash?: string; factManifestHash?: string; evaluatorVersion?: string } = {}, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (run.status !== "complete" && run.status !== "limited") throw new Error("Only a terminal customer report can be evaluated.");
  const evaluationRows = await database.prepare(`SELECT * FROM report_evaluations WHERE run_id = ? AND evaluation_type = 'report' AND evaluator_version = ? ORDER BY created_at DESC LIMIT 1`).bind(run.id, expected.evaluatorVersion || DETERMINISTIC_EVALUATOR_VERSION).all<Record<string, unknown>>();
  if (!evaluationRows.results?.length) throw new Error("Report evaluation was not created.");
  const evaluation = rowEvaluation(evaluationRows.results[0]);
  if ((expected.inputHash && expected.inputHash !== evaluation.inputHash) || (expected.factManifestHash && expected.factManifestHash !== evaluation.factManifestHash) || (expected.evaluatorVersion && expected.evaluatorVersion !== evaluation.evaluatorVersion)) throw new Error("Report evaluation binding conflicts with the persisted evidence snapshot.");
  if (["deterministic", "rubric_unavailable", "insufficient_facts", "failed", "complete", "agent_rejected"].includes(evaluation.status)) return { evaluation, replayed: true as const };
  if (evaluation.status !== "pending") throw new Error("Report evaluation is not available for deterministic profiling.");
  const documentRows = await database.prepare(`SELECT document_json FROM report_documents WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const manifestRows = await database.prepare(`SELECT manifest_hash, company_count, product_count, match_count, ad_count, status FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const documentJson = String(documentRows.results?.[0]?.document_json || "");
  const manifest = manifestRows.results?.[0];
  if (!documentJson || manifest?.status !== "complete") throw new Error("Report evaluation facts are incomplete.");
  const calculatedInputHash = await sha256Text(documentJson);
  if (calculatedInputHash !== evaluation.inputHash || String(manifest.manifest_hash || "") !== evaluation.factManifestHash || evaluation.evaluatorVersion !== DETERMINISTIC_EVALUATOR_VERSION) throw new Error("Report evaluation binding conflicts with the persisted evidence snapshot.");
  const [companyRows, productRows, matchRows, adRows, eventRows] = await Promise.all([
    database.prepare(`SELECT * FROM report_companies WHERE run_id = ? ORDER BY domain`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_products WHERE run_id = ? ORDER BY domain, product_id`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_matches WHERE run_id = ? ORDER BY rival_domain, id`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_ads WHERE run_id = ? ORDER BY domain, platform, id`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_events WHERE run_id = ? ORDER BY sequence`).bind(run.id).all<Record<string, unknown>>(),
  ]);
  let profile: ReturnType<typeof profileDeterministicEvaluation>;
  try {
    profile = profileDeterministicEvaluation({
      primaryDomain: run.primaryDomain,
      terminalStatus: run.status,
      evaluatedAt: now.toISOString(),
      document: JSON.parse(documentJson) as unknown,
      manifest: {
        companyCount: Number(manifest.company_count || 0),
        productCount: Number(manifest.product_count || 0),
        matchCount: Number(manifest.match_count || 0),
        adCount: Number(manifest.ad_count || 0),
      },
      companies: companyRows.results || [],
      products: productRows.results || [],
      matches: matchRows.results || [],
      ads: adRows.results || [],
      events: eventRows.results || [],
    });
  } catch {
    profile = {
      status: "failed",
      deterministicScore: null,
      deterministic: { evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION, rubricVersion: DETERMINISTIC_RUBRIC_VERSION, schemaValid: false },
      findings: [{ issueKey: "deterministic-profiler-failed", message: "The persisted evidence snapshot could not be profiled." }],
      signals: [{ stage: "evaluation", issueKey: "deterministic-profiler-failed", severity: "critical", evidence: { inputHash: evaluation.inputHash, factManifestHash: evaluation.factManifestHash } }],
      errorCode: "deterministic-profiler-failed",
    };
  }
  const completedAt = now.toISOString();
  const ratingBasis = profile.status === "failed" ? "none" : "deterministic_only";
  const update = database.prepare(`UPDATE report_evaluations SET status = ?, rating_basis = ?, deterministic_score = ?, deterministic_json = ?, findings_json = ?, error_code = ?, started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, completed_at = ? WHERE id = ? AND status = 'pending' AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND overall_score IS NULL AND user_value_score IS NULL AND evidence_integrity_score IS NULL AND evidence_yield_score IS NULL AND presentation_score IS NULL AND grade IS NULL`).bind(profile.status, ratingBasis, profile.deterministicScore, JSON.stringify(profile.deterministic), JSON.stringify(profile.findings), profile.errorCode, completedAt, completedAt, evaluation.id, evaluation.inputHash, evaluation.factManifestHash, evaluation.evaluatorVersion);
  const signalStatements = profile.signals.map((signal) => database.prepare(`INSERT INTO report_quality_signals (id, evaluation_id, run_id, primary_domain, stage, issue_key, severity, evidence_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_evaluations WHERE id = ? AND status = ?) ON CONFLICT(evaluation_id, issue_key) DO NOTHING`).bind(internalId(), evaluation.id, run.id, run.primaryDomain, cleanText(signal.stage, 80), cleanText(signal.issueKey, 120), signal.severity, JSON.stringify(signal.evidence), completedAt, evaluation.id, profile.status));
  await database.batch([update, ...signalStatements]);
  const persistedRows = await database.prepare(`SELECT * FROM report_evaluations WHERE id = ? LIMIT 1`).bind(evaluation.id).all<Record<string, unknown>>();
  if (!persistedRows.results?.length) throw new Error("Report evaluation was not persisted.");
  const persisted = rowEvaluation(persistedRows.results[0]);
  if (persisted.inputHash !== evaluation.inputHash || persisted.factManifestHash !== evaluation.factManifestHash || persisted.evaluatorVersion !== evaluation.evaluatorVersion) throw new Error("Report evaluation binding conflicts with the persisted evidence snapshot.");
  if (persisted.status === "pending") throw new Error("Report evaluation persistence conflicted with another profiler.");
  return { evaluation: persisted, replayed: false as const };
}

export async function saveReportFactChunk(publicReportId: string, input: ReportFactChunkInput, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId) || !/^[a-f0-9]{64}$/.test(input.manifestId) || !/^[a-f0-9]{64}$/.test(input.contentHash)) throw new Error("Invalid report fact chunk identity.");
  if (!(["companies", "products", "matches", "ads"] as string[]).includes(input.kind) || !Number.isInteger(input.chunkIndex) || !Number.isInteger(input.chunkCount) || input.chunkIndex < 0 || input.chunkCount < 1 || input.chunkCount > MAX_REPORT_FACT_CHUNKS || input.chunkIndex >= input.chunkCount || !Array.isArray(input.items) || input.items.length > 50) throw new Error("Invalid report fact chunk.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  const attemptNumber = input.attemptNumber ?? run.attemptCount;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber !== run.attemptCount) throw new Error("Report fact callback attempt is stale or invalid.");
  const items = input.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid report fact.");
    const fact = canonicalReportFact(input.kind, item);
    requiredFactFields(input.kind, fact);
    return fact;
  });
  if (input.kind === "matches" || input.kind === "ads") {
    for (const item of items) {
      const value = item as Record<string, unknown>;
      const expectedId = input.kind === "matches"
        ? await reportFactHash([publicReportId, value.primaryProductId, value.rivalDomain, value.rivalProductId])
        : await reportFactHash([publicReportId, value.domain, value.platform, (value.evidence as Record<string, unknown>).providerId]);
      if (value.id !== expectedId) throw new Error("Report fact id is not attributable to this report.");
    }
  }
  const calculatedHash = await reportFactHash(items);
  if (calculatedHash !== input.contentHash) throw new Error("Report fact chunk hash does not match its content.");
  if (new TextEncoder().encode(JSON.stringify(items)).byteLength > MAX_REPORT_FACT_CHUNK_BYTES) throw new Error("Report fact chunk canonical content is too large.");
  const existing = await database.prepare(`SELECT attempt_number, chunk_count, item_count, content_hash FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? AND kind = ? AND chunk_index = ? LIMIT 1`).bind(run.id, input.manifestId, input.kind, input.chunkIndex).all<Record<string, unknown>>();
  if (existing.results?.length) {
    const row = existing.results[0];
    if (Number(row.attempt_number) > attemptNumber || Number(row.chunk_count) !== input.chunkCount || Number(row.item_count) !== items.length || String(row.content_hash) !== calculatedHash) throw new Error("Report fact chunk replay conflicts with persisted content.");
    return { replayed: true as const, kind: input.kind, chunkIndex: input.chunkIndex, itemCount: items.length };
  }
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot accept report facts.");
  const completed = await database.prepare(`SELECT manifest_id FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  if (completed.results?.length) throw new Error("Completed report facts are immutable.");
  const otherManifest = await database.prepare(`SELECT manifest_id, attempt_number FROM report_fact_chunks WHERE run_id = ? AND manifest_id <> ? ORDER BY attempt_number DESC LIMIT 1`).bind(run.id, input.manifestId).all<Record<string, unknown>>();
  const replacingManifest = Boolean(otherManifest.results?.length);
  if (replacingManifest && (input.kind !== "companies" || input.chunkIndex !== 0 || Number(otherManifest.results?.[0]?.attempt_number || 0) >= attemptNumber)) throw new Error("A different report fact manifest is already in progress.");
  if (input.kind === "companies") {
    for (const item of items) {
      const value = item as Record<string, unknown>;
      const domain = String(value.domain);
      if ((domain === run.primaryDomain) !== (value.role === "primary") || !urlBelongsToDomain(value.evidenceUrl, domain)) throw new Error("Report company attribution does not match its domain or role.");
    }
    if (input.chunkIndex === 0 && !items.some((item) => (item as Record<string, unknown>).domain === run.primaryDomain && (item as Record<string, unknown>).role === "primary")) throw new Error("Report company facts are missing the primary domain.");
  }
  if (input.kind !== "companies" && items.length) {
    const domains = [...new Set(items.map((item) => String((item as Record<string, unknown>).domain || (item as Record<string, unknown>).rivalDomain || "")))];
    const allowed = await database.prepare(`SELECT domain FROM report_companies WHERE run_id = ?`).bind(run.id).all<Record<string, unknown>>();
    const allowedDomains = new Set([run.primaryDomain, ...(allowed.results || []).map((row) => String(row.domain || ""))]);
    if (domains.some((domain) => !allowedDomains.has(domain))) throw new Error("Report fact domain was not persisted as a report company.");
  }
  if (input.kind === "products" && items.some((item) => !urlBelongsToDomain((item as Record<string, unknown>).sourceUrl, String((item as Record<string, unknown>).domain)))) throw new Error("Report product source does not match its domain.");
  if (input.kind === "matches" && items.length) {
    const products = await database.prepare(`SELECT domain, product_id FROM report_products WHERE run_id = ?`).bind(run.id).all<Record<string, unknown>>();
    const productKeys = new Set((products.results || []).map((row) => `${row.domain}\n${row.product_id}`));
    const missingReference = items.some((item) => {
      const value = item as Record<string, unknown>;
      return !productKeys.has(`${run.primaryDomain}\n${value.primaryProductId}`) || !productKeys.has(`${value.rivalDomain}\n${value.rivalProductId}`);
    });
    if (missingReference) throw new Error("Report match references a product that was not persisted.");
    const invalidSources = items.some((item) => {
      const value = item as Record<string, unknown>;
      const evidence = value.evidence as Record<string, unknown>;
      return !urlBelongsToDomain(evidence.primarySourceUrl, run.primaryDomain) || !urlBelongsToDomain(evidence.rivalSourceUrl, String(value.rivalDomain));
    });
    if (invalidSources) throw new Error("Report match evidence source does not match its product domains.");
  }
  if (input.kind === "ads" && items.some((item) => {
    const value = item as Record<string, unknown>;
    return !officialAdEvidence((value.evidence as Record<string, unknown>).evidenceUrl, String(value.platform));
  })) throw new Error("Report ad evidence is not an official platform URL.");
  if ((input.kind === "matches" || input.kind === "ads") && items.length) {
    const ids = items.map((item) => String((item as Record<string, unknown>).id));
    const table = input.kind === "matches" ? "report_matches" : "report_ads";
    const collisions = await database.prepare(`SELECT id FROM ${table} WHERE run_id <> ? AND id IN (${ids.map(() => "?").join(",")}) LIMIT 1`).bind(run.id, ...ids).all<Record<string, unknown>>();
    if (collisions.results?.length) throw new Error("Report fact id belongs to another report.");
  }
  const factStatements = items.map((item) => {
    const value = item as Record<string, unknown>;
    if (input.kind === "companies") return database.prepare(`INSERT INTO report_companies (run_id, domain, role, company_name, evidence_url, evidence_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? AND kind = ? AND chunk_index = ? AND content_hash = ?) ON CONFLICT(run_id, domain) DO UPDATE SET role = excluded.role, company_name = excluded.company_name, evidence_url = excluded.evidence_url, evidence_json = excluded.evidence_json, observed_at = excluded.observed_at`).bind(run.id, value.domain, value.role, value.companyName, value.evidenceUrl, JSON.stringify(value.evidence), value.observedAt, run.id, input.manifestId, input.kind, input.chunkIndex, calculatedHash);
    if (input.kind === "products") return database.prepare(`INSERT INTO report_products (run_id, domain, product_id, name, normalized_name, source_url, image_url, price_json, metadata_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? AND kind = ? AND chunk_index = ? AND content_hash = ?) ON CONFLICT(run_id, domain, product_id) DO UPDATE SET name = excluded.name, normalized_name = excluded.normalized_name, source_url = excluded.source_url, image_url = excluded.image_url, price_json = excluded.price_json, metadata_json = excluded.metadata_json, observed_at = excluded.observed_at`).bind(run.id, value.domain, value.productId, value.name, value.normalizedName, value.sourceUrl, value.imageUrl, JSON.stringify(value.prices), JSON.stringify(value.metadata), value.observedAt, run.id, input.manifestId, input.kind, input.chunkIndex, calculatedHash);
    if (input.kind === "matches") return database.prepare(`INSERT INTO report_matches (id, run_id, primary_product_id, rival_product_id, rival_domain, verdict, confidence, claim_type, model, prompt_version, evidence_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? AND kind = ? AND chunk_index = ? AND content_hash = ?) ON CONFLICT(id) DO NOTHING`).bind(value.id, run.id, value.primaryProductId, value.rivalProductId, value.rivalDomain, value.verdict, value.confidence, value.claimType, value.model, value.promptVersion, JSON.stringify(value.evidence), value.observedAt, run.id, input.manifestId, input.kind, input.chunkIndex, calculatedHash);
    return database.prepare(`INSERT INTO report_ads (id, run_id, domain, platform, status, evidence_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? AND kind = ? AND chunk_index = ? AND content_hash = ?) ON CONFLICT(id) DO NOTHING`).bind(value.id, run.id, value.domain, value.platform, value.status, JSON.stringify(value.evidence), value.observedAt, run.id, input.manifestId, input.kind, input.chunkIndex, calculatedHash);
  });
  const replacementCondition = `EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted')) AND EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id <> ? AND attempt_number < ?) AND NOT EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id <> ? AND attempt_number >= ?) AND NOT EXISTS (SELECT 1 FROM report_fact_manifests WHERE run_id = ?)`;
  const replacementBindings = [run.id, attemptNumber, run.id, input.manifestId, attemptNumber, run.id, input.manifestId, attemptNumber, run.id] as const;
  const statements = replacingManifest ? [
    database.prepare(`DELETE FROM report_matches WHERE run_id = ? AND ${replacementCondition}`).bind(run.id, ...replacementBindings),
    database.prepare(`DELETE FROM report_ads WHERE run_id = ? AND ${replacementCondition}`).bind(run.id, ...replacementBindings),
    database.prepare(`DELETE FROM report_products WHERE run_id = ? AND ${replacementCondition}`).bind(run.id, ...replacementBindings),
    database.prepare(`DELETE FROM report_companies WHERE run_id = ? AND ${replacementCondition}`).bind(run.id, ...replacementBindings),
    database.prepare(`DELETE FROM report_fact_chunks WHERE run_id = ? AND ${replacementCondition}`).bind(run.id, ...replacementBindings),
  ] : [];
  statements.push(database.prepare(`INSERT INTO report_fact_chunks (run_id, manifest_id, attempt_number, kind, chunk_index, chunk_count, item_count, content_hash, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted')) AND NOT EXISTS (SELECT 1 FROM report_fact_manifests WHERE run_id = ?) AND NOT EXISTS (SELECT 1 FROM report_fact_chunks WHERE run_id = ? AND manifest_id <> ? AND attempt_number >= ?) ON CONFLICT(run_id, manifest_id, kind, chunk_index) DO NOTHING`).bind(run.id, input.manifestId, attemptNumber, input.kind, input.chunkIndex, input.chunkCount, items.length, calculatedHash, now.toISOString(), run.id, attemptNumber, run.id, run.id, input.manifestId, attemptNumber));
  statements.push(...factStatements);
  await database.batch(statements);
  const persisted = await database.prepare(`SELECT attempt_number, chunk_count, item_count, content_hash FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? AND kind = ? AND chunk_index = ? LIMIT 1`).bind(run.id, input.manifestId, input.kind, input.chunkIndex).all<Record<string, unknown>>();
  const row = persisted.results?.[0];
  if (!row || Number(row.attempt_number) > attemptNumber || Number(row.chunk_count) !== input.chunkCount || Number(row.item_count) !== items.length || String(row.content_hash) !== calculatedHash) throw new Error("Report fact chunk replay conflicts with persisted content.");
  return { replayed: Boolean(existing.results?.length), kind: input.kind, chunkIndex: input.chunkIndex, itemCount: items.length };
}

export async function finalizeReportFactManifest(publicReportId: string, input: ReportFactManifestInput, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  if (!PUBLIC_ID_PATTERN.test(publicReportId) || !/^[a-f0-9]{64}$/.test(input.manifestId) || !/^[a-f0-9]{64}$/.test(input.manifestHash)) throw new Error("Invalid report fact manifest identity.");
  const counts = input.counts;
  if (!counts || (["companies", "products", "matches", "ads"] as ReportFactKind[]).some((kind) => !Number.isInteger(counts[kind]) || counts[kind] < 0)) throw new Error("Invalid report fact manifest counts.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  const attemptNumber = input.attemptNumber ?? run.attemptCount;
  const manifestRow = async () => (await database.prepare(`SELECT manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>()).results?.[0];
  let prior = await manifestRow();
  const sameManifest = (row: Record<string, unknown>) => String(row.manifest_id) === input.manifestId && Number(row.attempt_number) === attemptNumber && String(row.manifest_hash) === input.manifestHash && Number(row.company_count) === counts.companies && Number(row.product_count) === counts.products && Number(row.match_count) === counts.matches && Number(row.ad_count) === counts.ads;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber !== run.attemptCount) throw new Error("Report fact callback attempt is stale or invalid.");
  if (prior && !sameManifest(prior)) throw new Error("Report fact manifest replay conflicts with persisted content.");
  if (prior?.status === "complete") return { replayed: true as const, manifestId: input.manifestId, counts };
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot finalize report facts.");
  const lockOwner = internalId();
  const lockedAt = now.toISOString();
  if (!prior) {
    try {
      await database.prepare(`INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'finalizing', ?, ?, '' WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted'))`).bind(run.id, input.manifestId, attemptNumber, input.manifestHash, counts.companies, counts.products, counts.matches, counts.ads, lockOwner, lockedAt, run.id, attemptNumber).run();
    } catch {
      prior = await manifestRow();
      if (!prior || !sameManifest(prior)) throw new Error("Report fact manifest replay conflicts with persisted content.");
      if (prior.status === "complete") return { replayed: true as const, manifestId: input.manifestId, counts };
    }
  } else {
    await database.prepare(`UPDATE report_fact_manifests SET lock_owner = ?, locked_at = ? WHERE run_id = ? AND manifest_id = ? AND attempt_number = ? AND status = 'finalizing' AND lock_owner = ? AND locked_at = ? AND EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted'))`).bind(lockOwner, lockedAt, run.id, input.manifestId, attemptNumber, String(prior.lock_owner || ""), String(prior.locked_at || ""), run.id, attemptNumber).run();
  }
  prior = await manifestRow();
  if (prior?.status === "complete" && sameManifest(prior)) return { replayed: true as const, manifestId: input.manifestId, counts };
  if (!prior || !sameManifest(prior) || prior.status !== "finalizing" || prior.lock_owner !== lockOwner) throw new Error("Report fact manifest finalization could not acquire its lock.");
  try {
    const chunks = await database.prepare(`SELECT kind, chunk_index, chunk_count, item_count, content_hash FROM report_fact_chunks WHERE run_id = ? AND manifest_id = ? ORDER BY kind, chunk_index`).bind(run.id, input.manifestId).all<Record<string, unknown>>();
    const rows = chunks.results || [];
    for (const kind of ["companies", "products", "matches", "ads"] as ReportFactKind[]) {
      const group = rows.filter((row) => row.kind === kind);
      const expectedChunks = counts[kind] === 0 ? 1 : Number(group[0]?.chunk_count || 0);
      if (group.length !== expectedChunks || group.some((row, index) => Number(row.chunk_index) !== index || Number(row.chunk_count) !== expectedChunks) || group.reduce((sum, row) => sum + Number(row.item_count || 0), 0) !== counts[kind]) throw new Error("Report fact manifest has incomplete or inconsistent chunks.");
    }
    const calculatedHash = await reportFactHash(rows.map((row) => ({ kind: row.kind, chunkIndex: Number(row.chunk_index), contentHash: row.content_hash })));
    if (calculatedHash !== input.manifestHash) throw new Error("Report fact manifest hash does not match its chunks.");
    const tableCounts = await Promise.all([
      database.prepare(`SELECT COUNT(*) AS count FROM report_companies WHERE run_id = ?`).bind(run.id).all<Record<string, unknown>>(),
      database.prepare(`SELECT COUNT(*) AS count FROM report_products WHERE run_id = ?`).bind(run.id).all<Record<string, unknown>>(),
      database.prepare(`SELECT COUNT(*) AS count FROM report_matches WHERE run_id = ?`).bind(run.id).all<Record<string, unknown>>(),
      database.prepare(`SELECT COUNT(*) AS count FROM report_ads WHERE run_id = ?`).bind(run.id).all<Record<string, unknown>>(),
    ]);
    const actual = tableCounts.map((result) => Number(result.results?.[0]?.count || 0));
    if (actual[0] !== counts.companies || actual[1] !== counts.products || actual[2] !== counts.matches || actual[3] !== counts.ads) throw new Error("Report fact manifest counts do not match relational facts.");
    await database.prepare(`UPDATE report_fact_manifests SET status = 'complete', lock_owner = '', locked_at = '', completed_at = ? WHERE run_id = ? AND manifest_id = ? AND attempt_number = ? AND status = 'finalizing' AND lock_owner = ? AND EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted'))`).bind(now.toISOString(), run.id, input.manifestId, attemptNumber, lockOwner, run.id, attemptNumber).run();
    const completed = await manifestRow();
    if (completed?.status === "complete" && sameManifest(completed)) return { replayed: false as const, manifestId: input.manifestId, counts };
    throw new Error("Report fact manifest finalization lost its lock.");
  } catch (error) {
    await database.prepare(`DELETE FROM report_fact_manifests WHERE run_id = ? AND manifest_id = ? AND attempt_number = ? AND status = 'finalizing' AND lock_owner = ?`).bind(run.id, input.manifestId, attemptNumber, lockOwner).run();
    throw error;
  }
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
      database.prepare(`UPDATE report_runs SET status = 'interrupted', current_phase = 'interrupted', updated_at = ?, error_code = 'stale-worker', error_message = ? WHERE id = ? AND status = 'running' AND attempt_count = ? AND heartbeat_at = ?`).bind(observedAt, message, run.id, run.attemptCount, run.heartbeatAt),
      database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE((SELECT MAX(sequence) FROM report_events WHERE run_id = ?), 0) + 1, 'stale-worker-interrupted', 'interrupted', 'interrupted', ?, '{}', ? FROM report_runs WHERE id = ? AND status = 'interrupted' AND attempt_count = ? AND updated_at = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, run.id, message, observedAt, run.id, run.attemptCount, observedAt),
    ]);
    run = await findRun(database, publicReportId) || run;
  } else if (run.status === "queued" && Number.isFinite(heartbeatTime) && now.getTime() - heartbeatTime > QUEUED_DISPATCH_TIMEOUT_MS) {
    const dispatchKey = `job-dispatched-attempt-${run.attemptCount}`;
    const dispatchResult = await database.prepare(`SELECT idempotency_key FROM report_events WHERE run_id = ? AND idempotency_key = ? LIMIT 1`).bind(run.id, dispatchKey).all<Record<string, unknown>>();
    if (dispatchResult.results?.length) {
      const observedAt = now.toISOString();
      const message = "The background report job was accepted but did not start within the expected time.";
      await database.batch([
        database.prepare(`UPDATE report_runs SET status = 'failed', current_phase = 'failed', updated_at = ?, error_code = 'dispatch-timeout', error_message = ? WHERE id = ? AND status = 'queued' AND attempt_count = ? AND heartbeat_at = ?`).bind(observedAt, message, run.id, run.attemptCount, run.heartbeatAt),
        database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE((SELECT MAX(sequence) FROM report_events WHERE run_id = ?), 0) + 1, 'queued-dispatch-timeout', 'failed', 'failed', ?, '{}', ? FROM report_runs WHERE id = ? AND status = 'failed' AND attempt_count = ? AND updated_at = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, run.id, message, observedAt, run.id, run.attemptCount, observedAt),
      ]);
      run = await findRun(database, publicReportId) || run;
    }
  }
  const [eventsResult, documentResult, manifestResult] = await Promise.all([
    database.prepare(`SELECT sequence, idempotency_key, phase, status, message, metadata_json, observed_at FROM report_events WHERE run_id = ? ORDER BY sequence ASC LIMIT 100`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT schema_version, document_json, observed_at, updated_at FROM report_documents WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>(),
    database.prepare(`SELECT manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, completed_at FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>(),
  ]);
  const events = (eventsResult.results || []).map((row): StoredReportEvent => {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(String(row.metadata_json || "{}")); } catch { metadata = {}; }
    return { sequence: Number(row.sequence || 0), idempotencyKey: String(row.idempotency_key || ""), phase: PHASES.has(row.phase as ReportPhase) ? row.phase as ReportPhase : "failed", status: STATUSES.has(row.status as ReportRunStatus) ? row.status as ReportRunStatus : "failed", message: String(row.message || ""), metadata, observedAt: String(row.observed_at || "") };
  });
  const documentRow = documentResult.results?.[0];
  let document: unknown = null;
  try { document = documentRow ? JSON.parse(String(documentRow.document_json || "null")) : null; } catch { document = null; }
  const manifestRow = manifestResult.results?.[0];
  const factManifest = manifestRow ? {
    manifestId: String(manifestRow.manifest_id || ""),
    attemptNumber: Number(manifestRow.attempt_number || 0),
    manifestHash: String(manifestRow.manifest_hash || ""),
    counts: { companies: Number(manifestRow.company_count || 0), products: Number(manifestRow.product_count || 0), matches: Number(manifestRow.match_count || 0), ads: Number(manifestRow.ad_count || 0) },
    status: String(manifestRow.status || ""),
    completedAt: String(manifestRow.completed_at || ""),
  } : null;
  return { run, events, document, documentSchemaVersion: Number(documentRow?.schema_version || 0), documentObservedAt: String(documentRow?.observed_at || ""), factManifest };
}

/**
 * Imports a public presentation snapshot from the retired deployment without
 * extending retention or replacing a report already owned by this database.
 */
export async function importStoredReportSnapshot(snapshot: StoredReportSnapshot, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  const run = snapshot?.run;
  if (!run || !PUBLIC_ID_PATTERN.test(run.publicId)) throw new Error("Invalid legacy report snapshot.");
  const primaryDomain = canonicalDomain(run.primaryDomain);
  if (!primaryDomain || primaryDomain !== run.primaryDomain) throw new Error("Invalid legacy report snapshot.");
  if (!(["complete", "limited"] as ReportRunStatus[]).includes(run.status) || run.currentPhase !== "complete") throw new Error("Invalid legacy report snapshot.");
  if (!Number.isInteger(run.attemptCount) || run.attemptCount < 1) throw new Error("Invalid legacy report snapshot.");
  const createdAt = Date.parse(run.createdAt);
  const updatedAt = Date.parse(run.updatedAt);
  const heartbeatAt = Date.parse(run.heartbeatAt);
  const expiresAt = Date.parse(run.expiresAt);
  const retentionWindowMs = REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  if (![createdAt, updatedAt, heartbeatAt, expiresAt].every(Number.isFinite) || expiresAt <= now.getTime() || createdAt >= expiresAt || expiresAt - createdAt > retentionWindowMs) throw new Error("Invalid legacy report snapshot.");
  if (snapshot.documentSchemaVersion !== REPORT_SCHEMA_VERSION || !snapshot.document || typeof snapshot.document !== "object" || Array.isArray(snapshot.document)) throw new Error("Invalid legacy report snapshot.");
  const documentJson = JSON.stringify(snapshot.document);
  if (new TextEncoder().encode(documentJson).byteLength > MAX_REPORT_DOCUMENT_BYTES) throw new Error("Invalid legacy report snapshot.");
  const documentObservedAt = Date.parse(snapshot.documentObservedAt);
  if (!Number.isFinite(documentObservedAt)) throw new Error("Invalid legacy report snapshot.");
  if (!Array.isArray(snapshot.events) || snapshot.events.length > 100) throw new Error("Invalid legacy report snapshot.");
  const events = snapshot.events.map((event) => {
    const sequence = Number(event?.sequence);
    const idempotencyKey = cleanText(event?.idempotencyKey, 120);
    const message = cleanText(event?.message, 280);
    const observedAt = Date.parse(event?.observedAt);
    if (!Number.isInteger(sequence) || sequence < 1 || !idempotencyKey || !message || !PHASES.has(event?.phase) || !STATUSES.has(event?.status) || !Number.isFinite(observedAt)) throw new Error("Invalid legacy report snapshot.");
    return { ...event, sequence, idempotencyKey, message, metadata: safeMetadata(event.metadata), observedAt: new Date(observedAt).toISOString() };
  });
  if (new Set(events.map((event) => event.sequence)).size !== events.length || new Set(events.map((event) => event.idempotencyKey)).size !== events.length) throw new Error("Invalid legacy report snapshot.");

  await ensureSchema(database);
  const id = internalId();
  const statements = [
    database.prepare(`INSERT INTO report_runs (id, public_id, primary_domain, locale, status, current_phase, attempt_count, created_at, updated_at, heartbeat_at, expires_at, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(public_id) DO NOTHING`).bind(id, run.publicId, primaryDomain, run.locale === "ar" ? "ar" : "en", run.status, run.currentPhase, run.attemptCount, new Date(createdAt).toISOString(), new Date(updatedAt).toISOString(), new Date(heartbeatAt).toISOString(), new Date(expiresAt).toISOString(), cleanText(run.errorCode, 80), cleanText(run.errorMessage, 280)),
    ...events.map((event) => database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND public_id = ?) ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(id, event.sequence, event.idempotencyKey, event.phase, event.status, event.message, JSON.stringify(event.metadata), event.observedAt, id, run.publicId)),
    database.prepare(`INSERT INTO report_documents (run_id, schema_version, document_json, observed_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND public_id = ?) ON CONFLICT(run_id) DO NOTHING`).bind(id, REPORT_SCHEMA_VERSION, documentJson, new Date(documentObservedAt).toISOString(), now.toISOString(), id, run.publicId),
  ];
  await database.batch(statements);
  const persisted = await getStoredReport(run.publicId, now, database);
  if (!persisted) throw new Error("Legacy report snapshot could not be persisted.");
  return persisted;
}

export const REPORT_PURGE_BATCH_SIZE = 25;
const REPORT_PURGE_HEARTBEAT_GRACE_MS = 24 * 60 * 60 * 1000;
const REPORT_PURGE_AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export type ReportPurgeCounts = {
  runs: number;
  qualitySignals: number;
  evaluations: number;
  ads: number;
  matches: number;
  products: number;
  companies: number;
  factChunks: number;
  factManifests: number;
  documents: number;
  events: number;
};

export type ReportPurgeResult = {
  cutoff: string;
  heartbeatGuard: string;
  deleted: ReportPurgeCounts;
  remaining: number;
};

function numberField(row: Record<string, unknown> | undefined, key: string) {
  const value = Number(row?.[key] || 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Deletes one bounded batch of expired report evidence. Every child statement
 * repeats the eligibility guard so a stale caller cannot delete a report whose
 * heartbeat was refreshed before the transaction began.
 */
export async function purgeExpiredReports(now = new Date(), databaseOverride?: D1DatabaseLike | null): Promise<ReportPurgeResult> {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  if (!Number.isFinite(now.getTime())) throw new Error("A valid retention cutoff is required.");
  await ensureSchema(database);
  const cutoff = now.toISOString();
  const heartbeatGuard = new Date(now.getTime() - REPORT_PURGE_HEARTBEAT_GRACE_MS).toISOString();
  const auditCutoff = new Date(now.getTime() - REPORT_PURGE_AUDIT_RETENTION_MS).toISOString();
  const auditId = internalId();
  const eligibleRuns = `SELECT id FROM report_runs WHERE expires_at <= ? AND heartbeat_at <= ? AND NOT EXISTS (SELECT 1 FROM report_evaluations active_evaluation WHERE active_evaluation.run_id = report_runs.id AND active_evaluation.status IN ('dispatching', 'profiling', 'ready_for_judge', 'judging') AND active_evaluation.lease_expires_at > ?) ORDER BY expires_at ASC LIMIT ${REPORT_PURGE_BATCH_SIZE}`;
  const eligible = () => [cutoff, heartbeatGuard, cutoff] as const;
  const countFor = (table: string) => `(SELECT COUNT(*) FROM ${table} WHERE run_id IN (${eligibleRuns}))`;
  const runCount = `(SELECT COUNT(*) FROM report_runs WHERE id IN (${eligibleRuns}))`;
  const audit = database.prepare(`INSERT INTO report_purge_audits (id, cutoff, heartbeat_guard, runs_deleted, quality_signals_deleted, evaluations_deleted, ads_deleted, matches_deleted, products_deleted, companies_deleted, fact_chunks_deleted, fact_manifests_deleted, documents_deleted, events_deleted, observed_at) SELECT ?, ?, ?, ${runCount}, ${countFor("report_quality_signals")}, ${countFor("report_evaluations")}, ${countFor("report_ads")}, ${countFor("report_matches")}, ${countFor("report_products")}, ${countFor("report_companies")}, ${countFor("report_fact_chunks")}, ${countFor("report_fact_manifests")}, ${countFor("report_documents")}, ${countFor("report_events")}, ? WHERE EXISTS (${eligibleRuns})`).bind(
    auditId,
    cutoff,
    heartbeatGuard,
    ...eligible(),
    ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(),
    ...eligible(), ...eligible(), ...eligible(), ...eligible(),
    cutoff,
    ...eligible(),
  );
  const guardedDelete = (table: string) => database.prepare(`DELETE FROM ${table} WHERE run_id IN (${eligibleRuns})`).bind(...eligible());
  const statements = [
    database.prepare(`UPDATE report_runs SET heartbeat_at = ? WHERE id IN (SELECT run_id FROM report_evaluations WHERE evaluation_type = 'report' AND status IN ('dispatching', 'profiling', 'ready_for_judge', 'judging') AND lease_expires_at != '' AND lease_expires_at <= ?)` ).bind(cutoff, cutoff),
    database.prepare(`UPDATE report_evaluations SET status = 'dispatch_failed', dispatch_outcome = CASE WHEN dispatch_outcome = '' THEN 'unknown' ELSE dispatch_outcome END, lease_expires_at = '' WHERE evaluation_type = 'report' AND status = 'dispatching' AND lease_expires_at != '' AND lease_expires_at <= ?`).bind(cutoff),
    database.prepare(`UPDATE report_evaluations SET status = 'agent_rejected', rating_basis = 'deterministic_only', overall_score = NULL, grade = NULL, error_code = 'agent-call-outcome-unknown', completed_at = ? WHERE evaluation_type = 'report' AND status = 'judging' AND lease_expires_at != '' AND lease_expires_at <= ?`).bind(cutoff, cutoff),
    database.prepare(`UPDATE report_evaluations SET status = 'pending', dispatch_outcome = 'accepted', lease_expires_at = '' WHERE evaluation_type = 'report' AND status IN ('profiling', 'ready_for_judge') AND lease_expires_at != '' AND lease_expires_at <= ?`).bind(cutoff),
    audit,
    guardedDelete("report_quality_signals"),
    guardedDelete("report_evaluations"),
    guardedDelete("report_ads"),
    guardedDelete("report_matches"),
    guardedDelete("report_products"),
    guardedDelete("report_companies"),
    guardedDelete("report_fact_chunks"),
    guardedDelete("report_fact_manifests"),
    guardedDelete("report_documents"),
    guardedDelete("report_events"),
    database.prepare(`DELETE FROM report_runs WHERE id IN (${eligibleRuns})`).bind(...eligible()),
    database.prepare(`DELETE FROM report_purge_audits WHERE observed_at < ?`).bind(auditCutoff),
    database.prepare(`SELECT * FROM report_purge_audits WHERE id = ? LIMIT 1`).bind(auditId),
    database.prepare(`SELECT COUNT(*) AS count FROM report_runs WHERE expires_at <= ? AND heartbeat_at <= ? AND NOT EXISTS (SELECT 1 FROM report_evaluations active_evaluation WHERE active_evaluation.run_id = report_runs.id AND active_evaluation.status IN ('dispatching', 'profiling', 'ready_for_judge', 'judging') AND active_evaluation.lease_expires_at > ?)` ).bind(cutoff, heartbeatGuard, cutoff),
  ];
  const results = await database.batch(statements);
  const auditRow = (results.at(-2) as { results?: Record<string, unknown>[] } | undefined)?.results?.[0];
  const remainingRow = (results.at(-1) as { results?: Record<string, unknown>[] } | undefined)?.results?.[0];
  return {
    cutoff,
    heartbeatGuard,
    deleted: {
      runs: numberField(auditRow, "runs_deleted"),
      qualitySignals: numberField(auditRow, "quality_signals_deleted"),
      evaluations: numberField(auditRow, "evaluations_deleted"),
      ads: numberField(auditRow, "ads_deleted"),
      matches: numberField(auditRow, "matches_deleted"),
      products: numberField(auditRow, "products_deleted"),
      companies: numberField(auditRow, "companies_deleted"),
      factChunks: numberField(auditRow, "fact_chunks_deleted"),
      factManifests: numberField(auditRow, "fact_manifests_deleted"),
      documents: numberField(auditRow, "documents_deleted"),
      events: numberField(auditRow, "events_deleted"),
    },
    remaining: numberField(remainingRow, "count"),
  };
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
    database.prepare(`DELETE FROM report_fact_manifests WHERE run_id = ? AND status = 'finalizing' AND attempt_number = ? AND EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND status = 'interrupted' AND attempt_count = ?)`).bind(run.id, run.attemptCount, run.id, run.attemptCount),
    database.prepare(`UPDATE report_runs SET status = 'queued', current_phase = 'queued', attempt_count = ?, updated_at = ?, heartbeat_at = ?, error_code = '', error_message = '' WHERE id = ? AND status = 'interrupted' AND attempt_count = ?`).bind(attemptCount, observedAt, observedAt, run.id, run.attemptCount),
    database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) SELECT ?, COALESCE((SELECT MAX(sequence) FROM report_events WHERE run_id = ?), 0) + 1, ?, 'queued', 'queued', 'The interrupted background report was authorized for another attempt.', ?, ? FROM report_runs WHERE id = ? AND status = 'queued' AND attempt_count = ? ON CONFLICT(run_id, idempotency_key) DO NOTHING`).bind(run.id, run.id, eventKey, JSON.stringify({ attempt: attemptCount }), observedAt, run.id, attemptCount),
  ]);
  const recovered = await findRun(database, publicReportId);
  if (!recovered || recovered.status !== "queued" || recovered.attemptCount !== attemptCount) throw new Error("The report recovery attempt is stale.");
  return recovered;
}
