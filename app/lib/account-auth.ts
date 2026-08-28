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

export type AccountContext = {
  user: { id: string; name: string; email: string };
  workspaceId: string;
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
    emailAndPassword: { enabled: true },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            ensurePersonalWorkspace(database, user);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            ensurePersonalWorkspaceForUserId(database, session.userId);
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
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" text NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY NOT NULL,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "issuer" text NOT NULL,
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
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" text NOT NULL,
      "createdAt" text NOT NULL,
      "updatedAt" text NOT NULL
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

  ensureAccountIssuerSchema(database);
}

type AccountColumnInfo = {
  name: string;
  notnull: number;
};

type LegacyAccountProvider = {
  providerId: string;
  total: number;
};

function ensureAccountIssuerSchema(database: Database.Database): void {
  const migrate = database.transaction(() => {
    let columns = database.prepare('PRAGMA table_info("account")').all() as AccountColumnInfo[];
    let issuerColumn = columns.find((column) => column.name === "issuer");

    if (!issuerColumn) {
      database.exec('ALTER TABLE "account" ADD COLUMN "issuer" text;');
      columns = database.prepare('PRAGMA table_info("account")').all() as AccountColumnInfo[];
      issuerColumn = columns.find((column) => column.name === "issuer");
    }

    const providersMissingIssuer = database.prepare(`
      SELECT providerId, count(*) AS total
      FROM "account"
      WHERE issuer IS NULL OR trim(issuer) = ''
      GROUP BY providerId
    `).all() as LegacyAccountProvider[];
    const unsupportedProviders = providersMissingIssuer.filter(({ providerId }) => providerId !== "credential");
    if (unsupportedProviders.length > 0) {
      throw new Error(
        `Better Auth 1.7 account migration requires an explicit trusted issuer for provider(s): ${unsupportedProviders
          .map(({ providerId }) => providerId)
          .join(", ")}.`,
      );
    }

    database.prepare(`
      UPDATE "account"
      SET issuer = 'local:credential', accountId = userId
      WHERE (issuer IS NULL OR trim(issuer) = '') AND providerId = 'credential'
    `).run();

    const incomplete = database.prepare(`
      SELECT count(*) AS total
      FROM "account"
      WHERE issuer IS NULL OR trim(issuer) = '' OR accountId IS NULL OR trim(accountId) = ''
    `).get() as { total: number };
    if (incomplete.total > 0) {
      throw new Error("Better Auth 1.7 account migration left incomplete account identities.");
    }

    const collision = database.prepare(`
      SELECT issuer, accountId, count(*) AS total
      FROM "account"
      GROUP BY issuer, accountId
      HAVING count(*) > 1
      LIMIT 1
    `).get() as { issuer: string; accountId: string; total: number } | undefined;
    if (collision) {
      throw new Error("Better Auth 1.7 account migration found an account identity collision.");
    }

    if (!issuerColumn || issuerColumn.notnull !== 1) {
      database.exec(`
        CREATE TABLE "account_v17_migration" (
          "id" text PRIMARY KEY NOT NULL,
          "accountId" text NOT NULL,
          "providerId" text NOT NULL,
          "issuer" text NOT NULL,
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
        INSERT INTO "account_v17_migration" (
          id, accountId, providerId, issuer, userId, accessToken, refreshToken, idToken,
          accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
        )
        SELECT
          id, accountId, providerId, issuer, userId, accessToken, refreshToken, idToken,
          accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
        FROM "account";
        DROP TABLE "account";
        ALTER TABLE "account_v17_migration" RENAME TO "account";
      `);
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
      CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx"
        ON "account"("issuer", "accountId");
    `);
  });

  migrate.immediate();
}

export function ensurePersonalWorkspace(
  database: Database.Database,
  user: AccountUser,
): string {
  const existing = database
    .prepare("SELECT id FROM workspaces WHERE personal_owner_user_id = ?")
    .get(user.id) as { id: string } | undefined;

  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  const slugSuffix = createHash("sha256").update(user.id).digest("hex").slice(0, 24);
  const slug = `personal-${slugSuffix}`;
  const workspaceName = `${user.name.trim() || "Personal"}'s workspace`;

  const create = database.transaction(() => {
    if (existing) {
      database.prepare(`
        INSERT OR IGNORE INTO workspace_members
          (workspace_id, user_id, role, created_at)
        VALUES (?, ?, 'owner', ?)
      `).run(existing.id, user.id, now);
      return existing.id;
    }
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

export function ensurePersonalWorkspaceForUserId(
  database: Database.Database,
  userId: string,
): string {
  const user = database
    .prepare('SELECT id, name FROM "user" WHERE id = ?')
    .get(userId) as AccountUser | undefined;
  if (!user) throw new Error("Cannot create a workspace for an unknown user.");
  return ensurePersonalWorkspace(database, user);
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

export async function accountContext(request: Request): Promise<AccountContext | null> {
  const config = accountAuthConfigFromEnvironment(process.env);
  if (!config) return null;
  const auth = await getAccountAuth(config);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return null;
  const databasePath = await canonicalNodeSqlitePath(config.databasePath);
  const database = new Database(databasePath);
  try {
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.pragma("foreign_keys = ON");
    ensureAccountSchema(database);
    const workspaceId = ensurePersonalWorkspace(database, {
      id: session.user.id,
      name: session.user.name || "Personal",
    });
    return {
      user: { id: session.user.id, name: session.user.name || "", email: session.user.email },
      workspaceId,
    };
  } finally {
    database.close();
  }
}
