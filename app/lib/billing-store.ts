import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalNodeSqlitePath } from "./node-sqlite-database.ts";
import { BILLING_PLANS, type BillingPlan } from "./billing-plans.ts";
import { PRODUCT_PLAN_LIMITS, type ProductPlan } from "./product-entitlements.ts";
import { ensurePriceWatchSchema, reconcilePriceWatchSubscription } from "./price-watch-store.ts";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
// A full Agency report can span multiple 52-minute worker attempts. Keep the
// reservation beyond that bounded retry window; genuinely abandoned rows are
// still reclaimed on a later reservation.
const RESERVATION_TTL_MS = 4 * 60 * 60 * 1_000;
const INTERNAL_DAILY_COMPARISON_LIMIT_MAX = 100_000;
const INTERNAL_TARGETS = new Set<number>(Object.values(PRODUCT_PLAN_LIMITS));

export type WorkspaceSubscription = {
  workspaceId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  planTier: ProductPlan | "";
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
};

export type SubscriptionUpdate = WorkspaceSubscription & {
  eventId: string;
  eventType: string;
  eventCreated: number;
};

export type InternalReportEntitlement = {
  workspaceId: string;
  enabled: boolean;
  maxComparisonTarget: number;
  dailyComparisonLimit: number;
  createdAt: string;
  updatedAt: string;
};

export class ReportReservationConflictError extends Error {
  constructor(message = "The report command id is already bound to different work.") {
    super(message);
    this.name = "ReportReservationConflictError";
  }
}

export async function openBillingDatabase(databasePath = String(process.env.MARKET_SIGNAL_SQLITE_PATH || "").trim()) {
  if (!databasePath) throw new Error("Billing storage is not configured.");
  const canonicalPath = await canonicalNodeSqlitePath(databasePath);
  const database = new Database(canonicalPath);
  database.pragma("busy_timeout = 10000");
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  ensureBillingSchema(database);
  return database;
}

