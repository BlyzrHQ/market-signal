import assert from "node:assert/strict";
import test from "node:test";

import { confirmedProductCurrency, hasConflictingDirectProductCurrency, parseShopifyProduct, parseWooCommerceProduct, storefrontAdapterRequest } from "../app/lib/product-page-adapters.ts";
import { validateProductPageIdentity } from "../app/lib/product-intelligence.ts";
import { bilingualNormalize, parseCanonicalQuantity } from "../app/lib/product-normalization.ts";

function expected(name, sourceUrl, identifiers) {
  return {
    id: "expected",
    domain: new URL(sourceUrl).hostname,
    name,
    normalizedName: bilingualNormalize(name),
    description: "",
    category: "product",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl,
    imageUrl: "",
    observedAt: "2026-07-20T10:00:00.000Z",
    claimIds: [],
    identifiers,
    quantity: parseCanonicalQuantity(name) || undefined,
  };
}

test("builds exact same-domain Shopify and WooCommerce adapter requests", () => {
  assert.deepEqual(storefrontAdapterRequest("https://shop.test/en/products/pistachio-maamoul?variant=2"), {
    kind: "shopify",
    endpointUrl: "https://shop.test/en/products/pistachio-maamoul.js",
    requestedKey: "pistachio-maamoul",
  });
  assert.deepEqual(storefrontAdapterRequest("https://grocer.test/product/white-onion/"), {
    kind: "woocommerce",
    endpointUrl: "https://grocer.test/wp-json/wc/store/v1/products?slug=white-onion",
    requestedKey: "white-onion",
  });
  assert.equal(storefrontAdapterRequest("https://shop.test/collections/sweets"), null);
});

test("confirms Shopify currency only from same-page public metadata", () => {
  assert.equal(confirmedProductCurrency('<meta property="product:price:currency" content="GBP">'), "GBP");
  assert.equal(confirmedProductCurrency('<script>Shopify.currency = {"active":"AED","rate":"1.0"}</script>'), "");
  assert.equal(confirmedProductCurrency('<meta property="og:price:currency" content="USD"><script>Shopify.currency = {"active":"EUR"}</script>'), "USD");
  assert.equal(confirmedProductCurrency('<meta property="product:price:currency" content="USD"><meta property="og:price:currency" content="EUR">'), "");
  assert.equal(hasConflictingDirectProductCurrency('<meta property="product:price:currency" content="USD"><meta property="og:price:currency" content="EUR">'), true);
  assert.equal(hasConflictingDirectProductCurrency('<meta property="product:price:currency" content="USD"><meta property="product:price:currency" content="EUR">'), true);
  assert.equal(hasConflictingDirectProductCurrency('<script>Shopify.currency = {"active":"USD"}</script><script>Shopify.currency = {"active":"EUR"}</script>'), false);
  assert.equal(hasConflictingDirectProductCurrency('<meta property="product:price:currency" content="USD"><meta property="product:price:currency" content=EUR>'), true);
  assert.equal(confirmedProductCurrency('<meta data-name="product:price:currency" content="EUR">'), "");
  assert.equal(confirmedProductCurrency('<!-- <meta property="product:price:currency" content="EUR"> -->'), "");
  assert.equal(confirmedProductCurrency('<script>const example = `<meta property="product:price:currency" content="EUR">`;</script>'), "");
  assert.equal(confirmedProductCurrency('<template><meta property="product:price:currency" content="EUR"></template>'), "");
  assert.equal(confirmedProductCurrency('<template><template><meta property="product:price:currency" content="EUR"></template></template>'), "");
  assert.equal(confirmedProductCurrency('<textarea><meta property="product:price:currency" content="EUR"></textarea>'), "");
  assert.equal(confirmedProductCurrency('<title><meta property="product:price:currency" content="EUR"></title>'), "");
  assert.equal(confirmedProductCurrency('<iframe srcdoc="<meta property=\'product:price:currency\' content=\'EUR\'>"></iframe>'), "");
  assert.equal(confirmedProductCurrency('<xmp><meta property="product:price:currency" content="EUR"></xmp>'), "");
  assert.equal(confirmedProductCurrency('<!-- <meta property="product:price:currency" content="EUR">'), "");
  assert.equal(hasConflictingDirectProductCurrency('<meta property="product:price:currency" content="USD"><script type="application/ld+json">{"priceCurrency":"EUR"}</script>'), false);
  assert.equal(confirmedProductCurrency('<script type="application/ld+json">{"priceCurrency":"EUR"}</script>'), "EUR");
  assert.equal(confirmedProductCurrency("Prices in pounds"), "");
});

