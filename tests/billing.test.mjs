import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Stripe from "stripe";

import { BILLING_PLANS, billingPlan, configuredPriceId, hostedBillingEnabled, planForConfiguredPrice } from "../app/lib/billing-plans.ts";
import {
  ReportReservationConflictError,
  activeWorkspacePlan,
  applySubscriptionUpdate,
  ensureBillingSchema,
  finishReportReservation,
  getInternalReportEntitlement,
  getWorkspaceSubscription,
  reserveReport,
  saveWorkspaceCustomer,
  setInternalReportEntitlement,
} from "../app/lib/billing-store.ts";
import { createPersistentReport, reportCreationDependencies } from "../app/api/reports/route.ts";
import { createCheckout } from "../app/api/billing/checkout/route.ts";
import { createPortal } from "../app/api/billing/portal/route.ts";
import { handleStripeWebhook } from "../app/api/stripe/webhook/route.ts";

function billingDatabase(path = ":memory:") {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE workspaces (id text PRIMARY KEY NOT NULL, kind text NOT NULL DEFAULT 'customer');
    INSERT INTO workspaces(id, kind) VALUES ('workspace-1', 'customer');
  `);
  ensureBillingSchema(database);
  return database;
}

function subscription(overrides = {}) {
  return {
    workspaceId: "workspace-1",
    stripeCustomerId: "cus_test",
    stripeSubscriptionId: "sub_test",
    stripePriceId: "price_starter",
    planTier: "starter",
    status: "active",
    cancelAtPeriodEnd: false,
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    eventId: "evt_1",
    eventType: "customer.subscription.created",
    eventCreated: 100,
    ...overrides,
  };
}

test("server price mapping accepts only exact configured Stripe prices", () => {
  const environment = {
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_SOLO: "price_solo",
    STRIPE_PRICE_GROWTH: "price_growth",
    STRIPE_PRICE_AGENCY: "price_agency",
  };
  assert.equal(billingPlan("AGENCY"), BILLING_PLANS.agency);
  assert.equal(billingPlan("enterprise"), null);
  assert.equal(configuredPriceId(BILLING_PLANS.starter, environment), "price_starter");
  assert.equal(planForConfiguredPrice("price_growth", environment)?.id, "growth");
  assert.equal(planForConfiguredPrice("price_client_supplied", environment), null);
});

test("subscription events are idempotent, stale-safe, and quota reservations are atomic", () => {
  const database = billingDatabase();
  try {
    assert.equal(applySubscriptionUpdate(database, subscription()), "applied");
    assert.equal(applySubscriptionUpdate(database, subscription()), "duplicate");
    assert.equal(applySubscriptionUpdate(database, subscription({ eventId: "evt_old", eventCreated: 99, status: "canceled" })), "stale");
    assert.equal(applySubscriptionUpdate(database, subscription({ eventId: "evt_same_second", eventCreated: 100, status: "incomplete" })), "stale");
    assert.equal(applySubscriptionUpdate(database, subscription({ eventId: "evt_old_subscription", eventCreated: 101, stripeSubscriptionId: "sub_old", status: "canceled" })), "ignored");
    assert.equal(getWorkspaceSubscription(database, "workspace-1")?.status, "active");

    const now = new Date("2026-08-16T12:00:00.000Z");
    const reservations = Array.from({ length: 5 }, () => reserveReport(database, "workspace-1", now));
    assert.equal(reservations.every((entry) => entry?.id), true);
    const limited = reserveReport(database, "workspace-1", now);
    assert.equal(limited?.id, "");
    assert.deepEqual({ used: limited?.used, limit: limited?.limit }, { used: 5, limit: 5 });
    assert.equal(finishReportReservation(database, reservations[0].id, "committed", "run-1", now), true);
    assert.equal(finishReportReservation(database, reservations[0].id, "released", "run-1", now), false);
    assert.deepEqual(database.prepare("SELECT status, run_id FROM billing_report_reservations WHERE id = ?").get(reservations[0].id), { status: "committed", run_id: "run-1" });
    assert.equal(reserveReport(database, "workspace-1", now)?.id, "");
  } finally { database.close(); }
});

test("internal report entitlement spends comparison units by UTC day and counts released attempts", () => {
  const database = billingDatabase();
  try {
    database.prepare("UPDATE workspaces SET kind = 'internal' WHERE id = 'workspace-1'").run();
    setInternalReportEntitlement(database, "workspace-1", {
      enabled: true,
      maxComparisonTarget: 50,
      dailyComparisonLimit: 70,
    }, new Date("2026-09-04T09:00:00.000Z"));
    assert.deepEqual(getInternalReportEntitlement(database, "workspace-1"), {
      workspaceId: "workspace-1",
      enabled: true,
      maxComparisonTarget: 50,
      dailyComparisonLimit: 70,
      createdAt: "2026-09-04T09:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
    });

    const fifty = reserveReport(database, "workspace-1", new Date("2026-09-04T23:58:00.000Z"), "internal:first", 50);
    assert.ok(fifty?.id);
    assert.deepEqual({ plan: fifty.plan.id, used: fifty.used, limit: fifty.limit, quotaKind: fifty.quotaKind }, {
      plan: "solo", used: 50, limit: 70, quotaKind: "comparisons",
    });
    assert.equal(finishReportReservation(database, fifty.id, "released", "", new Date("2026-09-04T23:58:01.000Z")), true);

    const twenty = reserveReport(database, "workspace-1", new Date("2026-09-04T23:59:00.000Z"), "internal:second", 20);
    assert.ok(twenty?.id);
    assert.equal(twenty.used, 70);
    const blocked = reserveReport(database, "workspace-1", new Date("2026-09-04T23:59:30.000Z"), "internal:third", 20);
    assert.deepEqual({ id: blocked?.id, used: blocked?.used, limit: blocked?.limit, quotaKind: blocked?.quotaKind }, {
      id: "", used: 70, limit: 70, quotaKind: "comparisons",
    });

    const reset = reserveReport(database, "workspace-1", new Date("2026-09-05T00:00:00.000Z"), "internal:next-day", 20);
    assert.ok(reset?.id);
    assert.equal(reset.used, 20);
  } finally { database.close(); }
});

test("internal report entitlement cannot be granted to a customer workspace", () => {
  const database = billingDatabase();
  try {
    assert.throws(
      () => setInternalReportEntitlement(database, "workspace-1", {
        enabled: true,
        maxComparisonTarget: 20,
        dailyComparisonLimit: 20,
      }),
      /require an internal workspace/i,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM internal_report_entitlements").get().count, 0);
  } finally { database.close(); }
});

test("internal reservations replay exactly and fail closed on target or workspace collisions", () => {
  const database = billingDatabase();
  try {
    database.prepare("UPDATE workspaces SET kind = 'internal' WHERE id = 'workspace-1'").run();
    database.prepare("INSERT INTO workspaces(id, kind) VALUES ('workspace-2', 'internal')").run();
    for (const workspaceId of ["workspace-1", "workspace-2"]) {
      setInternalReportEntitlement(database, workspaceId, {
        enabled: true,
        maxComparisonTarget: 50,
        dailyComparisonLimit: 100,
      });
    }
    const now = new Date("2026-09-04T12:00:00.000Z");
    const first = reserveReport(database, "workspace-1", now, "orchestrator:report:1", 20);
    const replay = reserveReport(database, "workspace-1", now, "orchestrator:report:1", 20);
    assert.ok(first?.id);
    assert.equal(replay?.id, first.id);
    assert.equal(replay?.used, 20);
    assert.throws(
      () => reserveReport(database, "workspace-1", now, "orchestrator:report:1", 50),
      (error) => error instanceof ReportReservationConflictError,
    );
    assert.throws(
      () => reserveReport(database, "workspace-2", now, "orchestrator:report:1", 20),
      (error) => error instanceof ReportReservationConflictError,
    );
  } finally { database.close(); }
});

test("competing database connections cannot exceed the internal daily ceiling", () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-internal-ceiling-"));
  const path = join(directory, "billing.sqlite");
  const first = billingDatabase(path);
  let second;
  try {
    first.prepare("UPDATE workspaces SET kind = 'internal' WHERE id = 'workspace-1'").run();
    setInternalReportEntitlement(first, "workspace-1", {
      enabled: true,
      maxComparisonTarget: 20,
      dailyComparisonLimit: 20,
    });
    second = new Database(path);
    second.pragma("busy_timeout = 10000");
    second.pragma("foreign_keys = ON");
    ensureBillingSchema(second);
    const now = new Date("2026-09-04T12:00:00.000Z");
    assert.ok(reserveReport(first, "workspace-1", now, "agent:a", 20)?.id);
    assert.equal(reserveReport(second, "workspace-1", now, "agent:b", 20)?.id, "");
  } finally {
    second?.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("client comparison targets never override a Stripe subscription plan", () => {
  const database = billingDatabase();
  try {
    applySubscriptionUpdate(database, subscription());
    const reservation = reserveReport(database, "workspace-1", new Date("2026-08-16T12:00:00.000Z"), "customer:spoof", 1_000);
    assert.ok(reservation?.id);
    assert.equal(reservation.plan.id, "starter");
    assert.equal(reservation.plan.productLimit, 20);
    assert.equal(reservation.quotaKind, "reports");
  } finally { database.close(); }
});

test("report history eligibility uses the same active billing-period boundary as reservations", () => {
  const database = billingDatabase();
  try {
    applySubscriptionUpdate(database, subscription());
    assert.equal(activeWorkspacePlan(database, "workspace-1", new Date("2026-08-16T12:00:00.000Z"))?.id, "starter");
    assert.equal(activeWorkspacePlan(database, "workspace-1", new Date("2026-09-01T00:00:00.000Z")), null);
    applySubscriptionUpdate(database, subscription({ eventId: "evt_2", eventCreated: 101, status: "past_due" }));
    assert.equal(activeWorkspacePlan(database, "workspace-1", new Date("2026-08-16T12:00:00.000Z")), null);
  } finally { database.close(); }
});

test("active report reservations survive the bounded retry window and stale reservations are eventually reclaimed", () => {
  const database = billingDatabase();
  try {
    applySubscriptionUpdate(database, subscription());
    const started = new Date("2026-08-16T08:00:00.000Z");
    const first = reserveReport(database, "workspace-1", started);
    assert.ok(first?.id);
    reserveReport(database, "workspace-1", new Date("2026-08-16T11:59:00.000Z"));
    assert.equal(database.prepare("SELECT status FROM billing_report_reservations WHERE id = ?").get(first.id).status, "reserved");
    reserveReport(database, "workspace-1", new Date("2026-08-16T12:01:00.000Z"));
    assert.equal(database.prepare("SELECT status FROM billing_report_reservations WHERE id = ?").get(first.id).status, "released");
  } finally { database.close(); }
});

test("hosted billing is explicit and unbilled deployments retain report creation", () => {
  assert.equal(hostedBillingEnabled({}), false);
  assert.equal(hostedBillingEnabled({ MARKET_SIGNAL_HOSTED_BILLING: "true" }), true);
  const unbilled = reportCreationDependencies({});
  assert.equal(unbilled.authorize, undefined);
  assert.equal(unbilled.reserve, undefined);
  const hosted = reportCreationDependencies({ MARKET_SIGNAL_HOSTED_BILLING: "true" });
  assert.equal(typeof hosted.authorize, "function");
  assert.equal(typeof hosted.reserve, "function");
  assert.equal(typeof hosted.finishReservation, "function");
});

test("checkout rejects unauthenticated, invalid, unconfigured, and duplicate subscriptions", async () => {
  {
    const environment = { MARKET_SIGNAL_HOSTED_BILLING: "true" };
    const never = () => { throw new Error("unexpected service call"); };
    const unauthenticated = await createCheckout(new Request("https://signal.example/api/billing/checkout", { method: "POST", body: "{}" }), { authorize: async () => null, openDatabase: never, stripe: never, applicationUrl: never, now: () => new Date(), environment });
    assert.equal(unauthenticated.status, 401);
    const account = async () => ({ user: { id: "u", name: "U", email: "u@example.com" }, workspaceId: "workspace-1" });
    const invalid = await createCheckout(new Request("https://signal.example/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "wrong" }) }), { authorize: account, openDatabase: never, stripe: never, applicationUrl: never, now: () => new Date(), environment });
    assert.equal(invalid.status, 400);
    const unconfigured = await createCheckout(new Request("https://signal.example/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "starter" }) }), { authorize: account, openDatabase: never, stripe: never, applicationUrl: never, now: () => new Date(), environment });
    assert.equal(unconfigured.status, 503);
  }

  {
    const database = billingDatabase();
    applySubscriptionUpdate(database, subscription());
    const response = await createCheckout(new Request("https://signal.example/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "starter" }) }), {
      authorize: async () => ({ user: { id: "u", name: "U", email: "u@example.com" }, workspaceId: "workspace-1" }),
      openDatabase: async () => database,
      stripe: () => { throw new Error("local guard should run first"); },
      applicationUrl: () => "https://signal.example",
      now: () => new Date("2026-08-16T12:00:00.000Z"),
      environment: { MARKET_SIGNAL_HOSTED_BILLING: "true", STRIPE_PRICE_STARTER: "price_starter" },
    });
    assert.equal(response.status, 409);
    assert.equal(database.open, false);
  }
});

test("checkout checks Stripe for remote duplicates before creating another session", async () => {
  {
    const database = billingDatabase();
    saveWorkspaceCustomer(database, "workspace-1", "cus_remote");
    const stripe = { subscriptions: { list: async () => ({ data: [{ status: "past_due" }] }) } };
    const response = await createCheckout(new Request("https://signal.example/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "starter" }) }), {
      authorize: async () => ({ user: { id: "u", name: "U", email: "u@example.com" }, workspaceId: "workspace-1" }),
      openDatabase: async () => database,
      stripe: () => stripe,
      applicationUrl: () => "https://signal.example",
      now: () => new Date("2026-08-16T12:00:00.000Z"),
      environment: { MARKET_SIGNAL_HOSTED_BILLING: "true", STRIPE_PRICE_STARTER: "price_starter" },
    });
    assert.equal(response.status, 409);
    assert.equal(database.open, false);
  }
});

test("signed webhook updates billing while invalid and unmapped events fail safely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-billing-"));
  try {
    const environment = { MARKET_SIGNAL_HOSTED_BILLING: "true", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_STARTER: "price_starter" };
    const stripeClient = new Stripe("rk_test_local", { apiVersion: "2026-07-29.dahlia" });
    const missing = await handleStripeWebhook(new Request("https://signal.example/api/stripe/webhook", { method: "POST", body: "{}" }), { stripe: () => stripeClient, openDatabase: async () => { throw new Error("no db"); }, environment });
    assert.equal(missing.status, 400);
    const invalid = await handleStripeWebhook(new Request("https://signal.example/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "bad" }, body: "{}" }), { stripe: () => stripeClient, openDatabase: async () => { throw new Error("no db"); }, environment });
    assert.equal(invalid.status, 400);

    const payload = JSON.stringify({ id: "evt_signed", type: "customer.subscription.created", created: 200, data: { object: { id: "sub_signed" } } });
    const signature = stripeClient.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    const databasePath = join(directory, "accepted.sqlite");
    const database = billingDatabase(databasePath);
    saveWorkspaceCustomer(database, "workspace-1", "cus_signed");
    const stripe = {
      webhooks: stripeClient.webhooks,
      subscriptions: { retrieve: async () => ({ id: "sub_signed", customer: "cus_signed", status: "active", cancel_at_period_end: false, metadata: {}, items: { data: [{ price: { id: "price_starter" }, current_period_start: 1_785_528_000, current_period_end: 1_788_206_400 }] } }) },
    };
    const accepted = await handleStripeWebhook(new Request("https://signal.example/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature }, body: payload }), { stripe: () => stripe, openDatabase: async () => database, environment });
    assert.equal(accepted.status, 200);
    assert.equal(database.open, false);
    const inspection = new Database(databasePath);
    assert.equal(getWorkspaceSubscription(inspection, "workspace-1")?.stripeSubscriptionId, "sub_signed");
    inspection.close();

    const unmappedPayload = JSON.stringify({ id: "evt_unmapped", type: "customer.subscription.updated", created: 201, data: { object: { id: "sub_unmapped" } } });
    const unmappedSignature = stripeClient.webhooks.generateTestHeaderString({ payload: unmappedPayload, secret: "whsec_test" });
    const unmappedDatabase = billingDatabase();
    const unmappedStripe = { webhooks: stripeClient.webhooks, subscriptions: { retrieve: async () => ({ id: "sub_unmapped", customer: "cus_unknown", status: "active", cancel_at_period_end: false, metadata: {}, items: { data: [{ price: { id: "price_starter" }, current_period_start: 1_785_528_000, current_period_end: 1_788_206_400 }] } }) } };
    const ignored = await handleStripeWebhook(new Request("https://signal.example/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": unmappedSignature }, body: unmappedPayload }), { stripe: () => unmappedStripe, openDatabase: async () => unmappedDatabase, environment });
    assert.equal(ignored.status, 200);
    assert.equal((await ignored.json()).ignored, "unmapped_subscription");
    assert.equal(unmappedDatabase.open, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("portal rejects unauthenticated users", async () => {
  const never = () => { throw new Error("unexpected service call"); };
  const response = await createPortal(new Request("https://signal.example/api/billing/portal", { method: "POST" }), {
    authorize: async () => null,
    openDatabase: never,
    stripe: never,
    applicationUrl: never,
    environment: { MARKET_SIGNAL_HOSTED_BILLING: "true" },
  });
  assert.equal(response.status, 401);
});

test("inactive, unknown-price, and out-of-period subscriptions fail closed", () => {
  for (const update of [
    subscription({ status: "past_due" }),
    subscription({ planTier: "", stripePriceId: "price_unknown" }),
    subscription({ currentPeriodEnd: "2026-08-02T00:00:00.000Z" }),
  ]) {
    const database = billingDatabase();
    try {
      applySubscriptionUpdate(database, update);
      assert.equal(reserveReport(database, "workspace-1", new Date("2026-08-16T12:00:00.000Z")), null);
    } finally { database.close(); }
  }
});

test("hosted report creation requires auth, subscription, and available quota", async () => {
  const base = {
    create: async () => { throw new Error("must not create"); },
    dispatch: async () => { throw new Error("must not dispatch"); },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  };
  const request = () => new Request("https://signal.example/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk" }) });
  const unauthenticated = await createPersistentReport(request(), { ...base, authorize: async () => null });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") || "", /oauth-protected-resource\/api/);
  const unpaid = await createPersistentReport(request(), { ...base, authorize: async () => ({ user: { id: "u", name: "U", email: "u@example.com" }, workspaceId: "w" }), reserve: async () => null });
  assert.equal(unpaid.status, 402);
  const limited = await createPersistentReport(request(), { ...base, authorize: async () => ({ user: { id: "u", name: "U", email: "u@example.com" }, workspaceId: "w" }), reserve: async () => ({ id: "", plan: BILLING_PLANS.starter, used: 5, limit: 5 }) });
  assert.equal(limited.status, 429);
});

test("hosted report creation reaches the workspace-scoped CLI authorizer", async () => {
  let browserAuthorizerCalls = 0;
  let loopAuthorizerCalls = 0;
  let creationInput;
  const response = await createPersistentReport(new Request("https://signal.blyzr.com/api/reports", {
    method: "POST",
    body: JSON.stringify({ primaryDomain: "myjam.co.uk", locale: "en", commandId: "cli:myjam:001", comparisonTarget: 20 }),
  }), {
    requireAccount: true,
    authorize: async () => {
      browserAuthorizerCalls += 1;
      return null;
    },
    authorizeLoop: async () => {
      loopAuthorizerCalls += 1;
      return { user: { id: "cli-user", name: "CLI User", email: "cli@example.com" }, workspaceId: "cli-workspace" };
    },
    reserve: async (_workspaceId, _commandId, comparisonTarget) => {
      assert.equal(comparisonTarget, 20);
      return { id: "reservation-cli", plan: BILLING_PLANS.starter, used: 20, limit: 20, quotaKind: "comparisons" };
    },
    create: async (value) => {
      creationInput = value;
      return {
        ok: true,
        report: {
          id: "run-cli",
          publicId: "b".repeat(32),
          primaryDomain: "myjam.co.uk",
          locale: "en",
          status: "queued",
          currentPhase: "queued",
          attemptCount: 1,
          createdAt: "now",
          expiresAt: "later",
          productPlan: "starter",
          productLimit: 20,
        },
      };
    },
    dispatch: async () => ({ runId: "trigger-cli", idempotencyKey: "key-cli" }),
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
    finishReservation: async () => {},
  });
  assert.equal(response.status, 202, await response.clone().text());
  assert.equal(browserAuthorizerCalls, 0);
  assert.equal(loopAuthorizerCalls, 1);
  assert.equal(creationInput.workspaceId, "cli-workspace");
  assert.equal(creationInput.commandId, "cli:myjam:001");
});

test("report creation rejects unknown comparison targets before reservation", async () => {
  let reserveCalls = 0;
  const response = await createPersistentReport(new Request("https://signal.blyzr.com/api/reports", {
    method: "POST",
    body: JSON.stringify({ primaryDomain: "myjam.co.uk", commandId: "cli:myjam:invalid", comparisonTarget: 21 }),
  }), {
    requireAccount: true,
    authorizeLoop: async () => ({ user: { id: "cli-user", name: "CLI User", email: "cli@example.com" }, workspaceId: "cli-workspace" }),
    reserve: async () => { reserveCalls += 1; return null; },
    create: async () => { throw new Error("must not create"); },
    dispatch: async () => { throw new Error("must not dispatch"); },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "Comparison target must be 20, 50, 500, or 1000.", errorCode: "invalid-comparison-target" });
  assert.equal(reserveCalls, 0);

  const stringTarget = await createPersistentReport(new Request("https://signal.blyzr.com/api/reports", {
    method: "POST",
    body: JSON.stringify({ primaryDomain: "myjam.co.uk", commandId: "cli:myjam:string-target", comparisonTarget: "20" }),
  }), {
    requireAccount: true,
    authorizeLoop: async () => ({ user: { id: "cli-user", name: "CLI User", email: "cli@example.com" }, workspaceId: "cli-workspace" }),
    reserve: async () => { reserveCalls += 1; return null; },
    create: async () => { throw new Error("must not create"); },
    dispatch: async () => { throw new Error("must not dispatch"); },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });
  assert.equal(stringTarget.status, 400);
  assert.equal(reserveCalls, 0);
});

test("paid report creation forwards only server-resolved workspace entitlement and leaves usage reserved until terminal", async () => {
  let input;
  const outcomes = [];
  const response = await createPersistentReport(new Request("https://signal.example/api/reports?plan=agency", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk", plan: "agency", productLimit: 1000 }) }), {
    authorize: async () => ({ user: { id: "u", name: "U", email: "u@example.com" }, workspaceId: "workspace-1" }),
    reserve: async () => ({ id: "reservation-1", plan: BILLING_PLANS.solo, used: 1, limit: 10 }),
    create: async (value) => { input = value; return { ok: true, report: { id: "run-1", publicId: "a".repeat(32), primaryDomain: "myjam.co.uk", locale: "en", status: "queued", currentPhase: "queued", attemptCount: 1, createdAt: "now", expiresAt: "later", productPlan: "solo", productLimit: 50 } }; },
    dispatch: async () => ({ runId: "trigger-1", idempotencyKey: "key" }),
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
    finishReservation: async (...args) => outcomes.push(args),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(input, { primaryDomain: "myjam.co.uk", locale: "en", workspaceId: "workspace-1", billingReservationId: "reservation-1", entitlement: { plan: "solo", productLimit: 50 } });
  assert.deepEqual(outcomes, []);
});

test("account and pricing sources expose real account billing without committed secrets", async () => {
  const root = process.cwd();
  const [auth, pricing, environment] = await Promise.all([
    readFile(join(root, "app/lib/account-auth.ts"), "utf8"),
    readFile(join(root, "app/pricing/page.tsx"), "utf8"),
    readFile(join(root, ".env.example"), "utf8"),
  ]);
  assert.match(auth, /emailAndPassword:\s*\{\s*enabled:\s*true/);
  assert.match(pricing, /CheckoutButton/);
  assert.doesNotMatch(pricing, /billing is not active yet|Start in beta|COMING SOON/i);
  assert.match(environment, /STRIPE_RESTRICTED_KEY=/);
  assert.doesNotMatch(environment, /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{12,}/);
});
