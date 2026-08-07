import assert from "node:assert/strict";
import test from "node:test";

import { rememberedReverificationFailures, resolvePrimaryDiscoveryPolicy, verifyDiscoveredCompetitor } from "../app/api/crawl/route.ts";
import { resolveVerificationMarket } from "../app/lib/competitor-verification.ts";

function product(domain, name) {
  return {
    id: `${domain}-${name}`,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description: "halal grocery product",
    category: "halal grocery",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl: `https://${domain}/products/${name.toLowerCase().replaceAll(" ", "-")}`,
    imageUrl: "",
    observedAt: "2026-08-07T00:00:00.000Z",
    claimIds: [],
  };
}

function page(domain) {
  return {
    ok: true,
    domain,
    path: "/",
    sourceUrl: `https://${domain}/`,
    title: "Halal grocery delivery",
    description: "Fresh halal meat and cultural groceries delivered in the UK",
    language: "en",
    region: "United Kingdom (inferred)",
    regionCountryCode: "GB",
    regionSignals: [],
    headings: ["Fresh halal groceries"],
    socialLinks: [],
    claims: [],
    prices: [],
    productCandidates: [],
    thirdPartyProductCount: 0,
    fetchedAt: "2026-08-07T00:00:00.000Z",
  };
}

function crawl(domain, products) {
  const homepage = page(domain);
  return {
    domain,
    role: domain === "myjam.co.uk" ? "primary" : "discovered-competitor",
    homepage,
    pages: [homepage],
    products,
    candidates: [],
    gaps: [],
    coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 3, robotsChecked: true },
    productCoverage: { scannedPages: 1, catalogProductsDiscovered: products.length, thirdPartyReferenced: 0 },
    fetchedAt: "2026-08-07T00:00:00.000Z",
  };
}

function rememberedCandidate() {
  return {
    domain: "rival.example",
    companyName: "Rival",
    reason: "Previously verified product seller",
    searchQuery: "remembered competitor",
    sourceUrl: "https://rival.example/products/halal-lamb-chops",
    websiteUrl: "https://rival.example/",
    marketCategory: "halal grocery",
    relationship: "direct",
    sharedOfferings: ["Halal Lamb Chops 500g"],
    evidence: [{ url: "https://rival.example/products/halal-lamb-chops", title: "Halal Lamb Chops", method: "product-search" }],
    mentionCount: 1,
    matchedPrimaryProductName: "Halal Lamb Chops 500g",
    matchedProductUrl: "https://rival.example/products/halal-lamb-chops",
    matchedPrimaryProductNames: ["Halal Lamb Chops 500g"],
    matchedProductUrls: ["https://rival.example/products/halal-lamb-chops"],
    evidenceMethod: "search-source",
    provenance: "remembered-reverified",
    rememberedVerifiedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("route policy keeps ecommerce overlap mandatory when discovery is unavailable", () => {
  const primary = crawl("myjam.co.uk", [
    product("myjam.co.uk", "Halal Lamb Chops 500g"),
    product("myjam.co.uk", "Halal Beef Steak 500g"),
  ]);
  const policy = resolvePrimaryDiscoveryPolicy(primary);
  assert.equal(policy.businessType, "ecommerce");
  assert.equal(policy.intendedStrategy, "product-first");
  assert.equal(policy.requireProductOverlap, true);

  const candidate = rememberedCandidate();
  const investigated = verifyDiscoveredCompetitor(
    primary,
    crawl("rival.example", []),
    candidate,
    resolveVerificationMarket("United Kingdom", "United Kingdom"),
    policy.requireProductOverlap,
  );
  assert.equal(investigated.discovery.categoryAlignment, true);
  assert.equal(investigated.discovery.hasProductOverlap, false);
  assert.equal(investigated.discovery.accepted, false);
  assert.deepEqual(rememberedReverificationFailures([candidate], [investigated]).map((item) => item.domain), ["rival.example"]);
});