test("parses an identity-gated Shopify product price, image, quantity, and SKU", () => {
  const sourceUrl = "https://myjam.co.uk/products/beef-sirloin-steak-halal-500g";
  const result = parseShopifyProduct({
    payload: {
      title: "Beef Sirloin Steak Halal 500g",
      handle: "beef-sirloin-steak-halal-500g",
      type: "Fresh Meat",
      featured_image: "//cdn.shopify.com/sirloin.jpg",
      variants: [{ title: "Default Title", price: 1257, sku: "BEEF-500", barcode: "1234567890128" }],
    },
    requestedKey: "beef-sirloin-steak-halal-500g",
    sourceUrl,
    domain: "myjam.co.uk",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "GBP",
    expectedQuantity: parseCanonicalQuantity("500g") || undefined,
  });
  assert.equal(result.gap, "");
  assert.equal(result.product?.extraction, "storefront-api");
  assert.equal(result.product?.imageUrl, "https://cdn.shopify.com/sirloin.jpg");
  assert.deepEqual(result.product?.priceSignals, [{ raw: "GBP 12.57", currency: "GBP", amount: 12.57 }]);
  assert.equal(result.product?.identifiers?.sku, "BEEF-500");
  assert.equal(result.product?.identifiers?.gtins[0], "01234567890128");
  assert.equal(validateProductPageIdentity([expected("Beef Sirloin Steak Halal 500G", sourceUrl)], [result.product], result.product?.name).accepted, true);
});

test("does not invent Shopify currency and keeps repurposed or conflicting products rejected", () => {
  const sourceUrl = "https://shop.test/products/nawashif-500g";
  const noCurrency = parseShopifyProduct({
    payload: { title: "Barazek Sesame Cookies 500g", handle: "nawashif-500g", variants: [{ title: "Default Title", price: 899, sku: "BAR-500" }] },
    requestedKey: "nawashif-500g",
    sourceUrl,
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "",
    expectedQuantity: parseCanonicalQuantity("500g") || undefined,
  });
  assert.deepEqual(noCurrency.product?.priceSignals, []);
  assert.match(noCurrency.gap, /no same-page currency/i);
  assert.equal(validateProductPageIdentity([expected("Nawashif Mixed Sweets 500g", sourceUrl)], [noCurrency.product], noCurrency.product?.name).accepted, false);

  const conflictingSku = parseShopifyProduct({
    payload: { title: "Nawashif Mixed Sweets 500g", handle: "nawashif-500g", variants: [{ title: "Default Title", price: 899, sku: "WRONG-SKU" }] },
    requestedKey: "nawashif-500g",
    sourceUrl,
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "GBP",
  });
  assert.equal(validateProductPageIdentity([expected("Nawashif Mixed Sweets 500g", sourceUrl, { gtins: [], sku: "EXPECTED-SKU" })], [conflictingSku.product], conflictingSku.product?.name).accepted, false);
});

test("keeps unresolved Shopify variant prices non-comparable", () => {
  const result = parseShopifyProduct({
    payload: {
      title: "Orange Juice",
      handle: "orange-juice",
      variants: [
        { title: "500ml", price: 200 },
        { title: "1L", price: 350 },
      ],
    },
    requestedKey: "orange-juice",
    sourceUrl: "https://shop.test/products/orange-juice",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "GBP",
  });
  assert.deepEqual(result.product?.priceSignals.map((signal) => signal.amount), [2, 3.5]);
});

