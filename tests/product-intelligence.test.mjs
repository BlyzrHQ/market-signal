import assert from "node:assert/strict";
import test from "node:test";

import { applyFinalProductEnrichment, applyPreMatchCatalogEnrichment, buildProductComparison, buildProductPairCandidateIndex, catalogReplacementAuditAttribute, extractFirstPartyOfferings, extractProductsFromHtml, extractProductsFromSitemap, planPreliminaryCatalogReconciliation, retrieveProductPairCandidates, scoreProductPair, selectFinalProductEnrichmentTargets, selectPreferredProducts, selectProductEnrichmentTargets, validateProductPageIdentity } from "../app/lib/product-intelligence.ts";

function extraction(overrides = {}) {
  return extractProductsFromHtml({
    document: "<html><head><title>Acme</title></head><body><h1>Acme</h1></body></html>",
    sourceUrl: "https://acme.com/",
    domain: "acme.com",
    observedAt: "2026-07-12T00:00:00.000Z",
    pageTitle: "Acme",
    pageDescription: "",
    headings: ["Acme"],
    pagePriceSignals: [],
    ...overrides,
  });
}

function product(id, domain, name, category = "inventory", description = "inventory operations") {
  return {
    id,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description,
    category,
    jsonLdType: "SoftwareApplication",
    priceSignals: [],
    attributes: [],
    ownership: "self-declared-brand",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://${domain}/${id}`,
    imageUrl: "",
    observedAt: "2026-07-12T00:00:00.000Z",
    claimIds: [`${id}-observed`],
  };
}

test("extracts owned JSON-LD products, @graph nodes, arrays, and offers", () => {
  const document = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [
      { "@type": "Product", name: "Acme Widget", brand: { name: "Acme" }, category: "Widgets", offers: [{ price: "29", priceCurrency: "USD" }] },
      { "@type": "SoftwareApplication", name: "Acme Cloud", provider: { url: "https://acme.com/about" }, applicationCategory: "Operations", offers: { lowPrice: 10, highPrice: 40, priceCurrency: "USD" } },
    ],
  })}</script>`;
  const result = extraction({ document });
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products.map((item) => item.name), ["Acme Widget", "Acme Cloud"]);
  assert.equal(result.products[0].ownership, "self-declared-brand");
  assert.match(result.products[0].priceSignals[0].raw, /USD 29/);
  assert.equal(result.products[1].priceSignals.length, 2);
  assert.ok(result.products.every((item) => item.claimIds[0].endsWith("-observed")));
});

test("excludes third-party-branded JSON-LD from the domain catalog", () => {
  const document = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Rival Widget", brand: { name: "Rival Corp", url: "https://rival.example" } })}</script>`;
  const result = extraction({ document, sourceUrl: "https://acme.com/reviews/rival-widget" });
  assert.equal(result.products.length, 0);
  assert.equal(result.thirdPartyReferenced.length, 1);
  assert.equal(result.thirdPartyReferenced[0].ownership, "third-party-referenced");
});

test("does not manufacture products from generic homepages or blog prose", () => {
  const homepage = extraction({ document: "<h1>Welcome to Acme</h1><p>Projects from $20 per month.</p>", pagePriceSignals: ["$20/month"] });
  const blog = extraction({ document: "<h1>Pricing trends</h1><p>Plans cost $20.</p>", sourceUrl: "https://acme.com/blog/pricing-trends", headings: ["Pricing trends", "What plans cost"], pagePriceSignals: ["$20"] });
  assert.equal(homepage.products.length, 0);
  assert.equal(blog.products.length, 0);
});

test("creates a medium-confidence page signal only with path and page structure", () => {
  const result = extraction({ sourceUrl: "https://acme.com/pricing", pageTitle: "Acme pricing", pageDescription: "Plans for growing teams", headings: ["Acme pricing", "Business plan", "Enterprise plan"], pagePriceSignals: ["$20/month"] });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].extraction, "page-signal");
  assert.equal(result.products[0].confidence, "Medium");
  assert.equal(result.products[0].ownership, "path-inferred");
  assert.deepEqual(result.products[0].priceSignals[0], { raw: "$20/month", currency: "USD", amount: 20, period: "month" });
});

test("extracts authoritative Shopify price metadata and prefers the secure product image", () => {
  const document = `<head>
    <meta property="og:price:amount" content="39.05">
    <meta property="og:price:currency" content="GBP">
    <meta property="og:image" content="http://myjam.co.uk/cdn/lamb-leg.jpg">
    <meta property="og:image:secure_url" content="https://cdn.shopify.com/lamb-leg.jpg">
  </head>`;
  const result = extraction({
    document,
    sourceUrl: "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g",
    domain: "myjam.co.uk",
    pageTitle: "Lamb Leg Halal apx 2500g | MyJam",
    headings: ["Lamb Leg Halal apx 2500g", "Choose your cut"],
  });
  assert.equal(result.products.length, 1);
  assert.deepEqual(result.products[0].priceSignals, [{ raw: "GBP 39.05", currency: "GBP", amount: 39.05, period: undefined }]);
  assert.equal(result.products[0].imageUrl, "https://cdn.shopify.com/lamb-leg.jpg");
});

test("rejects negative structured and metadata prices instead of making them positive", () => {
  const structured = extraction({
    document: `<script type="application/ld+json">${JSON.stringify([
      { "@type": "Product", name: "Acme Numeric Negative", brand: { name: "Acme" }, offers: { price: -12.5, priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme String Negative", brand: { name: "Acme" }, offers: { price: "-12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Unicode Negative", brand: { name: "Acme" }, offers: { price: "−12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Encoded Negative", brand: { name: "Acme" }, offers: { price: "&minus;12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Named Hyphen Negative", brand: { name: "Acme" }, offers: { price: "&hyphen;$12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Named Dash Negative", brand: { name: "Acme" }, offers: { price: "&dash;$12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Decimal Entity Negative", brand: { name: "Acme" }, offers: { price: "&#45;12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Hex Entity Negative", brand: { name: "Acme" }, offers: { price: "&#x2d;12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Hyphen Negative", brand: { name: "Acme" }, offers: { price: "\u201012.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Nonbreaking Hyphen Negative", brand: { name: "Acme" }, offers: { price: "\u201112.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Figure Dash Negative", brand: { name: "Acme" }, offers: { price: "\u201212.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Small Hyphen Negative", brand: { name: "Acme" }, offers: { price: "\ufe6312.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Fullwidth Hyphen Negative", brand: { name: "Acme" }, offers: { price: "\uff0d12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Superscript Minus Negative", brand: { name: "Acme" }, offers: { price: "\u207b12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Subscript Minus Negative", brand: { name: "Acme" }, offers: { price: "\u208b12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Heavy Minus Negative", brand: { name: "Acme" }, offers: { price: "\u279612.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Circled Minus Negative", brand: { name: "Acme" }, offers: { price: "\u229612.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Dot Minus Negative", brand: { name: "Acme" }, offers: { price: "\u223812.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Minus Plus Negative", brand: { name: "Acme" }, offers: { price: "\u221312.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Named Ominus Negative", brand: { name: "Acme" }, offers: { price: "&ominus;12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme KWD Negative", brand: { name: "Acme" }, offers: { price: "−د.ك 12", priceCurrency: "KWD" } },
      { "@type": "Product", name: "Acme Spaced Negative", brand: { name: "Acme" }, offers: { price: "- $12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Accounting Negative", brand: { name: "Acme" }, offers: { price: "($12.50)", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Trailing Negative", brand: { name: "Acme" }, offers: { price: "$12.50-", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Labeled Negative", brand: { name: "Acme" }, offers: { price: "Price: -$12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Entity Labeled Negative", brand: { name: "Acme" }, offers: { price: "Price&colon;&minus;$12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Equals Entity Negative", brand: { name: "Acme" }, offers: { price: "Price&equals;&minus;$12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Semicolonless Decimal Negative", brand: { name: "Acme" }, offers: { price: "&#45 $12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Semicolonless Hex Negative", brand: { name: "Acme" }, offers: { price: "&#x2d $12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Malformed Entity Negative", brand: { name: "Acme" }, offers: { price: "&#45USD 12.50", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Contradictory Currency", brand: { name: "Acme" }, offers: { price: "$12.50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme ISO Contradiction", brand: { name: "Acme" }, offers: { price: "USD 0", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Trailing ISO Contradiction", brand: { name: "Acme" }, offers: { price: "12.50 GBP", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Named Currency Contradiction", brand: { name: "Acme" }, offers: { price: "&dollar;12.50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Numeric Currency Contradiction", brand: { name: "Acme" }, offers: { price: "&#36;12.50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Mixed ISO Contradiction", brand: { name: "Acme" }, offers: { price: "USD 12 / EUR 10", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Incomplete Range With Point", brand: { name: "Acme" }, offers: { price: 19.99, lowPrice: 0, highPrice: 29.99, priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Semicolonless Numeric Currency Contradiction", brand: { name: "Acme" }, offers: { price: "&#36 12.50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Semicolonless Hex Currency Contradiction", brand: { name: "Acme" }, offers: { price: "&#x24 12.50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Yen Currency Contradiction", brand: { name: "Acme" }, offers: { price: "¥1200", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Lower ISO Currency Contradiction", brand: { name: "Acme" }, offers: { price: "12.50 usd", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Semicolonless Named Currency Contradiction", brand: { name: "Acme" }, offers: { price: "&pound 12.50", priceCurrency: "EUR" } },
      { "@type": "Product", name: "Acme Yen Entity Currency Contradiction", brand: { name: "Acme" }, offers: { price: "&yen;1200", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme MXN Currency Contradiction", brand: { name: "Acme" }, offers: { price: "MXN 1200", priceCurrency: "USD" } },
    ])}</script>`,
    sourceUrl: "https://acme.com/products/negative-catalog",
  });
  assert.equal(structured.products.length, 44);
  assert.ok(structured.products.every((item) => item.priceSignals.length === 0), structured.products.filter((item) => item.priceSignals.length).map((item) => item.name).join(", "));

  const metadata = extraction({
    document: `<head><meta property="og:price:amount" content="-12.50"><meta property="og:price:currency" content="USD"></head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Acme Negative Widget", brand: { name: "Acme" },
    })}</script>`,
    sourceUrl: "https://acme.com/products/negative-widget",
    pageTitle: "Acme Negative Widget",
    headings: ["Acme Negative Widget"],
  });
  assert.equal(metadata.products.length, 1);
  assert.deepEqual(metadata.products[0].priceSignals, []);

  const accountingMetadata = extraction({
    document: `<head><meta property="product:price:amount" content="($12.50)"><meta property="product:price:currency" content="USD"></head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Acme Accounting Widget", brand: { name: "Acme" },
    })}</script>`,
    sourceUrl: "https://acme.com/products/accounting-widget",
    pageTitle: "Acme Accounting Widget",
    headings: ["Acme Accounting Widget"],
  });
  assert.equal(accountingMetadata.products.length, 1);
  assert.deepEqual(accountingMetadata.products[0].priceSignals, []);

  const entityMetadata = extraction({
    document: `<head><meta property="product:price:amount" content="&#45;12.50"><meta property="product:price:currency" content="USD"></head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Acme Entity Widget", brand: { name: "Acme" },
    })}</script>`,
    sourceUrl: "https://acme.com/products/entity-widget",
    pageTitle: "Acme Entity Widget",
    headings: ["Acme Entity Widget"],
  });
  assert.equal(entityMetadata.products.length, 1);
  assert.deepEqual(entityMetadata.products[0].priceSignals, []);
});

