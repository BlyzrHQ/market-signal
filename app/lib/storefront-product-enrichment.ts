import { canonicalDomain, normalizeDomain } from "./domain.ts";
import { bilingualNormalize, parseCanonicalQuantity } from "./product-normalization.ts";
import { extractProductsFromHtml, validateProductPageIdentity, type ProductEnrichmentTarget, type ProductRecord } from "./product-intelligence.ts";
import { confirmedProductCurrency, parseShopifyProduct, parseWooCommerceProduct, storefrontAdapterRequest } from "./product-page-adapters.ts";
import { parseRobots } from "./robots.ts";

const MAX_DOCUMENT_BYTES = 1_500_000;
export const MAX_ENRICHMENT_TARGETS = 64;
const MAX_PER_DOMAIN_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";

type EnrichmentGap = { url: string; productId: string; role: ProductEnrichmentTarget["role"]; reason: string };

export type ProductEnrichmentCoverage = {
  pagesRequested: number;
  pagesFetched: number;
  maxPages: number;
  gaps: EnrichmentGap[];
};

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

async function fetchSameDomain(url: string, domain: string, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let current = url;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const checked = new URL(current);
      normalizeDomain(checked.hostname);
      if (canonicalDomain(checked.hostname) !== canonicalDomain(domain)) throw new Error("redirected off the product domain");
      const response = await fetch(current, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new Error("redirect limit reached");
        current = new URL(location, current).toString();
        continue;
      }
      const bytes = await response.arrayBuffer();
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        url: current,
        text: new TextDecoder().decode(bytes.slice(0, MAX_DOCUMENT_BYTES)),
      };
    }
    throw new Error("redirect limit reached");
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
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function currencyFromMarkup(value: string) {
  const decoded = decodeEvidence(value);
  if (/\u00A3/.test(decoded)) return "GBP";
  if (/\u20AC/.test(decoded)) return "EUR";
  if (/\$/.test(decoded)) return "USD";
  return decoded.match(/\b(?:GBP|USD|EUR|AED|SAR|KWD|QAR|CAD|AUD)\b/i)?.[0]?.toUpperCase() || "";
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
  const relatedAt = bounded.search(/<(?:section|div)\b[^>]*class\s*=\s*["'][^"']*(?:related|upsells|cross-sells)[^"']*["']/i);
  return relatedAt >= 0 ? bounded.slice(0, relatedAt) : bounded;
}

function scopedPriceSignals(currency: string, values: number[]) {
  if (!currency) return [];
  return [...new Set(values.filter((amount) => Number.isFinite(amount) && amount > 0))]
    .sort((left, right) => left - right)
    .map((amount) => ({ raw: `${currency} ${amount}`, currency, amount }));
}

function markedAmounts(markup: string, currency: string) {
  const decoded = decodeEvidence(markup.replace(/<[^>]*>/g, " "));
  const patterns: Record<string, RegExp> = {
    GBP: /(?:\u00A3|GBP\s*)\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi,
    EUR: /(?:\u20AC|EUR\s*)\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi,
    USD: /(?:\$|USD\s*)\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi,
  };
  const expression = patterns[currency] || new RegExp(`${currency}\\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)`, "gi");
  return [...decoded.matchAll(expression)].map((match) => Number(match[1].replace(/,/g, "")));
}

export function extractScopedProductPageEvidence(document: string, sourceUrl = "https://product.invalid/") {
  const scope = productScope(document);
  const currency = confirmedProductCurrency(document) || currencyFromMarkup(scope);
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
  products.push({
    ...selected,
    priceSignals: selected.priceSignals.length ? selected.priceSignals : evidence.priceSignals,
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

function hasConfirmedPrice(products: ProductRecord[]) {
  return products.some((product) => product.priceSignals.some((signal) => typeof signal.amount === "number" && Boolean(signal.currency)));
}

function hasSecureImage(products: ProductRecord[]) {
  return products.some((product) => /^https:\/\//i.test(product.imageUrl));
}

function comparablePrice(product: ProductRecord) {
  const prices = product.priceSignals.filter((signal) => typeof signal.amount === "number" && Boolean(signal.currency));
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
  const robotsByDomain = new Map<string, Awaited<ReturnType<typeof fetchSameDomain>> | null>();
  await Promise.all([...new Set(selected.map((item) => item.domain))].map(async (domain) => {
    try {
      robotsByDomain.set(domain, await fetchSameDomain(`https://${domain}/robots.txt`, domain, "text/plain"));
    } catch {
      robotsByDomain.set(domain, null);
    }
  }));

  const enrichOne = async (item: ProductEnrichmentTarget) => {
    const gap = (reason: string): EnrichmentGap => ({ url: item.sourceUrl, productId: item.productId, role: item.role, reason });
    try {
      const robotsResult = robotsByDomain.get(item.domain);
      if (!robotsResult?.ok) return { product: null, gap: gap("robots.txt could not be read, so selected-product enrichment was skipped.") };
      const robots = parseRobots(robotsResult.text);
      if (!robots.allows(new URL(item.sourceUrl).pathname)) return { product: null, gap: gap("robots.txt disallows this selected product page.") };
      const fetched = await fetchSameDomain(item.sourceUrl, item.domain, "text/html,application/xhtml+xml");
      if (!fetched.ok || !/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) return { product: null, gap: gap(`Selected product page returned HTTP ${fetched.status} or non-HTML content.`) };
      const extracted = pageExtraction(fetched.text, fetched.url, item.domain);
      const expected = expectedProduct(item);
      addScopedProductPageEvidence(fetched.text, fetched.url, expected, extracted.result.products, extracted.pageTitle);
      const initialIdentity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle);
      let adapterGap = "";
      const adapter = storefrontAdapterRequest(item.sourceUrl);
      if (adapter && (!initialIdentity.accepted || !hasConfirmedPrice(extracted.result.products) || !hasSecureImage(extracted.result.products))) {
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
              const adapterResult = adapter.kind === "shopify"
                ? parseShopifyProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt: new Date().toISOString(), currency: confirmedProductCurrency(fetched.text), expectedQuantity: expected.quantity })
                : parseWooCommerceProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt: new Date().toISOString() });
              if (adapterResult.product) extracted.result.products.push(adapterResult.product);
              adapterGap = adapterResult.gap;
            }
          }
        } catch (error) {
          adapterGap = error instanceof SyntaxError ? `${adapterLabel} endpoint returned invalid JSON.` : `${adapterLabel} endpoint could not be fetched.`;
        }
      }
      const identity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle, { allowScopedPageSignal: true });
      if (!identity.accepted) return { product: null, gap: gap(identity.reason) };
      const accepted = identity.products[0];
      const unresolvedAdapterGap = adapterGap && accepted && !hasConfirmedPrice([accepted]) ? adapterGap : "";
      return { product: accepted ? { ...accepted, id: item.productId } : null, gap: unresolvedAdapterGap ? gap(unresolvedAdapterGap) : null };
    } catch (error) {
      return { product: null, gap: gap(error instanceof Error ? `Selected product page could not be fetched: ${error.message}` : "Selected product page could not be fetched.") };
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
  const gaps = entries.flatMap((entry) => entry.gap ? [entry.gap] : []);
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
  return { domain, sourceUrl, productId, expectedName, expectedType: "Product", pairScore: typeof item.pairScore === "number" && Number.isFinite(item.pairScore) ? item.pairScore : 0, role: item.role === "rival" ? "rival" : "primary" };
}
