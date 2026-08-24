import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { BILLING_PLANS } from "../app/lib/billing-plans.ts";
import { applySubscriptionUpdate, ensureBillingSchema } from "../app/lib/billing-store.ts";
import {
  activatePriceWatchers,
  beginPriceWatchAttempt,
  claimDuePriceWatchers,
  completePriceWatchClaim,
  deletePriceWatcher,
  listPriceWatchers,
  listWorkspaceNotifications,
  markWorkspaceNotificationsRead,
  mutatePriceWatcher,
  priceWatchHistory,
  reapExpiredPriceWatchLeases,
} from "../app/lib/price-watch-store.ts";
import { canonicalPriceWatchUrl, canonicalPriceWatchVariant, currentPriceSnapshot } from "../app/lib/price-watch-target.ts";
import { inspectExactPriceWatchTarget, PRICE_WATCH_BATCH_LIMIT, processPriceWatchClaim, runWithPriceWatchConcurrency } from "../app/lib/price-watch-runner.ts";

const workspaceId = "workspace-1";
const userId = "user-1";
const publicReportId = "a".repeat(32);
const now = new Date("2026-08-24T12:00:00.000Z");

function subscription(overrides = {}) {
  return {
    workspaceId,
    stripeCustomerId: "cus_price_watch",
    stripeSubscriptionId: "sub_price_watch",
    stripePriceId: "price_starter",
    planTier: "starter",
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    eventId: "evt_price_watch_1",
    eventType: "customer.subscription.created",
    eventCreated: 100,
    ...overrides,
  };
}

function priceWatchDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE "user" (id text PRIMARY KEY NOT NULL, name text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '');
    CREATE TABLE workspaces (id text PRIMARY KEY NOT NULL);
    CREATE TABLE workspace_members (
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'owner', created_at text NOT NULL,
      PRIMARY KEY(workspace_id, user_id)
    );
    CREATE TABLE report_runs (
      id text PRIMARY KEY NOT NULL, public_id text NOT NULL UNIQUE, primary_domain text NOT NULL,
      workspace_id text NOT NULL DEFAULT '', expires_at text NOT NULL
    );
    CREATE TABLE report_products (
      run_id text NOT NULL, domain text NOT NULL, product_id text NOT NULL, name text NOT NULL,
      source_url text NOT NULL, price_json text NOT NULL DEFAULT '[]', metadata_json text NOT NULL DEFAULT '{}',
      PRIMARY KEY(run_id, domain, product_id)
    );
    CREATE TABLE report_matches (
      id text PRIMARY KEY NOT NULL, run_id text NOT NULL, primary_product_id text NOT NULL,
      rival_product_id text NOT NULL, rival_domain text NOT NULL, evidence_json text NOT NULL
    );
    INSERT INTO "user" (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.com');
    INSERT INTO workspaces(id) VALUES ('workspace-1');
    INSERT INTO workspace_members(workspace_id, user_id, role, created_at) VALUES ('workspace-1', 'user-1', 'owner', '2026-08-01T00:00:00.000Z');
  `);
  ensureBillingSchema(database);
  applySubscriptionUpdate(database, subscription(), now);
  return database;
}

function addReport(database, items = [
  { id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea?sku=1&utm_source=test", name: "Tea 500g", amount: 12.5 },
  { id: "2".repeat(64), productId: "rival-2", url: "https://rival.example/products/tea?sku=1", name: "Tea duplicate", amount: 12.5 },
  { id: "3".repeat(64), productId: "rival-3", url: "https://rival.example/products/coffee?pack=2", name: "Coffee twin pack", amount: 20 },
]) {
  database.prepare(`INSERT INTO report_runs (id, public_id, primary_domain, workspace_id, expires_at) VALUES ('run-1', ?, 'primary.example', ?, '2026-09-24T00:00:00.000Z')`).run(publicReportId, workspaceId);
  database.prepare(`INSERT INTO report_products (run_id, domain, product_id, name, source_url, price_json, metadata_json) VALUES ('run-1', 'primary.example', 'primary-1', 'Primary tea', 'https://primary.example/tea', '[{"raw":"£10","currency":"GBP","amount":10}]', '{}')`).run();
  for (const item of items) {
    database.prepare(`INSERT INTO report_products (run_id, domain, product_id, name, source_url, price_json, metadata_json) VALUES ('run-1', 'rival.example', ?, ?, ?, ?, ?)`)
      .run(item.productId, item.name, item.url, JSON.stringify([{ raw: `£${item.amount}`, currency: "GBP", amount: item.amount }]), JSON.stringify({ quantity: { kind: "mass", amount: 500, unit: "g" } }));
    database.prepare(`INSERT INTO report_matches (id, run_id, primary_product_id, rival_product_id, rival_domain, evidence_json) VALUES (?, 'run-1', 'primary-1', ?, 'rival.example', ?)`)
      .run(item.id, item.productId, JSON.stringify({ publication: { priceEligible: true }, rivalSourceUrl: item.url, normalizedVariant: "Original", normalizedSize: "500 g" }));
  }
}

test("monitoring plan allocations and canonical target identities are deterministic", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(BILLING_PLANS).map(([id, plan]) => [id, plan.monitoringCredits])), {
    starter: 1_000,
    solo: 5_000,
    growth: 25_000,
    agency: 100_000,
  });
  assert.equal(
    canonicalPriceWatchUrl("HTTPS://RIVAL.EXAMPLE:443/Item?utm_source=x&sku=2&sku=1#details").canonicalUrl,
    "https://rival.example/Item?sku=1&sku=2",
  );
  assert.notEqual(
    canonicalPriceWatchVariant({ quantity: { kind: "mass", amount: 500, unit: "G" }, normalizedVariant: " Original " }).variantKey,
    "default",
  );
  assert.equal(canonicalPriceWatchVariant({}).variantKey, "default");
  assert.equal(currentPriceSnapshot([
    { raw: "GBP 10", currency: "GBP", amount: 10 },
    { raw: "GBP 12", currency: "GBP", amount: 12 },
  ]), null);
});

test("bulk baseline affordability fails atomically without creating a partial watcher set", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [
      { id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 },
      { id: "2".repeat(64), productId: "rival-2", url: "https://rival.example/products/coffee", name: "Coffee", amount: 20 },
    ]);
    const insertUsage = database.transaction(() => {
      for (let index = 0; index < 999; index += 1) {
        const watcherId = `seed-watcher-${index}`;
        database.prepare(`INSERT INTO price_watchers (id, workspace_id, canonical_url, canonicalization_version, source_domain, rival_domain, product_name, variant_key, variant_json, audit_target, cadence, state, next_check_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'seed.example', 'seed.example', 'Seed', 'default', '{}', ?, 'daily', 'active', ?, ?, ?)`)
          .run(watcherId, workspaceId, `https://seed.example/${index}`, `audit-${index}`, now.toISOString(), now.toISOString(), now.toISOString());
        database.prepare(`INSERT INTO price_watch_credit_reservations (id, workspace_id, watcher_id, period_start, period_end, due_slot, status, created_at, updated_at) VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, 'committed', ?, ?)`)
          .run(`seed-reservation-${index}`, workspaceId, watcherId, `scheduled:${index}`, now.toISOString(), now.toISOString());
      }
    });
    insertUsage.immediate();
    const beforeWatchers = database.prepare(`SELECT COUNT(*) AS count FROM price_watchers`).get().count;
    const beforeReservations = database.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations`).get().count;
    assert.throws(
      () => activatePriceWatchers(database, workspaceId, userId, { publicReportId, rivalDomain: "rival.example", cadence: "daily" }, now),
      (error) => error?.code === "insufficient-credits",
    );
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watchers`).get().count, beforeWatchers);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations`).get().count, beforeReservations);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watcher_report_links`).get().count, 0);
  } finally { database.close(); }
});

