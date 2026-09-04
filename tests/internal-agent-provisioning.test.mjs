import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

import { createPersistentReport } from "../app/api/reports/route.ts";
import { ensureAccountSchema } from "../app/lib/account-auth.ts";
import { ensureBillingSchema, reserveReport } from "../app/lib/billing-store.ts";
import { ensureMcpOAuthSchema } from "../app/lib/mcp-oauth-schema.ts";
import { reportApiAccountContext } from "../app/lib/report-api-auth.ts";
import { authorizeReportApiKey } from "../app/lib/report-api-keys.ts";
import { provisionInternalAgent } from "../scripts/provision-internal-agent-cli.mjs";

const ORIGIN = "https://signal.blyzr.com";

function preparedDatabase(path) {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  ensureAccountSchema(database);
  ensureMcpOAuthSchema(database);
  ensureBillingSchema(database);
  database.close();
}

test("internal agent provisioning stores only a hash and requires explicit rotation", () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-internal-provision-"));
  try {
    const databasePath = join(directory, "market-signal.sqlite");
    const firstSecretFile = join(directory, "first.key");
    const secondSecretFile = join(directory, "second.key");
    preparedDatabase(databasePath);

    const now = new Date("2026-09-04T12:00:00.000Z");
    const first = provisionInternalAgent({ databasePath, secretFile: firstSecretFile, now });
    const firstKey = readFileSync(firstSecretFile, "utf8").trim();
    assert.match(firstKey, /^msk_live_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(first), /msk_live_/);
    assert.equal(first.maxComparisonTarget, 20);
    assert.equal(first.dailyComparisonLimit, 20);

    const inspection = new Database(databasePath);
    inspection.pragma("foreign_keys = ON");
    const stored = inspection.prepare("SELECT secret_hash, last_four FROM report_api_keys WHERE id = ?").get(first.keyId);
    assert.notEqual(stored.secret_hash, firstKey);
    assert.equal(stored.last_four, firstKey.slice(-4));
    assert.equal(inspection.prepare("SELECT count(*) AS total FROM workspace_subscriptions WHERE workspace_id = ?").get(first.workspaceId).total, 0);
    const authorization = authorizeReportApiKey(inspection, firstKey, ["reports:read", "reports:create"], now);
    assert.equal(authorization.ok, true);
    inspection.close();

    assert.throws(
      () => provisionInternalAgent({ databasePath, secretFile: secondSecretFile, now: new Date(now.getTime() + 1_000) }),
      /--rotate/,
    );
    const rotated = provisionInternalAgent({
      databasePath,
      secretFile: secondSecretFile,
      rotate: true,
      now: new Date(now.getTime() + 2_000),
    });
    const rotatedKey = readFileSync(secondSecretFile, "utf8").trim();
    assert.notEqual(rotatedKey, firstKey);
    assert.equal(JSON.stringify(rotated).includes(rotatedKey), false);

    const after = new Database(databasePath);
    assert.equal(after.prepare("SELECT count(*) AS total FROM report_api_keys WHERE workspace_id = ? AND revoked_at IS NULL").get(first.workspaceId).total, 1);
    assert.equal(authorizeReportApiKey(after, firstKey, []).ok, false);
    assert.equal(authorizeReportApiKey(after, rotatedKey, []).ok, true);
    after.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provisioning executable prints metadata but never the credential", () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-internal-provision-cli-"));
  try {
    const databasePath = join(directory, "market-signal.sqlite");
    const secretFile = join(directory, "agent.key");
    preparedDatabase(databasePath);
    const script = resolve("scripts/provision-internal-agent-cli.mjs");
    const result = spawnSync(process.execPath, [script, "--database", databasePath, "--secret-file", secretFile], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /msk_live_/);
    const metadata = JSON.parse(result.stdout);
    assert.equal(metadata.credentialFileWritten, true);
    const secret = readFileSync(secretFile, "utf8").trim();
    assert.match(secret, /^msk_live_/);
    assert.equal(result.stdout.includes(secret), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a provisioned key traverses hosted authorization and applies only its internal comparison entitlement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-internal-integration-"));
  try {
    const databasePath = join(directory, "market-signal.sqlite");
    const secretFile = join(directory, "agent.key");
    preparedDatabase(databasePath);
    const now = new Date("2026-09-04T12:00:00.000Z");
    const provisioned = provisionInternalAgent({ databasePath, secretFile, now });
    const apiKey = readFileSync(secretFile, "utf8").trim();
    const environment = {
      MARKET_SIGNAL_DEPLOY_TARGET: "node",
      MARKET_SIGNAL_HOSTED_BILLING: "true",
      MARKET_SIGNAL_SQLITE_PATH: databasePath,
      BETTER_AUTH_URL: ORIGIN,
      BETTER_AUTH_SECRET: "an-internal-agent-test-secret-longer-than-thirty-two-characters",
      STRIPE_RESTRICTED_KEY: `rk_test_${"a".repeat(24)}`,
      STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(24)}`,
      STRIPE_PRICE_STARTER: "price_starter",
      STRIPE_PRICE_SOLO: "price_solo",
      STRIPE_PRICE_GROWTH: "price_growth",
      STRIPE_PRICE_AGENCY: "price_agency",
    };
    let creationInput;
    const response = await createPersistentReport(new Request(`${ORIGIN}/api/reports`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        primaryDomain: "babanuj.com",
        locale: "en",
        commandId: "orchestrator:babanuj:001",
        comparisonTarget: 20,
      }),
    }), {
      requireAccount: true,
      authorizeLoop: (request) => reportApiAccountContext(request, environment),
      reserve: async (workspaceId, commandId, comparisonTarget) => {
        const database = new Database(databasePath);
        try {
          database.pragma("foreign_keys = ON");
          ensureBillingSchema(database);
          return reserveReport(database, workspaceId, now, commandId, comparisonTarget);
        } finally {
          database.close();
        }
      },
      create: async (input) => {
        creationInput = input;
        return {
          ok: true,
          report: {
            id: "run-internal-integration",
            publicId: "b".repeat(32),
            primaryDomain: "babanuj.com",
            locale: "en",
            status: "queued",
            currentPhase: "queued",
            attemptCount: 1,
            createdAt: now.toISOString(),
            expiresAt: "2026-10-04T12:00:00.000Z",
            productPlan: "starter",
            productLimit: 20,
          },
        };
      },
      dispatch: async () => ({ runId: "trigger-internal-integration", idempotencyKey: "internal-integration" }),
      markDispatched: async () => {},
      markDispatchFailed: async () => {},
      finishReservation: async () => {},
    });
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal(creationInput.workspaceId, provisioned.workspaceId);
    assert.equal(creationInput.commandId, "orchestrator:babanuj:001");
    assert.deepEqual(creationInput.entitlement, { plan: "starter", productLimit: 20 });

    const inspection = new Database(databasePath);
    const reservation = inspection.prepare(`
      SELECT entitlement_source, comparison_target, status
      FROM billing_report_reservations WHERE command_id = ?
    `).get("orchestrator:babanuj:001");
    assert.deepEqual(reservation, { entitlement_source: "internal", comparison_target: 20, status: "reserved" });
    inspection.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
