import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { betterAuth as betterAuthV16 } from "better-auth-v16";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  accountAuthConfigFromEnvironment,
  accountAuthHandler,
  createAccountAuth,
  ensureAccountSchema,
  ensurePersonalWorkspace,
} from "../app/lib/account-auth.ts";
import { accountUsers } from "../db/schema.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-auth-"));
  return { directory, databasePath: join(directory, "market-signal.sqlite") };
}

function createBetterAuthV16Schema(database) {
  database.exec(`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" integer NOT NULL,
      "image" text,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
    CREATE TABLE "session" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" text NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    );
    CREATE TABLE "account" (
      "id" text PRIMARY KEY NOT NULL,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" text,
      "refreshTokenExpiresAt" text,
      "scope" text,
      "password" text,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
    CREATE TABLE "verification" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" text NOT NULL,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
  `);
}

test("account auth configuration fails closed", () => {
  const complete = {
    MARKET_SIGNAL_DEPLOY_TARGET: "node",
    MARKET_SIGNAL_SQLITE_PATH: "C:\\data\\market-signal.sqlite",
    BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    BETTER_AUTH_URL: "https://signal.blyzr.com",
  };
  assert.deepEqual(accountAuthConfigFromEnvironment(complete), {
    baseURL: "https://signal.blyzr.com",
    databasePath: "C:\\data\\market-signal.sqlite",
    mcpEnabled: false,
    secret: complete.BETTER_AUTH_SECRET,
  });
  assert.equal(accountAuthConfigFromEnvironment({ ...complete, BETTER_AUTH_SECRET: "short" }), null);
  assert.equal(accountAuthConfigFromEnvironment({ ...complete, BETTER_AUTH_URL: "http://signal.blyzr.com" }), null);
  assert.equal(accountAuthConfigFromEnvironment({ ...complete, BETTER_AUTH_URL: "https://signal.blyzr.com/?unexpected=true" }), null);
  assert.equal(accountAuthConfigFromEnvironment({ ...complete, MARKET_SIGNAL_DEPLOY_TARGET: "cloudflare" }), null);
});

