import assert from "node:assert/strict";
import test from "node:test";

import { compareVerifiedCompetitors, resolveVerificationMarket, verifyCompetitorEntity } from "../app/lib/competitor-verification.ts";

function product(domain, name, category, type = "Product") {
  return {
    id: `${domain}-${name}`,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description: category,
    category,
    jsonLdType: type,
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl: `https://${domain}/products/${name.toLowerCase().replaceAll(" ", "-")}`,
    imageUrl: "",
    observedAt: "2026-07-14T00:00:00.000Z",
    claimIds: [],
  };
}

function site(domain, title, description, region, products = []) {
  return { domain, title, description, region, headings: [], products };
}

function discovery(overrides = {}) {
  return {
    domain: "rival.example",
    companyName: "Rival",
    reason: "Same market category",
    searchQuery: "halal grocery competitors UK",
    sourceUrl: "https://source.example/result",
    websiteUrl: "https://rival.example/",
    marketCategory: "halal grocery delivery",
    relationship: "direct",
    sharedOfferings: ["halal meat", "cultural groceries"],
    evidence: [{ url: "https://source.example/result", title: "Rival", method: "category-search" }],
    mentionCount: 2,
    ...overrides,
  };
}

test("accepts a company-level rival from its own category evidence without a matched product page", () => {
  const result = verifyCompetitorEntity(
    site("myjam.co.uk", "MyJam cultural grocery marketplace", "Halal meat and cultural groceries delivered across the UK", "United Kingdom (inferred)"),
    site("rival.example", "Rival halal grocery delivery", "Order halal meat and international groceries online", "Not enough public signal"),
    discovery(),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.categoryAlignment, true);
  assert.equal(result.regionCompatibility, true);
  assert.equal(result.hasProductOverlap, false);
});

test("requires observed product overlap when product-led ecommerce discovery requests it", () => {
  const result = verifyCompetitorEntity(
    site("myjam.co.uk", "MyJam cultural grocery marketplace", "Halal meat and cultural groceries delivered across the UK", "United Kingdom (inferred)"),
    site("rival.example", "Rival halal grocery delivery", "Order halal meat and international groceries online", "United Kingdom (inferred)"),
    discovery(),
    resolveVerificationMarket("United Kingdom", "United Kingdom"),
    { requireProductOverlap: true },
  );
  assert.equal(result.categoryAlignment, true);
  assert.equal(result.hasProductOverlap, false);
  assert.equal(result.accepted, false);
});

test("rejects an accessory seller that does not describe itself as the same core category", () => {
  const result = verifyCompetitorEntity(
    site("camera.example", "Professional cameras", "Cameras and lenses for creators", "United States (inferred)"),
    site("strap.example", "Leather camera straps", "Handmade straps, bags, and protective cases", "United States (inferred)"),
    discovery({ marketCategory: "professional cameras", sharedOfferings: ["camera accessories"] }),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.categoryAlignment, false);
});

test("rejects a same-region accessory seller even when one peripheral product pairs", () => {
  const primaryProduct = product("tea.example", "Tea Infuser Mug", "loose leaf tea accessories");
  const rivalProduct = product("mugs.example", "Tea Infuser Mug", "ceramic mugs");
  const result = verifyCompetitorEntity(
    site("tea.example", "Loose leaf tea and herbal infusions", "British tea shop selling loose leaf blends", "United Kingdom (inferred)", [primaryProduct]),
    site("mugs.example", "Personalised ceramic mugs", "UK mug shop for gifts, cups, and printed drinkware", "United Kingdom (inferred)", [rivalProduct]),
    discovery({ domain: "mugs.example", websiteUrl: "https://mugs.example/", marketCategory: "loose leaf tea", sharedOfferings: ["Tea Infuser Mug"] }),
  );
  assert.equal(result.hasProductOverlap, true);
  assert.equal(result.categoryAlignment, false);
  assert.equal(result.accepted, false);
});

