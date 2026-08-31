import { isAbsolute } from "node:path";

const KEY_BYTES = 32;
const MINIMUM_CLIENT_SECRET_LENGTH = 32;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const API_VERSION_PATTERN = /^\d{4}-(?:01|04|07|10)$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ShopifyConfig = {
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  databasePath: string;
  encryptionActiveKeyVersion: string;
  encryptionKeys: ReadonlyMap<string, Buffer>;
  requiredScopes: readonly ["read_products"];
  tokenExchangeTimeoutMs: number;
};

export class ShopifyConfigurationError extends Error {
  constructor() {
    super("Shopify is not configured on this deployment.");
    this.name = "ShopifyConfigurationError";
  }
}

function invalidConfiguration(): never {
  throw new ShopifyConfigurationError();
}

function parsedEncryptionKeys(value: string): ReadonlyMap<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalidConfiguration();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalidConfiguration();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 10) return invalidConfiguration();
  const keys = new Map<string, Buffer>();
  for (const [version, encoded] of entries) {
    if (!VERSION_PATTERN.test(version) || typeof encoded !== "string" || !BASE64_PATTERN.test(encoded)) {
      return invalidConfiguration();
    }
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== KEY_BYTES) return invalidConfiguration();
    keys.set(version, key);
  }
  return keys;
}

export function shopifyConfigFromEnvironment(
  environment: Record<string, string | undefined>,
): ShopifyConfig {
  const clientId = String(environment.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(environment.SHOPIFY_CLIENT_SECRET || "").trim();
  const databasePath = String(environment.MARKET_SIGNAL_SQLITE_PATH || "").trim();
  const apiVersion = String(environment.SHOPIFY_API_VERSION || "").trim();
  const activeKeyVersion = String(environment.SHOPIFY_TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION || "").trim();
  const encodedKeys = String(environment.SHOPIFY_TOKEN_ENCRYPTION_KEYS_JSON || "").trim();

  if (
    environment.MARKET_SIGNAL_SHOPIFY_APP !== "true" ||
    environment.MARKET_SIGNAL_DEPLOY_TARGET !== "node" ||
    !clientId || clientId.length > 200 ||
    clientSecret.length < MINIMUM_CLIENT_SECRET_LENGTH || clientSecret.length > 500 ||
    !databasePath || !isAbsolute(databasePath) || databasePath.includes("\0") ||
    !API_VERSION_PATTERN.test(apiVersion) ||
    !VERSION_PATTERN.test(activeKeyVersion) ||
    !encodedKeys
  ) return invalidConfiguration();

  const encryptionKeys = parsedEncryptionKeys(encodedKeys);
  if (!encryptionKeys.has(activeKeyVersion)) return invalidConfiguration();

  return {
    apiVersion,
    clientId,
    clientSecret,
    databasePath,
    encryptionActiveKeyVersion: activeKeyVersion,
    encryptionKeys,
    requiredScopes: ["read_products"],
    tokenExchangeTimeoutMs: 10_000,
  };
}

export function shopifyConfigFromProcessEnvironment(): ShopifyConfig {
  return shopifyConfigFromEnvironment(process.env);
}
