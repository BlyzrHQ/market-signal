import { canonicalDomain, normalizeDomain } from "../../lib/domain";
import { buildProductComparison, extractFirstPartyOfferings, extractProductsFromHtml, extractProductsFromSitemap, selectPreferredProducts, selectProductEnrichmentTargets, type ProductRecord } from "../../lib/product-intelligence";
import { parseRobots } from "../../lib/robots";
import { discoverCompetitors, type DiscoveryCandidate, type DiscoveryResult } from "../../lib/competitor-discovery";
import { attributableFacebookUrl, type AdIntelligenceResult } from "../../lib/ad-intelligence";
import { compareVerifiedCompetitors, verifyCompetitorEntity, type CompetitorVerification } from "../../lib/competitor-verification";
import { inferBusinessProfile } from "../../lib/business-profile";
import { combineRegionSignals, displayRegion, inferRegion as inferRegionEvidence, type RegionSignal } from "../../lib/region-inference";

type ClaimType = "Observed" | "Inferred";
type Confidence = "High" | "Medium" | "Low";

type Claim = {
  id: string;
  claimType: ClaimType;
  text: string;
  sourceUrl: string;
  observedAt: string;
  confidence: Confidence;
};

type CrawlPage = {
  ok: true;
  live: true;
  domain: string;
  url: string;
  path: string;
  sourceUrl: string;
  fetchedAt: string;
  title: string;
  description: string;
  language: string;
  region: string;
  regionCountryCode: string;
  regionConfidence: Confidence;
  regionSignals: RegionSignal[];
  headings: string[];
  prices: string[];
  socialLinks: string[];
  internalLinks: string[];
  wordCount: number;
  truncated: boolean;
  contentHash: string;
  claims: Claim[];
  products: ProductRecord[];
  productGaps: string[];
  thirdPartyProductCount: number;
};

type Gap = { url: string; reason: string; observedAt: string };
type Candidate = { domain: string; reason: string; sourceUrl: string; claimIds: string[] };

type DomainCrawl = {
  domain: string;
  role: "primary" | "submitted-comparison" | "discovered-competitor";
  homepage: CrawlPage | null;
  pages: CrawlPage[];
  products: ProductRecord[];
  candidates: Candidate[];
  gaps: Gap[];
  coverage: { pagesRequested: number; pagesFetched: number; maxPages: number; robotsChecked: boolean };
  productCoverage: { scannedPages: number; catalogProductsDiscovered: number; thirdPartyReferenced: number };
  fetchedAt: string;
  discovery?: DiscoveryCandidate & CompetitorVerification;
  enrichmentPages?: CrawlPage[];
  priceEnrichment?: { pagesRequested: number; pagesFetched: number; maxPages: number };
};

type ReportBlock = Record<string, unknown> & { type: string; id: string };

const MAX_DOMAINS = 4;
const MAX_HTML_PAGES = 5;
const MAX_DISCOVERED_HTML_PAGES = 3;
const MAX_SITEMAP_DOCUMENTS = 4;
const MAX_DISCOVERED_SITEMAP_DOCUMENTS = 2;
const MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES = 6;
const MAX_DOCUMENT_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 6_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";
const PRIORITY_PATHS = ["/pricing", "/plans", "/products", "/features", "/compare", "/integrations", "/about", "/customers", "/blog"];
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com", "x.com", "twitter.com"];

function verifyDiscoveredCompetitor(primary: DomainCrawl, candidate: DomainCrawl, discovery: DiscoveryCandidate) {
  if (!primary.homepage || !candidate.homepage) return candidate;
  const verification = verifyCompetitorEntity(
    { domain: primary.domain, title: primary.homepage.title, description: primary.homepage.description, region: primary.homepage.region, headings: primary.pages.flatMap((page) => page.headings), products: primary.products },
    { domain: candidate.domain, title: candidate.homepage.title, description: candidate.homepage.description, region: candidate.homepage.region, headings: candidate.pages.flatMap((page) => page.headings), products: candidate.products },
    discovery,
  );
  return { ...candidate, discovery: { ...discovery, ...verification } };
}

function productPathPriority(path: string) {
  if (/\/(?:pricing|plans?)(?:\/|$)/i.test(path)) return -10;
  if (/\/(?:boxes?|bundles?|subscriptions?|products?|shop|store|collections?|catalog|solutions?|services?|capabilities|expertise|platform|features?)(?:\/|$)/i.test(path)) return 0;
  if (/^\/[^/]+\/?$/.test(path) && !/\/(?:about|blog|careers?|contact|customers?|docs?|help|login|news|press|privacy|resources?|support|terms)(?:\/|$)/i.test(path)) return 30;
  const exact = PRIORITY_PATHS.indexOf(path);
  if (exact >= 0) return 200 + exact;
  return 999;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").replace(/&nbsp;/gi, " ").trim();
}

