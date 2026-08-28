import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const accountUsers = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const accountSessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: text("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => accountUsers.id, { onDelete: "cascade" }),
}, (table) => [
  index("session_userId_idx").on(table.userId),
]);

export const accountProviders = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  issuer: text("issuer").notNull(),
  userId: text("userId").notNull().references(() => accountUsers.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
}, (table) => [
  index("account_userId_idx").on(table.userId),
  uniqueIndex("account_issuer_accountId_uidx").on(table.issuer, table.accountId),
]);

export const accountVerifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
}, (table) => [
  index("verification_identifier_idx").on(table.identifier),
]);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  kind: text("kind").notNull().default("personal"),
  personalOwnerUserId: text("personal_owner_user_id").unique().references(() => accountUsers.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaceMembers = sqliteTable("workspace_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => accountUsers.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("owner"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index("workspace_members_user_idx").on(table.userId),
]);

export const workspaceSubscriptions = sqliteTable("workspace_subscriptions", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().default(""),
  stripePriceId: text("stripe_price_id").notNull().default(""),
  planTier: text("plan_tier").notNull().default(""),
  status: text("status").notNull().default("incomplete"),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  currentPeriodStart: text("current_period_start").notNull().default(""),
  currentPeriodEnd: text("current_period_end").notNull().default(""),
  lastEventCreated: integer("last_event_created").notNull().default(0),
  lastEventId: text("last_event_id").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("workspace_subscriptions_subscription_uidx").on(table.stripeSubscriptionId).where(sql`${table.stripeSubscriptionId} != ''`),
]);

export const stripeWebhookEvents = sqliteTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  eventCreated: integer("event_created").notNull(),
  processedAt: text("processed_at").notNull(),
});

export const billingReportReservations = sqliteTable("billing_report_reservations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  status: text("status").notNull(),
  runId: text("run_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("billing_report_reservations_run_uidx").on(table.runId).where(sql`${table.runId} != ''`),
  index("billing_report_reservations_usage_idx").on(table.workspaceId, table.periodStart, table.periodEnd, table.status),
]);

export const priceWatchEntitlements = sqliteTable("price_watch_entitlements", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  planTier: text("plan_tier").notNull(),
  allocation: integer("allocation").notNull(),
  purgedUsed: integer("purged_used").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.periodStart, table.periodEnd] }),
  index("price_watch_entitlements_period_idx").on(table.periodStart, table.periodEnd),
  check("price_watch_entitlements_allocation_check", sql`${table.allocation} >= 0`),
  check("price_watch_entitlements_purged_used_check", sql`${table.purgedUsed} >= 0`),
]);

export const priceWatchers = sqliteTable("price_watchers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  canonicalUrl: text("canonical_url").notNull(),
  resolvedUrl: text("resolved_url").notNull().default(""),
  canonicalizationVersion: integer("canonicalization_version").notNull(),
  sourceDomain: text("source_domain").notNull(),
  rivalDomain: text("rival_domain").notNull(),
  productName: text("product_name").notNull(),
  variantKey: text("variant_key").notNull(),
  variantJson: text("variant_json").notNull(),
  auditTarget: text("audit_target").notNull().unique(),
  creatorUserId: text("creator_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  emailOwnerUserId: text("email_owner_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  cadence: text("cadence").notNull(),
  state: text("state").notNull(),
  pauseReason: text("pause_reason").notNull().default(""),
  baselineCurrency: text("baseline_currency").notNull().default(""),
  baselineAmountMicros: integer("baseline_amount_micros"),
  baselineRaw: text("baseline_raw").notNull().default(""),
  baselineListAmountMicros: integer("baseline_list_amount_micros"),
  baselineListRaw: text("baseline_list_raw").notNull().default(""),
  baselineObservedAt: text("baseline_observed_at").notNull().default(""),
  failureStreak: integer("failure_streak").notNull().default(0),
  nextCheckAt: text("next_check_at").notNull().default(""),
  lastCheckAt: text("last_check_at").notNull().default(""),
  claimOwner: text("claim_owner").notNull().default(""),
  claimExpiresAt: text("claim_expires_at").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("price_watchers_target_uidx").on(table.workspaceId, table.canonicalUrl, table.variantKey),
  index("price_watchers_due_idx").on(table.state, table.nextCheckAt),
  index("price_watchers_workspace_idx").on(table.workspaceId, table.createdAt),
  check("price_watchers_cadence_check", sql`${table.cadence} in ('hourly', 'daily')`),
  check("price_watchers_state_check", sql`${table.state} in ('baseline_pending', 'active', 'disabled', 'paused_credits', 'paused_subscription', 'paused_failure')`),
  check("price_watchers_failure_streak_check", sql`${table.failureStreak} >= 0`),
]);

