import assert from "node:assert/strict";
import test from "node:test";

import { crawlDomain } from "../app/api/crawl/route.ts";
import { fetchPublicText } from "../app/lib/public-fetch.ts";
import { selectPrimaryProductPriceTargets } from "../app/lib/storefront-product-enrichment.ts";
import { createRobotsPolicyResolver } from "../app/lib/robots-policy.ts";

function crawlWithMock(input, role) {
  const fetchImpl = globalThis.fetch;
  const fetchText = (url, accept, expectedDomain) => fetchPublicText(url, accept, { expectedDomain, timeoutMs: 1_000, maxDocumentBytes: 2_000_000, userAgent: "test", fetchImpl });
  const robotsResolver = createRobotsPolicyResolver({ fetchText: (url, accept, options) => fetchPublicText(url, accept, { ...options, fetchImpl }) });
  return crawlDomain(input, role, [], { fetchText, robotsResolver });
}

test("short product routes outrank account navigation and survive a missing sitemap", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /p/blocked/");
    if (url.endsWith("/sitemap.xml")) return new Response("AccessDenied", { status: 403 });
    if (url === "https://shop.test/") return new Response(`<html><title>Tea store</title><body>${Array.from({length:70}, (_,i)=>`<a href="/account/${i}/">Account</a>`).join("")}${["tea-one","tea-two","tea-three","tea-four","tea-five","blocked"].map(id=>`<a href="/p/${id}/">${id}</a>`).join("")}</body></html>`, { headers:{"content-type":"text/html"} });
    return new Response(`<html><title>Tea</title><script type="application/ld+json">{"@type":"Product","name":"Tea","offers":{"price":"4.50","priceCurrency":"GBP"}}</script></html>`, {headers:{"content-type":"text/html"}});
  };
  try {
    const result = await crawlWithMock("shop.test", "primary");
    assert.ok(calls.some(url=>url.includes("/p/tea-")));
    assert.ok(!calls.some(url=>url.includes("/account/")||url.includes("/p/blocked/")));
    assert.equal(result.productCoverage.sitemapTruncated, true);
    assert.ok(result.products.some(product=>product.priceSignals.some(price=>price.amount===4.5)));
    assert.ok(result.products.some(product=>product.sourceUrl.includes("/p/tea-five/")), "unfetched observed product links remain available for bounded price recovery");
    assert.ok(selectPrimaryProductPriceTargets(result.products, "shop.test", 20).some(target=>target.sourceUrl.includes("/p/tea-five/")), "generic HTML product pages must not require a Shopify/WooCommerce adapter");
    assert.ok(result.coverage.pagesRequested <= result.coverage.maxPages);
  } finally { globalThis.fetch = originalFetch; }
});

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

test("a failed child sitemap exposes incomplete catalog coverage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\nSitemap: https://shop.test/sitemap.xml");
    if (url.endsWith("/sitemap.xml")) return new Response(`<?xml version="1.0"?><sitemapindex>${Array.from({ length: 4 }, (_, index) => `<sitemap><loc>https://shop.test/product-sitemap-${index}.xml</loc></sitemap>`).join("")}</sitemapindex>`, { headers: { "content-type": "application/xml" } });
    if (url.endsWith("/product-sitemap-2.xml")) return new Response("unavailable", { status: 503 });
    const child = url.match(/product-sitemap-(\d+)\.xml$/)?.[1];
    if (child) return new Response(`<urlset><url><loc>https://shop.test/products/sidr-honey-${child}-500g</loc></url></urlset>`, { headers: { "content-type": "application/xml" } });
    if (url === "https://shop.test/") return new Response("<html><head><title>Shop</title></head><body></body></html>", { headers: { "content-type": "text/html" } });
    return new Response("<html><head><title>Item</title></head><body><h1>Item</h1></body></html>", { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await crawlWithMock("shop.test", "primary");
    assert.equal(result.productCoverage.catalogProductsDiscovered, 3);
    assert.equal(result.productCoverage.sitemapTruncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