test("rejects a proven regional mismatch but keeps an unknown candidate region neutral", () => {
  const primary = site("shop.co.uk", "UK halal grocery", "Halal meat and grocery delivery", "United Kingdom (inferred)");
  const mismatch = verifyCompetitorEntity(primary, site("rival.us", "US halal grocery", "Halal meat and grocery delivery in America", "United States (inferred)"), discovery());
  const unknown = verifyCompetitorEntity(primary, site("rival.example", "Halal grocery", "Halal meat and grocery delivery", "Not enough public signal"), discovery());
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.regionCompatibility, false);
  assert.equal(unknown.regionCompatibility, true);
});

test("uses comparable products as a confidence booster and returns the strongest pair", () => {
  const primaryProduct = product("a.example", "Halal Lamb Chops 500g", "halal meat");
  const rivalProduct = product("b.example", "Fresh Halal Lamb Chops 500g", "halal meat");
  const result = verifyCompetitorEntity(
    site("a.example", "Halal grocery delivery", "Fresh halal meat online", "United Kingdom (inferred)", [primaryProduct]),
    site("b.example", "Halal meat shop", "Fresh halal grocery and meat delivery", "United Kingdom (inferred)", [rivalProduct]),
    discovery({ domain: "b.example", websiteUrl: "https://b.example/" }),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.hasProductOverlap, true);
  assert.equal(result.provenPrimaryProduct.name, primaryProduct.name);
  assert.equal(result.provenRivalProduct.name, rivalProduct.name);
});

test("verification finds the strongest pair at the end of MyJam-sized catalogs", () => {
  const primaryProducts = Array.from({ length: 599 }, (_, index) => product("myjam.co.uk", `Primary Grocery Item ${index}`, `primary-category-${index}`));
  const rivalProducts = Array.from({ length: 599 }, (_, index) => product("rival.example", `Different Market Item ${index}`, `rival-category-${index}`));
  const primaryMatch = product("myjam.co.uk", "Halal Lamb Chops 500g", "halal meat");
  const rivalMatch = product("rival.example", "Fresh Halal Lamb Chops 500g", "halal meat");
  const result = verifyCompetitorEntity(
    site("myjam.co.uk", "UK halal grocery delivery", "Fresh halal meat and cultural groceries", "United Kingdom (inferred)", [...primaryProducts, primaryMatch]),
    site("rival.example", "Halal grocery delivery", "Fresh halal grocery and meat delivery", "United Kingdom (inferred)", [...rivalProducts, rivalMatch]),
    discovery(),
  );
  assert.equal(result.hasProductOverlap, true);
  assert.equal(result.provenPrimaryProduct.name, primaryMatch.name);
  assert.equal(result.provenRivalProduct.name, rivalMatch.name);
});

test("verification preserves SaaS same-tier matching without shared name terms", () => {
  const primaryPlan = product("primary.example", "Growth", "saas-plan-growth", "SoftwareApplication");
  const rivalPlan = product("rival.example", "Professional", "saas-plan-professional", "SoftwareApplication");
  const result = verifyCompetitorEntity(
    site("primary.example", "Marketing automation software", "Campaign automation for growing teams", "Global market (inferred)", [primaryPlan]),
    site("rival.example", "Marketing automation platform", "Campaign automation software for teams", "Global market (inferred)", [rivalPlan]),
    discovery({ marketCategory: "marketing automation software", sharedOfferings: ["campaign automation"] }),
  );
  assert.equal(result.hasProductOverlap, true);
  assert.equal(result.provenPrimaryProduct.name, "Growth");
  assert.equal(result.provenRivalProduct.name, "Professional");
});

test("verification preserves catalog order when rival pairs tie exactly", () => {
  const primaryProduct = product("primary.example", "Halal Lamb Chops", "halal meat");
  const firstRival = { ...product("rival.example", "Fresh Halal Lamb Chops", "halal meat"), id: "first-rival" };
  const secondRival = { ...firstRival, id: "second-rival", sourceUrl: "https://rival.example/products/second-rival" };
  const result = verifyCompetitorEntity(
    site("primary.example", "Halal grocery delivery", "Fresh halal meat online", "United Kingdom (inferred)", [primaryProduct]),
    site("rival.example", "Halal grocery delivery", "Fresh halal meat online", "United Kingdom (inferred)", [firstRival, secondRival]),
    discovery(),
  );
  assert.equal(result.provenRivalProduct.id, "first-rival");
});

