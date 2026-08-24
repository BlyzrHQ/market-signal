import Database from "better-sqlite3";

import { applySubscriptionUpdate, ensureBillingSchema } from "../../app/lib/billing-store.ts";

export const PRICE_WATCH_WORKSPACE_ID = "workspace-1";
export const PRICE_WATCH_USER_ID = "user-1";
export const PRICE_WATCH_PUBLIC_ID = "a".repeat(32);
export const PRICE_WATCH_MATCH_ID = "1".repeat(64);
export const PRICE_WATCH_NOW = new Date("2026-08-24T12:00:00.000Z");

export function priceWatchSubscription(overrides = {}) {
  return {
    workspaceId: PRICE_WATCH_WORKSPACE_ID,
    stripeCustomerId: "cus_price_watch_fixture",
    stripeSubscriptionId: "sub_price_watch_fixture",
    stripePriceId: "price_starter",
    planTier: "starter",
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    eventId: "evt_price_watch_fixture",
    eventType: "customer.subscription.created",
    eventCreated: 100,
    ...overrides,
  };
}

export function openPriceWatchFixture(path = ":memory:", options = {}) {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'owner',
      created_at text NOT NULL,
      PRIMARY KEY(workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS report_runs (
      id text PRIMARY KEY NOT NULL,
      public_id text NOT NULL UNIQUE,
      primary_domain text NOT NULL,
      workspace_id text NOT NULL DEFAULT '',
      expires_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_products (
      run_id text NOT NULL,
      domain text NOT NULL,
      product_id text NOT NULL,
      name text NOT NULL,
      source_url text NOT NULL,
      price_json text NOT NULL DEFAULT '[]',
      metadata_json text NOT NULL DEFAULT '{}',
      PRIMARY KEY(run_id, domain, product_id)
    );
    CREATE TABLE IF NOT EXISTS report_matches (
      id text PRIMARY KEY NOT NULL,
      run_id text NOT NULL,
      primary_product_id text NOT NULL,
      rival_product_id text NOT NULL,
      rival_domain text NOT NULL,
      evidence_json text NOT NULL
    );
  `);
  database.prepare(`INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, 'Owner', 'owner@example.com')`).run(PRICE_WATCH_USER_ID);
  database.prepare(`INSERT OR IGNORE INTO workspaces(id) VALUES (?)`).run(PRICE_WATCH_WORKSPACE_ID);
  database.prepare(`INSERT OR IGNORE INTO workspace_members(workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
    .run(PRICE_WATCH_WORKSPACE_ID, PRICE_WATCH_USER_ID, PRICE_WATCH_NOW.toISOString());
  ensureBillingSchema(database);
  const hasSubscription = database.prepare(`SELECT workspace_id FROM workspace_subscriptions WHERE workspace_id = ?`).get(PRICE_WATCH_WORKSPACE_ID);
  if (!hasSubscription && options.subscription !== false) {
    applySubscriptionUpdate(database, priceWatchSubscription(options.subscription || {}), PRICE_WATCH_NOW);
  }
  return database;
}

export function addPriceWatchReport(database, options = {}) {
  const workspaceId = options.workspaceId ?? PRICE_WATCH_WORKSPACE_ID;
  const publicId = options.publicId ?? PRICE_WATCH_PUBLIC_ID;
  const runId = options.runId ?? `run-${publicId.slice(0, 8)}`;
  const expiresAt = options.expiresAt ?? "2026-09-24T00:00:00.000Z";
  const matchId = options.matchId ?? PRICE_WATCH_MATCH_ID;
  const sourceUrl = options.sourceUrl ?? "https://rival.example/products/tea?sku=server&utm_source=fixture";
  const priceSignals = options.priceSignals ?? [{ raw: "GBP 12.50", currency: "GBP", amount: 12.5 }];
  const priceEligible = options.priceEligible ?? true;
  database.prepare(`INSERT INTO report_runs (id, public_id, primary_domain, workspace_id, expires_at) VALUES (?, ?, 'primary.example', ?, ?)`)
    .run(runId, publicId, workspaceId, expiresAt);
  database.prepare(`INSERT INTO report_products (run_id, domain, product_id, name, source_url, price_json, metadata_json) VALUES (?, 'primary.example', 'primary-1', 'Primary tea', 'https://primary.example/tea', '[{"raw":"GBP 10","currency":"GBP","amount":10}]', '{}')`)
    .run(runId);
  database.prepare(`INSERT INTO report_products (run_id, domain, product_id, name, source_url, price_json, metadata_json) VALUES (?, 'rival.example', 'rival-1', 'Rival tea 500g', ?, ?, ?)`)
    .run(runId, sourceUrl, JSON.stringify(priceSignals), JSON.stringify({ quantity: { kind: "mass", amount: 500, unit: "g" } }));
  database.prepare(`INSERT INTO report_matches (id, run_id, primary_product_id, rival_product_id, rival_domain, evidence_json) VALUES (?, ?, 'primary-1', 'rival-1', 'rival.example', ?)`)
    .run(matchId, runId, JSON.stringify({ publication: { priceEligible }, rivalSourceUrl: sourceUrl, normalizedVariant: "Original", normalizedSize: "500 g" }));
  return { runId, publicId, matchId, sourceUrl };
}

export function accountFor(workspaceId = PRICE_WATCH_WORKSPACE_ID, userId = PRICE_WATCH_USER_ID, email = "owner@example.com") {
  return { user: { id: userId, name: "Owner", email }, workspaceId };
}
