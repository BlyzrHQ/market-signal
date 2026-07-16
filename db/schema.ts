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