export function ensureBillingSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workspace_subscriptions (
      workspace_id text PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      stripe_customer_id text NOT NULL UNIQUE,
      stripe_subscription_id text NOT NULL DEFAULT '',
      stripe_price_id text NOT NULL DEFAULT '',
      plan_tier text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'incomplete',
      cancel_at_period_end integer NOT NULL DEFAULT 0,
      current_period_start text NOT NULL DEFAULT '',
      current_period_end text NOT NULL DEFAULT '',
      last_event_created integer NOT NULL DEFAULT 0,
      last_event_id text NOT NULL DEFAULT '',
      updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_subscriptions_subscription_uidx
      ON workspace_subscriptions(stripe_subscription_id) WHERE stripe_subscription_id != '';
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id text PRIMARY KEY NOT NULL,
      event_type text NOT NULL,
      event_created integer NOT NULL,
      processed_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_report_reservations (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      command_id text NOT NULL DEFAULT '',
      entitlement_source text NOT NULL DEFAULT 'subscription',
      plan_tier text NOT NULL DEFAULT '',
      comparison_target integer NOT NULL DEFAULT 0,
      period_start text NOT NULL,
      period_end text NOT NULL,
      status text NOT NULL CHECK(status IN ('reserved','committed','released')),
      run_id text NOT NULL DEFAULT '',
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_report_reservations_run_uidx
      ON billing_report_reservations(run_id) WHERE run_id != '';
    CREATE INDEX IF NOT EXISTS billing_report_reservations_usage_idx
      ON billing_report_reservations(workspace_id, period_start, period_end, status);
    CREATE TABLE IF NOT EXISTS internal_report_entitlements (
      workspace_id text PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      enabled integer NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      max_comparison_target integer NOT NULL CHECK(max_comparison_target IN (20, 50, 500, 1000)),
      daily_comparison_limit integer NOT NULL CHECK(daily_comparison_limit >= max_comparison_target AND daily_comparison_limit <= 100000),
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
  `);
  const reservationColumns = database.prepare(`PRAGMA table_info(billing_report_reservations)`).all() as Array<{ name?: string }>;
  if (!reservationColumns.some((column) => column.name === "command_id")) {
    database.exec(`ALTER TABLE billing_report_reservations ADD COLUMN command_id text NOT NULL DEFAULT ''`);
  }
  if (!reservationColumns.some((column) => column.name === "entitlement_source")) {
    database.exec(`ALTER TABLE billing_report_reservations ADD COLUMN entitlement_source text NOT NULL DEFAULT 'subscription'`);
  }
  if (!reservationColumns.some((column) => column.name === "plan_tier")) {
    database.exec(`ALTER TABLE billing_report_reservations ADD COLUMN plan_tier text NOT NULL DEFAULT ''`);
  }
  if (!reservationColumns.some((column) => column.name === "comparison_target")) {
    database.exec(`ALTER TABLE billing_report_reservations ADD COLUMN comparison_target integer NOT NULL DEFAULT 0`);
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS billing_report_reservations_command_uidx ON billing_report_reservations(command_id) WHERE command_id != ''`);
  database.exec(`CREATE INDEX IF NOT EXISTS billing_report_reservations_internal_usage_idx ON billing_report_reservations(workspace_id, entitlement_source, period_start, period_end)`);
  const workspaceColumns = database.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name?: string }>;
  if (workspaceColumns.some((column) => column.name === "kind")) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS workspace_subscriptions_reject_shopify_insert
        BEFORE INSERT ON workspace_subscriptions
        WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND kind = 'shopify')
        BEGIN SELECT RAISE(ABORT, 'Shopify workspaces cannot use Stripe subscriptions'); END;
      CREATE TRIGGER IF NOT EXISTS workspace_subscriptions_reject_shopify_update
        BEFORE UPDATE OF workspace_id ON workspace_subscriptions
        WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND kind = 'shopify')
        BEGIN SELECT RAISE(ABORT, 'Shopify workspaces cannot use Stripe subscriptions'); END;
      CREATE TRIGGER IF NOT EXISTS workspaces_reject_shopify_kind_with_stripe
        BEFORE UPDATE OF kind ON workspaces
        WHEN NEW.kind = 'shopify' AND EXISTS (
          SELECT 1 FROM workspace_subscriptions WHERE workspace_id = NEW.id
        )
        BEGIN SELECT RAISE(ABORT, 'Stripe subscription workspaces cannot become Shopify workspaces'); END;
    `);
  }
  ensurePriceWatchSchema(database);
}

function rowToSubscription(row: Record<string, unknown> | undefined): WorkspaceSubscription | null {
  if (!row) return null;
  return {
    workspaceId: String(row.workspace_id || ""),
    stripeCustomerId: String(row.stripe_customer_id || ""),
    stripeSubscriptionId: String(row.stripe_subscription_id || ""),
    stripePriceId: String(row.stripe_price_id || ""),
    planTier: String(row.plan_tier || "") as ProductPlan | "",
    status: String(row.status || ""),
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
    currentPeriodStart: String(row.current_period_start || ""),
    currentPeriodEnd: String(row.current_period_end || ""),
  };
}

export function getWorkspaceSubscription(database: Database.Database, workspaceId: string): WorkspaceSubscription | null {
  return rowToSubscription(database.prepare("SELECT * FROM workspace_subscriptions WHERE workspace_id = ?").get(workspaceId) as Record<string, unknown> | undefined);
}

export function activeWorkspacePlan(database: Database.Database, workspaceId: string, now = new Date()): BillingPlan | null {
  const subscription = getWorkspaceSubscription(database, workspaceId);
  const plan = subscription?.planTier ? BILLING_PLANS[subscription.planTier] : null;
  if (!subscription || !plan || !ACTIVE_STATUSES.has(subscription.status) || !subscription.currentPeriodStart || !subscription.currentPeriodEnd) return null;
  const nowIso = now.toISOString();
  return nowIso >= subscription.currentPeriodStart && nowIso < subscription.currentPeriodEnd ? plan : null;
}

export function getSubscriptionByCustomer(database: Database.Database, customerId: string): WorkspaceSubscription | null {
  return rowToSubscription(database.prepare("SELECT * FROM workspace_subscriptions WHERE stripe_customer_id = ?").get(customerId) as Record<string, unknown> | undefined);
}

export function saveWorkspaceCustomer(database: Database.Database, workspaceId: string, customerId: string, now = new Date()): void {
  database.prepare(`
    INSERT INTO workspace_subscriptions (workspace_id, stripe_customer_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      updated_at = excluded.updated_at
  `).run(workspaceId, customerId, now.toISOString());
}

export function applySubscriptionUpdate(database: Database.Database, update: SubscriptionUpdate, now = new Date()): "applied" | "duplicate" | "stale" | "ignored" {
  return database.transaction(() => {
    const inserted = database.prepare(`INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, event_created, processed_at) VALUES (?, ?, ?, ?)`)
      .run(update.eventId, update.eventType, update.eventCreated, now.toISOString());
    if (inserted.changes === 0) return "duplicate" as const;
    const existing = database.prepare("SELECT last_event_created, stripe_subscription_id, status FROM workspace_subscriptions WHERE workspace_id = ?").get(update.workspaceId) as { last_event_created?: number; stripe_subscription_id?: string; status?: string } | undefined;
    if (existing && Number(existing.last_event_created || 0) > update.eventCreated) return "stale" as const;
    if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== update.stripeSubscriptionId && !ACTIVE_STATUSES.has(update.status)) return "ignored" as const;
    if (existing && Number(existing.last_event_created || 0) === update.eventCreated && ACTIVE_STATUSES.has(String(existing.status || "")) && !ACTIVE_STATUSES.has(update.status)) return "stale" as const;
    database.prepare(`
      INSERT INTO workspace_subscriptions (
        workspace_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan_tier,
        status, cancel_at_period_end, current_period_start, current_period_end,
        last_event_created, last_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_price_id = excluded.stripe_price_id,
        plan_tier = excluded.plan_tier,
        status = excluded.status,
        cancel_at_period_end = excluded.cancel_at_period_end,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        last_event_created = excluded.last_event_created,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `).run(
      update.workspaceId, update.stripeCustomerId, update.stripeSubscriptionId,
      update.stripePriceId, update.planTier, update.status, update.cancelAtPeriodEnd ? 1 : 0,
      update.currentPeriodStart, update.currentPeriodEnd, update.eventCreated, update.eventId,
      now.toISOString(),
    );
    reconcilePriceWatchSubscription(database, update.workspaceId, now);
    return "applied" as const;
  }).immediate();
}

export function recordWebhookEvent(database: Database.Database, eventId: string, eventType: string, eventCreated: number, now = new Date()): boolean {
  const result = database.prepare(`INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, event_created, processed_at) VALUES (?, ?, ?, ?)`)
    .run(eventId, eventType, eventCreated, now.toISOString());
  return result.changes === 1;
}

function internalEntitlementFromRow(row: Record<string, unknown> | undefined): InternalReportEntitlement | null {
  if (!row) return null;
  return {
    workspaceId: String(row.workspace_id || ""),
    enabled: Number(row.enabled) === 1,
    maxComparisonTarget: Number(row.max_comparison_target || 0),
    dailyComparisonLimit: Number(row.daily_comparison_limit || 0),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export function getInternalReportEntitlement(database: Database.Database, workspaceId: string): InternalReportEntitlement | null {
  const workspaceColumns = database.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name?: string }>;
  if (!workspaceColumns.some((column) => column.name === "kind")) return null;
  return internalEntitlementFromRow(database.prepare(`
    SELECT entitlement.*
    FROM internal_report_entitlements AS entitlement
    JOIN workspaces AS workspace ON workspace.id = entitlement.workspace_id
    WHERE entitlement.workspace_id = ? AND workspace.kind = 'internal'
    LIMIT 1
  `).get(workspaceId) as Record<string, unknown> | undefined);
}

export function setInternalReportEntitlement(
  database: Database.Database,
  workspaceId: string,
  input: { enabled: boolean; maxComparisonTarget: number; dailyComparisonLimit: number },
  now = new Date(),
): InternalReportEntitlement {
  if (!workspaceId || !INTERNAL_TARGETS.has(input.maxComparisonTarget)) throw new Error("Invalid internal report entitlement target.");
  if (!Number.isSafeInteger(input.dailyComparisonLimit)
    || input.dailyComparisonLimit < input.maxComparisonTarget
    || input.dailyComparisonLimit > INTERNAL_DAILY_COMPARISON_LIMIT_MAX) {
    throw new Error("Invalid internal report entitlement daily limit.");
  }
  const workspaceColumns = database.prepare(`PRAGMA table_info(workspaces)`).all() as Array<{ name?: string }>;
  if (!workspaceColumns.some((column) => column.name === "kind")
    || !(database.prepare(`SELECT 1 AS found FROM workspaces WHERE id = ? AND kind = 'internal' LIMIT 1`).get(workspaceId))) {
    throw new Error("Internal report entitlements require an internal workspace.");
  }
  const updatedAt = now.toISOString();
  database.prepare(`
    INSERT INTO internal_report_entitlements (
      workspace_id, enabled, max_comparison_target, daily_comparison_limit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      enabled = excluded.enabled,
      max_comparison_target = excluded.max_comparison_target,
      daily_comparison_limit = excluded.daily_comparison_limit,
      updated_at = excluded.updated_at
  `).run(workspaceId, input.enabled ? 1 : 0, input.maxComparisonTarget, input.dailyComparisonLimit, updatedAt, updatedAt);
  const entitlement = getInternalReportEntitlement(database, workspaceId);
  if (!entitlement) throw new Error("Internal report entitlement was not persisted.");
  return entitlement;
}

export type ReportReservation = {
  id: string;
  plan: BillingPlan;
  used: number;
  limit: number;
  quotaKind: "reports" | "comparisons";
  denialReason?: "daily-limit" | "target-limit";
  maxComparisonTarget?: number;
};

function utcDay(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function planForComparisonTarget(target: number): BillingPlan {
  const plan = Object.values(BILLING_PLANS).find((candidate) => candidate.productLimit === target);
  if (!plan) throw new Error("Invalid internal report comparison target.");
  return plan;
}

type ReservationRow = {
  id: string;
  workspace_id: string;
  command_id: string;
  entitlement_source: string;
  plan_tier: string;
  comparison_target: number;
  period_start: string;
  period_end: string;
  status: string;
};

function commandReservation(database: Database.Database, commandId: string) {
  if (!commandId) return undefined;
  return database.prepare(`
    SELECT id, workspace_id, command_id, entitlement_source, plan_tier,
      comparison_target, period_start, period_end, status
    FROM billing_report_reservations WHERE command_id = ? LIMIT 1
  `).get(commandId) as ReservationRow | undefined;
}

function reserveInternalReport(
  database: Database.Database,
  entitlement: InternalReportEntitlement,
  now: Date,
  commandId: string,
  requestedComparisonTarget: number | undefined,
): ReportReservation {
  const target = requestedComparisonTarget === undefined ? PRODUCT_PLAN_LIMITS.starter : requestedComparisonTarget;
  if (!INTERNAL_TARGETS.has(target)) throw new Error("Invalid internal report comparison target.");
  const existing = commandReservation(database, commandId);
  if (existing) {
    if (existing.workspace_id !== entitlement.workspaceId
      || existing.entitlement_source !== "internal"
      || Number(existing.comparison_target) !== target) {
      throw new ReportReservationConflictError();
    }
  }
  const period = utcDay(now);
  const usage = database.prepare(`
    SELECT coalesce(sum(comparison_target), 0) AS total
    FROM billing_report_reservations
    WHERE workspace_id = ? AND entitlement_source = 'internal'
      AND period_start = ? AND period_end = ?
  `).get(entitlement.workspaceId, period.start, period.end) as { total: number };
  const used = Number(usage.total || 0);
  if (existing) {
    const plan = planForComparisonTarget(Number(existing.comparison_target));
    return { id: existing.id, plan, used, limit: entitlement.dailyComparisonLimit, quotaKind: "comparisons" };
  }
  const plan = planForComparisonTarget(target);
  if (target > entitlement.maxComparisonTarget) {
    return {
      id: "", plan, used, limit: entitlement.dailyComparisonLimit, quotaKind: "comparisons",
      denialReason: "target-limit", maxComparisonTarget: entitlement.maxComparisonTarget,
    };
  }
  if (used + target > entitlement.dailyComparisonLimit) {
    return { id: "", plan, used, limit: entitlement.dailyComparisonLimit, quotaKind: "comparisons", denialReason: "daily-limit" };
  }
  const id = randomUUID();
  const nowIso = now.toISOString();
  database.prepare(`
    INSERT INTO billing_report_reservations (
      id, workspace_id, command_id, entitlement_source, plan_tier,
      comparison_target, period_start, period_end, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'internal', ?, ?, ?, ?, 'reserved', ?, ?)
  `).run(id, entitlement.workspaceId, commandId, plan.id, target, period.start, period.end, nowIso, nowIso);
  return { id, plan, used: used + target, limit: entitlement.dailyComparisonLimit, quotaKind: "comparisons" };
}

export function reserveReport(
  database: Database.Database,
  workspaceId: string,
  now = new Date(),
  commandId = "",
  requestedComparisonTarget?: number,
): ReportReservation | null {
  if (commandId && !/^[A-Za-z0-9:_-]{1,120}$/.test(commandId)) throw new Error("Invalid report command id.");
  return database.transaction((): ReportReservation | null => {
    const internalEntitlement = getInternalReportEntitlement(database, workspaceId);
    if (internalEntitlement?.enabled) {
      return reserveInternalReport(database, internalEntitlement, now, commandId, requestedComparisonTarget);
    }
    const subscription = getWorkspaceSubscription(database, workspaceId);
    const plan = activeWorkspacePlan(database, workspaceId, now);
    if (!subscription || !plan) return null;
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    database.prepare(`UPDATE billing_report_reservations SET status = 'released', updated_at = ? WHERE workspace_id = ? AND entitlement_source = 'subscription' AND status = 'reserved' AND created_at < ?`)
      .run(nowIso, workspaceId, staleBefore);
    const existing = commandReservation(database, commandId);
    const usage = database.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations WHERE workspace_id = ? AND entitlement_source = 'subscription' AND period_start = ? AND period_end = ? AND status IN ('reserved','committed')`)
      .get(workspaceId, subscription.currentPeriodStart, subscription.currentPeriodEnd) as { count: number };
    const used = Number(usage.count || 0);
    if (existing) {
      if (existing.workspace_id !== workspaceId || existing.entitlement_source !== "subscription" || existing.period_start !== subscription.currentPeriodStart || existing.period_end !== subscription.currentPeriodEnd || !["reserved", "committed"].includes(existing.status)) {
        throw new ReportReservationConflictError("The report command reservation is no longer reusable.");
      }
      return { id: existing.id, plan, used, limit: plan.reportsPerMonth, quotaKind: "reports" };
    }
    if (used >= plan.reportsPerMonth) return { id: "", plan, used, limit: plan.reportsPerMonth, quotaKind: "reports", denialReason: "daily-limit" };
    const id = randomUUID();
    database.prepare(`INSERT INTO billing_report_reservations (id, workspace_id, command_id, entitlement_source, plan_tier, comparison_target, period_start, period_end, status, created_at, updated_at) VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, 'reserved', ?, ?)`)
      .run(id, workspaceId, commandId, plan.id, plan.productLimit, subscription.currentPeriodStart, subscription.currentPeriodEnd, nowIso, nowIso);
    return { id, plan, used: used + 1, limit: plan.reportsPerMonth, quotaKind: "reports" };
  }).immediate();
}