function decodeEntities(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function stripMarkup(value: string) {
  return cleanText(decodeEntities(value.replace(/<[^>]*>/g, " ")));
}

function firstMatch(document: string, expression: RegExp) {
  return document.match(expression)?.[1] ?? "";
}

function allMatches(document: string, expression: RegExp) {
  return [...document.matchAll(expression)].map((match) => cleanText(decodeEntities(match[1] ?? ""))).filter(Boolean);
}

function unique(values: string[], limit = 20) {
  return [...new Set(values)].slice(0, limit);
}

function prices(text: string) {
  return unique(text.match(/(?:[$€£]\s?\d{1,5}(?:[,.]\d{1,2})?|\d{1,5}(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP))(?:\s*\/\s*(?:mo|month|year|yr|user))?/gi)?.map(cleanText) ?? [], 12);
}

function socialLinks(document: string, baseUrl: URL) {
  return unique(allMatches(document, /href\s*=\s*["']([^"']+)["']/gi).flatMap((href) => {
    try {
      const url = new URL(href, baseUrl);
      return SOCIAL_HOSTS.some((host) => url.hostname.includes(host)) ? [url.toString()] : [];
    } catch {
      return [];
    }
  }), 12);
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function fetchText(url: string, accept: string, expectedDomain?: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let currentUrl = url;
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const checked = normalizeDomain(currentUrl);
      if (expectedDomain && canonicalDomain(checked.hostname) !== canonicalDomain(expectedDomain)) throw new Error("redirected off the submitted domain");
      response = await fetch(currentUrl, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("redirect limit reached");
      currentUrl = new URL(location, currentUrl).toString();
    }
    if (!response) throw new Error("request failed");
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > MAX_DOCUMENT_BYTES;
    return { ok: response.ok, status: response.status, contentType: response.headers.get("content-type") ?? "", url: response.url || url, text: new TextDecoder().decode(buffer.slice(0, MAX_DOCUMENT_BYTES)), truncated };
  } catch (error) {
    return { ok: false, status: 0, contentType: "", url, text: "", truncated: false, error: error instanceof Error && error.name === "AbortError" ? "timeout" : "request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function extractLinks(document: string, baseUrl: URL, domain: string) {
  const paths: string[] = [];
  const candidates = new Map<string, { domain: string; text: string; sourceUrl: string }>();
  for (const match of document.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1] ?? "";
    const anchorText = stripMarkup(match[2] ?? "");
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      url.search = "";
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (canonicalDomain(url.hostname) === domain) {
        if (url.pathname !== "/") paths.push(url.pathname);
      } else if (!SOCIAL_HOSTS.some((host) => url.hostname.includes(host)) && /\b(compare|alternative|competitor|similar|versus|vs\.?)/i.test(anchorText)) {
        const candidateDomain = canonicalDomain(url.hostname);
        if (candidateDomain !== domain && !candidates.has(candidateDomain)) candidates.set(candidateDomain, { domain: candidateDomain, text: anchorText || "linked market reference", sourceUrl: baseUrl.toString() });
      }
    } catch {
      continue;
    }
  }
  return { paths: unique(paths, 60), candidates: [...candidates.values()] };
}

function parseSitemapUrls(text: string, domain: string) {
  return unique([...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)].flatMap((match) => {
    try {
      const url = new URL(decodeEntities(match[1]));
      return canonicalDomain(url.hostname) === domain ? [url.toString()] : [];
    } catch {
      return [];
    }
  }), 500);
}

async function collectSitemapEvidence(sitemapUrl: string, domain: string, observedAt: string, maxDocuments = MAX_SITEMAP_DOCUMENTS) {
  const root = await fetchText(sitemapUrl, "application/xml,text/xml,text/plain", domain);
  if (!root.ok) return { paths: [] as string[], products: [] as ProductRecord[] };
  const rootUrls = parseSitemapUrls(root.text, domain);
  const childSitemaps = rootUrls.filter((value) => /sitemap[^/]*\.xml/i.test(new URL(value).pathname)).sort((left, right) => Number(!/products?/i.test(left)) - Number(!/products?/i.test(right))).slice(0, maxDocuments);
  const documents = childSitemaps.length ? await Promise.all(childSitemaps.map(async (url) => ({ url, result: await fetchText(url, "application/xml,text/xml,text/plain", domain) }))) : [{ url: sitemapUrl, result: root }];
  const urls = documents.flatMap(({ result }) => result.ok ? parseSitemapUrls(result.text, domain) : []);
  const products = documents.flatMap(({ result }) => result.ok ? extractProductsFromSitemap(result.text, domain, observedAt) : []);
  return { paths: unique(urls.flatMap((value) => { try { return [new URL(value).pathname]; } catch { return []; } }), 500), products: selectPreferredProducts(products) };
}

