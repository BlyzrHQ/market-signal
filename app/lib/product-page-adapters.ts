import {
  bilingualNormalize,
  extractProductIdentifiers,
  parseCanonicalQuantity,
  quantitiesEqual,
  type CanonicalProductQuantity,
} from "./product-normalization.ts";
import type { ProductPriceSignal, ProductRecord } from "./product-intelligence.ts";

type JsonRecord = Record<string, unknown>;

export type StorefrontAdapterRequest = {
  kind: "shopify" | "woocommerce";
  endpointUrl: string;
  requestedKey: string;
};

export type StorefrontAdapterResult = {
  product: ProductRecord | null;
  gap: string;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown, limit = 300) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function decodedCodePoint(value: string, radix: number) {
  const code = Number.parseInt(value, radix);
  return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : " ";
}

function plainText(value: unknown, limit = 400) {
  const raw = text(value, Math.max(limit * 8, 3_200));
  return raw
    .replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|noscript)\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => decodedCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => decodedCodePoint(code, 16))
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
    .slice(0, limit);
}

function decodedSegment(value: string) {
  try { return decodeURIComponent(value).toLowerCase(); } catch { return value.toLowerCase(); }
}

function publicImageUrl(value: unknown, sourceUrl: string) {
  try {
    const raw = text(record(value)?.src || record(value)?.url || value, 1_000);
    if (!raw) return "";
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, sourceUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function productRoute(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const routeIndex = segments.findIndex((segment) => /^(?:products?|product)$/.test(segment.toLowerCase()));
    if (routeIndex < 0 || !segments[routeIndex + 1]) return null;
    return { url, segments, routeIndex, key: decodedSegment(segments[routeIndex + 1]) };
  } catch {
    return null;
  }
}

export function storefrontAdapterRequest(sourceUrl: string): StorefrontAdapterRequest | null {
  const route = productRoute(sourceUrl);
  if (!route) return null;
  const routeName = route.segments[route.routeIndex].toLowerCase();
  if (routeName === "products") {
    const endpoint = new URL(route.url.toString());
    endpoint.search = "";
    endpoint.hash = "";
    endpoint.pathname = `/${route.segments.slice(0, route.routeIndex + 2).join("/")}.js`;
    return { kind: "shopify", endpointUrl: endpoint.toString(), requestedKey: route.key };
  }
  if (routeName === "product") {
    const endpoint = new URL("/wp-json/wc/store/v1/products", route.url.origin);
    endpoint.searchParams.set("slug", route.key);
    return { kind: "woocommerce", endpointUrl: endpoint.toString(), requestedKey: route.key };
  }
  return null;
}

function metaContents(document: string, key: string) {
  const attributeValue = (tag: string, name: string) => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return text(match?.[1] || match?.[2] || match?.[3], 40);
  };
  return [...document.matchAll(/<meta\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => ["property", "name", "itemprop"].some((attribute) => attributeValue(tag, attribute) === key))
    .map((tag) => attributeValue(tag, "content"))
    .filter(Boolean);
}

function isoCurrency(value: unknown) {
  const candidate = text(value, 10).toUpperCase();
  return /^[A-Z]{3}$/.test(candidate) ? candidate : "";
}

function directProductCurrencies(document: string) {
  const activeDocument = document.replace(/<!--[\s\S]*?-->/g, " ");
  const metadata = ["product:price:currency", "og:price:currency", "priceCurrency"]
    .flatMap((key) => metaContents(activeDocument, key));
  const shopify = [...activeDocument.matchAll(/Shopify\.currency\s*=\s*\{[^}]*["']active["']\s*:\s*["']([A-Za-z]{3})["']/gi)]
    .map((match) => match[1]);
  return [...new Set([...metadata, ...shopify].map(isoCurrency).filter(Boolean))];
}

export function hasConflictingDirectProductCurrency(document: string) {
  return directProductCurrencies(document).length > 1;
}

export function confirmedProductCurrency(document: string, options: { allowStructured?: boolean } = {}) {
  const direct = directProductCurrencies(document);
  if (direct.length > 1) return "";
  if (direct.length === 1) return direct[0];
  if (options.allowStructured === false) return "";
  const structured = [...document.matchAll(/["']priceCurrency["']\s*:\s*["']([A-Za-z]{3})["']/gi)]
    .map((match) => isoCurrency(match[1]))
    .filter(Boolean);
  const unique = [...new Set(structured)];
  return unique.length === 1 ? unique[0] : "";
}

function minorUnitPrice(value: unknown, currency: string, explicitDigits: unknown): ProductPriceSignal | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || !currency) return null;
  const digits = Number.isInteger(explicitDigits) && Number(explicitDigits) >= 0 && Number(explicitDigits) <= 4
    ? Number(explicitDigits)
    : 2;
  const amount = Number((numeric / (10 ** digits)).toFixed(digits));
  const rendered = amount.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return { raw: `${currency} ${rendered}`, currency, amount };
}

function positiveMinorUnitInput(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string" || !value.trim()) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function identifierRecord(value: JsonRecord | null) {
  if (!value) return undefined;
  const identifiers = extractProductIdentifiers({ sku: value.sku, gtin: value.barcode || value.gtin, brand: value.brand });
  return identifiers.gtins.length || identifiers.sku || identifiers.mpn || identifiers.brand ? identifiers : undefined;
}

function makeProduct(input: {
  domain: string;
  sourceUrl: string;
  observedAt: string;
  name: string;
  description?: unknown;
  category?: string;
  priceSignals: ProductPriceSignal[];
  imageUrl: string;
  identifiers?: ProductRecord["identifiers"];
  quantity?: CanonicalProductQuantity;
}): ProductRecord {
  const normalizedName = bilingualNormalize(input.name);
  const id = `${input.domain}-storefront-${normalizedName.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 100)}`;
  return {
    id,
    domain: input.domain,
    name: input.name.slice(0, 160),
    normalizedName,
    description: plainText(input.description, 400),
    category: text(input.category, 120) || "product",
    jsonLdType: "Product",
    priceSignals: input.priceSignals,
    attributes: [],
    ownership: "path-inferred",
    extraction: "storefront-api",
    confidence: "High",
    sourceUrl: input.sourceUrl,
    imageUrl: input.imageUrl,
    observedAt: input.observedAt,
    claimIds: [`${id}-observed-${Date.parse(input.observedAt) || 0}`],
    identifiers: input.identifiers,
    quantity: input.quantity,
  };
}

function shopifyVariantQuantity(productTitle: string, variant: JsonRecord) {
  const variantTitle = text(variant.title, 160);
  return parseCanonicalQuantity(`${productTitle} ${/^default title$/i.test(variantTitle) ? "" : variantTitle}`) || undefined;
}

export function parseShopifyProduct(input: {
  payload: unknown;
  requestedKey: string;
  sourceUrl: string;
  domain: string;
  observedAt: string;
  currency: string;
  expectedQuantity?: CanonicalProductQuantity;
}): StorefrontAdapterResult {
  const payload = record(input.payload);
  const name = text(payload?.title, 160);
  const handle = decodedSegment(text(payload?.handle, 200));
  if (!payload || !name || !handle) return { product: null, gap: "The Shopify product endpoint returned an invalid product payload." };
  if (handle !== input.requestedKey) return { product: null, gap: "The Shopify product endpoint returned a different product handle." };

  const variants = Array.isArray(payload.variants) ? payload.variants.map(record).filter((value): value is JsonRecord => Boolean(value)) : [];
  const quantityMatches = input.expectedQuantity
    ? variants.filter((variant) => quantitiesEqual(input.expectedQuantity, shopifyVariantQuantity(name, variant)))
    : [];
  const selectedVariants = input.expectedQuantity ? quantityMatches : variants;
  const completeSelectedPricing = selectedVariants.length > 0 && selectedVariants.every((variant) => positiveMinorUnitInput(variant.price));
  const priceSignals = input.currency && completeSelectedPricing
    ? [...new Map(selectedVariants.map((variant) => minorUnitPrice(variant.price, input.currency, 2)).filter((value): value is ProductPriceSignal => Boolean(value)).map((signal) => [`${signal.currency}|${signal.amount}`, signal])).values()]
    : [];
  const selectedVariant = selectedVariants.length === 1 ? selectedVariants[0] : null;
  const featured = selectedVariant ? record(selectedVariant.featured_image) : null;
  const images = Array.isArray(payload.images) ? payload.images : [];
  const imageUrl = [featured?.src, payload.featured_image, images[0]].map((value) => publicImageUrl(value, input.sourceUrl)).find((value) => /^https:\/\//i.test(value)) || "";
  const product = makeProduct({
    domain: input.domain,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    name,
    description: payload.description,
    category: text(payload.type, 120),
    priceSignals,
    imageUrl,
    identifiers: identifierRecord(selectedVariant),
    quantity: parseCanonicalQuantity(`${name} ${selectedVariant ? text(selectedVariant.title, 160) : ""}`) || undefined,
  });
  return {
    product,
    gap: !completeSelectedPricing
      ? "Shopify did not expose a positive price for every selected variant, so the product price was not treated as comparable."
      : !input.currency && selectedVariants.some((variant) => Number.isFinite(Number(variant.price)))
      ? "Shopify exposed a price but no same-page currency, so the price was not treated as comparable."
      : "",
  };
}

export function parseWooCommerceProduct(input: {
  payload: unknown;
  requestedKey: string;
  sourceUrl: string;
  domain: string;
  observedAt: string;
}): StorefrontAdapterResult {
  const products = Array.isArray(input.payload) ? input.payload.map(record).filter((value): value is JsonRecord => Boolean(value)) : [];
  const payload = products.find((product) => decodedSegment(text(product.slug, 200)) === input.requestedKey);
  if (!payload) return { product: null, gap: "The WooCommerce Store API did not return the requested product slug." };
  const name = text(payload.name, 160);
  const prices = record(payload.prices);
  const currency = isoCurrency(prices?.currency_code);
  if (!name) return { product: null, gap: "The WooCommerce Store API returned a product without a usable name." };
  const images = Array.isArray(payload.images) ? payload.images.map(record).filter((value): value is JsonRecord => Boolean(value)) : [];
  const fixedPriceProvided = Boolean(prices) && Object.prototype.hasOwnProperty.call(prices, "price");
  const fixedPricePositive = positiveMinorUnitInput(prices?.price);
  const price = fixedPricePositive ? minorUnitPrice(prices?.price, currency, prices?.currency_minor_unit) : null;
  const priceRange = record(prices?.price_range);
  const rangeValues = [priceRange?.min_amount, priceRange?.max_amount];
  const rangeProvided = Boolean(priceRange) && rangeValues.some((value) => value !== undefined);
  const rangeInputsValid = rangeProvided && rangeValues.every(positiveMinorUnitInput);
  const rangeSignals = rangeInputsValid
    ? rangeValues.map((value) => minorUnitPrice(value, currency, prices?.currency_minor_unit)).filter((value): value is ProductPriceSignal => Boolean(value))
    : [];
  const completeRange = rangeInputsValid && rangeSignals.length === 2;
  const priceSignals = rangeProvided
    ? completeRange
      ? rangeSignals[0].amount !== rangeSignals[1].amount ? rangeSignals : [rangeSignals[0]]
      : []
    : price ? [price] : [];
  const gap = rangeProvided
    ? !rangeInputsValid || (currency && !completeRange)
      ? "WooCommerce exposed an incomplete price range, so no price was treated as comparable."
      : !currency
        ? "WooCommerce exposed a price without a confirmed ISO currency."
        : ""
    : fixedPriceProvided && !fixedPricePositive
      ? "WooCommerce exposed a zero, empty, or invalid price without evidence of a public free offer."
      : fixedPricePositive && !currency
        ? "WooCommerce exposed a price without a confirmed ISO currency."
        : "";
  return {
    product: makeProduct({
      domain: input.domain,
      sourceUrl: input.sourceUrl,
      observedAt: input.observedAt,
      name,
      description: payload.short_description || payload.description,
      category: text((Array.isArray(payload.categories) ? record(payload.categories[0])?.name : ""), 120),
      priceSignals,
      imageUrl: images.map((image) => publicImageUrl(image, input.sourceUrl)).find((value) => /^https:\/\//i.test(value)) || "",
      identifiers: identifierRecord(payload),
      quantity: parseCanonicalQuantity(name) || undefined,
    }),
    gap,
  };
}
