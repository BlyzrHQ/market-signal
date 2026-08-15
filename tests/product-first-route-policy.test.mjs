import assert from "node:assert/strict";
import test from "node:test";

import { rememberedReverificationFailures, resolvePrimaryDiscoveryPolicy, verifiedExactMatchHints, verifyDiscoveredCompetitor, verifyDiscoveredCompetitorWithInferredLeads, verifyInferredProductLead } from "../app/api/crawl/route.ts";
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
  const homepage = { ...page(domain), products: [] };
  const productPages = products.map((item) => ({ ...homepage, path: new URL(item.sourceUrl).pathname, sourceUrl: item.sourceUrl, products: [item] }));
  return {
    domain,
    role: domain === "myjam.co.uk" ? "primary" : "discovered-competitor",
    homepage,
    pages: [homepage, ...productPages],
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

test("promotes only the exact structured, priced inferred product page after semantic acceptance", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "عسل الريشي 500 غرام"), id: "primary-ar", sourceUrl: "https://noororganicfood.com/product/reishi-honey" };
  const rivalProduct = { ...product("health.example", "Organic Reishi Honey 500g"), id: "rival-en", sourceUrl: "https://health.example/products/reishi-honey-500g?utm_source=search", extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [{ raw: "KWD 8.00", currency: "KWD", amount: 8 }] };
  const primary = crawl("noororganicfood.com", [primaryProduct]);
  const rival = crawl("health.example", [rivalProduct, { ...rivalProduct, id: "borrowed", sourceUrl: "https://health.example/products/other" }]);
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "reishi honey 500g kuwait", candidateDomain: "health.example", candidateSourceUrl: "https://health.example/products/reishi-honey-500g", admission: "inferred-cross-language" }] };
  let calls = 0;
  let judgeOptions;
  const accepted = await verifyInferredProductLead(primary, rival, discovery, async (_domain, _catalogs, options) => {
    calls += 1;
    judgeOptions = options;
    return { rows: [{ primary: primaryProduct, matches: [{ domain: "health.example", product: rivalProduct, confidence: "Medium", assessment: { verdict: "close_substitute", confidence: 0.91, contradictions: [] } }] }] };
  });
  assert.equal(calls, 1);
  assert.deepEqual(judgeOptions.pinnedPairs, [{ primaryId: primaryProduct.id, rivalDomain: "health.example", rivalId: rivalProduct.id }]);
  assert.equal(accepted?.primary.id, primaryProduct.id);
  assert.equal(accepted?.rival.id, rivalProduct.id);

  const unpriced = crawl("health.example", [{ ...rivalProduct, priceSignals: [] }]);
  const rejected = await verifyInferredProductLead(primary, unpriced, discovery, async () => { throw new Error("judge must not run"); });
  assert.equal(rejected, undefined);
});

test("rejects inferred leads when the exact page is absent or the one-pair judge declines", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "عسل الريشي 500 غرام"), id: "primary-ar", sourceUrl: "https://noororganicfood.com/product/reishi-honey" };
  const rivalProduct = { ...product("health.example", "Organic Reishi Honey 500g"), id: "rival-en", sourceUrl: "https://health.example/products/other", extraction: "json-ld", priceSignals: [{ raw: "KWD 8", currency: "KWD", amount: 8 }] };
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "reishi honey 500g", candidateDomain: "health.example", candidateSourceUrl: "https://health.example/products/reishi-honey-500g", admission: "inferred-cross-language" }] };
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), crawl("health.example", [rivalProduct]), discovery, async () => { throw new Error("judge must not run"); }), undefined);
  const exact = { ...rivalProduct, sourceUrl: "https://health.example/products/reishi-honey-500g" };
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), crawl("health.example", [exact]), discovery, async () => ({ rows: [{ primary: primaryProduct, matches: [{ domain: "health.example", product: exact, confidence: "Medium", assessment: { verdict: "no_match", confidence: 0.99, contradictions: [] } }] }] })), undefined);
  for (const assessment of [
    { verdict: "close_substitute", confidence: 0.79, contradictions: [] },
    { verdict: "same_product", confidence: 0.99, contradictions: ["Observed quantity conflicts."] },
  ]) assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), crawl("health.example", [exact]), discovery, async () => ({ rows: [{ primary: primaryProduct, matches: [{ domain: "health.example", product: exact, confidence: "Medium", assessment }] }] })), undefined);
});

