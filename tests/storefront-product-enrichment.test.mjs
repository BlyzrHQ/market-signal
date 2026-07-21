import assert from "node:assert/strict";
import test from "node:test";

import { productDecision } from "../app/lib/product-intelligence.ts";
import { claimablePagePricePatterns, enrichProductTargets, extractScopedProductPageEvidence, publicProductTarget, selectPrimaryProductPriceTargets } from "../app/lib/storefront-product-enrichment.ts";

function product(index, overrides = {}) {
  return {
    id: `p-${index}`,
    domain: "shop.test",
    name: `Baklava Box ${index} 500g`,
    normalizedName: `baklava box ${index} 500g`,
    description: "",
    category: "products",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl: `https://shop.test/products/baklava-box-${index}`,
    imageUrl: `https://cdn.shop.test/baklava-${index}.jpg`,
    observedAt: "2026-07-20T00:00:00.000Z",
    claimIds: [`p-${index}-observed`],
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    domain: "shop.test",
    sourceUrl: "https://shop.test/products/maamoul-pistachio",
    productId: "maamoul-pistachio",
    expectedName: "Maamoul Pistachio",
    expectedType: "Product",
    pairScore: 0,
    role: "primary",
    ...overrides,
  };
}

test("selects every requested same-domain first-party target up to the report ceiling", () => {
  const products = [
    ...Array.from({ length: 8 }, (_, index) => product(index)),
    product(20, { sourceUrl: "https://other.test/products/wrong-domain" }),
    product(21, { sourceUrl: "https://shop.test/blog/not-a-product" }),
    product(22, { priceSignals: [{ raw: "USD 9", currency: "USD", amount: 9 }] }),
  ];
  const targets = selectPrimaryProductPriceTargets(products, "shop.test", 20);
  assert.equal(targets.length, 8);
  assert.ok(targets.every((item) => item.domain === "shop.test" && item.role === "primary"));
  assert.equal(targets.some((item) => item.productId === "p-20" || item.productId === "p-21" || item.productId === "p-22"), false);
});

test("extracts only the requested product summary price and ignores related products", () => {
  const evidence = extractScopedProductPageEvidence(`
    <main><h1 class="product_title">White Onion</h1>
      <div class="summary entry-summary"><p class="price"><span class="amount">&pound;1.14</span></p></div>
    </main>
    <section class="related products"><h2>Related products</h2><p class="price">&pound;99.00</p></section>
  `);
  assert.deepEqual(evidence.priceSignals, [{ raw: "GBP 1.14", currency: "GBP", amount: 1.14 }]);
  assert.equal(evidence.basis, "point");
});

test("uses the current ins price instead of the crossed-out WooCommerce price", () => {
  const evidence = extractScopedProductPageEvidence(`
    <h1 class="product_title">Halloumi Cheese 250g</h1>
    <div class="summary entry-summary"><p class="price"><del><span>&pound;5.25</span></del><ins><span>&pound;4.35</span></ins></p></div>
  `);
  assert.deepEqual(evidence.priceSignals.map((signal) => signal.amount), [4.35]);
  assert.equal(evidence.basis, "sale");
});

test("extracts a truthful WooCommerce variant range from the product form", () => {
  const variations = JSON.stringify([
    { display_price: 18.5, display_regular_price: 20, attributes: { attribute_weight: "500g" } },
    { display_price: 52, display_regular_price: 52, attributes: { attribute_weight: "1.5kg" } },
  ]).replaceAll('"', "&quot;");
  const evidence = extractScopedProductPageEvidence(`
    <h1 class="product_title">Halal Beef Fillet Whole</h1>
    <div class="summary entry-summary"><p class="price">&pound;18.50 &ndash; &pound;52.00</p>
      <form class="variations_form" data-product_variations="${variations}"></form>
    </div>
  `);
  assert.deepEqual(evidence.priceSignals.map((signal) => signal.amount), [18.5, 52]);
  assert.equal(evidence.basis, "range");
});

test("does not claim a scoped amount without a confirmed same-page currency", () => {
  const evidence = extractScopedProductPageEvidence('<h1>Maamoul Box</h1><div class="summary"><p class="price">12.50</p></div>');
  assert.deepEqual(evidence.priceSignals, []);
  assert.equal(evidence.basis, "unavailable");
});

