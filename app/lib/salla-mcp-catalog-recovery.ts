import { canonicalDomain } from "./domain.ts";
import { fetchPublicText } from "./public-fetch.ts";
import { isSupportedCurrency, type ProductRecord } from "./product-intelligence.ts";
import { bilingualNormalize } from "./product-normalization.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2_500_000;
const MAX_PAGES = 70;
const USER_AGENT = "MarketSignalPublicScanner/0.1";

type FetchText = typeof fetchPublicText;

export type SallaStorefrontRecovery = {
  domain: string;
  sourceUrl: string;
  storeUrl: string;
  name: string;
  title: string;
  description: string;
  countryCode: string;
  languages: string[];
  socialLinks: string[];
  products: ProductRecord[];
  observedAt: string;
  requests: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, maxLength: number) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sameDomainHttpsUrl(value: unknown, domain: string) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || canonicalDomain(url.hostname) !== domain) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeImageUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function parseJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function jsonRpcText(payload: unknown) {
  const root = record(payload);
  if (root?.jsonrpc !== "2.0" || root.error) return null;
  const result = record(root.result);
  const content = Array.isArray(result?.content) ? result.content.map(record).find((item) => item?.type === "text" && typeof item.text === "string") : null;
  return typeof content?.text === "string" ? parseJson(content.text) : null;
}

function jsonRpcResource(payload: unknown) {
  const root = record(payload);
  if (root?.jsonrpc !== "2.0" || root.error) return null;
  const result = record(root.result);
  const contents = Array.isArray(result?.contents) ? result.contents.map(record) : [];
  const content = contents.find((item) => item?.uri === "store://info" && item.mimeType === "application/json" && typeof item.text === "string");
  return typeof content?.text === "string" ? parseJson(content.text) : null;
}

function isVerifiedSallaCard(payload: unknown) {
  const card = record(payload);
  const transport = record(card?.transport);
  const serverInfo = record(card?.serverInfo);
  const identity = `${boundedText(serverInfo?.name, 100)} ${boundedText(serverInfo?.title, 100)} ${boundedText(card?.description, 300)}`;
  return /\bsalla\b/i.test(identity) && transport?.type === "streamable-http" && transport.endpoint === "/mcp";
}

function isVerifiedSallaInitialize(payload: unknown) {
  const root = record(payload);
  if (root?.jsonrpc !== "2.0" || root.id !== "initialize" || root.error) return false;
  const result = record(root.result);
  const serverInfo = record(result?.serverInfo);
  const identity = `${boundedText(serverInfo?.name, 100)} ${boundedText(serverInfo?.title, 100)} ${boundedText(serverInfo?.description, 500)} ${boundedText(result?.instructions, 1_000)}`;
  return result?.protocolVersion === MCP_PROTOCOL_VERSION && /\bsalla\b/i.test(identity);
}

export function isSallaCatalogRecoveryEligible(primary: {
  homepage?: unknown;
  homepageAccessDenied?: { status: number; hosts: string[] };
  siteState?: { status: string };
} | undefined) {
  if (primary?.homepage) return false;
  const deniedOnBothHosts = primary?.homepageAccessDenied?.status === 403
    && primary.homepageAccessDenied.hosts.length === 2;
  return Boolean(deniedOnBothHosts || primary?.siteState?.status === "unavailable");
}

function nextCursor(value: unknown) {
  if (typeof value !== "string" || value.length > 8_000) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.salla.dev" || url.pathname !== "/store/v1/products") return "";
    const cursor = url.searchParams.get("cursor") || "";
    return cursor.length <= 5_000 ? cursor : "";
  } catch {
    return "";
  }
}

function productRecord(value: unknown, domain: string, observedAt: string): ProductRecord | null {
  const item = record(value);
  const name = boundedText(item?.name, 500);
  const sourceUrl = sameDomainHttpsUrl(item?.url, domain);
  const id = boundedText(item?.id, 240);
  if (!id || !name || !sourceUrl) return null;
  const rawAmount = Number(item?.price ?? item?.sale_price ?? item?.regular_price);
  const currency = boundedText(item?.currency, 8).toUpperCase();
  const amount = Number.isFinite(rawAmount) && rawAmount > 0 && isSupportedCurrency(currency) ? rawAmount : undefined;
  const category = boundedText(record(item?.category)?.name, 240);
  const image = safeImageUrl(record(item?.image)?.url || item?.original_image);
  const claimId = `${domain}-salla-product-${id}`;
  return {
    id: `${domain}:salla:${id}`,
    domain,
    name,
    normalizedName: bilingualNormalize(name),
    description: boundedText(item?.description, 2_000),
    category,
    jsonLdType: "Product",
    priceSignals: amount === undefined ? [] : [{ raw: `${currency} ${amount}`, currency, amount }],
    attributes: [category, boundedText(item?.sku, 120)].filter(Boolean),
    ownership: "self-declared-brand",
    extraction: "storefront-api",
    confidence: "High",
    sourceUrl,
    imageUrl: image,
    observedAt,
    claimIds: [claimId],
  };
}