test("rejects conflicting or inactive Open Graph price metadata", () => {
  const product = { "@type": "Product", name: "Acme Metadata Widget", brand: { name: "Acme" } };
  const conflicting = extraction({
    document: `<head><meta property="product:price:amount" content="12.50"><meta property="product:price:currency" content="USD"><meta property="product:price:currency" content="EUR"></head><script type="application/ld+json">${JSON.stringify(product)}</script>`,
    sourceUrl: "https://acme.com/products/metadata-widget",
  });
  assert.deepEqual(conflicting.products[0].priceSignals, []);

  const commented = extraction({
    document: `<head><!-- <meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD"> --></head><script type="application/ld+json">${JSON.stringify(product)}</script>`,
    sourceUrl: "https://acme.com/products/metadata-widget",
  });
  assert.deepEqual(commented.products[0].priceSignals, []);

  for (const inert of [
    '<script>const example = `<meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD">`;</script>',
    '<template><meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD"></template>',
    '<!-- <meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD">',
    '<template><template><meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD"></template></template>',
    '<textarea><meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD"></textarea>',
    '<title><meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD"></title>',
    '<iframe srcdoc="<meta property=\'product:price:amount\' content=\'77\'><meta property=\'product:price:currency\' content=\'USD\'>"></iframe>',
    '<xmp><meta property="product:price:amount" content="77"><meta property="product:price:currency" content="USD"></xmp>',
  ]) {
    const result = extraction({ document: `<script type="application/ld+json">${JSON.stringify(product)}</script>${inert}`, sourceUrl: "https://acme.com/products/metadata-widget" });
    assert.deepEqual(result.products[0].priceSignals, []);
  }
});

test("does not infer ISO currencies from lowercase ordinary prose", () => {
  const result = extraction({
    document: `<script type="application/ld+json">${JSON.stringify([
      { "@type": "Product", name: "Acme All", offers: { price: "for all 19.99" } },
      { "@type": "Product", name: "Acme Try", offers: { price: "try 19.99" } },
      { "@type": "Product", name: "Acme Upper All", offers: { price: "FOR ALL 19.99" } },
      { "@type": "Product", name: "Acme Upper Try", offers: { price: "TRY 19.99" } },
    ])}</script>`,
    sourceUrl: "https://acme.com/products/prose",
  });
  assert.ok(result.products.every((item) => item.priceSignals.every((signal) => !signal.currency)));
});

test("preserves explicitly positive and decorated positive structured prices", () => {
  const result = extraction({
    document: `<script type="application/ld+json">${JSON.stringify([
      { "@type": "Product", name: "Acme Explicit Positive", offers: { price: "+19.99", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Star Price", offers: { price: "★ $19.99", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Approximate Price", offers: { price: "≈$19.99", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Sale Price Label", offers: { price: "sale-price USD 19.99", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Sale Separator", offers: { price: "Sale - USD 19.99", priceCurrency: "USD" } },
      { "@type": "Product", name: "Acme Now Separator", offers: { price: "Now - 19.99 USD", priceCurrency: "USD" } },
    ])}</script>`,
    sourceUrl: "https://acme.com/products/positive-catalog",
  });
  assert.equal(result.products.length, 6);
  assert.ok(result.products.every((item) => item.priceSignals[0]?.amount === 19.99));
});

test("ignores out-of-range numeric price entities without crashing extraction", () => {
  const result = extraction({
    document: `<head><meta property="og:price:amount" content="&#9999999999;"><meta property="og:price:currency" content="USD"></head><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Acme Safe Widget", brand: { name: "Acme" } })}</script>`,
    sourceUrl: "https://acme.com/products/safe-widget",
  });
  assert.equal(result.products.length, 1);
  assert.deepEqual(result.products[0].priceSignals, []);
});

test("prefers an exact product H1 when a marketing-prefixed title contains that identity", () => {
  const document = `<head><meta property="product:price:amount" content="39.05"><meta property="product:price:currency" content="GBP"></head>`;
  const result = extraction({
    document,
    sourceUrl: "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g",
    domain: "myjam.co.uk",
    pageTitle: "Fresh halal lamb meat: Order Lamb Leg Halal apx 2500g | MyJam",
    headings: ["Lamb Leg Halal apx 2500g", "Product details"],
  });

  assert.equal(result.products[0].name, "Lamb Leg Halal apx 2500g");
  assert.equal(result.products[0].priceSignals[0].currency, "GBP");
});

test("supplements the title-matched JSON-LD product from same-page metadata and resolves public images", () => {
  const document = `<head>
    <meta property="product:price:amount" content="43.20">
    <meta property="product:price:currency" content="USD">
    <meta name="twitter:image" content="/media/pistachio-maamoul.jpg">
  </head><script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "Zaitoune Mamoul With Pistachio 500g",
    brand: { name: "Zaitoune" },
  })}</script>`;
  const result = extraction({
    document,
    sourceUrl: "https://www.babanuj.com/product/zaitoune-sweets-pistachio-maamoul-500g",
    domain: "babanuj.com",
    pageTitle: "Zaitoune Mamoul With Pistachio 500g | Babanuj",
    headings: ["Zaitoune Mamoul With Pistachio 500g"],
  });

  assert.deepEqual(result.products[0].priceSignals, [{ raw: "USD 43.20", currency: "USD", amount: 43.2, period: undefined }]);
  assert.equal(result.products[0].imageUrl, "https://www.babanuj.com/media/pistachio-maamoul.jpg");
});

test("same-page metadata supplements only the exact title product and never a related product", () => {
  const document = `<head>
    <meta property="product:price:amount" content="43.20">
    <meta property="product:price:currency" content="USD">
    <meta property="og:image" content="https://cdn.shopify.com/pistachio-maamoul.jpg">
  </head><script type="application/ld+json">${JSON.stringify([
    { "@type": "Product", name: "Zaitoune Mamoul With Pistachio 500g", brand: { name: "Zaitoune" } },
    { "@type": "Product", name: "Zaitoune Mamoul With Walnut 500g", brand: { name: "Zaitoune" } },
  ])}</script>`;
  const result = extraction({
    document,
    sourceUrl: "https://www.babanuj.com/product/zaitoune-sweets-pistachio-maamoul-500g",
    domain: "babanuj.com",
    pageTitle: "Zaitoune Mamoul With Pistachio 500g | Babanuj",
  });
  const target = result.products.find((item) => item.name.includes("Pistachio"));
  const related = result.products.find((item) => item.name.includes("Walnut"));

  assert.equal(target.priceSignals[0].amount, 43.2);
  assert.equal(target.imageUrl, "https://cdn.shopify.com/pistachio-maamoul.jpg");
  assert.deepEqual(related.priceSignals, []);
  assert.equal(related.imageUrl, "");
});

test("same-page metadata is rejected when two structured products claim the exact page identity", () => {
  const document = `<head>
    <meta property="product:price:amount" content="43.20">
    <meta property="product:price:currency" content="USD">
    <meta property="og:image" content="https://cdn.shopify.com/ambiguous.jpg">
  </head><script type="application/ld+json">${JSON.stringify([
    { "@type": "Product", "@id": "primary", name: "Zaitoune Mamoul With Pistachio 500g", brand: { name: "Zaitoune" } },
    { "@type": "Product", "@id": "related", name: "Zaitoune Mamoul With Pistachio 500g", brand: { name: "Zaitoune" } },
  ])}</script>`;
  const result = extraction({
    document,
    sourceUrl: "https://www.babanuj.com/product/zaitoune-sweets-pistachio-maamoul-500g",
    domain: "babanuj.com",
    pageTitle: "Zaitoune Mamoul With Pistachio 500g | Babanuj",
  });

  assert.deepEqual(result.products[0].priceSignals, []);
  assert.equal(result.products[0].imageUrl, "");
});

test("resolves a protocol-relative structured product image against the public product page", () => {
  const document = `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: "Zaitoune Mamoul With Dates 500g",
    brand: { name: "Zaitoune" },
    image: "//cdn.shopify.com/s/files/date-maamoul.jpg",
    offers: { price: "21.60", priceCurrency: "USD" },
  })}</script>`;
  const result = extraction({
    document,
    sourceUrl: "https://www.babanuj.com/product/zaitoune-dates-maamoul-500g",
    domain: "babanuj.com",
    pageTitle: "Zaitoune Mamoul With Dates 500g | Babanuj",
  });

  assert.equal(result.products[0].imageUrl, "https://cdn.shopify.com/s/files/date-maamoul.jpg");
});