test("keeps a selected Shopify variant set non-comparable when any selected price is incomplete", () => {
  const result = parseShopifyProduct({
    payload: {
      title: "Orange Juice",
      handle: "orange-juice",
      variants: [
        { title: "500ml Red", price: 200 },
        { title: "500ml Blue" },
      ],
    },
    requestedKey: "orange-juice",
    sourceUrl: "https://shop.test/products/orange-juice",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "GBP",
    expectedQuantity: parseCanonicalQuantity("500ml") || undefined,
  });
  assert.deepEqual(result.product?.priceSignals, []);
  assert.match(result.gap, /every selected variant/i);
});

test("accepts only canonical integer minor units from storefront adapters", () => {
  const parse = (price) => parseShopifyProduct({
    payload: { title: "Canonical Price", handle: "canonical-price", variants: [{ title: "Default Title", price }] },
    requestedKey: "canonical-price",
    sourceUrl: "https://shop.test/products/canonical-price",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "USD",
  });
  for (const value of ["0x10", "1e3", 12.5, "12.5", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parse(value).product?.priceSignals, [], String(value));
  }
  assert.deepEqual(parse("1250").product?.priceSignals, [{ raw: "USD 12.5", currency: "USD", amount: 12.5 }]);
});

test("quantity steering excludes differently sized Shopify variants while preserving same-size choices", () => {
  const result = parseShopifyProduct({
    payload: {
      title: "Acme Tea",
      handle: "acme-tea",
      variants: [
        { title: "100g Red", price: 800 },
        { title: "100g Blue", price: 850 },
        { title: "500g", price: 3000 },
      ],
    },
    requestedKey: "acme-tea",
    sourceUrl: "https://shop.test/products/acme-tea",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "USD",
    expectedQuantity: parseCanonicalQuantity("100g") || undefined,
  });
  assert.deepEqual(result.product?.priceSignals.map((signal) => signal.amount), [8, 8.5]);
  assert.equal(result.product?.priceSignals.some((signal) => signal.amount === 30), false);
});

test("quantity steering does not fall back to differently sized Shopify variants", () => {
  const result = parseShopifyProduct({
    payload: {
      title: "Acme Tea",
      handle: "acme-tea",
      variants: [
        { title: "500g", price: 1000 },
        { title: "1kg", price: 1000 },
      ],
    },
    requestedKey: "acme-tea",
    sourceUrl: "https://shop.test/products/acme-tea",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "USD",
    expectedQuantity: parseCanonicalQuantity("100g") || undefined,
  });
  assert.deepEqual(result.product?.priceSignals, []);
  assert.match(result.gap, /every selected variant/i);
});

test("uses Shopify's fixed hundredths contract for zero- and three-decimal currencies", () => {
  const parse = (currency, price) => parseShopifyProduct({
    payload: { title: "Currency Test Product", handle: "currency-test", variants: [{ title: "Default Title", price }] },
    requestedKey: "currency-test",
    sourceUrl: "https://shop.test/products/currency-test",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency,
  }).product?.priceSignals[0];
  assert.deepEqual(parse("JPY", 100000), { raw: "JPY 1000", currency: "JPY", amount: 1000 });
  assert.deepEqual(parse("KWD", 900), { raw: "KWD 9", currency: "KWD", amount: 9 });
  assert.equal(parse("GBP", 0), undefined);
});

test("strips storefront HTML from product descriptions", () => {
  const result = parseShopifyProduct({
    payload: {
      title: "Pistachio Maamoul 500g",
      handle: "pistachio-maamoul-500g",
      description: '<p>Filled with <strong>pistachio</strong> &amp; dates.</p><script>alert("ignore")</script>',
      variants: [{ title: "Default Title", price: 1200 }],
    },
    requestedKey: "pistachio-maamoul-500g",
    sourceUrl: "https://shop.test/products/pistachio-maamoul-500g",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
    currency: "GBP",
  });
  assert.equal(result.product?.description, "Filled with pistachio & dates.");
});

