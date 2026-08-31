import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ShopifyConfig } from "./config.ts";
import { canonicalShopifyShop } from "./shop-domain.ts";

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CIPHERTEXT_LENGTH = 32_768;

export type ShopifyTokenPurpose = "offline-access" | "refresh";

type TokenCryptoConfig = Pick<ShopifyConfig, "encryptionActiveKeyVersion" | "encryptionKeys">;

type TokenEnvelope = {
  c: string;
  i: string;
  k: string;
  t: string;
  v: 1;
};

export class ShopifyTokenCryptoError extends Error {
  constructor() {
    super("The protected Shopify token could not be processed.");
    this.name = "ShopifyTokenCryptoError";
  }
}

function authenticatedData(shop: string, purpose: ShopifyTokenPurpose, keyVersion: string): Buffer {
  return Buffer.from(`market-signal|shopify-token|${ENVELOPE_VERSION}|${keyVersion}|${canonicalShopifyShop(shop)}|${purpose}`, "utf8");
}

function validEnvelope(value: unknown): value is TokenEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.v === ENVELOPE_VERSION &&
    typeof item.k === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(item.k) &&
    typeof item.i === "string" && typeof item.c === "string" && typeof item.t === "string";
}

function decodedBase64Url(value: string, maximumBytes: number): Buffer {
  if (!value || value.length > maximumBytes * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ShopifyTokenCryptoError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength > maximumBytes || decoded.toString("base64url") !== value) {
    throw new ShopifyTokenCryptoError();
  }
  return decoded;
}

export function encryptShopifyToken(
  plaintext: string,
  shop: string,
  purpose: ShopifyTokenPurpose,
  config: TokenCryptoConfig,
): string {
  if (!plaintext || plaintext.length > 16_384) throw new ShopifyTokenCryptoError();
  const keyVersion = config.encryptionActiveKeyVersion;
  const key = config.encryptionKeys.get(keyVersion);
  if (!key || key.byteLength !== 32) throw new ShopifyTokenCryptoError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(authenticatedData(shop, purpose, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: TokenEnvelope = {
    v: ENVELOPE_VERSION,
    k: keyVersion,
    i: iv.toString("base64url"),
    c: ciphertext.toString("base64url"),
    t: cipher.getAuthTag().toString("base64url"),
  };
  return JSON.stringify(envelope);
}

export function decryptShopifyToken(
  encodedEnvelope: string,
  shop: string,
  purpose: ShopifyTokenPurpose,
  config: Pick<ShopifyConfig, "encryptionKeys">,
): string {
  if (!encodedEnvelope || encodedEnvelope.length > MAX_CIPHERTEXT_LENGTH) throw new ShopifyTokenCryptoError();
  try {
    const envelope: unknown = JSON.parse(encodedEnvelope);
    if (!validEnvelope(envelope)) throw new ShopifyTokenCryptoError();
    const key = config.encryptionKeys.get(envelope.k);
    const iv = decodedBase64Url(envelope.i, IV_BYTES);
    const ciphertext = decodedBase64Url(envelope.c, 16_384);
    const tag = decodedBase64Url(envelope.t, TAG_BYTES);
    if (!key || key.byteLength !== 32 || iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES || ciphertext.byteLength === 0) {
      throw new ShopifyTokenCryptoError();
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(authenticatedData(shop, purpose, envelope.k));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!plaintext || plaintext.length > 16_384) throw new ShopifyTokenCryptoError();
    return plaintext;
  } catch (error) {
    if (error instanceof ShopifyTokenCryptoError) throw error;
    throw new ShopifyTokenCryptoError();
  }
}
