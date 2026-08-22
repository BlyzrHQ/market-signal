import assert from "node:assert/strict";
import test from "node:test";

import { crawlDomain } from "../app/api/crawl/route.ts";
import { fetchPublicText } from "../app/lib/public-fetch.ts";
import { createRobotsPolicyResolver } from "../app/lib/robots-policy.ts";

function crawlWithMock(input, role) {
  const fetchImpl = globalThis.fetch;
  const fetchText = (url, accept, expectedDomain) => fetchPublicText(url, accept, { expectedDomain, timeoutMs: 1_000, maxDocumentBytes: 2_000_000, userAgent: "test", fetchImpl });
  const robotsResolver = createRobotsPolicyResolver({ fetchText: (url, accept, options) => fetchPublicText(url, accept, { ...options, fetchImpl }) });
  return crawlDomain(input, role, [], { fetchText, robotsResolver });
}

test("a 404 robots response permits sitemap discovery and bounded page expansion", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
    if (url.endsWith("/sitemap.xml")) return new Response("<?xml version=\"1.0\"?><urlset><url><loc>https://shop.test/products/sidr-honey</loc></url></urlset>", { headers: { "content-type": "application/xml" } });
    if (url.endsWith("/products/sidr-honey")) return new Response("<html><head><title>Sidr Honey</title></head><body><h1>Sidr Honey</h1></body></html>", { headers: { "content-type": "text/html" } });
    return new Response('<html><head><title>Honey Shop</title></head><body><a href="/products/sidr-honey">Sidr Honey</a></body></html>', { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await crawlWithMock("shop.test", "primary");
    assert.ok(calls.includes("https://shop.test/sitemap.xml"));
    assert.ok(calls.includes("https://shop.test/products/sidr-honey"));
    assert.ok(result.pages.some((page) => page.path === "/products/sidr-honey"));
    assert.match(result.gaps[0].reason, /No robots\.txt was published \(HTTP 404\)/);
    assert.ok(result.coverage.pagesRequested <= result.coverage.maxPages);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a bounded child-sitemap crawl exposes incomplete catalog coverage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\nSitemap: https://shop.test/sitemap.xml");
    if (url.endsWith("/sitemap.xml")) return new Response(`<?xml version="1.0"?><sitemapindex>${Array.from({ length: 5 }, (_, index) => `<sitemap><loc>https://shop.test/product-sitemap-${index}.xml</loc></sitemap>`).join("")}</sitemapindex>`, { headers: { "content-type": "application/xml" } });
    const child = url.match(/product-sitemap-(\d+)\.xml$/)?.[1];
    if (child) return new Response(`<?xml version="1.0"?><urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://shop.test/products/sidr-honey-${child}-500g</loc><image:image><image:title>Sidr Honey ${child} 500g</image:title></image:image></url></urlset>`, { headers: { "content-type": "application/xml" } });
    if (url === "https://shop.test/") return new Response("<html><head><title>Shop</title></head><body></body></html>", { headers: { "content-type": "text/html" } });
    return new Response(`<html><head><title>Item</title></head><body><h1>Item</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await crawlWithMock("shop.test", "primary");
    assert.equal(result.productCoverage.catalogProductsDiscovered, 4);
    assert.equal(result.productCoverage.sitemapTruncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