test("does not treat a shipping threshold as an exact product price", () => {
  const result = extraction({
    document: "<h1>Organic Honey 500g</h1><h2>Product details</h2><p>Free shipping over $75</p>",
    sourceUrl: "https://shop.example/products/organic-honey-500g",
    domain: "shop.example",
    pageTitle: "Organic Honey 500g | Shop",
    headings: ["Organic Honey 500g", "Product details"],
    pagePriceSignals: ["$75"],
  });

  assert.equal(result.products.length, 1);
  assert.deepEqual(result.products[0].priceSignals, []);
});

test("creates a page signal for a branded shallow product page but not a company page", () => {
  const productPage = extraction({ sourceUrl: "https://acme.com/billing", pageTitle: "Acme Billing | Subscription management", headings: ["Acme Billing", "Automate invoices", "Manage subscriptions", "Recover revenue"] });
  const companyPage = extraction({ sourceUrl: "https://acme.com/company", pageTitle: "Acme Company", headings: ["Our company", "Our mission", "Our team", "Our offices"] });
  assert.equal(productPage.products.length, 1);
  assert.equal(productPage.products[0].name, "Acme Billing");
  assert.equal(companyPage.products.length, 0);
});

test("rejects generic shallow pages while preserving evidence-backed product pages", () => {
  const details = { pageTitle: "Acme", headings: ["Acme", "Built for teams", "Useful features", "Get started"] };
  const customers = extraction({ ...details, sourceUrl: "https://acme.com/customers" });
  const jobs = extraction({ ...details, sourceUrl: "https://acme.com/jobs" });
  const team = extraction({ ...details, sourceUrl: "https://acme.com/team", pageTitle: "Our team | Acme", headings: ["Our team", "Leadership", "Board", "Values"] });
  const industries = extraction({ ...details, sourceUrl: "https://acme.com/industries", pageTitle: "Industries | Acme", headings: ["Industries we serve", "Retail", "Healthcare", "Fintech"] });
  const community = extraction({ ...details, sourceUrl: "https://acme.com/community", pageTitle: "Community | Acme", headings: ["Community", "Built for teams", "Product features", "Pricing plans"], pagePriceSignals: ["$20/month"] });
  const payments = extraction({ ...details, sourceUrl: "https://acme.com/payments", pageTitle: "Acme Payments", headings: ["Acme Payments", "Accept payments online", "Optimize checkout", "Fight fraud"] });
  const features = extraction({ sourceUrl: "https://acme.com/features", pageTitle: "Features", headings: ["Product features", "Useful features", "Built for teams"] });
  assert.equal(customers.products.length, 0);
  assert.equal(jobs.products.length, 0);
  assert.equal(team.products.length, 0);
  assert.equal(industries.products.length, 0);
  assert.equal(community.products.length, 0);
  assert.equal(payments.products.length, 1);
  assert.equal(features.products.length, 0);
});

test("catalog deduplication preserves high-confidence structured evidence", () => {
  const structured = product("structured", "acme.com", "Acme Billing");
  const pageSignal = { ...structured, id: "page", extraction: "page-signal", confidence: "Medium", sourceUrl: "https://acme.com/billing" };
  assert.equal(selectPreferredProducts([structured, pageSignal])[0].id, "structured");
  assert.equal(selectPreferredProducts([pageSignal, structured])[0].id, "structured");
});

test("catalog deduplication collapses locale variants of the same product URL", () => {
  const arabic = {
    ...product("bundle-ar", "shop.example", "\u0645\u062c\u0645\u0648\u0639\u0629 \u0627\u0644\u062f\u0642\u064a\u0642"),
    jsonLdType: "Product",
    sourceUrl: "https://shop.example/ar/products/flours-bundle",
    claimIds: ["bundle-ar-observed"],
  };
  const english = {
    ...product("bundle-en", "shop.example", "Flours Value Bundle"),
    jsonLdType: "Product",
    sourceUrl: "https://shop.example/products/flours-bundle",
    priceSignals: [{ raw: "KWD 9.00", currency: "KWD", amount: 9 }],
    claimIds: ["bundle-en-observed"],
  };

  const selected = selectPreferredProducts([arabic, english]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, english.id);
  assert.deepEqual(new Set(selected[0].claimIds), new Set(["bundle-ar-observed", "bundle-en-observed"]));
});

test("catalog enrichment keeps a secure sitemap image while adding a page price", () => {
  const sitemap = {
    ...product("sitemap", "myjam.co.uk", "Lamb Leg Halal apx 2500g"),
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl: "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g",
    imageUrl: "https://cdn.shopify.com/lamb-leg.jpg",
  };
  const enriched = {
    ...sitemap,
    id: "page",
    extraction: "page-signal",
    priceSignals: [{ raw: "GBP 39.05", currency: "GBP", amount: 39.05 }],
    imageUrl: "http://myjam.co.uk/cdn/lamb-leg.jpg",
  };
  const selected = selectPreferredProducts([sitemap, enriched]);
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].priceSignals, enriched.priceSignals);
  assert.equal(selected[0].imageUrl, sitemap.imageUrl);
});

test("rejects enrichment when the fetched product contradicts the requested product URL", () => {
  const expected = {
    ...product("amul-butter", "egrocers.uk", "Amul Butter 500g"),
    jsonLdType: "Product",
    extraction: "sitemap",
    sourceUrl: "https://www.egrocers.uk/product/amul-butter-500-g/",
  };
  const fetched = {
    ...product("beef-on-bone", "egrocers.uk", "Beef On The Bone"),
    jsonLdType: "Product",
    sourceUrl: expected.sourceUrl,
    priceSignals: [{ raw: "GBP 13.00", currency: "GBP", amount: 13 }],
  };
  const result = validateProductPageIdentity([expected], [fetched], "Beef On The Bone – E-Grocers UK");
  assert.equal(result.accepted, false);
  assert.deepEqual(result.products, []);
  assert.match(result.reason, /contradicts/i);
});

test("accepts harmless Babanuj sitemap title drift on the exact final product URL", () => {
  const sourceUrl = "https://www.babanuj.com/product/zaitoune-sweets-pistachio-maamoul-500g";
  const expected = {
    ...product("babanuj-sitemap", "babanuj.com", "zaitoune sweets pistachio maamoul 500g"),
    jsonLdType: "Product",
    extraction: "sitemap",
    sourceUrl,
    quantity: { kind: "mass", amount: 500, unit: "g" },
  };
  const fetched = {
    ...product("babanuj-live", "babanuj.com", "Zaitoune Mamoul With Pistachio 500g"),
    normalizedName: "zaitoune mamoul with pistachio 500g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 500, unit: "g" },
    priceSignals: [{ raw: "USD 43.2", currency: "USD", amount: 43.2 }],
    imageUrl: "https://cdn.shopify.com/zaitoune-maamoul.jpg",
  };

  const result = validateProductPageIdentity([expected], [fetched], fetched.name);
  assert.equal(result.accepted, true);
  assert.equal(result.products[0].name, fetched.name);
});

test("accepts an exact singular-to-plural product term without broad short-token fuzziness", () => {
  const sourceUrl = "https://www.babanuj.com/product/zaitoune-maamoul-date-250g";
  const expected = {
    ...product("date-sitemap", "babanuj.com", "Zaitoune Maamoul Date 250g"),
    normalizedName: "zaitoune maamoul date 250g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 250, unit: "g" },
  };
  const fetched = {
    ...product("date-live", "babanuj.com", "Zaitoune Mamoul With Dates 250g"),
    normalizedName: "zaitoune mamoul with dates 250g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 250, unit: "g" },
  };

  assert.equal(validateProductPageIdentity([expected], [fetched], fetched.name).accepted, true);
});

test("prefers the most specific accepted Product node over extraction order", () => {
  const sourceUrl = "https://www.babanuj.com/product/zaitoune-pistachio-maamoul-500g";
  const expected = {
    ...product("specific-sitemap", "babanuj.com", "Zaitoune Pistachio Maamoul 500g"),
    normalizedName: "zaitoune pistachio maamoul 500g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 500, unit: "g" },
  };
  const generic = {
    ...product("generic-node", "babanuj.com", "Zaitoune Maamoul"),
    normalizedName: "zaitoune maamoul",
    jsonLdType: "Product",
    sourceUrl,
  };
  const specific = {
    ...product("specific-node", "babanuj.com", "Zaitoune Mamoul With Pistachio 500g"),
    normalizedName: "zaitoune mamoul with pistachio 500g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 500, unit: "g" },
  };

  const result = validateProductPageIdentity([expected], [generic, specific], specific.name);
  assert.equal(result.accepted, true);
  assert.equal(result.products[0].id, specific.id);
});

test("rejects a repurposed same-URL product and conflicting variants", () => {
  const sourceUrl = "https://www.babanuj.com/product/zaitoune-sweets-mixed-nawashif-500g";
  const expected = {
    ...product("stale", "babanuj.com", "Zaitoune Sweets Mixed Nawashif 500g"),
    normalizedName: "zaitoune sweets mixed nawashif 500g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 500, unit: "g" },
  };
  const repurposed = {
    ...product("live", "babanuj.com", "Zaitoune Sesame Cookies Barazek 500g"),
    normalizedName: "zaitoune sesame cookies barazek 500g",
    jsonLdType: "Product",
    sourceUrl,
    quantity: { kind: "mass", amount: 500, unit: "g" },
  };
  const conflictingVariant = {
    ...product("walnut", "babanuj.com", "Zaitoune Walnut Maamoul 500g"),
    normalizedName: "zaitoune walnut maamoul 500g",
    jsonLdType: "Product",
    sourceUrl: "https://www.babanuj.com/product/zaitoune-pistachio-maamoul-500g",
    quantity: { kind: "mass", amount: 500, unit: "g" },
  };
  const pistachio = {
    ...expected,
    name: "Zaitoune Pistachio Maamoul 500g",
    normalizedName: "zaitoune pistachio maamoul 500g",
    sourceUrl: conflictingVariant.sourceUrl,
  };

  assert.equal(validateProductPageIdentity([expected], [repurposed], repurposed.name).accepted, false);
  assert.equal(validateProductPageIdentity([pistachio], [conflictingVariant], conflictingVariant.name).accepted, false);
});

