import { canonicalDomain, normalizeDomain } from "../../lib/domain";
import { buildProductComparison, extractProductsFromHtml, selectPreferredProducts, type ProductRecord } from "../../lib/product-intelligence";
import { parseRobots } from "../../lib/robots";

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
  role: "primary" | "submitted-comparison";
  homepage: CrawlPage | null;
  pages: CrawlPage[];
  products: ProductRecord[];
  candidates: Candidate[];
  gaps: Gap[];
  coverage: { pagesRequested: number; pagesFetched: number; maxPages: number; robotsChecked: boolean };
  productCoverage: { scannedPages: number; thirdPartyReferenced: number };
  fetchedAt: string;
};

type ReportBlock = Record<string, unknown> & { type: string; id: string };

const MAX_DOMAINS = 4;
const MAX_HTML_PAGES = 5;
const MAX_DOCUMENT_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 6_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";
const PRIORITY_PATHS = ["/pricing", "/plans", "/products", "/features", "/compare", "/integrations", "/about", "/customers", "/blog"];
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com", "x.com", "twitter.com"];

function productPathPriority(path: string) {
  if (/\/(?:products?|shop|store|collections?|catalog|solutions?|services?|platform|features?)(?:\/|$)/i.test(path)) return 0;
  if (/\/(?:pricing|plans?)(?:\/|$)/i.test(path)) return 10;
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

function inferRegion(text: string, language: string) {
  if (/\b(United States|USA|California|New York|USD)\b/i.test(text)) return "United States (inferred)";
  if (/\b(United Kingdom|UK|London|GBP)\b/i.test(text)) return "United Kingdom (inferred)";
  if (/\b(Europe|EUR|€)\b/i.test(text)) return "Europe (inferred)";
  if (language.startsWith("ar")) return "Arabic-speaking market (inferred)";
  return "Not enough public signal";
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function fetchText(url: string, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
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

function parseSitemap(text: string, domain: string) {
  return unique([...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)].flatMap((match) => {
    try {
      const url = new URL(match[1]);
      return canonicalDomain(url.hostname) === domain ? [url.pathname] : [];
    } catch {
      return [];
    }
  }), 30);
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
  const priceSignals = prices(readable);
  const productExtraction = extractProductsFromHtml({ document, sourceUrl, domain, observedAt, pageTitle: title, pageDescription: description, headings, pagePriceSignals: priceSignals });
  const claims: Claim[] = [
    makeClaim(domain, `${url.pathname}-title`, `${domain} presents itself as “${title}”.`, sourceUrl, observedAt),
    ...(description ? [makeClaim(domain, `${url.pathname}-description`, `${domain} describes itself as “${description}”.`, sourceUrl, observedAt)] : []),
    ...(priceSignals.length ? [makeClaim(domain, `${url.pathname}-prices`, `${domain} exposes these public price patterns: ${priceSignals.join(", ")}.`, sourceUrl, observedAt)] : []),
    ...(headings.length ? [makeClaim(domain, `${url.pathname}-headings`, `${domain} uses these public headings: ${headings.slice(0, 5).join("; ")}.`, sourceUrl, observedAt)] : []),
    makeClaim(domain, `${url.pathname}-language`, `${domain} exposes language ${language || "unknown"} and region signal ${inferRegion(textContent, language)}.`, sourceUrl, observedAt, "Inferred", language === "unknown" ? "Low" : "Medium"),
    makeClaim(domain, `${url.pathname}-social`, `${domain} links to ${socialLinks(document, url).length} public social profiles from this page.`, sourceUrl, observedAt),
    ...productExtraction.products.map((product) => ({ id: product.claimIds[0], claimType: "Observed" as const, text: `${domain} exposes product or service “${product.name}” via ${product.extraction === "json-ld" ? "structured JSON-LD" : "a product-like public page"}.`, sourceUrl: product.sourceUrl, observedAt: product.observedAt, confidence: product.confidence })),
  ];
  return { ok: true, live: true, domain, url: sourceUrl, path: url.pathname, sourceUrl, fetchedAt, title, description: description || "No meta description was exposed on the public page.", language: language || "unknown", region: inferRegion(textContent, language), headings, prices: priceSignals, socialLinks: socialLinks(document, url), internalLinks, wordCount: readable ? readable.split(/\s+/).length : 0, truncated, contentHash: await hash(document), claims, products: productExtraction.products, productGaps: productExtraction.gaps, thirdPartyProductCount: productExtraction.thirdPartyReferenced.length };
}

async function crawlDomain(input: string, role: DomainCrawl["role"]): Promise<DomainCrawl> {
  const startedAt = new Date().toISOString();
  let base: URL;
  try {
    base = normalizeDomain(input);
  } catch (error) {
    const domain = canonicalDomain(input);
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps: [{ url: input, reason: error instanceof Error ? error.message : "invalid or private domain.", observedAt: startedAt }], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: MAX_HTML_PAGES, robotsChecked: false }, productCoverage: { scannedPages: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const domain = base.hostname;
  const gaps: Gap[] = [];
  const robotsResult = await fetchText(new URL("/robots.txt", base).toString(), "text/plain");
  const robots = robotsResult.ok ? parseRobots(robotsResult.text) : { sitemaps: [], hasRules: false, allows: () => true };
  if (!robotsResult.ok) gaps.push({ url: new URL("/robots.txt", base).toString(), reason: "robots.txt could not be read; expansion is limited to the homepage.", observedAt: startedAt });
  if (robotsResult.ok && !robots.allows("/")) {
    gaps.push({ url: base.toString(), reason: "robots.txt disallows the homepage for this scanner.", observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: MAX_HTML_PAGES, robotsChecked: true }, productCoverage: { scannedPages: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const homepageResult = await fetchText(base.toString(), "text/html,application/xhtml+xml");
  if (!homepageResult.ok || !/text\/html|application\/xhtml\+xml/i.test(homepageResult.contentType)) {
    gaps.push({ url: base.toString(), reason: homepageResult.error || `homepage returned HTTP ${homepageResult.status}.`, observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: MAX_HTML_PAGES, robotsChecked: robotsResult.ok }, productCoverage: { scannedPages: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const homepageHost = new URL(homepageResult.url).hostname.toLowerCase().replace(/^www\./, "");
  if (homepageHost !== domain.replace(/^www\./, "")) {
    gaps.push({ url: base.toString(), reason: "homepage redirected off the submitted domain.", observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: MAX_HTML_PAGES, robotsChecked: robotsResult.ok }, productCoverage: { scannedPages: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const homepage = await parsePage(homepageResult.text, homepageResult.url, startedAt, domain, homepageResult.truncated);
  const discovered = extractLinks(homepageResult.text, new URL(homepageResult.url), domain);
  let sitemapPaths: string[] = [];
  const sitemapUrl = robots.sitemaps[0] || new URL("/sitemap.xml", base).toString();
  if (robotsResult.ok) {
    const sitemapResult = await fetchText(sitemapUrl, "application/xml,text/xml,text/plain");
    if (sitemapResult.ok) sitemapPaths = parseSitemap(sitemapResult.text, domain);
  }
  const candidates = discovered.candidates.slice(0, 12).map((candidate, index) => ({ domain: candidate.domain, reason: `A public page linked to this domain with “${candidate.text.slice(0, 120)}”. This is a possible match, not a confirmed competitor.`, sourceUrl: candidate.sourceUrl, claimIds: [`${domain}-candidate-${index}`] }));
  candidates.forEach((candidate, index) => homepage.claims.push(makeClaim(domain, `candidate-${index}`, `${domain} linked to possible market candidate ${candidate.domain}; anchor context supports investigation only.`, candidate.sourceUrl, startedAt, "Inferred", "Low")));
  const observedPaths = robotsResult.ok ? unique([...discovered.paths, ...sitemapPaths], 60) : [];
  const expandablePaths = observedPaths.sort((left, right) => {
    return productPathPriority(left) - productPathPriority(right) || left.localeCompare(right);
  }).slice(0, MAX_HTML_PAGES - 1);
  const paths = expandablePaths.filter((path) => robots.allows(path));
  for (const path of expandablePaths) if (!robots.allows(path)) gaps.push({ url: new URL(path, base).toString(), reason: "robots.txt disallows this crawl path.", observedAt: startedAt });
  const fetchedPages = await Promise.all(paths.map(async (path) => {
    const url = new URL(path, base).toString();
    const result = await fetchText(url, "text/html,application/xhtml+xml");
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
  for (const page of pages) for (const reason of page.productGaps) gaps.push({ url: page.sourceUrl, reason, observedAt: page.fetchedAt });
  const products = selectPreferredProducts(pages.flatMap((page) => page.products));
  return { domain, role, homepage, pages, products, candidates, gaps, coverage: { pagesRequested: 1 + paths.length, pagesFetched: pages.length, maxPages: MAX_HTML_PAGES, robotsChecked: robotsResult.ok }, productCoverage: { scannedPages: pages.length, thirdPartyReferenced: pages.reduce((sum, page) => sum + page.thirdPartyProductCount, 0) }, fetchedAt: startedAt };
}

function buildDocument(results: DomainCrawl[], primaryDomain: string): { version: "1"; generatedAt: string; blocks: ReportBlock[] } {
  const blocks: ReportBlock[] = [{ type: "summary", id: "scan-summary", title: "Evidence-first market scan", body: `Collected bounded public-page evidence for ${results.length} submitted domain${results.length === 1 ? "" : "s"}. Possible candidates are shown only when a page contains a public link that justifies investigation.` }];
  for (const result of results) {
    blocks.push({ type: "coverage", id: `coverage-${result.domain}`, domain: result.domain, role: result.role, pagesRequested: result.coverage.pagesRequested, pagesFetched: result.coverage.pagesFetched, maxPages: result.coverage.maxPages, robotsChecked: result.coverage.robotsChecked, gaps: result.gaps });
    if (result.homepage) {
      blocks.push({ type: "company", id: `company-${result.domain}`, domain: result.domain, role: result.role, title: result.homepage.title, description: result.homepage.description, pages: result.pages.map((page) => ({ url: page.sourceUrl, path: page.path, title: page.title, claimIds: page.claims.map((claim) => claim.id) })) });
      blocks.push({ type: "product-catalog", id: `product-catalog-${result.domain}`, domain: result.domain, role: result.role, products: result.products, scannedPages: result.productCoverage.scannedPages, thirdPartyReferenced: result.productCoverage.thirdPartyReferenced, coverageNote: `Observed from ${result.productCoverage.scannedPages} scanned public page${result.productCoverage.scannedPages === 1 ? "" : "s"}; this is not a complete catalog guarantee.` });
      for (const candidate of result.candidates) blocks.push({ type: "candidate", id: `candidate-${result.domain}-${candidate.domain}`, domain: candidate.domain, reason: candidate.reason, sourceUrl: candidate.sourceUrl, claimIds: candidate.claimIds });
      for (const claim of result.pages.flatMap((page) => page.claims)) blocks.push({ type: "evidence", id: `evidence-${claim.id}`, claimId: claim.id, claimType: claim.claimType, text: claim.text, sourceUrl: claim.sourceUrl, observedAt: claim.observedAt, confidence: claim.confidence });
    }
    for (const gap of result.gaps) blocks.push({ type: "gap", id: `gap-${result.domain}-${blocks.length}`, domain: result.domain, url: gap.url, reason: gap.reason, observedAt: gap.observedAt });
  }
  const primary = results.find((result) => result.domain === primaryDomain);
  if (primary?.products.length) {
    const comparison = buildProductComparison(primaryDomain, results.map((result) => ({ domain: result.domain, products: result.products })));
    if (comparison.comparisonDomains.length) blocks.push({ type: "product-comparison", id: "product-comparison", ...comparison });
    for (const unmatched of comparison.unmatched) if (unmatched.products.length) blocks.push({ type: "product-unmatched", id: `product-unmatched-${unmatched.domain}`, domain: unmatched.domain, products: unmatched.products, reason: "Observed competitor products that were not assigned to a primary-product row." });
  } else if (primary?.homepage) {
    blocks.push({ type: "gap", id: "product-coverage-gap", domain: primary.domain, url: primary.homepage.sourceUrl, reason: `No attributable public product or service record was observed across ${primary.productCoverage.scannedPages} scanned page${primary.productCoverage.scannedPages === 1 ? "" : "s"}. No product comparison was generated.`, observedAt: new Date().toISOString() });
  }
  if (primary && primary.candidates.length === 0) blocks.push({ type: "gap", id: "candidate-gap", domain: primary.domain, url: primary.homepage?.sourceUrl || "", reason: "No evidence-backed possible competitor was discovered from the scanned public pages. Add comparison domains or connect search/ad-library adapters before claiming competitor discovery.", observedAt: new Date().toISOString() });
  return { version: "1", generatedAt: new Date().toISOString(), blocks };
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { primary?: unknown; domains?: unknown };
    const rawDomains = Array.isArray(payload.domains) ? payload.domains.filter((domain): domain is string => typeof domain === "string" && domain.trim()).map((domain) => canonicalDomain(domain)) : [];
    const domains = [...new Set(rawDomains)].slice(0, MAX_DOMAINS);
    if (!domains.length) return Response.json({ ok: false, live: false, error: "Enter at least one public domain to crawl." }, { status: 400 });
    const primaryDomain = canonicalDomain(typeof payload.primary === "string" ? payload.primary : domains[0]);
    const results = await Promise.all(domains.map((domain) => crawlDomain(domain, domain === primaryDomain ? "primary" : "submitted-comparison")));
    const primary = results.find((result) => result.domain === primaryDomain);
    if (!primary?.homepage) {
      const reason = primary?.gaps[0]?.reason;
      const error = reason ? `The primary domain could not be crawled: ${reason}` : "The primary domain could not be crawled.";
      return Response.json({ ok: false, live: false, error, results, document: buildDocument(results, primaryDomain) }, { status: 400 });
    }
    return Response.json({ ok: true, live: true, primaryDomain, results, document: buildDocument(results, primaryDomain), crawl: { maxPagesPerDomain: MAX_HTML_PAGES, robotsAware: true, generatedAt: new Date().toISOString() } });
  } catch (error) {
    return Response.json({ ok: false, live: false, error: error instanceof Error ? error.message : "Unable to crawl the submitted domains." }, { status: 400 });
  }
}
