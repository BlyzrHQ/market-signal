import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalNodeSqlitePath } from "./node-sqlite-database.ts";
import { BILLING_PLANS, type BillingPlan } from "./billing-plans.ts";
import type { ProductPlan } from "./product-entitlements.ts";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const RESERVATION_TTL_MS = 30 * 60 * 1_000;

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
  `);
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
    return "applied" as const;
  }).immediate();
}

export function recordWebhookEvent(database: Database.Database, eventId: string, eventType: string, eventCreated: number, now = new Date()): boolean {
  const result = database.prepare(`INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, event_created, processed_at) VALUES (?, ?, ?, ?)`)
    .run(eventId, eventType, eventCreated, now.toISOString());
  return result.changes === 1;
}

export type ReportReservation = { id: string; plan: BillingPlan; used: number; limit: number };

export function reserveReport(database: Database.Database, workspaceId: string, now = new Date()): ReportReservation | null {
  return database.transaction(() => {
    const subscription = getWorkspaceSubscription(database, workspaceId);
    const plan = subscription?.planTier ? BILLING_PLANS[subscription.planTier] : null;
    if (!subscription || !plan || !ACTIVE_STATUSES.has(subscription.status) || !subscription.currentPeriodStart || !subscription.currentPeriodEnd) return null;
    const nowIso = now.toISOString();
    if (nowIso < subscription.currentPeriodStart || nowIso >= subscription.currentPeriodEnd) return null;
    const staleBefore = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    database.prepare(`UPDATE billing_report_reservations SET status = 'released', updated_at = ? WHERE workspace_id = ? AND status = 'reserved' AND created_at < ?`)
      .run(nowIso, workspaceId, staleBefore);
    const usage = database.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations WHERE workspace_id = ? AND period_start = ? AND period_end = ? AND status IN ('reserved','committed')`)
      .get(workspaceId, subscription.currentPeriodStart, subscription.currentPeriodEnd) as { count: number };
    const used = Number(usage.count || 0);
    if (used >= plan.reportsPerMonth) return { id: "", plan, used, limit: plan.reportsPerMonth };
    const id = randomUUID();
    database.prepare(`INSERT INTO billing_report_reservations (id, workspace_id, period_start, period_end, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?)`)
      .run(id, workspaceId, subscription.currentPeriodStart, subscription.currentPeriodEnd, nowIso, nowIso);
    return { id, plan, used: used + 1, limit: plan.reportsPerMonth };
  }).immediate();
}

export function finishReportReservation(database: Database.Database, reservationId: string, outcome: "committed" | "released", runId = "", now = new Date()): void {
  database.prepare(`UPDATE billing_report_reservations SET status = ?, run_id = ?, updated_at = ? WHERE id = ? AND status = 'reserved'`)
    .run(outcome, outcome === "committed" ? runId : "", now.toISOString(), reservationId);
}

export function workspaceUsage(database: Database.Database, workspaceId: string): { used: number; limit: number } {
  const subscription = getWorkspaceSubscription(database, workspaceId);
  const plan = subscription?.planTier ? BILLING_PLANS[subscription.planTier] : null;
  if (!subscription || !plan) return { used: 0, limit: 0 };
  const row = database.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations WHERE workspace_id = ? AND period_start = ? AND period_end = ? AND status IN ('reserved','committed')`)
    .get(workspaceId, subscription.currentPeriodStart, subscription.currentPeriodEnd) as { count: number };
  return { used: Number(row.count || 0), limit: plan.reportsPerMonth };
}
