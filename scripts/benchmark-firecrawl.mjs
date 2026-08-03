#!/usr/bin/env node

const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL || "http://localhost:3002";
const FIRECRAWL_REVISION = process.env.FIRECRAWL_REVISION || null;
const MARKET_SIGNAL_ENRICH_URL = process.env.MARKET_SIGNAL_ENRICH_URL || "https://signal.blyzr.com/api/enrich-products";
const ORIGIN = "https://www.babanuj.com";
const SAMPLE_SIZE = 10;
const KNOWN_PRODUCT = `${ORIGIN}/product/zaitoune-maamoul-date-250g`;
const COLLECTION = `${ORIGIN}/collections/cookies`;

function elapsed(started) {
  return Math.round(performance.now() - started);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function urlsFromSitemap(xml) {
  return [...xml.matchAll(/<loc>([^<]+<\/loc>)/gi)]
    .map((match) => match[1].replace(/<\/loc>$/i, "").replace(/&amp;/g, "&"));
}

function productUrlsFromSitemap(xml) {
  return urlsFromSitemap(xml).filter((url) => /\/product\//i.test(url));
}

function robotsAllows(body, targetUrl, userAgent) {
  const groups = [];
  let agents = [];
  let rules = [];
  const finish = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === "user-agent") {
      if (rules.length) finish();
      agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && agents.length && value) {
      rules.push({ allow: key === "allow", path: value });
    }
  }
  finish();
  const normalizedAgent = userAgent.toLowerCase();
  const candidates = groups.filter((group) => group.agents.some((agent) => agent === "*" || normalizedAgent.includes(agent)));
  const specificity = Math.max(0, ...candidates.flatMap((group) => group.agents.filter((agent) => agent === "*" || normalizedAgent.includes(agent)).map((agent) => agent === "*" ? 0 : agent.length)));
  const selectedRules = candidates
    .filter((group) => group.agents.some((agent) => (agent === "*" ? 0 : agent.length) === specificity && (agent === "*" || normalizedAgent.includes(agent))))
    .flatMap((group) => group.rules);
  const path = `${new URL(targetUrl).pathname}${new URL(targetUrl).search}`;
  const ruleMatches = (pattern) => {
    const anchored = pattern.endsWith("$");
    const body = (anchored ? pattern.slice(0, -1) : pattern)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
  };
  const matching = selectedRules.filter((rule) => ruleMatches(rule.path)).sort((left, right) => right.path.length - left.path.length || Number(right.allow) - Number(left.allow));
  return matching[0]?.allow ?? true;
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleWithoutSite(value) {
  return String(value || "").replace(/\s*\|\s*Babanuj\s*$/i, "").trim();
}

function productLinkCount(html, baseUrl) {
  const links = [...html.matchAll(/\bhref=["']([^"']+)["']/gi)].flatMap((match) => {
    try {
      return [new URL(match[1].replace(/&amp;/g, "&"), baseUrl).toString()];
    } catch {
      return [];
    }
  });
  return new Set(links.filter((url) => /\/product\//i.test(url))).size;
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1]?.replace(/&amp;/g, "&") || "";
}

function visibleProduct(html, metadata) {
  const title = titleWithoutSite(metadata?.title);
  const imageCandidates = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => ({
    alt: attribute(match[0], "alt"),
    src: attribute(match[0], "src"),
  }));
  const image = imageCandidates.find((candidate) =>
    /^https:\/\/cdn\.shopify\.com\//i.test(candidate.src)
      && normalized(candidate.alt)
      && (normalized(title).includes(normalized(candidate.alt)) || normalized(candidate.alt).includes(normalized(title))),
  ) || imageCandidates.find((candidate) => /^https:\/\/cdn\.shopify\.com\//i.test(candidate.src));
  const price = html.match(/<div[^>]*class=["'][^"']*display-heavy\s+num[^"']*["'][^>]*>\s*(?:\$|USD\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)\s*<\/div>/i)?.[1];
  return {
    name: title || null,
    imageUrl: image?.src || null,
    price: price ? Number(price) : null,
    currency: price ? "USD" : null,
  };
}

async function jsonRequest(url, body, timeoutMs = 120_000) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false || payload.ok === false) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

async function boundedMap() {
  const started = performance.now();
  const payload = await jsonRequest(`${FIRECRAWL_BASE_URL}/v2/map`, { url: ORIGIN, limit: 150 });
  const links = Array.isArray(payload.links) ? payload.links : [];
  const productUrls = links.map((entry) => entry?.url || "").filter((url) => /\/product\//i.test(url));
  return {
    elapsedMs: elapsed(started),
    links: links.length,
    productLinks: productUrls.length,
    productUrls,
  };
}

async function directSurface(url) {
  const started = performance.now();
  const response = await fetch(url, { headers: { "user-agent": "MarketSignalFirecrawlBenchmark/0.1" } });
  const html = await response.text();
  return {
    elapsedMs: elapsed(started),
    status: response.status,
    finalUrl: response.url,
    documentBytes: Buffer.byteLength(html),
    productLinks: productLinkCount(html, response.url),
  };
}

async function firecrawlSurface(url) {
  const started = performance.now();
  const payload = await jsonRequest(`${FIRECRAWL_BASE_URL}/v2/scrape`, { url, formats: ["html"], onlyMainContent: false });
  const document = payload.data || {};
  const html = String(document.html || "");
  return {
    elapsedMs: elapsed(started),
    status: document.metadata?.statusCode || null,
    finalUrl: document.metadata?.url || document.metadata?.sourceURL || null,
    documentBytes: Buffer.byteLength(html),
    productLinks: productLinkCount(html, document.metadata?.sourceURL || url),
  };
}

async function firecrawlProduct(url) {
  const started = performance.now();
  try {
    const payload = await jsonRequest(`${FIRECRAWL_BASE_URL}/v2/scrape`, {
      url,
      formats: ["html"],
      onlyMainContent: false,
    });
    const document = payload.data || {};
  return {
      url,
      elapsedMs: elapsed(started),
      status: document.metadata?.statusCode || null,
      sourceUrl: document.metadata?.url || document.metadata?.sourceURL || null,
      ...visibleProduct(String(document.html || ""), document.metadata),
      error: null,
    };
  } catch (error) {
    return { url, elapsedMs: elapsed(started), status: null, sourceUrl: null, name: null, imageUrl: null, price: null, currency: null, error: error.message };
  }
}

async function firecrawlProducts(urls) {
  const results = [];
  for (let cursor = 0; cursor < urls.length; cursor += 2) {
    results.push(...await Promise.all(urls.slice(cursor, cursor + 2).map(firecrawlProduct)));
  }
  return results;
}

function expectedName(url) {
  return new URL(url).pathname.split("/product/")[1].replace(/-/g, " ");
}

async function marketSignalProducts(urls) {
  const targets = urls.map((sourceUrl, index) => ({
    domain: "babanuj.com",
    sourceUrl,
    productId: `firecrawl-benchmark-${index}`,
    expectedName: expectedName(sourceUrl),
    expectedType: "Product",
    role: "primary",
  }));
  const started = performance.now();
  const payload = await jsonRequest(MARKET_SIGNAL_ENRICH_URL, { targets });
  return { elapsedMs: elapsed(started), payload };
}

const robotsResponse = await fetch(`${ORIGIN}/robots.txt`, { headers: { "user-agent": "MarketSignalFirecrawlBenchmark/0.1" } });
if (!robotsResponse.ok) throw new Error(`robots.txt returned ${robotsResponse.status}`);
const robots = await robotsResponse.text();

const sitemapStarted = performance.now();
const sitemapResponse = await fetch(`${ORIGIN}/sitemap.xml`, { headers: { "user-agent": "MarketSignalFirecrawlBenchmark/0.1" } });
if (!sitemapResponse.ok) throw new Error(`sitemap.xml returned ${sitemapResponse.status}`);
const sitemapXml = await sitemapResponse.text();
const sitemapUrls = urlsFromSitemap(sitemapXml);
const sitemapProducts = productUrlsFromSitemap(sitemapXml);
const sitemapElapsedMs = elapsed(sitemapStarted);
const sample = [KNOWN_PRODUCT, ...sitemapProducts.filter((url) => url !== KNOWN_PRODUCT)].slice(0, SAMPLE_SIZE);
for (const url of [ORIGIN, COLLECTION, ...sample]) {
  if (!robotsAllows(robots, url, "MarketSignalFirecrawlBenchmark/0.1")) throw new Error(`robots.txt disallows benchmark route: ${url}`);
}

const map = await boundedMap();
const sitemapProductSet = new Set(sitemapProducts);
const firecrawlProductSet = new Set(map.productUrls);
const onlyInFirecrawlProducts = [...firecrawlProductSet].filter((url) => !sitemapProductSet.has(url)).sort();
const onlyInSitemapProducts = [...sitemapProductSet].filter((url) => !firecrawlProductSet.has(url)).sort();
const surfaces = {};
for (const [name, url] of [["homepage", ORIGIN], ["collection", COLLECTION]]) {
  surfaces[name] = { url, direct: await directSurface(url), firecrawl: await firecrawlSurface(url) };
}
const firecrawl = await firecrawlProducts(sample);
const marketSignal = await marketSignalProducts(sample);
const accepted = new Map((marketSignal.payload.products || []).map((product) => [product.sourceUrl, product]));
const gaps = new Map((marketSignal.payload.coverage?.gaps || []).map((gap) => [gap.url, gap]));

const pairs = firecrawl.map((firecrawlResult) => {
  const marketProduct = accepted.get(firecrawlResult.url);
  const marketPrice = marketProduct?.priceSignals?.[0] || null;
  return {
    url: firecrawlResult.url,
    firecrawl: {
      status: firecrawlResult.status,
      sourceUrl: firecrawlResult.sourceUrl,
      redirected: firecrawlResult.sourceUrl ? new URL(firecrawlResult.sourceUrl).toString() !== new URL(firecrawlResult.url).toString() : null,
      elapsedMs: firecrawlResult.elapsedMs,
      name: firecrawlResult.name,
      hasImage: Boolean(firecrawlResult.imageUrl),
      price: firecrawlResult.price,
      currency: firecrawlResult.currency,
      error: firecrawlResult.error,
    },
    marketSignal: marketProduct ? {
      accepted: true,
      name: marketProduct.name,
      hasImage: Boolean(marketProduct.imageUrl),
      price: marketPrice?.amount ?? null,
      currency: marketPrice?.currency ?? null,
      gapCode: null,
    } : {
      accepted: false,
      name: null,
      hasImage: false,
      price: null,
      currency: null,
      gapCode: gaps.get(firecrawlResult.url)?.code || "unknown",
    },
  };
});

const validPairs = pairs.filter((pair) => pair.marketSignal.accepted);
const sameValidPrices = validPairs.filter((pair) => pair.firecrawl.price === pair.marketSignal.price && pair.firecrawl.currency === pair.marketSignal.currency).length;
const result = {
  observedAt: new Date().toISOString(),
  scope: {
    domain: "babanuj.com",
    sampleSize: sample.length,
    firecrawlRevision: FIRECRAWL_REVISION,
    firecrawlBaseUrl: FIRECRAWL_BASE_URL,
    marketSignalEnrichUrl: MARKET_SIGNAL_ENRICH_URL,
  },
  discovery: {
    directSitemap: { elapsedMs: sitemapElapsedMs, links: sitemapUrls.length, productLinks: sitemapProducts.length },
    firecrawlMap: { elapsedMs: map.elapsedMs, links: map.links, productLinks: map.productLinks },
    productSetDifference: { onlyInFirecrawlProducts, onlyInSitemapProducts },
    surfaces,
  },
  summary: {
    firecrawl: {
      pagesRequested: firecrawl.length,
      pagesFetched: firecrawl.filter((item) => item.status === 200).length,
      pagesWithImage: firecrawl.filter((item) => item.imageUrl).length,
      pagesWithVisiblePrice: firecrawl.filter((item) => item.price !== null).length,
      medianScrapeMs: median(firecrawl.map((item) => item.elapsedMs)),
    },
    marketSignal: {
      requestElapsedMs: marketSignal.elapsedMs,
      pagesRequested: marketSignal.payload.coverage?.pagesRequested || 0,
      pagesAccepted: marketSignal.payload.coverage?.pagesFetched || 0,
      acceptedWithImage: (marketSignal.payload.products || []).filter((item) => item.imageUrl).length,
      acceptedWithPrice: (marketSignal.payload.products || []).filter((item) => item.priceSignals?.length).length,
      identityGaps: (marketSignal.payload.coverage?.gaps || []).filter((gap) => gap.code === "identity_mismatch").length,
    },
    acceptedPairsWithSamePrice: `${sameValidPrices}/${validPairs.length}`,
  },
  pairs,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
