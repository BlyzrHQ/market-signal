import { canonicalDomain, normalizeDomain } from "./domain.ts";
import { bilingualNormalize, bilingualTokens, parseCanonicalQuantity, quantitiesConflict } from "./product-normalization.ts";
import { CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX, catalogReplacementAuditAttribute, extractProductsFromHtml, isSupportedCurrency, validateProductPageIdentity, type ProductEnrichmentTarget, type ProductRecord } from "./product-intelligence.ts";
import { confirmedProductCurrency, parseShopifyProduct, parseWooCommerceProduct, storefrontAdapterRequest } from "./product-page-adapters.ts";
import { sharedRobotsPolicyResolver } from "./robots-policy.ts";

const MAX_DOCUMENT_BYTES = 1_500_000;
export const MAX_ENRICHMENT_TARGETS = 64;
const MAX_PER_DOMAIN_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";

export type EnrichmentGap = {
  url: string;
  productId: string;
  role: ProductEnrichmentTarget["role"];
  reason: string;
  code?: "robots_unreachable" | "robots_disallowed" | "fetch_failed" | "identity_mismatch" | "adapter_limited";
  httpStatus?: number;
  failureKind?: "robots" | "network" | "http" | "content" | "identity" | "adapter" | "redirect";
};

export type ProductEnrichmentCoverage = {
  pagesRequested: number;
  pagesFetched: number;
  maxPages: number;
  gaps: EnrichmentGap[];
  edgeRecovery?: { recovered: number; requested: number; provider: string; observedAt: string };
};

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

class ProductFetchFailure extends Error {
  readonly failureKind: NonNullable<EnrichmentGap["failureKind"]>;

  constructor(message: string, failureKind: NonNullable<EnrichmentGap["failureKind"]>) {
    super(message);
    this.name = "ProductFetchFailure";
    this.failureKind = failureKind;
  }
}

async function fetchSameDomain(url: string, domain: string, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let current = url;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const checked = new URL(current);
      normalizeDomain(checked.hostname);
      if (canonicalDomain(checked.hostname) !== canonicalDomain(domain)) throw new ProductFetchFailure("redirected off the product domain", "redirect");
      let response: Response;
      try {
        response = await fetch(current, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
      } catch (error) {
        throw new ProductFetchFailure(error instanceof Error ? error.message : "network request failed", "network");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new ProductFetchFailure("redirect limit reached", "redirect");
        current = new URL(location, current).toString();
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) return { ok: false, status: response.status, contentType, url: current, text: "" };
      let bytes: ArrayBuffer;
      try { bytes = await response.arrayBuffer(); } catch { throw new ProductFetchFailure("response body could not be read", "content"); }
      return {
        ok: true,
        status: response.status,
        contentType,
        url: current,
        text: new TextDecoder().decode(bytes.slice(0, MAX_DOCUMENT_BYTES)),
      };
    }
    throw new ProductFetchFailure("redirect limit reached", "redirect");
  } finally {
    clearTimeout(timeout);
  }
}

