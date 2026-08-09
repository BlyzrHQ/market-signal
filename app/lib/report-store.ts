import { canonicalDomain } from "./domain.ts";
import type { ApplicationDatabase, DatabasePreparedStatement } from "./database-contract.ts";
import { runtimeDatabaseResult } from "./runtime-database.ts";
import { canonicalReportFact, reportFactHash } from "../../src/shared/report-facts.ts";
import { publicHttpUrl } from "./public-url.ts";
import { officialAdRecordUrl } from "./ad-intelligence.ts";
import { DETERMINISTIC_EVALUATOR_VERSION, DETERMINISTIC_RUBRIC_VERSION, profileDeterministicEvaluation } from "./report-evaluator.ts";
import { compactTerminalReportDocument, REPORT_SNAPSHOT_HARD_BYTES } from "../../src/shared/report-document-compaction.ts";
import { PRODUCT_PLAN_LIMITS, type ProductEntitlement, type ProductPlan } from "./product-entitlements.ts";
import {
  AGENT_EVALUATOR_VERSION,
  AGENT_MAX_RESERVED_COST_MICROUSD,
  AGENT_MODEL,
  AGENT_PRICING_VERSION,
  AGENT_PROMPT_VERSION,
  buildAgentEvidenceCatalog,
  buildCanonicalAgentInput,
  calculateAgentUsageCost,
  calculateHybridScores,
  validateAgentEvaluationResult,
  type AgentEvidenceCandidate,
} from "./report-agent-evaluator.ts";
import type { ReportEvaluationTerminalCallback } from "../../src/shared/report-evaluation-contract.ts";

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
  productPlan: ProductPlan;
  productLimit: number;
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
  primaryProducts?: StoredPrimaryProducts;
};

export type StoredPrimaryProducts = {
  authoritative: boolean;
  totalCount: number;
  products: Array<Record<string, unknown>>;
  truncated: boolean;
};

export type StoredReportMatchPage = {
  authoritative: true;
  manifestHash: string;
  totalCount: number;
  directPriceCount: number;
  items: Array<{
    primary: Record<string, unknown>;
    rival: Record<string, unknown>;
    match: Record<string, unknown>;
    key: string;
  }>;
  nextCursor: string | null;
};

export type StoredReportEvaluation = {
  id: string;
  runId: string;
  evaluationType: "report" | "run_failure";
  inputHash: string;
  factManifestHash: string;
  evaluatorVersion: string;
  rubricVersion: string;
  status: "pending" | "deterministic" | "dispatching" | "dispatch_failed" | "reserved" | "complete" | "agent_rejected" | "needs_human_review" | "call_outcome_unknown" | "insufficient_facts" | "rubric_unavailable" | "failed";
  ratingBasis: "hybrid" | "deterministic_only" | "none";
  deterministicScore: number | null;
  overallScore: number | null;
  grade: string | null;
  deterministic: Record<string, unknown>;
  agent: Record<string, unknown>;
  findings: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  model: string;
  promptVersion: string;
  pricingVersion: string;
  usageStatus: "not_called" | "reserved" | "known" | "unknown";
  costMicrousd: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reservedCostMicrousd: number;
  dispatchAttempts: number;
  deterministicAt: string;
  dispatchStartedAt: string;
  dispatchToken: string;
  dispatchFailedAt: string;
  watchdogExpiredAt: string;
  reservationId: string;
  reservationOwner: string;
  reservedAt: string;
  clientRequestId: string;
  providerResponseId: string;
  providerRequestId: string;
  errorCode: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
};

export type HumanReviewResolutionCode = "answered" | "unable_to_determine" | "invalid_question";
export type StoredHumanReviewRequest = {
  queueSeq: number;
  id: string;
  evaluationId: string;
  runId: string;
  publicReportId: string;
  primaryDomain: string;
  uncertaintyCode: string;
  question: string;
  evidenceIds: string[];
  strengths: Array<Record<string, unknown>>;
  weaknesses: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  createdAt: string;
  response: null | {
    id: string;
    idempotencyKey: string;
    resolutionCode: HumanReviewResolutionCode;
    answerText: string;
    respondedAt: string;
  };
};

