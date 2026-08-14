import assert from "node:assert/strict";
import test from "node:test";

import { productDecision } from "../app/lib/product-intelligence.ts";
import { resetSharedRobotsPolicyResolverForTests, sharedRobotsPolicyResolver } from "../app/lib/robots-policy.ts";
import { claimablePagePricePatterns, enrichProductTargets, extractScopedProductPageEvidence, publicProductTarget, selectPrimaryProductPriceTargets } from "../app/lib/storefront-product-enrichment.ts";

test.beforeEach(() => resetSharedRobotsPolicyResolverForTests());

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

test("preserves three-decimal KWD prices from Arabic visible markup", () => {
  const evidence = extractScopedProductPageEvidence(`
    <h1 class="product_title">عسل سدر 500 جرام</h1>
    <div class="summary entry-summary"><p class="price"><span>1.255 ك.د</span></p></div>
  `);
  assert.deepEqual(evidence.priceSignals, [{ raw: "KWD 1.255", currency: "KWD", amount: 1.255 }]);
});

test("recognizes directly observed Arabic AED and SAR currency tokens", () => {
  const aed = extractScopedProductPageEvidence('<h1>تمر</h1><div class="summary"><p class="price">د.إ 12.50</p></div>');
  const sar = extractScopedProductPageEvidence('<h1>عسل</h1><div class="summary"><p class="price">19.75 ر.س</p></div>');
  assert.deepEqual(aed.priceSignals, [{ raw: "AED 12.5", currency: "AED", amount: 12.5 }]);
  assert.deepEqual(sar.priceSignals, [{ raw: "SAR 19.75", currency: "SAR", amount: 19.75 }]);
});

test("requires Arabic currency tokens to be bounded and adjacent to a price", () => {
  const ordinaryWords = extractScopedProductPageEvidence(`
    <h1>عسل سريع ومؤكد</h1>
    <div class="summary"><p class="price">12.50</p>
      <form data-product_variations="[{&quot;display_price&quot;:12.5}]"></form>
    </div>
  `);
  const honorific = extractScopedProductPageEvidence('<h1>Sr Honey</h1><div class="summary"><p class="price">12.50</p></div>');
  assert.deepEqual(ordinaryWords.priceSignals, []);
  assert.deepEqual(honorific.priceSignals, []);
});

