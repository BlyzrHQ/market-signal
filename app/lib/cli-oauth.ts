import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  CLI_AUTHORIZATION_SCOPES,
  CLI_CLIENT_ID,
  CLI_REGISTERED_REDIRECT_URI,
  CLI_RESOURCE,
} from "./mcp-oauth-shared.ts";

export function ensureFirstPartyCliClient(database: Database.Database, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("The CLI OAuth client timestamp is invalid.");
  const resource = database.prepare(`SELECT identifier FROM oauthResource WHERE identifier = ? AND coalesce(disabled, 0) = 0`).get(CLI_RESOURCE);
  if (!resource) throw new Error("The CLI OAuth protected resource is unavailable.");

  const observedAt = now.toISOString();
  const scopes = JSON.stringify(CLI_AUTHORIZATION_SCOPES);
  const redirectUris = JSON.stringify([CLI_REGISTERED_REDIRECT_URI]);
  const grantTypes = JSON.stringify(["authorization_code", "refresh_token"]);
  const responseTypes = JSON.stringify(["code"]);

  database.transaction(() => {
    const existing = database.prepare(`SELECT id, clientSecret FROM oauthClient WHERE clientId = ?`).get(CLI_CLIENT_ID) as { id: string; clientSecret: string | null } | undefined;
    if (existing?.clientSecret) throw new Error("The first-party CLI OAuth client is not a public client.");
    if (existing) {
      database.prepare(`
        UPDATE oauthClient
        SET disabled = 0,
            scopes = ?,
            clientCredentialsScopes = '[]',
            updatedAt = ?,
            name = 'Market Signal CLI',
            uri = ?,
            redirectUris = ?,
            tokenEndpointAuthMethod = 'none',
            applicationType = 'native',
            grantTypes = ?,
            responseTypes = ?,
            requirePKCE = 1,
            dpopBoundAccessTokens = 0,
            skipConsent = 0
        WHERE clientId = ?
      `).run(scopes, observedAt, CLI_CLIENT_ID, redirectUris, grantTypes, responseTypes, CLI_CLIENT_ID);
    } else {
      database.prepare(`
        INSERT INTO oauthClient (
          id, clientId, clientSecret, clientDiscoveryId, disabled, skipConsent,
          scopes, clientCredentialsScopes, createdAt, updatedAt, name, uri,
          redirectUris, tokenEndpointAuthMethod, applicationType, grantTypes,
          responseTypes, requirePKCE, dpopBoundAccessTokens
        ) VALUES (?, ?, NULL, NULL, 0, 0, ?, '[]', ?, ?, 'Market Signal CLI', ?, ?, 'none', 'native', ?, ?, 1, 0)
      `).run(randomUUID(), CLI_CLIENT_ID, scopes, observedAt, observedAt, CLI_CLIENT_ID, redirectUris, grantTypes, responseTypes);
    }
    database.prepare(`
      INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(clientId, resourceId) DO NOTHING
    `).run(randomUUID(), CLI_CLIENT_ID, CLI_RESOURCE, observedAt);
  }).immediate();
}