export class ReportEvaluationStateError extends Error {
  readonly code: string;
  readonly httpStatus: 404 | 409 | 410;
  constructor(code: string, message: string, httpStatus: 404 | 409 | 410) {
    super(message);
    this.name = "ReportEvaluationStateError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

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

export type ReportMatchBatchCheckpoint = {
  attemptNumber: number;
  batchIndex: number;
  inputHash: string;
  result: unknown;
  resultHash: string;
  createdAt: string;
  updatedAt: string;
};

export type ReportMatchBatchCheckpointInput = {
  attemptNumber: number;
  batchIndex: number;
  inputHash: string;
  result: unknown;
  resultHash?: string;
};

export type ReportCreateDiagnostic =
  | "invalid-domain"
  | "storage-unavailable"
  | "database-import-failed"
  | "database-binding-missing"
  | `schema-statement-${number}-failed`
  | `run-create-batch-${"schema-mismatch" | "constraint" | "binding-count" | "transaction" | "batch-api"}`
  | "run-create-unclassified";

const REPORT_SCHEMA_VERSION = 1;
const REPORT_RETENTION_DAYS = 90;
// The largest authenticated worker operation is a 12.5-minute deep-catalog
// match. Keep the stale guard above that deadline so report polling cannot
// interrupt a healthy matcher between phase heartbeats.
const STALE_RUN_MS = 15 * 60 * 1000;
const QUEUED_DISPATCH_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_REPORT_DOCUMENT_BYTES = REPORT_SNAPSHOT_HARD_BYTES;
const MAX_REPORT_FACT_CHUNKS = 1_000;
const MAX_REPORT_FACT_CHUNK_BYTES = 1_000_000;
export const MAX_REPORT_MATCH_BATCH_RESULT_BYTES = 512_000;
const INVALID_DOMAIN_MESSAGE = "A valid public domain is required.";
const STORAGE_UNAVAILABLE_MESSAGE = "Persistent report storage is unavailable.";
const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
const MATCH_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PUBLIC_MATCH_PAGE_SIZE = 100;
const PHASES = new Set<ReportPhase>(["queued", "crawl", "competitors", "brief", "products", "matching", "enrichment", "actions", "ads", "persistence", "complete", "failed", "interrupted"]);
const STATUSES = new Set<ReportRunStatus>(["queued", "running", "complete", "limited", "failed", "interrupted"]);
const TERMINAL_REPORT_STATUSES = new Set<ReportRunStatus>(["complete", "limited", "failed", "interrupted"]);
const schemaInitialization = new WeakMap<object, Promise<void>>();
const emittedStorageDiagnostics = new Set<string>();
const REPORT_STORAGE_DIAGNOSTIC = /^(?:database-(?:import-failed|binding-missing)|schema-statement-[1-9]\d?-failed|run-create-batch-(?:schema-mismatch|constraint|binding-count|transaction|batch-api))$/;

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
  `CREATE INDEX IF NOT EXISTS report_matches_run_rival_id_idx ON report_matches (run_id, rival_domain, id)`,
  `CREATE TABLE IF NOT EXISTS report_ads (id text PRIMARY KEY NOT NULL, run_id text NOT NULL, domain text NOT NULL, platform text NOT NULL, status text NOT NULL, evidence_json text NOT NULL, observed_at text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS report_ads_run_domain_idx ON report_ads (run_id, domain)`,
  `CREATE TABLE IF NOT EXISTS report_fact_chunks (run_id text NOT NULL, manifest_id text NOT NULL, attempt_number integer NOT NULL, kind text NOT NULL, chunk_index integer NOT NULL, chunk_count integer NOT NULL, item_count integer NOT NULL, content_hash text NOT NULL, created_at text NOT NULL, PRIMARY KEY (run_id, manifest_id, kind, chunk_index))`,
  `CREATE INDEX IF NOT EXISTS report_fact_chunks_run_manifest_idx ON report_fact_chunks (run_id, manifest_id)`,
  `CREATE TABLE IF NOT EXISTS report_fact_manifests (run_id text PRIMARY KEY NOT NULL, manifest_id text NOT NULL, attempt_number integer NOT NULL, manifest_hash text NOT NULL, company_count integer NOT NULL, product_count integer NOT NULL, match_count integer NOT NULL, ad_count integer NOT NULL, status text NOT NULL, lock_owner text NOT NULL, locked_at text NOT NULL, completed_at text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_match_batch_checkpoints (run_id text NOT NULL, attempt_number integer NOT NULL, batch_index integer NOT NULL, input_hash text NOT NULL, result_json text NOT NULL, result_hash text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL, PRIMARY KEY (run_id, attempt_number, batch_index))`,
  `CREATE INDEX IF NOT EXISTS report_match_batch_checkpoints_run_attempt_idx ON report_match_batch_checkpoints (run_id, attempt_number, batch_index)`,
  `CREATE TABLE IF NOT EXISTS report_evaluations (id text PRIMARY KEY NOT NULL, run_id text NOT NULL, evaluation_type text NOT NULL, input_hash text NOT NULL, fact_manifest_hash text DEFAULT '' NOT NULL, evaluator_version text NOT NULL, rubric_version text NOT NULL, status text NOT NULL, rating_basis text NOT NULL, overall_score integer, user_value_score integer, evidence_integrity_score integer, evidence_yield_score integer, presentation_score integer, deterministic_score integer, grade text, deterministic_json text DEFAULT '{}' NOT NULL, agent_json text DEFAULT '{}' NOT NULL, findings_json text DEFAULT '[]' NOT NULL, proposals_json text DEFAULT '[]' NOT NULL, model text DEFAULT '' NOT NULL, prompt_version text DEFAULT '' NOT NULL, pricing_version text DEFAULT '' NOT NULL, cost_microusd integer, input_tokens integer, cached_input_tokens integer, output_tokens integer, usage_status text DEFAULT 'not_called' NOT NULL, reserved_cost_microusd integer DEFAULT 0 NOT NULL, error_code text DEFAULT '' NOT NULL, dispatch_attempts integer DEFAULT 0 NOT NULL, deterministic_at text DEFAULT '' NOT NULL, dispatch_started_at text DEFAULT '' NOT NULL, dispatch_token text DEFAULT '' NOT NULL, dispatch_failed_at text DEFAULT '' NOT NULL, watchdog_expired_at text DEFAULT '' NOT NULL, reservation_id text DEFAULT '' NOT NULL, reservation_owner text DEFAULT '' NOT NULL, reserved_at text DEFAULT '' NOT NULL, client_request_id text DEFAULT '' NOT NULL, provider_response_id text DEFAULT '' NOT NULL, provider_request_id text DEFAULT '' NOT NULL, created_at text NOT NULL, started_at text DEFAULT '' NOT NULL, completed_at text DEFAULT '' NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_evaluations_identity_uidx ON report_evaluations (run_id, input_hash, evaluator_version, evaluation_type)`,
  `CREATE INDEX IF NOT EXISTS report_evaluations_run_completed_idx ON report_evaluations (run_id, completed_at)`,
  `CREATE INDEX IF NOT EXISTS report_evaluations_score_completed_idx ON report_evaluations (overall_score, completed_at)`,
  `CREATE INDEX IF NOT EXISTS report_evaluations_status_completed_idx ON report_evaluations (status, completed_at)`,
  `CREATE TABLE IF NOT EXISTS report_quality_signals (id text PRIMARY KEY NOT NULL, evaluation_id text NOT NULL, run_id text NOT NULL, primary_domain text NOT NULL, stage text NOT NULL, issue_key text NOT NULL, severity text NOT NULL, evidence_json text DEFAULT '{}' NOT NULL, observed_at text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_quality_signals_evaluation_issue_uidx ON report_quality_signals (evaluation_id, issue_key)`,
  `CREATE INDEX IF NOT EXISTS report_quality_signals_issue_observed_idx ON report_quality_signals (issue_key, observed_at)`,
  `CREATE INDEX IF NOT EXISTS report_quality_signals_stage_severity_observed_idx ON report_quality_signals (stage, severity, observed_at)`,
  `CREATE TABLE IF NOT EXISTS report_human_review_requests (queue_seq integer PRIMARY KEY AUTOINCREMENT NOT NULL, id text NOT NULL, evaluation_id text NOT NULL REFERENCES report_evaluations(id) ON DELETE CASCADE, run_id text NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE, evaluator_version text NOT NULL, input_hash text NOT NULL, fact_manifest_hash text NOT NULL, uncertainty_code text NOT NULL CHECK (uncertainty_code IN ('conflicting_evidence','subjective_usefulness','insufficient_context','suspected_factual_error')), question text NOT NULL CHECK (length(question) BETWEEN 1 AND 240), evidence_ids_json text NOT NULL, request_hash text NOT NULL CHECK (length(request_hash) = 64), created_at text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_human_review_requests_id_uidx ON report_human_review_requests (id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_human_review_requests_evaluation_uidx ON report_human_review_requests (evaluation_id)`,
  `CREATE TABLE IF NOT EXISTS report_human_review_responses (id text PRIMARY KEY NOT NULL, request_id text NOT NULL REFERENCES report_human_review_requests(id) ON DELETE CASCADE, evaluation_id text NOT NULL REFERENCES report_evaluations(id) ON DELETE CASCADE, run_id text NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE, idempotency_key text NOT NULL, resolution_code text NOT NULL CHECK (resolution_code IN ('answered','unable_to_determine','invalid_question')), answer_text text DEFAULT '' NOT NULL CHECK ((resolution_code = 'answered' AND length(answer_text) BETWEEN 1 AND 1000) OR (resolution_code != 'answered' AND answer_text = '')), response_hash text NOT NULL CHECK (length(response_hash) = 64), reviewer_key text NOT NULL, responded_at text NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_human_review_responses_request_uidx ON report_human_review_responses (request_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_human_review_responses_idempotency_uidx ON report_human_review_responses (idempotency_key)`,
  `CREATE TRIGGER IF NOT EXISTS report_human_review_requests_immutable BEFORE UPDATE ON report_human_review_requests BEGIN SELECT RAISE(ABORT, 'immutable human review request'); END`,
  `CREATE TRIGGER IF NOT EXISTS report_human_review_responses_immutable BEFORE UPDATE ON report_human_review_responses BEGIN SELECT RAISE(ABORT, 'immutable human review response'); END`,
  `CREATE TABLE IF NOT EXISTS report_human_review_open (request_id text PRIMARY KEY NOT NULL REFERENCES report_human_review_requests(id) ON DELETE CASCADE, run_id text NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE, queue_seq integer NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_human_review_open_queue_uidx ON report_human_review_open (queue_seq)`,
  `CREATE TABLE IF NOT EXISTS report_purge_audits (id text PRIMARY KEY NOT NULL, cutoff text NOT NULL, heartbeat_guard text NOT NULL, runs_deleted integer NOT NULL, quality_signals_deleted integer NOT NULL, human_review_requests_deleted integer DEFAULT 0 NOT NULL, human_review_responses_deleted integer DEFAULT 0 NOT NULL, human_review_open_deleted integer DEFAULT 0 NOT NULL, evaluations_deleted integer NOT NULL, ads_deleted integer NOT NULL, matches_deleted integer NOT NULL, products_deleted integer NOT NULL, companies_deleted integer NOT NULL, fact_chunks_deleted integer NOT NULL, fact_manifests_deleted integer NOT NULL, documents_deleted integer NOT NULL, events_deleted integer NOT NULL, observed_at text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS report_purge_audits_observed_idx ON report_purge_audits (observed_at)`,
  `CREATE TABLE IF NOT EXISTS report_product_entitlements (run_id text PRIMARY KEY NOT NULL, plan_tier text NOT NULL, product_limit integer NOT NULL, resolved_at text NOT NULL)`,
];

const REPORT_EVALUATION_COLUMN_MIGRATIONS = [
  ["cached_input_tokens", "ALTER TABLE report_evaluations ADD COLUMN cached_input_tokens integer"],
  ["usage_status", "ALTER TABLE report_evaluations ADD COLUMN usage_status text DEFAULT 'not_called' NOT NULL"],
  ["reserved_cost_microusd", "ALTER TABLE report_evaluations ADD COLUMN reserved_cost_microusd integer DEFAULT 0 NOT NULL"],
  ["deterministic_at", "ALTER TABLE report_evaluations ADD COLUMN deterministic_at text DEFAULT '' NOT NULL"],
  ["dispatch_started_at", "ALTER TABLE report_evaluations ADD COLUMN dispatch_started_at text DEFAULT '' NOT NULL"],
  ["dispatch_token", "ALTER TABLE report_evaluations ADD COLUMN dispatch_token text DEFAULT '' NOT NULL"],
  ["dispatch_failed_at", "ALTER TABLE report_evaluations ADD COLUMN dispatch_failed_at text DEFAULT '' NOT NULL"],
  ["watchdog_expired_at", "ALTER TABLE report_evaluations ADD COLUMN watchdog_expired_at text DEFAULT '' NOT NULL"],
  ["reservation_id", "ALTER TABLE report_evaluations ADD COLUMN reservation_id text DEFAULT '' NOT NULL"],
  ["reservation_owner", "ALTER TABLE report_evaluations ADD COLUMN reservation_owner text DEFAULT '' NOT NULL"],
  ["reserved_at", "ALTER TABLE report_evaluations ADD COLUMN reserved_at text DEFAULT '' NOT NULL"],
  ["client_request_id", "ALTER TABLE report_evaluations ADD COLUMN client_request_id text DEFAULT '' NOT NULL"],
  ["provider_response_id", "ALTER TABLE report_evaluations ADD COLUMN provider_response_id text DEFAULT '' NOT NULL"],
  ["provider_request_id", "ALTER TABLE report_evaluations ADD COLUMN provider_request_id text DEFAULT '' NOT NULL"],
] as const;

const REPORT_PURGE_AUDIT_COLUMN_MIGRATIONS = [
  ["human_review_requests_deleted", "ALTER TABLE report_purge_audits ADD COLUMN human_review_requests_deleted integer DEFAULT 0 NOT NULL"],
  ["human_review_responses_deleted", "ALTER TABLE report_purge_audits ADD COLUMN human_review_responses_deleted integer DEFAULT 0 NOT NULL"],
  ["human_review_open_deleted", "ALTER TABLE report_purge_audits ADD COLUMN human_review_open_deleted integer DEFAULT 0 NOT NULL"],
] as const;

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
    agent: parsedRecord(row.agent_json),
    findings: parsedRecords(row.findings_json),
    proposals: parsedRecords(row.proposals_json),
    model: String(row.model || ""),
    promptVersion: String(row.prompt_version || ""),
    pricingVersion: String(row.pricing_version || ""),
    usageStatus: (["not_called", "reserved", "known", "unknown"].includes(String(row.usage_status)) ? String(row.usage_status) : "not_called") as StoredReportEvaluation["usageStatus"],
    costMicrousd: row.usage_status === "known" ? Number(row.cost_microusd) : null,
    inputTokens: row.usage_status === "known" ? Number(row.input_tokens) : null,
    cachedInputTokens: row.usage_status === "known" ? Number(row.cached_input_tokens || 0) : null,
    outputTokens: row.usage_status === "known" ? Number(row.output_tokens) : null,
    reservedCostMicrousd: Number(row.reserved_cost_microusd || 0),
    dispatchAttempts: Number(row.dispatch_attempts || 0),
    deterministicAt: String(row.deterministic_at || ""),
    dispatchStartedAt: String(row.dispatch_started_at || ""),
    dispatchToken: String(row.dispatch_token || ""),
    dispatchFailedAt: String(row.dispatch_failed_at || ""),
    watchdogExpiredAt: String(row.watchdog_expired_at || ""),
    reservationId: String(row.reservation_id || ""),
    reservationOwner: String(row.reservation_owner || ""),
    reservedAt: String(row.reserved_at || ""),
    clientRequestId: String(row.client_request_id || ""),
    providerResponseId: String(row.provider_response_id || ""),
    providerRequestId: String(row.provider_request_id || ""),
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

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableJsonValue(item)]));
}

