import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../app/api/enrich-products/route.ts";
import { EDGE_PRODUCT_ENRICHMENT_MARKER } from "../app/lib/edge-product-enrichment-recovery.ts";
import { resetSharedRobotsPolicyResolverForTests } from "../app/lib/robots-policy.ts";

test.beforeEach(() => resetSharedRobotsPolicyResolverForTests());

test("retries only a typed robots-unreachable target through the configured edge", async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    token: process.env.MARKET_SIGNAL_CALLBACK_TOKEN,
    target: process.env.MARKET_SIGNAL_DEPLOY_TARGET,
    url: process.env.MARKET_SIGNAL_EDGE_ENRICH_URL,
  };
  const calls = [];
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = "a-valid-test-callback-token-with-32-chars";
  process.env.MARKET_SIGNAL_DEPLOY_TARGET = "node";
  process.env.MARKET_SIGNAL_EDGE_ENRICH_URL = "https://market-signal.abdulla617931.chatgpt.site/api/enrich-products";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === process.env.MARKET_SIGNAL_EDGE_ENRICH_URL) return Response.json({
      ok: true,
      products: [{
        id: "babanuj-maamoul",
        domain: "babanuj.com",
        name: "Zaitoune Mamoul With Dates 250g",
        normalizedName: "zaitoune mamoul with dates 250g",
        description: "",
        category: "product",
        jsonLdType: "Product",
        priceSignals: [{ raw: "USD 10.8", currency: "USD", amount: 10.8 }],
        attributes: [],
        ownership: "path-inferred",
        extraction: "json-ld",
        confidence: "Medium",
        sourceUrl: "https://www.babanuj.com/product/zaitoune-maamoul-date-250g",
        imageUrl: "https://cdn.shopify.com/babanuj-maamoul.jpg",
        observedAt: "2026-08-03T00:00:00.000Z",
        claimIds: [],
      }],
      coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] },
    });
    throw new Error("VPS egress unavailable");
  };
  try {
    const response = await POST(new Request("https://signal.blyzr.com/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{
        domain: "babanuj.com",
        sourceUrl: "https://www.babanuj.com/product/zaitoune-maamoul-date-250g",
        productId: "babanuj-maamoul",
        expectedName: "zaitoune maamoul date 250g",
        expectedType: "Product",
        role: "primary",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.products[0].imageUrl, "https://cdn.shopify.com/babanuj-maamoul.jpg");
    assert.equal(payload.products[0].priceSignals[0].amount, 10.8);
    assert.equal(payload.coverage.edgeRecovery.recovered, 1);
    assert.equal(calls.filter((call) => call.url === process.env.MARKET_SIGNAL_EDGE_ENRICH_URL).length, 1);
    const edgeCall = calls.find((call) => call.url === process.env.MARKET_SIGNAL_EDGE_ENRICH_URL);
    assert.equal(edgeCall.init.headers.Authorization, "Bearer a-valid-test-callback-token-with-32-chars");
    assert.equal(edgeCall.init.headers[EDGE_PRODUCT_ENRICHMENT_MARKER], "1");
    assert.doesNotMatch(edgeCall.init.body, /a-valid-test-callback-token/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      const envName = key === "token" ? "MARKET_SIGNAL_CALLBACK_TOKEN" : key === "target" ? "MARKET_SIGNAL_DEPLOY_TARGET" : "MARKET_SIGNAL_EDGE_ENRICH_URL";
      if (value === undefined) delete process.env[envName]; else process.env[envName] = value;
    }
  }
});