test("rival activation deduplicates exact URL and variant, reserves baselines atomically, and reuses active watchers", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database);
    const first = activatePriceWatchers(database, workspaceId, userId, { publicReportId, rivalDomain: "rival.example", cadence: "daily" }, now);
    assert.deepEqual({ created: first.created, reused: first.reused, credits: first.baselineCreditsReserved }, { created: 2, reused: 0, credits: 2 });
    assert.equal(first.usage.used, 2);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watcher_report_links`).get().count, 3);

    const claims = claimDuePriceWatchers(database, "worker-1", 2, now);
    assert.equal(claims.length, 2);
    for (const claim of claims) {
      assert.equal(beginPriceWatchAttempt(database, claim, now), true);
      assert.equal(completePriceWatchClaim(database, claim, { kind: "baseline", snapshot: { currency: "GBP", amountMicros: 12_500_000, raw: "£12.50", listAmountMicros: null, listRaw: "" }, observedUrl: claim.canonicalUrl }, now).completed, true);
    }
    const second = activatePriceWatchers(database, workspaceId, userId, { publicReportId, rivalDomain: "rival.example", cadence: "hourly" }, new Date("2026-08-24T12:05:00.000Z"));
    assert.deepEqual({ created: second.created, reused: second.reused, credits: second.baselineCreditsReserved }, { created: 0, reused: 2, credits: 0 });
    assert.equal(second.usage.used, 2);
    assert.equal(listPriceWatchers(database, workspaceId, now).watchers.every((watcher) => watcher.cadence === "hourly"), true);
  } finally { database.close(); }
});

test("baseline, unchanged, confirmed change, history, and three failures are charged once per check", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    const activation = activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "hourly" }, now);
    let claim = claimDuePriceWatchers(database, "worker-1", 1, now)[0];
    assert.ok(claim);
    assert.equal(beginPriceWatchAttempt(database, claim, now), true);
    const baseline = { currency: "GBP", amountMicros: 12_500_000, raw: "£12.50", listAmountMicros: 15_000_000, listRaw: "£15" };
    completePriceWatchClaim(database, claim, { kind: "baseline", snapshot: baseline, observedUrl: claim.canonicalUrl }, now);

    let checkTime = new Date("2026-08-24T13:00:00.000Z");
    claim = claimDuePriceWatchers(database, "worker-2", 1, checkTime)[0];
    assert.equal(beginPriceWatchAttempt(database, claim, checkTime), true);
    completePriceWatchClaim(database, claim, { kind: "unchanged", snapshot: baseline, observedUrl: claim.canonicalUrl }, checkTime);
    assert.equal(priceWatchHistory(database, workspaceId, activation.watcherIds[0]).length, 1);

    checkTime = new Date("2026-08-24T14:00:00.000Z");
    claim = claimDuePriceWatchers(database, "worker-3", 1, checkTime)[0];
    assert.equal(beginPriceWatchAttempt(database, claim, checkTime), true);
    const discounted = { ...baseline, amountMicros: 10_000_000, raw: "£10" };
    assert.equal(completePriceWatchClaim(database, claim, { kind: "change", snapshot: discounted, observedUrl: claim.canonicalUrl }, checkTime).eventType, "price-decreased");
    assert.equal(priceWatchHistory(database, workspaceId, activation.watcherIds[0]).length, 2);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM workspace_notifications WHERE workspace_id = ?`).get(workspaceId).count, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_email_outbox`).get().count, 1);

    for (let index = 0; index < 3; index += 1) {
      checkTime = new Date(Date.parse("2026-08-24T15:00:00.000Z") + index * 60 * 60 * 1_000);
      claim = claimDuePriceWatchers(database, `failure-${index}`, 1, checkTime)[0];
      assert.equal(beginPriceWatchAttempt(database, claim, checkTime), true);
      completePriceWatchClaim(database, claim, { kind: index === 2 ? "confirmation_inconclusive" : "failure", code: "missing-price" }, checkTime);
    }
    const watcher = listPriceWatchers(database, workspaceId, checkTime).watchers[0];
    assert.equal(watcher.state, "paused_failure");
    assert.equal(watcher.failureStreak, 3);
    assert.equal(listPriceWatchers(database, workspaceId, checkTime).usage.used, 6);
  } finally { database.close(); }
});

test("expired reserved and attempting leases recover without duplicate credit debit", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "daily" }, now);
    const first = claimDuePriceWatchers(database, "crashed-before-attempt", 1, now)[0];
    const afterLease = new Date("2026-08-24T12:11:00.000Z");
    assert.deepEqual(reapExpiredPriceWatchLeases(database, afterLease), { released: 1, committedUnknown: 0 });
    const replay = claimDuePriceWatchers(database, "replacement", 1, afterLease)[0];
    assert.equal(replay.reservationId, first.reservationId);
    assert.equal(beginPriceWatchAttempt(database, replay, afterLease), true);
    const afterSecondLease = new Date("2026-08-24T12:22:00.000Z");
    assert.deepEqual(reapExpiredPriceWatchLeases(database, afterSecondLease), { released: 0, committedUnknown: 1 });
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations WHERE status IN ('reserved','attempting','committed')`).get().count, 1);
  } finally { database.close(); }
});

