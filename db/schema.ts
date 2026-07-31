import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const verifiedCompetitors = sqliteTable("verified_competitors", {
  primaryDomain: text("primary_domain").notNull(),
  competitorDomain: text("competitor_domain").notNull(),
  candidateJson: text("candidate_json").notNull(),
  firstVerifiedAt: text("first_verified_at").notNull(),
  lastVerifiedAt: text("last_verified_at").notNull(),
  lastVerificationScore: integer("last_verification_score").notNull(),
  category: text("category").notNull().default(""),
  evidenceUrl: text("evidence_url").notNull().default(""),
}, (table) => [
  primaryKey({ columns: [table.primaryDomain, table.competitorDomain] }),
  index("verified_competitors_primary_recent_idx").on(table.primaryDomain, table.lastVerifiedAt),
]);

export const reportRuns = sqliteTable("report_runs", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull(),
  primaryDomain: text("primary_domain").notNull(),
  locale: text("locale").notNull().default("en"),
  status: text("status").notNull(),
  currentPhase: text("current_phase").notNull(),
  attemptCount: integer("attempt_count").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  errorCode: text("error_code").notNull().default(""),
  errorMessage: text("error_message").notNull().default(""),
}, (table) => [
  uniqueIndex("report_runs_public_id_uidx").on(table.publicId),
  index("report_runs_domain_recent_idx").on(table.primaryDomain, table.createdAt),
  index("report_runs_expiry_idx").on(table.expiresAt),
]);

export const reportEvents = sqliteTable("report_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  sequence: integer("sequence").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  phase: text("phase").notNull(),
  status: text("status").notNull(),
  message: text("message").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  uniqueIndex("report_events_run_sequence_uidx").on(table.runId, table.sequence),
  uniqueIndex("report_events_run_idempotency_uidx").on(table.runId, table.idempotencyKey),
  index("report_events_run_order_idx").on(table.runId, table.sequence),
]);

export const reportDocuments = sqliteTable("report_documents", {
  runId: text("run_id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  documentJson: text("document_json").notNull(),
  observedAt: text("observed_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const reportCompanies = sqliteTable("report_companies", {
  runId: text("run_id").notNull(),
  domain: text("domain").notNull(),
  role: text("role").notNull(),
  companyName: text("company_name").notNull().default(""),
  evidenceUrl: text("evidence_url").notNull().default(""),
  evidenceJson: text("evidence_json").notNull().default("{}"),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.domain] }),
  index("report_companies_run_role_idx").on(table.runId, table.role),
]);

export const reportProducts = sqliteTable("report_products", {
  runId: text("run_id").notNull(),
  domain: text("domain").notNull(),
  productId: text("product_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().default(""),
  sourceUrl: text("source_url").notNull(),
  imageUrl: text("image_url").notNull().default(""),
  priceJson: text("price_json").notNull().default("[]"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.domain, table.productId] }),
  index("report_products_run_domain_idx").on(table.runId, table.domain),
]);

export const reportMatches = sqliteTable("report_matches", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  primaryProductId: text("primary_product_id").notNull(),
  rivalProductId: text("rival_product_id").notNull(),
  rivalDomain: text("rival_domain").notNull(),
  verdict: text("verdict").notNull(),
  confidence: text("confidence").notNull(),
  claimType: text("claim_type").notNull(),
  model: text("model").notNull().default(""),
  promptVersion: text("prompt_version").notNull().default(""),
  evidenceJson: text("evidence_json").notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  index("report_matches_run_rival_idx").on(table.runId, table.rivalDomain),
]);

export const reportAds = sqliteTable("report_ads", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  domain: text("domain").notNull(),
  platform: text("platform").notNull(),
  status: text("status").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  index("report_ads_run_domain_idx").on(table.runId, table.domain),
]);

export const reportFactChunks = sqliteTable("report_fact_chunks", {
  runId: text("run_id").notNull(),
  manifestId: text("manifest_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  kind: text("kind").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  itemCount: integer("item_count").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.manifestId, table.kind, table.chunkIndex] }),
  index("report_fact_chunks_run_manifest_idx").on(table.runId, table.manifestId),
]);

export const reportFactManifests = sqliteTable("report_fact_manifests", {
  runId: text("run_id").primaryKey(),
  manifestId: text("manifest_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  companyCount: integer("company_count").notNull(),
  productCount: integer("product_count").notNull(),
  matchCount: integer("match_count").notNull(),
  adCount: integer("ad_count").notNull(),
  status: text("status").notNull(),
  lockOwner: text("lock_owner").notNull(),
  lockedAt: text("locked_at").notNull(),
  completedAt: text("completed_at").notNull(),
});

export const reportEvaluations = sqliteTable("report_evaluations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  evaluationType: text("evaluation_type").notNull(),
  inputHash: text("input_hash").notNull(),
  factManifestHash: text("fact_manifest_hash").notNull().default(""),
  evaluatorVersion: text("evaluator_version").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  status: text("status").notNull(),
  ratingBasis: text("rating_basis").notNull(),
  overallScore: integer("overall_score"),
  userValueScore: integer("user_value_score"),
  evidenceIntegrityScore: integer("evidence_integrity_score"),
  evidenceYieldScore: integer("evidence_yield_score"),
  presentationScore: integer("presentation_score"),
  deterministicScore: integer("deterministic_score"),
  grade: text("grade"),
  deterministicJson: text("deterministic_json").notNull().default("{}"),
  agentJson: text("agent_json").notNull().default("{}"),
  findingsJson: text("findings_json").notNull().default("[]"),
  proposalsJson: text("proposals_json").notNull().default("[]"),
  model: text("model").notNull().default(""),
  promptVersion: text("prompt_version").notNull().default(""),
  pricingVersion: text("pricing_version").notNull().default(""),
  costMicrousd: integer("cost_microusd").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  errorCode: text("error_code").notNull().default(""),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at").notNull().default(""),
  completedAt: text("completed_at").notNull().default(""),
}, (table) => [
  uniqueIndex("report_evaluations_identity_uidx").on(table.runId, table.inputHash, table.evaluatorVersion, table.evaluationType),
  index("report_evaluations_run_completed_idx").on(table.runId, table.completedAt),
  index("report_evaluations_score_completed_idx").on(table.overallScore, table.completedAt),
  index("report_evaluations_status_completed_idx").on(table.status, table.completedAt),
]);

export const reportQualitySignals = sqliteTable("report_quality_signals", {
  id: text("id").primaryKey(),
  evaluationId: text("evaluation_id").notNull(),
  runId: text("run_id").notNull(),
  primaryDomain: text("primary_domain").notNull(),
  stage: text("stage").notNull(),
  issueKey: text("issue_key").notNull(),
  severity: text("severity").notNull(),
  evidenceJson: text("evidence_json").notNull().default("{}"),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  uniqueIndex("report_quality_signals_evaluation_issue_uidx").on(table.evaluationId, table.issueKey),
  index("report_quality_signals_issue_observed_idx").on(table.issueKey, table.observedAt),
  index("report_quality_signals_stage_severity_observed_idx").on(table.stage, table.severity, table.observedAt),
]);
