import assert from "node:assert/strict";
import test from "node:test";

import { buildProductComparison, extractProductsFromHtml, scoreProductPair, selectPreferredProducts } from "../app/lib/product-intelligence.ts";

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
  assert.equal(customers.products.length, 0);
  assert.equal(jobs.products.length, 0);
  assert.equal(team.products.length, 0);
  assert.equal(industries.products.length, 0);
  assert.equal(community.products.length, 0);
  assert.equal(payments.products.length, 1);
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

test("matching rejects generic-only and low-similarity pairs", () => {
  const generic = scoreProductPair(product("a", "a.com", "Pro Plan", "software", "team software"), product("b", "b.com", "Pro Suite", "commerce", "online sales"));
  const unrelated = scoreProductPair(product("c", "a.com", "Inventory Forecasting"), product("d", "b.com", "Email Campaign Builder", "marketing", "email automation"));
  assert.equal(generic.eligible, false);
  assert.equal(unrelated.eligible, false);
});

test("matching removes each company brand token before comparing product names", () => {
  const left = product("billing-a", "chargebee.com", "Chargebee Billing", "billing", "subscription billing infrastructure");
  const right = product("billing-b", "paddle.com", "Paddle Billing", "billing", "subscription billing platform");
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
  assert.equal(first.rows.find((row) => row.primary.id === "primary-b").matches[0].product, null);
  assert.equal(first.unmatched[0].products.length, 0);
});
