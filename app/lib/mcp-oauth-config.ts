import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";
import { BILLING_PLANS, configuredPriceId, hostedBillingEnabled } from "./billing-plans.ts";
import { fetchPinnedClientMetadataResource } from "./cimd-node-transport.ts";
import {
  MARKET_SIGNAL_ORIGIN,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_AUTHORIZATION_SCOPES,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  MCP_RESOURCE,
} from "./mcp-oauth-shared.ts";

export * from "./mcp-oauth-shared.ts";

type Environment = Record<string, string | undefined>;

export function hostedMcpEnabled(
  environment: Environment,
  baseURL: string,
): boolean {
  if (baseURL !== MARKET_SIGNAL_ORIGIN || !hostedBillingEnabled(environment)) return false;
  if (!/^rk_(?:test|live)_[A-Za-z0-9_]{20,}$/.test(String(environment.STRIPE_RESTRICTED_KEY || "").trim())) return false;
  if (!/^whsec_[A-Za-z0-9]{20,}$/.test(String(environment.STRIPE_WEBHOOK_SECRET || "").trim())) return false;
  return Object.values(BILLING_PLANS).every((plan) => configuredPriceId(plan, environment));
}

export function createHostedMcpAuthPlugins(baseURL: string) {
  return [
    jwt({
      disableSettingJwtHeader: true,
      jwks: {
        keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
        rotationInterval: 30 * 24 * 60 * 60,
        gracePeriod: 7 * 24 * 60 * 60,
      },
      jwt: { issuer: baseURL },
    }),
    mcp({
      loginPage: "/account",
      consentPage: "/oauth/consent",
      resource: MCP_RESOURCE,
      scopes: [...MCP_AUTHORIZATION_SCOPES],
      resources: [{
        identifier: MCP_RESOURCE,
        name: "Market Signal MCP",
        accessTokenTtl: MCP_ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenTtl: MCP_REFRESH_TOKEN_TTL_SECONDS,
        // Better Auth retains offline_access on the refresh-token family only
        // when the audience policy permits it; this enables strict rotation.
        allowedScopes: [...MCP_AUTHORIZATION_SCOPES],
        signingAlgorithm: "EdDSA",
      }],
      resourceSeedMode: "overwrite",
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
      refreshTokenReuseInterval: 0,
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      allowPublicClientPrelogin: true,
      enforcePerClientResources: true,
    }),
    cimd({
      fetchClientMetadataResource: fetchPinnedClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
      metadataRevalidationInterval: "60m",
      maxCacheEntries: 500,
      metadataFetchPolicy: {
        minimumFetchInterval: 1,
        maximumConcurrentFetches: 8,
        maximumConcurrentFetchesPerOrigin: 2,
        maximumFetchesPerMinute: 60,
        maximumFetchesPerOriginPerMinute: 12,
      },
      onClientCreated: ({ client }) => {
        let host = "unknown";
        try {
          host = new URL(client.clientId).host;
        } catch {
          // Non-URL IDs are allowed only for explicitly registered test clients.
        }
        console.info("Market Signal MCP client connected.", { host, discovery: "cimd" });
      },
    }),
  ];
}