export const priceWatchCreditReservations = sqliteTable("price_watch_credit_reservations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  watcherId: text("watcher_id").notNull().references(() => priceWatchers.id, { onDelete: "cascade" }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  dueSlot: text("due_slot").notNull(),
  status: text("status").notNull(),
  claimOwner: text("claim_owner").notNull().default(""),
  leaseExpiresAt: text("lease_expires_at").notNull().default(""),
  externalAttemptAt: text("external_attempt_at").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("price_watch_credit_reservations_due_uidx").on(table.watcherId, table.dueSlot),
  index("price_watch_credit_reservations_usage_idx").on(table.workspaceId, table.periodStart, table.periodEnd, table.status),
  index("price_watch_credit_reservations_lease_idx").on(table.status, table.leaseExpiresAt),
  check("price_watch_credit_reservations_status_check", sql`${table.status} in ('reserved', 'attempting', 'committed', 'released')`),
]);

export const priceWatchObservations = sqliteTable("price_watch_observations", {
  id: text("id").primaryKey(),
  watcherId: text("watcher_id").notNull().references(() => priceWatchers.id, { onDelete: "cascade" }),
  reservationId: text("reservation_id").notNull().references(() => priceWatchCreditReservations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  currency: text("currency").notNull(),
  amountMicros: integer("amount_micros").notNull(),
  rawPrice: text("raw_price").notNull(),
  listAmountMicros: integer("list_amount_micros"),
  rawListPrice: text("raw_list_price").notNull().default(""),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  uniqueIndex("price_watch_observations_reservation_uidx").on(table.reservationId),
  index("price_watch_observations_history_idx").on(table.watcherId, table.observedAt),
  check("price_watch_observations_amount_check", sql`${table.amountMicros} > 0`),
]);

export const priceWatchEvents = sqliteTable("price_watch_events", {
  id: text("id").primaryKey(),
  watcherId: text("watcher_id").notNull().references(() => priceWatchers.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  detailJson: text("detail_json").notNull().default("{}"),
  idempotencyKey: text("idempotency_key").notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  uniqueIndex("price_watch_events_idempotency_uidx").on(table.watcherId, table.idempotencyKey),
  index("price_watch_events_history_idx").on(table.watcherId, table.observedAt),
]);

export const workspaceNotifications = sqliteTable("workspace_notifications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  watcherId: text("watcher_id").references(() => priceWatchers.id, { onDelete: "cascade" }),
  notificationType: text("notification_type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("workspace_notifications_dedupe_uidx").on(table.workspaceId, table.dedupeKey),
  index("workspace_notifications_recent_idx").on(table.workspaceId, table.createdAt),
]);

export const workspaceNotificationReads = sqliteTable("workspace_notification_reads", {
  notificationId: text("notification_id").notNull().references(() => workspaceNotifications.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => accountUsers.id, { onDelete: "cascade" }),
  readAt: text("read_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.notificationId, table.userId] }),
  index("workspace_notification_reads_user_idx").on(table.userId, table.readAt),
]);

export const priceWatchEmailOutbox = sqliteTable("price_watch_email_outbox", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  watcherId: text("watcher_id").notNull().references(() => priceWatchers.id, { onDelete: "cascade" }),
  recipientUserId: text("recipient_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  eventId: text("event_id").notNull().references(() => priceWatchEvents.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  batchAfter: text("batch_after").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code").notNull().default(""),
  deliveredAt: text("delivered_at").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("price_watch_email_outbox_event_uidx").on(table.eventId),
  index("price_watch_email_outbox_due_idx").on(table.status, table.batchAfter),
  check("price_watch_email_outbox_status_check", sql`${table.status} in ('pending', 'sending', 'delivered')`),
  check("price_watch_email_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
]);

export const priceWatchAuditLog = sqliteTable("price_watch_audit_log", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetTombstone: text("target_tombstone").notNull(),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("price_watch_audit_log_workspace_idx").on(table.workspaceId, table.createdAt),
]);

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
  workspaceId: text("workspace_id").notNull().default(""),
  billingReservationId: text("billing_reservation_id").notNull().default(""),
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

export const reportProductEntitlements = sqliteTable("report_product_entitlements", {
  runId: text("run_id").primaryKey(),
  planTier: text("plan_tier").notNull(),
  productLimit: integer("product_limit").notNull(),
  targetKind: text("target_kind").notNull().default("primary-products"),
  resolvedAt: text("resolved_at").notNull(),
});

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

export const reportShareLinks = sqliteTable("report_share_links", {
  runId: text("run_id").primaryKey().references(() => reportRuns.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  rotation: integer("rotation").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  revokedAt: text("revoked_at").notNull().default(""),
}, (table) => [
  uniqueIndex("report_share_links_token_uidx").on(table.token),
  index("report_share_links_active_idx").on(table.active, table.updatedAt),
  check("report_share_links_token_check", sql`length(${table.token}) = 64 AND ${table.token} NOT GLOB '*[^0-9a-f]*'`),
  check("report_share_links_active_check", sql`${table.active} IN (0, 1)`),
  check("report_share_links_rotation_check", sql`${table.rotation} >= 1`),
]);

export const reportShareAudits = sqliteTable("report_share_audits", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  action: text("action").notNull(),
  rotation: integer("rotation").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("report_share_audits_run_idx").on(table.runId, table.createdAt),
  index("report_share_audits_workspace_idx").on(table.workspaceId, table.createdAt),
  check("report_share_audits_action_check", sql`${table.action} IN ('share', 'unshare')`),
  check("report_share_audits_rotation_check", sql`${table.rotation} >= 1`),
]);

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

export const priceWatcherReportLinks = sqliteTable("price_watcher_report_links", {
  watcherId: text("watcher_id").notNull().references(() => priceWatchers.id, { onDelete: "cascade" }),
  reportRunId: text("report_run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  matchId: text("match_id").notNull().references(() => reportMatches.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.watcherId, table.reportRunId, table.matchId] }),
  index("price_watcher_report_links_report_idx").on(table.reportRunId, table.matchId),
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

export const reportMatchBatchCheckpoints = sqliteTable("report_match_batch_checkpoints", {
  runId: text("run_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  batchIndex: integer("batch_index").notNull(),
  inputHash: text("input_hash").notNull(),
  resultJson: text("result_json").notNull(),
  resultHash: text("result_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.attemptNumber, table.batchIndex] }),
  index("report_match_batch_checkpoints_run_attempt_idx").on(table.runId, table.attemptNumber, table.batchIndex),
]);

export const reportMatchLeases = sqliteTable("report_match_leases", {
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  owner: text("owner").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.attemptNumber] }),
  check("report_match_leases_owner_check", sql`length(${table.owner}) = 32 AND ${table.owner} NOT GLOB '*[^0-9a-f]*'`),
  index("report_match_leases_expiry_idx").on(table.expiresAt),
]);

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
  costMicrousd: integer("cost_microusd"),
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cacheWriteInputTokens: integer("cache_write_input_tokens"),
  outputTokens: integer("output_tokens"),
  usageStatus: text("usage_status").notNull().default("not_called"),
  reservedCostMicrousd: integer("reserved_cost_microusd").notNull().default(0),
  errorCode: text("error_code").notNull().default(""),
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  deterministicAt: text("deterministic_at").notNull().default(""),
  dispatchStartedAt: text("dispatch_started_at").notNull().default(""),
  dispatchToken: text("dispatch_token").notNull().default(""),
  dispatchFailedAt: text("dispatch_failed_at").notNull().default(""),
  watchdogExpiredAt: text("watchdog_expired_at").notNull().default(""),
  reservationId: text("reservation_id").notNull().default(""),
  reservationOwner: text("reservation_owner").notNull().default(""),
  reservedAt: text("reserved_at").notNull().default(""),
  clientRequestId: text("client_request_id").notNull().default(""),
  providerResponseId: text("provider_response_id").notNull().default(""),
  providerRequestId: text("provider_request_id").notNull().default(""),
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

export const reportHumanReviewRequests = sqliteTable("report_human_review_requests", {
  queueSeq: integer("queue_seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  evaluationId: text("evaluation_id").notNull().references(() => reportEvaluations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  evaluatorVersion: text("evaluator_version").notNull(),
  inputHash: text("input_hash").notNull(),
  factManifestHash: text("fact_manifest_hash").notNull(),
  uncertaintyCode: text("uncertainty_code").notNull(),
  question: text("question").notNull(),
  evidenceIdsJson: text("evidence_ids_json").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("report_human_review_requests_id_uidx").on(table.id),
  uniqueIndex("report_human_review_requests_evaluation_uidx").on(table.evaluationId),
]);

export const reportHumanReviewResponses = sqliteTable("report_human_review_responses", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => reportHumanReviewRequests.id, { onDelete: "cascade" }),
  evaluationId: text("evaluation_id").notNull().references(() => reportEvaluations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  resolutionCode: text("resolution_code").notNull(),
  answerText: text("answer_text").notNull().default(""),
  responseHash: text("response_hash").notNull(),
  reviewerKey: text("reviewer_key").notNull(),
  respondedAt: text("responded_at").notNull(),
}, (table) => [
  uniqueIndex("report_human_review_responses_request_uidx").on(table.requestId),
  uniqueIndex("report_human_review_responses_idempotency_uidx").on(table.idempotencyKey),
]);

export const reportHumanReviewOpen = sqliteTable("report_human_review_open", {
  requestId: text("request_id").primaryKey().references(() => reportHumanReviewRequests.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  queueSeq: integer("queue_seq").notNull(),
}, (table) => [
  uniqueIndex("report_human_review_open_queue_uidx").on(table.queueSeq),
]);

export const reportEvaluationFeedbackOutbox = sqliteTable("report_evaluation_feedback_outbox", {
  queueSeq: integer("queue_seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  evaluationId: text("evaluation_id").notNull().references(() => reportEvaluations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  eventKind: text("event_kind").notNull().default("terminal_report_evaluation"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("report_evaluation_feedback_outbox_id_uidx").on(table.id),
  uniqueIndex("report_evaluation_feedback_outbox_evaluation_uidx").on(table.evaluationId),
]);

export const reportEvaluationFeedbackPending = sqliteTable("report_evaluation_feedback_pending", {
  outboxId: text("outbox_id").primaryKey().references(() => reportEvaluationFeedbackOutbox.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  queueSeq: integer("queue_seq").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("report_evaluation_feedback_pending_queue_uidx").on(table.queueSeq),
]);

export const reportRuntimeSchemaMarkers = sqliteTable("report_runtime_schema_markers", {
  key: text("key").primaryKey(),
  completedAt: text("completed_at").notNull(),
});

export const reportEvaluationFeedbackClaims = sqliteTable("report_evaluation_feedback_claims", {
  outboxId: text("outbox_id").primaryKey().references(() => reportEvaluationFeedbackOutbox.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  consumerKey: text("consumer_key").notNull(),
  leaseIdHash: text("lease_id_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  leasedUntil: text("leased_until").notNull(),
  claimedAt: text("claimed_at").notNull(),
});

export const reportEvaluationFeedbackReceipts = sqliteTable("report_evaluation_feedback_receipts", {
  id: text("id").primaryKey(),
  outboxId: text("outbox_id").notNull().references(() => reportEvaluationFeedbackOutbox.id, { onDelete: "cascade" }),
  evaluationId: text("evaluation_id").notNull().references(() => reportEvaluations.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  consumerKey: text("consumer_key").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  receiptHash: text("receipt_hash").notNull(),
  acknowledgedAt: text("acknowledged_at").notNull(),
}, (table) => [
  uniqueIndex("report_evaluation_feedback_receipts_outbox_uidx").on(table.outboxId),
  uniqueIndex("report_evaluation_feedback_receipts_idempotency_uidx").on(table.idempotencyKey),
]);

export const reportPurgeAudits = sqliteTable("report_purge_audits", {
  id: text("id").primaryKey(),
  cutoff: text("cutoff").notNull(),
  heartbeatGuard: text("heartbeat_guard").notNull(),
  runsDeleted: integer("runs_deleted").notNull(),
  qualitySignalsDeleted: integer("quality_signals_deleted").notNull(),
  humanReviewRequestsDeleted: integer("human_review_requests_deleted").notNull().default(0),
  humanReviewResponsesDeleted: integer("human_review_responses_deleted").notNull().default(0),
  humanReviewOpenDeleted: integer("human_review_open_deleted").notNull().default(0),
  evaluationFeedbackPendingDeleted: integer("evaluation_feedback_pending_deleted").notNull().default(0),
  evaluationFeedbackOutboxDeleted: integer("evaluation_feedback_outbox_deleted").notNull().default(0),
  evaluationFeedbackClaimsDeleted: integer("evaluation_feedback_claims_deleted").notNull().default(0),
  evaluationFeedbackReceiptsDeleted: integer("evaluation_feedback_receipts_deleted").notNull().default(0),
  evaluationsDeleted: integer("evaluations_deleted").notNull(),
  adsDeleted: integer("ads_deleted").notNull(),
  matchesDeleted: integer("matches_deleted").notNull(),
  productsDeleted: integer("products_deleted").notNull(),
  companiesDeleted: integer("companies_deleted").notNull(),
  factChunksDeleted: integer("fact_chunks_deleted").notNull(),
  factManifestsDeleted: integer("fact_manifests_deleted").notNull(),
  documentsDeleted: integer("documents_deleted").notNull(),
  eventsDeleted: integer("events_deleted").notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  index("report_purge_audits_observed_idx").on(table.observedAt),
]);
