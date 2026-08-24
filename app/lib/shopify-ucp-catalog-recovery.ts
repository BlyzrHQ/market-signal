import { domainToASCII } from "node:url";
import { getDomain } from "tldts";
import { canonicalDomain } from "./domain.ts";
import { MARKET_SIGNAL_USER_AGENT } from "./crawler-identity.ts";
import { fetchPublicText } from "./public-fetch.ts";
import { publicHttpUrl } from "./public-url.ts";
import { isSupportedCurrency, type ProductRecord } from "./product-intelligence.ts";
import { bilingualNormalize } from "./product-normalization.ts";

const UCP_VERSION = "2026-04-08" as const;
const UCP_AGENT_PROFILE = "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";
const UCP_PATH = "/api/ucp/mcp";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_PRODUCTS = 1_000;
const PAGE_SIZE = 100;
const MAX_PAGES = Math.ceil(MAX_PRODUCTS / PAGE_SIZE);
const MAX_CURSOR_LENGTH = 4_000;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const FOUR_DECIMAL_CURRENCIES = new Set(["CLF", "UYW"]);

type FetchText = typeof fetchPublicText;
type JsonRecord = Record<string, unknown>;

export type ShopifyUcpCatalogRecovery = {
  domain: string;
  endpointHost: string;
  sourceUrl: string;
  storeUrl: string;
  title: string;
  description: string;
  products: ProductRecord[];
  observedAt: string;
  requests: number;
  truncated: boolean;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function boundedText(value: unknown, maxLength: number) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function exactEndpointUrl(value: unknown, endpointHost: string) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.hostname === endpointHost
      && url.pathname === UCP_PATH
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function sameStoreProductUrl(value: unknown, endpointHost: string) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.hostname !== endpointHost || !url.pathname.startsWith("/products/")) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeImageUrl(value: unknown) {
  try {
    const url = publicHttpUrl(value);
    return url.startsWith("https://") ? url : "";
  } catch {
    return "";
  }
}

function currencyExponent(currency: string) {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(currency)) return 4;
  return 2;
}

function positiveMinorPrice(value: unknown) {
  const price = record(value);
  const amount = Number(price?.amount);
  const currency = boundedText(price?.currency, 8).toUpperCase();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !isSupportedCurrency(currency)) return null;
  const exponent = currencyExponent(currency);
  const majorAmount = amount / (10 ** exponent);
  if (!Number.isFinite(majorAmount) || majorAmount <= 0) return null;
  return { currency, amount: majorAmount, raw: `${currency} ${majorAmount.toFixed(exponent)}` };
}

function observedPrice(item: JsonRecord) {
  for (const value of Array.isArray(item.variants) ? item.variants : []) {
    const variant = record(value);
    const availability = record(variant?.availability);
    if (availability?.available === false) continue;
    const variantPrice = positiveMinorPrice(variant?.price);
    if (variantPrice) return variantPrice;
  }
  const range = record(item.price_range);
  return positiveMinorPrice(range?.min);
}

function productRecord(value: unknown, domain: string, endpointHost: string, observedAt: string): ProductRecord | null {
  const item = record(value);
  if (!item) return null;
  const id = boundedText(item.id, 240);
  const name = boundedText(item.title, 500);
  const sourceUrl = sameStoreProductUrl(item.url, endpointHost);
  const price = observedPrice(item);
  if (!/^gid:\/\/shopify\/Product\/[A-Za-z0-9_-]+$/.test(id) || !name || !sourceUrl || !price) return null;

  const descriptions = record(item.description);
  const categoryValues = (Array.isArray(item.categories) ? item.categories : [])
    .map(record)
    .filter((category): category is JsonRecord => Boolean(category))
    .sort((left, right) => Number(right.taxonomy === "merchant") - Number(left.taxonomy === "merchant"));
  const category = boundedText(categoryValues[0]?.value, 240);
  const media = (Array.isArray(item.media) ? item.media : []).map(record).find((entry) => entry?.type === "image" && safeImageUrl(entry.url));
  const imageUrl = media ? safeImageUrl(media.url) : "";
  const claimId = `${domain}-shopify-ucp-product-${id.slice("gid://shopify/Product/".length)}`;

  return {
    id: `${domain}:shopify-ucp:${id.slice("gid://shopify/Product/".length)}`,
    domain,
    name,
    normalizedName: bilingualNormalize(name),
    description: boundedText(descriptions?.plain || descriptions?.html, 2_000),
    category,
    jsonLdType: "Product",
    priceSignals: [price],
    attributes: [category].filter(Boolean),
    ownership: "self-declared-brand",
    extraction: "storefront-api",
    confidence: "High",
    sourceUrl,
    imageUrl,
    observedAt,
    claimIds: [claimId],
  };
}