test("rejects enrichment when quantity, SKU, or final product URL conflicts", () => {
  const base = {
    ...product("expected", "babanuj.com", "Zaitoune Pistachio Maamoul 500g"),
    normalizedName: "zaitoune pistachio maamoul 500g",
    jsonLdType: "Product",
    sourceUrl: "https://www.babanuj.com/product/zaitoune-pistachio-maamoul-500g",
    quantity: { kind: "mass", amount: 500, unit: "g" },
    identifiers: { gtins: [], sku: "PISTACHIO-500" },
  };
  const wrongQuantity = { ...base, id: "wrong-quantity", quantity: { kind: "mass", amount: 600, unit: "g" } };
  const wrongSku = { ...base, id: "wrong-sku", identifiers: { gtins: [], sku: "WALNUT-500" } };
  const redirected = { ...base, id: "redirected", sourceUrl: "https://www.babanuj.com/product/zaitoune-pistachio-maamoul-new" };

  assert.equal(validateProductPageIdentity([base], [wrongQuantity], wrongQuantity.name).accepted, false);
  assert.equal(validateProductPageIdentity([base], [wrongSku], wrongSku.name).accepted, false);
  assert.equal(validateProductPageIdentity([base], [redirected], redirected.name).accepted, true, "an identical structured name remains authoritative even if the canonical source URL changed");
  const driftedRedirect = { ...redirected, name: "Zaitoune Mamoul With Pistachio 500g", normalizedName: "zaitoune mamoul with pistachio 500g" };
  assert.equal(validateProductPageIdentity([base], [driftedRedirect], driftedRedirect.name).accepted, false);
});

test("malformed JSON-LD becomes a visible extraction gap without throwing", () => {
  const result = extraction({ document: '<script type="application/ld+json">{"@type":"Product",</script>' });
  assert.equal(result.products.length, 0);
  assert.equal(result.gaps.length, 1);
  assert.match(result.gaps[0], /Malformed JSON-LD/);
});

test("keeps third-party brands when the store is actually selling them on a product path", () => {
  const document = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Patchi Mixed Baklawa 500G", brand: { name: "Patchi" }, offers: { price: "12.99", priceCurrency: "GBP" } })}</script>`;
  const result = extraction({ document, sourceUrl: "https://grocer.example/products/patchi-mixed-baklawa-500g" });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].ownership, "path-inferred");
});

test("discovers real product records from a Shopify child sitemap", () => {
  const sitemap = `<?xml version="1.0"?><urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://myjam.co.uk/products/halal-lamb-chops-500g</loc><image:image><image:title>Halal Lamb Chops 500g</image:title><image:caption>Fresh halal lamb chops</image:caption></image:image></url><url><loc>https://myjam.co.uk/collections/meat</loc><image:image><image:title>Meat</image:title></image:image></url></urlset>`;
  const products = extractProductsFromSitemap(sitemap, "myjam.co.uk", "2026-07-13T00:00:00.000Z");
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Halal Lamb Chops 500g");
  assert.equal(products[0].extraction, "sitemap");
  assert.equal(products[0].sourceUrl, "https://myjam.co.uk/products/halal-lamb-chops-500g");
});

test("discovers locale-prefixed product and shop records from public sitemaps", () => {
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://shop.example/en-gb/product/sidr-honey-500g</loc><image:title>Sidr Honey 500g</image:title></url><url><loc>https://shop.example/ar/shop/baklava-box</loc><image:title>Baklava Box</image:title></url><url><loc>https://shop.example/en-gb/blog/honey-guide</loc></url></urlset>`;
  const products = extractProductsFromSitemap(sitemap, "shop.example", "2026-07-14T00:00:00.000Z");
  assert.deepEqual(products.map((item) => item.name), ["Sidr Honey 500g", "Baklava Box"]);
});

test("turns first-party SaaS capability headings into attributable service records", () => {
  const offerings = extractFirstPartyOfferings({
    domain: "buffer.com",
    observedAt: "2026-07-14T00:00:00.000Z",
    businessType: "saas",
    pages: [
      { sourceUrl: "https://buffer.com/", title: "Buffer: Social media management for everyone", description: "Manage social media in one place", headings: ["Publish and schedule posts", "Analyze social media performance", "Engage with your audience", "How to Run a Successful PR Agency in the Age of Social Media"] },
      { sourceUrl: "https://buffer.com/features", title: "Social media management features | Buffer", description: "Tools for creators and teams", headings: ["Plan your content calendar", "Collaborate on campaigns", "Build a landing page"] },
    ],
  });
  assert.ok(offerings.length >= 5);
  assert.ok(offerings.every((offering) => offering.sourceUrl.startsWith("https://buffer.com/")));
  assert.ok(offerings.some((offering) => /schedule posts/i.test(offering.name)));
  assert.ok(offerings.every((offering) => !/PR Agency/i.test(offering.name)));
});

test("does not turn business-type phrases into standalone comparable offerings", () => {
  const offerings = extractFirstPartyOfferings({
    domain: "buffer.com",
    observedAt: "2026-07-14T00:00:00.000Z",
    businessType: "saas",
    pages: [
      { sourceUrl: "https://buffer.com/features", title: "Buffer features", description: "Tools for growing brands", headings: ["Social media", "Mobile app", "Content creation", "AI social media scheduling", "Mobile app analytics for retailers"] },
    ],
  });
  assert.deepEqual(offerings.map((offering) => offering.name), ["AI social media scheduling", "Mobile app analytics for retailers"]);
});

test("extracts named SaaS plans and their nearest public recurring price", () => {
  const result = extraction({
    sourceUrl: "https://buffer.com/pricing",
    pageTitle: "Buffer pricing",
    pageDescription: "Flexible pricing for everyone",
    headings: ["Plans", "Free Placeholder", "Essentials Recommended", "Team Placeholder"],
    pagePriceSignals: ["$5 /month", "$10 /month"],
    document: `
      <h2>Plans</h2>
      <h2>Free <span>Placeholder</span></h2><p>Free forever</p><p>Connect up to 3 channels</p>
      <h2>Essentials <span>Recommended</span></h2><p>$5 /month</p><p>1 channel · billed yearly</p>
      <h2>Team <span>Placeholder</span></h2><p>$10 /month</p><p>1 channel · billed yearly</p>
    `,
  });
  const plans = result.products.filter((item) => item.category.startsWith("saas-plan"));
  assert.deepEqual(plans.map((item) => item.name), ["Free", "Essentials", "Team"]);
  assert.deepEqual(plans[1].priceSignals, [{ raw: "$5 /month", currency: "USD", amount: 5, period: "month" }]);
  assert.ok(plans[1].attributes.includes("Plan tier: entry"));
  assert.ok(plans[1].attributes.includes("Price basis: channel"));
  assert.ok(plans[1].attributes.includes("Billing commitment: annual"));
  assert.ok(plans.every((item) => item.sourceUrl === "https://buffer.com/pricing"));
});

test("retains explicit billing commitment after noisy duplicated price markup", () => {
  const duplicatedAccessiblePrices = `<span>$10 per user/month</span>`.repeat(300);
  const malformedShadowMarkup = `<template shadowroot="open"><style>:host{display:inline-block}<span>shadow digits</span></template >`;
  const result = extraction({
    domain: "linear.app",
    sourceUrl: "https://linear.app/pricing",
    pageTitle: "Linear pricing",
    headings: ["Basic"],
    pagePriceSignals: ["$10 per user/month"],
    document: `<h3>Basic</h3><span>$10 per user/month</span>${duplicatedAccessiblePrices}${malformedShadowMarkup}<p>Billed yearly</p><svg><path d="M0 0" /></svg><h3>Business</h3><p>$16 per user/month</p>`,
  });
  const basic = result.products.find((item) => item.name === "Basic");
  const business = result.products.find((item) => item.name === "Business");
  assert.deepEqual(basic.priceSignals, [{ raw: "$10 per user/month", currency: "USD", amount: 10, period: "month" }]);
  assert.ok(basic.attributes.includes("Billing commitment: annual"));
  assert.ok(!business.attributes.some((attribute) => attribute.startsWith("Billing commitment: annual")));
});

test("does not infer SaaS plans from unstructured pricing prose or feature names", () => {
  const result = extraction({
    sourceUrl: "https://metricool.com/pricing",
    pageTitle: "Metricool pricing",
    headings: ["Plans designed to give you peace of mind", "Start for free, scale up as your networks grow"],
    pagePriceSignals: ["€0/month", "€16/month", "€43/month"],
    document: `<h2>Start for free, scale up as your networks grow</h2><section>Annual Monthly EUR USD Free €0/month Start now Manage 1 brand Starter From €16/month Includes everything in Free Access to Advanced Analytics add-on Advanced €43/month Custom Contact sales</section>`,
  });
  assert.equal(result.products.filter((item) => item.category.startsWith("saas-plan")).length, 0);
});