function boundedCheckpointResult(value: unknown) {
  let transportJson: string;
  try {
    transportJson = JSON.stringify(value);
  } catch {
    throw new Error("Report match batch checkpoint result must be valid JSON.");
  }
  if (transportJson === undefined) throw new Error("Report match batch checkpoint result must be valid JSON.");
  const resultJson = JSON.stringify(stableJsonValue(JSON.parse(transportJson)));
  if (new TextEncoder().encode(resultJson).byteLength > MAX_REPORT_MATCH_BATCH_RESULT_BYTES) throw new Error("Report match batch checkpoint result is too large.");
  return resultJson;
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

export const compactReportDocument = compactTerminalReportDocument;

function rowRun(row: Record<string, unknown>): StoredReportRun {
  const productPlan = Object.hasOwn(PRODUCT_PLAN_LIMITS, String(row.plan_tier || "")) ? String(row.plan_tier) as ProductPlan : "starter";
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
    productPlan,
    productLimit: PRODUCT_PLAN_LIMITS[productPlan],
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
  const columns = await database.prepare("PRAGMA table_info(report_evaluations)").all<Record<string, unknown>>();
  const names = new Set((columns.results || []).map((column) => String(column.name || "")));
  for (const [name, statement] of REPORT_EVALUATION_COLUMN_MIGRATIONS) {
    if (names.has(name)) continue;
    await database.prepare(statement).run();
  }
  const auditColumns = await database.prepare("PRAGMA table_info(report_purge_audits)").all<Record<string, unknown>>();
  const auditNames = new Set((auditColumns.results || []).map((column) => String(column.name || "")));
  for (const [name, statement] of REPORT_PURGE_AUDIT_COLUMN_MIGRATIONS) {
    if (auditNames.has(name)) continue;
    await database.prepare(statement).run();
  }
  await database.prepare(`UPDATE report_evaluations SET deterministic_at = CASE WHEN deterministic_at = '' AND status IN ('deterministic', 'rubric_unavailable', 'failed') THEN COALESCE(NULLIF(completed_at, ''), created_at) ELSE deterministic_at END, usage_status = CASE WHEN usage_status IN ('', 'not_called') AND (COALESCE(cost_microusd, 0) > 0 OR COALESCE(input_tokens, 0) > 0 OR COALESCE(output_tokens, 0) > 0) THEN 'known' WHEN usage_status = '' THEN 'not_called' ELSE usage_status END`).run();
}

function databaseWriteChanged(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const row = result as Record<string, unknown>;
  if (Number.isFinite(Number(row.changes))) return Number(row.changes) > 0;
  const meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? row.meta as Record<string, unknown> : null;
  return meta && Number.isFinite(Number(meta.changes)) ? Number(meta.changes) > 0 : null;
}

function rootReportDocument(value: unknown) {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return root.document && typeof root.document === "object" && !Array.isArray(root.document) ? root.document as Record<string, unknown> : root;
}

function agentEvaluationInput(publicReportId: string, run: StoredReportRun, evaluation: StoredReportEvaluation, document: unknown, companies: Record<string, unknown>[], products: Record<string, unknown>[], matches: Record<string, unknown>[]) {
  const companyIds = new Map(companies.map((company, index) => [String(company.domain || ""), `company:${index + 1}`]));
  const productIds = new Map(products.map((product, index) => [`${String(product.domain || "")}\n${String(product.product_id || "")}`, `product:${index + 1}`]));
  const candidates: AgentEvidenceCandidate[] = [];
  companies.forEach((company, index) => {
    const evidence = parsedRecord(company.evidence_json);
    const domain = String(company.domain || "");
    candidates.push({
      id: `evidence:company:${index + 1}`,
      type: "company",
      companyId: companyIds.get(domain) || null,
      productId: null,
      matchId: null,
      recommendationId: null,
      domain,
      sourceUrl: String(company.evidence_url || ""),
      text: `${String(company.role || "company")}: ${String(company.company_name || domain)}; region ${String(evidence.region || "not observed")}`,
      priority: "other",
      sourceOrder: index,
    });
  });
  const matchedProductKeys = new Set<string>();
  matches.forEach((match, index) => {
    const evidence = parsedRecord(match.evidence_json);
    const rivalDomain = String(match.rival_domain || "");
    const primaryKey = `${run.primaryDomain}\n${String(match.primary_product_id || "")}`;
    const rivalKey = `${rivalDomain}\n${String(match.rival_product_id || "")}`;
    matchedProductKeys.add(primaryKey);
    matchedProductKeys.add(rivalKey);
    const matchId = `match:${index + 1}`;
    const reasons = Array.isArray(evidence.reasons) ? evidence.reasons.slice(0, 2).map(String).join("; ") : "";
    candidates.push({ id: `evidence:match:${index + 1}`, type: "match", companyId: companyIds.get(rivalDomain) || null, productId: productIds.get(primaryKey) || null, matchId, recommendationId: null, domain: rivalDomain, sourceUrl: String(evidence.rivalSourceUrl || ""), text: `${String(match.verdict || "match")}; ${String(match.confidence || "unknown confidence")}${reasons ? `; ${reasons}` : ""}`, priority: "accepted_match", sourceOrder: index });
    const decision = evidence.decision && typeof evidence.decision === "object" && !Array.isArray(evidence.decision) ? evidence.decision as Record<string, unknown> : {};
    const actionPlan = decision.actionPlan && typeof decision.actionPlan === "object" && !Array.isArray(decision.actionPlan) ? decision.actionPlan as Record<string, unknown> : {};
    const action = cleanText(decision.recommendedMove || actionPlan.actionEn, 320);
    if (action) candidates.push({ id: `evidence:recommendation:${index + 1}`, type: "recommendation", companyId: companyIds.get(rivalDomain) || null, productId: productIds.get(primaryKey) || null, matchId, recommendationId: `recommendation:${index + 1}`, domain: rivalDomain, sourceUrl: String(evidence.rivalSourceUrl || ""), text: action, priority: "accepted_match", sourceOrder: index });
  });
  products.forEach((product, index) => {
    const domain = String(product.domain || "");
    const key = `${domain}\n${String(product.product_id || "")}`;
    const prices = parsedRecords(product.price_json).slice(0, 2).map((price) => cleanText(price.raw || `${price.currency || ""} ${price.amount || ""}`, 60)).filter(Boolean);
    candidates.push({ id: `evidence:product:${index + 1}`, type: "product", companyId: companyIds.get(domain) || null, productId: productIds.get(key) || null, matchId: null, recommendationId: null, domain, sourceUrl: String(product.source_url || ""), text: `${String(product.name || "Product")}; price ${prices.join(" / ") || "not observed"}; image ${product.image_url ? "observed" : "not observed"}`, priority: matchedProductKeys.has(key) ? "accepted_match" : "other", sourceOrder: index });
  });
  const deterministic = evaluation.deterministic;
  const hardCaps = Array.isArray(deterministic.hardCaps) ? deterministic.hardCaps : [];
  hardCaps.forEach((cap, index) => {
    const item = cap && typeof cap === "object" && !Array.isArray(cap) ? cap as Record<string, unknown> : {};
    candidates.push({ id: `evidence:gap:cap:${index + 1}`, type: "gap", companyId: null, productId: null, matchId: null, recommendationId: null, domain: run.primaryDomain, sourceUrl: "", text: `${String(item.issueKey || "quality gap")}; maximum overall score ${String(item.maximumOverallScore ?? "unknown")}`, priority: "hard_cap_gap", sourceOrder: index });
  });
  const report = rootReportDocument(document);
  const blocks = Array.isArray(report.blocks) ? report.blocks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const gapBlocks = blocks.filter((block) => block.type === "gap" && cleanText(block.reason, 320)).slice(0, 8);
  gapBlocks.forEach((block, index) => candidates.push({ id: `evidence:gap:report:${index + 1}`, type: "gap", companyId: null, productId: null, matchId: null, recommendationId: null, domain: run.primaryDomain, sourceUrl: String(block.url || block.sourceUrl || ""), text: cleanText(block.reason, 320), priority: "hard_cap_gap", sourceOrder: hardCaps.length + index }));
  const summary = blocks.find((block) => block.type === "summary") || {};
  candidates.push({ id: "evidence:presentation:1", type: "presentation", companyId: null, productId: null, matchId: null, recommendationId: null, domain: run.primaryDomain, sourceUrl: "", text: `Report sections: ${blocks.slice(0, 12).map((block) => String(block.type || "section")).join(", ") || "none"}`, priority: "deterministic_loss", sourceOrder: 0 });
  const evidence = buildAgentEvidenceCatalog(candidates);
  const actions = candidates.filter((item) => item.type === "recommendation").slice(0, 3).map((item) => item.text);
  const gaps = gapBlocks.map((block) => cleanText(block.reason, 240));
  const sections = blocks.slice(0, 8).map((block) => ({ label: cleanText(block.title || block.type, 60), summary: cleanText(block.body || block.summary || block.description, 240) }));
  return buildCanonicalAgentInput({
    report: { id: `report:${publicReportId}`, domain: run.primaryDomain, status: run.status },
    deterministic: { raw: deterministic.raw, components: deterministic.components, hardCaps },
    evidence,
    compactReport: { headline: summary.title, summary: summary.body || summary.summary, actions, gaps, sections, navigationLabels: blocks.map((block) => block.type) },
  });
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
  const row = result.results?.[0];
  if (!row) return null;
  const entitlement = await database.prepare(`SELECT plan_tier, product_limit FROM report_product_entitlements WHERE run_id = ? LIMIT 1`).bind(String(row.id || "")).all<Record<string, unknown>>();
  return rowRun({ ...row, ...(entitlement.results?.[0] || {}) });
}

function matchCursor(value: string) {
  if (!value) return null;
  const separator = value.indexOf("~");
  if (separator <= 0 || separator !== value.lastIndexOf("~")) throw new Error("Invalid report match cursor.");
  const domain = canonicalDomain(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!domain || !MATCH_ID_PATTERN.test(id)) throw new Error("Invalid report match cursor.");
  return { domain, id };
}

function matchProduct(row: Record<string, unknown>, prefix: "primary" | "rival") {
  const metadata = parsedRecord(row[`${prefix}_metadata_json`]);
  return {
    id: String(row[`${prefix}_product_id`] || ""),
    domain: String(row[`${prefix}_domain`] || ""),
    name: String(row[`${prefix}_name`] || ""),
    normalizedName: String(row[`${prefix}_normalized_name`] || ""),
    sourceUrl: String(row[`${prefix}_source_url`] || ""),
    imageUrl: String(row[`${prefix}_image_url`] || ""),
    priceSignals: parsedRecords(row[`${prefix}_price_json`]),
    observedAt: String(row[`${prefix}_observed_at`] || ""),
    ...metadata,
  };
}

function matchPageItem(row: Record<string, unknown>) {
  const evidence = parsedRecord(row.evidence_json);
  const confidence = Number(row.confidence);
  const rivalDomain = String(row.rival_domain || "");
  const id = String(row.match_id || "");
  return {
    primary: matchProduct(row, "primary"),
    rival: matchProduct(row, "rival"),
    match: {
      domain: rivalDomain,
      score: typeof evidence.score === "number" && Number.isFinite(evidence.score) ? evidence.score : null,
      confidence: String(row.confidence || ""),
      sharedTerms: Array.isArray(evidence.sharedTerms) ? evidence.sharedTerms : [],
      claimIds: Array.isArray(evidence.claimIds) ? evidence.claimIds : [],
      assessment: {
        method: row.model ? "ai-hybrid" : "",
        claimType: String(row.claim_type || ""),
        verdict: String(row.verdict || ""),
        confidence: Number.isFinite(confidence) ? confidence : null,
        model: String(row.model || ""),
        promptVersion: String(row.prompt_version || ""),
        reasons: Array.isArray(evidence.reasons) ? evidence.reasons : [],
        contradictions: Array.isArray(evidence.contradictions) ? evidence.contradictions : [],
        normalizedCategory: String(evidence.normalizedCategory || ""),
        normalizedVariant: String(evidence.normalizedVariant || ""),
        normalizedSize: String(evidence.normalizedSize || ""),
        primarySourceUrl: String(evidence.primarySourceUrl || ""),
        rivalSourceUrl: String(evidence.rivalSourceUrl || ""),
      },
      decision: evidence.decision && typeof evidence.decision === "object" && !Array.isArray(evidence.decision) ? evidence.decision : {},
    },
    key: id,
  };
}

export async function loadStoredReportMatchPage(publicReportId: string, input: { cursor?: string; limit?: number } = {}, databaseOverride?: D1DatabaseLike | null): Promise<StoredReportMatchPage> {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  const limit = input.limit === undefined ? MAX_PUBLIC_MATCH_PAGE_SIZE : Math.floor(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PUBLIC_MATCH_PAGE_SIZE) throw new Error("Invalid report match page size.");
  const cursor = matchCursor(input.cursor || "");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  const manifestResult = await database.prepare(`SELECT manifest_hash, attempt_number, match_count, status FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const manifest = manifestResult.results?.[0];
  if (!manifest || manifest.status !== "complete" || Number(manifest.attempt_number) !== run.attemptCount) throw new Error("Authoritative report match facts are unavailable.");
  const cursorCondition = cursor ? " AND (matches.rival_domain > ? OR (matches.rival_domain = ? AND matches.id > ?))" : "";
  const bindings: unknown[] = [run.primaryDomain, run.id];
  if (cursor) bindings.push(cursor.domain, cursor.domain, cursor.id);
  bindings.push(limit + 1);
  const rows = await database.prepare(`SELECT
      matches.id AS match_id, matches.verdict, matches.confidence, matches.claim_type, matches.model, matches.prompt_version, matches.evidence_json,
      primary_products.product_id AS primary_product_id, primary_products.domain AS primary_domain, primary_products.name AS primary_name, primary_products.normalized_name AS primary_normalized_name, primary_products.source_url AS primary_source_url, primary_products.image_url AS primary_image_url, primary_products.price_json AS primary_price_json, primary_products.metadata_json AS primary_metadata_json, primary_products.observed_at AS primary_observed_at,
      rival_products.product_id AS rival_product_id, rival_products.domain AS rival_domain, rival_products.name AS rival_name, rival_products.normalized_name AS rival_normalized_name, rival_products.source_url AS rival_source_url, rival_products.image_url AS rival_image_url, rival_products.price_json AS rival_price_json, rival_products.metadata_json AS rival_metadata_json, rival_products.observed_at AS rival_observed_at
    FROM report_matches AS matches
    JOIN report_products AS primary_products ON primary_products.run_id = matches.run_id AND primary_products.domain = ? AND primary_products.product_id = matches.primary_product_id
    JOIN report_products AS rival_products ON rival_products.run_id = matches.run_id AND rival_products.domain = matches.rival_domain AND rival_products.product_id = matches.rival_product_id
    WHERE matches.run_id = ?${cursorCondition}
    ORDER BY matches.rival_domain ASC, matches.id ASC
    LIMIT ?`).bind(...bindings).all<Record<string, unknown>>();
  const selected = (rows.results || []).slice(0, limit);
  const direct = await database.prepare(`SELECT COUNT(*) AS count FROM report_matches WHERE run_id = ? AND COALESCE(json_extract(evidence_json, '$.decision.priceComparison.primaryRaw'), '') <> '' AND COALESCE(json_extract(evidence_json, '$.decision.priceComparison.rivalRaw'), '') <> ''`).bind(run.id).all<Record<string, unknown>>();
  const last = selected.at(-1);
  return {
    authoritative: true,
    manifestHash: String(manifest.manifest_hash || ""),
    totalCount: Number(manifest.match_count || 0),
    directPriceCount: Number(direct.results?.[0]?.count || 0),
    items: selected.map(matchPageItem),
    nextCursor: (rows.results || []).length > limit && last ? `${String(last.rival_domain)}~${String(last.match_id)}` : null,
  };
}

function rowMatchBatchCheckpoint(row: Record<string, unknown>): ReportMatchBatchCheckpoint {
  let result: unknown;
  try { result = JSON.parse(String(row.result_json)); } catch { throw new Error("Persisted report match batch checkpoint is invalid."); }
  return {
    attemptNumber: Number(row.attempt_number),
    batchIndex: Number(row.batch_index),
    inputHash: String(row.input_hash || ""),
    result,
    resultHash: String(row.result_hash || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function validateMatchBatchCheckpointIdentity(attemptNumber: number, batchIndex: number, inputHash?: string) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error("Invalid report match batch checkpoint attempt.");
  if (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= MAX_REPORT_FACT_CHUNKS) throw new Error("Invalid report match batch checkpoint index.");
  if (inputHash !== undefined && !/^[a-f0-9]{64}$/.test(inputHash)) throw new Error("Invalid report match batch checkpoint input hash.");
}

export async function loadReportMatchBatchCheckpoints(publicReportId: string, input: { attemptNumber: number; batchIndex?: number }, databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  validateMatchBatchCheckpointIdentity(input.attemptNumber, input.batchIndex ?? 0);
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (input.attemptNumber !== run.attemptCount) throw new Error("Report match batch checkpoint attempt is stale.");
  if (TERMINAL_REPORT_STATUSES.has(run.status)) throw new Error("A terminal report cannot load report match batch checkpoints.");
  const byBatch = input.batchIndex === undefined ? "" : " AND batch_index = ?";
  const bindings = input.batchIndex === undefined ? [run.id, input.attemptNumber] : [run.id, input.attemptNumber, input.batchIndex];
  const rows = await database.prepare(`SELECT attempt_number, batch_index, input_hash, result_json, result_hash, created_at, updated_at FROM report_match_batch_checkpoints WHERE run_id = ? AND attempt_number = ?${byBatch} ORDER BY batch_index ASC`).bind(...bindings).all<Record<string, unknown>>();
  return (rows.results || []).map(rowMatchBatchCheckpoint);
}

export async function loadReportProductEntitlement(publicReportId: string, attemptNumber: number, databaseOverride?: D1DatabaseLike | null): Promise<ProductEntitlement> {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  if (!PUBLIC_ID_PATTERN.test(publicReportId) || !Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error("Invalid report entitlement identity.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (run.attemptCount !== attemptNumber) throw new Error("Report product entitlement attempt is stale.");
  return { plan: run.productPlan, productLimit: run.productLimit };
}

export async function saveReportMatchBatchCheckpoint(publicReportId: string, input: ReportMatchBatchCheckpointInput, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  if (!PUBLIC_ID_PATTERN.test(publicReportId)) throw new Error("Invalid report id.");
  validateMatchBatchCheckpointIdentity(input.attemptNumber, input.batchIndex, input.inputHash);
  if (!Number.isFinite(now.getTime())) throw new Error("A valid report match batch checkpoint timestamp is required.");
  const resultJson = boundedCheckpointResult(input.result);
  const resultHash = await sha256Text(resultJson);
  if (input.resultHash !== undefined && input.resultHash !== resultHash) throw new Error("Report match batch checkpoint result hash does not match its content.");
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  if (input.attemptNumber !== run.attemptCount) throw new Error("Report match batch checkpoint attempt is stale.");
  if (TERMINAL_REPORT_STATUSES.has(run.status)) throw new Error("A terminal report cannot accept report match batch checkpoints.");

  const select = () => database.prepare(`SELECT attempt_number, batch_index, input_hash, result_json, result_hash, created_at, updated_at FROM report_match_batch_checkpoints WHERE run_id = ? AND attempt_number = ? AND batch_index = ? LIMIT 1`).bind(run.id, input.attemptNumber, input.batchIndex).all<Record<string, unknown>>();
  let existing = (await select()).results?.[0];
  const replayed = Boolean(existing);
  if (!existing) {
    const observedAt = now.toISOString();
    await database.prepare(`INSERT INTO report_match_batch_checkpoints (run_id, attempt_number, batch_index, input_hash, result_json, result_hash, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status NOT IN ('complete', 'limited', 'failed', 'interrupted')) ON CONFLICT(run_id, attempt_number, batch_index) DO NOTHING`).bind(run.id, input.attemptNumber, input.batchIndex, input.inputHash, resultJson, resultHash, observedAt, observedAt, run.id, input.attemptNumber).run();
    existing = (await select()).results?.[0];
  }
  if (!existing) throw new Error("Report match batch checkpoint attempt is stale or terminal.");
  if (String(existing.input_hash) !== input.inputHash || String(existing.result_hash) !== resultHash || String(existing.result_json) !== resultJson) throw new Error("Report match batch checkpoint replay conflicts with persisted content.");
  return { checkpoint: rowMatchBatchCheckpoint(existing), replayed };
}

export async function createReportRun(input: { primaryDomain: string; locale?: string; entitlement?: ProductEntitlement }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  const primaryDomain = canonicalDomain(input.primaryDomain);
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(primaryDomain)) throw new Error(INVALID_DOMAIN_MESSAGE);
  const locale: "en" | "ar" = input.locale === "ar" ? "ar" : "en";
  const id = internalId();
  const shareId = publicId();
  const observedAt = now.toISOString();
  const expiresAt = addDays(now, REPORT_RETENTION_DAYS);
  const productPlan = input.entitlement?.plan && Object.hasOwn(PRODUCT_PLAN_LIMITS, input.entitlement.plan) ? input.entitlement.plan : "starter";
  const productLimit = PRODUCT_PLAN_LIMITS[productPlan];
  await ensureSchema(database);
  try {
    await database.batch([
      database.prepare(`INSERT INTO report_runs (id, public_id, primary_domain, locale, status, current_phase, attempt_count, created_at, updated_at, heartbeat_at, expires_at, error_code, error_message) VALUES (?, ?, ?, ?, 'queued', 'queued', 1, ?, ?, ?, ?, '', '')`).bind(id, shareId, primaryDomain, locale, observedAt, observedAt, observedAt, expiresAt),
      database.prepare(`INSERT INTO report_product_entitlements (run_id, plan_tier, product_limit, resolved_at) VALUES (?, ?, ?, ?)`).bind(id, productPlan, productLimit, observedAt),
      database.prepare(`INSERT INTO report_events (run_id, sequence, idempotency_key, phase, status, message, metadata_json, observed_at) VALUES (?, 1, 'run-created', 'queued', 'queued', 'Report queued for public-source collection.', ?, ?)`).bind(id, JSON.stringify({ productPlan, productLimit }), observedAt),
    ]);
  } catch (error) {
    const diagnosticCode = `run-create-batch-${batchFailureClass(error)}`;
    logStorageDiagnostic(diagnosticCode);
    throw new ReportStorageError(diagnosticCode);
  }
  return { id, publicId: shareId, primaryDomain, locale, status: "queued" as const, currentPhase: "queued" as const, attemptCount: 1, createdAt: observedAt, expiresAt, productPlan, productLimit };
}

export async function createReportRunResult(input: { primaryDomain: string; locale?: string; entitlement?: ProductEntitlement }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
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
  const requestedObservedAt = cleanText(options.observedAt, 40);
  const observedAt = requestedObservedAt && Number.isFinite(Date.parse(requestedObservedAt)) ? new Date(requestedObservedAt).toISOString() : now.toISOString();
  const status = options.status === "limited" ? "limited" : "complete";
  await ensureSchema(database);
  const run = await findRun(database, publicReportId);
  if (!run) throw new Error("Report not found.");
  const attemptNumber = options.attemptNumber ?? run.attemptCount;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber !== run.attemptCount) throw new Error("Report callback attempt is stale or invalid.");
  if (["complete", "limited", "failed", "interrupted"].includes(run.status)) throw new Error("A terminal report cannot be overwritten.");
  const manifestRows = await database.prepare(`SELECT manifest_hash, company_count, product_count, match_count, ad_count, status FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const manifest = manifestRows.results?.[0];
  const completeManifest = manifest?.status === "complete" && /^[a-f0-9]{64}$/.test(String(manifest.manifest_hash || ""));
  const factCounts = completeManifest ? { companies: Number(manifest?.company_count || 0), products: Number(manifest?.product_count || 0), matches: Number(manifest?.match_count || 0), ads: Number(manifest?.ad_count || 0) } : null;
  const compactedDocument = compactTerminalReportDocument(document, undefined, { factsAuthoritative: completeManifest, factCounts });
  const documentJson = JSON.stringify(compactedDocument);
  if (new TextEncoder().encode(documentJson).byteLength > MAX_REPORT_DOCUMENT_BYTES) throw new Error("The presentation snapshot is too large; store catalogs as relational report products.");
  const documentHash = await sha256Text(documentJson);
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
    database.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, overall_score, user_value_score, evidence_integrity_score, evidence_yield_score, presentation_score, deterministic_score, grade, deterministic_json, agent_json, findings_json, proposals_json, model, prompt_version, pricing_version, cost_microusd, input_tokens, cached_input_tokens, output_tokens, usage_status, reserved_cost_microusd, error_code, dispatch_attempts, created_at, started_at, completed_at) SELECT ?, ?, 'report', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', '{}', '[]', '[]', '', '', '', 0, 0, NULL, 0, 'not_called', 0, ?, 0, ?, '', ? WHERE EXISTS (SELECT 1 FROM report_runs WHERE id = ? AND attempt_count = ? AND status = ?) ON CONFLICT(run_id, input_hash, evaluator_version, evaluation_type) DO NOTHING`).bind(evaluationId, run.id, documentHash, completeManifest ? String(manifest?.manifest_hash || "") : "", AGENT_EVALUATOR_VERSION, DETERMINISTIC_RUBRIC_VERSION, evaluationStatus, evaluationBasis, completeManifest ? "" : "incomplete-fact-manifest", now.toISOString(), evaluationCompletedAt, run.id, attemptNumber, status),
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
  if (evaluationCreated && completeManifest) {
    try {
      await evaluateStoredReport(publicReportId, { inputHash: documentHash, factManifestHash: String(manifest?.manifest_hash || ""), evaluatorVersion: AGENT_EVALUATOR_VERSION }, now, database);
    } catch {
      console.error("report deterministic evaluation failed", { stage: "evaluation-profile", diagnosticCode: "evaluation-profile-failed" });
    }
  }
  const savedEvaluation = evaluationCreated ? await getReportEvaluation(publicReportId, database) : null;
  return { publicId: run.publicId, status, schemaVersion: REPORT_SCHEMA_VERSION, bytes: new TextEncoder().encode(documentJson).byteLength, evaluation: savedEvaluation ? { id: savedEvaluation.id, status: savedEvaluation.status, evaluatorVersion: savedEvaluation.evaluatorVersion } : null };
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
  const evaluationRows = await database.prepare(`SELECT * FROM report_evaluations WHERE run_id = ? AND evaluation_type = 'report' AND evaluator_version = ? ORDER BY created_at DESC LIMIT 1`).bind(run.id, expected.evaluatorVersion || AGENT_EVALUATOR_VERSION).all<Record<string, unknown>>();
  if (!evaluationRows.results?.length) throw new Error("Report evaluation was not created.");
  const evaluation = rowEvaluation(evaluationRows.results[0]);
  if ((expected.inputHash && expected.inputHash !== evaluation.inputHash) || (expected.factManifestHash && expected.factManifestHash !== evaluation.factManifestHash) || (expected.evaluatorVersion && expected.evaluatorVersion !== evaluation.evaluatorVersion)) throw new Error("Report evaluation binding conflicts with the persisted evidence snapshot.");
  if (["deterministic", "rubric_unavailable", "insufficient_facts", "failed", "complete", "agent_rejected", "needs_human_review", "call_outcome_unknown"].includes(evaluation.status)) return { evaluation, replayed: true as const };
  if (evaluation.status !== "pending") throw new Error("Report evaluation is not available for deterministic profiling.");
  const documentRows = await database.prepare(`SELECT document_json FROM report_documents WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const manifestRows = await database.prepare(`SELECT manifest_hash, company_count, product_count, match_count, ad_count, status FROM report_fact_manifests WHERE run_id = ? LIMIT 1`).bind(run.id).all<Record<string, unknown>>();
  const documentJson = String(documentRows.results?.[0]?.document_json || "");
  const manifest = manifestRows.results?.[0];
  if (!documentJson || manifest?.status !== "complete") throw new Error("Report evaluation facts are incomplete.");
  const calculatedInputHash = await sha256Text(documentJson);
  if (calculatedInputHash !== evaluation.inputHash || String(manifest.manifest_hash || "") !== evaluation.factManifestHash || evaluation.evaluatorVersion !== AGENT_EVALUATOR_VERSION) throw new Error("Report evaluation binding conflicts with the persisted evidence snapshot.");
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
  const terminalDeterministic = profile.status !== "deterministic";
  const ratingBasis = profile.status === "failed" ? "none" : "deterministic_only";
  const update = database.prepare(`UPDATE report_evaluations SET status = ?, rating_basis = ?, deterministic_score = ?, deterministic_json = ?, findings_json = ?, error_code = ?, started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, deterministic_at = ?, completed_at = ? WHERE id = ? AND status = 'pending' AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND overall_score IS NULL AND user_value_score IS NULL AND evidence_integrity_score IS NULL AND evidence_yield_score IS NULL AND presentation_score IS NULL AND grade IS NULL`).bind(profile.status, ratingBasis, profile.deterministicScore, JSON.stringify(profile.deterministic), JSON.stringify(profile.findings), profile.errorCode, completedAt, completedAt, terminalDeterministic ? completedAt : "", evaluation.id, evaluation.inputHash, evaluation.factManifestHash, evaluation.evaluatorVersion);
  const signalStatements = profile.signals.map((signal) => database.prepare(`INSERT INTO report_quality_signals (id, evaluation_id, run_id, primary_domain, stage, issue_key, severity, evidence_json, observed_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_evaluations WHERE id = ? AND status = ?) ON CONFLICT(evaluation_id, issue_key) DO NOTHING`).bind(internalId(), evaluation.id, run.id, run.primaryDomain, cleanText(signal.stage, 80), cleanText(signal.issueKey, 120), signal.severity, JSON.stringify(signal.evidence), completedAt, evaluation.id, profile.status));
  await database.batch([update, ...signalStatements]);
  const persistedRows = await database.prepare(`SELECT * FROM report_evaluations WHERE id = ? LIMIT 1`).bind(evaluation.id).all<Record<string, unknown>>();
  if (!persistedRows.results?.length) throw new Error("Report evaluation was not persisted.");
  const persisted = rowEvaluation(persistedRows.results[0]);
  if (persisted.inputHash !== evaluation.inputHash || persisted.factManifestHash !== evaluation.factManifestHash || persisted.evaluatorVersion !== evaluation.evaluatorVersion) throw new Error("Report evaluation binding conflicts with the persisted evidence snapshot.");
  if (persisted.status === "pending") throw new Error("Report evaluation persistence conflicted with another profiler.");
  return { evaluation: persisted, replayed: false as const };
}

async function evaluationContext(database: D1DatabaseLike, evaluationId: string) {
  const rows = await database.prepare(`SELECT evaluations.*, runs.public_id, runs.primary_domain, runs.locale, runs.status AS run_status, runs.current_phase, runs.attempt_count, runs.created_at AS run_created_at, runs.updated_at AS run_updated_at, runs.heartbeat_at, runs.expires_at, runs.error_code AS run_error_code, runs.error_message, entitlements.plan_tier, entitlements.product_limit, documents.document_json FROM report_evaluations evaluations JOIN report_runs runs ON runs.id = evaluations.run_id LEFT JOIN report_product_entitlements entitlements ON entitlements.run_id = runs.id LEFT JOIN report_documents documents ON documents.run_id = runs.id WHERE evaluations.id = ? LIMIT 1`).bind(evaluationId).all<Record<string, unknown>>();
  const row = rows.results?.[0];
  if (!row) return null;
  const run = rowRun({ id: row.run_id, public_id: row.public_id, primary_domain: row.primary_domain, locale: row.locale, status: row.run_status, current_phase: row.current_phase, attempt_count: row.attempt_count, created_at: row.run_created_at, updated_at: row.run_updated_at, heartbeat_at: row.heartbeat_at, expires_at: row.expires_at, error_code: row.run_error_code, error_message: row.error_message, plan_tier: row.plan_tier, product_limit: row.product_limit });
  return { row, run, evaluation: rowEvaluation(row), document: parsedRecord(row.document_json) };
}

export async function beginReportEvaluationDispatch(evaluationId: string, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  await ensureSchema(database);
  const context = await evaluationContext(database, evaluationId);
  if (!context) throw new ReportEvaluationStateError("evaluation-not-found", "Report evaluation not found.", 404);
  const { evaluation } = context;
  if (evaluation.evaluatorVersion !== AGENT_EVALUATOR_VERSION || !["deterministic", "dispatch_failed"].includes(evaluation.status) || evaluation.dispatchAttempts >= 3) throw new Error("Report evaluation is not eligible for dispatch.");
  const dispatchAttempt = evaluation.dispatchAttempts + 1;
  const dispatchToken = internalId();
  const observedAt = now.toISOString();
  await database.prepare(`UPDATE report_evaluations SET status = 'dispatching', dispatch_attempts = ?, dispatch_started_at = ?, dispatch_token = ?, dispatch_failed_at = '', error_code = '' WHERE id = ? AND evaluator_version = ? AND input_hash = ? AND fact_manifest_hash = ? AND status = ? AND dispatch_attempts = ? AND reservation_id = ''`).bind(dispatchAttempt, observedAt, dispatchToken, evaluation.id, evaluation.evaluatorVersion, evaluation.inputHash, evaluation.factManifestHash, evaluation.status, evaluation.dispatchAttempts).run();
  const persisted = await evaluationContext(database, evaluation.id);
  if (!persisted || persisted.evaluation.status !== "dispatching" || persisted.evaluation.dispatchAttempts !== dispatchAttempt || persisted.evaluation.dispatchToken !== dispatchToken) throw new Error("Report evaluation dispatch was claimed by another worker.");
  return { evaluationId: evaluation.id, evaluatorVersion: evaluation.evaluatorVersion, dispatchAttempt };
}

export async function markReportEvaluationDispatchFailed(evaluationId: string, dispatchAttempt: number, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  await ensureSchema(database);
  const terminal = dispatchAttempt >= 3;
  const observedAt = now.toISOString();
  await database.prepare(`UPDATE report_evaluations SET status = ?, dispatch_failed_at = ?, completed_at = ?, error_code = ? WHERE id = ? AND evaluator_version = ? AND status = 'dispatching' AND dispatch_attempts = ? AND reservation_id = ''`).bind(terminal ? "failed" : "dispatch_failed", observedAt, terminal ? observedAt : "", terminal ? "evaluation-dispatch-exhausted" : "evaluation-dispatch-failed", evaluationId, AGENT_EVALUATOR_VERSION, dispatchAttempt).run();
  const persisted = await evaluationContext(database, evaluationId);
  if (!persisted || !["dispatch_failed", "failed"].includes(persisted.evaluation.status)) throw new Error("Report evaluation dispatch failure conflicted with current state.");
  return persisted.evaluation;
}

export async function reserveReportAgentEvaluation(evaluationId: string, input: { evaluatorVersion: string; dispatchAttempt: number; reservationOwner: string; clientRequestId: string }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  await ensureSchema(database);
  const context = await evaluationContext(database, evaluationId);
  if (!context) throw new ReportEvaluationStateError("evaluation-not-found", "Report evaluation not found.", 404);
  if (["complete", "agent_rejected", "needs_human_review", "call_outcome_unknown", "failed", "insufficient_facts", "rubric_unavailable"].includes(context.evaluation.status)) return { ok: false as const, code: "terminal" as const };
  if (context.evaluation.status === "reserved") return { ok: false as const, code: "already_reserved" as const };
  if (input.evaluatorVersion !== context.evaluation.evaluatorVersion || input.dispatchAttempt !== context.evaluation.dispatchAttempts) return { ok: false as const, code: "stale_attempt" as const };
  if (context.evaluation.status !== "dispatching" || context.evaluation.evaluatorVersion !== AGENT_EVALUATOR_VERSION) return { ok: false as const, code: "ineligible" as const };
  const [companies, products, matches] = await Promise.all([
    database.prepare(`SELECT * FROM report_companies WHERE run_id = ? ORDER BY domain`).bind(context.evaluation.runId).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_products WHERE run_id = ? ORDER BY domain, product_id`).bind(context.evaluation.runId).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_matches WHERE run_id = ? ORDER BY rival_domain, id`).bind(context.evaluation.runId).all<Record<string, unknown>>(),
  ]);
  let canonical: ReturnType<typeof agentEvaluationInput>;
  try {
    canonical = agentEvaluationInput(String(context.row.public_id || ""), context.run, context.evaluation, context.document, companies.results || [], products.results || [], matches.results || []);
  } catch {
    const observedAt = now.toISOString();
    await database.prepare(`UPDATE report_evaluations SET status = 'agent_rejected', error_code = 'input-contract-rejected', usage_status = 'not_called', completed_at = ? WHERE id = ? AND status = 'dispatching' AND dispatch_attempts = ?`).bind(observedAt, evaluationId, input.dispatchAttempt).run();
    return { ok: false as const, code: "ineligible" as const };
  }
  const reservationId = internalId();
  const observedAt = now.toISOString();
  await database.prepare(`UPDATE report_evaluations SET status = 'reserved', reservation_id = ?, reservation_owner = ?, reserved_at = ?, client_request_id = ?, usage_status = 'reserved', reserved_cost_microusd = ?, model = ?, prompt_version = ?, pricing_version = ?, started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END WHERE id = ? AND evaluator_version = ? AND input_hash = ? AND fact_manifest_hash = ? AND status = 'dispatching' AND dispatch_attempts = ? AND reservation_id = ''`).bind(reservationId, cleanText(input.reservationOwner, 120), observedAt, cleanText(input.clientRequestId, 120), AGENT_MAX_RESERVED_COST_MICROUSD, AGENT_MODEL, AGENT_PROMPT_VERSION, AGENT_PRICING_VERSION, observedAt, evaluationId, input.evaluatorVersion, context.evaluation.inputHash, context.evaluation.factManifestHash, input.dispatchAttempt).run();
  const persisted = await evaluationContext(database, evaluationId);
  if (!persisted || persisted.evaluation.status !== "reserved" || persisted.evaluation.reservationId !== reservationId) return { ok: false as const, code: "already_reserved" as const };
  return { ok: true as const, reservationId, clientRequestId: persisted.evaluation.clientRequestId, canonicalInput: canonical.serialized };
}

export async function completeReportAgentEvaluation(evaluationId: string, callback: ReportEvaluationTerminalCallback, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  await ensureSchema(database);
  const context = await evaluationContext(database, evaluationId);
  if (!context) throw new ReportEvaluationStateError("evaluation-not-found", "Report evaluation not found.", 404);
  const evaluation = context.evaluation;
  if (evaluation.status !== "reserved") throw new ReportEvaluationStateError("evaluation-terminal-or-not-reserved", "A terminal report evaluation is immutable or not reserved.", 409);
  if (callback.evaluatorVersion !== evaluation.evaluatorVersion || callback.dispatchAttempt !== evaluation.dispatchAttempts || callback.reservationId !== evaluation.reservationId || callback.reservationOwner !== evaluation.reservationOwner || callback.clientRequestId !== evaluation.clientRequestId || callback.model !== AGENT_MODEL || callback.promptVersion !== AGENT_PROMPT_VERSION || callback.pricingVersion !== AGENT_PRICING_VERSION) throw new ReportEvaluationStateError("evaluation-callback-binding-conflict", "Report evaluation callback binding conflicts with its reservation.", 409);
  const [companies, products, matches] = await Promise.all([
    database.prepare(`SELECT * FROM report_companies WHERE run_id = ? ORDER BY domain`).bind(evaluation.runId).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_products WHERE run_id = ? ORDER BY domain, product_id`).bind(evaluation.runId).all<Record<string, unknown>>(),
    database.prepare(`SELECT * FROM report_matches WHERE run_id = ? ORDER BY rival_domain, id`).bind(evaluation.runId).all<Record<string, unknown>>(),
  ]);
  const canonical = agentEvaluationInput(String(context.row.public_id || ""), context.run, evaluation, context.document, companies.results || [], products.results || [], matches.results || []);
  let status = callback.status;
  let errorCode = cleanText(callback.errorCode, 120);
  let agent: Record<string, unknown> = {};
  let findings = evaluation.findings;
  let proposals: Record<string, unknown>[] = [];
  let hybrid: ReturnType<typeof calculateHybridScores> = null;
  let usageStatus: StoredReportEvaluation["usageStatus"] = callback.usageStatus;
  let usage: ReturnType<typeof calculateAgentUsageCost> = null;
  let humanReview: null | { uncertaintyCode: string; question: string; evidenceIds: string[] } = null;
  if (callback.usageStatus === "known" && callback.usage) usage = calculateAgentUsageCost({ input_tokens: callback.usage.inputTokens, output_tokens: callback.usage.outputTokens, input_tokens_details: { cached_tokens: callback.usage.cachedInputTokens } });
  if (callback.usageStatus === "known" && !usage) usageStatus = "unknown";
  if ((status === "complete" || status === "needs_human_review") && !callback.providerResponseId) {
    status = "agent_rejected";
    errorCode = "provider-response-id-missing";
  } else if (usage && usage.costMicrousd > AGENT_MAX_RESERVED_COST_MICROUSD) {
    status = "agent_rejected";
    errorCode = "evaluation-cost-budget-exceeded";
    usageStatus = "known";
  } else if ((status === "complete" || status === "needs_human_review") && callback.agentOutput) {
    const validated = validateAgentEvaluationResult(callback.agentOutput, canonical.envelope.evidence);
    if (!validated.ok || !usage || (status === "complete" && validated.ok && validated.value.humanReview !== null) || (status === "needs_human_review" && validated.ok && validated.value.humanReview === null)) {
      status = "agent_rejected";
      errorCode = !usage ? "missing-or-invalid-usage" : "invalid-agent-result";
      usageStatus = usage ? "known" : "unknown";
    } else {
      agent = validated.value as unknown as Record<string, unknown>;
      findings = [...evaluation.findings, ...validated.value.strengths.map((item) => ({ ...item, kind: "strength" })), ...validated.value.weaknesses.map((item) => ({ ...item, kind: "weakness" }))];
      proposals = validated.value.proposals;
      hybrid = calculateHybridScores(evaluation.deterministic, validated.value);
      humanReview = validated.value.humanReview;
    }
  } else if (status === "complete" || status === "needs_human_review") {
    status = "agent_rejected";
    errorCode = "missing-agent-result";
    usageStatus = usage ? "known" : "unknown";
  }
  if (status === "complete" && !hybrid) {
    status = "agent_rejected";
    errorCode ||= "hybrid-score-unavailable";
  }
  const ratingBasis = status === "complete" ? "hybrid" : "deterministic_only";
  const observedAt = now.toISOString();
  const write = database.prepare(`UPDATE report_evaluations SET status = ?, rating_basis = ?, overall_score = ?, user_value_score = ?, evidence_integrity_score = ?, evidence_yield_score = ?, presentation_score = ?, grade = ?, agent_json = ?, findings_json = ?, proposals_json = ?, provider_response_id = ?, provider_request_id = ?, usage_status = ?, cost_microusd = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?, error_code = ?, completed_at = ? WHERE id = ? AND status = 'reserved' AND evaluator_version = ? AND input_hash = ? AND fact_manifest_hash = ? AND dispatch_attempts = ? AND reservation_id = ? AND reservation_owner = ? AND client_request_id = ?`).bind(status, ratingBasis, hybrid?.overallScore ?? null, hybrid?.userValue ?? null, hybrid?.evidenceIntegrity ?? null, hybrid?.evidenceYield ?? null, hybrid?.presentation ?? null, hybrid?.grade ?? null, JSON.stringify(agent), JSON.stringify(findings), JSON.stringify(proposals), cleanText(callback.providerResponseId, 120), cleanText(callback.providerRequestId, 120), usageStatus, usage?.costMicrousd ?? 0, usage?.inputTokens ?? 0, usage?.cachedInputTokens ?? null, usage?.outputTokens ?? 0, errorCode, observedAt, evaluationId, evaluation.evaluatorVersion, evaluation.inputHash, evaluation.factManifestHash, evaluation.dispatchAttempts, evaluation.reservationId, evaluation.reservationOwner, evaluation.clientRequestId);
  const statements = [write];
  if (status === "needs_human_review" && humanReview) {
    const requestId = internalId();
    const requestHash = await sha256Text(JSON.stringify({ evaluationId, runId: evaluation.runId, evaluatorVersion: evaluation.evaluatorVersion, inputHash: evaluation.inputHash, factManifestHash: evaluation.factManifestHash, uncertaintyCode: humanReview.uncertaintyCode, question: humanReview.question, evidenceIds: humanReview.evidenceIds }));
    statements.push(database.prepare(`INSERT INTO report_human_review_requests (id, evaluation_id, run_id, evaluator_version, input_hash, fact_manifest_hash, uncertainty_code, question, evidence_ids_json, request_hash, created_at) SELECT ?, id, run_id, evaluator_version, input_hash, fact_manifest_hash, ?, ?, ?, ?, ? FROM report_evaluations WHERE id = ? AND status = 'needs_human_review'`).bind(requestId, humanReview.uncertaintyCode, humanReview.question, JSON.stringify(humanReview.evidenceIds), requestHash, observedAt, evaluationId));
    statements.push(database.prepare(`INSERT INTO report_human_review_open (request_id, run_id, queue_seq) SELECT id, run_id, queue_seq FROM report_human_review_requests WHERE id = ? AND request_hash = ?`).bind(requestId, requestHash));
  }
  const writes = await database.batch(statements);
  if (databaseWriteChanged(writes[0]) === false) throw new ReportEvaluationStateError("evaluation-callback-state-conflict", "Report evaluation terminal callback conflicted with current state.", 409);
  const persisted = await evaluationContext(database, evaluationId);
  if (!persisted || persisted.evaluation.status === "reserved") throw new ReportEvaluationStateError("evaluation-callback-state-conflict", "Report evaluation terminal callback conflicted with current state.", 409);
  if (status === "needs_human_review") {
    const requests = await database.prepare(`SELECT * FROM report_human_review_requests WHERE evaluation_id = ? LIMIT 1`).bind(evaluationId).all<Record<string, unknown>>();
    const request = requests.results?.[0];
    const expectedHash = humanReview ? await sha256Text(JSON.stringify({ evaluationId, runId: evaluation.runId, evaluatorVersion: evaluation.evaluatorVersion, inputHash: evaluation.inputHash, factManifestHash: evaluation.factManifestHash, uncertaintyCode: humanReview.uncertaintyCode, question: humanReview.question, evidenceIds: humanReview.evidenceIds })) : "";
    if (!request || request.run_id !== evaluation.runId || request.evaluator_version !== evaluation.evaluatorVersion || request.input_hash !== evaluation.inputHash || request.fact_manifest_hash !== evaluation.factManifestHash || request.request_hash !== expectedHash) throw new ReportEvaluationStateError("human-review-request-binding-conflict", "The human-review request binding conflicted with its evaluation.", 409);
  }
  return persisted.evaluation;
}

