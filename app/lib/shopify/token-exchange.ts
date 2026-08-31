import type { ShopifyConfig } from "./config.ts";
import { canonicalShopifyShop } from "./shop-domain.ts";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const OFFLINE_TOKEN_TYPE = "urn:shopify:params:oauth:token-type:offline-access-token";
const MAX_RESPONSE_BYTES = 65_536;

export type ShopifyOfflineToken = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  scopes: string[];
};

export class ShopifyTokenExchangeError extends Error {
  readonly code: "stale-session" | "shopify-unavailable";

  constructor(code: ShopifyTokenExchangeError["code"]) {
    super(code === "stale-session" ? "The Shopify session token is stale." : "Shopify token exchange is unavailable.");
    this.name = "ShopifyTokenExchangeError";
    this.code = code;
  }
}

function boundedToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 16_384 || /\s/.test(value)) {
    throw new ShopifyTokenExchangeError("shopify-unavailable");
  }
  return value;
}

function positiveSeconds(value: unknown, required = true): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 366 * 24 * 60 * 60) {
    if (!required && (value === undefined || value === null || value === "")) return 0;
    throw new ShopifyTokenExchangeError("shopify-unavailable");
  }
  return parsed;
}

function normalizedScopes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const scopes = values.map((scope) => String(scope).trim()).filter(Boolean);
  if (scopes.some((scope) => !/^[a-z][a-z0-9_]{0,79}$/.test(scope)) || scopes.length > 100) {
    throw new ShopifyTokenExchangeError("shopify-unavailable");
  }
  return [...new Set(scopes)].sort();
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    throw new ShopifyTokenExchangeError("shopify-unavailable");
  }
  if (!response.body) throw new ShopifyTokenExchangeError("shopify-unavailable");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ShopifyTokenExchangeError("shopify-unavailable");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function exchangeShopifyOfflineToken(
  input: {
    config: Pick<ShopifyConfig, "clientId" | "clientSecret" | "tokenExchangeTimeoutMs">;
    idToken: string;
    now?: Date;
    shop: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<ShopifyOfflineToken> {
  const shop = canonicalShopifyShop(input.shop);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.tokenExchangeTimeoutMs);
  try {
    const body = new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: input.idToken,
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: OFFLINE_TOKEN_TYPE,
      expiring: "1",
    });
    const response = await fetcher(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: controller.signal,
    });
    if (response.status === 400) throw new ShopifyTokenExchangeError("stale-session");
    if (!response.ok) throw new ShopifyTokenExchangeError("shopify-unavailable");
    const text = await boundedResponseText(response);
    if (!text) throw new ShopifyTokenExchangeError("shopify-unavailable");
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new ShopifyTokenExchangeError("shopify-unavailable");
    }
    const accessToken = boundedToken(payload.access_token);
    const refreshToken = payload.refresh_token ? boundedToken(payload.refresh_token) : "";
    const accessExpiresIn = positiveSeconds(payload.expires_in);
    const refreshExpiresIn = refreshToken ? positiveSeconds(payload.refresh_token_expires_in) : 0;
    const observedAt = input.now || new Date();
    return {
      accessToken,
      accessTokenExpiresAt: new Date(observedAt.getTime() + accessExpiresIn * 1_000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresIn ? new Date(observedAt.getTime() + refreshExpiresIn * 1_000).toISOString() : "",
      scopes: normalizedScopes(payload.scope),
    };
  } catch (error) {
    if (error instanceof ShopifyTokenExchangeError) throw error;
    throw new ShopifyTokenExchangeError("shopify-unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