test("subscription pauses require manual resume while customer disable preserves history", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    const activation = activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "daily" }, now);
    const watcherId = activation.watcherIds[0];
    applySubscriptionUpdate(database, subscription({ eventId: "evt_inactive", eventCreated: 101, status: "past_due" }), now);
    assert.equal(listPriceWatchers(database, workspaceId, now).watchers[0].state, "paused_subscription");
    applySubscriptionUpdate(database, subscription({ eventId: "evt_active_again", eventCreated: 102 }), now);
    assert.equal(listPriceWatchers(database, workspaceId, now).watchers[0].state, "paused_subscription");
    const resumed = mutatePriceWatcher(database, workspaceId, userId, watcherId, { action: "resume" }, now);
    assert.equal(resumed.watcher.state, "baseline_pending");
    mutatePriceWatcher(database, workspaceId, userId, watcherId, { action: "disable" }, now);
    assert.equal(listPriceWatchers(database, workspaceId, now).watchers[0].state, "disabled");
  } finally { database.close(); }
});

test("an in-flight result cannot reactivate a disabled watcher and completion honors the latest cadence", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    const activation = activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "daily" }, now);
    const watcherId = activation.watcherIds[0];
    const baseline = { currency: "GBP", amountMicros: 12_500_000, raw: "GBP 12.50", listAmountMicros: null, listRaw: "" };
    let claim = claimDuePriceWatchers(database, "disable-race", 1, now)[0];
    assert.equal(beginPriceWatchAttempt(database, claim, now), true);
    mutatePriceWatcher(database, workspaceId, userId, watcherId, { action: "disable" }, new Date("2026-08-24T12:00:01.000Z"));
    completePriceWatchClaim(database, claim, { kind: "baseline", snapshot: baseline, observedUrl: claim.canonicalUrl }, new Date("2026-08-24T12:00:02.000Z"));
    assert.equal(listPriceWatchers(database, workspaceId, now).watchers[0].state, "disabled");
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM workspace_notifications`).get().count, 0);

    const resumedAt = new Date("2026-08-24T12:05:00.000Z");
    mutatePriceWatcher(database, workspaceId, userId, watcherId, { action: "resume", cadence: "hourly" }, resumedAt);
    claim = claimDuePriceWatchers(database, "cadence-baseline", 1, resumedAt)[0];
    beginPriceWatchAttempt(database, claim, resumedAt);
    completePriceWatchClaim(database, claim, { kind: "baseline", snapshot: baseline, observedUrl: claim.canonicalUrl }, resumedAt);

    const scheduledAt = new Date("2026-08-24T13:05:00.000Z");
    claim = claimDuePriceWatchers(database, "cadence-race", 1, scheduledAt)[0];
    beginPriceWatchAttempt(database, claim, scheduledAt);
    mutatePriceWatcher(database, workspaceId, userId, watcherId, { cadence: "daily" }, new Date("2026-08-24T13:05:01.000Z"));
    completePriceWatchClaim(database, claim, { kind: "unchanged", snapshot: baseline, observedUrl: claim.canonicalUrl }, new Date("2026-08-24T13:05:02.000Z"));
    const watcher = listPriceWatchers(database, workspaceId, scheduledAt).watchers[0];
    assert.equal(watcher.state, "active");
    assert.equal(watcher.cadence, "daily");
    assert.equal(watcher.nextCheckAt, "2026-08-25T13:05:02.000Z");
  } finally { database.close(); }
});

test("an expired attempted lease preserves a customer-disabled watcher state", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    const activation = activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "daily" }, now);
    const watcherId = activation.watcherIds[0];
    const claim = claimDuePriceWatchers(database, "unknown-disable-race", 1, now)[0];
    assert.equal(beginPriceWatchAttempt(database, claim, now), true);
    database.prepare(`UPDATE price_watchers SET failure_streak = 2 WHERE id = ?`).run(watcherId);
    mutatePriceWatcher(database, workspaceId, userId, watcherId, { action: "disable" }, new Date("2026-08-24T12:00:01.000Z"));
    assert.deepEqual(reapExpiredPriceWatchLeases(database, new Date("2026-08-24T12:11:00.000Z")), { released: 0, committedUnknown: 1 });
    const watcher = listPriceWatchers(database, workspaceId, new Date("2026-08-24T12:11:00.000Z")).watchers[0];
    assert.equal(watcher.state, "disabled");
    assert.equal(watcher.pauseReason, "customer-disabled");
    assert.equal(watcher.failureStreak, 3);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM workspace_notifications`).get().count, 0);
  } finally { database.close(); }
});

