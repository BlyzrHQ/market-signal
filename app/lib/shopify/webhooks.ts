import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalShopifyShop } from "./shop-domain.ts";
import type { ShopifyWebhookEvent, ShopifyWebhookTopic } from "./store.ts";

const MAX_WEBHOOK_BYTES = 1_048_576;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PAYLOAD_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOPICS = new Set<ShopifyWebhookTopic>([
  "app/uninstalled",
  "app/scopes_update",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

export class ShopifyWebhookError extends Error {
  readonly code: "invalid-webhook" | "unsupported-topic";
  readonly httpStatus: 400 | 401 | 404;

  constructor(code: ShopifyWebhookError["code"], httpStatus: ShopifyWebhookError["httpStatus"]) {
    super(code === "unsupported-topic" ? "The Shopify webhook topic is not supported." : "The Shopify webhook is invalid.");
    this.name = "ShopifyWebhookError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function verifiedSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature || signature.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function payloadShopCandidates(payload: Record<string, unknown>): string[] {
  const shops: string[] = [];
  for (const key of ["shop_domain", "myshopify_domain"] as const) {
    const value = payload[key];
    if (value === undefined || value === null || value === "") continue;
    shops.push(canonicalShopifyShop(value));
  }
  if (typeof payload.domain === "string" && payload.domain.toLowerCase().endsWith(".myshopify.com")) {
    shops.push(canonicalShopifyShop(payload.domain));
  }
  return [...new Set(shops)];
}

async function boundedRawBody(request: Request): Promise<Buffer> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEBHOOK_BYTES)) {
    throw new ShopifyWebhookError("invalid-webhook", 400);
  }
  if (!request.body) throw new ShopifyWebhookError("invalid-webhook", 400);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ShopifyWebhookError("invalid-webhook", 400);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new ShopifyWebhookError("invalid-webhook", 400);
  return Buffer.concat(chunks, total);
}

export async function verifyShopifyWebhookRequest(request: Request, clientSecret: string): Promise<ShopifyWebhookEvent> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ShopifyWebhookError("invalid-webhook", 400);
  }
  const rawBytes = await boundedRawBody(request);
  const signature = request.headers.get("x-shopify-hmac-sha256") || "";
  if (!verifiedSignature(rawBytes, signature, clientSecret)) {
    throw new ShopifyWebhookError("invalid-webhook", 401);
  }
  const rawBody = rawBytes.toString("utf8");

  const deliveryId = request.headers.get("x-shopify-webhook-id") || "";
  const topicValue = (request.headers.get("x-shopify-topic") || "").toLowerCase();
  if (!DELIVERY_ID_PATTERN.test(deliveryId)) throw new ShopifyWebhookError("invalid-webhook", 400);
  if (!TOPICS.has(topicValue as ShopifyWebhookTopic)) throw new ShopifyWebhookError("unsupported-topic", 404);

  let shop: string;
  let payload: Record<string, unknown>;
  try {
    shop = canonicalShopifyShop(request.headers.get("x-shopify-shop-domain"));
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    payload = parsed as Record<string, unknown>;
    const candidates = payloadShopCandidates(payload);
    if (candidates.some((candidate) => candidate !== shop)) throw new Error("shop-mismatch");
  } catch {
    throw new ShopifyWebhookError("invalid-webhook", 400);
  }
  const payloadHash = createHash("sha256").update(rawBytes).digest("hex");
  if (!PAYLOAD_HASH_PATTERN.test(payloadHash)) throw new ShopifyWebhookError("invalid-webhook", 400);
  return {
    deliveryId,
    payload,
    payloadHash,
    shop,
    topic: topicValue as ShopifyWebhookTopic,
  };
}