test("matches differently named SaaS plans by tier and compares aligned per-user monthly prices", () => {
  const linear = extraction({
    domain: "linear.app",
    sourceUrl: "https://linear.app/pricing",
    pageTitle: "Linear pricing",
    headings: ["Pricing", "Free", "Basic", "Business", "Enterprise"],
    pagePriceSignals: ["$0", "$10 per user/month", "$16 per user/month"],
    document: `<h1>Pricing</h1><h2>Free</h2><p>$0 Free for everyone</p><h2>Basic</h2><p>$10 per user/month Billed yearly</p><h2>Business</h2><p>$16 per user/month Billed yearly</p><h2>Enterprise</h2><p>Custom Annual billing only Contact sales</p>`,
  }).products.filter((item) => item.category.startsWith("saas-plan"));
  const clickup = extraction({
    domain: "clickup.com",
    sourceUrl: "https://clickup.com/pricing",
    pageTitle: "ClickUp pricing",
    headings: ["free forever", "unlimited", "business", "enterprise"],
    pagePriceSignals: ["$7 per user/month", "$12 per user/month"],
    document: `<h2>free forever</h2><p>Free</p><h2>unlimited</h2><p>$7 Per user/month, billed yearly</p><h2>business</h2><p>$12 Per user/month, billed yearly</p><h2>enterprise</h2><p>Contact sales</p>`,
  }).products.filter((item) => item.category.startsWith("saas-plan"));
  const comparison = buildProductComparison("linear.app", [
    { domain: "linear.app", products: linear },
    { domain: "clickup.com", products: clickup },
  ]);
  const basic = comparison.rows.find((row) => row.primary.name === "Basic").matches[0];
  assert.equal(basic.product.name, "unlimited");
  assert.equal(basic.confidence, "Medium");
  assert.match(basic.decision.priceVerdict, /clickup\.com is USD 3\.00 cheaper/i);
  assert.deepEqual(basic.decision.priceComparison, { primaryRaw: "$10 per user/month", rivalRaw: "$7 Per user/month" });
});

test("does not emit an exact SaaS price delta across billing units, periods, or commitments", () => {
  const buffer = extraction({
    domain: "buffer.com",
    sourceUrl: "https://buffer.com/pricing",
    pageTitle: "Buffer pricing",
    headings: ["Essentials"],
    pagePriceSignals: ["$5 /month"],
    document: `<h2>Essentials</h2><p>$5 /month</p><p>1 channel billed yearly</p>`,
  }).products.find((item) => item.name === "Essentials");
  const later = extraction({
    domain: "later.com",
    sourceUrl: "https://later.com/pricing",
    pageTitle: "Later pricing",
    headings: ["Starter"],
    pagePriceSignals: ["$18.75 USD/month"],
    document: `<h2>Starter</h2><p>$18.75 USD/month</p><p>1 social set billed yearly</p>`,
  }).products.find((item) => item.name === "Starter");
  const yearly = { ...later, id: "later-yearly", priceSignals: [{ raw: "$180 USD/year", currency: "USD", amount: 180, period: "year" }], attributes: ["Plan tier: entry", "Price basis: channel"] };
  const monthlyCommitment = { ...later, id: "later-monthly", priceSignals: [{ raw: "$18.75 USD/month", currency: "USD", amount: 18.75, period: "month" }], attributes: ["Plan tier: entry", "Price basis: channel", "Billing commitment: monthly"] };
  const unitMismatch = buildProductComparison("buffer.com", [{ domain: "buffer.com", products: [buffer] }, { domain: "later.com", products: [later] }]).rows[0].matches[0];
  const periodMismatch = buildProductComparison("buffer.com", [{ domain: "buffer.com", products: [buffer] }, { domain: "later.com", products: [yearly] }]).rows[0].matches[0];
  const commitmentMismatch = buildProductComparison("buffer.com", [{ domain: "buffer.com", products: [buffer] }, { domain: "later.com", products: [monthlyCommitment] }]).rows[0].matches[0];
  assert.match(unitMismatch.decision.priceVerdict, /billing period, commitment, or unit basis is unresolved/i);
  assert.equal(unitMismatch.decision.priceComparison, null);
  assert.match(periodMismatch.decision.priceVerdict, /billing period, commitment, or unit basis is unresolved/i);
  assert.equal(periodMismatch.decision.priceComparison, null);
  assert.match(commitmentMismatch.decision.priceVerdict, /billing period, commitment, or unit basis is unresolved/i);
  assert.equal(commitmentMismatch.decision.priceComparison, null);
});

test("filters sentence-like slogans and generic workspace taglines from SaaS offerings", () => {
  const offerings = extractFirstPartyOfferings({
    domain: "linear.app",
    observedAt: "2026-07-14T00:00:00.000Z",
    businessType: "saas",
    pages: [
      { sourceUrl: "https://linear.app/features", title: "Linear features", description: "Product development tools", headings: ["Artificial colleagues. Natural collaboration.", "Your social media workspace", "Plan and navigate from idea to launch", "Delegate and automate work"] },
    ],
  });
  assert.deepEqual(offerings.map((offering) => offering.name), ["Plan and navigate from idea to launch", "Delegate and automate work"]);
});

test("recognizes first-party subscription box pages without inventing physical SKUs", () => {
  const offerings = extractFirstPartyOfferings({
    domain: "oddbox.co.uk",
    observedAt: "2026-07-14T00:00:00.000Z",
    businessType: "ecommerce",
    pages: [
      { sourceUrl: "https://oddbox.co.uk/boxes", title: "Fruit and veg boxes | Oddbox", description: "Choose a rescued produce box", headings: ["Small Fruit & Veg Box", "Medium Fruit & Veg Box", "Large Fruit & Veg Box", "Fruit Booster Box", "Veg Booster Box", "Wake up to fruit, veg & more", "The faces behind the fruit & veg"] },
    ],
  });
  assert.equal(offerings.length, 5);
  assert.ok(offerings.every((offering) => offering.jsonLdType === "Service"));
  assert.ok(offerings.every((offering) => offering.confidence === "Medium"));
});

test("uses matching product-image filenames as supporting identity evidence", () => {
  const left = { ...product("image-a", "a.com", "Premium Chops"), imageUrl: "https://cdn.a.com/products/halal-lamb-chops-500g.jpg" };
  const right = { ...product("image-b", "b.com", "Fresh Meat Pack"), imageUrl: "https://cdn.b.com/catalog/halal-lamb-chops-500g.webp" };
  const result = scoreProductPair(left, right);
  assert.ok(result.imageScore >= 0.75);
  assert.equal(result.eligible, false);
});

test("never treats generic image filenames or shared pack-size words as product identity", () => {
  const meat = { ...product("meat-a", "a.com", "Halal Lamb Chops 500g"), imageUrl: "https://a.com/logo.png" };
  const poultry = { ...product("meat-b", "b.com", "Halal Chicken Wings 500g"), imageUrl: "https://b.com/logo.png" };
  const result = scoreProductPair(meat, poultry);
  assert.equal(result.imageScore, 0);
  assert.equal(result.eligible, false);
});

test("matching preserves Arabic product words instead of stripping them", () => {
  const left = product("arabic-a", "a.com", "عسل سدر سعودي", "عسل", "عسل طبيعي من السعودية");
  const right = product("arabic-b", "b.com", "عسل سدر فاخر", "عسل", "عسل طبيعي أصلي");
  const result = scoreProductPair(left, right);
  assert.equal(result.eligible, true);
  assert.ok(result.sharedTerms.includes("عسل"));
  assert.ok(result.sharedTerms.includes("سدر"));
});

test("matching rejects generic-only and low-similarity pairs", () => {
  const generic = scoreProductPair(product("a", "a.com", "Pro Plan", "software", "team software"), product("b", "b.com", "Pro Suite", "commerce", "online sales"));
  const identicalPricing = scoreProductPair(product("pricing-a", "a.com", "Pricing", "pricing", "plans"), product("pricing-b", "b.com", "Pricing", "pricing", "plans"));
  const identicalGenericPlan = scoreProductPair(product("plan-a", "a.com", "Pro Plan", "plans", "software"), product("plan-b", "b.com", "Pro Plan", "plans", "software"));
  const unrelated = scoreProductPair(product("c", "a.com", "Inventory Forecasting"), product("d", "b.com", "Email Campaign Builder", "marketing", "email automation"));
  assert.equal(generic.eligible, false);
  assert.equal(identicalPricing.eligible, false);
  assert.equal(identicalGenericPlan.eligible, false);
  assert.equal(unrelated.eligible, false);
});

test("matching removes each company brand token before comparing product names", () => {
  const left = product("billing-a", "chargebee.com", "Chargebee Subscription Billing", "billing", "subscription billing infrastructure");
  const right = product("billing-b", "paddle.com", "Paddle Subscription Billing", "billing", "subscription billing platform");
  const result = scoreProductPair(left, right);
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 0.35);
  assert.deepEqual(result.sharedTerms.includes("billing"), true);
});

test("matching treats a fully contained two-token product identity as defensible", () => {
  const contained = scoreProductPair(
    { ...product("butter", "shop.test", "Peanut Butter", "nut butter", ""), jsonLdType: "Product" },
    { ...product("crunchy-butter", "rival.test", "Crunchy Peanut Butter 1kg", "spread", ""), jsonLdType: "Product" },
  );
  assert.equal(contained.eligible, true);
  assert.ok(contained.score >= 0.55);
});

test("matching rejects contained names when the rival is a different food form", () => {
  const butter = { ...product("almond-butter", "shop.test", "Almond Butter", "nut butter", ""), jsonLdType: "Product" };
  const granola = { ...product("almond-granola", "rival.test", "Almond Butter Granola", "granola", ""), jsonLdType: "Product" };
  const bar = { ...product("almond-bar", "rival.test", "Almond Butter Bar", "snack bar", ""), jsonLdType: "Product" };
  assert.equal(scoreProductPair(butter, granola).eligible, false);
  assert.equal(scoreProductPair(butter, bar).eligible, false);
  assert.equal(scoreProductPair(
    { ...product("matcha", "shop.test", "Matcha", "tea", ""), jsonLdType: "Product" },
    { ...product("ceremonial-matcha", "rival.test", "Ceremonial Matcha", "tea", ""), jsonLdType: "Product" },
  ).eligible, false);
});

test("matching compares an apparel family without color and sole variants", () => {
  const variant = { ...product("wool-runner-white", "allbirds.com", "Men's Wool Runner - Natural White (Cream Sole)", "shoes", ""), jsonLdType: "Product" };
  const family = { ...product("wool-runner", "rival.test", "Men's Wool Runner", "footwear", ""), jsonLdType: "Product" };
  const match = scoreProductPair(variant, family);
  assert.equal(match.eligible, true);
  assert.ok(match.score >= 0.55);
});