test("rejects a listing response that exposes several priced product identities at the seeded URL", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "عسل الريشي 500 غرام"), id: "primary-ar", sourceUrl: "https://noororganicfood.com/product/reishi-honey" };
  const sourceUrl = "https://health.example/shop/reishi-honey";
  const first = { ...product("health.example", "Organic Reishi Honey 500g"), id: "r1", sourceUrl, extraction: "json-ld", priceSignals: [{ raw: "KWD 8", currency: "KWD", amount: 8 }] };
  const second = { ...product("health.example", "Organic Lion Mane Honey 500g"), id: "r2", sourceUrl, extraction: "json-ld", priceSignals: [{ raw: "KWD 9", currency: "KWD", amount: 9 }] };
  const candidate = crawl("health.example", [first]);
  candidate.pages = [{ ...candidate.pages[0], path: "/shop/reishi-honey", sourceUrl, products: [first, second] }];
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "reishi honey 500g", candidateDomain: "health.example", candidateSourceUrl: sourceUrl, admission: "inferred-cross-language" }] };
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), candidate, discovery, async () => { throw new Error("judge must not run"); }), undefined);
});

test("preserves product identity query parameters while ignoring known tracking parameters", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "Arabic Honey"), id: "primary", sourceUrl: "https://noororganicfood.com/product?id=10" };
  const rivalProduct = { ...product("health.example", "Organic Honey"), id: "rival", sourceUrl: "https://health.example/product?id=22&utm_source=search", extraction: "json-ld", priceSignals: [{ raw: "KWD 8", currency: "KWD", amount: 8 }] };
  const candidate = crawl("health.example", [rivalProduct]);
  const base = { ...rememberedCandidate(), domain: "health.example" };
  const lead = (url) => ({ ...base, inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "organic honey", candidateDomain: "health.example", candidateSourceUrl: url, admission: "inferred-cross-language" }] });
  const judge = async () => ({ rows: [{ primary: primaryProduct, matches: [{ domain: "health.example", product: rivalProduct, confidence: "Medium", assessment: { verdict: "same_product", confidence: 0.95, contradictions: [] } }] }] });

  assert.equal((await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), candidate, lead("https://health.example/product?id=22&utm_source=search"), judge))?.rival.id, "rival");
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), candidate, lead("https://health.example/product?id=21"), async () => { throw new Error("judge must not run"); }), undefined);
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), candidate, lead("https://health.example/product?id=22&ref=sku-a"), async () => { throw new Error("judge must not run"); }), undefined);
});

test("rejects same-name exact-page variants when price, quantity, or identifiers differ", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "Arabic Honey"), id: "primary", sourceUrl: "https://noororganicfood.com/product/honey" };
  const sourceUrl = "https://health.example/products/honey";
  const first = { ...product("health.example", "Organic Honey"), id: "r1", sourceUrl, extraction: "json-ld", quantity: { kind: "mass", amount: 250, unit: "g" }, identifiers: { gtins: [], sku: "H-250" }, priceSignals: [{ raw: "KWD 8", currency: "KWD", amount: 8 }] };
  const second = { ...first, id: "r2", quantity: { kind: "mass", amount: 500, unit: "g" }, identifiers: { gtins: [], sku: "H-500" }, priceSignals: [{ raw: "KWD 12", currency: "KWD", amount: 12 }] };
  const candidate = crawl("health.example", [first]);
  candidate.pages = [{ ...candidate.pages[0], path: "/products/honey", sourceUrl, products: [first, second] }];
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "organic honey", candidateDomain: "health.example", candidateSourceUrl: sourceUrl, admission: "inferred-cross-language" }] };
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), candidate, discovery, async () => { throw new Error("judge must not run"); }), undefined);
});

test("rejects same-name exact-page variants that differ only by a variant attribute", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "Arabic Shirt"), id: "primary", sourceUrl: "https://noororganicfood.com/product/shirt" };
  const sourceUrl = "https://fashion.example/products/shirt";
  const first = { ...product("fashion.example", "Organic Shirt"), id: "r1", sourceUrl, extraction: "json-ld", attributes: ["Color: Red"], priceSignals: [{ raw: "USD 20", currency: "USD", amount: 20 }] };
  const second = { ...first, id: "r2", attributes: ["Color: Blue"] };
  const candidate = crawl("fashion.example", [first]);
  candidate.pages = [{ ...candidate.pages[0], path: "/products/shirt", sourceUrl, products: [first, second] }];
  const discovery = { ...rememberedCandidate(), domain: "fashion.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "organic shirt", candidateDomain: "fashion.example", candidateSourceUrl: sourceUrl, admission: "inferred-cross-language" }] };
  assert.equal(await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), candidate, discovery, async () => { throw new Error("judge must not run"); }), undefined);
});