test("parses a matching WooCommerce Store API product and rejects a different slug", () => {
  const payload = [{
    name: "White Onion",
    slug: "white-onion",
    sku: "ONION-WHITE",
    prices: { price: "114", currency_code: "GBP", currency_minor_unit: 2 },
    images: [{ src: "https://mymeatshop.co.uk/wp-content/onion.jpg" }],
  }];
  const result = parseWooCommerceProduct({
    payload,
    requestedKey: "white-onion",
    sourceUrl: "https://mymeatshop.co.uk/product/white-onion/",
    domain: "mymeatshop.co.uk",
    observedAt: "2026-07-20T10:00:00.000Z",
  });
  assert.equal(result.product?.imageUrl, "https://mymeatshop.co.uk/wp-content/onion.jpg");
  assert.deepEqual(result.product?.priceSignals, [{ raw: "GBP 1.14", currency: "GBP", amount: 1.14 }]);
  assert.equal(parseWooCommerceProduct({
    payload,
    requestedKey: "red-onion",
    sourceUrl: "https://mymeatshop.co.uk/product/red-onion/",
    domain: "mymeatshop.co.uk",
    observedAt: "2026-07-20T10:00:00.000Z",
  }).product, null);
});

test("keeps a WooCommerce variable-product price range non-comparable", () => {
  const result = parseWooCommerceProduct({
    payload: [{
      name: "Date Box",
      slug: "date-box",
      short_description: "<p>Choose a <strong>box size</strong>.</p>",
      prices: {
        price: "100",
        currency_code: "GBP",
        currency_minor_unit: 2,
        price_range: { min_amount: "100", max_amount: "250" },
      },
    }],
    requestedKey: "date-box",
    sourceUrl: "https://shop.test/product/date-box/",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
  });
  assert.deepEqual(result.product?.priceSignals.map((signal) => signal.amount), [1, 2.5]);
  assert.equal(result.product?.description, "Choose a box size.");
});

test("rejects WooCommerce zero and coercible empty prices while retaining product evidence", () => {
  for (const value of ["0", "", null, false, "not-a-price"]) {
    const result = parseWooCommerceProduct({
      payload: [{
        name: value === "0" ? "Free Range Eggs 6pk" : "Spring Onions",
        slug: "spring-onions",
        is_purchasable: true,
        prices: { price: value, currency_code: "GBP", currency_minor_unit: 2 },
        images: [{ src: "https://grocer.test/spring-onions.jpg" }],
      }],
      requestedKey: "spring-onions",
      sourceUrl: "https://grocer.test/product/spring-onions/",
      domain: "grocer.test",
      observedAt: "2026-07-20T10:00:00.000Z",
    });
    assert.equal(result.product?.name, value === "0" ? "Free Range Eggs 6pk" : "Spring Onions");
    assert.equal(result.product?.imageUrl, "https://grocer.test/spring-onions.jpg");
    assert.deepEqual(result.product?.priceSignals, []);
    assert.match(result.gap, /zero, empty, or invalid price/i);
  }
});

test("rejects incomplete WooCommerce ranges instead of treating one positive endpoint as fixed", () => {
  for (const minAmount of ["0", ""]) {
    const result = parseWooCommerceProduct({
      payload: [{
        name: "Date Box",
        slug: "date-box",
        prices: {
          price: "250",
          currency_code: "GBP",
          currency_minor_unit: 2,
          price_range: { min_amount: minAmount, max_amount: "250" },
        },
      }],
      requestedKey: "date-box",
      sourceUrl: "https://shop.test/product/date-box/",
      domain: "shop.test",
      observedAt: "2026-07-20T10:00:00.000Z",
    });
    assert.deepEqual(result.product?.priceSignals, []);
    assert.match(result.gap, /incomplete price range/i);
  }
});

test("keeps a complete positive WooCommerce range unavailable when currency is unconfirmed", () => {
  const result = parseWooCommerceProduct({
    payload: [{
      name: "Date Box",
      slug: "date-box",
      prices: { price: "100", currency_code: "", currency_minor_unit: 2, price_range: { min_amount: "100", max_amount: "250" } },
    }],
    requestedKey: "date-box",
    sourceUrl: "https://shop.test/product/date-box/",
    domain: "shop.test",
    observedAt: "2026-07-20T10:00:00.000Z",
  });
  assert.deepEqual(result.product?.priceSignals, []);
  assert.match(result.gap, /without a confirmed ISO currency/i);
});
