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
    assert.equal(payload.products[0].id, "lamb-leg");
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
    assert.match(payload.coverage.gaps[0].reason, /robots\.txt was unreachable/i);
    assert.equal(payload.coverage.gaps[0].productId, "lemon-tea");
    assert.equal(payload.coverage.gaps[0].role, "rival");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses a robots-allowed Shopify product endpoint when HTML price and image are missing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "Beef Sirloin Steak Halal 500g",
      handle: "beef-sirloin-steak-halal-500g",
      featured_image: "//cdn.shopify.com/sirloin.jpg",
      variants: [{ title: "Default Title", price: 1257 }],
    });
    return new Response(`<html><head><title>halal Beef top sirloin steak 500G – MyJam Food</title><meta property="og:price:amount" content="99.00"><meta property="og:price:currency" content="GBP"><meta property="og:image:secure_url" content="https://cdn.shopify.com/marketing-image.jpg"><script>Shopify.currency = {"active":"GBP","rate":"1.0"}</script></head><body><h1>Beef Sirloin Steak Halal 500g</h1><h2>Product details</h2></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  try {
    const response = await POST(new Request("http://localhost/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "myjam.co.uk",
        sourceUrl: "https://myjam.co.uk/products/beef-sirloin-steak-halal-500g",
        productId: "sirloin-500g",
        expectedName: "Beef Sirloin Steak Halal 500G",
        expectedType: "Product",
        role: "primary",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.coverage.pagesFetched, 1);
    assert.deepEqual(payload.products[0].priceSignals, [{ raw: "GBP 12.57", currency: "GBP", amount: 12.57 }]);
    assert.equal(payload.products[0].imageUrl, "https://cdn.shopify.com/sirloin.jpg");
    assert.deepEqual(calls, [
      "https://myjam.co.uk/robots.txt",
      "https://myjam.co.uk/products/beef-sirloin-steak-halal-500g",
      "https://myjam.co.uk/products/beef-sirloin-steak-halal-500g.js",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns valid HTML evidence plus a visible gap when its storefront endpoint is blocked", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.includes("/wp-json/")) return Response.json({ code: "forbidden" }, { status: 403 });
    return new Response(`<html><head><title>White Onion</title><meta property="og:image:secure_url" content="https://grocer.test/onion.jpg"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"White Onion","image":"https://grocer.test/onion.jpg"}</script></head><body><h1>White Onion</h1><h2>Product details</h2></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const response = await POST(new Request("http://localhost/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "grocer.test",
        sourceUrl: "https://grocer.test/product/white-onion/",
        productId: "white-onion",
        expectedName: "White Onion",
        expectedType: "Product",
        role: "rival",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(payload.coverage.pagesFetched, 1);
    assert.equal(payload.products[0].imageUrl, "https://grocer.test/onion.jpg");
    assert.match(payload.coverage.gaps[0].reason, /returned HTTP 403/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps valid HTML evidence when the optional storefront endpoint cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) throw new Error("connection reset");
    return new Response(`<html><head><title>Lemon Tea</title><meta property="og:image:secure_url" content="https://shop.test/lemon.jpg"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Lemon Tea","image":"https://shop.test/lemon.jpg"}</script></head><body><h1>Lemon Tea</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const response = await POST(new Request("http://localhost/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "shop.test",
        sourceUrl: "https://shop.test/products/lemon-tea",
        productId: "lemon-tea",
        expectedName: "Lemon Tea",
        expectedType: "Product",
        role: "primary",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(payload.coverage.pagesFetched, 1);
    assert.equal(payload.products[0].name, "Lemon Tea");
    assert.match(payload.coverage.gaps[0].reason, /endpoint could not be fetched/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("includes the WooCommerce query string when enforcing robots rules", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /wp-json/wc/store/v1/products?slug=", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><head><title>White Onion</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"White Onion","image":"https://shop.test/onion.jpg"}</script></head><body><h1>White Onion</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const response = await POST(new Request("http://localhost/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "shop.test",
        sourceUrl: "https://shop.test/product/white-onion/",
        productId: "white-onion",
        expectedName: "White Onion",
        expectedType: "Product",
        role: "rival",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(payload.coverage.pagesFetched, 1);
    assert.match(payload.coverage.gaps[0].reason, /robots\.txt disallows the WooCommerce Store API endpoint/i);
    assert.equal(calls.some((url) => url.includes("/wp-json/")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