test("normalizes Eastern Arabic digits only when paired with observed currency", () => {
  const evidence = extractScopedProductPageEvidence('<h1>عسل</h1><div class="summary"><p class="price">١٩٫٧٥ ر.س</p></div>');
  assert.deepEqual(evidence.priceSignals, [{ raw: "SAR 19.75", currency: "SAR", amount: 19.75 }]);
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

test("keeps an incomplete WooCommerce variation set non-comparable", () => {
  const variations = JSON.stringify([
    { display_price: 0, attributes: { attribute_weight: "500g" } },
    { display_price: 19.99, attributes: { attribute_weight: "1kg" } },
  ]).replace(/"/g, "&quot;");
  const evidence = extractScopedProductPageEvidence(`<h1>Tea</h1><form data-product_variations="${variations}"><p class="price">USD 19.99</p></form>`);
  assert.deepEqual(evidence.priceSignals, []);
  assert.equal(evidence.basis, "unavailable");
});

test("keeps malformed and non-array WooCommerce variation payloads non-comparable", () => {
  const payloads = [
    "{", JSON.stringify("not-an-array"), JSON.stringify({ display_price: 19.99 }), "", "false",
    JSON.stringify([{ display_price: true }]),
    JSON.stringify([{ display_price: "0x10" }]),
    JSON.stringify([{ display_price: "1e3" }]),
  ];
  for (const payload of payloads) {
    const encoded = payload.replace(/"/g, "&quot;");
    const attribute = payload === "false" ? "data-product_variations=false" : `data-product_variations="${encoded}"`;
    const evidence = extractScopedProductPageEvidence(`<h1>Tea</h1><form ${attribute}><p class="price">USD 19.99</p></form>`);
    assert.deepEqual(evidence.priceSignals, [], payload);
    assert.equal(evidence.basis, "unavailable", payload);
  }
  const booleanEvidence = extractScopedProductPageEvidence('<h1>Tea</h1><form data-product_variations><p class="price">USD 19.99</p></form>');
  assert.deepEqual(booleanEvidence.priceSignals, []);
});

test("ignores scoped prices, variations, and images inside inert markup", () => {
  const variation = JSON.stringify([{ display_price: 19.99 }]).replace(/"/g, "&quot;");
  for (const [open, close] of [["<script>", "</script>"], ["<template>", "</template>"], ["<textarea>", "</textarea>"], ["<xmp>", "</xmp>"]]) {
    const evidence = extractScopedProductPageEvidence(`<h1>Tea</h1>${open}<form data-product_variations="${variation}"><p class="price">USD 19.99</p><img class="product-image" src="https://cdn.shop.test/inert.jpg"></form>${close}`);
    assert.deepEqual(evidence.priceSignals, [], open);
    assert.equal(evidence.imageUrl, "", open);
  }
});

test("preserves active product evidence between sibling script blocks", () => {
  const evidence = extractScopedProductPageEvidence('<script>head()</script><h1>Tea</h1><div class="summary"><p class="price">USD 19.99</p><img class="product-image" src="https://cdn.shop.test/tea.jpg"></div><script>foot()</script>');
  assert.deepEqual(evidence.priceSignals, [{ raw: "USD 19.99", currency: "USD", amount: 19.99 }]);
  assert.equal(evidence.imageUrl, "https://cdn.shop.test/tea.jpg");
});

test("preserves active product evidence after script text containing fallback markup", () => {
  const evidence = extractScopedProductPageEvidence('<script>document.write(\'<script src="fallback.js"><\\/script>\')</script><h1>Tea</h1><div class="summary"><p class="price">USD 19.99</p></div>');
  assert.deepEqual(evidence.priceSignals, [{ raw: "USD 19.99", currency: "USD", amount: 19.99 }]);
});

test("reconciles visible and direct product currencies before publishing a scoped price", () => {
  const conflicting = extractScopedProductPageEvidence('<meta property="product:price:currency" content="EUR"><h1>Tea</h1><p class="price">USD 19.99</p>');
  assert.deepEqual(conflicting.priceSignals, []);

  const disambiguatedDollar = extractScopedProductPageEvidence('<meta property="product:price:currency" content="CAD"><h1>Tea</h1><p class="price">$19.99</p>');
  assert.deepEqual(disambiguatedDollar.priceSignals, [{ raw: "CAD 19.99", currency: "CAD", amount: 19.99 }]);

  const ambiguousDollar = extractScopedProductPageEvidence('<h1>Tea</h1><p class="price">$19.99</p>');
  assert.deepEqual(ambiguousDollar.priceSignals, []);

  const cadWithUsd = extractScopedProductPageEvidence('<meta property="product:price:currency" content="CAD"><h1>Tea</h1><p class="price">$19.99 USD</p>');
  assert.deepEqual(cadWithUsd.priceSignals, []);

  const usdWithCad = extractScopedProductPageEvidence('<meta property="product:price:currency" content="USD"><h1>Tea</h1><p class="price">CAD $19.99</p>');
  assert.deepEqual(usdWithCad.priceSignals, []);
});

test("does not collapse visible multi-currency evidence into a single point price", () => {
  const evidence = extractScopedProductPageEvidence('<h1>Product</h1><div class="summary"><p class="price">USD 12.50 / EUR 10.99</p></div>');
  assert.deepEqual(evidence.priceSignals, []);
  assert.equal(evidence.basis, "unavailable");
});

test("rejects unsupported or negative scoped price markup", () => {
  const unsupported = extractScopedProductPageEvidence('<html><head><meta property="og:price:currency" content="XXX"></head><body><h1>Product</h1><p class="price">XXX 12.50</p></body></html>');
  const negativePrefix = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">-$12.50</p></body></html>');
  const negativeSpaced = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">- $12.50</p></body></html>');
  const encodedNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&minus;$12.50</p></body></html>');
  const encodedEnDash = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&ndash;$12.50</p></body></html>');
  const encodedEmDash = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&mdash;$12.50</p></body></html>');
  const encodedHyphen = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&hyphen;$12.50</p></body></html>');
  const encodedDash = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&dash;$12.50</p></body></html>');
  const numericHyphen = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#x2010;$12.50</p></body></html>');
  const superscriptMinus = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#x207b;$12.50</p></body></html>');
  const subscriptMinus = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#x208b;$12.50</p></body></html>');
  const heavyMinus = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#x2796;$12.50</p></body></html>');
  const circledMinus = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&ominus;12.50 USD</p></body></html>');
  const dotMinus = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">\u223812.50 USD</p></body></html>');
  const minusPlus = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">\u221312.50 USD</p></body></html>');
  const trailingNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">$12.50-</p></body></html>');
  const accountingNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">($12.50)</p></body></html>');
  const labeledNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">Price: &minus;$12.50</p></body></html>');
  const entityLabeledNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">Price&colon;&minus;$12.50</p></body></html>');
  const equalsEntityNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">Price&equals;&minus;$12.50</p></body></html>');
  const semicolonlessDecimalNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#45 $12.50</p></body></html>');
  const semicolonlessHexNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#x2d $12.50</p></body></html>');
  const punctuationDecimalNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#45: USD 12.50</p></body></html>');
  const punctuationHexNegative = extractScopedProductPageEvidence('<html><body><h1>Product</h1><p class="price">&#x2d: USD 12.50</p></body></html>');
  assert.deepEqual(unsupported.priceSignals, []);
  assert.deepEqual(negativePrefix.priceSignals, []);
  assert.deepEqual(negativeSpaced.priceSignals, []);
  assert.deepEqual(encodedNegative.priceSignals, []);
  assert.deepEqual(encodedEnDash.priceSignals, []);
  assert.deepEqual(encodedEmDash.priceSignals, []);
  assert.deepEqual(encodedHyphen.priceSignals, []);
  assert.deepEqual(encodedDash.priceSignals, []);
  assert.deepEqual(numericHyphen.priceSignals, []);
  assert.deepEqual(superscriptMinus.priceSignals, []);
  assert.deepEqual(subscriptMinus.priceSignals, []);
  assert.deepEqual(heavyMinus.priceSignals, []);
  assert.deepEqual(circledMinus.priceSignals, []);
  assert.deepEqual(dotMinus.priceSignals, []);
  assert.deepEqual(minusPlus.priceSignals, []);
  assert.deepEqual(trailingNegative.priceSignals, []);
  assert.deepEqual(accountingNegative.priceSignals, []);
  assert.deepEqual(labeledNegative.priceSignals, []);
  assert.deepEqual(entityLabeledNegative.priceSignals, []);
  assert.deepEqual(equalsEntityNegative.priceSignals, []);
  assert.deepEqual(semicolonlessDecimalNegative.priceSignals, []);
  assert.deepEqual(semicolonlessHexNegative.priceSignals, []);
  assert.deepEqual(punctuationDecimalNegative.priceSignals, []);
  assert.deepEqual(punctuationHexNegative.priceSignals, []);
});

test("preserves both ends of a scoped same-currency price range", () => {
  const evidence = extractScopedProductPageEvidence('<h1>Product</h1><div class="summary"><p class="price">USD 12.50 - USD 19.99</p></div>');
  assert.deepEqual(evidence.priceSignals.map((signal) => signal.amount), [12.5, 19.99]);
  assert.equal(evidence.basis, "range");
});

test("ignores out-of-range numeric entities in scoped evidence", () => {
  const evidence = extractScopedProductPageEvidence('<h1>Product</h1><div class="summary"><p class="price">USD &#9999999999;</p></div>');
  assert.deepEqual(evidence.priceSignals, []);
});

test("replaces a zero Shopify page placeholder with a positive same-domain adapter price", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "CornerStone Enhanced Visibility Beanie",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
    assert.deepEqual(calls, [
      "https://shop.test/robots.txt",
      "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
      "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replaces a zero structured placeholder with positive scoped visible evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "CornerStone Enhanced Visibility Beanie",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1><div class="summary"><p class="price">USD 12.50</p></div></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/shop/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 12.5", currency: "USD", amount: 12.5 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the matched product currency instead of an unrelated structured product currency", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify([
      { "@type": "Product", name: "Unrelated Safety Jacket", offers: { price: "50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "0", priceCurrency: "USD" } },
    ])}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores script-only Shopify currency and uses explicit structured product currency", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script>Shopify.currency = {"active":"EUR"}</script><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "0", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not fall back to structured currency when direct metadata currencies conflict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><meta property="product:price:currency" content="USD"><meta property="og:price:currency" content="EUR"><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "0", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not infer Shopify adapter currency from a symbol-only zero placeholder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "$0" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not collapse a partial structured range into its positive endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { lowPrice: 0, highPrice: 19.99, priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/shop/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not collapse malformed or negative structured ranges into a positive endpoint", async () => {
  const originalFetch = globalThis.fetch;
  for (const lowPrice of ["N/A", -1, "-1", "NaN"]) {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
      return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { lowPrice, highPrice: 19.99, priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
    };
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/shop/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, [], String(lowPrice));
    resetSharedRobotsPolicyResolverForTests();
  }
  globalThis.fetch = originalFetch;
});

test("does not merge page and adapter evidence when their observed SKUs conflict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      featured_image: "https://cdn.shop.test/wrong-sku.jpg",
      variants: [{ title: "Default Title", price: 1340, sku: "ADAPTER-B" }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><meta property="product:price:currency" content="USD"><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", sku: "PAGE-A", offers: { price: 12.5, priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.equal(result.products[0].identifiers?.sku, "PAGE-A");
    assert.equal(result.products[0].imageUrl, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not replace a zero-price page record with an adapter price from a conflicting SKU", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340, sku: "ADAPTER-B" }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><meta property="product:price:currency" content="USD"><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", sku: "PAGE-A", offers: { price: 0, priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1><div class="summary"><img class="product-image" src="https://cdn.shop.test/page-a.jpg"></div></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.equal(result.products[0].identifiers?.sku, "PAGE-A");
    assert.deepEqual(result.products[0].priceSignals, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not use a recommendation block price as scoped target evidence", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "0", priceCurrency: "USD" },
    })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1><div class="recommendations"><p class="price">USD 89.99</p></div><div class="summary"><img class="product-image" src="https://cdn.shop.test/beanie.jpg"><p class="price">USD 12.50</p></div></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
    assert.equal(calls.at(-1), "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not use an id-based recommendation price as scoped target evidence", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "0", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1><div id="product-recommendations"><img class="product-image" src="https://cdn.shop.test/upsell.jpg"><p class="price">USD 89.99</p></div></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
    assert.equal(calls.at(-1), "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not use a recommendation custom-element price as scoped target evidence", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "0", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1><product-recommendations><img class="product-image" src="https://cdn.shop.test/upsell.jpg"><p class="price">USD 89.99</p></product-recommendations><div class="summary"><p class="price">USD 12.50</p></div></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
    assert.equal(calls.at(-1), "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not use an unquoted related-products class as scoped target evidence", () => {
  const evidence = extractScopedProductPageEvidence('<h1>Target</h1><div class=related-products><p class="price">USD 89.99</p></div><div class=summary><p class="price">USD 12.50</p></div>');
  assert.deepEqual(evidence.priceSignals, []);
});

test("does not confuse unrelated-content with a related-product boundary", () => {
  const evidence = extractScopedProductPageEvidence('<h1>Target</h1><div class="unrelated-content">Editorial copy</div><div class="summary"><p class="price">USD 12.50</p></div>');
  assert.deepEqual(evidence.priceSignals, [{ raw: "USD 12.5", currency: "USD", amount: 12.5 }]);
});

test("preserves decorated and promotional positive scoped prices", () => {
  for (const markup of ["+19.99 USD", "Sale - USD 19.99", "Now - 19.99 USD"]) {
    const evidence = extractScopedProductPageEvidence(`<h1>Product</h1><div class="summary"><p class="price">${markup}</p></div>`);
    assert.equal(evidence.priceSignals[0]?.amount, 19.99, markup);
  }
  for (const markup of ["★ $19.99", "≈$19.99", "Promo &ndash; $19.99"]) {
    const evidence = extractScopedProductPageEvidence(`<h1>Product</h1><div class="summary"><p class="price">${markup}</p></div>`);
    assert.deepEqual(evidence.priceSignals, [], markup);
  }
});

test("does not assign a Shopify fallback price when the matched product exposes multiple currencies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: [{ price: "0", priceCurrency: "USD" }, { price: "10", priceCurrency: "EUR" }] })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.deepEqual(result.products[0].priceSignals, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Shopify only for a missing image when the page already has a valid price", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      featured_image: "https://cdn.shop.test/beanie.jpg",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "12.50", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.equal(result.products[0].priceSignals[0].amount, 12.5);
    assert.equal(result.products[0].imageUrl, "https://cdn.shop.test/beanie.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not merge an image from an identity-rejected Shopify fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "Chocolate Cake",
      handle: "cornerstone-enhanced-visibility-beanie",
      featured_image: "https://cdn.shop.test/chocolate-cake.jpg",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", offers: { price: "12.50", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.equal(result.products[0].priceSignals[0].amount, 12.5);
    assert.equal(result.products[0].imageUrl, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Shopify only for a missing price when the page already has a valid image", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "CornerStone Enhanced Visibility Beanie", handle: "cornerstone-enhanced-visibility-beanie", variants: [{ title: "Default Title", price: 1340 }] }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "CornerStone Enhanced Visibility Beanie", image: "https://cdn.shop.test/page-beanie.jpg", offers: { price: "0", priceCurrency: "USD" } })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "CornerStone Enhanced Visibility Beanie", sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie" })], 1);
    assert.equal(result.products[0].priceSignals[0].amount, 13.4);
    assert.equal(result.products[0].imageUrl, "https://cdn.shop.test/page-beanie.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prefers a valid adapter price when an exact-name zero placeholder ranks above a compatible longer title", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie with Reflective Stripe",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "CornerStone Enhanced Visibility Beanie",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].name, "CornerStone Enhanced Visibility Beanie with Reflective Stripe");
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not let an unrelated priced product suppress adapter recovery for the matched product", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify([
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "CornerStone Enhanced Visibility Beanie",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Unrelated Safety Jacket",
        image: "https://cdn.shop.test/unrelated.jpg",
        offers: { "@type": "Offer", price: "89.99", priceCurrency: "USD" },
      },
    ])}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
    assert.equal(calls.at(-1), "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not let a similarly named priced related product contaminate the strongest matched product", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "CornerStone Enhanced Visibility Beanie",
      handle: "cornerstone-enhanced-visibility-beanie",
      variants: [{ title: "Default Title", price: 1340 }],
    }, { headers: { "content-type": "text/javascript" } });
    return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify([
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "CornerStone Enhanced Visibility Beanie",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "CornerStone Enhanced Visibility Beanie with Pom",
        image: "https://cdn.shop.test/related.jpg",
        offers: { "@type": "Offer", price: "89.99", priceCurrency: "USD" },
      },
    ])}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({
      expectedName: "CornerStone Enhanced Visibility Beanie",
      sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
    })], 1);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].name, "CornerStone Enhanced Visibility Beanie");
    assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 13.4", currency: "USD", amount: 13.4 }]);
    assert.equal(calls.at(-1), "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps non-positive, non-finite, or unsupported-currency Shopify prices non-comparable after adapter enrichment", async () => {
  for (const { priceCurrency, adapterPrice } of [
    { priceCurrency: "USD", adapterPrice: 0 },
    { priceCurrency: "USD", adapterPrice: -100 },
    { priceCurrency: "USD", adapterPrice: "NaN" },
    { priceCurrency: "USD", adapterPrice: "Infinity" },
    { priceCurrency: "XXX", adapterPrice: 1340 },
    { priceCurrency: "   ", adapterPrice: 1340 },
  ]) {
    resetSharedRobotsPolicyResolverForTests();
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
      if (url.endsWith(".js")) return Response.json({
        title: "CornerStone Enhanced Visibility Beanie",
        handle: "cornerstone-enhanced-visibility-beanie",
        variants: [{ title: "Default Title", price: adapterPrice }],
      }, { headers: { "content-type": "text/javascript" } });
      return new Response(`<html><head><title>CornerStone Enhanced Visibility Beanie</title><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "CornerStone Enhanced Visibility Beanie",
        offers: { "@type": "Offer", price: "0", priceCurrency },
      })}</script></head><body><h1>CornerStone Enhanced Visibility Beanie</h1></body></html>`, { headers: { "content-type": "text/html" } });
    };
    try {
      const result = await enrichProductTargets([target({
        expectedName: "CornerStone Enhanced Visibility Beanie",
        sourceUrl: "https://shop.test/products/cornerstone-enhanced-visibility-beanie",
      })], 1);
      assert.equal(result.products.length, 1);
      assert.deepEqual(result.products[0].priceSignals, []);
      assert.equal(calls.at(-1), "https://shop.test/products/cornerstone-enhanced-visibility-beanie.js");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    assert.equal(result.coverage.gaps[0].code, "fetch_failed");
    assert.equal(result.coverage.gaps[0].failureKind, "redirect");
    assert.equal(result.coverage.gaps[0].httpStatus, undefined);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/products/maamoul-pistachio"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves observed non-success HTTP statuses without reading their bodies", async (t) => {
  for (const status of [404, 410, 500, 503]) {
    await t.test(String(status), async () => {
      resetSharedRobotsPolicyResolverForTests();
      const originalFetch = globalThis.fetch;
      let bodyRead = false;
      globalThis.fetch = async (input) => {
        if (String(input).endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
        return {
          ok: false,
          status,
          headers: new Headers({ "content-type": "text/html" }),
          arrayBuffer: async () => { bodyRead = true; throw new Error("body stream failed"); },
        };
      };
      try {
        const result = await enrichProductTargets([target()], 1);
        assert.equal(bodyRead, false);
        assert.equal(result.coverage.gaps[0].code, "fetch_failed");
        assert.equal(result.coverage.gaps[0].failureKind, "http");
        assert.equal(result.coverage.gaps[0].httpStatus, status);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test("classifies a successful response body-read failure as content, not network", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      arrayBuffer: async () => { throw new Error("body stream failed"); },
    };
  };
  try {
    const result = await enrichProductTargets([target()], 1);
    assert.equal(result.coverage.gaps[0].code, "fetch_failed");
    assert.equal(result.coverage.gaps[0].failureKind, "content");
    assert.equal(result.coverage.gaps[0].httpStatus, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reserves HTTP status zero for a pre-response network rejection", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    throw new Error("connection refused");
  };
  try {
    const result = await enrichProductTargets([target()], 1);
    assert.equal(result.coverage.gaps[0].code, "fetch_failed");
    assert.equal(result.coverage.gaps[0].failureKind, "network");
    assert.equal(result.coverage.gaps[0].httpStatus, 0);
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

test("catalog drift stays rejected unless the pre-match caller explicitly permits replacement", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    return new Response(`<html><head><title>Maamoul Walnut... | Shop</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name: "Maamoul Walnut 600g",
      image: "https://cdn.shop.test/walnut-600g.jpg", offers: { "@type": "Offer", price: "12.50", priceCurrency: "USD" },
    })}</script></head><body><h1>Maamoul Walnut 600g</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const stale = target({ expectedName: "Maamoul Walnut 500g", sourceUrl: "https://shop.test/products/maamoul-walnut-500g" });
    const rejected = await enrichProductTargets([stale], 1);
    assert.equal(rejected.products.length, 0);
    assert.equal(rejected.coverage.gaps[0].code, "identity_mismatch");

    const replaced = await enrichProductTargets([{ ...stale, allowCatalogReplacement: true }], 1);
    assert.equal(replaced.products.length, 1);
    assert.equal(replaced.products[0].id, stale.productId);
    assert.equal(replaced.products[0].name, "Maamoul Walnut 600g");
    assert.equal(replaced.products[0].quantity.amount, 600);
    assert.equal(replaced.products[0].priceSignals[0].amount, 12.5);
    assert.equal(replaced.products[0].imageUrl, "https://cdn.shop.test/walnut-600g.jpg");
    assert.match(replaced.products[0].attributes.join(" "), /Previous sitemap identity: Maamoul Walnut 500g/);
    assert.equal(replaced.products[0].claimIds.some((id) => id.includes("catalog-replacement")), true);
    assert.equal(replaced.coverage.gaps.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog replacement rejects ambiguous structured identities and page-signal-only evidence", async () => {
  const originalFetch = globalThis.fetch;
  let mode = "ambiguous";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    const scripts = mode === "ambiguous" ? `
      <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Maamoul Walnut 600g", offers: { "@type": "Offer", price: "12.50", priceCurrency: "USD" } })}</script>
      <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Maamoul Pistachio 600g", offers: { "@type": "Offer", price: "14.50", priceCurrency: "USD" } })}</script>` : "";
    return new Response(`<html><head><title>Maamoul Walnut Pistachio 600g | Shop</title>${scripts}<meta property="og:price:currency" content="USD"></head><body><h1>Maamoul Walnut Pistachio 600g</h1><div class="summary"><p class="price">USD 12.50</p><img class="product-image" src="https://cdn.shop.test/live.jpg"></div></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const stale = target({ expectedName: "Old Maamoul 500g", sourceUrl: "https://shop.test/shop/old-maamoul", allowCatalogReplacement: true });
    const ambiguous = await enrichProductTargets([stale], 1);
    assert.equal(ambiguous.products.length, 0);
    assert.equal(ambiguous.coverage.gaps[0].code, "identity_mismatch");
    mode = "page-signal";
    resetSharedRobotsPolicyResolverForTests();
    const unstructured = await enrichProductTargets([stale], 1);
    assert.equal(unstructured.products.length, 0);
    assert.equal(unstructured.coverage.gaps[0].code, "identity_mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog replacement rejects adapter disagreement and a structured quantity that conflicts with the page title", async () => {
  const originalFetch = globalThis.fetch;
  let mode = "adapter-disagreement";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({ title: "Maamoul Pistachio 600g", handle: "old-maamoul", variants: [{ title: "Default Title", price: 1450 }] });
    const title = mode === "adapter-disagreement" ? "Maamoul Walnut Pistachio 600g | Shop" : "Maamoul Walnut 500g | Shop";
    return new Response(`<html><head><title>${title}</title><meta property="og:price:currency" content="USD"><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name: "Maamoul Walnut 600g",
      image: "https://cdn.shop.test/walnut.jpg", offers: { "@type": "Offer", price: "12.50", priceCurrency: "USD" },
    })}</script></head><body><h1>${title}</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const targetValue = target({ expectedName: "Old Maamoul 400g", sourceUrl: "https://shop.test/products/old-maamoul", allowCatalogReplacement: true });
    const disagreement = await enrichProductTargets([targetValue], 1);
    assert.equal(disagreement.products.length, 0);
    assert.equal(disagreement.coverage.gaps[0].code, "identity_mismatch");
    mode = "quantity-conflict";
    resetSharedRobotsPolicyResolverForTests();
    const quantityConflict = await enrichProductTargets([{ ...targetValue, sourceUrl: "https://shop.test/shop/old-maamoul" }], 1);
    assert.equal(quantityConflict.products.length, 0);
    assert.equal(quantityConflict.coverage.gaps[0].code, "identity_mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ordinary Shopify enrichment keeps expected-quantity variant steering for opted-in primary targets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith(".js")) return Response.json({
      title: "Maamoul Walnut",
      handle: "maamoul-walnut",
      variants: [
        { title: "500g", price: 1250 },
        { title: "1kg", price: 2300 },
      ],
    });
    return new Response('<html><head><title>Shop</title><meta property="og:price:currency" content="USD"></head><body></body></html>', { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "Maamoul Walnut 500g", sourceUrl: "https://shop.test/products/maamoul-walnut", allowCatalogReplacement: true })], 1);
    assert.equal(result.products.length, 1);
    assert.deepEqual(result.products[0].priceSignals.map((signal) => signal.amount), [12.5]);
    assert.equal(result.products[0].quantity.amount, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog replacement rejects a same-domain redirect to another product path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/products/old-maamoul")) return new Response(null, { status: 302, headers: { location: "/products/live-maamoul-600g" } });
    return new Response(`<html><head><title>Live Maamoul 600g | Shop</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name: "Live Maamoul 600g",
      image: "https://cdn.shop.test/live.jpg", offers: { "@type": "Offer", price: "12.50", priceCurrency: "USD" },
    })}</script></head><body><h1>Live Maamoul 600g</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target({ expectedName: "Old Maamoul 500g", sourceUrl: "https://shop.test/products/old-maamoul", allowCatalogReplacement: true })], 1);
    assert.equal(result.products.length, 0);
    assert.equal(result.coverage.gaps[0].code, "identity_mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("primary targets opt into catalog replacement while public parsing stays strict boolean", () => {
  const targets = selectPrimaryProductPriceTargets([product(1, { name: "Maamoul Walnut 500g", normalizedName: "maamoul walnut 500g" })], "shop.test", 1);
  assert.equal(targets[0].allowCatalogReplacement, true);
  assert.equal(publicProductTarget(target({ allowCatalogReplacement: "true" })).allowCatalogReplacement, undefined);
  assert.equal(publicProductTarget(target({ allowCatalogReplacement: true })).allowCatalogReplacement, true);
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

test("a cached robots denial still blocks the selected product page", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return new Response("User-agent: *\nDisallow: /products/", { headers: { "content-type": "text/plain" } });
  };
  try {
    await sharedRobotsPolicyResolver.resolve("shop.test", "shop.test");
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response("should not be fetched", { headers: { "content-type": "text/html" } });
    };
    const result = await enrichProductTargets([target()], 1);
    assert.equal(result.products.length, 0);
    assert.match(result.coverage.gaps[0].reason, /robots\.txt disallows/i);
    assert.deepEqual(calls, ["https://shop.test/robots.txt"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cached successful robots policy carries a later product enrichment request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("User-agent: *\nAllow: /products/", { headers: { "content-type": "text/plain" } });
  };
  try {
    await sharedRobotsPolicyResolver.resolve("shop.test", "shop.test");
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      return new Response(`<html><head><title>Maamoul Pistachio</title><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org", "@type": "Product", name: "Maamoul Pistachio",
        image: "https://cdn.shop.test/maamoul.jpg", offers: { "@type": "Offer", price: "8.50", priceCurrency: "USD" },
      })}</script></head><body><h1>Maamoul Pistachio</h1></body></html>`, { headers: { "content-type": "text/html" } });
    };
    const result = await enrichProductTargets([target()], 1);
    assert.equal(result.coverage.pagesFetched, 1);
    assert.equal(result.products[0].imageUrl, "https://cdn.shop.test/maamoul.jpg");
    assert.equal(result.products[0].priceSignals[0].amount, 8.5);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/products/maamoul-pistachio"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a missing robots file permits only the existing bounded product enrichment", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
    return new Response(`<html><head><title>Maamoul Pistachio</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name: "Maamoul Pistachio",
      image: "https://cdn.shop.test/maamoul.jpg", offers: { "@type": "Offer", price: "8.50", priceCurrency: "USD" },
    })}</script></head><body><h1>Maamoul Pistachio</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([target()], 1);
    assert.equal(result.products[0].priceSignals[0].amount, 8.5);
    assert.match(result.coverage.gaps[0].reason, /No robots\.txt was published \(HTTP 404\)/);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/products/maamoul-pistachio"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports a missing robots policy once per domain instead of once per product", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
    const name = url.includes("second") ? "Maamoul Walnut" : "Maamoul Pistachio";
    return new Response(`<html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", name,
      offers: { "@type": "Offer", price: "8.50", priceCurrency: "USD" },
    })}</script></head><body><h1>${name}</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const result = await enrichProductTargets([
      target(),
      target({ sourceUrl: "https://shop.test/products/second", productId: "second", expectedName: "Maamoul Walnut" }),
    ], 2);
    assert.equal(result.products.length, 2);
    assert.equal(result.coverage.gaps.filter((gap) => /No robots\.txt was published/.test(gap.reason)).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unreachable robots file remains fail closed", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("unavailable", { status: 503 });
  };
  try {
    const result = await enrichProductTargets([target()], 1);
    assert.equal(result.products.length, 0);
    assert.match(result.coverage.gaps[0].reason, /robots\.txt was unreachable/i);
    assert.deepEqual(calls, [
      "https://shop.test/robots.txt",
      "https://shop.test/robots.txt",
      "https://www.shop.test/robots.txt",
      "https://www.shop.test/robots.txt",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