test("uses both agencies' first-party capability headings for category alignment", () => {
  const primary = { ...site("studio.example", "Digital Product Studio", "We make digital experiences", "Global market (inferred)"), headings: ["Product strategy", "UX and UI design", "Web and mobile development"] };
  const rival = { ...site("rival.example", "Product design and engineering agency", "Digital products for ambitious companies", "United States (inferred)"), headings: ["Product strategy", "UX design", "Mobile app development"] };
  const result = verifyCompetitorEntity(primary, rival, discovery({ marketCategory: "digital product design and development agency", sharedOfferings: ["product strategy", "UX design", "mobile development"] }));
  assert.equal(result.categoryAlignment, true);
  assert.equal(result.regionCompatibility, true);
  assert.equal(result.accepted, true);
});

test("ranks a verified product-backed rival ahead only after entity acceptance", () => {
  const base = { verificationScore: 90, accepted: true, hasProductOverlap: false };
  const productBacked = { ...base, verificationScore: 70, hasProductOverlap: true };
  const rejectedProductLead = { ...productBacked, accepted: false, verificationScore: 99 };
  assert.ok(compareVerifiedCompetitors(base, productBacked) > 0);
  assert.ok(compareVerifiedCompetitors(base, rejectedProductLead) < 0);
});

test("uses a concrete discovery market instead of a broad primary-site global label", () => {
  const target = resolveVerificationMarket("United States (inferred)", "Global market (inferred)", "first-party-inferred");
  assert.deepEqual(target, { region: "United States (inferred)", regionCode: "US", source: "discovery-inferred" });

  const primary = site("babanuj.com", "Mediterranean grocery and sweets", "Shop Mediterranean pantry products online", "Global market (inferred)");
  const india = verifyCompetitorEntity(
    primary,
    { ...site("desertcart.in", "Mediterranean grocery and sweets India", "Shop Mediterranean pantry products online in India", "India (inferred)"), regionEvidenceSource: "first-party-observed" },
    discovery({ domain: "desertcart.in", websiteUrl: "https://desertcart.in/" }),
    target,
  );
  const saudi = verifyCompetitorEntity(
    primary,
    { ...site("desertcart.com.sa", "Mediterranean grocery and sweets Saudi", "Shop Mediterranean pantry products online in Saudi Arabia", "Saudi Arabia (inferred)"), regionEvidenceSource: "first-party-observed" },
    discovery({ domain: "desertcart.com.sa", websiteUrl: "https://desertcart.com.sa/" }),
    target,
  );

  assert.equal(india.regionCompatibility, false);
  assert.equal(india.accepted, false);
  assert.equal(india.targetRegionCode, "US");
  assert.equal(india.candidateRegionCode, "IN");
  assert.match(india.regionDecisionReason, /Target market US \(discovery-inferred\) conflicts with candidate region IN \(first-party-observed\)/);
  assert.equal(saudi.regionCompatibility, false);
  assert.equal(saudi.candidateRegionCode, "SA");
});

test("preserves global and unknown candidate neutrality for a concrete target", () => {
  const target = resolveVerificationMarket("US", "Global market (inferred)");
  const primary = site("primary.example", "Halal grocery delivery", "Fresh halal meat and grocery delivery", "Global market (inferred)");
  const global = verifyCompetitorEntity(primary, site("global.example", "Global halal grocery", "Fresh halal meat and grocery delivery worldwide", "Global market (inferred)"), discovery(), target);
  const unknown = verifyCompetitorEntity(primary, site("unknown.example", "Halal grocery", "Fresh halal meat and grocery delivery", "Not enough public signal"), discovery(), target);
  assert.equal(global.regionCompatibility, true);
  assert.equal(global.candidateRegionCode, "GLOBAL");
  assert.equal(unknown.regionCompatibility, true);
  assert.equal(unknown.candidateRegionCode, "");
});

