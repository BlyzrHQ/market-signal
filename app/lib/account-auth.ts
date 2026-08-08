import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { createHash, randomUUID } from "node:crypto";
import { canonicalNodeSqlitePath } from "./node-sqlite-database.ts";

const MINIMUM_SECRET_LENGTH = 32;
const BUSY_TIMEOUT_MS = 10_000;

export type AccountAuthConfig = {
  baseURL: string;
  databasePath: string;
  secret: string;
};

type AccountUser = {
  id: string;
  name: string;
};

type AccountAuthEnvironment = Record<string, string | undefined>;

let authPromise: ReturnType<typeof createAccountAuth> | null = null;

export function accountAuthConfigFromEnvironment(
  environment: AccountAuthEnvironment,
): AccountAuthConfig | null {
  const secret = String(environment.BETTER_AUTH_SECRET || "").trim();
  const baseURL = String(environment.BETTER_AUTH_URL || "").trim();
  const databasePath = String(environment.MARKET_SIGNAL_SQLITE_PATH || "").trim();

  if (
    environment.MARKET_SIGNAL_DEPLOY_TARGET !== "node" ||
    secret.length < MINIMUM_SECRET_LENGTH ||
    !databasePath
  ) {
    return null;
  }

  let parsedURL: URL;
  try {
    parsedURL = new URL(baseURL);
  } catch {
    return null;
  }
  if (
    parsedURL.protocol !== "https:" ||
    parsedURL.pathname !== "/" ||
    parsedURL.search ||
    parsedURL.hash ||
    parsedURL.username ||
    parsedURL.password
  ) return null;

  return {
    baseURL: parsedURL.origin,
    databasePath,
    secret,
  };
}

export async function accountAuthHandler(request: Request): Promise<Response> {
  const config = accountAuthConfigFromEnvironment(process.env);
  if (!config) {
    return Response.json(
      {
        code: "account_auth_not_configured",
        error: "Account sign-in is not configured on this deployment.",
      },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  try {
    const auth = await getAccountAuth(config);
    return auth.handler(request);
  } catch (error) {
    console.error("Account authentication failed to initialize.", error);
    return Response.json(
      {
        code: "account_auth_unavailable",
        error: "Account sign-in is temporarily unavailable.",
      },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

export async function createAccountAuth(config: AccountAuthConfig) {
  const databasePath = await canonicalNodeSqlitePath(config.databasePath);
  const database = new Database(databasePath);
  database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  ensureAccountSchema(database);

  return betterAuth({
    appName: "Market Signal",
    baseURL: config.baseURL,
    database,
    secret: config.secret,
    emailAndPassword: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            ensurePersonalWorkspace(database, user);
          },
        },
      },
    },
  });
}

export function ensureAccountSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" integer NOT NULL,
      "image" text,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" integer NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY NOT NULL,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" integer,
      "refreshTokenExpiresAt" integer,
      "scope" text,
      "password" text,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" integer NOT NULL,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");
    CREATE TABLE IF NOT EXISTS "workspaces" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "kind" text NOT NULL DEFAULT 'personal',
      "personal_owner_user_id" text UNIQUE REFERENCES "user"("id") ON DELETE CASCADE,
      "created_at" text NOT NULL,
      "updated_at" text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "workspace_members" (
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "role" text NOT NULL DEFAULT 'owner',
      "created_at" text NOT NULL,
      PRIMARY KEY ("workspace_id", "user_id")
    );
    CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members"("user_id");
  `);
}

export function ensurePersonalWorkspace(
  database: Database.Database,
  user: AccountUser,
): string {
  const existing = database
    .prepare("SELECT id FROM workspaces WHERE personal_owner_user_id = ?")
    .get(user.id) as { id: string } | undefined;
  if (existing) return existing.id;

  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  const slugSuffix = createHash("sha256").update(user.id).digest("hex").slice(0, 24);
  const slug = `personal-${slugSuffix}`;
  const workspaceName = `${user.name.trim() || "Personal"}'s workspace`;

  const create = database.transaction(() => {
    database.prepare(`
      INSERT OR IGNORE INTO workspaces
        (id, name, slug, kind, personal_owner_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'personal', ?, ?, ?)
    `).run(workspaceId, workspaceName, slug, user.id, now, now);
    const workspace = database
      .prepare("SELECT id FROM workspaces WHERE personal_owner_user_id = ?")
      .get(user.id) as { id: string };
    database.prepare(`
      INSERT OR IGNORE INTO workspace_members
        (workspace_id, user_id, role, created_at)
      VALUES (?, ?, 'owner', ?)
    `).run(workspace.id, user.id, now);
    return workspace.id;
  });

  return create.immediate();
}

async function getAccountAuth(config: AccountAuthConfig) {
  authPromise ??= createAccountAuth(config);
  try {
    return await authPromise;
  } catch (error) {
    authPromise = null;
    throw error;
  }
}
