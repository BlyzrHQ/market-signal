import assert from "node:assert/strict";
import test from "node:test";

import { buildProductComparison, extractFirstPartyOfferings, extractProductsFromHtml, extractProductsFromSitemap, scoreProductPair, selectPreferredProducts, selectProductEnrichmentTargets } from "../app/lib/product-intelligence.ts";

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