function humanReviewRow(row: Record<string, unknown>): StoredHumanReviewRequest {
  const agent = parsedRecord(row.agent_json);
  const responseId = String(row.response_id || "");
  return {
    queueSeq: Number(row.queue_seq || 0),
    id: String(row.id || ""),
    evaluationId: String(row.evaluation_id || ""),
    runId: String(row.run_id || ""),
    publicReportId: String(row.public_id || ""),
    primaryDomain: String(row.primary_domain || ""),
    uncertaintyCode: String(row.uncertainty_code || ""),
    question: String(row.question || ""),
    evidenceIds: parsedStringArray(row.evidence_ids_json),
    strengths: Array.isArray(agent.strengths) ? agent.strengths.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [],
    weaknesses: Array.isArray(agent.weaknesses) ? agent.weaknesses.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [],
    proposals: Array.isArray(agent.proposals) ? agent.proposals.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [],
    createdAt: String(row.created_at || ""),
    response: responseId ? {
      id: responseId,
      idempotencyKey: String(row.response_idempotency_key || ""),
      resolutionCode: String(row.response_resolution_code || "unable_to_determine") as HumanReviewResolutionCode,
      answerText: String(row.response_answer_text || ""),
      respondedAt: String(row.responded_at || ""),
    } : null,
  };
}

function parsedStringArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export async function listHumanReviewRequests(options: { limit?: number; afterQueueSeq?: number; now?: Date } = {}, databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  await ensureSchema(database);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid human-review queue options.");
  const afterQueueSeq = options.afterQueueSeq ?? 0;
  const now = options.now || new Date();
  if (!Number.isSafeInteger(afterQueueSeq) || afterQueueSeq < 0 || !Number.isFinite(now.getTime())) throw new Error("Invalid human-review queue cursor.");
  const rows = await database.prepare(`SELECT requests.*, evaluations.agent_json, runs.public_id, runs.primary_domain, NULL AS response_id FROM report_human_review_open open JOIN report_human_review_requests requests ON requests.id = open.request_id JOIN report_evaluations evaluations ON evaluations.id = requests.evaluation_id JOIN report_runs runs ON runs.id = requests.run_id WHERE evaluations.status = 'needs_human_review' AND runs.expires_at > ? AND open.queue_seq > ? ORDER BY open.queue_seq LIMIT ?`).bind(now.toISOString(), afterQueueSeq, limit).all<Record<string, unknown>>();
  const items = (rows.results || []).map((row) => {
    const mapped = humanReviewRow(row);
    mapped.evidenceIds = parsedStringArray(row.evidence_ids_json);
    return mapped;
  });
  return { items, hasMore: items.length === limit, nextCursor: items.length === limit ? { queueSeq: items.at(-1)!.queueSeq } : null };
}

