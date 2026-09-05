import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { verifyCompanyTriggerKey, COMPANY_WORKSPACE_ID } from "../app/lib/company-trigger-access.ts";
import { ensureAccountSchema } from "../app/lib/account-auth.ts";
import { ensureBillingSchema, reserveReport, setInternalReportEntitlement } from "../app/lib/billing-store.ts";
import { ensureMcpOAuthSchema } from "../app/lib/mcp-oauth-schema.ts";
import { reportApiAccountContext } from "../app/lib/report-api-auth.ts";
import { createPersistentReport } from "../app/api/reports/route.ts";
import { provisionInternalAgent } from "../scripts/provision-internal-agent-cli.mjs";

// Deliberately fake credentials; no provider calls or paid work in this suite.
const KEY = `tr_prod_sk_${"x".repeat(24)}`;
const ENV = {
  MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_REF: "proj_testcompany",
  MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_ID: "project_testcompany",
  MARKET_SIGNAL_INTERNAL_TRIGGER_KEY_SHA256: createHash("sha256").update(KEY).digest("hex"),
};
const bootstrap = () => ({ apiKey: KEY, projectId: ENV.MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_ID, apiUrl: "https://api.trigger.dev" });

test("company verification requires registration and fixed project/environment with bounded secret-free errors", async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.trigger.dev/api/v1/projects/proj_testcompany/prod");
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return Response.json(bootstrap());
  };
  assert.equal(await verifyCompanyTriggerKey(KEY, ENV, fetcher), true);
  for (const token of [KEY + "y", KEY.replace("prod", "dev"), "malformed"]) {
    assert.equal(await verifyCompanyTriggerKey(token, ENV, fetcher), false);
  }
  assert.equal(await verifyCompanyTriggerKey(KEY, {}, fetcher), false);
  assert.equal(calls, 1, "unregistered keys must not reach Trigger");
  for (const overrides of [{ projectId: "another_project" }, { apiUrl: "https://attacker.example" }, { apiKey: "other-key" }]) {
    assert.equal(await verifyCompanyTriggerKey(KEY, ENV, async () => Response.json({ ...bootstrap(), ...overrides })), false);
  }
  for (const response of [new Response("revoked", { status: 401 }), new Response(null, { status: 302 }), new Response("not json"), new Response("x".repeat(16_385))]) {
    assert.equal(await verifyCompanyTriggerKey(KEY, ENV, async () => response), false);
  }
  assert.equal(await verifyCompanyTriggerKey(KEY, ENV, async () => { throw new Error(KEY); }), false);
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-company-trigger-"));
  const path = join(directory, "test.sqlite");
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  ensureAccountSchema(database);
  ensureMcpOAuthSchema(database);
  ensureBillingSchema(database);
  provisionInternalAgent({ databasePath: path, secretFile: join(directory, "fake-internal.key") });
  return {
    database,
    apiKey: readFileSync(join(directory, "fake-internal.key"), "utf8").trim(),
    environment: { ...ENV, MARKET_SIGNAL_DEPLOY_TARGET: "node", MARKET_SIGNAL_HOSTED_BILLING: "true", MARKET_SIGNAL_SQLITE_PATH: path,
      MARKET_SIGNAL_INTERNAL_UNLIMITED: "true", TRIGGER_SECRET_KEY: KEY,
      BETTER_AUTH_URL: "https://signal.blyzr.com", BETTER_AUTH_SECRET: "synthetic-secret-longer-than-thirty-two-characters",
      STRIPE_RESTRICTED_KEY: `rk_test_${"a".repeat(24)}`, STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(24)}`,
      STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_SOLO: "price_solo", STRIPE_PRICE_GROWTH: "price_growth", STRIPE_PRICE_AGENCY: "price_agency",
    },
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("verified owner can reserve five reports beyond 20/day; replay is accounted once and ordinary key remains capped", () => {
  const f = fixture();
  try {
    const now = new Date("2026-09-04T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      const result = reserveReport(f.database, COMPANY_WORKSPACE_ID, now, `company:${i}`, 20, true);
      assert.ok(result.id);
      assert.equal(result.unlimited, true);
      assert.equal(result.used, 20 * (i + 1));
    }
    const replay = reserveReport(f.database, COMPANY_WORKSPACE_ID, now, "company:0", 20, true);
    assert.equal(replay.used, 100);
    assert.equal(replay.unlimited, true);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM billing_report_reservations").get().n, 5);
    assert.throws(() => reserveReport(f.database, COMPANY_WORKSPACE_ID, now, "company:0", 50, true), /conflict|different/i);
    assert.equal(reserveReport(f.database, COMPANY_WORKSPACE_ID, now, "ordinary:1", 20).denialReason, "daily-limit");
    assert.equal(reserveReport(f.database, COMPANY_WORKSPACE_ID, now, "ordinary:2", 50).denialReason, "target-limit");
    assert.ok(reserveReport(f.database, COMPANY_WORKSPACE_ID, now, "company:large", 1000, true).id);
    assert.throws(() => reserveReport(f.database, COMPANY_WORKSPACE_ID, now, "company:invalid", 21, true), /Invalid/);
  } finally { f.close(); }
});

test("verified flag cannot lift a different workspace entitlement", () => {
  const f = fixture();
  try {
    f.database.prepare("INSERT INTO workspaces (id, name, slug, kind, created_at, updated_at) VALUES ('other-internal', 'Other', 'other-internal', 'internal', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    setInternalReportEntitlement(f.database, "other-internal", { enabled: true, maxComparisonTarget: 20, dailyComparisonLimit: 20 });
    assert.equal(reserveReport(f.database, "other-internal", new Date(), "other:1", 50, true).denialReason, "target-limit");
  } finally { f.close(); }
});

test("quota exemption requires scoped company credential and server-owned Trigger verification; reads remain available", async (t) => {
  const f = fixture();
  try {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(bootstrap()); });
    const request = (path, method = "GET", token = f.apiKey) => new Request(`https://signal.blyzr.com${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    const account = await reportApiAccountContext(request("/api/reports", "POST"), f.environment);
    assert.equal(account?.workspaceId, COMPANY_WORKSPACE_ID);
    assert.equal(account?.verifiedCompanyTrigger, true);
    assert.equal((await reportApiAccountContext(request(`/api/reports/${"a".repeat(32)}/result`), f.environment))?.verifiedCompanyTrigger, undefined);
    assert.equal(calls, 1);
    assert.equal(await reportApiAccountContext(request("/api/reports", "POST", KEY), f.environment), null, "raw Trigger secrets are never client credentials");
    assert.equal((await reportApiAccountContext(request("/api/reports", "POST"), { ...f.environment, MARKET_SIGNAL_INTERNAL_UNLIMITED: "false" }))?.verifiedCompanyTrigger, undefined);
    await assert.rejects(() => reportApiAccountContext(request("/api/reports", "POST"), { ...f.environment, TRIGGER_SECRET_KEY: "invalid" }), /could not be verified/);
    f.database.prepare("UPDATE internal_report_entitlements SET enabled = 0 WHERE workspace_id = ?").run(COMPANY_WORKSPACE_ID);
    await assert.rejects(() => reportApiAccountContext(request("/api/reports", "POST"), f.environment), /could not be verified/);
    f.database.prepare("UPDATE internal_report_entitlements SET enabled = 1 WHERE workspace_id = ?").run(COMPANY_WORKSPACE_ID);
    f.database.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").run(COMPANY_WORKSPACE_ID);
    assert.equal(await reportApiAccountContext(request("/api/reports", "POST"), f.environment), null);
  } finally { f.close(); }
});

test("company POST requires an idempotency key before reserving or dispatching", async () => {
  const response = await createPersistentReport(new Request("https://signal.blyzr.com/api/reports", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ primaryDomain: "example.com", comparisonTarget: 20 }),
  }), { requireAccount: true, authorizeLoop: async () => ({ workspaceId: COMPANY_WORKSPACE_ID, user: { id: "owner", email: "", name: "Owner" }, verifiedCompanyTrigger: true }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).errorCode, "invalid-request-id");
});

test("request JSON cannot elevate a normal account into company quota exemption", async () => {
  let observed;
  const response = await createPersistentReport(new Request("https://signal.blyzr.com/api/reports", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ primaryDomain: "example.com", commandId: "spoof:1", comparisonTarget: 20, verifiedCompanyTrigger: true }),
  }), {
    requireAccount: true,
    authorizeLoop: async () => ({ workspaceId: "customer", user: { id: "customer", email: "", name: "Customer" } }),
    reserve: async (_workspace, _command, _target, verified) => { observed = verified; return null; },
  });
  assert.equal(response.status, 402);
  assert.equal(observed, false);
});