test("a new Stripe billing period resumes only credit-paused work and duplicate reconciliation does not reset usage", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "daily" }, now);
    database.prepare(`UPDATE price_watchers SET state = 'paused_credits', pause_reason = 'credits:2026-09-01T00:00:00.000Z'`).run();
    const september = new Date("2026-09-01T00:00:00.000Z");
    const nextPeriod = subscription({
      eventId: "evt_period_2", eventCreated: 200,
      currentPeriodStart: "2026-09-01T00:00:00.000Z", currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    });
    applySubscriptionUpdate(database, nextPeriod, september);
    applySubscriptionUpdate(database, nextPeriod, september);
    const listed = listPriceWatchers(database, workspaceId, september);
    assert.equal(listed.watchers[0].state, "baseline_pending");
    assert.equal(listed.usage.used, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_entitlements WHERE workspace_id = ?`).get(workspaceId).count, 2);
    const claim = claimDuePriceWatchers(database, "period-2", 1, september)[0];
    assert.ok(claim);
    assert.equal(listPriceWatchers(database, workspaceId, september).usage.used, 1);
  } finally { database.close(); }
});

test("an immediate downgrade preserves prior usage, clamps remaining credit, and creates no new claim", () => {
  const database = priceWatchDatabase();
  try {
    applySubscriptionUpdate(database, subscription({
      eventId: "evt_agency", eventCreated: 110, planTier: "agency", stripePriceId: "price_agency",
    }), now);
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "daily" }, now);
    const baseline = claimDuePriceWatchers(database, "downgrade-baseline", 1, now)[0];
    beginPriceWatchAttempt(database, baseline, now);
    completePriceWatchClaim(database, baseline, {
      kind: "baseline",
      snapshot: { currency: "GBP", amountMicros: 12_500_000, raw: "GBP 12.50", listAmountMicros: null, listRaw: "" },
      observedUrl: baseline.canonicalUrl,
    }, now);
    const seedUsage = database.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const watcherId = `downgrade-seed-${index}`;
        database.prepare(`INSERT INTO price_watchers (id, workspace_id, canonical_url, canonicalization_version, source_domain, rival_domain, product_name, variant_key, variant_json, audit_target, cadence, state, next_check_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'seed.example', 'seed.example', 'Seed', 'default', '{}', ?, 'daily', 'disabled', '', ?, ?)`)
          .run(watcherId, workspaceId, `https://seed.example/downgrade/${index}`, `downgrade-audit-${index}`, now.toISOString(), now.toISOString());
        database.prepare(`INSERT INTO price_watch_credit_reservations (id, workspace_id, watcher_id, period_start, period_end, due_slot, status, created_at, updated_at) VALUES (?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, 'committed', ?, ?)`)
          .run(`downgrade-reservation-${index}`, workspaceId, watcherId, `scheduled:seed-${index}`, now.toISOString(), now.toISOString());
      }
    });
    seedUsage.immediate();
    const downgradedAt = new Date("2026-08-24T12:05:00.000Z");
    database.prepare(`UPDATE price_watchers SET next_check_at = ? WHERE id = ?`).run(downgradedAt.toISOString(), baseline.watcherId);
    applySubscriptionUpdate(database, subscription({
      eventId: "evt_starter_downgrade", eventCreated: 120, planTier: "starter", stripePriceId: "price_starter",
    }), downgradedAt);
    const usage = listPriceWatchers(database, workspaceId, downgradedAt).usage;
    assert.deepEqual({ allocation: usage.allocation, used: usage.used, remaining: usage.remaining }, { allocation: 1_000, used: 1_001, remaining: 0 });
    assert.deepEqual(claimDuePriceWatchers(database, "downgrade-worker", 50, downgradedAt), []);
    assert.equal(listPriceWatchers(database, workspaceId, downgradedAt).watchers.find((watcher) => watcher.id === baseline.watcherId).state, "paused_credits");
  } finally { database.close(); }
});