test("comparison collapses primary color variants into one family row", () => {
  const white = { ...product("runner-white", "allbirds.com", "Men's Wool Runner - Natural White (Cream Sole)", "shoes", ""), jsonLdType: "Product" };
  const black = { ...product("runner-black", "allbirds.com", "Men's Wool Runner - Natural Black (Black Sole)", "shoes", ""), jsonLdType: "Product", priceSignals: [{ raw: "USD 98", currency: "USD", amount: 98 }] };
  const dasher = { ...product("tree-dasher", "allbirds.com", "Men's Tree Dasher - Blizzard (White Sole)", "shoes", ""), jsonLdType: "Product" };
  const rival = { ...product("rival-runner", "rival.test", "Men's Wool Runner", "footwear", ""), jsonLdType: "Product" };
  const comparison = buildProductComparison("allbirds.com", [
    { domain: "allbirds.com", products: [white, black, dasher] },
    { domain: "rival.test", products: [rival] },
  ]);
  assert.equal(comparison.coverage.primaryProductsAvailable, 3);
  assert.equal(comparison.coverage.primaryProductsScanned, 3);
  assert.equal(comparison.coverage.primaryProductFamiliesCompared, 2);
  assert.equal(comparison.rows.length, 2);
  const runnerRows = comparison.rows.filter((row) => /Wool Runner/.test(row.primary.name));
  assert.equal(runnerRows.length, 1);
  assert.equal(runnerRows[0].primary.id, "runner-black");
  assert.equal(runnerRows[0].matches[0].confidence, "Medium");
  assert.equal(comparison.rows.find((row) => row.primary.id === "tree-dasher").matches[0].product, null);
});

test("matching rejects an accessory even when its name contains the complete product name", () => {
  const food = { ...product("butter", "shop.test", "Peanut Butter"), jsonLdType: "Product" };
  const cookbook = { ...product("cookbook", "rival.test", "The Peanut Butter Cookbook"), jsonLdType: "Product" };
  const cookbooks = { ...product("cookbooks", "rival.test", "Peanut Butter Cookbooks"), jsonLdType: "Product" };
  const matchingSpoons = scoreProductPair(
    { ...product("spoon-a", "shop.test", "Perfect Matcha Spoon"), jsonLdType: "Product" },
    { ...product("spoon-b", "rival.test", "Perfect Matcha Spoon"), jsonLdType: "Product" },
  );
  assert.equal(scoreProductPair(food, cookbook).eligible, false);
  assert.equal(scoreProductPair(food, cookbooks).eligible, false);
  assert.equal(matchingSpoons.eligible, true);
  assert.equal(scoreProductPair(
    { ...product("mug", "shop.test", "Tea Infuser Mug"), jsonLdType: "Product" },
    { ...product("cup", "rival.test", "Tea Infuser Cup"), jsonLdType: "Product" },
  ).eligible, true);
  assert.equal(scoreProductPair(
    { ...product("recipe-box", "shop.test", "Classic Recipe Box"), jsonLdType: "Product" },
    { ...product("meal-box", "rival.test", "Classic Meal Box"), jsonLdType: "Product" },
  ).eligible, false);
});

test("matching is deterministic and one-to-one per competitor", () => {
  const primaryA = product("primary-a", "a.com", "Inventory Forecasting", "inventory forecasting", "forecast inventory demand");
  const primaryB = product("primary-b", "a.com", "Inventory Planning", "inventory planning", "plan inventory levels");
  const candidate = product("candidate-a", "b.com", "Inventory Forecasting", "inventory forecasting", "forecast inventory demand");
  const first = buildProductComparison("a.com", [{ domain: "a.com", products: [primaryB, primaryA] }, { domain: "b.com", products: [candidate] }]);
  const second = buildProductComparison("a.com", [{ domain: "a.com", products: [primaryB, primaryA] }, { domain: "b.com", products: [candidate] }]);
  assert.deepEqual(first, second);
  assert.equal(first.rows.find((row) => row.primary.id === "primary-a").matches[0].product.id, "candidate-a");
  assert.match(first.rows.find((row) => row.primary.id === "primary-a").matches[0].decision.recommendedMove, /Compare|price|offer/i);
  assert.equal(first.rows.find((row) => row.primary.id === "primary-b").matches[0].product, null);
  assert.equal(first.unmatched[0].products.length, 0);
});

test("indexed product retrieval preserves exact and one-edit token matches", () => {
  const variants = [
    ["exact", "Golden Pistachio Maamoul"],
    ["substitution", "Gxlden Pistachio Maamoul"],
    ["insertion", "Goldenn Pistachio Maamoul"],
    ["deletion", "Golde Pistachio Maamoul"],
  ];
  for (const [id, rivalName] of variants) {
    const primary = { ...product(`primary-${id}`, "shop.test", "Golden Pistachio Maamoul"), jsonLdType: "Product" };
    const rival = { ...product(`rival-${id}`, "rival.test", rivalName), jsonLdType: "Product" };
    const comparison = buildProductComparison("shop.test", [
      { domain: "shop.test", products: [primary] },
      { domain: "rival.test", products: [rival] },
    ]);
    assert.equal(comparison.rows[0].matches[0].product?.id, rival.id, `${id} variant should remain retrievable`);
  }
});

test("indexed product retrieval preserves short-token and unrelated-token rejection", () => {
  const primary = { ...product("primary-tea", "shop.test", "Tea Pot"), jsonLdType: "Product" };
  const shortTypo = { ...product("rival-typo", "rival.test", "Tee Pot"), jsonLdType: "Product" };
  const unrelated = { ...product("rival-unrelated", "rival.test", "Coffee Grinder"), jsonLdType: "Product" };
  const comparison = buildProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [shortTypo, unrelated] },
  ]);
  assert.equal(comparison.rows[0].matches[0].product, null);
});

test("indexed candidate retrieval matches the one-edit boundary without double-counting", () => {
  const primary = { ...product("primary", "shop.test", "Anchor Golden"), jsonLdType: "Product" };
  const candidates = [
    { ...product("exact-short", "rival.test", "Anchor Tea"), jsonLdType: "Product" },
    { ...product("substitution", "rival.test", "Anchor Gxlden"), jsonLdType: "Product" },
    { ...product("insertion", "rival.test", "Anchor Goldenn"), jsonLdType: "Product" },
    { ...product("deletion", "rival.test", "Anchor Golde"), jsonLdType: "Product" },
    { ...product("transposition", "rival.test", "Anchor Gloden"), jsonLdType: "Product" },
    { ...product("length-two", "rival.test", "Anchor Goldennn"), jsonLdType: "Product" },
    { ...product("short-typo", "rival.test", "Anchor Tee"), jsonLdType: "Product" },
  ];
  const goldenIds = retrieveProductPairCandidates(primary, buildProductPairCandidateIndex(candidates)).map((item) => item.id).sort();
  assert.deepEqual(goldenIds, ["deletion", "insertion", "substitution"]);

  const shortPrimary = { ...product("short-primary", "shop.test", "Anchor Tea"), jsonLdType: "Product" };
  const shortIds = retrieveProductPairCandidates(shortPrimary, buildProductPairCandidateIndex(candidates)).map((item) => item.id).sort();
  assert.deepEqual(shortIds, ["exact-short"]);
});

test("indexed candidate retrieval counts each primary token once per product", () => {
  const primary = { ...product("primary", "shop.test", "Golden Pistachio"), jsonLdType: "Product" };
  const oneTokenOnly = { ...product("one-token", "rival.test", "Gxlden Goldenn"), jsonLdType: "Product" };
  const candidates = retrieveProductPairCandidates(primary, buildProductPairCandidateIndex([oneTokenOnly]));
  assert.deepEqual(candidates, []);
});

test("comparison scans the crawled catalog beyond the first sixteen products and reports bounded coverage", () => {
  const primaryFillers = Array.from({ length: 24 }, (_, index) => product(`a-primary-${index}`, "shop.test", `Unrelated Primary ${index}`));
  const rivalFillers = Array.from({ length: 30 }, (_, index) => product(`a-rival-${index}`, "rival.test", `Different Rival ${index}`));
  const primaryMatch = product("z-primary-match", "shop.test", "Halal Lamb Ribs");
  const rivalMatch = product("z-rival-match", "rival.test", "Lamb Ribs Halal");
  const comparison = buildProductComparison("shop.test", [
    { domain: "shop.test", products: [...primaryFillers, primaryMatch] },
    { domain: "rival.test", products: [...rivalFillers, rivalMatch] },
  ]);
  const matchedRow = comparison.rows.find((row) => row.primary.id === primaryMatch.id);
  assert.equal(matchedRow.matches[0].product.id, rivalMatch.id);
  assert.equal(comparison.coverage.primaryProductsScanned, 25);
  assert.equal(comparison.coverage.competitorProductsScanned, 31);
  assert.equal(comparison.coverage.verifiedPairCount, 1);
  assert.ok(comparison.unmatched[0].products.length <= 24);
});

