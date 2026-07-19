import { canonicalDomain, normalizeDomain } from "../../lib/domain.ts";
import { bilingualNormalize, parseCanonicalQuantity } from "../../lib/product-normalization.ts";
import { extractProductsFromHtml, validateProductPageIdentity, type ProductEnrichmentTarget, type ProductRecord } from "../../lib/product-intelligence.ts";
import { parseRobots } from "../../lib/robots.ts";

const MAX_TARGETS = 24;
const MAX_DOCUMENT_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function publicProductUrl(value: unknown, domain: string) {
  try {
    const url = new URL(text(value, 1_000));
    normalizeDomain(url.hostname);
    return /^https?:$/.test(url.protocol)
      && canonicalDomain(url.hostname) === canonicalDomain(domain)
      && /\/(?:products?|shop|store)\//i.test(url.pathname)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function target(value: unknown): ProductEnrichmentTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const domain = canonicalDomain(text(item.domain, 300));
  const sourceUrl = publicProductUrl(item.sourceUrl, domain);
  const productId = text(item.productId, 300);
  const expectedName = text(item.expectedName, 160);
  if (!domain || !sourceUrl || !productId || !expectedName || item.expectedType !== "Product") return null;
  return {
    domain,
    sourceUrl,
    productId,
    expectedName,
    expectedType: "Product",
    pairScore: typeof item.pairScore === "number" && Number.isFinite(item.pairScore) ? item.pairScore : 0,
    role: item.role === "rival" ? "rival" : "primary",
  };
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

export async function POST(request: Request) {
  try {
    const body = await request.json() as { targets?: unknown };
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS).flatMap((value) => {
      const parsed = target(value);
      return parsed ? [parsed] : [];
    }) : [];
    if (!targets.length) return Response.json({ ok: false, error: "At least one verified selected product page is required." }, { status: 400 });

    const robotsByDomain = new Map<string, Awaited<ReturnType<typeof fetchSameDomain>> | null>();
    await Promise.all([...new Set(targets.map((item) => item.domain))].map(async (domain) => {
      try {
        robotsByDomain.set(domain, await fetchSameDomain(`https://${domain}/robots.txt`, domain, "text/plain"));
      } catch {
        robotsByDomain.set(domain, null);
      }
    }));
    const entries = await Promise.all(targets.map(async (item) => {
      try {
        const robotsResult = robotsByDomain.get(item.domain);
        if (!robotsResult?.ok) return { product: null, gap: { url: item.sourceUrl, productId: item.productId, role: item.role, reason: "robots.txt could not be read, so selected-product enrichment was skipped." } };
        const robots = parseRobots(robotsResult.text);
        if (!robots.allows(new URL(item.sourceUrl).pathname)) return { product: null, gap: { url: item.sourceUrl, productId: item.productId, role: item.role, reason: "robots.txt disallows this selected product page." } };
        const fetched = await fetchSameDomain(item.sourceUrl, item.domain, "text/html,application/xhtml+xml");
        if (!fetched.ok || !/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) return { product: null, gap: { url: item.sourceUrl, productId: item.productId, role: item.role, reason: `Selected product page returned HTTP ${fetched.status} or non-HTML content.` } };
        const extracted = pageExtraction(fetched.text, fetched.url, item.domain);
        const identity = validateProductPageIdentity([expectedProduct(item)], extracted.result.products, extracted.pageTitle);
        if (!identity.accepted) return { product: null, gap: { url: item.sourceUrl, productId: item.productId, role: item.role, reason: identity.reason } };
        const accepted = identity.products[0];
        return { product: accepted ? { ...accepted, id: item.productId } : null, gap: null };
      } catch (error) {
        return { product: null, gap: { url: item.sourceUrl, productId: item.productId, role: item.role, reason: error instanceof Error ? `Selected product page could not be fetched: ${error.message}` : "Selected product page could not be fetched." } };
      }
    }));
    const products = entries.flatMap((entry) => entry.product ? [entry.product] : []);
    const gaps = entries.flatMap((entry) => entry.gap ? [entry.gap] : []);
    return Response.json({ ok: true, products, coverage: { pagesRequested: targets.length, pagesFetched: products.length, maxPages: MAX_TARGETS, gaps } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Selected product enrichment was unavailable." }, { status: 400 });
  }
}