test("same-domain baseline redirects are stored separately from canonical watcher identity", async () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea-old", name: "Tea", amount: 12.5 }]);
    activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "hourly" }, now);
    const baselineClaim = claimDuePriceWatchers(database, "redirect-baseline", 1, now)[0];
    const snapshot = { currency: "GBP", amountMicros: 12_500_000, raw: "GBP 12.5", listAmountMicros: null, listRaw: "" };
    await processPriceWatchClaim(database, baselineClaim, {
      now: () => now,
      inspect: async () => ({ ok: true, snapshot, observedUrl: "https://rival.example/products/tea", code: "", transient: false }),
    });
    const watcher = listPriceWatchers(database, workspaceId, now).watchers[0];
    assert.equal(watcher.canonicalUrl, "https://rival.example/products/tea-old");
    assert.equal(watcher.resolvedUrl, "https://rival.example/products/tea");
    const next = new Date("2026-08-24T13:00:00.000Z");
    const claim = claimDuePriceWatchers(database, "redirect-next", 1, next)[0];
    assert.equal(claim.resolvedUrl, watcher.resolvedUrl);
    const result = await processPriceWatchClaim(database, claim, {
      now: () => next,
      inspect: async () => ({ ok: true, snapshot, observedUrl: watcher.resolvedUrl, code: "", transient: false }),
    });
    assert.equal(result.status, "unchanged");
  } finally { database.close(); }
});

test("explicit discount context changes alert once and permanent deletion purges watcher data but keeps an immutable tombstone", () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    const activation = activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "hourly" }, now);
    const watcherId = activation.watcherIds[0];
    const baselineClaim = claimDuePriceWatchers(database, "discount-baseline", 1, now)[0];
    beginPriceWatchAttempt(database, baselineClaim, now);
    const baseline = { currency: "GBP", amountMicros: 12_500_000, raw: "GBP 12.5", listAmountMicros: null, listRaw: "" };
    completePriceWatchClaim(database, baselineClaim, { kind: "baseline", snapshot: baseline, observedUrl: baselineClaim.canonicalUrl }, now);
    const changedAt = new Date("2026-08-24T13:00:00.000Z");
    const changeClaim = claimDuePriceWatchers(database, "discount-change", 1, changedAt)[0];
    beginPriceWatchAttempt(database, changeClaim, changedAt);
    const discounted = { ...baseline, listAmountMicros: 15_000_000, listRaw: "GBP 15" };
    assert.equal(completePriceWatchClaim(database, changeClaim, { kind: "change", snapshot: discounted, observedUrl: changeClaim.canonicalUrl }, changedAt).eventType, "discount-started");
    const alerts = listWorkspaceNotifications(database, workspaceId, userId);
    assert.equal(alerts.unread, 1);
    assert.equal(markWorkspaceNotificationsRead(database, workspaceId, userId, [alerts.items[0].id], changedAt), 1);
    assert.equal(listWorkspaceNotifications(database, workspaceId, userId).unread, 0);
    const usageBeforeDelete = listPriceWatchers(database, workspaceId, changedAt).usage;
    assert.equal(usageBeforeDelete.used, 2);
    assert.equal(deletePriceWatcher(database, workspaceId, userId, watcherId, changedAt), true);
    for (const table of ["price_watchers", "price_watch_credit_reservations", "price_watch_observations", "price_watch_events", "workspace_notifications", "workspace_notification_reads", "price_watch_email_outbox", "price_watcher_report_links"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    }
    const usageAfterDelete = listPriceWatchers(database, workspaceId, changedAt).usage;
    assert.equal(usageAfterDelete.used, usageBeforeDelete.used);
    assert.equal(database.prepare(`SELECT purged_used FROM price_watch_entitlements WHERE workspace_id = ?`).get(workspaceId).purged_used, 2);
    assert.ok(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_audit_log`).get().count > 0);
    assert.throws(() => database.prepare(`UPDATE price_watch_audit_log SET action = 'tampered'`).run(), /immutable/);
    assert.throws(() => database.prepare(`DELETE FROM price_watch_audit_log`).run(), /immutable/);
    database.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_audit_log`).get().count, 0);
  } finally { database.close(); }
});

