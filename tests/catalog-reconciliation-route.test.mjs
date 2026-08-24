import assert from "node:assert/strict";
import test from "node:test";

import { buildDocument, crawlResponseMetadata, enrichPrimaryProductPrices, primaryProductPricePageBudget } from "../app/api/crawl/route.ts";
import { resetSharedRobotsPolicyResolverForTests } from "../app/lib/robots-policy.ts";

function product(id, sourceUrl) {
  return {
    id,
    domain: "shop.test",
    name: `${id} Maamoul 500g`,
    normalizedName: `${id} maamoul 500g`,
    description: "public product",
    category: "sweets",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl,
    imageUrl: "",
    observedAt: "2026-08-03T00:00:00.000Z",
    claimIds: [`${id}-stale`],
  };
}

function crawl(products) {
  return {
    domain: "shop.test",
    role: "primary",
    homepage: null,
    pages: [],
    products,
    candidates: [],
    gaps: [],
    coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 5, robotsChecked: true },
    productCoverage: { scannedPages: 1, catalogProductsDiscovered: products.length, thirdPartyReferenced: 0 },
    fetchedAt: "2026-08-03T00:00:00.000Z",
  };
}

test("primary price enrichment stays local and preserves blocked pages as gaps", async () => {
  const originalFetch = globalThis.fetch;
  resetSharedRobotsPolicyResolverForTests();
  const live = product("Pistachio", "https://shop.test/product/pistachio");
  const blocked = product("Blocked", "https://shop.test/product/blocked");
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/product/blocked") {
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: live.name,
      image: "https://cdn.shop.test/pistachio.jpg",
      offers: { "@type": "Offer", price: "12.50", priceCurrency: "USD" },
    })}</script></head><body><h1>${live.name}</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichPrimaryProductPrices(crawl([live, blocked]), { fetchImpl: globalThis.fetch });
    assert.equal(result.primaryPriceEnrichment.pagesRequested, 2);
    assert.equal(result.primaryPriceEnrichment.pagesFetched, 1);
    assert.equal(result.primaryPriceEnrichment.maxPages, 16);
    assert.equal(buildDocument([result], result.domain).blocks.find((block) => block.type === "coverage")?.primaryPriceEnrichmentMaxPagesPerReport, 16);
    assert.equal(crawlResponseMetadata(false).maxPrimaryProductPricePages, 16);
    assert.equal("edgeRecovery" in result.primaryPriceEnrichment, false);
    assert.equal(result.products.some((item) => item.id === live.id && item.priceSignals[0]?.amount === 12.5), true);
    assert.equal(result.gaps.some((gap) => gap.url === blocked.sourceUrl && /HTTP 403/.test(gap.reason)), true);
  } finally {
    globalThis.fetch = originalFetch;
    resetSharedRobotsPolicyResolverForTests();
  }
});

test("direct search expands scripted primary price supply to the storefront request ceiling", async () => {
  const originalFetch = globalThis.fetch;
  resetSharedRobotsPolicyResolverForTests();
  const products = Array.from({ length: 70 }, (_, index) => product(`Product-${String(index).padStart(2, "0")}`, `https://shop.test/product/item-${index}`));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    const expected = products.find((item) => new URL(item.sourceUrl).pathname === url.pathname);
    assert.ok(expected);
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: expected.name,
      offers: { "@type": "Offer", price: "12.50", priceCurrency: "USD" },
    })}</script></head><body><h1>${expected.name}</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    assert.equal(primaryProductPricePageBudget(false), 16);
    assert.equal(primaryProductPricePageBudget(true), 64);
    const result = await enrichPrimaryProductPrices(crawl(products), { fetchImpl: globalThis.fetch }, primaryProductPricePageBudget(true));
    assert.equal(result.primaryPriceEnrichment.pagesRequested, 64);
    assert.equal(result.primaryPriceEnrichment.pagesFetched, 64);
    assert.equal(result.primaryPriceEnrichment.maxPages, 64);
    assert.equal(buildDocument([result], result.domain).blocks.find((block) => block.type === "coverage")?.primaryPriceEnrichmentMaxPagesPerReport, 64);
    assert.equal(crawlResponseMetadata(true).maxPrimaryProductPricePages, 64);
    assert.equal(result.products.filter((item) => item.priceSignals[0]?.amount === 12.5).length, 64);
    assert.equal(result.products.filter((item) => item.priceSignals.length === 0).length, 6);
  } finally {
    globalThis.fetch = originalFetch;
    resetSharedRobotsPolicyResolverForTests();
  }
});
