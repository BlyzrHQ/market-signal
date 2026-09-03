import type Database from "better-sqlite3";

export function ensureMcpOAuthSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS "jwks" (
      "id" text PRIMARY KEY NOT NULL,
      "publicKey" text NOT NULL,
      "privateKey" text NOT NULL,
      "createdAt" date NOT NULL,
      "expiresAt" date,
      "alg" text,
      "crv" text
    );
    CREATE TABLE IF NOT EXISTS "oauthClient" (
      "id" text PRIMARY KEY NOT NULL,
      "clientId" text NOT NULL UNIQUE,
      "clientSecret" text,
      "clientDiscoveryId" text,
      "disabled" integer DEFAULT 0,
      "skipConsent" integer,
      "enableEndSession" integer,
      "subjectType" text,
      "scopes" text,
      "clientCredentialsScopes" text,
      "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
      "createdAt" date,
      "updatedAt" date,
      "name" text,
      "uri" text,
      "icon" text,
      "contacts" text,
      "tos" text,
      "policy" text,
      "softwareId" text,
      "softwareVersion" text,
      "softwareStatement" text,
      "redirectUris" text NOT NULL,
      "postLogoutRedirectUris" text,
      "backchannelLogoutUri" text,
      "backchannelLogoutSessionRequired" integer,
      "tokenEndpointAuthMethod" text,
      "applicationType" text,
      "jwks" text,
      "jwksUri" text,
      "grantTypes" text,
      "responseTypes" text,
      "requirePKCE" integer,
      "dpopBoundAccessTokens" integer DEFAULT 0,
      "referenceId" text,
      "metadata" text
    );
    CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient"("userId");
    CREATE TABLE IF NOT EXISTS "oauthResource" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL UNIQUE,
      "name" text NOT NULL,
      "accessTokenTtl" integer,
      "refreshTokenTtl" integer,
      "signingAlgorithm" text,
      "signingKeyId" text,
      "allowedScopes" text,
      "customClaims" text,
      "dpopBoundAccessTokensRequired" integer DEFAULT 0,
      "disabled" integer DEFAULT 0,
      "createdAt" date,
      "updatedAt" date,
      "policyVersion" integer DEFAULT 1,
      "metadata" text
    );
    CREATE TABLE IF NOT EXISTS "oauthClientResource" (
      "id" text PRIMARY KEY NOT NULL,
      "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
      "resourceId" text NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
      "metadata" text,
      "createdAt" date
    );
    CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauthClientResource"("clientId");
    CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauthClientResource"("resourceId");
    CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx"
      ON "oauthClientResource"("clientId", "resourceId");
    CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
      "id" text PRIMARY KEY NOT NULL,
      "token" text NOT NULL UNIQUE,
      "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
      "sessionId" text REFERENCES "session"("id") ON DELETE SET NULL,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "referenceId" text,
      "authorizationCodeId" text,
      "resources" text,
      "requestedUserInfoClaims" text,
      "expiresAt" date NOT NULL,
      "createdAt" date NOT NULL,
      "revoked" date,
      "rotatedAt" date,
      "rotationReplayResponse" text,
      "rotationReplayExpiresAt" date,
      "authTime" date,
      "confirmation" text,
      "scopes" text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
    CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken"("sessionId");
    CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");
    CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken"("authorizationCodeId");
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
      "id" text PRIMARY KEY NOT NULL,
      "token" text NOT NULL UNIQUE,
      "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
      "sessionId" text REFERENCES "session"("id") ON DELETE SET NULL,
      "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
      "referenceId" text,
      "authorizationCodeId" text,
      "resources" text,
      "requestedUserInfoClaims" text,
      "refreshId" text REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE,
      "expiresAt" date NOT NULL,
      "createdAt" date NOT NULL,
      "revoked" date,
      "confirmation" text,
      "scopes" text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
    CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauthAccessToken"("sessionId");
    CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
    CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken"("authorizationCodeId");
    CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauthAccessToken"("refreshId");
    CREATE TABLE IF NOT EXISTS "oauthConsent" (
      "id" text PRIMARY KEY NOT NULL,
      "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
      "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
      "referenceId" text,
      "resources" text,
      "requestedUserInfoClaims" text,
      "scopes" text NOT NULL,
      "createdAt" date NOT NULL,
      "updatedAt" date NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
    CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent"("userId");
    CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" date NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "mcp_oauth_connection_events" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "client_id" text NOT NULL,
      "event_type" text NOT NULL,
      "details_json" text NOT NULL DEFAULT '{}',
      "created_at" text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "mcp_oauth_connection_events_user_created_idx"
      ON "mcp_oauth_connection_events"("user_id", "created_at");
    CREATE TABLE IF NOT EXISTS "report_api_keys" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "secret_hash" text NOT NULL CHECK(length("secret_hash") = 43),
      "last_four" text NOT NULL CHECK(length("last_four") = 4),
      "scopes" text NOT NULL,
      "created_at" text NOT NULL,
      "expires_at" text NOT NULL,
      "last_used_at" text,
      "revoked_at" text
    );
    CREATE INDEX IF NOT EXISTS "report_api_keys_owner_idx"
      ON "report_api_keys"("user_id", "workspace_id", "created_at");
    CREATE INDEX IF NOT EXISTS "report_api_keys_active_idx"
      ON "report_api_keys"("workspace_id", "revoked_at");
    CREATE TABLE IF NOT EXISTS "report_api_key_events" (
      "id" text PRIMARY KEY NOT NULL,
      "key_id" text NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "event_type" text NOT NULL,
      "created_at" text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "report_api_key_events_owner_idx"
      ON "report_api_key_events"("user_id", "workspace_id", "created_at");
  `);
}