test("the deterministic runner retries one transient failure and confirms numeric changes", async () => {
  const database = priceWatchDatabase();
  try {
    addReport(database, [{ id: "1".repeat(64), productId: "rival-1", url: "https://rival.example/products/tea", name: "Tea", amount: 12.5 }]);
    activatePriceWatchers(database, workspaceId, userId, { publicReportId, matchId: "1".repeat(64), cadence: "hourly" }, now);
    const baselineClaim = claimDuePriceWatchers(database, "runner-baseline", 1, now)[0];
    let calls = 0;
    const baseline = { currency: "GBP", amountMicros: 12_500_000, raw: "£12.50", listAmountMicros: null, listRaw: "" };
    const baselineResult = await processPriceWatchClaim(database, baselineClaim, {
      now: () => now,
      inspect: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, snapshot: null, observedUrl: "", code: "fetch-failed", transient: true }
          : { ok: true, snapshot: baseline, observedUrl: baselineClaim.canonicalUrl, code: "", transient: false };
      },
    });
    assert.equal(baselineResult.status, "baseline");
    assert.equal(calls, 2);

    const changeTime = new Date("2026-08-24T13:00:00.000Z");
    const changeClaim = claimDuePriceWatchers(database, "runner-change", 1, changeTime)[0];
    const changed = { ...baseline, amountMicros: 11_000_000, raw: "£11" };
    calls = 0;
    const changeResult = await processPriceWatchClaim(database, changeClaim, {
      now: () => changeTime,
      inspect: async () => { calls += 1; return { ok: true, snapshot: changed, observedUrl: changeClaim.canonicalUrl, code: "", transient: false }; },
    });
    assert.equal(changeResult.status, "changed");
    assert.equal(calls, 2);

    const uncertainTime = new Date("2026-08-24T14:00:00.000Z");
    const uncertainClaim = claimDuePriceWatchers(database, "runner-uncertain", 1, uncertainTime)[0];
    const prices = [
      { ...changed, amountMicros: 10_000_000, raw: "£10" },
      { ...changed, amountMicros: 9_000_000, raw: "£9" },
    ];
    const uncertain = await processPriceWatchClaim(database, uncertainClaim, {
      now: () => uncertainTime,
      inspect: async () => ({ ok: true, snapshot: prices.shift(), observedUrl: uncertainClaim.canonicalUrl, code: "", transient: false }),
    });
    assert.equal(uncertain.status, "confirmation_inconclusive");
    assert.equal(listPriceWatchers(database, workspaceId, uncertainTime).watchers[0].baseline.amountMicros, 11_000_000);
  } finally { database.close(); }
});

test("the exact target inspector rejects currency drift, cross-domain redirects, URL drift, and ambiguous prices", async () => {
  const baseline = { currency: "GBP", amountMicros: 12_500_000, raw: "GBP 12.50", listAmountMicros: null, listRaw: "" };
  const claim = {
    reservationId: "reservation-inspection",
    dueSlot: "scheduled:inspection",
    watcherId: "watcher-inspection",
    workspaceId,
    canonicalUrl: "https://rival.example/products/tea",
    resolvedUrl: "https://rival.example/products/tea",
    sourceDomain: "rival.example",
    rivalDomain: "rival.example",
    productName: "Tea",
    variantKey: "default",
    variantJson: "{}",
    cadence: "daily",
    state: "active",
    baseline,
    claimOwner: "worker",
    leaseExpiresAt: "2026-08-24T12:10:00.000Z",
  };
  const resultFor = (sourceUrl, priceSignals) => ({
    enrich: async () => ({ products: [{ id: claim.watcherId, sourceUrl, priceSignals }], coverage: { gaps: [] } }),
  });

  assert.equal((await inspectExactPriceWatchTarget(claim, resultFor(claim.canonicalUrl, [{ raw: "USD 12.50", currency: "USD", amount: 12.5 }]))).code, "currency-drift");
  assert.equal((await inspectExactPriceWatchTarget(claim, resultFor("https://other.example/products/tea", [{ raw: "GBP 12.50", currency: "GBP", amount: 12.5 }]))).code, "cross-domain-redirect");
  assert.equal((await inspectExactPriceWatchTarget(claim, resultFor("https://rival.example/products/other-tea", [{ raw: "GBP 12.50", currency: "GBP", amount: 12.5 }]))).code, "target-url-drift");
  assert.equal((await inspectExactPriceWatchTarget(claim, resultFor(claim.canonicalUrl, [
    { raw: "GBP 12.50", currency: "GBP", amount: 12.5 },
    { raw: "GBP 13.50", currency: "GBP", amount: 13.5 },
  ]))).code, "missing-price");
  assert.equal((await inspectExactPriceWatchTarget(claim, resultFor(claim.canonicalUrl, [{ raw: "GBP 12.50", currency: "GBP", amount: 12.5 }]))).ok, true);
});

