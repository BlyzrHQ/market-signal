import assert from "node:assert/strict";
import test from "node:test";

import { crawlDomain } from "../app/api/crawl/route.ts";

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
    const result = await crawlDomain("shop.test", "primary");
    assert.ok(calls.includes("https://shop.test/sitemap.xml"));
    assert.ok(calls.includes("https://shop.test/products/sidr-honey"));
    assert.ok(result.pages.some((page) => page.path === "/products/sidr-honey"));
    assert.match(result.gaps[0].reason, /No robots\.txt was published \(HTTP 404\)/);
    assert.ok(result.coverage.pagesRequested <= result.coverage.maxPages);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