test("an unconfigured auth endpoint returns JSON without caching", async () => {
  const previous = {
    target: process.env.MARKET_SIGNAL_DEPLOY_TARGET,
    secret: process.env.BETTER_AUTH_SECRET,
    url: process.env.BETTER_AUTH_URL,
  };
  try {
    process.env.MARKET_SIGNAL_DEPLOY_TARGET = "node";
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_URL;
    const response = await accountAuthHandler(new Request("https://signal.blyzr.com/api/auth/get-session"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).code, "account_auth_not_configured");
  } finally {
    if (previous.target === undefined) delete process.env.MARKET_SIGNAL_DEPLOY_TARGET;
    else process.env.MARKET_SIGNAL_DEPLOY_TARGET = previous.target;
    if (previous.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous.secret;
    if (previous.url === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previous.url;
  }
});

test("account schema and personal workspace creation are durable and idempotent", async () => {
  const { directory, databasePath } = await fixture();
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    ensureAccountSchema(database);
    const now = Date.now();
    database.prepare(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("user-1", "Amina", "amina@example.test", 1, now, now);

    const first = ensurePersonalWorkspace(database, { id: "user-1", name: "Amina" });
    const second = ensurePersonalWorkspace(database, { id: "user-1", name: "Amina" });
    assert.equal(second, first);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspaces").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspace_members").get().total, 1);
    assert.deepEqual(
      database.prepare("SELECT role, user_id AS userId FROM workspace_members").get(),
      { role: "owner", userId: "user-1" },
    );

    database.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(first, "user-1");
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspace_members").get().total, 0);
    assert.equal(ensurePersonalWorkspace(database, { id: "user-1", name: "Amina" }), first);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspaces").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspace_members").get().total, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a committed user without a workspace is repaired before session creation", async () => {
  const { directory, databasePath } = await fixture();
  let auth;
  try {
    auth = await createAccountAuth({
      baseURL: "https://signal.example.test",
      databasePath,
      secret: "a-second-secure-test-secret-with-at-least-32-characters",
    });
    const database = auth.options.database;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("stranded-user", "Recovery User", "recovery@example.test", 1, now, now);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspaces").get().total, 0);

    const context = await auth.$context;
    await context.internalAdapter.createSession("stranded-user");
    await context.internalAdapter.createSession("stranded-user");
    assert.equal(database.prepare("SELECT count(*) AS total FROM session").get().total, 2);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspaces").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspace_members").get().total, 1);
  } finally {
    auth?.options.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Better Auth serves its standard session endpoint over Request and Response", async () => {
  const { directory, databasePath } = await fixture();
  let auth;
  try {
    auth = await createAccountAuth({
      baseURL: "https://signal.example.test",
      databasePath,
      secret: "a-secure-test-secret-with-at-least-32-characters",
    });
    const response = await auth.handler(new Request("https://signal.example.test/api/auth/get-session"));
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);

    const observedAt = new Date("2026-08-08T12:00:00.000Z");
    const context = await auth.$context;
    await context.internalAdapter.createUser({
      id: "better-auth-user",
      name: "Better Auth User",
      email: "better-auth@example.test",
      emailVerified: true,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    const raw = auth.options.database
      .prepare('SELECT typeof("createdAt") AS storageType, "createdAt" FROM "user" WHERE id = ?')
      .get("better-auth-user");
    assert.deepEqual(raw, { storageType: "text", createdAt: observedAt.toISOString() });
    const [drizzleUser] = await drizzle(auth.options.database)
      .select()
      .from(accountUsers)
      .where(eq(accountUsers.id, "better-auth-user"));
    assert.equal(drizzleUser.createdAt, observedAt.toISOString());
  } finally {
    auth?.options.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("email signup creates a user, password account, session, and personal workspace", async () => {
  const { directory, databasePath } = await fixture();
  let auth;
  try {
    auth = await createAccountAuth({
      baseURL: "https://signal.example.test",
      databasePath,
      secret: "a-signup-test-secret-with-at-least-32-characters",
    });
    const response = await auth.handler(new Request("https://signal.example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://signal.example.test" },
      body: JSON.stringify({ name: "Paid User", email: "paid@example.test", password: "secure-password-123" }),
    }));
    assert.equal(response.status, 200);
    const database = auth.options.database;
    assert.equal(database.prepare('SELECT count(*) AS total FROM "user"').get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM account WHERE providerId = 'credential' AND password IS NOT NULL").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM session").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspaces").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM workspace_members WHERE role = 'owner'").get().total, 1);
  } finally {
    auth?.options.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Better Auth 1.7 upgrades a populated 1.6 database without invalidating its session", async () => {
  const { directory, databasePath } = await fixture();
  const secret = "a-production-shaped-upgrade-secret-with-at-least-32-characters";
  const baseURL = "https://signal.example.test";
  let legacyDatabase;
  let upgradedAuth;
  try {
    legacyDatabase = new Database(databasePath);
    legacyDatabase.pragma("foreign_keys = ON");
    createBetterAuthV16Schema(legacyDatabase);
    const legacyAuth = betterAuthV16({
      appName: "Market Signal",
      baseURL,
      database: legacyDatabase,
      secret,
      emailAndPassword: { enabled: true },
    });
    const signup = await legacyAuth.handler(new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({
        name: "Existing User",
        email: "existing@example.test",
        password: "secure-password-123",
      }),
    }));
    assert.equal(signup.status, 200);
    const cookie = signup.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    assert.equal(
      legacyDatabase.prepare("SELECT count(*) AS total FROM account").get().total,
      1,
    );
    assert.equal(
      legacyDatabase.prepare("SELECT count(*) AS total FROM pragma_table_info('account') WHERE name = 'issuer'").get().total,
      0,
    );
    legacyDatabase.close();
    legacyDatabase = undefined;

    upgradedAuth = await createAccountAuth({ baseURL, databasePath, secret });
    const session = await upgradedAuth.handler(new Request(`${baseURL}/api/auth/get-session`, {
      headers: { cookie },
    }));
    assert.equal(session.status, 200);
    assert.equal((await session.json())?.user?.email, "existing@example.test");

    const database = upgradedAuth.options.database;
    assert.deepEqual(
      database.prepare("SELECT providerId, issuer, accountId, userId FROM account").get(),
      {
        providerId: "credential",
        issuer: "local:credential",
        accountId: database.prepare('SELECT id FROM "user"').get().id,
        userId: database.prepare('SELECT id FROM "user"').get().id,
      },
    );
    const issuerColumn = database.prepare('PRAGMA table_info("account")').all()
      .find((column) => column.name === "issuer");
    assert.equal(issuerColumn?.notnull, 1);
    assert.equal(
      database.prepare(`
        SELECT count(*) AS total
        FROM pragma_index_list('account')
        WHERE name = 'account_issuer_accountId_uidx' AND "unique" = 1
      `).get().total,
      1,
    );
  } finally {
    legacyDatabase?.close();
    upgradedAuth?.options.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("VPS strips obsolete platform identity headers at the proxy boundary", async () => {
  const caddy = await readFile(new URL("../deploy/vps/Caddyfile", import.meta.url), "utf8");
  for (const header of [
    "oai-authenticated-user-email",
    "oai-authenticated-user-full-name",
    "oai-authenticated-user-full-name-encoding",
  ]) {
    assert.match(caddy, new RegExp(`header_up -${header}`));
  }
});