test("batch concurrency is capped at eight globally and two per rival domain", async () => {
  const items = Array.from({ length: 24 }, (_, index) => ({ sourceDomain: `rival-${index % 3}.example`, index }));
  let active = 0;
  let maxActive = 0;
  const domainActive = new Map();
  const maxByDomain = new Map();
  const results = await runWithPriceWatchConcurrency(items, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const next = (domainActive.get(item.sourceDomain) || 0) + 1;
    domainActive.set(item.sourceDomain, next);
    maxByDomain.set(item.sourceDomain, Math.max(maxByDomain.get(item.sourceDomain) || 0, next));
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    domainActive.set(item.sourceDomain, next - 1);
    return item.index;
  });
  assert.equal(maxActive <= 8, true);
  assert.equal([...maxByDomain.values()].every((value) => value <= 2), true);
  assert.deepEqual(results, items.map((item) => item.index));
});

test("batch concurrency waits for active siblings before surfacing a worker failure", async () => {
  const launched = [];
  let releaseSibling;
  const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
  let siblingFinished = false;
  const execution = runWithPriceWatchConcurrency(
    Array.from({ length: 4 }, (_, index) => ({ sourceDomain: "one.example", index })),
    async (item) => {
      launched.push(item.index);
      if (item.index === 0) { await new Promise((resolve) => setImmediate(resolve)); throw new Error("worker-failed"); }
      await siblingGate;
      siblingFinished = true;
      return item.index;
    },
  );
  let settled = false;
  void execution.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(launched, [0, 1]);
  releaseSibling();
  await assert.rejects(execution, /worker-failed/);
  assert.equal(siblingFinished, true);
});

test("a scheduler pass claims at most fifty watchers in oldest-due order", () => {
  const database = priceWatchDatabase();
  try {
    const insert = database.transaction(() => {
      for (let index = 0; index < 60; index += 1) {
        const due = new Date(now.getTime() - (60 - index) * 1_000).toISOString();
        database.prepare(`INSERT INTO price_watchers (
          id, workspace_id, canonical_url, canonicalization_version, source_domain, rival_domain,
          product_name, variant_key, variant_json, audit_target, cadence, state,
          baseline_currency, baseline_amount_micros, baseline_raw, next_check_at, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, 'default', '{}', ?, 'daily', 'active', 'GBP', 1000000, 'GBP 1', ?, ?, ?)`)
          .run(`batch-watcher-${index}`, workspaceId, `https://batch-${index % 3}.example/${index}`, `batch-${index % 3}.example`, `batch-${index % 3}.example`, `Product ${index}`, `batch-audit-${index}`, due, due, due);
      }
    });
    insert.immediate();
    const claims = claimDuePriceWatchers(database, "batch-worker", 999, now);
    assert.equal(claims.length, 50);
    assert.deepEqual(claims.map((claim) => claim.watcherId), Array.from({ length: 50 }, (_, index) => `batch-watcher-${index}`));
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations WHERE status = 'reserved'`).get().count, 50);
    assert.equal(PRICE_WATCH_BATCH_LIMIT, 8);
  } finally { database.close(); }
});