export async function submitHumanReviewResponse(requestId: string, input: { idempotencyKey: string; resolutionCode: HumanReviewResolutionCode; answerText: string }, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(requestId) || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(input.idempotencyKey) || !["answered", "unable_to_determine", "invalid_question"].includes(input.resolutionCode)) throw new Error("Invalid human-review response.");
  const answerText = input.answerText;
  if (typeof answerText !== "string" || answerText.length > 1_000 || new TextEncoder().encode(answerText).byteLength > 4_000 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]|https?:\/\/|www\.|\[[^\]]*\]\(/iu.test(answerText) || (input.resolutionCode === "answered" ? !answerText.trim() : answerText !== "")) throw new Error("Human-review response answer is invalid.");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid human-review response time.");
  await ensureSchema(database);
  const requestRows = await database.prepare(`SELECT requests.*, evaluations.status AS evaluation_status, runs.expires_at FROM report_human_review_requests requests JOIN report_evaluations evaluations ON evaluations.id = requests.evaluation_id JOIN report_runs runs ON runs.id = requests.run_id WHERE requests.id = ? LIMIT 1`).bind(requestId).all<Record<string, unknown>>();
  const request = requestRows.results?.[0];
  if (!request) throw new ReportEvaluationStateError("human-review-request-not-found", "Human-review request not found.", 404);
  if (Date.parse(String(request.expires_at || "")) <= now.getTime()) throw new ReportEvaluationStateError("human-review-request-expired", "Human-review request expired with its report.", 410);
  if (request.evaluation_status !== "needs_human_review") throw new ReportEvaluationStateError("human-review-request-ineligible", "Human-review request is no longer eligible.", 409);
  const reviewerKey = "product-owner-v1";
  const responseHash = await sha256Text(JSON.stringify({ requestId, idempotencyKey: input.idempotencyKey, resolutionCode: input.resolutionCode, answerText, reviewerKey }));
  const existingRows = await database.prepare(`SELECT * FROM report_human_review_responses WHERE request_id = ? OR idempotency_key = ? ORDER BY request_id = ? DESC LIMIT 1`).bind(requestId, input.idempotencyKey, requestId).all<Record<string, unknown>>();
  const existing = existingRows.results?.[0];
  if (existing) {
    const exact = existing.request_id === requestId && existing.idempotency_key === input.idempotencyKey && existing.response_hash === responseHash;
    if (!exact) throw new ReportEvaluationStateError("human-review-response-conflict", "A different immutable human-review response already exists.", 409);
    return { replayed: true as const, response: { id: String(existing.id), requestId, idempotencyKey: String(existing.idempotency_key), resolutionCode: existing.resolution_code as HumanReviewResolutionCode, answerText: String(existing.answer_text), respondedAt: String(existing.responded_at || "") } };
  }
  const id = internalId();
  const respondedAt = now.toISOString();
  await database.batch([
    database.prepare(`INSERT INTO report_human_review_responses (id, request_id, evaluation_id, run_id, idempotency_key, resolution_code, answer_text, response_hash, reviewer_key, responded_at) SELECT ?, requests.id, requests.evaluation_id, requests.run_id, ?, ?, ?, ?, ?, ? FROM report_human_review_requests requests JOIN report_human_review_open open ON open.request_id = requests.id JOIN report_evaluations evaluations ON evaluations.id = requests.evaluation_id JOIN report_runs runs ON runs.id = requests.run_id WHERE requests.id = ? AND evaluations.status = 'needs_human_review' AND runs.expires_at > ? ON CONFLICT DO NOTHING`).bind(id, input.idempotencyKey, input.resolutionCode, answerText, responseHash, reviewerKey, respondedAt, requestId, respondedAt),
    database.prepare(`DELETE FROM report_human_review_open WHERE request_id = ? AND EXISTS (SELECT 1 FROM report_human_review_responses WHERE request_id = ? AND idempotency_key = ? AND response_hash = ?)`).bind(requestId, requestId, input.idempotencyKey, responseHash),
  ]);
  const persistedRows = await database.prepare(`SELECT * FROM report_human_review_responses WHERE request_id = ? OR idempotency_key = ? ORDER BY request_id = ? DESC LIMIT 1`).bind(requestId, input.idempotencyKey, requestId).all<Record<string, unknown>>();
  const persisted = persistedRows.results?.[0];
  if (!persisted || persisted.request_id !== requestId || persisted.idempotency_key !== input.idempotencyKey || persisted.response_hash !== responseHash) throw new ReportEvaluationStateError("human-review-response-conflict", "A different immutable human-review response already exists.", 409);
  return { replayed: String(persisted.id) !== id, response: { id: String(persisted.id), requestId, idempotencyKey: String(persisted.idempotency_key), resolutionCode: persisted.resolution_code as HumanReviewResolutionCode, answerText: String(persisted.answer_text), respondedAt: String(persisted.responded_at || respondedAt) } };
}