test("price enrichment targets are physical product pages, competitor-diverse, and globally capped", () => {
  const primary = [
    { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea", extraction: "sitemap", confidence: "Medium" },
    { ...product("whisk", "shop.test", "Bamboo Matcha Whisk"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/bamboo-matcha-whisk", extraction: "sitemap", confidence: "Medium" },
    { ...product("planning", "shop.test", "Product Planning"), jsonLdType: "Service", sourceUrl: "https://shop.test/features/planning" },
  ];
  const rivals = [
    { domain: "tea.test", products: [{ ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea", extraction: "sitemap", confidence: "Medium" }] },
    { domain: "matcha.test", products: [{ ...product("rival-whisk", "matcha.test", "Bamboo Matcha Whisk"), jsonLdType: "Product", sourceUrl: "https://matcha.test/shop/bamboo-matcha-whisk", extraction: "sitemap", confidence: "Medium" }] },
    { domain: "saas.test", products: [{ ...product("rival-planning", "saas.test", "Product Planning"), jsonLdType: "Service", sourceUrl: "https://saas.test/features/planning" }] },
  ];
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: primary }, ...rivals]);
  const targets = selectProductEnrichmentTargets(comparison, 4);
  assert.equal(targets.length, 4);
  assert.ok(targets.every((target) => /\/(?:products?|shop)\//.test(new URL(target.sourceUrl).pathname)));
  assert.ok(targets.some((target) => target.domain === "tea.test"));
  assert.ok(targets.some((target) => target.domain === "matcha.test"));
  assert.ok(targets.every((target) => target.domain !== "saas.test"));
});

test("price enrichment skips the side that already has comparable structured price evidence", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
  const rival = { ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea" };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "tea.test", products: [rival] }]);
  assert.deepEqual(selectProductEnrichmentTargets(comparison).map((target) => [target.role, target.domain]), [["rival", "tea.test"]]);
});

test("decodes an Arabic product identity from a percent-encoded sitemap path", () => {
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://shop.example/products/%D8%B9%D8%B3%D9%84-%D8%B3%D8%AF%D8%B1-%D8%B9%D8%B6%D9%88%D9%8A-500-%D8%AC%D8%B1%D8%A7%D9%85</loc></url></urlset>`;
  const products = extractProductsFromSitemap(sitemap, "shop.example", "2026-07-15T00:00:00.000Z");

  assert.equal(products[0].name, "عسل سدر عضوي 500 جرام");
  assert.equal(products[0].normalizedName, "عسل سدر عضوي 500 جرام");
});

test("keeps malformed sitemap path escapes safe and deterministic", () => {
  const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://shop.example/products/raw-honey-%ZZ-500g</loc></url></urlset>`;

  assert.doesNotThrow(() => extractProductsFromSitemap(sitemap, "shop.example", "2026-07-15T00:00:00.000Z"));
  assert.equal(extractProductsFromSitemap(sitemap, "shop.example", "2026-07-15T00:00:00.000Z")[0].name, "raw honey %ZZ 500g");
});

test("keeps a single public sitemap broad but bounded at one thousand products", () => {
  const entries = Array.from({ length: 1_005 }, (_, index) => `<url><loc>https://shop.example/products/catalog-item-${index}</loc></url>`).join("");
  const products = extractProductsFromSitemap(`<urlset>${entries}</urlset>`, "shop.example", "2026-07-15T00:00:00.000Z");

  assert.equal(products.length, 1_000);
  assert.equal(products.at(-1).name, "catalog item 999");
});

test("final match enrichment fetches the exact AI-selected pair when secure images are missing", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
  const rival = { ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea", priceSignals: [{ raw: "GBP 6", currency: "GBP", amount: 6 }] };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "tea.test", products: [rival] }]);
  comparison.rows[0].matches[0].assessment = { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.94, model: "gpt-5.4-mini", promptVersion: "test", reasons: ["same tea"], contradictions: [], normalizedCategory: "tea", normalizedVariant: "lemon ginger", normalizedSize: "", primarySourceUrl: primary.sourceUrl, rivalSourceUrl: rival.sourceUrl };
  const targets = selectFinalProductEnrichmentTargets(comparison, 24);
  assert.deepEqual(targets.map((target) => [target.role, target.productId, target.expectedName]), [
    ["rival", rival.id, rival.name],
    ["primary", primary.id, primary.name],
  ]);
});

test("accepts exact-page title qualifiers when both expected and fetched identity are anchored to the requested slug", () => {
  const sourceUrl = "https://grocer.test/product/halal-ribs/";
  const expected = { ...product("expected-ribs", "grocer.test", "halal ribs"), jsonLdType: "Product", sourceUrl };
  const fetched = { ...product("fetched-ribs", "grocer.test", "Halal Beef Ribs — Pack of 5"), jsonLdType: "PageSignal", sourceUrl };
  assert.equal(validateProductPageIdentity([expected], [fetched], fetched.name, { allowScopedPageSignal: true }).accepted, true);

  const unrelated = { ...fetched, name: "Chocolate Celebration Cake", normalizedName: "chocolate celebration cake" };
  assert.equal(validateProductPageIdentity([expected], [unrelated], unrelated.name).accepted, false);

  const liverUrl = "https://grocer.test/product/lamb-liver/";
  const liverExpected = { ...product("expected-liver", "grocer.test", "lamb liver"), jsonLdType: "Product", sourceUrl: liverUrl };
  const liverFetched = { ...product("fetched-liver", "grocer.test", "Halal Lamb Liver (Pre Order)"), jsonLdType: "PageSignal", sourceUrl: liverUrl };
  assert.equal(validateProductPageIdentity([liverExpected], [liverFetched], liverFetched.name, { allowScopedPageSignal: true }).accepted, true);
});

test("final match enrichment can cover both sides of twenty-nine selected rows", () => {
  const rows = Array.from({ length: 29 }, (_, index) => {
    const primary = { ...product(`primary-${index}`, "shop.test", `Product ${index} 500g`), jsonLdType: "Product", sourceUrl: `https://shop.test/products/product-${index}` };
    const rival = { ...product(`rival-${index}`, "rival.test", `Product ${index} 500g`), jsonLdType: "Product", sourceUrl: `https://rival.test/products/product-${index}` };
    return { primary, matches: [{ domain: "rival.test", product: rival, score: 0.9, confidence: "Medium", sharedTerms: ["product"], claimIds: [], decision: null, assessment: { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.95, model: "gpt-5.4-mini", promptVersion: "test", reasons: ["same item"], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "500g", primarySourceUrl: primary.sourceUrl, rivalSourceUrl: rival.sourceUrl } }] };
  });
  const comparison = { primaryDomain: "shop.test", comparisonDomains: ["rival.test"], rows, unmatched: [], coverage: { primaryProductsAvailable: 29, primaryProductsScanned: 29, primaryProductFamiliesCompared: 29, competitorProductsAvailable: 29, competitorProductsScanned: 29, assignedPairCount: 29, verifiedPairCount: 29, rowsReturned: 29, rowLimit: 40, truncated: false } };
  const targets = selectFinalProductEnrichmentTargets(comparison, 64);
  assert.equal(targets.length, 58);
  assert.equal(targets.filter((target) => target.role === "primary").length, 29);
  assert.equal(targets.filter((target) => target.role === "rival").length, 29);
});

test("final enrichment gives every product family its strongest rival before primary presentation gaps", () => {
  const rows = Array.from({ length: 70 }, (_, index) => {
    const primary = { ...product(`primary-${index}`, "shop.test", `Product ${index} 500g`), jsonLdType: "Product", sourceUrl: `https://shop.test/products/product-${index}` };
    const weaker = { ...product(`weaker-${index}`, "a-rival.test", `Product ${index} 500g`), jsonLdType: "Product", sourceUrl: `https://a-rival.test/products/product-${index}` };
    const strongest = { ...product(`strongest-${index}`, "z-rival.test", `Product ${index} 500g`), jsonLdType: "Product", sourceUrl: `https://z-rival.test/products/product-${index}` };
    const match = (rival, score) => ({ domain: rival.domain, product: rival, score, confidence: "Medium", sharedTerms: ["product"], claimIds: [], decision: null, assessment: { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: score, model: "gpt-5.4-mini", promptVersion: "test", reasons: ["same item"], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "500g", primarySourceUrl: primary.sourceUrl, rivalSourceUrl: rival.sourceUrl } });
    return { primary, matches: [match(weaker, 0.71), match(strongest, 0.99)] };
  });
  const comparison = { primaryDomain: "shop.test", comparisonDomains: ["a-rival.test", "z-rival.test"], rows, unmatched: [], coverage: { primaryProductsAvailable: 70, primaryProductsScanned: 70, primaryProductFamiliesCompared: 70, competitorProductsAvailable: 140, competitorProductsScanned: 140, assignedPairCount: 140, verifiedPairCount: 140, rowsReturned: 70, rowLimit: 70, truncated: false } };
  const targets = selectFinalProductEnrichmentTargets(comparison, 80);
  assert.equal(targets.length, 80);
  assert.equal(targets.slice(0, 70).every((target) => target.role === "rival"), true);
  assert.equal(targets.slice(0, 70).every((target) => target.productId.startsWith("strongest-")), true);
  assert.equal(targets.slice(70).every((target) => target.productId.startsWith("weaker-")), true);
});

test("final enrichment updates the selected pair and recomputes its price decision", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea", extraction: "sitemap", confidence: "Medium" };
  const rival = { ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea", extraction: "sitemap", confidence: "Medium" };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "tea.test", products: [rival] }]);
  const enriched = applyFinalProductEnrichment(comparison, [
    { ...primary, name: "Lemon & Ginger Tea", normalizedName: "lemon & ginger tea", extraction: "page-signal", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }], imageUrl: "https://cdn.shop.test/tea.jpg" },
    { ...rival, extraction: "json-ld", priceSignals: [{ raw: "GBP 6", currency: "GBP", amount: 6 }], imageUrl: "https://cdn.tea.test/tea.jpg" },
  ], { pagesRequested: 2, pagesFetched: 2, maxPages: 24, gaps: [] });
  assert.equal(enriched.rows[0].primary.imageUrl, "https://cdn.shop.test/tea.jpg");
  assert.equal(enriched.rows[0].primary.name, "Lemon & Ginger Tea");
  assert.equal(enriched.rows[0].matches[0].product.imageUrl, "https://cdn.tea.test/tea.jpg");
  assert.match(enriched.rows[0].matches[0].decision.priceVerdict, /GBP 2\.00 cheaper/);
  assert.deepEqual(enriched.enrichment, { pagesRequested: 2, pagesFetched: 2, maxPages: 24, gaps: [] });
});

test("pre-match catalog reconciliation replaces stale identity without inheriting stale fields", () => {
  const stale = {
    ...product("walnut", "shop.test", "Maamoul Walnut 500g"),
    jsonLdType: "Product",
    sourceUrl: "https://shop.test/products/maamoul-walnut-500g",
    quantity: { kind: "mass", amount: 500, unit: "g" },
    identifiers: { gtins: [], sku: "STALE-500", brand: "Old Brand" },
    claimIds: ["stale-sitemap-claim"],
  };
  const live = {
    ...stale,
    name: "Maamoul Walnut 600g",
    normalizedName: "maamoul walnut 600g",
    quantity: { kind: "mass", amount: 600, unit: "g" },
    identifiers: { gtins: [], sku: "LIVE-600", brand: "Live Brand" },
    priceSignals: [{ raw: "USD 12.5", currency: "USD", amount: 12.5 }],
    imageUrl: "https://cdn.shop.test/walnut-600g.jpg",
    extraction: "storefront-api",
    confidence: "High",
    attributes: [catalogReplacementAuditAttribute(stale.name, stale.sourceUrl)],
    claimIds: ["live-observed", "walnut-catalog-replacement-1"],
  };
  const reconciled = applyPreMatchCatalogEnrichment([stale], [live]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].name, live.name);
  assert.equal(reconciled[0].quantity.amount, 600);
  assert.equal(reconciled[0].identifiers.sku, "LIVE-600");
  assert.deepEqual(reconciled[0].claimIds, live.claimIds);
  assert.equal(reconciled[0].claimIds.includes("stale-sitemap-claim"), false);
});

test("preliminary catalog planning uses the full primary catalog without flagging rivals", () => {
  const matched = { ...product("matched", "shop.test", "Walnut Maamoul 500g"), jsonLdType: "Product", sourceUrl: "https://shop.test/shop/walnut-maamoul" };
  const unmatched = { ...product("unmatched", "shop.test", "Old Nougat 500g"), jsonLdType: "Product", sourceUrl: "https://shop.test/shop/old-nougat" };
  const rival = { ...product("rival", "rival.test", "Walnut Maamoul 500g"), jsonLdType: "Product", sourceUrl: "https://rival.test/shop/walnut-maamoul" };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [matched, unmatched] }, { domain: "rival.test", products: [rival] }]);
  const { targets, totalEligible, truncated } = planPreliminaryCatalogReconciliation(comparison, [matched, unmatched], 64);
  assert.deepEqual(new Set(targets.map((target) => target.productId)), new Set([matched.id, unmatched.id]));
  assert.equal(totalEligible, 2);
  assert.equal(truncated, false);
  assert.equal(targets.every((target) => target.role === "primary" && target.allowCatalogReplacement === true), true);
  assert.equal(targets.some((target) => target.productId === rival.id), false);
});

