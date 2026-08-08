import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  accountAuthConfigFromEnvironment,
  accountAuthHandler,
  createAccountAuth,
  ensureAccountSchema,
  ensurePersonalWorkspace,
} from "../app/lib/account-auth.ts";
import {
  chatGPTUserFromHeaders,
  mayTrustChatGPTIdentityHeaders,
} from "../app/lib/chatgpt-identity.ts";
import { accountUsers } from "../db/schema.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-auth-"));
  return { directory, databasePath: join(directory, "market-signal.sqlite") };
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

test("VPS requests cannot authenticate through user-supplied ChatGPT headers", async () => {
  const headers = new Headers({
    "oai-authenticated-user-email": "forged@example.test",
    "oai-authenticated-user-full-name": "Forged%20User",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  assert.equal(mayTrustChatGPTIdentityHeaders({ MARKET_SIGNAL_DEPLOY_TARGET: "node", MARKET_SIGNAL_TRUST_CHATGPT_AUTH_HEADERS: "true" }), false);
  assert.equal(chatGPTUserFromHeaders(headers, { MARKET_SIGNAL_DEPLOY_TARGET: "node", MARKET_SIGNAL_TRUST_CHATGPT_AUTH_HEADERS: "true" }), null);
  for (const target of [undefined, "site", "cloudflare", "future-target"]) {
    assert.equal(mayTrustChatGPTIdentityHeaders({ MARKET_SIGNAL_DEPLOY_TARGET: target, MARKET_SIGNAL_TRUST_CHATGPT_AUTH_HEADERS: "true" }), false);
  }
  assert.equal(mayTrustChatGPTIdentityHeaders({ MARKET_SIGNAL_DEPLOY_TARGET: "sites", MARKET_SIGNAL_TRUST_CHATGPT_AUTH_HEADERS: "true" }), true);

  const caddy = await readFile(new URL("../deploy/vps/Caddyfile", import.meta.url), "utf8");
  for (const header of [
    "oai-authenticated-user-email",
    "oai-authenticated-user-full-name",
    "oai-authenticated-user-full-name-encoding",
  ]) {
    assert.match(caddy, new RegExp(`header_up -${header}`));
  }
});