function nextCursor(value: unknown) {
  if (typeof value !== "string" || !value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return "";
  return value;
}

function verifiedToolsPayload(payload: unknown) {
  const root = record(payload);
  const result = record(root?.result);
  const tools = Array.isArray(result?.tools) ? result.tools.map(record) : [];
  const search = tools.find((tool) => tool?.name === "search_catalog");
  const description = boundedText(search?.description, 2_000);
  return Boolean(search && /\bshopify\b/i.test(description) && /\bucp\b/i.test(description) && /\bcatalog\b/i.test(description));
}

function verifiedSearchPayload(payload: unknown) {
  const root = record(payload);
  const result = record(root?.result);
  const content = record(result?.structuredContent);
  const ucp = record(content?.ucp);
  const capabilities = record(ucp?.capabilities);
  const searchCapabilities = Array.isArray(capabilities?.["dev.ucp.shopping.catalog.search"]) ? capabilities["dev.ucp.shopping.catalog.search"] as unknown[] : [];
  const shopifyCapabilities = Array.isArray(capabilities?.["dev.shopify.catalog"]) ? capabilities["dev.shopify.catalog"] as unknown[] : [];
  const supportsVersion = (values: unknown[]) => values.map(record).some((entry) => entry?.version === UCP_VERSION);
  if (ucp?.version !== UCP_VERSION || ucp.status !== "success" || !supportsVersion(searchCapabilities) || !supportsVersion(shopifyCapabilities)) return null;
  if (!Array.isArray(content?.products) || content.products.length > 250) return null;
  const pagination = record(content.pagination);
  if (!pagination || typeof pagination.has_next_page !== "boolean") return null;
  return { products: content.products, hasNextPage: pagination.has_next_page, cursor: nextCursor(pagination.cursor) };
}

function agentMeta() {
  return { "ucp-agent": { profile: UCP_AGENT_PROFILE } };
}

async function publicJsonRpc(fetchText: FetchText, endpointHost: string, body: JsonRecord) {
  const endpoint = `https://${endpointHost}${UCP_PATH}`;
  const response = await fetchText(endpoint, "application/json", {
    expectedDomain: endpointHost,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxDocumentBytes: MAX_RESPONSE_BYTES,
    userAgent: MARKET_SIGNAL_USER_AGENT,
    jsonRpcBody: JSON.stringify(body),
  });
  if (!response.ok
    || !/^application\/json\b/i.test(response.contentType)
    || response.truncated
    || response.redirectCount !== 0
    || !exactEndpointUrl(response.url, endpointHost)) return null;
  const payload = parseJson(response.text);
  const root = record(payload);
  return root?.jsonrpc === "2.0" && root.id === body.id && !root.error ? payload : null;
}

export function shopifyCheckoutHost(input: string) {
  const submitted = domainToASCII(canonicalDomain(input)).toLowerCase();
  const registrable = getDomain(submitted, { allowPrivateDomains: true });
  if (!registrable || (submitted !== registrable && !submitted.endsWith(`.${registrable}`))) return "";
  return `checkout.${registrable}`;
}

export function isShopifyUcpCatalogRecoveryEligible(primary: {
  homepage?: unknown;
  homepageAccessDenied?: { status: number; hosts: string[] };
} | undefined) {
  if (primary?.homepage) return false;
  return primary?.homepageAccessDenied?.status === 403
    && new Set(primary.homepageAccessDenied.hosts.map((host) => host.toLowerCase())).size === 2;
}

export async function recoverShopifyUcpCatalog(
  input: string,
  options: { maxProducts: number; fetchText?: FetchText; now?: () => Date },
): Promise<ShopifyUcpCatalogRecovery | null> {
  const domain = canonicalDomain(input);
  const endpointHost = shopifyCheckoutHost(domain);
  if (!endpointHost) return null;
  const maxProducts = Math.max(1, Math.min(MAX_PRODUCTS, Math.floor(options.maxProducts)));
  const observedAt = (options.now || (() => new Date()))().toISOString();
  const fetchText = options.fetchText || fetchPublicText;
  let requests = 1;

  const toolsPayload = await publicJsonRpc(fetchText, endpointHost, {
    jsonrpc: "2.0",
    id: "shopify-tools",
    method: "tools/list",
    params: { arguments: { meta: agentMeta() } },
  });
  if (!verifiedToolsPayload(toolsPayload)) return null;

  const products: ProductRecord[] = [];
  const seenProducts = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  let exhausted = false;
  for (let page = 0; page < MAX_PAGES && products.length < maxProducts; page += 1) {
    const pageLimit = Math.min(PAGE_SIZE, maxProducts - products.length);
    const searchPayload = await publicJsonRpc(fetchText, endpointHost, {
      jsonrpc: "2.0",
      id: `shopify-search-${page + 1}`,
      method: "tools/call",
      params: {
        name: "search_catalog",
        arguments: {
          meta: agentMeta(),
          catalog: {
            filters: { available: true },
            pagination: { limit: pageLimit, ...(cursor ? { cursor } : {}) },
          },
        },
      },
    });
    requests += 1;
    const search = verifiedSearchPayload(searchPayload);
    if (!search) return null;
    let pageHadUnprocessedProducts = false;
    for (let index = 0; index < search.products.length; index += 1) {
      const product = productRecord(search.products[index], domain, endpointHost, observedAt);
      if (!product || seenProducts.has(product.id)) continue;
      seenProducts.add(product.id);
      products.push(product);
      if (products.length >= maxProducts) {
        pageHadUnprocessedProducts = index < search.products.length - 1;
        break;
      }
    }
    if (!search.hasNextPage) {
      exhausted = !pageHadUnprocessedProducts;
      break;
    }
    if (!search.cursor || seenCursors.has(search.cursor)) return null;
    seenCursors.add(search.cursor);
    cursor = search.cursor;
  }
  if (!products.length) return null;

  const sourceUrl = `https://${endpointHost}${UCP_PATH}`;
  return {
    domain,
    endpointHost,
    sourceUrl,
    storeUrl: `https://${endpointHost}/`,
    title: domain,
    description: `Official public Shopify catalog for ${domain}.`,
    products,
    observedAt,
    requests,
    truncated: !exhausted,
  };
}