test("removes only exact-zero unstructured price patterns", () => {
  assert.deepEqual(
    claimablePagePricePatterns(["$0", "$0.00", "0 USD", "EUR 0,00", "$0.99", "EUR 0,50", "GBP 12"]),
    ["$0.99", "EUR 0,50", "GBP 12"],
  );
});

test("recovers public Shopify variants while preserving a non-comparable price basis", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "Maamoul Pistachio",
      handle: "maamoul-pistachio",
      type: "Maamoul",
      featured_image: "//cdn.shopify.com/maamoul.jpg",
      variants: [
        { title: "1 Piece", price: 99 },
        { title: "3 Pieces", price: 249 },
        { title: "1 lb", price: 1199 },
      ],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response('<html><head><title>Maamoul Pistachio</title><meta property="og:price:currency" content="USD"><script>Shopify.currency = {"active":"USD"}</script></head><body><h1>Maamoul Pistachio</h1></body></html>', { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target()], 6);
    assert.equal(result.coverage.pagesRequested, 1);
    assert.equal(result.coverage.pagesFetched, 1);
    assert.deepEqual(result.products[0].priceSignals.map((signal) => signal.amount), [0.99, 2.49, 11.99]);
    assert.equal(result.products[0].imageUrl, "https://cdn.shopify.com/maamoul.jpg");
    const rival = product(30, { domain: "rival.test", name: "Maamoul Pistachio", normalizedName: "maamoul pistachio", priceSignals: [{ raw: "USD 8", currency: "USD", amount: 8 }] });
    const decision = productDecision(result.products[0], rival, 0.9, true);
    assert.equal(decision.priceComparison, null);
    assert.match(decision.priceVerdict, /variant or pack-size alignment is unresolved/i);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/products/maamoul-pistachio", "https://shop.test/products/maamoul-pistachio.js"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves custom same-domain shop URLs for HTML-only enrichment", async () => {
  const parsed = publicProductTarget(target({ sourceUrl: "https://shop.test/shop/maamoul-pistachio" }));
  assert.ok(parsed);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><head><title>Maamoul Pistachio</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Maamoul Pistachio",
      image: "https://cdn.shop.test/maamoul.jpg",
      offers: { "@type": "Offer", price: "8.50", priceCurrency: "USD" },
    })}</script></head><body><h1>Maamoul Pistachio</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([parsed], 24);
    assert.equal(result.coverage.pagesRequested, 1);
    assert.equal(result.coverage.pagesFetched, 1);
    assert.equal(result.products[0].priceSignals[0].amount, 8.5);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/shop/maamoul-pistachio"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not follow a selected product redirect off-domain", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response(null, { status: 302, headers: { location: "https://tracker.test/stolen" } });
  };
  try {
    const result = await enrichProductTargets([target()], 6);
    assert.equal(result.coverage.pagesFetched, 0);
    assert.match(result.coverage.gaps[0].reason, /redirected off the product domain/i);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/products/maamoul-pistachio"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retains product evidence but no price when Shopify currency is not confirmed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "Maamoul Pistachio", handle: "maamoul-pistachio", variants: [{ title: "Default Title", price: 1199 }] });
    return new Response("<html><head><title>Maamoul Pistachio</title></head><body><h1>Maamoul Pistachio</h1></body></html>", { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target()], 6);
    assert.equal(result.coverage.pagesFetched, 1);
    assert.deepEqual(result.products[0].priceSignals, []);
    assert.match(result.coverage.gaps[0].reason, /no same-page currency/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a storefront payload whose product identity contradicts the target", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "Chocolate Cake", handle: "maamoul-pistachio", variants: [{ title: "Default Title", price: 1199 }] });
    return new Response('<html><head><title>Chocolate Cake</title><meta property="og:price:currency" content="USD"></head><body><h1>Chocolate Cake</h1></body></html>', { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target()], 6);
    assert.equal(result.coverage.pagesFetched, 0);
    assert.match(result.coverage.gaps[0].reason, /contradicts the requested product identity/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips product and adapter fetches when robots disallows the selected page", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("User-agent: *\nDisallow: /products/", { headers: { "content-type": "text/plain" } });
  };
  try {
    const result = await enrichProductTargets([target()], 6);
    assert.equal(result.coverage.pagesFetched, 0);
    assert.match(result.coverage.gaps[0].reason, /robots\.txt disallows/i);
    assert.deepEqual(calls, ["https://shop.test/robots.txt"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
