import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../app/api/enrich-products/route.ts";

test("enriches the exact selected product page with authoritative price and secure image", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><head>
      <title>Lamb Leg Halal apx 2500g | MyJam</title>
      <meta property="og:price:amount" content="39.05">
      <meta property="og:price:currency" content="GBP">
      <meta property="og:image" content="http://myjam.co.uk/cdn/lamb-leg.jpg">
      <meta property="og:image:secure_url" content="https://cdn.shopify.com/lamb-leg.jpg">
    </head><body><h1>Lamb Leg Halal apx 2500g</h1><h2>Product details</h2></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  try {
    const response = await POST(new Request("http://localhost/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "myjam.co.uk",
        sourceUrl: "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g",
        productId: "lamb-leg",
        expectedName: "Lamb Leg Halal apx 2500g",
        expectedType: "Product",
        pairScore: 0.91,
        role: "primary",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.coverage.pagesRequested, 1);
    assert.equal(payload.coverage.pagesFetched, 1);
    assert.deepEqual(payload.products[0].priceSignals, [{ raw: "GBP 39.05", currency: "GBP", amount: 39.05 }]);
    assert.equal(payload.products[0].imageUrl, "https://cdn.shopify.com/lamb-leg.jpg");
    assert.deepEqual(calls, ["https://myjam.co.uk/robots.txt", "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a visible source gap when one selected product domain cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connection reset"); };
  try {
    const response = await POST(new Request("http://localhost/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "rival.test",
        sourceUrl: "https://rival.test/products/lemon-tea",
        productId: "lemon-tea",
        expectedName: "Lemon Tea",
        expectedType: "Product",
        role: "rival",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.coverage.pagesFetched, 0);
    assert.match(payload.coverage.gaps[0].reason, /could not be read/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