test("falls back to primary first-party region when discovery is global or unsupported", () => {
  assert.deepEqual(
    resolveVerificationMarket("Global market (inferred)", "United Kingdom (inferred)", "first-party-observed"),
    { region: "United Kingdom (inferred)", regionCode: "GB", source: "primary-first-party-observed" },
  );
  assert.deepEqual(
    resolveVerificationMarket("South Africa", "United Kingdom (inferred)", "first-party-observed"),
    { region: "United Kingdom (inferred)", regionCode: "GB", source: "primary-first-party-observed" },
  );
});

test("keeps observed multi-label country storefronts decisive when combined page signals are unknown", () => {
  const target = resolveVerificationMarket("United States", "United States (inferred)");
  const primary = site("babanuj.com", "Middle Eastern sweets online", "Baklava, maamoul, and Turkish delight delivery", "United States (inferred)");
  for (const [domain, code] of [["desertcart.com.sa", "SA"], ["desertcart.com.eg", "EG"]]) {
    const result = verifyCompetitorEntity(
      primary,
      { ...site(domain, "Middle Eastern sweets marketplace", "Baklava, maamoul, and Turkish delight delivery", "Not enough public signal"), countryTldRegionCode: code },
      discovery({ domain, websiteUrl: `https://${domain}/` }),
      target,
    );
    assert.equal(result.regionCompatibility, false, domain);
    assert.equal(result.accepted, false, domain);
    assert.equal(result.candidateRegionCode, code, domain);
    assert.equal(result.candidateCombinedRegionCode, "", domain);
    assert.equal(result.candidateRegionBasis, "country-code-storefront", domain);
    assert.match(result.regionDecisionReason, new RegExp(`country-code storefront ${domain.replaceAll(".", "\\.")} resolves to ${code} \\(first-party-observed\\); combined page signals resolved unknown`));
  }
});

test("country storefront evidence overrides a conflicting concrete combined region", () => {
  const target = resolveVerificationMarket("US", "United States (inferred)");
  const result = verifyCompetitorEntity(
    site("primary.example", "Halal grocery delivery", "Fresh halal grocery delivery", "United States (inferred)"),
    { ...site("seller.in", "Halal grocery delivery", "Fresh halal grocery delivery", "United States (inferred)"), countryTldRegionCode: "IN" },
    discovery({ domain: "seller.in", websiteUrl: "https://seller.in/" }),
    target,
  );
  assert.equal(result.regionCompatibility, false);
  assert.equal(result.candidateRegionCode, "IN");
  assert.equal(result.candidateCombinedRegionCode, "US");
  assert.match(result.regionDecisionReason, /country-code storefront seller\.in resolves to IN .*combined page signals resolved US/);
});

test("same-market storefront and combined-region candidates remain compatible", () => {
  const target = resolveVerificationMarket("US", "United States (inferred)");
  const primary = site("primary.example", "Halal grocery delivery", "Fresh halal grocery delivery", "United States (inferred)");
  const storefront = verifyCompetitorEntity(primary, { ...site("seller.us", "Halal grocery delivery", "Fresh halal grocery delivery", "Not enough public signal"), countryTldRegionCode: "US" }, discovery(), target);
  const combined = verifyCompetitorEntity(primary, site("seller.com", "Halal grocery delivery", "Fresh halal grocery delivery", "United States (inferred)"), discovery(), target);
  const unknown = verifyCompetitorEntity(primary, site("seller.io", "Halal grocery delivery", "Fresh halal grocery delivery", "Not enough public signal"), discovery(), target);
  assert.equal(storefront.regionCompatibility, true);
  assert.equal(storefront.candidateRegionBasis, "country-code-storefront");
  assert.equal(combined.regionCompatibility, true);
  assert.equal(combined.candidateRegionBasis, "combined-first-party");
  assert.equal(unknown.regionCompatibility, true);
  assert.equal(unknown.candidateRegionCode, "");
});