function makeClaim(domain: string, suffix: string, text: string, sourceUrl: string, observedAt: string, claimType: ClaimType = "Observed", confidence: Confidence = "High"): Claim {
  return { id: `${domain}-${suffix}`, claimType, text: text.slice(0, 300), sourceUrl, observedAt, confidence };
}

async function parsePage(document: string, sourceUrl: string, fetchedAt: string, domain: string, truncated: boolean): Promise<CrawlPage> {
  const url = new URL(sourceUrl);
  const readable = stripMarkup(document.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " "));
  const title = stripMarkup(firstMatch(document, /<title[^>]*>([\s\S]*?)<\/title>/i)) || domain;
  const description = decodeEntities(firstMatch(document, /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i) || firstMatch(document, /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["']/i));
  const headings = unique(allMatches(document, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi).map(stripMarkup), 16);
  const internalLinks = unique(extractLinks(document, url, domain).paths, 20);
  const language = firstMatch(document, /<html[^>]*\blang\s*=\s*["']([^"']+)["']/i).toLowerCase() || "unknown";
  const observedAt = fetchedAt;
  const textContent = `${title} ${description} ${readable}`;
  const observedPrices = prices(readable);
  const priceSignals = /\/(?:products?|shop|store|catalog|pricing|plans?)(?:\/|$)/i.test(url.pathname) ? observedPrices : [];
  const regionInference = inferRegionEvidence({ domain, language, document, text: textContent, priceSignals: observedPrices, sourceUrl });
  const productExtraction = extractProductsFromHtml({ document, sourceUrl, domain, observedAt, pageTitle: title, pageDescription: description, headings, pagePriceSignals: priceSignals });
  const claims: Claim[] = [
    makeClaim(domain, `${url.pathname}-title`, `${domain} presents itself as “${title}”.`, sourceUrl, observedAt),
    ...(description ? [makeClaim(domain, `${url.pathname}-description`, `${domain} describes itself as “${description}”.`, sourceUrl, observedAt)] : []),
    ...(priceSignals.length ? [makeClaim(domain, `${url.pathname}-prices`, `${domain} exposes these public price patterns: ${priceSignals.join(", ")}.`, sourceUrl, observedAt)] : []),
    ...(headings.length ? [makeClaim(domain, `${url.pathname}-headings`, `${domain} uses these public headings: ${headings.slice(0, 5).join("; ")}.`, sourceUrl, observedAt)] : []),
    makeClaim(domain, `${url.pathname}-language`, `${domain} exposes language ${language || "unknown"} and region signal ${displayRegion(regionInference)}.`, sourceUrl, observedAt, "Inferred", regionInference.confidence),
    makeClaim(domain, `${url.pathname}-social`, `${domain} links to ${socialLinks(document, url).length} public social profiles from this page.`, sourceUrl, observedAt),
    ...productExtraction.products.map((product) => ({ id: product.claimIds[0], claimType: "Observed" as const, text: `${domain} exposes product or service “${product.name}” via ${product.extraction === "json-ld" ? "structured JSON-LD" : "a product-like public page"}.`, sourceUrl: product.sourceUrl, observedAt: product.observedAt, confidence: product.confidence })),
  ];
  return { ok: true, live: true, domain, url: sourceUrl, path: url.pathname, sourceUrl, fetchedAt, title, description: description || "No meta description was exposed on the public page.", language: language || "unknown", region: displayRegion(regionInference), regionCountryCode: regionInference.countryCode, regionConfidence: regionInference.confidence, regionSignals: regionInference.signals, headings, prices: priceSignals, socialLinks: socialLinks(document, url), internalLinks, wordCount: readable ? readable.split(/\s+/).length : 0, truncated, contentHash: await hash(document), claims, products: productExtraction.products, productGaps: productExtraction.gaps, thirdPartyProductCount: productExtraction.thirdPartyReferenced.length };
}

async function crawlDomain(input: string, role: DomainCrawl["role"], seededProductUrls: string[] = []): Promise<DomainCrawl> {
  const startedAt = new Date().toISOString();
  const maxHtmlPages = role === "discovered-competitor" ? MAX_DISCOVERED_HTML_PAGES : MAX_HTML_PAGES;
  const maxSitemapDocuments = role === "discovered-competitor" ? MAX_DISCOVERED_SITEMAP_DOCUMENTS : MAX_SITEMAP_DOCUMENTS;
  let base: URL;
  try {
    base = normalizeDomain(input);
  } catch (error) {
    const domain = canonicalDomain(input);
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps: [{ url: input, reason: error instanceof Error ? error.message : "invalid or private domain.", observedAt: startedAt }], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: false }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const domain = base.hostname;
  const gaps: Gap[] = [];
  const robotsResult = await fetchText(new URL("/robots.txt", base).toString(), "text/plain", domain);
  const robots = robotsResult.ok ? parseRobots(robotsResult.text) : { sitemaps: [], hasRules: false, allows: () => true };
  if (!robotsResult.ok) gaps.push({ url: new URL("/robots.txt", base).toString(), reason: "robots.txt could not be read; expansion is limited to the homepage.", observedAt: startedAt });
  if (robotsResult.ok && !robots.allows("/")) {
    gaps.push({ url: base.toString(), reason: "robots.txt disallows the homepage for this scanner.", observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: true }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const homepageResult = await fetchText(base.toString(), "text/html,application/xhtml+xml", domain);
  if (!homepageResult.ok || !/text\/html|application\/xhtml\+xml/i.test(homepageResult.contentType)) {
    gaps.push({ url: base.toString(), reason: homepageResult.error || `homepage returned HTTP ${homepageResult.status}.`, observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: robotsResult.ok }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const homepageHost = new URL(homepageResult.url).hostname.toLowerCase().replace(/^www\./, "");
  if (homepageHost !== domain.replace(/^www\./, "")) {
    gaps.push({ url: base.toString(), reason: "homepage redirected off the submitted domain.", observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: robotsResult.ok }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const homepage = await parsePage(homepageResult.text, homepageResult.url, startedAt, domain, homepageResult.truncated);
  const discovered = extractLinks(homepageResult.text, new URL(homepageResult.url), domain);
  let sitemapPaths: string[] = [];
  let sitemapProducts: ProductRecord[] = [];
  const sitemapUrl = (() => { try { const candidate = new URL(robots.sitemaps[0] || "/sitemap.xml", base); return canonicalDomain(candidate.hostname) === canonicalDomain(domain) && /^https?:$/.test(candidate.protocol) ? candidate.toString() : new URL("/sitemap.xml", base).toString(); } catch { return new URL("/sitemap.xml", base).toString(); } })();
  if (robotsResult.ok) {
    const sitemapEvidence = await collectSitemapEvidence(sitemapUrl, domain, startedAt, maxSitemapDocuments);
    sitemapPaths = sitemapEvidence.paths;
    sitemapProducts = sitemapEvidence.products;
  }
  const candidates = discovered.candidates.slice(0, 12).map((candidate, index) => ({ domain: candidate.domain, reason: `A public page linked to this domain with “${candidate.text.slice(0, 120)}”. This is a possible match, not a confirmed competitor.`, sourceUrl: candidate.sourceUrl, claimIds: [`${domain}-candidate-${index}`] }));
  candidates.forEach((candidate, index) => homepage.claims.push(makeClaim(domain, `candidate-${index}`, `${domain} linked to possible market candidate ${candidate.domain}; anchor context supports investigation only.`, candidate.sourceUrl, startedAt, "Inferred", "Low")));
  const seededPaths = seededProductUrls.flatMap((value) => { try { const url = new URL(value); return canonicalDomain(url.hostname) === domain ? [`${url.pathname}${url.search}`] : []; } catch { return []; } });
  const observedPaths = robotsResult.ok ? unique([...discovered.paths, ...sitemapPaths], 500) : [];
  const sortedObservedPaths = observedPaths.sort((left, right) => {
    return productPathPriority(left) - productPathPriority(right) || left.localeCompare(right);
  });
  const expandablePaths = unique([...seededPaths, ...sortedObservedPaths], maxHtmlPages - 1);
  const paths = expandablePaths.filter((path) => robots.allows(new URL(path, base).pathname));
  for (const path of expandablePaths) if (!robots.allows(new URL(path, base).pathname)) gaps.push({ url: new URL(path, base).toString(), reason: "robots.txt disallows this crawl path.", observedAt: startedAt });
  const fetchedPages = await Promise.all(paths.map(async (path) => {
    const url = new URL(path, base).toString();
    const result = await fetchText(url, "text/html,application/xhtml+xml", domain);
    if (!result.ok || !/text\/html|application\/xhtml\+xml/i.test(result.contentType)) { gaps.push({ url, reason: result.error || `page returned HTTP ${result.status} or non-HTML content.`, observedAt: startedAt }); return null; }
    const finalHost = new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
    if (finalHost !== domain.replace(/^www\./, "")) { gaps.push({ url, reason: "redirected off the submitted domain.", observedAt: startedAt }); return null; }
    return parsePage(result.text, result.url, new Date().toISOString(), domain, result.truncated);
  }));
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const pages = [homepage, ...fetchedPages.filter((page): page is CrawlPage => Boolean(page))].filter((page) => {
    const normalizedUrl = page.sourceUrl.split("#")[0];
    if (seenUrls.has(normalizedUrl) || seenHashes.has(page.contentHash)) return false;
    seenUrls.add(normalizedUrl);
    seenHashes.add(page.contentHash);
    return true;
  });
  const combinedRegion = combineRegionSignals(pages.flatMap((page) => page.regionSignals));
  if (combinedRegion.countryCode) {
    homepage.region = displayRegion(combinedRegion);
    homepage.regionCountryCode = combinedRegion.countryCode;
    homepage.regionConfidence = combinedRegion.confidence;
    homepage.regionSignals = combinedRegion.signals;
  }
  for (const page of pages) for (const reason of page.productGaps) gaps.push({ url: page.sourceUrl, reason, observedAt: page.fetchedAt });
  const observedProducts = selectPreferredProducts([...sitemapProducts, ...pages.flatMap((page) => page.products)]);
  const business = inferBusinessProfile({
    domain,
    title: homepage.title,
    description: homepage.description,
    region: homepage.region,
    language: homepage.language,
    products: observedProducts,
    pages: pages.map((page) => ({ title: page.title, description: page.description, path: page.path, sourceUrl: page.sourceUrl, headings: page.headings })),
  });
  const fallbackOfferings = observedProducts.length >= 5 ? [] : extractFirstPartyOfferings({
    domain,
    observedAt: startedAt,
    businessType: business.businessType,
    pages: pages.map((page) => ({ sourceUrl: page.sourceUrl, title: page.title, description: page.description, headings: page.headings })),
  });
  for (const offering of fallbackOfferings) {
    const page = pages.find((candidate) => candidate.sourceUrl === offering.sourceUrl);
    if (page && !page.claims.some((claim) => claim.id === offering.claimIds[0])) page.claims.push({ id: offering.claimIds[0], claimType: "Observed", text: `${domain} presents “${offering.name}” as a first-party ${business.businessType === "ecommerce" ? "subscription or product option" : "service or capability"}.`, sourceUrl: offering.sourceUrl, observedAt: offering.observedAt, confidence: "Medium" });
  }
  const products = selectPreferredProducts([...observedProducts, ...fallbackOfferings]);
  return { domain, role, homepage, pages, products, candidates, gaps, coverage: { pagesRequested: 1 + paths.length, pagesFetched: pages.length, maxPages: maxHtmlPages, robotsChecked: robotsResult.ok }, productCoverage: { scannedPages: pages.length, catalogProductsDiscovered: sitemapProducts.length, thirdPartyReferenced: pages.reduce((sum, page) => sum + page.thirdPartyProductCount, 0) }, fetchedAt: startedAt };
}

function comparisonSourceUrls(results: DomainCrawl[], primaryDomain: string) {
  const primary = results.find((result) => result.domain === primaryDomain);
  const required = Object.fromEntries(results.map((result) => [result.domain, [result.discovery?.provenPrimaryProduct?.sourceUrl, result.discovery?.provenRivalProduct?.sourceUrl].filter((value): value is string => Boolean(value))]));
  for (const result of results.filter((candidate) => candidate.role === "discovered-competitor" && candidate.discovery?.accepted)) {
    if (primary && result.discovery?.provenPrimaryProduct?.sourceUrl) (required[primary.domain] ||= []).push(result.discovery.provenPrimaryProduct.sourceUrl);
  }
  return required;
}

async function enrichMatchedProductPages(results: DomainCrawl[], primaryDomain: string) {
  const comparison = buildProductComparison(primaryDomain, results.map((result) => ({ domain: result.domain, products: result.products })), comparisonSourceUrls(results, primaryDomain));
  const targets = selectProductEnrichmentTargets(comparison, MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES);
  if (!targets.length) return results;
  const grouped = new Map<string, string[]>();
  for (const target of targets) {
    const urls = grouped.get(target.domain) || [];
    if (!urls.includes(target.sourceUrl)) urls.push(target.sourceUrl);
    grouped.set(target.domain, urls);
  }
  const updates = await Promise.all([...grouped].map(async ([domain, sourceUrls]) => {
    const result = results.find((candidate) => candidate.domain === domain);
    const observedAt = new Date().toISOString();
    const gaps: Gap[] = [];
    if (!result?.homepage) return { domain, sourceUrls, pages: [] as CrawlPage[], gaps };
    const base = normalizeDomain(result.homepage.sourceUrl);
    const robotsUrl = new URL("/robots.txt", base).toString();
    const robotsResult = await fetchText(robotsUrl, "text/plain", domain);
    if (!robotsResult.ok) {
      for (const sourceUrl of sourceUrls) gaps.push({ url: sourceUrl, reason: "Matched product price enrichment was skipped because robots.txt could not be read.", observedAt });
      return { domain, sourceUrls, pages: [] as CrawlPage[], gaps };
    }
    const robots = parseRobots(robotsResult.text);
    const entries = await Promise.all(sourceUrls.map(async (sourceUrl) => {
      const path = new URL(sourceUrl).pathname;
      if (!robots.allows(path)) return { page: null, gap: { url: sourceUrl, reason: "robots.txt disallows this matched product price-enrichment page.", observedAt } as Gap };
      const fetched = await fetchText(sourceUrl, "text/html,application/xhtml+xml", domain);
      if (!fetched.ok || !/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) return { page: null, gap: { url: sourceUrl, reason: fetched.error || `Matched product price-enrichment page returned HTTP ${fetched.status} or non-HTML content.`, observedAt } as Gap };
      try {
        const page = await parsePage(fetched.text, fetched.url, new Date().toISOString(), domain, fetched.truncated);
        const hasPrice = page.products.some((product) => product.priceSignals.some((signal) => typeof signal.amount === "number" && Boolean(signal.currency)));
        return { page, gap: hasPrice ? null : { url: sourceUrl, reason: "The matched public product page was fetched but did not expose comparable structured price evidence.", observedAt } as Gap };
      } catch {
        return { page: null, gap: { url: sourceUrl, reason: "The matched public product page could not be parsed for price evidence.", observedAt } as Gap };
      }
    }));
    return { domain, sourceUrls, pages: entries.flatMap((entry) => entry.page ? [entry.page] : []), gaps: [...gaps, ...entries.flatMap((entry) => entry.gap ? [entry.gap] : [])] };
  }));
  const updateByDomain = new Map(updates.map((update) => [update.domain, update]));
  return results.map((result) => {
    const update = updateByDomain.get(result.domain);
    if (!update) return result;
    return {
      ...result,
      enrichmentPages: update.pages,
      priceEnrichment: { pagesRequested: update.sourceUrls.length, pagesFetched: update.pages.length, maxPages: MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES },
      products: selectPreferredProducts([...result.products, ...update.pages.flatMap((page) => page.products)]),
      gaps: [...result.gaps, ...update.gaps],
    };
  });
}

function buildDocument(results: DomainCrawl[], primaryDomain: string, discovery?: DiscoveryResult, investigated: Array<DomainCrawl | null> = [], ads?: AdIntelligenceResult): { version: "1"; generatedAt: string; blocks: ReportBlock[] } {
  const discovered = results.filter((result) => result.role === "discovered-competitor" && result.homepage && result.discovery);
  const productMatched = discovered.filter((result) => result.discovery?.hasProductOverlap).length;
  const blocks: ReportBlock[] = [{ type: "summary", id: "scan-summary", title: discovered.length ? `We verified ${discovered.length} market competitor${discovered.length === 1 ? "" : "s"}` : "No company passed independent verification", body: discovered.length ? `${productMatched} had a comparable public product match. Every included company was crawled and had to describe itself in the same core category; product overlap increased confidence but was not required.` : discovery?.gap || "No searched company exposed enough first-party category evidence to include without guessing." }];
  if (discovery) blocks.push({ type: "market-profile", id: "market-profile", category: discovery.category, region: discovery.region, businessType: discovery.businessType, queries: discovery.queries, provider: discovery.provider, model: discovery.model, available: discovery.available, gaps: discovery.gaps, gap: discovery.gap || "" });
  for (const result of discovered) blocks.push({ type: "competitor", id: `competitor-${result.domain}`, domain: result.domain, companyName: result.discovery?.companyName, title: result.homepage?.title, description: result.homepage?.description, reason: result.discovery?.reason, marketCategory: result.discovery?.marketCategory, relationship: result.discovery?.relationship, sharedOfferings: result.discovery?.sharedOfferings, categoryAlignment: result.discovery?.categoryAlignment, regionCompatibility: result.discovery?.regionCompatibility, hasProductOverlap: result.discovery?.hasProductOverlap, matchedPrimaryProductName: result.discovery?.provenPrimaryProduct?.name, matchedProductName: result.discovery?.provenRivalProduct?.name, matchedProductUrl: result.discovery?.provenRivalProduct?.sourceUrl || result.discovery?.websiteUrl, searchQuery: result.discovery?.searchQuery, discoverySourceUrl: result.discovery?.sourceUrl, websiteSourceUrl: result.homepage?.sourceUrl, verificationScore: result.discovery?.verificationScore, confidence: result.discovery?.confidence, overlapTerms: result.discovery?.overlapTerms, productCount: result.products.length, prices: result.products.flatMap((product) => product.priceSignals.map((price) => price.raw)).slice(0, 6) });
  for (const result of results) {
    blocks.push({ type: "coverage", id: `coverage-${result.domain}`, domain: result.domain, role: result.role, pagesRequested: result.coverage.pagesRequested, pagesFetched: result.coverage.pagesFetched, maxPages: result.coverage.maxPages, robotsChecked: result.coverage.robotsChecked, priceEnrichmentPagesRequested: result.priceEnrichment?.pagesRequested || 0, priceEnrichmentPagesFetched: result.priceEnrichment?.pagesFetched || 0, priceEnrichmentMaxPagesPerReport: MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES, gaps: result.gaps });
    if (result.homepage) {
      blocks.push({ type: "company", id: `company-${result.domain}`, domain: result.domain, role: result.role, title: result.homepage.title, description: result.homepage.description, pages: result.pages.map((page) => ({ url: page.sourceUrl, path: page.path, title: page.title, claimIds: page.claims.map((claim) => claim.id) })) });
      blocks.push({ type: "product-catalog", id: `product-catalog-${result.domain}`, domain: result.domain, role: result.role, products: result.products, scannedPages: result.productCoverage.scannedPages, priceEnrichmentPagesFetched: result.priceEnrichment?.pagesFetched || 0, catalogProductsDiscovered: result.productCoverage.catalogProductsDiscovered, thirdPartyReferenced: result.productCoverage.thirdPartyReferenced, coverageNote: `Discovered ${result.productCoverage.catalogProductsDiscovered} product URLs from public sitemaps, fetched ${result.productCoverage.scannedPages} representative public page${result.productCoverage.scannedPages === 1 ? "" : "s"}, and fetched ${result.priceEnrichment?.pagesFetched || 0} matched product page${result.priceEnrichment?.pagesFetched === 1 ? "" : "s"} for bounded price enrichment.` });
      for (const candidate of result.candidates) blocks.push({ type: "candidate", id: `candidate-${result.domain}-${candidate.domain}`, domain: candidate.domain, reason: candidate.reason, sourceUrl: candidate.sourceUrl, claimIds: candidate.claimIds });
      for (const claim of [...result.pages, ...(result.enrichmentPages || [])].flatMap((page) => page.claims)) blocks.push({ type: "evidence", id: `evidence-${claim.id}`, claimId: claim.id, claimType: claim.claimType, text: claim.text, sourceUrl: claim.sourceUrl, observedAt: claim.observedAt, confidence: claim.confidence });
    }
    for (const gap of result.gaps) blocks.push({ type: "gap", id: `gap-${result.domain}-${blocks.length}`, domain: result.domain, url: gap.url, reason: gap.reason, observedAt: gap.observedAt });
  }
  const primary = results.find((result) => result.domain === primaryDomain);
  if (primary?.products.length) {
    const comparison = buildProductComparison(primaryDomain, results.map((result) => ({ domain: result.domain, products: result.products })), comparisonSourceUrls(results, primaryDomain));
    if (comparison.comparisonDomains.length) blocks.push({ type: "product-comparison", id: "product-comparison", ...comparison });
    for (const unmatched of comparison.unmatched) if (unmatched.products.length) blocks.push({ type: "product-unmatched", id: `product-unmatched-${unmatched.domain}`, domain: unmatched.domain, products: unmatched.products, reason: "Observed competitor products that were not assigned to a primary-product row." });
  } else if (primary?.homepage) {
    blocks.push({ type: "gap", id: "product-coverage-gap", domain: primary.domain, url: primary.homepage.sourceUrl, reason: `No attributable public product or service record was observed across ${primary.productCoverage.scannedPages} scanned page${primary.productCoverage.scannedPages === 1 ? "" : "s"}. No product comparison was generated.`, observedAt: new Date().toISOString() });
  }
  if (discovered.length === 0) blocks.push({ type: "gap", id: "candidate-gap", domain: primary?.domain || primaryDomain, url: primary?.homepage?.sourceUrl || "", reason: discovery?.gap || "No searched candidate passed independent public-site verification.", observedAt: new Date().toISOString() });
  if (ads) blocks.push({ type: "ad-intelligence", id: "ad-intelligence", primaryDomain, ...ads });
  for (const candidate of investigated) {
    if (!candidate || results.some((result) => result.domain === candidate.domain)) continue;
    blocks.push({ type: "gap", id: `investigation-gap-${candidate.domain}`, domain: candidate.domain, url: candidate.homepage?.sourceUrl || candidate.discovery?.sourceUrl || "", reason: candidate.homepage ? (!candidate.discovery?.regionCompatibility ? "Investigated but not confirmed: first-party evidence placed this company in a different market region." : !candidate.discovery?.categoryAlignment ? "Investigated but not confirmed: the company's own website did not establish the same core market category." : `Investigated but not confirmed: entity verification score ${candidate.discovery?.verificationScore || 0}/100 did not meet the inclusion threshold.`) : `Investigated but not confirmed: ${candidate.gaps[0]?.reason || "the public site could not be verified."}`, observedAt: candidate.fetchedAt });
  }
  return { version: "1", generatedAt: new Date().toISOString(), blocks };
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { primary?: unknown; domains?: unknown };
    const rawDomains = Array.isArray(payload.domains) ? payload.domains.filter((domain): domain is string => typeof domain === "string" && Boolean(domain.trim())).map((domain) => canonicalDomain(domain)) : [];
    const domains = [...new Set(rawDomains)].slice(0, MAX_DOMAINS);
    if (!domains.length) return Response.json({ ok: false, live: false, error: "Enter at least one public domain to crawl." }, { status: 400 });
    const primaryDomain = canonicalDomain(typeof payload.primary === "string" ? payload.primary : domains[0]);
    const submittedResults = await Promise.all(domains.map((domain) => crawlDomain(domain, domain === primaryDomain ? "primary" : "submitted-comparison")));
    const primary = submittedResults.find((result) => result.domain === primaryDomain);
    if (!primary?.homepage) {
      const reason = primary?.gaps[0]?.reason;
      const error = reason ? `The primary domain could not be crawled: ${reason}` : "The primary domain could not be crawled.";
      return Response.json({ ok: false, live: false, error, results: submittedResults, document: buildDocument(submittedResults, primaryDomain) }, { status: 400 });
    }
    let discovery: DiscoveryResult;
    try {
      discovery = await discoverCompetitors({ domain: primary.domain, title: primary.homepage.title, description: primary.homepage.description, region: primary.homepage.region, language: primary.homepage.language, products: primary.products, pages: primary.pages.map((page) => ({ title: page.title, description: page.description, path: page.path, sourceUrl: page.sourceUrl, headings: page.headings })) });
    } catch (error) {
      const gap = error instanceof Error ? error.message : "Web competitor discovery failed.";
      discovery = { available: false, provider: "unavailable", model: process.env.MARKET_SIGNAL_DISCOVERY_MODEL || "gpt-5.4-mini", category: "", region: primary.homepage.region, businessType: "unknown", queries: [], candidates: [], gaps: [gap], gap };
    }
    const discoveredResults = await Promise.all(discovery.candidates.filter((candidate) => !domains.includes(candidate.domain)).map(async (candidate) => {
      try { return verifyDiscoveredCompetitor(primary, await crawlDomain(candidate.domain, "discovered-competitor", candidate.matchedProductUrls?.length ? candidate.matchedProductUrls : [candidate.matchedProductUrl || candidate.websiteUrl]), candidate); } catch { return null; }
    }));
    const confirmed: DomainCrawl[] = discoveredResults.filter((result): result is NonNullable<typeof result> => Boolean(result?.homepage && result.discovery?.accepted)).sort((left, right) => compareVerifiedCompetitors(left.discovery!, right.discovery!));
    const results = await enrichMatchedProductPages([...submittedResults, ...confirmed], primaryDomain);
    const enrichedPrimary = results.find((result) => result.domain === primaryDomain) || primary;
    const enrichedConfirmed = results.filter((result) => result.role === "discovered-competitor");
    const adTargets = [enrichedPrimary, ...enrichedConfirmed].filter((result, index, all) => all.findIndex((candidate) => candidate.domain === result.domain) === index);
    const adRequest = {
      region: discovery.region || primary.homepage.region,
      companies: adTargets.map((result) => ({
        domain: result.domain,
        brand: result.discovery?.companyName || result.homepage?.title.split(/\s[–—-]\s|\|/)[0].trim() || result.domain,
        facebookUrl: attributableFacebookUrl(result.pages.flatMap((page) => page.socialLinks)),
      })),
    };
    return Response.json({ ok: true, live: true, primaryDomain, results, discovery, adRequest, document: buildDocument(results, primaryDomain, discovery, discoveredResults), crawl: { maxPagesPerDomain: MAX_HTML_PAGES, maxPagesPerDiscoveredCompetitor: MAX_DISCOVERED_HTML_PAGES, maxMatchedProductEnrichmentPages: MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES, robotsAware: true, generatedAt: new Date().toISOString() } });
  } catch (error) {
    return Response.json({ ok: false, live: false, error: error instanceof Error ? error.message : "Unable to crawl the submitted domains." }, { status: 400 });
  }
}