function decode(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&pound;|&#163;/gi, "£").replace(/&euro;|&#8364;/gi, "€").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function clean(value: string) {
  return decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEvidence(value: string) {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&pound;|&#163;/gi, "\u00A3")
    .replace(/&euro;|&#8364;/gi, "\u20AC")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&minus;/gi, "\u2212")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&(?:hyphen|dash);/gi, "-")
    .replace(/&ominus;/gi, "-")
    .replace(/&nbsp;/gi, " ")
    .replace(/&dollar;/gi, "$")
    .replace(/&colon;/gi, ":")
    .replace(/&equals;/gi, "=")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeLocalizedNumbers(value: string) {
  return value
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, ".")
    .replace(/\u066c/g, ",");
}

const CURRENCY_TOKENS: Record<string, string> = {
  GBP: "(?:\\u00A3|\\bGBP\\b)",
  EUR: "(?:\\u20AC|\\bEUR\\b)",
  USD: "(?:\\$|\\bUSD\\b)",
  KWD: "(?:\\bKWD\\b|(?<![\\u0600-\\u06FF])(?:ك\\s*\\.?\\s*د|د\\s*\\.?\\s*ك)(?![\\u0600-\\u06FF]))",
  BHD: "(?:\\bBHD\\b|(?<![\\u0600-\\u06FF])(?:ب\\s*\\.?\\s*د|د\\s*\\.?\\s*ب)(?![\\u0600-\\u06FF]))",
  OMR: "(?:\\bOMR\\b|(?<![\\u0600-\\u06FF])(?:ر\\s*\\.?\\s*ع|ع\\s*\\.?\\s*ر)(?![\\u0600-\\u06FF]))",
  AED: "(?:\\bAED\\b|(?<![\\u0600-\\u06FF])(?:إ\\s*\\.?\\s*د|د\\s*\\.?\\s*إ)(?![\\u0600-\\u06FF]))",
  SAR: "(?:\\bSAR\\b|\\bSR\\b|(?<![\\u0600-\\u06FF])(?:س\\s*\\.?\\s*ر|ر\\s*\\.?\\s*س)(?![\\u0600-\\u06FF]))",
  QAR: "\\bQAR\\b",
  CAD: "\\bCAD\\b",
  AUD: "\\bAUD\\b",
};

function currencyAmountExpression(currency: string) {
  const decimals = /^(?:KWD|BHD|OMR)$/.test(currency) ? 3 : 2;
  const amount = `[0-9]{1,6}(?:,[0-9]{3})*(?:\\.[0-9]{1,${decimals}})?`;
  const token = CURRENCY_TOKENS[currency] || currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:${token})\\s*(${amount})|(${amount})\\s*(?:${token})`, "giu");
}

function currencyFromMarkup(value: string) {
  const decoded = normalizeLocalizedNumbers(decodeEvidence(value).replace(/<[^>]*>/g, " "));
  return Object.keys(CURRENCY_TOKENS).find((currency) => currencyAmountExpression(currency).test(decoded)) || "";
}

function publicImageFromScope(scope: string, sourceUrl: string) {
  const tags = [...scope.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  for (const tag of tags) {
    if (!/(?:wp-post-image|woocommerce-product-gallery|product-image|product__media)/i.test(tag)) continue;
    const raw = tag.match(/(?:data-large_image|data-lazy-src|data-src|src)\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    try {
      const url = new URL(decodeEvidence(raw).replace(/^\/\//, "https://"), sourceUrl);
      if (/^https:$/.test(url.protocol)) return url.toString();
    } catch { /* Ignore malformed public markup. */ }
  }
  return "";
}

function productScope(document: string) {
  const title = document.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i);
  const summaryIndex = document.search(/class\s*=\s*["'][^"']*(?:summary|product-summary)[^"']*["']/i);
  const start = Math.max(0, title?.index ?? summaryIndex);
  const bounded = document.slice(start, Math.min(document.length, start + 160_000));
  const marker = /(?:^|[\s_-])(?:related(?:[\s_-]+products?)?|upsells?|cross[\s_-]*sells?|recommend(?:ed|ations?)|product[\s_-]*recommendations?|you[\s_-]*may[\s_-]*also[\s_-]*like|similar[\s_-]*products?)(?:$|[\s_-])/i;
  let relatedAt = -1;
  for (const tag of bounded.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const markup = tag[0];
    const tagName = tag[1].replace(/:/g, "-");
    const quoted = [...markup.matchAll(/(?:class|id)\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
    const unquoted = [...markup.matchAll(/(?:class|id)\s*=\s*([^\s>"']+)/gi)].map((match) => match[1]);
    if (marker.test(tagName) || [...quoted, ...unquoted].some((value) => marker.test(value))) {
      relatedAt = tag.index ?? -1;
      break;
    }
  }
  return relatedAt >= 0 ? bounded.slice(0, relatedAt) : bounded;
}

function scopedPriceSignals(currency: string, values: number[]) {
  if (!currency) return [];
  return [...new Set(values.filter((amount) => Number.isFinite(amount) && amount > 0))]
    .sort((left, right) => left - right)
    .map((amount) => ({ raw: `${currency} ${amount}`, currency, amount }));
}

function markedAmounts(markup: string, currency: string) {
  const decoded = normalizeLocalizedNumbers(decodeEvidence(markup.replace(/<[^>]*>/g, " ")))
    .replace(/[\p{Pd}\u207B\u208B\u2212\u2213\u2238\u2296\u229D\u229F\u2796\u2A29-\u2A2C\u2A3A\u2A41\u2A6C]/gu, "-");
  const expression = currencyAmountExpression(currency);
  return [...decoded.matchAll(expression)]
    .filter((match) => {
      const start = match.index ?? 0;
      const before = decoded.slice(0, start);
      const after = decoded.slice(start + match[0].length);
      const trimmedBefore = before.trimEnd();
      const signPrefix = trimmedBefore.endsWith("-") ? trimmedBefore.slice(0, -1).trimEnd() : null;
      const negativePrefix = signPrefix !== null && (!signPrefix || /[:=]\s*$/u.test(signPrefix));
      return !negativePrefix
        && !/\(\s*$/u.test(before)
        && !/^\s*\)/u.test(after)
        && !/^\s*-\s*$/u.test(after);
    })
    .map((match) => Number((match[1] || match[2]).replace(/,/g, "")));
}

export function extractScopedProductPageEvidence(document: string, sourceUrl = "https://product.invalid/") {
  const scope = productScope(document);
  const observedCurrency = currencyFromMarkup(scope) || confirmedProductCurrency(document, { allowStructured: false });
  const currency = isSupportedCurrency(observedCurrency) ? observedCurrency.trim().toUpperCase() : "";
  const variationAttribute = scope.match(/data-product_variations\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] || "";
  if (variationAttribute && currency) {
    try {
      const variations = JSON.parse(decodeEvidence(variationAttribute));
      const amounts = Array.isArray(variations)
        ? variations.map((variation) => Number(variation?.display_price)).filter((amount) => Number.isFinite(amount) && amount > 0)
        : [];
      const signals = scopedPriceSignals(currency, amounts);
      if (signals.length) return { priceSignals: signals, basis: signals.length > 1 ? "range" as const : "point" as const, imageUrl: publicImageFromScope(scope, sourceUrl) };
    } catch { /* Fall through to the visible product-summary price. */ }
  }

  const priceMarkup = scope.match(/<p\b[^>]*class\s*=\s*["'][^"']*\bprice\b[^"']*["'][^>]*>[\s\S]*?<\/p>/i)?.[0]
    || scope.match(/<(?:div|span)\b[^>]*class\s*=\s*["'][^"']*(?:product[-_ ]price|single_product_price)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|span)>/i)?.[0]
    || "";
  const currentMarkup = priceMarkup.match(/<ins\b[^>]*>([\s\S]*?)<\/ins>/i)?.[1]
    || priceMarkup.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, " ");
  const signals = scopedPriceSignals(currency, markedAmounts(currentMarkup, currency));
  return {
    priceSignals: signals,
    basis: signals.length > 1 ? "range" as const : signals.length === 1 ? (/<ins\b/i.test(priceMarkup) ? "sale" as const : "point" as const) : "unavailable" as const,
    imageUrl: publicImageFromScope(scope, sourceUrl),
  };
}

function addScopedProductPageEvidence(document: string, sourceUrl: string, expected: ProductRecord, products: ProductRecord[], pageTitle: string) {
  const evidence = extractScopedProductPageEvidence(document, sourceUrl);
  if (!evidence.priceSignals.length && !evidence.imageUrl) return;
  const identity = validateProductPageIdentity([expected], products, pageTitle, { allowScopedPageSignal: true });
  if (!identity.accepted) return;
  const selected = identity.products[0];
  const selectedPositive = withPositivePrices(selected);
  products.push({
    ...selected,
    priceSignals: selectedPositive.priceSignals.length ? selectedPositive.priceSignals : evidence.priceSignals,
    imageUrl: selected.imageUrl || evidence.imageUrl,
    attributes: [...new Set([...selected.attributes, ...(evidence.priceSignals.length ? [`Price evidence: ${evidence.basis}`] : [])])],
    extraction: selected.extraction === "json-ld" ? selected.extraction : "page-signal",
  });
}

function pageExtraction(document: string, sourceUrl: string, domain: string) {
  const pageTitle = clean(document.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || domain);
  const pageDescription = decode(document.match(/<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i)?.[1] || "");
  const headings = [...document.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((match) => clean(match[1] || "")).filter(Boolean).slice(0, 16);
  const readable = clean(document.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " "));
  const pagePriceSignals = [...new Set(readable.match(/(?:[$€£]\s?\d{1,5}(?:[,.]\d{1,2})?|\d{1,5}(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP))/gi) || [])].slice(0, 12);
  return { pageTitle, result: extractProductsFromHtml({ document, sourceUrl, domain, observedAt: new Date().toISOString(), pageTitle, pageDescription, headings, pagePriceSignals }) };
}

function expectedProduct(item: ProductEnrichmentTarget): ProductRecord {
  return {
    id: item.productId,
    domain: item.domain,
    name: item.expectedName,
    normalizedName: bilingualNormalize(item.expectedName),
    description: "",
    category: "product",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl: item.sourceUrl,
    imageUrl: "",
    observedAt: new Date().toISOString(),
    claimIds: [],
    quantity: parseCanonicalQuantity(item.expectedName) || undefined,
  };
}

function canonicalSelectedPage(value: string) {
  try {
    const url = new URL(value);
    return `${canonicalDomain(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch { return ""; }
}

function liveTitleIdentity(pageTitle: string) {
  return pageTitle.split(/\s+[|–—]\s+/u)[0]?.trim() || pageTitle.trim();
}

function titleAlignedProduct(product: ProductRecord, pageTitle: string) {
  const titleIdentity = liveTitleIdentity(pageTitle);
  const normalizedTitle = bilingualNormalize(titleIdentity.replace(/(?:\.{3}|…)+$/u, ""));
  const truncatedPrefix = /(?:\.{3}|…)$/u.test(titleIdentity) && normalizedTitle.length >= 12 && product.normalizedName.startsWith(normalizedTitle);
  const titleTokens = new Set(bilingualTokens(titleIdentity).filter((token) => token.length >= 2));
  const productTokens = bilingualTokens(product.name).filter((token) => token.length >= 2);
  const coverage = productTokens.filter((token) => titleTokens.has(token)).length / Math.max(1, productTokens.length);
  const titleQuantity = parseCanonicalQuantity(titleIdentity) || undefined;
  return productTokens.length >= 2 && (coverage >= 0.8 || truncatedPrefix) && !quantitiesConflict(titleQuantity, product.quantity);
}

function observedCatalogReplacement(item: ProductEnrichmentTarget, products: ProductRecord[], pageTitle: string, fetchedUrl: string) {
  if (item.allowCatalogReplacement !== true || canonicalSelectedPage(item.sourceUrl) !== canonicalSelectedPage(fetchedUrl)) return null;
  const candidates = products.filter((product) => product.jsonLdType === "Product"
    && (product.extraction === "json-ld" || product.extraction === "storefront-api")
    && canonicalSelectedPage(product.sourceUrl) === canonicalSelectedPage(item.sourceUrl)
    && titleAlignedProduct(product, pageTitle));
  const groups: ProductRecord[][] = [];
  for (const candidate of candidates) {
    const group = groups.find((entries) => validateProductPageIdentity([entries[0]], [candidate], pageTitle).accepted
      && validateProductPageIdentity([candidate], [entries[0]], pageTitle).accepted);
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  if (groups.length !== 1) return null;
  const product = [...groups[0]].sort((left, right) =>
    Number(right.extraction === "storefront-api") - Number(left.extraction === "storefront-api")
      || Number(right.priceSignals.length > 0) - Number(left.priceSignals.length > 0)
      || Number(/^https:\/\//i.test(right.imageUrl)) - Number(/^https:\/\//i.test(left.imageUrl))
      || left.name.localeCompare(right.name))[0];
  if (!product) return null;
  const observedAt = product.observedAt || new Date().toISOString();
  const audit = catalogReplacementAuditAttribute(item.expectedName, item.sourceUrl);
  return {
    ...product,
    id: item.productId,
    domain: canonicalDomain(item.domain),
    normalizedName: bilingualNormalize(product.name),
    attributes: [...new Set([...product.attributes.filter((attribute) => !attribute.startsWith(CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX)), audit])],
    sourceUrl: item.sourceUrl,
    observedAt,
    claimIds: [...new Set([...product.claimIds, `${item.productId}-catalog-replacement-${Date.parse(observedAt) || 0}`])],
    quantity: parseCanonicalQuantity(product.name) || product.quantity || undefined,
  } satisfies ProductRecord;
}

function isPositivePriceSignal(signal: ProductRecord["priceSignals"][number]) {
  return typeof signal.amount === "number" && Number.isFinite(signal.amount) && signal.amount > 0 && isSupportedCurrency(signal.currency);
}

function withPositivePrices(product: ProductRecord) {
  return { ...product, priceSignals: product.priceSignals.filter(isPositivePriceSignal) };
}

function hasConfirmedPrice(products: ProductRecord[]) {
  return products.some((product) => product.priceSignals.some(isPositivePriceSignal));
}

function confirmedAdapterCurrency(document: string, matchedProduct?: ProductRecord) {
  const matchedCurrencies = [...new Set((matchedProduct?.priceSignals || [])
    .map((signal) => signal.currency?.trim().toUpperCase() || "")
    .filter(isSupportedCurrency))];
  if (matchedCurrencies.length === 1) return matchedCurrencies[0];
  if (matchedCurrencies.length > 1) return "";
  return confirmedProductCurrency(document, { allowStructured: false });
}

function hasSecureImage(products: ProductRecord[]) {
  return products.some((product) => /^https:\/\//i.test(product.imageUrl));
}

function comparablePrice(product: ProductRecord) {
  const prices = product.priceSignals.filter(isPositivePriceSignal);
  return prices.length > 0 && new Set(prices.map((signal) => signal.currency)).size === 1 && new Set(prices.map((signal) => signal.amount)).size === 1;
}

function safeProductUrl(product: ProductRecord, domain: string) {
  try {
    const url = new URL(product.sourceUrl);
    return /^https?:$/.test(url.protocol)
      && canonicalDomain(url.hostname) === canonicalDomain(domain)
      && Boolean(storefrontAdapterRequest(url.toString()))
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

export function selectPrimaryProductPriceTargets(products: ProductRecord[], domain: string, maxPages = 6): ProductEnrichmentTarget[] {
  const limit = Math.max(0, Math.min(MAX_ENRICHMENT_TARGETS, Math.floor(maxPages)));
  const seen = new Set<string>();
  return products
    .filter((product) => product.jsonLdType === "Product" && !comparablePrice(product))
    .map((product) => ({ product, sourceUrl: safeProductUrl(product, domain) }))
    .filter((entry) => Boolean(entry.sourceUrl) && !seen.has(entry.sourceUrl) && Boolean(seen.add(entry.sourceUrl)))
    .sort((left, right) => Number(Boolean(right.product.quantity || parseCanonicalQuantity(right.product.name))) - Number(Boolean(left.product.quantity || parseCanonicalQuantity(left.product.name))) || left.product.name.localeCompare(right.product.name))
    .slice(0, limit)
    .map(({ product, sourceUrl }) => ({
      domain: canonicalDomain(domain),
      sourceUrl,
      productId: product.id,
      expectedName: product.name,
      expectedType: "Product" as const,
      pairScore: 0,
      role: "primary" as const,
      allowCatalogReplacement: true as const,
    }));
}

function priceAmount(value: string) {
  const matched = value.match(/\d{1,5}(?:[,.]\d{1,2})?/i)?.[0];
  if (!matched) return null;
  const normalized = matched.includes(",") && !matched.includes(".") ? matched.replace(",", ".") : matched.replace(/,/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function claimablePagePricePatterns(values: string[]) {
  return values.filter((value) => priceAmount(value) !== 0);
}

export async function enrichProductTargets(targets: ProductEnrichmentTarget[], maxPages = 24) {
  const boundedMax = Math.max(0, Math.min(MAX_ENRICHMENT_TARGETS, Math.floor(maxPages)));
  const selected = targets.slice(0, boundedMax);
  const robotsByDomain = new Map<string, Awaited<ReturnType<typeof sharedRobotsPolicyResolver.resolve>>>();
  await Promise.all([...new Set(selected.map((item) => item.domain))].map(async (domain) => {
    const preferred = selected.find((item) => item.domain === domain)?.sourceUrl || domain;
    robotsByDomain.set(domain, await sharedRobotsPolicyResolver.resolve(domain, preferred));
  }));

  const enrichOne = async (item: ProductEnrichmentTarget) => {
    const gap = (reason: string, code?: EnrichmentGap["code"], httpStatus?: number, failureKind?: EnrichmentGap["failureKind"]): EnrichmentGap => ({ url: item.sourceUrl, productId: item.productId, role: item.role, reason, ...(code ? { code } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}), ...(failureKind ? { failureKind } : {}) });
    try {
      const robotsResult = robotsByDomain.get(item.domain);
      const availability = robotsResult?.availability || "unreachable";
      if (availability === "unreachable") return { product: null, gap: gap("robots.txt was unreachable, so selected-product enrichment was skipped.", "robots_unreachable", undefined, "robots") };
      const robots = robotsResult?.policy;
      if (!robots) return { product: null, gap: gap("robots.txt was unreachable, so selected-product enrichment was skipped.", "robots_unreachable", undefined, "robots") };
      if (!robots.allows(new URL(item.sourceUrl).pathname)) return { product: null, gap: gap("robots.txt disallows this selected product page.", "robots_disallowed", undefined, "robots") };
      const fetched = await fetchSameDomain(item.sourceUrl, item.domain, "text/html,application/xhtml+xml");
      if (!fetched.ok) return { product: null, gap: gap(`Selected product page returned HTTP ${fetched.status} or non-HTML content.`, "fetch_failed", fetched.status, "http") };
      if (!/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) return { product: null, gap: gap(`Selected product page returned HTTP ${fetched.status} or non-HTML content.`, "fetch_failed", fetched.status, "content") };
      const extracted = pageExtraction(fetched.text, fetched.url, item.domain);
      const expected = expectedProduct(item);
      addScopedProductPageEvidence(fetched.text, fetched.url, expected, extracted.result.products, extracted.pageTitle);
      const rawInitialIdentity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle, { allowScopedPageSignal: true });
      const rawMatchedProduct = rawInitialIdentity.products[0];
      extracted.result.products = extracted.result.products.map(withPositivePrices);
      const initialIdentity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle);
      const replacementCandidates = [...extracted.result.products];
      let adapterGap = "";
      let adapterEvidenceProduct: ProductRecord | null = null;
      const adapter = storefrontAdapterRequest(item.sourceUrl);
      const strongestInitialProduct = initialIdentity.products[0];
      if (adapter && (!initialIdentity.accepted || !strongestInitialProduct || !hasConfirmedPrice([strongestInitialProduct]) || !hasSecureImage([strongestInitialProduct]))) {
        const adapterLabel = adapter.kind === "shopify" ? "Shopify product" : "WooCommerce Store API";
        try {
          const adapterUrl = new URL(adapter.endpointUrl);
          if (!robots.allows(`${adapterUrl.pathname}${adapterUrl.search}`)) {
            adapterGap = `robots.txt disallows the ${adapterLabel} endpoint.`;
          } else {
            const adapterResponse = await fetchSameDomain(adapter.endpointUrl, item.domain, "application/json");
            if (!adapterResponse.ok || !/json|javascript/i.test(adapterResponse.contentType)) {
              adapterGap = `${adapterLabel} endpoint returned HTTP ${adapterResponse.status} or non-JSON content.`;
            } else {
              const payload = JSON.parse(adapterResponse.text);
              const observedAt = new Date().toISOString();
              const adapterResult = adapter.kind === "shopify"
                ? parseShopifyProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt, currency: confirmedAdapterCurrency(fetched.text, rawMatchedProduct), expectedQuantity: expected.quantity })
                : parseWooCommerceProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt: new Date().toISOString() });
              if (adapterResult.product) {
                adapterEvidenceProduct = withPositivePrices(adapterResult.product);
                extracted.result.products.push(adapterEvidenceProduct);
              }
              if (item.allowCatalogReplacement === true && !initialIdentity.accepted) {
                const replacementAdapterResult = adapter.kind === "shopify"
                  ? parseShopifyProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt, currency: confirmedAdapterCurrency(fetched.text, rawMatchedProduct) })
                  : adapterResult;
                if (replacementAdapterResult.product) replacementCandidates.push(withPositivePrices(replacementAdapterResult.product));
              }
              adapterGap = adapterResult.gap;
            }
          }
        } catch (error) {
          adapterGap = error instanceof SyntaxError ? `${adapterLabel} endpoint returned invalid JSON.` : `${adapterLabel} endpoint could not be fetched.`;
        }
      }
      const identity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle, { allowScopedPageSignal: true });
      if (!identity.accepted) {
        const replacement = observedCatalogReplacement(item, replacementCandidates, extracted.pageTitle, fetched.url);
        return replacement ? { product: replacement, gap: null } : { product: null, gap: gap(identity.reason, "identity_mismatch", undefined, "identity") };
      }
      const originalIdentityProduct = strongestInitialProduct
        && identity.products.includes(strongestInitialProduct)
        ? strongestInitialProduct
        : null;
      const adapterIdentityProduct = adapterEvidenceProduct
        && identity.products.includes(adapterEvidenceProduct)
        ? adapterEvidenceProduct
        : null;
      const originalAccepted = originalIdentityProduct && hasConfirmedPrice([originalIdentityProduct])
        ? originalIdentityProduct
        : null;
      const accepted = originalAccepted
        ? (!hasSecureImage([originalAccepted]) && adapterIdentityProduct?.imageUrl
            ? { ...originalAccepted, imageUrl: adapterIdentityProduct.imageUrl }
            : originalAccepted)
        : adapterIdentityProduct
          && hasConfirmedPrice([adapterIdentityProduct])
          ? { ...adapterIdentityProduct, imageUrl: adapterIdentityProduct.imageUrl || originalIdentityProduct?.imageUrl || "" }
          : identity.products[0];
      const unresolvedAdapterGap = adapterGap && accepted && !hasConfirmedPrice([accepted]) ? adapterGap : "";
      return { product: accepted ? { ...accepted, id: item.productId } : null, gap: unresolvedAdapterGap ? gap(unresolvedAdapterGap, "adapter_limited", undefined, "adapter") : null };
    } catch (error) {
      const failureKind = error instanceof ProductFetchFailure ? error.failureKind : "content";
      return { product: null, gap: gap(error instanceof Error ? `Selected product page could not be fetched: ${error.message}` : "Selected product page could not be fetched.", "fetch_failed", failureKind === "network" ? 0 : undefined, failureKind) };
    }
  };

  const entries = new Array<Awaited<ReturnType<typeof enrichOne>>>(selected.length);
  const targetIndexesByDomain = new Map<string, number[]>();
  selected.forEach((item, index) => targetIndexesByDomain.set(item.domain, [...(targetIndexesByDomain.get(item.domain) || []), index]));
  await Promise.all([...targetIndexesByDomain.values()].map(async (indexes) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_PER_DOMAIN_CONCURRENCY, indexes.length) }, async () => {
      while (cursor < indexes.length) {
        const index = indexes[cursor];
        cursor += 1;
        entries[index] = await enrichOne(selected[index]);
      }
    }));
  }));

  const products = entries.flatMap((entry) => entry.product ? [entry.product] : []);
  const missingRobotsGaps = [...robotsByDomain.entries()].flatMap(([domain, result]) => {
    if (result.availability !== "missing") return [];
    const first = selected.find((item) => item.domain === domain);
    return first ? [{ url: result.sourceUrl, productId: first.productId, role: first.role, reason: `No robots.txt was published (HTTP ${result.status}); bounded selected-product enrichment proceeded.` }] : [];
  });
  const gaps = [...entries.flatMap((entry) => entry.gap ? [entry.gap] : []), ...missingRobotsGaps];
  return { products, coverage: { pagesRequested: selected.length, pagesFetched: products.length, maxPages: boundedMax, gaps } satisfies ProductEnrichmentCoverage };
}

export function publicProductTarget(value: unknown): ProductEnrichmentTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const domain = canonicalDomain(text(item.domain, 300));
  const productId = text(item.productId, 300);
  const expectedName = text(item.expectedName, 160);
  let sourceUrl = "";
  try {
    const url = new URL(text(item.sourceUrl, 1_000));
    sourceUrl = /^https?:$/.test(url.protocol)
      && canonicalDomain(url.hostname) === domain
      && /\/(?:products?|shop|store)\//i.test(url.pathname)
      ? url.toString()
      : "";
  } catch {
    sourceUrl = "";
  }
  if (!domain || !sourceUrl || !productId || !expectedName || item.expectedType !== "Product") return null;
  return { domain, sourceUrl, productId, expectedName, expectedType: "Product", pairScore: typeof item.pairScore === "number" && Number.isFinite(item.pairScore) ? item.pairScore : 0, role: item.role === "rival" ? "rival" : "primary", ...(item.allowCatalogReplacement === true ? { allowCatalogReplacement: true as const } : {}) };
}