test("rejects an unauthenticated marked edge enrichment request before reading targets", async () => {
  const previous = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = "a-valid-test-callback-token-with-32-chars";
  try {
    const response = await POST(new Request("https://market-signal.abdulla617931.chatgpt.site/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json", [EDGE_PRODUCT_ENRICHMENT_MARKER]: "1" },
      body: JSON.stringify({ targets: [] }),
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized." });
  } finally {
    if (previous === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN; else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = previous;
  }
});

test("accepts an authenticated marked edge request and performs its own robots check", async () => {
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  const previousTarget = process.env.MARKET_SIGNAL_DEPLOY_TARGET;
  const calls = [];
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = "a-valid-test-callback-token-with-32-chars";
  process.env.MARKET_SIGNAL_DEPLOY_TARGET = "sites";
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response('<html><head><title>Date Maamoul 250g</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Date Maamoul 250g","image":"https://cdn.shop.test/date.jpg","offers":{"@type":"Offer","price":"10.80","priceCurrency":"USD"}}</script></head><body><h1>Date Maamoul 250g</h1></body></html>', { headers: { "content-type": "text/html" } });
  };
  try {
    const response = await POST(new Request("https://market-signal.abdulla617931.chatgpt.site/api/enrich-products", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [EDGE_PRODUCT_ENRICHMENT_MARKER]: "1",
        authorization: "Bearer a-valid-test-callback-token-with-32-chars",
      },
      body: JSON.stringify({ targets: [{
        domain: "shop.test",
        sourceUrl: "https://shop.test/product/date-maamoul-250g",
        productId: "date-maamoul",
        expectedName: "Date Maamoul 250g",
        expectedType: "Product",
        role: "primary",
      }] }),
    }));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.products[0].imageUrl, "https://cdn.shop.test/date.jpg");
    assert.equal(payload.products[0].priceSignals[0].amount, 10.8);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/product/date-maamoul-250g"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN; else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = previousToken;
    if (previousTarget === undefined) delete process.env.MARKET_SIGNAL_DEPLOY_TARGET; else process.env.MARKET_SIGNAL_DEPLOY_TARGET = previousTarget;
  }
});

test("never forwards a robots-disallowed target with an unreachable target", async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    token: process.env.MARKET_SIGNAL_CALLBACK_TOKEN,
    target: process.env.MARKET_SIGNAL_DEPLOY_TARGET,
    url: process.env.MARKET_SIGNAL_EDGE_ENRICH_URL,
  };
  let edgeBody;
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = "a-valid-test-callback-token-with-32-chars";
  process.env.MARKET_SIGNAL_DEPLOY_TARGET = "node";
  process.env.MARKET_SIGNAL_EDGE_ENRICH_URL = "https://market-signal.abdulla617931.chatgpt.site/api/enrich-products";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === process.env.MARKET_SIGNAL_EDGE_ENRICH_URL) {
      edgeBody = JSON.parse(init.body);
      return Response.json({ ok: true, products: [], coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: 64, gaps: [] } });
    }
    if (url === "https://blocked.test/robots.txt") return new Response("User-agent: *\nDisallow: /product/", { headers: { "content-type": "text/plain" } });
    if (url === "https://unreachable.test/robots.txt") throw new Error("network unavailable");
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const response = await POST(new Request("https://signal.blyzr.com/api/enrich-products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [
        { domain: "blocked.test", sourceUrl: "https://blocked.test/product/cake", productId: "blocked", expectedName: "Cake", expectedType: "Product", role: "rival" },
        { domain: "unreachable.test", sourceUrl: "https://unreachable.test/product/honey", productId: "unreachable", expectedName: "Honey", expectedType: "Product", role: "primary" },
      ] }),
    }));
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(edgeBody.targets.map((item) => item.productId), ["unreachable"]);
    assert.equal(payload.coverage.gaps.some((gap) => gap.productId === "blocked" && gap.code === "robots_disallowed"), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      const envName = key === "token" ? "MARKET_SIGNAL_CALLBACK_TOKEN" : key === "target" ? "MARKET_SIGNAL_DEPLOY_TARGET" : "MARKET_SIGNAL_EDGE_ENRICH_URL";
      if (value === undefined) delete process.env[envName]; else process.env[envName] = value;
    }
  }
});

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