test("preliminary catalog planning covers zero-competitor catalogs and exposes its sixty-four page limit", () => {
  const primary = Array.from({ length: 70 }, (_, index) => ({
    ...product(`primary-${index}`, "shop.test", `Catalog Product ${String(index).padStart(2, "0")}`),
    jsonLdType: "Product",
    sourceUrl: `https://shop.test/shop/catalog-${index}`,
  }));
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: primary }]);
  const plan = planPreliminaryCatalogReconciliation(comparison, primary, 64);
  assert.equal(plan.targets.length, 64);
  assert.equal(plan.totalEligible, 70);
  assert.equal(plan.truncated, true);
  assert.equal(plan.targets.every((target) => target.role === "primary" && target.allowCatalogReplacement === true), true);
});

test("pre-match catalog reconciliation drops a stale URL when the live identity already exists", () => {
  const stale = { ...product("stale", "shop.test", "Old Baklava 500g"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/old-baklava" };
  const existing = { ...product("current", "shop.test", "Baklava Special 500g"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/baklava-special", quantity: { kind: "mass", amount: 500, unit: "g" } };
  const replacement = {
    ...existing,
    id: stale.id,
    sourceUrl: stale.sourceUrl,
    extraction: "json-ld",
    attributes: [catalogReplacementAuditAttribute(stale.name, stale.sourceUrl)],
  };
  const reconciled = applyPreMatchCatalogEnrichment([stale, existing], [replacement]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, existing.id);
  assert.equal(reconciled[0].sourceUrl, existing.sourceUrl);
  assert.match(reconciled[0].attributes.join(" "), /Previous sitemap identity: Old Baklava 500g/);
});

test("pre-match catalog reconciliation collapses equal live names when both quantities are absent", () => {
  const stale = { ...product("stale", "shop.test", "Old Mixed Nawashif 500g"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/old-nawashif" };
  const existing = { ...product("barazek", "shop.test", "Sesame Cookies (Barazek)"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/barazek", quantity: undefined };
  const replacement = {
    ...existing,
    id: stale.id,
    sourceUrl: stale.sourceUrl,
    extraction: "json-ld",
    attributes: [catalogReplacementAuditAttribute(stale.name, stale.sourceUrl)],
  };
  const reconciled = applyPreMatchCatalogEnrichment([stale, existing], [replacement]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, existing.id);
  assert.equal(reconciled[0].quantity, undefined);
  assert.match(reconciled[0].attributes.join(" "), /Previous sitemap identity: Old Mixed Nawashif 500g/);
});

test("post-match enrichment ignores a replacement-marked product even if injected", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea" };
  const rival = { ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea" };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "tea.test", products: [rival] }]);
  const injected = {
    ...primary,
    name: "Completely Different Product 1kg",
    normalizedName: "completely different product 1kg",
    priceSignals: [{ raw: "GBP 99", currency: "GBP", amount: 99 }],
    attributes: [catalogReplacementAuditAttribute(primary.name, primary.sourceUrl)],
  };
  const enriched = applyFinalProductEnrichment(comparison, [injected], { pagesRequested: 1, pagesFetched: 1, maxPages: 24, gaps: [] });
  assert.equal(enriched.rows[0].primary.name, primary.name);
  assert.deepEqual(enriched.rows[0].primary.priceSignals, primary.priceSignals);
  assert.equal(selectFinalProductEnrichmentTargets(comparison, 24).some((target) => target.allowCatalogReplacement), false);
});

test("final enrichment joins equivalent canonical product URLs after host and scheme redirects", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://www.shop.test/products/lemon-ginger-tea" };
  const rival = { ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea" };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "tea.test", products: [rival] }]);
  const enriched = applyFinalProductEnrichment(comparison, [
    { ...primary, sourceUrl: "http://shop.test/products/lemon-ginger-tea?variant=1", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }], imageUrl: "https://cdn.shop.test/tea.jpg" },
  ], { pagesRequested: 1, pagesFetched: 1, maxPages: 24, gaps: [] });

  assert.equal(enriched.rows[0].primary.priceSignals[0].amount, 8);
  assert.equal(enriched.rows[0].primary.imageUrl, "https://cdn.shop.test/tea.jpg");
});

test("final enrichment joins a validated redirected product by its selected product id", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea" };
  const rival = { ...product("rival-tea", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea" };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "tea.test", products: [rival] }]);
  const enriched = applyFinalProductEnrichment(comparison, [
    { ...primary, sourceUrl: "https://shop.test/en/products/lemon-and-ginger-tea", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }], imageUrl: "https://cdn.shop.test/tea.jpg" },
  ], { pagesRequested: 1, pagesFetched: 1, maxPages: 24, gaps: [] });

  assert.equal(enriched.rows[0].primary.priceSignals[0].amount, 8);
  assert.equal(enriched.rows[0].primary.imageUrl, "https://cdn.shop.test/tea.jpg");
});

test("enriched product evidence replaces sitemap placeholders and activates a price verdict", () => {
  const primarySitemap = { ...product("tea-sitemap", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://shop.test/products/lemon-ginger-tea", extraction: "sitemap", confidence: "Medium" };
  const rivalSitemap = { ...product("rival-sitemap", "tea.test", "Lemon Ginger Tea"), jsonLdType: "Product", sourceUrl: "https://tea.test/products/lemon-ginger-tea", extraction: "sitemap", confidence: "Medium" };
  const primaryEnriched = { ...primarySitemap, id: "tea-jsonld", extraction: "json-ld", confidence: "High", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
  const rivalEnriched = { ...rivalSitemap, id: "rival-jsonld", extraction: "json-ld", confidence: "High", priceSignals: [{ raw: "GBP 6", currency: "GBP", amount: 6 }] };
  const comparison = buildProductComparison("shop.test", [
    { domain: "shop.test", products: selectPreferredProducts([primarySitemap, primaryEnriched]) },
    { domain: "tea.test", products: selectPreferredProducts([rivalSitemap, rivalEnriched]) },
  ]);
  const match = comparison.rows[0].matches[0];
  assert.equal(match.product.id, "rival-jsonld");
  assert.match(match.decision.priceVerdict, /GBP 2\.00 cheaper/);
});

test("price verdicts do not compare a multi-variant range with a single rival SKU", () => {
  const primary = {
    ...product("butter", "shop.test", "Peanut Butter"),
    jsonLdType: "Product",
    priceSignals: [
      { raw: "GBP 3.49", currency: "GBP", amount: 3.49 },
      { raw: "GBP 7.85", currency: "GBP", amount: 7.85 },
    ],
  };
  const rival = {
    ...product("rival-butter", "rival.test", "Crunchy Peanut Butter 1kg"),
    jsonLdType: "Product",
    priceSignals: [{ raw: "GBP 8.49", currency: "GBP", amount: 8.49 }],
  };
  const comparison = buildProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ]);
  assert.match(comparison.rows[0].matches[0].decision.priceVerdict, /variant or pack-size alignment is unresolved/i);
  assert.doesNotMatch(comparison.rows[0].matches[0].decision.priceVerdict, /cheaper/i);
  assert.equal(comparison.rows[0].matches[0].decision.priceComparison, null);
});

test("price verdicts identify an equal unambiguous public price", () => {
  const primary = { ...product("tea", "shop.test", "Lemon Ginger Tea"), jsonLdType: "Product", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
  const rival = { ...product("rival-tea", "rival.test", "Lemon Ginger Tea"), jsonLdType: "Product", priceSignals: [{ raw: "GBP 8.00", currency: "GBP", amount: 8 }] };
  const comparison = buildProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "rival.test", products: [rival] }]);
  assert.match(comparison.rows[0].matches[0].decision.priceVerdict, /same at GBP 8\.00/i);
  assert.deepEqual(comparison.rows[0].matches[0].decision.priceComparison, { primaryRaw: "GBP 8", rivalRaw: "GBP 8.00" });
});