async function publicJsonRpc(fetchText: FetchText, domain: string, body: Record<string, unknown>) {
  const response = await fetchText(`https://${domain}/mcp`, "application/json, text/event-stream", {
    expectedDomain: domain,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxDocumentBytes: MAX_RESPONSE_BYTES,
    userAgent: USER_AGENT,
    jsonRpcBody: JSON.stringify(body),
    protocolVersion: MCP_PROTOCOL_VERSION,
  });
  if (!response.ok || !/^application\/json\b/i.test(response.contentType) || response.truncated) return null;
  const payload = parseJson(response.text);
  const root = record(payload);
  return root?.id === body.id ? payload : null;
}

export async function recoverSallaStorefrontCatalog(
  input: string,
  options: { maxProducts: number; fetchText?: FetchText; now?: () => Date },
): Promise<SallaStorefrontRecovery | null> {
  const domain = canonicalDomain(input);
  const maxProducts = Math.max(1, Math.min(1_000, Math.floor(options.maxProducts)));
  const fetchText = options.fetchText || fetchPublicText;
  const observedAt = (options.now || (() => new Date()))().toISOString();
  const cardUrl = `https://${domain}/.well-known/mcp/server-card.json`;
  let sourceUrl = cardUrl;
  let requests = 1;
  const cardResponse = await fetchText(cardUrl, "application/json", {
    expectedDomain: domain,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxDocumentBytes: 64_000,
    userAgent: USER_AGENT,
  });
  const cardVerified = cardResponse.ok
    && /^application\/json\b/i.test(cardResponse.contentType)
    && !cardResponse.truncated
    && isVerifiedSallaCard(parseJson(cardResponse.text));
  if (!cardVerified) {
    const initializePayload = await publicJsonRpc(fetchText, domain, {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Market Signal", version: "0.1" },
      },
    });
    requests += 1;
    if (!isVerifiedSallaInitialize(initializePayload)) return null;
    sourceUrl = `https://${domain}/mcp`;
  }

  const infoPayload = await publicJsonRpc(fetchText, domain, { jsonrpc: "2.0", id: "store-info", method: "resources/read", params: { uri: "store://info" } });
  requests += 1;
  const info = record(jsonRpcResource(infoPayload));
  const store = record(info?.store);
  const storeUrl = sameDomainHttpsUrl(store?.url, domain);
  if (!store || !storeUrl) return null;
  const scope = record(store?.scope);
  const meta = record(store?.meta);
  const countryCode = [store.country, store.store_country, ...(Array.isArray(scope?.countries) ? scope.countries : [])]
    .map((item) => boundedText(item, 2).toUpperCase())
    .find((item) => /^[A-Z]{2}$/.test(item)) || "";
  if (!countryCode) return null;

  const products: ProductRecord[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < MAX_PAGES && products.length < maxProducts; page += 1) {
    const argumentsValue = { source: "latest", per_page: 100, ...(cursor ? { cursor } : { page: 1 }) };
    const productPayload = await publicJsonRpc(fetchText, domain, { jsonrpc: "2.0", id: `products-${page + 1}`, method: "tools/call", params: { name: "catalog-product-list", arguments: argumentsValue } });
    requests += 1;
    const result = record(jsonRpcText(productPayload));
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const item of items) {
      const product = productRecord(item, domain, observedAt);
      if (!product || seen.has(product.id)) continue;
      seen.add(product.id);
      products.push(product);
      if (products.length >= maxProducts) break;
    }
    const next = nextCursor(result?.next_cursor);
    if (!next || next === cursor || !items.length) break;
    cursor = next;
  }
  if (!products.length) return null;

  const social = record(store.social);
  return {
    domain,
    sourceUrl,
    storeUrl,
    name: boundedText(store.name, 300) || domain,
    title: boundedText(meta?.title, 500) || boundedText(store.name, 300) || domain,
    description: boundedText(meta?.description, 1_000) || boundedText(store.description, 1_000),
    countryCode,
    languages: (Array.isArray(scope?.languages) ? scope.languages : []).map((item) => boundedText(item, 20).toLowerCase()).filter(Boolean).slice(0, 8),
    socialLinks: Object.values(social || {}).map(safeImageUrl).filter(Boolean).slice(0, 12),
    products,
    observedAt,
    requests,
  };
}
