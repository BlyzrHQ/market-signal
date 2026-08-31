import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { BILLING_PLANS, type BillingPlan } from "./billing-plans.ts";
import { canonicalDomain } from "./domain.ts";
import {
  ensureMcpCommandSchema,
  getMcpCommandReceipt,
  recordMcpCommandReceipt,
} from "./mcp-command-store.ts";
import {
  canonicalPriceWatchUrl,
  canonicalPriceWatchVariant,
  currentPriceSnapshot,
  type PriceWatchPriceSnapshot,
} from "./price-watch-target.ts";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const ACTIVE_WATCHER_STATES = new Set(["active", "baseline_pending"]);
const MAX_BULK_TARGETS = 1_000;
const WATCHER_LEASE_MS = 10 * 60 * 1_000;

export type PriceWatchCadence = "hourly" | "daily";
export type PriceWatchState = "baseline_pending" | "active" | "disabled" | "paused_credits" | "paused_subscription" | "paused_failure";
export type PriceWatchReservationStatus = "reserved" | "attempting" | "committed" | "released";

export type PriceWatchUsage = {
  planTier: string;
  periodStart: string;
  periodEnd: string;
  allocation: number;
  used: number;
  remaining: number;
  projectedDaily: number;
  projectedMonthly: number;
};

export type PriceWatcher = {
  id: string;
  workspaceId: string;
  canonicalUrl: string;
  resolvedUrl: string;
  sourceDomain: string;
  rivalDomain: string;
  productName: string;
  variantKey: string;
  variant: Record<string, unknown>;
  cadence: PriceWatchCadence;
  state: PriceWatchState;
  pauseReason: string;
  baseline: PriceWatchPriceSnapshot | null;
  failureStreak: number;
  nextCheckAt: string;
  lastCheckAt: string;
  createdAt: string;
  updatedAt: string;
  links: Array<{ publicReportId: string; matchId: string }>;
};

export type PriceWatchActivationInput = {
  publicReportId: string;
  cadence: PriceWatchCadence;
  matchId?: string;
  rivalDomain?: string;
};

export type PriceWatchActivationResult = {
  watcherIds: string[];
  created: number;
  reused: number;
  baselineCreditsReserved: number;
  usage: PriceWatchUsage;
  replayed?: boolean;
};

export type PriceWatchActivationPreview = {
  publicReportId: string;
  selection: { kind: "match"; matchId: string } | { kind: "rival-snapshot"; rivalDomain: string };
  cadence: PriceWatchCadence;
  eligibleComparisons: number;
  uniqueTargets: number;
  newWatchers: number;
  reusedWatchers: number;
  baselineCreditsRequired: number;
  usageBefore: PriceWatchUsage;
  usageAfter: PriceWatchUsage;
  impactFingerprint: string;
};

export type PriceWatchCommandOptions = {
  commandId: string;
  operation: string;
  expectedImpactFingerprint?: string;
};

export type PriceWatchClaim = {
  reservationId: string;
  dueSlot: string;
  watcherId: string;
  workspaceId: string;
  canonicalUrl: string;
  resolvedUrl: string;
  sourceDomain: string;
  rivalDomain: string;
  productName: string;
  variantKey: string;
  variantJson: string;
  cadence: PriceWatchCadence;
  state: "baseline_pending" | "active";
  baseline: PriceWatchPriceSnapshot | null;
  claimOwner: string;
  leaseExpiresAt: string;
};

export class PriceWatchStoreError extends Error {
  readonly code: string;
  readonly httpStatus: 400 | 402 | 404 | 409;

  constructor(code: string, message: string, httpStatus: 400 | 402 | 404 | 409) {
    super(message);
    this.name = "PriceWatchStoreError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function cleanText(value: unknown, limit = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function parsedRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parsedArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validCadence(value: unknown): PriceWatchCadence {
  if (value === "hourly" || value === "daily") return value;
  throw new PriceWatchStoreError("invalid-cadence", "Choose hourly or daily monitoring.", 400);
}

function cadenceMilliseconds(cadence: PriceWatchCadence) {
  return cadence === "hourly" ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
}

export function nextPriceWatchCheck(cadence: PriceWatchCadence, now = new Date()) {
  return new Date(now.getTime() + cadenceMilliseconds(cadence)).toISOString();
}

export function ensurePriceWatchSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS price_watch_entitlements (
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      period_start text NOT NULL,
      period_end text NOT NULL,
      plan_tier text NOT NULL,
      allocation integer NOT NULL CHECK(allocation >= 0),
      purged_used integer NOT NULL DEFAULT 0 CHECK(purged_used >= 0),
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY(workspace_id, period_start, period_end)
    );
    CREATE INDEX IF NOT EXISTS price_watch_entitlements_period_idx
      ON price_watch_entitlements(period_start, period_end);