test("an inference-only failed lead cannot fall through to unrelated deterministic catalog overlap", async () => {
  const primaryProducts = [product("noororganicfood.com", "Shared Coffee 1kg"), { ...product("noororganicfood.com", "Arabic Honey"), id: "target" }];
  const rivalProducts = [product("health.example", "Shared Coffee 1kg")];
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: "target", primarySourceUrl: primaryProducts[1].sourceUrl, laneQuery: "organic honey", candidateDomain: "health.example", candidateSourceUrl: "https://health.example/products/missing", admission: "inferred-cross-language" }] };
  const result = await verifyDiscoveredCompetitorWithInferredLeads(crawl("noororganicfood.com", primaryProducts), crawl("health.example", rivalProducts), discovery, resolveVerificationMarket("United Kingdom", "United Kingdom"), true);
  assert.equal(result.discovery.accepted, false);
  assert.equal(result.discovery.hasProductOverlap, false);

  const observed = await verifyDiscoveredCompetitorWithInferredLeads(crawl("noororganicfood.com", primaryProducts), crawl("health.example", rivalProducts), { ...discovery, observedAdmission: true }, resolveVerificationMarket("United Kingdom", "United Kingdom"), true);
  assert.equal(observed.discovery.hasProductOverlap, true);
});

test("a verified exact pair emits a pin even when observed core overlap is the displayed basis", () => {
  const primaryProduct = product("noororganicfood.com", "Organic Honey 500g");
  const rivalProduct = { ...product("health.example", "Organic Honey 500g"), priceSignals: [{ raw: "KWD 8", currency: "KWD", amount: 8 }] };
  const verified = verifyDiscoveredCompetitor(crawl("noororganicfood.com", [primaryProduct]), crawl("health.example", [rivalProduct]), { ...rememberedCandidate(), domain: "health.example" }, resolveVerificationMarket("United Kingdom", "United Kingdom"), true, { primary: primaryProduct, rival: rivalProduct, confidence: 0.95 });
  assert.equal(verified.discovery.categoryBasis, "observed-core");
  assert.equal(verified.discovery.exactProductPairVerified, true);
  assert.deepEqual(verifiedExactMatchHints([verified]), [{ primaryId: primaryProduct.id, rivalDomain: "health.example", rivalId: rivalProduct.id }]);
});

test("publication provenance is rebound atomically to the exact inferred lead that passed", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "Arabic Honey"), id: "primary", sourceUrl: "https://noororganicfood.com/product/honey" };
  const rivalProduct = { ...product("health.example", "Organic Honey"), id: "rival", sourceUrl: "https://health.example/products/right", extraction: "json-ld", priceSignals: [{ raw: "KWD 8", currency: "KWD", amount: 8 }] };
  const discovery = { ...rememberedCandidate(), domain: "health.example", sourceUrl: "https://health.example/products/wrong", searchQuery: "wrong query", inferredProductLeads: [
    { primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "wrong query", candidateDomain: "health.example", candidateSourceUrl: "https://health.example/products/wrong", admission: "inferred-cross-language" },
    { primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "right query", candidateDomain: "health.example", candidateSourceUrl: rivalProduct.sourceUrl, admission: "inferred-cross-language" },
  ] };
  const judge = async () => ({ rows: [{ primary: primaryProduct, matches: [{ domain: "health.example", product: rivalProduct, confidence: "Medium", assessment: { verdict: "same_product", confidence: 0.95, contradictions: [] } }] }] });
  const result = await verifyDiscoveredCompetitorWithInferredLeads(crawl("noororganicfood.com", [primaryProduct]), crawl("health.example", [rivalProduct]), discovery, resolveVerificationMarket("United Kingdom", "United Kingdom"), true, judge);
  assert.equal(result.discovery.accepted, true);
  assert.equal(result.discovery.sourceUrl, rivalProduct.sourceUrl);
  assert.equal(result.discovery.searchQuery, "right query");
  assert.equal(result.discovery.matchedProductUrl, rivalProduct.sourceUrl);
  assert.deepEqual(result.discovery.evidence.map((item) => item.url), [rivalProduct.sourceUrl]);
});