export function finishReportReservation(database: Database.Database, reservationId: string, outcome: "committed" | "released", runId = "", now = new Date()): boolean {
  if (outcome === "committed") {
    const result = database.prepare(`UPDATE billing_report_reservations SET status = 'committed', run_id = ?, updated_at = ? WHERE id = ? AND status = 'reserved'`)
      .run(runId, now.toISOString(), reservationId);
    if (result.changes === 1) return true;
    const existing = database.prepare(`SELECT status, run_id FROM billing_report_reservations WHERE id = ? LIMIT 1`).get(reservationId) as { status?: string; run_id?: string } | undefined;
    return existing?.status === "committed" && existing.run_id === runId;
  }
  const result = database.prepare(`UPDATE billing_report_reservations SET status = 'released', run_id = '', updated_at = ? WHERE id = ? AND status = 'reserved'`)
    .run(now.toISOString(), reservationId);
  if (result.changes === 1) return true;
  const existing = database.prepare(`SELECT status FROM billing_report_reservations WHERE id = ? LIMIT 1`).get(reservationId) as { status?: string } | undefined;
  return existing?.status === "released";
}

export function hasReportCommandReservation(database: Database.Database, workspaceId: string, commandId: string): boolean {
  if (!commandId) return false;
  const row = database.prepare(`SELECT 1 AS found FROM billing_report_reservations WHERE workspace_id = ? AND command_id = ? AND status IN ('reserved','committed') LIMIT 1`)
    .get(workspaceId, commandId) as { found?: number } | undefined;
  return row?.found === 1;
}

export function workspaceUsage(database: Database.Database, workspaceId: string, excludingCommandId = ""): { used: number; limit: number } {
  const subscription = getWorkspaceSubscription(database, workspaceId);
  const plan = subscription?.planTier ? BILLING_PLANS[subscription.planTier] : null;
  if (!subscription || !plan) return { used: 0, limit: 0 };
  const row = database.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations WHERE workspace_id = ? AND period_start = ? AND period_end = ? AND status IN ('reserved','committed')`)
    .get(workspaceId, subscription.currentPeriodStart, subscription.currentPeriodEnd) as { count: number };
  const ownReservation = excludingCommandId
    ? database.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations WHERE workspace_id = ? AND command_id = ? AND period_start = ? AND period_end = ? AND status IN ('reserved','committed')`)
      .get(workspaceId, excludingCommandId, subscription.currentPeriodStart, subscription.currentPeriodEnd) as { count: number }
    : { count: 0 };
  return { used: Math.max(0, Number(row.count || 0) - Number(ownReservation.count || 0)), limit: plan.reportsPerMonth };
}