export async function reconcileReportEvaluations(now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) throw new Error("Persistent report storage is unavailable.");
  await ensureSchema(database);
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000).toISOString();
  const observedAt = now.toISOString();
  await database.batch([
    database.prepare(`UPDATE report_evaluations SET status = 'dispatch_failed', dispatch_failed_at = ?, error_code = 'evaluation-dispatch-stale' WHERE status = 'dispatching' AND dispatch_started_at != '' AND dispatch_started_at <= ? AND reservation_id = '' AND dispatch_attempts < 3`).bind(observedAt, fiveMinutesAgo),
    database.prepare(`UPDATE report_evaluations SET status = 'failed', dispatch_failed_at = ?, completed_at = ?, error_code = 'evaluation-dispatch-exhausted' WHERE status = 'dispatching' AND dispatch_started_at != '' AND dispatch_started_at <= ? AND reservation_id = '' AND dispatch_attempts >= 3`).bind(observedAt, observedAt, fiveMinutesAgo),
    database.prepare(`UPDATE report_evaluations SET status = 'call_outcome_unknown', watchdog_expired_at = ?, completed_at = ?, usage_status = 'unknown', error_code = 'evaluation-reservation-expired' WHERE status = 'reserved' AND reserved_at != '' AND reserved_at <= ?`).bind(observedAt, observedAt, tenMinutesAgo),
  ]);
  const pendingRows = await database.prepare(`SELECT evaluations.id, runs.public_id FROM report_evaluations evaluations JOIN report_runs runs ON runs.id = evaluations.run_id WHERE evaluations.status = 'pending' AND evaluations.evaluator_version = ? AND evaluations.created_at <= ? ORDER BY evaluations.created_at LIMIT 25`).bind(AGENT_EVALUATOR_VERSION, fiveMinutesAgo).all<Record<string, unknown>>();
  for (const row of pendingRows.results || []) {
    try { await evaluateStoredReport(String(row.public_id || ""), { evaluatorVersion: AGENT_EVALUATOR_VERSION }, now, database); } catch { /* deterministic profiler persists its own terminal failure when possible */ }
  }
  const candidates = await database.prepare(`SELECT id FROM report_evaluations WHERE evaluator_version = ? AND status IN ('deterministic', 'dispatch_failed') AND dispatch_attempts < 3 ORDER BY deterministic_at, created_at LIMIT 25`).bind(AGENT_EVALUATOR_VERSION).all<Record<string, unknown>>();
  return { candidates: (candidates.results || []).map((row) => String(row.id || "")).filter(Boolean) };
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
  const primaryProducts: StoredPrimaryProducts = { authoritative: false, totalCount: 0, products: [], truncated: false };
  if (factManifest?.status === "complete") {
    const [countResult, productResult] = await Promise.all([
      database.prepare(`SELECT COUNT(*) AS count FROM report_products WHERE run_id = ? AND domain = ?`).bind(run.id, run.primaryDomain).all<Record<string, unknown>>(),
      database.prepare(`SELECT product_id, domain, name, normalized_name, source_url, image_url, price_json, metadata_json, observed_at FROM report_products WHERE run_id = ? AND domain = ? ORDER BY product_id LIMIT 200`).bind(run.id, run.primaryDomain).all<Record<string, unknown>>(),
    ]);
    primaryProducts.authoritative = true;
    primaryProducts.totalCount = Number(countResult.results?.[0]?.count || 0);
    primaryProducts.products = (productResult.results || []).map((row) => {
      let prices: unknown = [];
      let metadata: Record<string, unknown> = {};
      try { prices = JSON.parse(String(row.price_json || "[]")); } catch { prices = []; }
      try { metadata = JSON.parse(String(row.metadata_json || "{}")); } catch { metadata = {}; }
      return {
        id: String(row.product_id || ""),
        domain: String(row.domain || ""),
        name: String(row.name || ""),
        normalizedName: String(row.normalized_name || ""),
        sourceUrl: String(row.source_url || ""),
        imageUrl: String(row.image_url || ""),
        priceSignals: Array.isArray(prices) ? prices : [],
        category: String(metadata.category || ""),
        jsonLdType: String(metadata.jsonLdType || ""),
        ownership: String(metadata.ownership || ""),
        extraction: String(metadata.extraction || ""),
        confidence: String(metadata.confidence || ""),
        identifiers: metadata.identifiers && typeof metadata.identifiers === "object" && !Array.isArray(metadata.identifiers) ? metadata.identifiers : {},
        quantity: metadata.quantity && typeof metadata.quantity === "object" && !Array.isArray(metadata.quantity) ? metadata.quantity : {},
        observedAt: String(row.observed_at || ""),
      };
    });
    primaryProducts.truncated = primaryProducts.totalCount > primaryProducts.products.length;
  }
  return { run, events, document, documentSchemaVersion: Number(documentRow?.schema_version || 0), documentObservedAt: String(documentRow?.observed_at || ""), factManifest, primaryProducts };
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
  humanReviewRequests: number;
  humanReviewResponses: number;
  humanReviewOpen: number;
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
  const eligibleRuns = `SELECT id FROM report_runs WHERE expires_at <= ? AND heartbeat_at <= ? ORDER BY expires_at ASC LIMIT ${REPORT_PURGE_BATCH_SIZE}`;
  const eligible = () => [cutoff, heartbeatGuard] as const;
  const countFor = (table: string) => `(SELECT COUNT(*) FROM ${table} WHERE run_id IN (${eligibleRuns}))`;
  const runCount = `(SELECT COUNT(*) FROM report_runs WHERE id IN (${eligibleRuns}))`;
  const audit = database.prepare(`INSERT INTO report_purge_audits (id, cutoff, heartbeat_guard, runs_deleted, quality_signals_deleted, human_review_requests_deleted, human_review_responses_deleted, human_review_open_deleted, evaluations_deleted, ads_deleted, matches_deleted, products_deleted, companies_deleted, fact_chunks_deleted, fact_manifests_deleted, documents_deleted, events_deleted, observed_at) SELECT ?, ?, ?, ${runCount}, ${countFor("report_quality_signals")}, ${countFor("report_human_review_requests")}, ${countFor("report_human_review_responses")}, ${countFor("report_human_review_open")}, ${countFor("report_evaluations")}, ${countFor("report_ads")}, ${countFor("report_matches")}, ${countFor("report_products")}, ${countFor("report_companies")}, ${countFor("report_fact_chunks")}, ${countFor("report_fact_manifests")}, ${countFor("report_documents")}, ${countFor("report_events")}, ? WHERE EXISTS (${eligibleRuns})`).bind(
    auditId,
    cutoff,
    heartbeatGuard,
    ...eligible(),
    ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(),
    ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(), ...eligible(),
    cutoff,
    ...eligible(),
  );
  const guardedDelete = (table: string) => database.prepare(`DELETE FROM ${table} WHERE run_id IN (${eligibleRuns})`).bind(...eligible());
  const statements = [
    audit,
    guardedDelete("report_quality_signals"),
    guardedDelete("report_human_review_responses"),
    guardedDelete("report_human_review_open"),
    guardedDelete("report_human_review_requests"),
    guardedDelete("report_evaluations"),
    guardedDelete("report_ads"),
    guardedDelete("report_matches"),
    guardedDelete("report_products"),
    guardedDelete("report_companies"),
    guardedDelete("report_fact_chunks"),
    guardedDelete("report_fact_manifests"),
    guardedDelete("report_match_batch_checkpoints"),
    guardedDelete("report_product_entitlements"),
    guardedDelete("report_documents"),
    guardedDelete("report_events"),
    database.prepare(`DELETE FROM report_runs WHERE id IN (${eligibleRuns})`).bind(...eligible()),
    database.prepare(`DELETE FROM report_purge_audits WHERE observed_at < ?`).bind(auditCutoff),
    database.prepare(`SELECT * FROM report_purge_audits WHERE id = ? LIMIT 1`).bind(auditId),
    database.prepare(`SELECT COUNT(*) AS count FROM report_runs WHERE expires_at <= ? AND heartbeat_at <= ?`).bind(cutoff, heartbeatGuard),
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
      humanReviewRequests: numberField(auditRow, "human_review_requests_deleted"),
      humanReviewResponses: numberField(auditRow, "human_review_responses_deleted"),
      humanReviewOpen: numberField(auditRow, "human_review_open_deleted"),
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
