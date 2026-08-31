import type Database from "better-sqlite3";
import {
  shopifyConfigFromProcessEnvironment,
  ShopifyConfigurationError,
  type ShopifyConfig,
} from "../../../lib/shopify/config.ts";
import {
  shopifyAuthenticationResponse,
  shopifyBearerToken,
  ShopifyAuthenticationError,
  verifyShopifyIdToken,
} from "../../../lib/shopify/id-token.ts";
import { encryptShopifyToken, ShopifyTokenCryptoError } from "../../../lib/shopify/token-crypto.ts";
import {
  exchangeShopifyOfflineToken,
  ShopifyTokenExchangeError,
} from "../../../lib/shopify/token-exchange.ts";
import {
  openShopifyDatabase,
  saveShopifyInstallation,
  ShopifyStoreError,
} from "../../../lib/shopify/store.ts";

type BootstrapServices = {
  config: () => ShopifyConfig;
  exchangeToken: typeof exchangeShopifyOfflineToken;
  openDatabase: (databasePath: string) => Promise<Database.Database>;
  verifyIdToken: typeof verifyShopifyIdToken;
};

const defaultServices: BootstrapServices = {
  config: shopifyConfigFromProcessEnvironment,
  exchangeToken: exchangeShopifyOfflineToken,
  openDatabase: openShopifyDatabase,
  verifyIdToken: verifyShopifyIdToken,
};

function boundedError(code: string, error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ code, error }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function handleShopifyBootstrap(request: Request, services: BootstrapServices = defaultServices): Promise<Response> {
  let config: ShopifyConfig;
  try {
    config = services.config();
  } catch (error) {
    if (error instanceof ShopifyConfigurationError) {
      return boundedError("shopify_not_configured", "Shopify is not configured on this deployment.", 503);
    }
    return boundedError("shopify_unavailable", "Shopify is temporarily unavailable.", 503);
  }

  let idToken: string;
  let verified: Awaited<ReturnType<typeof verifyShopifyIdToken>>;
  try {
    idToken = shopifyBearerToken(request);
    verified = await services.verifyIdToken(idToken, config);
  } catch (error) {
    if (error instanceof ShopifyAuthenticationError) return shopifyAuthenticationResponse(error);
    return shopifyAuthenticationResponse(new ShopifyAuthenticationError());
  }

  try {
    const token = await services.exchangeToken({ config, idToken, shop: verified.shop });
    const accessTokenCiphertext = encryptShopifyToken(token.accessToken, verified.shop, "offline-access", config);
    const refreshTokenCiphertext = token.refreshToken
      ? encryptShopifyToken(token.refreshToken, verified.shop, "refresh", config)
      : "";
    const database = await services.openDatabase(config.databasePath);
    try {
      const installed = saveShopifyInstallation(database, {
        shop: verified.shop,
        staffSubject: verified.staffSubject,
        requiredScopes: config.requiredScopes,
        tokens: {
          accessTokenCiphertext,
          accessTokenExpiresAt: token.accessTokenExpiresAt,
          refreshTokenCiphertext,
          refreshTokenExpiresAt: token.refreshTokenExpiresAt,
          scopes: token.scopes,
          tokenKeyVersion: config.encryptionActiveKeyVersion,
        },
      });
      return Response.json(
        {
          shop: installed.shop,
          workspaceId: installed.workspaceId,
          actorUserId: installed.userId,
          installState: installed.installState,
          requiredScopesGranted: installed.requiredScopesGranted,
        },
        { status: installed.created || installed.reconnected ? 201 : 200, headers: { "cache-control": "no-store" } },
      );
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof ShopifyTokenExchangeError && error.code === "stale-session") {
      return boundedError(
        "shopify_session_stale",
        "Refresh the Shopify session and try again.",
        401,
        { "X-Shopify-Retry-Invalid-Session-Request": "1" },
      );
    }
    if (error instanceof ShopifyTokenExchangeError) {
      return boundedError("shopify_exchange_unavailable", "Shopify authorization is temporarily unavailable.", 502);
    }
    if (error instanceof ShopifyStoreError) {
      return boundedError(error.code, "Shopify storage is temporarily unavailable.", error.httpStatus);
    }
    if (error instanceof ShopifyTokenCryptoError) {
      return boundedError("shopify_token_protection_failed", "Shopify storage is temporarily unavailable.", 503);
    }
    return boundedError("shopify_unavailable", "Shopify is temporarily unavailable.", 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleShopifyBootstrap(request);
}