    CREATE TABLE IF NOT EXISTS price_watchers (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      canonical_url text NOT NULL,
      resolved_url text NOT NULL DEFAULT '',
      canonicalization_version integer NOT NULL,
      source_domain text NOT NULL,
      rival_domain text NOT NULL,
      product_name text NOT NULL,
      variant_key text NOT NULL,
      variant_json text NOT NULL,
      audit_target text NOT NULL UNIQUE,
      creator_user_id text REFERENCES user(id) ON DELETE SET NULL,
      email_owner_user_id text REFERENCES user(id) ON DELETE SET NULL,
      cadence text NOT NULL CHECK(cadence IN ('hourly','daily')),
      state text NOT NULL CHECK(state IN ('baseline_pending','active','disabled','paused_credits','paused_subscription','paused_failure')),
      pause_reason text NOT NULL DEFAULT '',
      baseline_currency text NOT NULL DEFAULT '',
      baseline_amount_micros integer,
      baseline_raw text NOT NULL DEFAULT '',
      baseline_list_amount_micros integer,
      baseline_list_raw text NOT NULL DEFAULT '',
      baseline_observed_at text NOT NULL DEFAULT '',
      failure_streak integer NOT NULL DEFAULT 0 CHECK(failure_streak >= 0),
      next_check_at text NOT NULL DEFAULT '',
      last_check_at text NOT NULL DEFAULT '',
      claim_owner text NOT NULL DEFAULT '',
      claim_expires_at text NOT NULL DEFAULT '',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE(workspace_id, canonical_url, variant_key)
    );
    CREATE INDEX IF NOT EXISTS price_watchers_due_idx ON price_watchers(state, next_check_at);
    CREATE INDEX IF NOT EXISTS price_watchers_workspace_idx ON price_watchers(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS price_watch_credit_reservations (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      watcher_id text NOT NULL REFERENCES price_watchers(id) ON DELETE CASCADE,
      period_start text NOT NULL,
      period_end text NOT NULL,
      due_slot text NOT NULL,
      status text NOT NULL CHECK(status IN ('reserved','attempting','committed','released')),
      claim_owner text NOT NULL DEFAULT '',
      lease_expires_at text NOT NULL DEFAULT '',
      external_attempt_at text NOT NULL DEFAULT '',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE(watcher_id, due_slot)
    );
    CREATE INDEX IF NOT EXISTS price_watch_credit_reservations_usage_idx
      ON price_watch_credit_reservations(workspace_id, period_start, period_end, status);
    CREATE INDEX IF NOT EXISTS price_watch_credit_reservations_lease_idx
      ON price_watch_credit_reservations(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS price_watch_observations (
      id text PRIMARY KEY NOT NULL,
      watcher_id text NOT NULL REFERENCES price_watchers(id) ON DELETE CASCADE,
      reservation_id text NOT NULL UNIQUE REFERENCES price_watch_credit_reservations(id) ON DELETE CASCADE,
      kind text NOT NULL,
      currency text NOT NULL,
      amount_micros integer NOT NULL CHECK(amount_micros > 0),
      raw_price text NOT NULL,
      list_amount_micros integer,
      raw_list_price text NOT NULL DEFAULT '',
      observed_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS price_watch_observations_history_idx
      ON price_watch_observations(watcher_id, observed_at);

    CREATE TABLE IF NOT EXISTS price_watch_events (
      id text PRIMARY KEY NOT NULL,
      watcher_id text NOT NULL REFERENCES price_watchers(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      detail_json text NOT NULL DEFAULT '{}',
      idempotency_key text NOT NULL,
      observed_at text NOT NULL,
      UNIQUE(watcher_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS price_watch_events_history_idx ON price_watch_events(watcher_id, observed_at);

    CREATE TABLE IF NOT EXISTS workspace_notifications (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      watcher_id text REFERENCES price_watchers(id) ON DELETE CASCADE,
      notification_type text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      dedupe_key text NOT NULL,
      created_at text NOT NULL,
      UNIQUE(workspace_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS workspace_notifications_recent_idx ON workspace_notifications(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS workspace_notification_reads (
      notification_id text NOT NULL REFERENCES workspace_notifications(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      read_at text NOT NULL,
      PRIMARY KEY(notification_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_notification_reads_user_idx ON workspace_notification_reads(user_id, read_at);

    CREATE TABLE IF NOT EXISTS price_watch_email_outbox (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      watcher_id text NOT NULL REFERENCES price_watchers(id) ON DELETE CASCADE,
      recipient_user_id text REFERENCES user(id) ON DELETE SET NULL,
      event_id text NOT NULL UNIQUE REFERENCES price_watch_events(id) ON DELETE CASCADE,
      status text NOT NULL CHECK(status IN ('pending','sending','delivered')),
      batch_after text NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      last_error_code text NOT NULL DEFAULT '',
      delivered_at text NOT NULL DEFAULT '',
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS price_watch_email_outbox_due_idx ON price_watch_email_outbox(status, batch_after);

    CREATE TABLE IF NOT EXISTS price_watch_audit_log (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_user_id text REFERENCES user(id) ON DELETE SET NULL,
      action text NOT NULL,
      target_tombstone text NOT NULL,
      detail_json text NOT NULL DEFAULT '{}',
      created_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS price_watch_audit_log_workspace_idx ON price_watch_audit_log(workspace_id, created_at);
    CREATE TRIGGER IF NOT EXISTS price_watch_audit_log_no_update
      BEFORE UPDATE ON price_watch_audit_log
      BEGIN SELECT RAISE(ABORT, 'price-watch audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS price_watch_audit_log_no_direct_delete
      BEFORE DELETE ON price_watch_audit_log
      WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      BEGIN SELECT RAISE(ABORT, 'price-watch audit rows are immutable'); END;

    CREATE TABLE IF NOT EXISTS price_watcher_report_links (
      watcher_id text NOT NULL REFERENCES price_watchers(id) ON DELETE CASCADE,
      report_run_id text NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
      match_id text NOT NULL REFERENCES report_matches(id) ON DELETE CASCADE,
      created_at text NOT NULL,
      PRIMARY KEY(watcher_id, report_run_id, match_id)
    );
    CREATE INDEX IF NOT EXISTS price_watcher_report_links_report_idx ON price_watcher_report_links(report_run_id, match_id);
  `);
  const watcherColumns = database.prepare(`PRAGMA table_info(price_watchers)`).all() as Array<{ name?: string }>;
  if (!watcherColumns.some((column) => column.name === "resolved_url")) {
    database.exec(`ALTER TABLE price_watchers ADD COLUMN resolved_url text NOT NULL DEFAULT ''`);
  }
}

export function disableWorkspacePriceWatchers(
  database: Database.Database,
  workspaceId: string,
  reason: string,
  now = new Date(),
): { disabled: number; releasedReservations: number } {
  const cleanWorkspaceId = cleanText(workspaceId, 200);
  const cleanReason = cleanText(reason, 120);
  if (!cleanWorkspaceId || !cleanReason) return { disabled: 0, releasedReservations: 0 };
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('price_watchers', 'price_watch_credit_reservations')
  `).all() as Array<{ name?: string }>;
  const names = new Set(tables.map((row) => row.name));
  if (!names.has("price_watchers")) return { disabled: 0, releasedReservations: 0 };
  const nowIso = now.toISOString();
  const releasedReservations = names.has("price_watch_credit_reservations")
    ? database.prepare(`
        UPDATE price_watch_credit_reservations
        SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ?
        WHERE workspace_id = ? AND status = 'reserved'
      `).run(nowIso, cleanWorkspaceId).changes
    : 0;
  const disabled = database.prepare(`
    UPDATE price_watchers
    SET state = 'disabled', pause_reason = ?, claim_owner = '', claim_expires_at = '', next_check_at = '', updated_at = ?
    WHERE workspace_id = ? AND state != 'disabled'
  `).run(cleanReason, nowIso, cleanWorkspaceId).changes;
  return { disabled, releasedReservations };
}

type ActiveEntitlement = {
  plan: BillingPlan;
  periodStart: string;
  periodEnd: string;
  allocation: number;
};

function currentSubscriptionEntitlement(database: Database.Database, workspaceId: string, now: Date): ActiveEntitlement | null {
  const row = database.prepare(`SELECT plan_tier, status, current_period_start, current_period_end FROM workspace_subscriptions WHERE workspace_id = ?`)
    .get(workspaceId) as Record<string, unknown> | undefined;
  const plan = row ? BILLING_PLANS[String(row.plan_tier || "") as keyof typeof BILLING_PLANS] : null;
  const periodStart = cleanText(row?.current_period_start, 80);
  const periodEnd = cleanText(row?.current_period_end, 80);
  const nowIso = now.toISOString();
  if (!row || !plan || !ACTIVE_SUBSCRIPTION_STATUSES.has(String(row.status || "")) || !periodStart || !periodEnd || nowIso < periodStart || nowIso >= periodEnd) return null;
  return { plan, periodStart, periodEnd, allocation: plan.monitoringCredits };
}

function notification(database: Database.Database, input: { workspaceId: string; watcherId?: string; type: string; title: string; body: string; dedupeKey: string; nowIso: string }) {
  database.prepare(`INSERT OR IGNORE INTO workspace_notifications (id, workspace_id, watcher_id, notification_type, title, body, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.workspaceId, input.watcherId || null, input.type, cleanText(input.title, 160), cleanText(input.body, 500), input.dedupeKey, input.nowIso);
}

export function reconcilePriceWatchSubscription(database: Database.Database, workspaceId: string, now = new Date()): ActiveEntitlement | null {
  ensurePriceWatchSchema(database);
  const nowIso = now.toISOString();
  const entitlement = currentSubscriptionEntitlement(database, workspaceId, now);
  if (!entitlement) {
    database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE workspace_id = ? AND status = 'reserved'`).run(nowIso, workspaceId);
    database.prepare(`UPDATE price_watchers SET state = 'paused_subscription', pause_reason = 'subscription-inactive', claim_owner = '', claim_expires_at = '', updated_at = ? WHERE workspace_id = ? AND state IN ('active','baseline_pending','paused_credits')`).run(nowIso, workspaceId);
    return null;
  }
  const existing = database.prepare(`SELECT workspace_id FROM price_watch_entitlements WHERE workspace_id = ? AND period_start = ? AND period_end = ?`)
    .get(workspaceId, entitlement.periodStart, entitlement.periodEnd);
  database.prepare(`INSERT INTO price_watch_entitlements (workspace_id, period_start, period_end, plan_tier, allocation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, period_start, period_end) DO UPDATE SET plan_tier = excluded.plan_tier, allocation = excluded.allocation, updated_at = excluded.updated_at`)
    .run(workspaceId, entitlement.periodStart, entitlement.periodEnd, entitlement.plan.id, entitlement.allocation, nowIso, nowIso);
  database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE workspace_id = ? AND status = 'reserved' AND (period_start <> ? OR period_end <> ?)`)
    .run(nowIso, workspaceId, entitlement.periodStart, entitlement.periodEnd);
  if (!existing) {
    database.prepare(`UPDATE price_watchers SET state = 'active', pause_reason = '', next_check_at = ?, updated_at = ? WHERE workspace_id = ? AND state = 'paused_credits' AND baseline_amount_micros IS NOT NULL`).run(nowIso, nowIso, workspaceId);
    database.prepare(`UPDATE price_watchers SET state = 'baseline_pending', pause_reason = '', next_check_at = ?, updated_at = ? WHERE workspace_id = ? AND state = 'paused_credits' AND baseline_amount_micros IS NULL`).run(nowIso, nowIso, workspaceId);
  }
  return entitlement;
}

function usageForPeriod(database: Database.Database, workspaceId: string, entitlement: ActiveEntitlement | null): PriceWatchUsage {
  if (!entitlement) return { planTier: "", periodStart: "", periodEnd: "", allocation: 0, used: 0, remaining: 0, projectedDaily: 0, projectedMonthly: 0 };
  const usedRow = database.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations WHERE workspace_id = ? AND period_start = ? AND period_end = ? AND status IN ('reserved','attempting','committed')`)
    .get(workspaceId, entitlement.periodStart, entitlement.periodEnd) as { count?: number } | undefined;
  const entitlementRow = database.prepare(`SELECT purged_used FROM price_watch_entitlements WHERE workspace_id = ? AND period_start = ? AND period_end = ? LIMIT 1`)
    .get(workspaceId, entitlement.periodStart, entitlement.periodEnd) as { purged_used?: number } | undefined;
  const projectionRows = database.prepare(`SELECT cadence, COUNT(*) AS count FROM price_watchers WHERE workspace_id = ? AND state IN ('active','baseline_pending') GROUP BY cadence`).all(workspaceId) as Array<{ cadence: string; count: number }>;
  const hourly = Number(projectionRows.find((row) => row.cadence === "hourly")?.count || 0);
  const daily = Number(projectionRows.find((row) => row.cadence === "daily")?.count || 0);
  const projectedDaily = hourly * 24 + daily;
  const used = Number(usedRow?.count || 0) + Number(entitlementRow?.purged_used || 0);
  return {
    planTier: entitlement.plan.id,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    allocation: entitlement.allocation,
    used,
    remaining: Math.max(0, entitlement.allocation - used),
    projectedDaily,
    projectedMonthly: projectedDaily * 30,
  };
}

export function priceWatchUsage(database: Database.Database, workspaceId: string, now = new Date()): PriceWatchUsage {
  return database.transaction(() => usageForPeriod(database, workspaceId, reconcilePriceWatchSubscription(database, workspaceId, now))).immediate();
}

function rowWatcher(row: Record<string, unknown>): PriceWatcher {
  const baselineAmount = Number(row.baseline_amount_micros);
  const listAmount = Number(row.baseline_list_amount_micros);
  return {
    id: String(row.id || ""),
    workspaceId: String(row.workspace_id || ""),
    canonicalUrl: String(row.canonical_url || ""),
    resolvedUrl: String(row.resolved_url || ""),
    sourceDomain: String(row.source_domain || ""),
    rivalDomain: String(row.rival_domain || ""),
    productName: String(row.product_name || ""),
    variantKey: String(row.variant_key || ""),
    variant: parsedRecord(row.variant_json),
    cadence: row.cadence === "hourly" ? "hourly" : "daily",
    state: String(row.state || "disabled") as PriceWatchState,
    pauseReason: String(row.pause_reason || ""),
    baseline: Number.isSafeInteger(baselineAmount) && baselineAmount > 0 ? {
      currency: String(row.baseline_currency || ""),
      amountMicros: baselineAmount,
      raw: String(row.baseline_raw || ""),
      listAmountMicros: Number.isSafeInteger(listAmount) && listAmount > 0 ? listAmount : null,
      listRaw: Number.isSafeInteger(listAmount) && listAmount > 0 ? String(row.baseline_list_raw || "") : "",
    } : null,
    failureStreak: Number(row.failure_streak || 0),
    nextCheckAt: String(row.next_check_at || ""),
    lastCheckAt: String(row.last_check_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    links: [],
  };
}

export function listPriceWatchers(database: Database.Database, workspaceId: string, now = new Date()): { watchers: PriceWatcher[]; usage: PriceWatchUsage } {
  ensurePriceWatchSchema(database);
  const usage = priceWatchUsage(database, workspaceId, now);
  const rows = database.prepare(`SELECT * FROM price_watchers WHERE workspace_id = ? ORDER BY created_at DESC, id DESC`).all(workspaceId) as Record<string, unknown>[];
  const links = database.prepare(`SELECT links.watcher_id, links.match_id, runs.public_id FROM price_watcher_report_links links JOIN price_watchers watchers ON watchers.id = links.watcher_id JOIN report_runs runs ON runs.id = links.report_run_id WHERE watchers.workspace_id = ? ORDER BY links.created_at ASC`).all(workspaceId) as Record<string, unknown>[];
  const linksByWatcher = new Map<string, Array<{ publicReportId: string; matchId: string }>>();
  for (const link of links) {
    const watcherId = String(link.watcher_id || "");
    const entry = { publicReportId: String(link.public_id || ""), matchId: String(link.match_id || "") };
    linksByWatcher.set(watcherId, [...(linksByWatcher.get(watcherId) || []), entry]);
  }
  return { watchers: rows.map((row) => ({ ...rowWatcher(row), links: linksByWatcher.get(String(row.id || "")) || [] })), usage };
}

type EligibleTarget = {
  runId: string;
  matchId: string;
  primaryDomain: string;
  rivalDomain: string;
  productName: string;
  canonicalUrl: string;
  canonicalizationVersion: number;
  sourceDomain: string;
  variantKey: string;
  variantJson: string;
};

function eligibleTargets(database: Database.Database, workspaceId: string, input: PriceWatchActivationInput, now: Date): EligibleTarget[] {
  const publicReportId = cleanText(input.publicReportId, 80);
  const matchId = cleanText(input.matchId, 100);
  const requestedRival = input.rivalDomain ? canonicalDomain(input.rivalDomain) : "";
  if ((!matchId && !requestedRival) || (matchId && requestedRival)) {
    throw new PriceWatchStoreError("invalid-selection", "Choose one saved comparison or one rival snapshot.", 400);
  }
  const run = database.prepare(`SELECT id, workspace_id, primary_domain, expires_at FROM report_runs WHERE public_id = ? LIMIT 1`).get(publicReportId) as Record<string, unknown> | undefined;
  if (!run || String(run.workspace_id || "") !== workspaceId || String(run.expires_at || "") <= now.toISOString()) {
    throw new PriceWatchStoreError("report-not-found", "Report not found.", 404);
  }
  const selector = matchId ? "matches.id = ?" : "matches.rival_domain = ?";
  const selectorValue = matchId || requestedRival;
  const rows = database.prepare(`SELECT
      matches.id AS match_id,
      matches.rival_domain,
      matches.evidence_json,
      rival_products.name AS rival_name,
      rival_products.source_url AS rival_source_url,
      rival_products.price_json AS rival_price_json,
      rival_products.metadata_json AS rival_metadata_json
    FROM report_matches AS matches
    JOIN report_products AS rival_products
      ON rival_products.run_id = matches.run_id
      AND rival_products.domain = matches.rival_domain
      AND rival_products.product_id = matches.rival_product_id
    WHERE matches.run_id = ?
      AND ${selector}
      AND json_extract(matches.evidence_json, '$.publication.priceEligible') = 1
    ORDER BY matches.rival_domain ASC, matches.id ASC
    LIMIT ?`).all(String(run.id || ""), selectorValue, MAX_BULK_TARGETS + 1) as Record<string, unknown>[];
  if (rows.length > MAX_BULK_TARGETS) throw new PriceWatchStoreError("selection-too-large", "This rival snapshot exceeds the bounded watcher activation limit.", 400);
  const targets: EligibleTarget[] = [];
  for (const row of rows) {
    const evidence = parsedRecord(row.evidence_json);
    const metadata = parsedRecord(row.rival_metadata_json);
    const assessment = parsedRecord(evidence.assessment);
    const persistedSourceUrl = cleanText(evidence.rivalSourceUrl || assessment.rivalSourceUrl || row.rival_source_url, 2_048);
    const rivalDomain = canonicalDomain(String(row.rival_domain || ""));
    let canonical: ReturnType<typeof canonicalPriceWatchUrl>;
    try { canonical = canonicalPriceWatchUrl(persistedSourceUrl); } catch { continue; }
    const snapshot = currentPriceSnapshot(parsedArray(row.rival_price_json));
    if (!snapshot || !rivalDomain || canonical.domain !== rivalDomain) continue;
    const variant = canonicalPriceWatchVariant({
      quantity: metadata.quantity,
      normalizedVariant: evidence.normalizedVariant || assessment.normalizedVariant,
      normalizedSize: evidence.normalizedSize || assessment.normalizedSize,
    });
    targets.push({
      runId: String(run.id || ""),
      matchId: String(row.match_id || ""),
      primaryDomain: String(run.primary_domain || ""),
      rivalDomain,
      productName: cleanText(row.rival_name, 240) || "Rival product",
      canonicalUrl: canonical.canonicalUrl,
      canonicalizationVersion: canonical.version,
      sourceDomain: canonical.domain,
      variantKey: variant.variantKey,
      variantJson: variant.variantJson,
    });
  }
  if (!targets.length) throw new PriceWatchStoreError("no-eligible-targets", "No saved comparison with an exact URL and positive supported-currency price is eligible.", 409);
  return targets;
}

function cadenceChecksPerDay(cadence: PriceWatchCadence) {
  return cadence === "hourly" ? 24 : 1;
}

function activationResolution(
  database: Database.Database,
  workspaceId: string,
  input: PriceWatchActivationInput,
  now: Date,
  reconcile: boolean,
) {
  const cadence = validCadence(input.cadence);
  const targets = eligibleTargets(database, workspaceId, input, now);
  const entitlement = reconcile
    ? reconcilePriceWatchSubscription(database, workspaceId, now)
    : currentSubscriptionEntitlement(database, workspaceId, now);
  if (!entitlement) throw new PriceWatchStoreError("subscription-required", "An active subscription is required for price monitoring.", 402);
  const grouped = new Map<string, { target: EligibleTarget; links: EligibleTarget[] }>();
  for (const target of targets) {
    const key = `${target.canonicalUrl}\n${target.variantKey}`;
    const existing = grouped.get(key);
    if (existing) existing.links.push(target);
    else grouped.set(key, { target, links: [target] });
  }
  const resolved = [...grouped.values()].map((group) => {
    const existing = database.prepare(`SELECT * FROM price_watchers WHERE workspace_id = ? AND canonical_url = ? AND variant_key = ? LIMIT 1`)
      .get(workspaceId, group.target.canonicalUrl, group.target.variantKey) as Record<string, unknown> | undefined;
    return { ...group, existing };
  });
  const baselineCredits = resolved.filter(({ existing }) => !existing || !ACTIVE_WATCHER_STATES.has(String(existing.state || ""))).length;
  const before = usageForPeriod(database, workspaceId, entitlement);
  let projectedDaily = before.projectedDaily;
  for (const item of resolved) {
    if (item.existing && ACTIVE_WATCHER_STATES.has(String(item.existing.state || ""))) {
      projectedDaily -= cadenceChecksPerDay(item.existing.cadence === "hourly" ? "hourly" : "daily");
    }
    projectedDaily += cadenceChecksPerDay(cadence);
  }
  const fingerprintInput = {
    publicReportId: cleanText(input.publicReportId, 80),
    cadence,
    selection: input.matchId ? { matchId: cleanText(input.matchId, 100) } : { rivalDomain: canonicalDomain(input.rivalDomain || "") },
    period: [entitlement.periodStart, entitlement.periodEnd],
    usage: [before.used, before.remaining],
    targets: resolved.map((item) => ({
      key: `${item.target.canonicalUrl}\n${item.target.variantKey}`,
      existing: item.existing ? {
        id: String(item.existing.id || ""),
        state: String(item.existing.state || ""),
        cadence: String(item.existing.cadence || ""),
        updatedAt: String(item.existing.updated_at || ""),
      } : null,
      links: item.links.map((link) => link.matchId).sort(),
    })).sort((left, right) => left.key.localeCompare(right.key)),
  };
  const impactFingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
  const after: PriceWatchUsage = {
    ...before,
    used: before.used + baselineCredits,
    remaining: Math.max(0, before.remaining - baselineCredits),
    projectedDaily,
    projectedMonthly: projectedDaily * 30,
  };
  return { cadence, targets, entitlement, resolved, baselineCredits, before, after, impactFingerprint };
}

export function previewPriceWatchActivation(
  database: Database.Database,
  workspaceId: string,
  input: PriceWatchActivationInput,
  now = new Date(),
): PriceWatchActivationPreview {
  ensurePriceWatchSchema(database);
  const resolution = activationResolution(database, workspaceId, input, now, false);
  if (resolution.before.used + resolution.baselineCredits > resolution.entitlement.allocation) {
    throw new PriceWatchStoreError("insufficient-credits", `This activation needs ${resolution.baselineCredits} monitoring credits, but only ${resolution.before.remaining} remain.`, 402);
  }
  return {
    publicReportId: cleanText(input.publicReportId, 80),
    selection: input.matchId
      ? { kind: "match", matchId: cleanText(input.matchId, 100) }
      : { kind: "rival-snapshot", rivalDomain: canonicalDomain(input.rivalDomain || "") },
    cadence: resolution.cadence,
    eligibleComparisons: resolution.targets.length,
    uniqueTargets: resolution.resolved.length,
    newWatchers: resolution.resolved.filter((item) => !item.existing).length,
    reusedWatchers: resolution.resolved.filter((item) => Boolean(item.existing)).length,
    baselineCreditsRequired: resolution.baselineCredits,
    usageBefore: resolution.before,
    usageAfter: resolution.after,
    impactFingerprint: resolution.impactFingerprint,
  };
}

function reserveBaseline(database: Database.Database, input: { workspaceId: string; watcherId: string; entitlement: ActiveEntitlement; nowIso: string }) {
  const id = randomUUID();
  database.prepare(`INSERT INTO price_watch_credit_reservations (id, workspace_id, watcher_id, period_start, period_end, due_slot, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
    .run(id, input.workspaceId, input.watcherId, input.entitlement.periodStart, input.entitlement.periodEnd, `baseline:${randomUUID()}`, input.nowIso, input.nowIso);
  return id;
}

export function activatePriceWatchers(
  database: Database.Database,
  workspaceId: string,
  actorUserId: string,
  input: PriceWatchActivationInput,
  now = new Date(),
  command?: PriceWatchCommandOptions,
): PriceWatchActivationResult {
  ensurePriceWatchSchema(database);
  if (command) ensureMcpCommandSchema(database);
  return database.transaction(() => {
    const receipt = command ? getMcpCommandReceipt(database, workspaceId, command.operation, command.commandId) : null;
    if (receipt) return { ...receipt, replayed: true } as PriceWatchActivationResult;
    const resolution = activationResolution(database, workspaceId, input, now, true);
    if (command?.expectedImpactFingerprint && command.expectedImpactFingerprint !== resolution.impactFingerprint) {
      throw new PriceWatchStoreError("impact-changed", "Price-watch eligibility, credits, or target state changed. Preview the action again.", 409);
    }
    const { cadence, entitlement, resolved, baselineCredits, before } = resolution;
    if (before.used + baselineCredits > entitlement.allocation) {
      throw new PriceWatchStoreError("insufficient-credits", `This activation needs ${baselineCredits} monitoring credits, but only ${before.remaining} remain.`, 402);
    }
    const nowIso = now.toISOString();
    const watcherIds: string[] = [];
    let created = 0;
    let reused = 0;
    for (const item of resolved) {
      let watcherId = String(item.existing?.id || "");
      if (!watcherId) {
        watcherId = randomUUID();
        database.prepare(`INSERT INTO price_watchers (
          id, workspace_id, canonical_url, canonicalization_version, source_domain, rival_domain, product_name,
          variant_key, variant_json, audit_target, creator_user_id, email_owner_user_id, cadence, state,
          pause_reason, next_check_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'baseline_pending', '', ?, ?, ?)`)
          .run(
            watcherId, workspaceId, item.target.canonicalUrl, item.target.canonicalizationVersion,
            item.target.sourceDomain, item.target.rivalDomain, item.target.productName,
            item.target.variantKey, item.target.variantJson, randomUUID(), actorUserId, actorUserId,
            cadence, nowIso, nowIso, nowIso,
          );
        reserveBaseline(database, { workspaceId, watcherId, entitlement, nowIso });
        created += 1;
      } else {
        reused += 1;
        if (!ACTIVE_WATCHER_STATES.has(String(item.existing?.state || ""))) {
          database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE watcher_id = ? AND status = 'reserved'`).run(nowIso, watcherId);
          database.prepare(`UPDATE price_watchers SET cadence = ?, state = 'baseline_pending', pause_reason = '', resolved_url = '', baseline_currency = '', baseline_amount_micros = NULL, baseline_raw = '', baseline_list_amount_micros = NULL, baseline_list_raw = '', baseline_observed_at = '', failure_streak = 0, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND workspace_id = ?`)
            .run(cadence, nowIso, nowIso, watcherId, workspaceId);
          reserveBaseline(database, { workspaceId, watcherId, entitlement, nowIso });
        } else {
          const active = String(item.existing?.state || "") === "active";
          database.prepare(`UPDATE price_watchers SET cadence = ?, next_check_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
            .run(cadence, active ? nextPriceWatchCheck(cadence, now) : String(item.existing?.next_check_at || nowIso), nowIso, watcherId, workspaceId);
        }
      }
      for (const link of item.links) {
        database.prepare(`INSERT OR IGNORE INTO price_watcher_report_links (watcher_id, report_run_id, match_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(watcherId, link.runId, link.matchId, nowIso);
      }
      watcherIds.push(watcherId);
    }
    database.prepare(`INSERT INTO price_watch_audit_log (id, workspace_id, actor_user_id, action, target_tombstone, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), workspaceId, actorUserId, input.matchId ? "watcher.activate-one" : "watcher.activate-rival-snapshot", randomUUID(), JSON.stringify({ count: watcherIds.length, cadence }), nowIso);
    const result: PriceWatchActivationResult = {
      watcherIds,
      created,
      reused,
      baselineCreditsReserved: baselineCredits,
      usage: usageForPeriod(database, workspaceId, entitlement),
    };
    if (command) recordMcpCommandReceipt(database, workspaceId, command.operation, command.commandId, result, now);
    return result;
  }).immediate();
}

export type PriceWatchMutation = {
  cadence?: PriceWatchCadence;
  action?: "disable" | "resume";
};

export type PriceWatchMutationPreview = {
  watcherId: string;
  productName: string;
  rivalDomain: string;
  current: { state: PriceWatchState; cadence: PriceWatchCadence };
  requested: { action: "disable" | "resume" | "cadence"; cadence: PriceWatchCadence };
  baselineCreditsRequired: number;
  usageBefore: PriceWatchUsage;
  usageAfter: PriceWatchUsage;
  impactFingerprint: string;
};

export function previewPriceWatchMutation(
  database: Database.Database,
  workspaceId: string,
  watcherId: string,
  input: PriceWatchMutation,
  now = new Date(),
): PriceWatchMutationPreview {
  ensurePriceWatchSchema(database);
  const row = database.prepare(`SELECT * FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(watcherId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) throw new PriceWatchStoreError("watcher-not-found", "Price watcher not found.", 404);
  const cadence = input.cadence === undefined ? (row.cadence === "hourly" ? "hourly" : "daily") : validCadence(input.cadence);
  if (input.action !== undefined && input.action !== "disable" && input.action !== "resume") throw new PriceWatchStoreError("invalid-action", "Invalid watcher action.", 400);
  if (input.action === undefined && input.cadence === undefined) throw new PriceWatchStoreError("empty-mutation", "No watcher change was supplied.", 400);
  const entitlement = currentSubscriptionEntitlement(database, workspaceId, now);
  if (input.action === "resume" && !entitlement) throw new PriceWatchStoreError("subscription-required", "An active subscription is required to resume monitoring.", 402);
  const before = usageForPeriod(database, workspaceId, entitlement);
  const currentState = String(row.state || "disabled") as PriceWatchState;
  const currentlyActive = ACTIVE_WATCHER_STATES.has(currentState);
  const willBeActive = input.action === "disable" ? false : input.action === "resume" ? true : currentlyActive;
  const baselineCreditsRequired = input.action === "resume" && !currentlyActive
    && !(currentState === "paused_credits" && Number(row.baseline_amount_micros) > 0) ? 1 : 0;
  if (baselineCreditsRequired > before.remaining) throw new PriceWatchStoreError("insufficient-credits", "A fresh baseline needs one monitoring credit, but none remain.", 402);
  let projectedDaily = before.projectedDaily;
  if (currentlyActive) projectedDaily -= cadenceChecksPerDay(row.cadence === "hourly" ? "hourly" : "daily");
  if (willBeActive) projectedDaily += cadenceChecksPerDay(cadence);
  const after: PriceWatchUsage = {
    ...before,
    used: before.used + baselineCreditsRequired,
    remaining: Math.max(0, before.remaining - baselineCreditsRequired),
    projectedDaily,
    projectedMonthly: projectedDaily * 30,
  };
  const fingerprintInput = {
    watcherId,
    updatedAt: String(row.updated_at || ""),
    currentState,
    currentCadence: String(row.cadence || ""),
    baselineAmountMicros: Number(row.baseline_amount_micros) || null,
    requestedAction: input.action || "cadence",
    requestedCadence: cadence,
    usage: [before.used, before.remaining],
  };
  return {
    watcherId,
    productName: String(row.product_name || ""),
    rivalDomain: String(row.rival_domain || ""),
    current: { state: currentState, cadence: row.cadence === "hourly" ? "hourly" : "daily" },
    requested: { action: input.action || "cadence", cadence },
    baselineCreditsRequired,
    usageBefore: before,
    usageAfter: after,
    impactFingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex"),
  };
}

export function mutatePriceWatcher(
  database: Database.Database,
  workspaceId: string,
  actorUserId: string,
  watcherId: string,
  input: PriceWatchMutation,
  now = new Date(),
  command?: PriceWatchCommandOptions,
): { watcher: PriceWatcher; usage: PriceWatchUsage } {
  ensurePriceWatchSchema(database);
  if (command) ensureMcpCommandSchema(database);
  return database.transaction(() => {
    const receipt = command ? getMcpCommandReceipt(database, workspaceId, command.operation, command.commandId) : null;
    if (receipt) return receipt as { watcher: PriceWatcher; usage: PriceWatchUsage };
    const preview = previewPriceWatchMutation(database, workspaceId, watcherId, input, now);
    if (command?.expectedImpactFingerprint && command.expectedImpactFingerprint !== preview.impactFingerprint) {
      throw new PriceWatchStoreError("impact-changed", "Price-watch state or credit impact changed. Preview the action again.", 409);
    }
    const row = database.prepare(`SELECT * FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(watcherId, workspaceId) as Record<string, unknown> | undefined;
    if (!row) throw new PriceWatchStoreError("watcher-not-found", "Price watcher not found.", 404);
    const cadence = input.cadence === undefined ? (row.cadence === "hourly" ? "hourly" : "daily") : validCadence(input.cadence);
    if (input.action !== undefined && input.action !== "disable" && input.action !== "resume") throw new PriceWatchStoreError("invalid-action", "Invalid watcher action.", 400);
    if (input.action === undefined && input.cadence === undefined) throw new PriceWatchStoreError("empty-mutation", "No watcher change was supplied.", 400);
    const nowIso = now.toISOString();
    let entitlement: ActiveEntitlement | null = null;
    if (input.action === "disable") {
      database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE watcher_id = ? AND status = 'reserved'`).run(nowIso, watcherId);
      database.prepare(`UPDATE price_watchers SET cadence = ?, state = 'disabled', pause_reason = 'customer-disabled', claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND workspace_id = ?`).run(cadence, nowIso, watcherId, workspaceId);
    } else if (input.action === "resume") {
      entitlement = reconcilePriceWatchSubscription(database, workspaceId, now);
      if (!entitlement) throw new PriceWatchStoreError("subscription-required", "An active subscription is required to resume monitoring.", 402);
      const usage = usageForPeriod(database, workspaceId, entitlement);
      const state = String(row.state || "");
      if (ACTIVE_WATCHER_STATES.has(state)) {
        database.prepare(`UPDATE price_watchers SET cadence = ?, next_check_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .run(cadence, state === "active" ? nextPriceWatchCheck(cadence, now) : String(row.next_check_at || nowIso), nowIso, watcherId, workspaceId);
      } else if (state === "paused_credits") {
        if (usage.remaining < 1) throw new PriceWatchStoreError("insufficient-credits", "No monitoring credits remain in this billing period.", 402);
        const resumeState = Number(row.baseline_amount_micros) > 0 ? "active" : "baseline_pending";
        database.prepare(`UPDATE price_watchers SET cadence = ?, state = ?, pause_reason = '', failure_streak = 0, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND workspace_id = ?`).run(cadence, resumeState, nowIso, nowIso, watcherId, workspaceId);
      } else {
        if (usage.remaining < 1) throw new PriceWatchStoreError("insufficient-credits", "A fresh baseline needs one monitoring credit, but none remain.", 402);
        database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE watcher_id = ? AND status = 'reserved'`).run(nowIso, watcherId);
        database.prepare(`UPDATE price_watchers SET cadence = ?, state = 'baseline_pending', pause_reason = '', resolved_url = '', baseline_currency = '', baseline_amount_micros = NULL, baseline_raw = '', baseline_list_amount_micros = NULL, baseline_list_raw = '', baseline_observed_at = '', failure_streak = 0, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND workspace_id = ?`).run(cadence, nowIso, nowIso, watcherId, workspaceId);
        reserveBaseline(database, { workspaceId, watcherId, entitlement, nowIso });
      }
    } else {
      database.prepare(`UPDATE price_watchers SET cadence = ?, next_check_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
        .run(cadence, row.state === "active" ? nextPriceWatchCheck(cadence, now) : String(row.next_check_at || ""), nowIso, watcherId, workspaceId);
    }
    database.prepare(`INSERT INTO price_watch_audit_log (id, workspace_id, actor_user_id, action, target_tombstone, detail_json, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?)`)
      .run(randomUUID(), workspaceId, actorUserId, input.action ? `watcher.${input.action}` : "watcher.cadence", String(row.audit_target || randomUUID()), nowIso);
    const updated = database.prepare(`SELECT * FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(watcherId, workspaceId) as Record<string, unknown>;
    const result = { watcher: rowWatcher(updated), usage: usageForPeriod(database, workspaceId, entitlement || reconcilePriceWatchSubscription(database, workspaceId, now)) };
    if (command) recordMcpCommandReceipt(database, workspaceId, command.operation, command.commandId, result, now);
    return result;
  }).immediate();
}

export type PriceWatchDeletePreview = {
  watcherId: string;
  productName: string;
  rivalDomain: string;
  state: PriceWatchState;
  removes: { observations: number; reportLinks: number; notifications: number; pendingEmailDeliveries: number };
  consumedCreditsRemainCharged: true;
  impactFingerprint: string;
};

export function previewPriceWatchDelete(database: Database.Database, workspaceId: string, watcherId: string): PriceWatchDeletePreview {
  ensurePriceWatchSchema(database);
  const row = database.prepare(`SELECT * FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(watcherId, workspaceId) as Record<string, unknown> | undefined;
  if (!row) throw new PriceWatchStoreError("watcher-not-found", "Price watcher not found.", 404);
  const observations = database.prepare(`SELECT COUNT(*) AS count FROM price_watch_observations WHERE watcher_id = ?`).get(watcherId) as { count?: number };
  const links = database.prepare(`SELECT COUNT(*) AS count FROM price_watcher_report_links WHERE watcher_id = ?`).get(watcherId) as { count?: number };
  const notifications = database.prepare(`SELECT COUNT(*) AS count FROM workspace_notifications WHERE workspace_id = ? AND watcher_id = ?`).get(workspaceId, watcherId) as { count?: number };
  const deliveries = database.prepare(`SELECT COUNT(*) AS count FROM price_watch_email_outbox WHERE workspace_id = ? AND watcher_id = ? AND status != 'delivered'`).get(workspaceId, watcherId) as { count?: number };
  const removes = {
    observations: Number(observations.count || 0),
    reportLinks: Number(links.count || 0),
    notifications: Number(notifications.count || 0),
    pendingEmailDeliveries: Number(deliveries.count || 0),
  };
  const fingerprintInput = { watcherId, state: row.state, updatedAt: row.updated_at, removes };
  return {
    watcherId,
    productName: String(row.product_name || ""),
    rivalDomain: String(row.rival_domain || ""),
    state: String(row.state || "disabled") as PriceWatchState,
    removes,
    consumedCreditsRemainCharged: true,
    impactFingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex"),
  };
}

export function deletePriceWatcher(database: Database.Database, workspaceId: string, actorUserId: string, watcherId: string, now = new Date(), command?: PriceWatchCommandOptions): boolean {
  ensurePriceWatchSchema(database);
  if (command) ensureMcpCommandSchema(database);
  return database.transaction(() => {
    const receipt = command ? getMcpCommandReceipt(database, workspaceId, command.operation, command.commandId) : null;
    if (receipt) return receipt.deleted === true;
    const preview = previewPriceWatchDelete(database, workspaceId, watcherId);
    if (command?.expectedImpactFingerprint && command.expectedImpactFingerprint !== preview.impactFingerprint) {
      throw new PriceWatchStoreError("impact-changed", "Price-watch deletion impact changed. Preview the action again.", 409);
    }
    const row = database.prepare(`SELECT audit_target FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(watcherId, workspaceId) as { audit_target?: string } | undefined;
    if (!row) throw new PriceWatchStoreError("watcher-not-found", "Price watcher not found.", 404);
    const nowIso = now.toISOString();
    // Watcher deletion purges source-linked rows, but checks that crossed the
    // durable external-attempt boundary must remain charged. Roll those debits
    // into their immutable period entitlement before cascading the details.
    const debits = database.prepare(`SELECT period_start, period_end, COUNT(*) AS count FROM price_watch_credit_reservations WHERE watcher_id = ? AND status IN ('attempting','committed') GROUP BY period_start, period_end`)
      .all(watcherId) as Array<{ period_start: string; period_end: string; count: number }>;
    for (const debit of debits) {
      const preserved = database.prepare(`UPDATE price_watch_entitlements SET purged_used = purged_used + ?, updated_at = ? WHERE workspace_id = ? AND period_start = ? AND period_end = ?`)
        .run(Number(debit.count || 0), nowIso, workspaceId, debit.period_start, debit.period_end);
      if (preserved.changes !== 1) throw new Error("A consumed price-watch debit could not be preserved before deletion.");
    }
    if (command) recordMcpCommandReceipt(database, workspaceId, command.operation, command.commandId, { deleted: true }, now);
    const deleted = database.prepare(`DELETE FROM price_watchers WHERE id = ? AND workspace_id = ?`).run(watcherId, workspaceId);
    database.prepare(`INSERT INTO price_watch_audit_log (id, workspace_id, actor_user_id, action, target_tombstone, detail_json, created_at) VALUES (?, ?, ?, 'watcher.delete-permanent', ?, '{}', ?)`)
      .run(randomUUID(), workspaceId, actorUserId, String(row.audit_target || randomUUID()), nowIso);
    return deleted.changes === 1;
  }).immediate();
}

export type PriceWatchHistoryEntry = {
  id: string;
  kind: string;
  currency: string;
  amountMicros: number;
  raw: string;
  listAmountMicros: number | null;
  listRaw: string;
  observedAt: string;
};

export function priceWatchHistory(database: Database.Database, workspaceId: string, watcherId: string, limit = 100): PriceWatchHistoryEntry[] {
  ensurePriceWatchSchema(database);
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const exists = database.prepare(`SELECT id FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(watcherId, workspaceId);
  if (!exists) throw new PriceWatchStoreError("watcher-not-found", "Price watcher not found.", 404);
  const rows = database.prepare(`SELECT observations.* FROM price_watch_observations observations JOIN price_watchers watchers ON watchers.id = observations.watcher_id WHERE observations.watcher_id = ? AND watchers.workspace_id = ? ORDER BY observations.observed_at DESC, observations.id DESC LIMIT ?`)
    .all(watcherId, workspaceId, bounded) as Record<string, unknown>[];
  return rows.map((row) => {
    const list = Number(row.list_amount_micros);
    return {
      id: String(row.id || ""),
      kind: String(row.kind || ""),
      currency: String(row.currency || ""),
      amountMicros: Number(row.amount_micros || 0),
      raw: String(row.raw_price || ""),
      listAmountMicros: Number.isSafeInteger(list) && list > 0 ? list : null,
      listRaw: Number.isSafeInteger(list) && list > 0 ? String(row.raw_list_price || "") : "",
      observedAt: String(row.observed_at || ""),
    };
  });
}

export type WorkspaceNotification = {
  id: string;
  watcherId: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
};

export function listWorkspaceNotifications(database: Database.Database, workspaceId: string, userId: string, limit = 50): { unread: number; items: WorkspaceNotification[] } {
  ensurePriceWatchSchema(database);
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = database.prepare(`SELECT notifications.*, reads.read_at FROM workspace_notifications notifications LEFT JOIN workspace_notification_reads reads ON reads.notification_id = notifications.id AND reads.user_id = ? WHERE notifications.workspace_id = ? ORDER BY notifications.created_at DESC, notifications.id DESC LIMIT ?`)
    .all(userId, workspaceId, bounded) as Record<string, unknown>[];
  const unread = database.prepare(`SELECT COUNT(*) AS count FROM workspace_notifications notifications LEFT JOIN workspace_notification_reads reads ON reads.notification_id = notifications.id AND reads.user_id = ? WHERE notifications.workspace_id = ? AND reads.notification_id IS NULL`)
    .get(userId, workspaceId) as { count?: number } | undefined;
  return {
    unread: Number(unread?.count || 0),
    items: rows.map((row) => ({
      id: String(row.id || ""),
      watcherId: String(row.watcher_id || ""),
      type: String(row.notification_type || ""),
      title: String(row.title || ""),
      body: String(row.body || ""),
      createdAt: String(row.created_at || ""),
      read: Boolean(row.read_at),
    })),
  };
}

export function markWorkspaceNotificationsRead(database: Database.Database, workspaceId: string, userId: string, notificationIds: string[], now = new Date()): number {
  ensurePriceWatchSchema(database);
  const ids = [...new Set(notificationIds.map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 100);
  return database.transaction(() => ids.reduce((count, id) => {
    const inserted = database.prepare(`INSERT OR IGNORE INTO workspace_notification_reads (notification_id, user_id, read_at) SELECT id, ?, ? FROM workspace_notifications WHERE id = ? AND workspace_id = ?`)
      .run(userId, now.toISOString(), id, workspaceId);
    return count + inserted.changes;
  }, 0)).immediate();
}

function claimRow(row: Record<string, unknown>): PriceWatchClaim {
  const baselineAmount = Number(row.baseline_amount_micros);
  const listAmount = Number(row.baseline_list_amount_micros);
  return {
    reservationId: String(row.reservation_id || ""),
    dueSlot: String(row.due_slot || ""),
    watcherId: String(row.watcher_id || ""),
    workspaceId: String(row.workspace_id || ""),
    canonicalUrl: String(row.canonical_url || ""),
    resolvedUrl: String(row.resolved_url || ""),
    sourceDomain: String(row.source_domain || ""),
    rivalDomain: String(row.rival_domain || ""),
    productName: String(row.product_name || ""),
    variantKey: String(row.variant_key || ""),
    variantJson: String(row.variant_json || "{}"),
    cadence: row.cadence === "hourly" ? "hourly" : "daily",
    state: row.state === "baseline_pending" ? "baseline_pending" : "active",
    baseline: Number.isSafeInteger(baselineAmount) && baselineAmount > 0 ? {
      currency: String(row.baseline_currency || ""),
      amountMicros: baselineAmount,
      raw: String(row.baseline_raw || ""),
      listAmountMicros: Number.isSafeInteger(listAmount) && listAmount > 0 ? listAmount : null,
      listRaw: Number.isSafeInteger(listAmount) && listAmount > 0 ? String(row.baseline_list_raw || "") : "",
    } : null,
    claimOwner: String(row.reservation_claim_owner || ""),
    leaseExpiresAt: String(row.lease_expires_at || ""),
  };
}

function watcherFailureAfterUnknownAttempt(database: Database.Database, row: Record<string, unknown>, now: Date) {
  const watcherId = String(row.watcher_id || "");
  const workspaceId = String(row.workspace_id || "");
  const reservationId = String(row.reservation_id || "");
  const failures = Number(row.failure_streak || 0) + 1;
  const currentState = String(row.watcher_state || "active");
  const currentlyRunnable = ACTIVE_WATCHER_STATES.has(currentState);
  const currentPauseReason = String(row.pause_reason || "");
  const paused = currentlyRunnable && failures >= 3;
  const nowIso = now.toISOString();
  database.prepare(`UPDATE price_watch_credit_reservations SET status = 'committed', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE id = ? AND status = 'attempting'`).run(nowIso, reservationId);
  database.prepare(`UPDATE price_watchers SET state = ?, pause_reason = ?, failure_streak = ?, last_check_at = ?, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ?`)
    .run(paused ? "paused_failure" : currentState, paused ? "three-consecutive-failures" : (currentlyRunnable ? "" : currentPauseReason), failures, nowIso, nextPriceWatchCheck(row.cadence === "hourly" ? "hourly" : "daily", now), nowIso, watcherId);
  database.prepare(`INSERT OR IGNORE INTO price_watch_events (id, watcher_id, event_type, detail_json, idempotency_key, observed_at) VALUES (?, ?, 'unknown-attempt-outcome', ?, ?, ?)`)
    .run(randomUUID(), watcherId, JSON.stringify({ code: "expired-attempt-lease" }), `reservation:${reservationId}:unknown-outcome`, nowIso);
  if (paused) notification(database, {
    workspaceId,
    watcherId,
    type: "watcher-paused",
    title: "Price watch paused",
    body: `${cleanText(row.product_name, 120) || "A watched product"} paused after three consecutive validation failures.`,
    dedupeKey: `watcher:${watcherId}:paused-failure:${reservationId}`,
    nowIso,
  });
}

export function reapExpiredPriceWatchLeases(database: Database.Database, now = new Date()): { released: number; committedUnknown: number } {
  ensurePriceWatchSchema(database);
  return database.transaction(() => {
    const nowIso = now.toISOString();
    const rows = database.prepare(`SELECT reservations.id AS reservation_id, reservations.status, reservations.watcher_id, reservations.workspace_id, watchers.state AS watcher_state, watchers.pause_reason, watchers.failure_streak, watchers.cadence, watchers.product_name FROM price_watch_credit_reservations reservations JOIN price_watchers watchers ON watchers.id = reservations.watcher_id WHERE reservations.status IN ('reserved','attempting') AND reservations.lease_expires_at <> '' AND reservations.lease_expires_at <= ? ORDER BY reservations.lease_expires_at ASC`).all(nowIso) as Record<string, unknown>[];
    let released = 0;
    let committedUnknown = 0;
    for (const row of rows) {
      if (row.status === "reserved") {
        const result = database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE id = ? AND status = 'reserved' AND lease_expires_at <= ?`).run(nowIso, row.reservation_id, nowIso);
        if (result.changes) {
          database.prepare(`UPDATE price_watchers SET next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND claim_expires_at <= ?`).run(nowIso, nowIso, row.watcher_id, nowIso);
          released += 1;
        }
      } else {
        watcherFailureAfterUnknownAttempt(database, row, now);
        committedUnknown += 1;
      }
    }
    database.prepare(`UPDATE price_watch_credit_reservations SET claim_owner = '', lease_expires_at = '', updated_at = ? WHERE status IN ('committed','released') AND lease_expires_at <> '' AND lease_expires_at <= ?`).run(nowIso, nowIso);
    return { released, committedUnknown };
  }).immediate();
}

function reservationForClaim(database: Database.Database, watcher: Record<string, unknown>, entitlement: ActiveEntitlement, now: Date): Record<string, unknown> | null {
  const watcherId = String(watcher.id || "");
  if (watcher.state === "baseline_pending") {
    const baseline = database.prepare(`SELECT * FROM price_watch_credit_reservations WHERE watcher_id = ? AND due_slot LIKE 'baseline:%' ORDER BY created_at DESC LIMIT 1`)
      .get(watcherId) as Record<string, unknown> | undefined;
    if (baseline?.status === "reserved" && baseline.period_start === entitlement.periodStart && baseline.period_end === entitlement.periodEnd && !baseline.claim_owner) return baseline;
    if (baseline?.status === "released") {
      database.prepare(`UPDATE price_watch_credit_reservations SET workspace_id = ?, period_start = ?, period_end = ?, status = 'reserved', claim_owner = '', lease_expires_at = '', external_attempt_at = '', updated_at = ? WHERE id = ? AND status = 'released'`)
        .run(watcher.workspace_id, entitlement.periodStart, entitlement.periodEnd, now.toISOString(), baseline.id);
      return database.prepare(`SELECT * FROM price_watch_credit_reservations WHERE id = ?`).get(baseline.id) as Record<string, unknown>;
    }
  }
  const dueSlot = `scheduled:${String(watcher.next_check_at || now.toISOString())}`;
  const existing = database.prepare(`SELECT * FROM price_watch_credit_reservations WHERE watcher_id = ? AND due_slot = ? LIMIT 1`).get(watcherId, dueSlot) as Record<string, unknown> | undefined;
  const nowIso = now.toISOString();
  if (existing?.status === "released") {
    database.prepare(`UPDATE price_watch_credit_reservations SET workspace_id = ?, period_start = ?, period_end = ?, status = 'reserved', claim_owner = '', lease_expires_at = '', external_attempt_at = '', updated_at = ? WHERE id = ? AND status = 'released'`)
      .run(watcher.workspace_id, entitlement.periodStart, entitlement.periodEnd, nowIso, existing.id);
    return database.prepare(`SELECT * FROM price_watch_credit_reservations WHERE id = ?`).get(existing.id) as Record<string, unknown>;
  }
  if (existing) return null;
  const id = randomUUID();
  database.prepare(`INSERT INTO price_watch_credit_reservations (id, workspace_id, watcher_id, period_start, period_end, due_slot, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
    .run(id, watcher.workspace_id, watcherId, entitlement.periodStart, entitlement.periodEnd, dueSlot, nowIso, nowIso);
  return database.prepare(`SELECT * FROM price_watch_credit_reservations WHERE id = ?`).get(id) as Record<string, unknown>;
}

export function claimDuePriceWatchers(database: Database.Database, claimOwner: string, limit = 50, now = new Date()): PriceWatchClaim[] {
  ensurePriceWatchSchema(database);
  const owner = cleanText(claimOwner, 160);
  if (!owner) throw new Error("A price-watch claim owner is required.");
  const bounded = Math.min(50, Math.max(1, Math.trunc(limit)));
  return database.transaction(() => {
    reapExpiredPriceWatchLeases(database, now);
    const nowIso = now.toISOString();
    const candidates = database.prepare(`SELECT * FROM price_watchers WHERE state IN ('active','baseline_pending') AND next_check_at <= ? AND (claim_owner = '' OR claim_expires_at <= ?) ORDER BY next_check_at ASC, created_at ASC, id ASC LIMIT ?`)
      .all(nowIso, nowIso, bounded * 4) as Record<string, unknown>[];
    const claims: PriceWatchClaim[] = [];
    const leaseExpiresAt = new Date(now.getTime() + WATCHER_LEASE_MS).toISOString();
    for (const watcher of candidates) {
      if (claims.length >= bounded) break;
      const workspaceId = String(watcher.workspace_id || "");
      const entitlement = reconcilePriceWatchSubscription(database, workspaceId, now);
      if (!entitlement) continue;
      let reservation = watcher.state === "baseline_pending"
        ? database.prepare(`SELECT * FROM price_watch_credit_reservations WHERE watcher_id = ? AND period_start = ? AND period_end = ? AND status = 'reserved' AND claim_owner = '' AND due_slot LIKE 'baseline:%' ORDER BY created_at ASC LIMIT 1`).get(watcher.id, entitlement.periodStart, entitlement.periodEnd) as Record<string, unknown> | undefined
        : undefined;
      if (!reservation) {
        const usage = usageForPeriod(database, workspaceId, entitlement);
        if (usage.remaining < 1) {
          database.prepare(`UPDATE price_watchers SET state = 'paused_credits', pause_reason = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND state IN ('active','baseline_pending')`)
            .run(`credits:${entitlement.periodEnd}`, nowIso, watcher.id);
          notification(database, {
            workspaceId,
            watcherId: String(watcher.id || ""),
            type: "monitoring-credits-exhausted",
            title: "Monitoring credits used",
            body: `Price checks are paused until ${entitlement.periodEnd}.`,
            dedupeKey: `credits:${workspaceId}:${entitlement.periodEnd}`,
            nowIso,
          });
          continue;
        }
        reservation = reservationForClaim(database, watcher, entitlement, now) || undefined;
      }
      if (!reservation) continue;
      const reserved = database.prepare(`UPDATE price_watch_credit_reservations SET claim_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'reserved' AND claim_owner = ''`).run(owner, leaseExpiresAt, nowIso, reservation.id);
      if (reserved.changes !== 1) continue;
      const watcherClaim = database.prepare(`UPDATE price_watchers SET claim_owner = ?, claim_expires_at = ?, updated_at = ? WHERE id = ? AND state IN ('active','baseline_pending') AND (claim_owner = '' OR claim_expires_at <= ?)`)
        .run(owner, leaseExpiresAt, nowIso, watcher.id, nowIso);
      if (watcherClaim.changes !== 1) {
        database.prepare(`UPDATE price_watch_credit_reservations SET claim_owner = '', lease_expires_at = '', updated_at = ? WHERE id = ? AND status = 'reserved' AND claim_owner = ?`).run(nowIso, reservation.id, owner);
        continue;
      }
      claims.push(claimRow({
        ...watcher,
        reservation_id: reservation.id,
        due_slot: reservation.due_slot,
        reservation_claim_owner: owner,
        lease_expires_at: leaseExpiresAt,
        watcher_id: watcher.id,
      }));
    }
    return claims;
  }).immediate();
}

export function beginPriceWatchAttempt(database: Database.Database, claim: PriceWatchClaim, now = new Date()): boolean {
  ensurePriceWatchSchema(database);
  return database.transaction(() => {
    const nowIso = now.toISOString();
    const result = database.prepare(`UPDATE price_watch_credit_reservations SET status = 'attempting', external_attempt_at = ?, updated_at = ? WHERE id = ? AND watcher_id = ? AND status = 'reserved' AND claim_owner = ? AND lease_expires_at > ?`)
      .run(nowIso, nowIso, claim.reservationId, claim.watcherId, claim.claimOwner, nowIso);
    return result.changes === 1;
  }).immediate();
}

export function releasePriceWatchClaim(database: Database.Database, claim: PriceWatchClaim, reason: string, now = new Date()): boolean {
  ensurePriceWatchSchema(database);
  return database.transaction(() => {
    const nowIso = now.toISOString();
    const released = database.prepare(`UPDATE price_watch_credit_reservations SET status = 'released', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE id = ? AND watcher_id = ? AND status = 'reserved' AND claim_owner = ?`)
      .run(nowIso, claim.reservationId, claim.watcherId, claim.claimOwner);
    if (released.changes !== 1) return false;
    database.prepare(`UPDATE price_watchers SET next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ? AND claim_owner = ?`).run(nowIso, nowIso, claim.watcherId, claim.claimOwner);
    database.prepare(`INSERT OR IGNORE INTO price_watch_events (id, watcher_id, event_type, detail_json, idempotency_key, observed_at) VALUES (?, ?, 'internal-release', ?, ?, ?)`)
      .run(randomUUID(), claim.watcherId, JSON.stringify({ code: cleanText(reason, 100) }), `reservation:${claim.reservationId}:released`, nowIso);
    return true;
  }).immediate();
}

export type PriceWatchCheckOutcome =
  | { kind: "baseline" | "unchanged" | "change"; snapshot: PriceWatchPriceSnapshot; observedUrl: string }
  | { kind: "failure" | "confirmation_inconclusive"; code: string };

function snapshotEventType(previous: PriceWatchPriceSnapshot, current: PriceWatchPriceSnapshot) {
  if (current.amountMicros < previous.amountMicros) return "price-decreased";
  if (current.amountMicros > previous.amountMicros) return "price-increased";
  if (previous.listAmountMicros === null && current.listAmountMicros !== null) return "discount-started";
  if (previous.listAmountMicros !== null && current.listAmountMicros === null) return "discount-ended";
  return "discount-changed";
}

function priceLabel(snapshot: PriceWatchPriceSnapshot) {
  return `${snapshot.currency} ${(snapshot.amountMicros / 1_000_000).toLocaleString("en", { maximumFractionDigits: 6 })}`;
}

export function completePriceWatchClaim(database: Database.Database, claim: PriceWatchClaim, outcome: PriceWatchCheckOutcome, now = new Date()): { completed: boolean; paused: boolean; eventType: string } {
  ensurePriceWatchSchema(database);
  return database.transaction(() => {
    const nowIso = now.toISOString();
    const existing = database.prepare(`SELECT status FROM price_watch_credit_reservations WHERE id = ? AND watcher_id = ? LIMIT 1`).get(claim.reservationId, claim.watcherId) as { status?: string } | undefined;
    if (existing?.status === "committed") return { completed: true, paused: false, eventType: "replayed" };
    const committed = database.prepare(`UPDATE price_watch_credit_reservations SET status = 'committed', claim_owner = '', lease_expires_at = '', updated_at = ? WHERE id = ? AND watcher_id = ? AND status = 'attempting' AND claim_owner = ?`)
      .run(nowIso, claim.reservationId, claim.watcherId, claim.claimOwner);
    if (committed.changes !== 1) return { completed: false, paused: false, eventType: "" };
    const watcher = database.prepare(`SELECT * FROM price_watchers WHERE id = ? AND workspace_id = ? LIMIT 1`).get(claim.watcherId, claim.workspaceId) as Record<string, unknown> | undefined;
    if (!watcher) return { completed: false, paused: false, eventType: "" };
    const currentState = String(watcher.state || claim.state) as PriceWatchState;
    const currentlyRunnable = ACTIVE_WATCHER_STATES.has(currentState);
    const currentPauseReason = String(watcher.pause_reason || "");
    const currentCadence = watcher.cadence === "hourly" ? "hourly" : "daily";
    const nextCheckAt = nextPriceWatchCheck(currentCadence, now);
    if (outcome.kind === "failure" || outcome.kind === "confirmation_inconclusive") {
      const failures = Number(watcher.failure_streak || 0) + 1;
      const paused = currentlyRunnable && failures >= 3;
      const eventType = outcome.kind === "confirmation_inconclusive" ? "confirmation-inconclusive" : "check-failed";
      database.prepare(`UPDATE price_watchers SET state = ?, pause_reason = ?, failure_streak = ?, last_check_at = ?, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ?`)
        .run(paused ? "paused_failure" : currentState, paused ? "three-consecutive-failures" : (currentlyRunnable ? "" : currentPauseReason), failures, nowIso, nextCheckAt, nowIso, claim.watcherId);
      database.prepare(`INSERT OR IGNORE INTO price_watch_events (id, watcher_id, event_type, detail_json, idempotency_key, observed_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), claim.watcherId, eventType, JSON.stringify({ code: cleanText(outcome.code, 100), failureStreak: failures }), `reservation:${claim.reservationId}:${eventType}`, nowIso);
      if (paused) notification(database, {
        workspaceId: claim.workspaceId,
        watcherId: claim.watcherId,
        type: "watcher-paused",
        title: "Price watch paused",
        body: `${claim.productName} paused after three consecutive validation failures.`,
        dedupeKey: `watcher:${claim.watcherId}:paused-failure:${claim.reservationId}`,
        nowIso,
      });
      return { completed: true, paused, eventType };
    }
    if (!("snapshot" in outcome)) throw new Error("A completed price-watch outcome is missing its snapshot.");
    const snapshot = outcome.snapshot;
    if (outcome.kind === "baseline") {
      let canonicalUrl = claim.canonicalUrl;
      try {
        const finalTarget = canonicalPriceWatchUrl(outcome.observedUrl);
        if (finalTarget.domain === claim.sourceDomain) canonicalUrl = finalTarget.canonicalUrl;
      } catch { /* retain the validated requested URL */ }
      database.prepare(`UPDATE price_watchers SET resolved_url = ?, state = ?, pause_reason = ?, baseline_currency = ?, baseline_amount_micros = ?, baseline_raw = ?, baseline_list_amount_micros = ?, baseline_list_raw = ?, baseline_observed_at = ?, failure_streak = 0, last_check_at = ?, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ?`)
        .run(canonicalUrl, currentlyRunnable ? "active" : currentState, currentlyRunnable ? "" : currentPauseReason, snapshot.currency, snapshot.amountMicros, snapshot.raw, snapshot.listAmountMicros, snapshot.listRaw, nowIso, nowIso, nextCheckAt, nowIso, claim.watcherId);
      database.prepare(`INSERT OR IGNORE INTO price_watch_observations (id, watcher_id, reservation_id, kind, currency, amount_micros, raw_price, list_amount_micros, raw_list_price, observed_at) VALUES (?, ?, ?, 'baseline', ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), claim.watcherId, claim.reservationId, snapshot.currency, snapshot.amountMicros, snapshot.raw, snapshot.listAmountMicros, snapshot.listRaw, nowIso);
      return { completed: true, paused: false, eventType: "baseline" };
    }
    database.prepare(`UPDATE price_watchers SET state = ?, pause_reason = ?, failure_streak = 0, last_check_at = ?, next_check_at = ?, claim_owner = '', claim_expires_at = '', updated_at = ? WHERE id = ?`)
      .run(currentlyRunnable ? "active" : currentState, currentlyRunnable ? "" : currentPauseReason, nowIso, nextCheckAt, nowIso, claim.watcherId);
    if (outcome.kind === "unchanged") return { completed: true, paused: false, eventType: "unchanged" };
    const previous = claim.baseline;
    if (!previous) throw new Error("A price change requires a persisted baseline.");
    const eventType = snapshotEventType(previous, snapshot);
    const eventId = randomUUID();
    database.prepare(`UPDATE price_watchers SET baseline_currency = ?, baseline_amount_micros = ?, baseline_raw = ?, baseline_list_amount_micros = ?, baseline_list_raw = ?, baseline_observed_at = ? WHERE id = ?`)
      .run(snapshot.currency, snapshot.amountMicros, snapshot.raw, snapshot.listAmountMicros, snapshot.listRaw, nowIso, claim.watcherId);
    database.prepare(`INSERT OR IGNORE INTO price_watch_observations (id, watcher_id, reservation_id, kind, currency, amount_micros, raw_price, list_amount_micros, raw_list_price, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), claim.watcherId, claim.reservationId, eventType, snapshot.currency, snapshot.amountMicros, snapshot.raw, snapshot.listAmountMicros, snapshot.listRaw, nowIso);
    database.prepare(`INSERT OR IGNORE INTO price_watch_events (id, watcher_id, event_type, detail_json, idempotency_key, observed_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(eventId, claim.watcherId, eventType, JSON.stringify({ previous, current: snapshot }), `reservation:${claim.reservationId}:change`, nowIso);
    if (currentlyRunnable) {
      notification(database, {
        workspaceId: claim.workspaceId,
        watcherId: claim.watcherId,
        type: eventType,
        title: `${claim.productName} price changed`,
        body: `${priceLabel(previous)} → ${priceLabel(snapshot)}`,
        dedupeKey: `watcher:${claim.watcherId}:change:${claim.reservationId}`,
        nowIso,
      });
      database.prepare(`INSERT OR IGNORE INTO price_watch_email_outbox (id, workspace_id, watcher_id, recipient_user_id, event_id, status, batch_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(randomUUID(), claim.workspaceId, claim.watcherId, watcher.email_owner_user_id || null, eventId, new Date(now.getTime() + 15 * 60 * 1_000).toISOString(), nowIso, nowIso);
    }
    return { completed: true, paused: false, eventType };
  }).immediate();
}
