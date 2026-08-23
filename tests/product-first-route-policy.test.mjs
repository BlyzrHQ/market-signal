import assert from "node:assert/strict";
import test from "node:test";

import { competitorInvestigationComplete, finalizedComparisonTargetCoverage, finalizedDiscoveryCoverage, investigationGapSourceUrl, MAX_PRIMARY_CATALOG_PRODUCTS, rememberedReverificationFailures, resolvePrimaryDiscoveryPolicy, selectComparisonTarget, verifiedExactMatchHints, verifyDiscoveredCompetitor, verifyDiscoveredCompetitorWithInferredLeads, verifyInferredProductLead, verifyInferredProductLeads } from "../app/api/crawl/route.ts";
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

test("the primary catalog screening bound is independent of the 20-result publication target", () => {
  assert.equal(MAX_PRIMARY_CATALOG_PRODUCTS, 1_000);
});

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

test("one seller preserves more than twelve verified exact pairs as match hints", async () => {
  const primaryProducts = Array.from({ length: 13 }, (_, index) => ({ ...product("myjam.co.uk", `Halal Product ${index} 500g`), id: `primary-${index}` }));
  const rivalProducts = Array.from({ length: 13 }, (_, index) => ({ ...product("rival.example", `Halal Product ${index} 500g`), id: `rival-${index}`, extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [{ raw: `GBP ${index + 1}`, currency: "GBP", amount: index + 1 }] }));
  const discovery = {
    ...rememberedCandidate(),
    inferredProductLeads: primaryProducts.map((primary, index) => ({ primaryProductId: primary.id, primarySourceUrl: primary.sourceUrl, laneQuery: `halal product ${index}`, candidateDomain: "rival.example", candidateSourceUrl: rivalProducts[index].sourceUrl, admission: "inferred-cross-language" })),
  };
  const judge = async () => ({ rows: primaryProducts.map((primary, index) => ({ primary, matches: [{ domain: "rival.example", product: rivalProducts[index], confidence: "Medium", assessment: { verdict: "same_product", confidence: 0.95, contradictions: [] } }] })) });

  assert.equal((await verifyInferredProductLeads(crawl("myjam.co.uk", primaryProducts), crawl("rival.example", rivalProducts), discovery, judge)).length, 13);
  const verified = await verifyDiscoveredCompetitorWithInferredLeads(crawl("myjam.co.uk", primaryProducts), crawl("rival.example", rivalProducts), discovery, resolveVerificationMarket("United Kingdom", "United Kingdom"), true, judge);
  const hints = verifiedExactMatchHints([verified]);
  assert.equal(hints.length, 13);
  assert.ok(hints.some((hint) => hint.primaryId === "primary-12" && hint.rivalDomain === "rival.example" && hint.rivalId === "rival-12"));
});

test("selects exactly twenty publication-eligible pairs before deriving competitor domains", () => {
  const observedAt = "2026-08-23T00:00:00.000Z";
  const primaryProducts = Array.from({ length: 5 }, (_, primaryIndex) => ({
    ...product("myjam.co.uk", `MyJam Product ${primaryIndex + 1} 500g`),
    id: `primary-${primaryIndex + 1}`,
    observedAt,
    priceSignals: [{ raw: `GBP ${primaryIndex + 5}.00`, currency: "GBP", amount: primaryIndex + 5 }],
  }));
  const rivals = Array.from({ length: 25 }, (_, index) => {
    const domain = `rival-${(index % 7) + 1}.co.uk`;
    const primary = primaryProducts[index % primaryProducts.length];
    const rival = {
      ...product(domain, `Comparable ${index + 1} 500g`),
      id: `rival-${index + 1}`,
      observedAt,
      extraction: "json-ld",
      ownership: "self-declared-brand",
      priceSignals: [{ raw: `GBP ${index + 1}.00`, currency: "GBP", amount: index + 1 }],
    };
    return {
      ...crawl(domain, [rival]),
      verifiedExactProductPairs: [{ primary, rival, confidence: 0.95 }],
      discovery: { ...rememberedCandidate(), domain, accepted: true, verificationScore: 90 },
    };
  });
  const selected = selectComparisonTarget(primaryProducts, rivals, 20, "GB", Date.parse(observedAt));
  assert.equal(selected.hints.length, 20);
  assert.equal(new Set(selected.hints.map((pair) => `${pair.primaryId}|${pair.rivalDomain}|${pair.rivalId}`)).size, 20);
  assert.deepEqual(selected.competitors.map((result) => result.domain), [...new Set(selected.hints.map((pair) => pair.rivalDomain))]);
  assert.ok(selected.competitors.every((result) => result.verifiedExactProductPairs.every((pair) => selected.hints.some((hint) => hint.primaryId === pair.primary.id && hint.rivalDomain === result.domain && hint.rivalId === pair.rival.id))));
});

test("does not count a semantically verified pair whose price or market would fail publication", () => {
  const observedAt = "2026-08-23T00:00:00.000Z";
  const primary = { ...product("myjam.co.uk", "MyJam Product 500g"), id: "primary", observedAt, priceSignals: [{ raw: "GBP 5.00", currency: "GBP", amount: 5 }] };
  const ukRival = { ...product("valid-rival.co.uk", "Comparable 500g"), id: "valid", observedAt, extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [{ raw: "GBP 4.00", currency: "GBP", amount: 4 }] };
  const usRival = { ...product("wrong-market.com", "Comparable 500g"), id: "wrong-market", observedAt, extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [{ raw: "GBP 4.00", currency: "GBP", amount: 4 }] };
  const unpriced = { ...product("unpriced.co.uk", "Comparable 500g"), id: "unpriced", observedAt, extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [] };
  const candidates = [ukRival, usRival, unpriced].map((rival) => ({
    ...crawl(rival.domain, [rival]),
    verifiedExactProductPairs: [{ primary, rival, confidence: 0.95 }],
    discovery: { ...rememberedCandidate(), domain: rival.domain, accepted: true, verificationScore: 90 },
  }));
  const selected = selectComparisonTarget([primary], candidates, 20, "GB", Date.parse(observedAt));
  assert.deepEqual(selected.hints, [{ primaryId: "primary", rivalDomain: "valid-rival.co.uk", rivalId: "valid" }]);
  assert.deepEqual(selected.competitors.map((result) => result.domain), ["valid-rival.co.uk"]);
  assert.deepEqual(selectComparisonTarget([primary], candidates, 20, "US", Date.parse(observedAt)).hints, []);
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

test("promotes a priced product after a same-domain locale redirect preserves the requested seed", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "Arabic Tea 500g"), id: "primary-ar", sourceUrl: "https://noororganicfood.com/product/tea-500g" };
  const finalUrl = "https://health.example/en/products/tea-500g";
  const rivalProduct = { ...product("health.example", "Organic Tea 500g"), id: "rival-en", sourceUrl: finalUrl, extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [{ raw: "KWD 8.00", currency: "KWD", amount: 8 }] };
  const primary = crawl("noororganicfood.com", [primaryProduct]);
  const rival = crawl("health.example", [rivalProduct]);
  rival.pages = rival.pages.map((page) => page.sourceUrl === finalUrl
    ? { ...page, requestedSourceUrl: "https://health.example/products/tea-500g" }
    : page);
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "tea 500g", candidateDomain: "health.example", candidateSourceUrl: "https://health.example/products/tea-500g", admission: "inferred-cross-language" }] };
  const accepted = await verifyInferredProductLead(primary, rival, discovery, async () => ({ rows: [{ primary: primaryProduct, matches: [{ domain: "health.example", product: rivalProduct, confidence: "Medium", assessment: { verdict: "close_substitute", confidence: 0.91, contradictions: [] } }] }] }));
  assert.equal(accepted?.rival.sourceUrl, finalUrl);
});

test("rejects a same-domain redirect that changes the seeded product identity", async () => {
  const primaryProduct = { ...product("noororganicfood.com", "Arabic Reishi Honey 500g"), id: "primary-ar", sourceUrl: "https://noororganicfood.com/product/reishi-honey" };
  const finalUrl = "https://health.example/en/products/ginseng-capsules-60";
  const rivalProduct = { ...product("health.example", "Ginseng Capsules 60"), id: "rival-en", sourceUrl: finalUrl, extraction: "json-ld", ownership: "self-declared-brand", priceSignals: [{ raw: "KWD 8.00", currency: "KWD", amount: 8 }] };
  const rival = crawl("health.example", [rivalProduct]);
  rival.pages = rival.pages.map((page) => page.sourceUrl === finalUrl
    ? { ...page, requestedSourceUrl: "https://health.example/products/reishi-honey-500g" }
    : page);
  const discovery = { ...rememberedCandidate(), domain: "health.example", inferredProductLeads: [{ primaryProductId: primaryProduct.id, primarySourceUrl: primaryProduct.sourceUrl, laneQuery: "reishi honey 500g", candidateDomain: "health.example", candidateSourceUrl: "https://health.example/products/reishi-honey-500g", admission: "inferred-cross-language" }] };
  const accepted = await verifyInferredProductLead(crawl("noororganicfood.com", [primaryProduct]), rival, discovery, async () => { throw new Error("judge must not run"); });
  assert.equal(accepted, undefined);
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

test("failed inference-only investigations never publish provisional search-result URLs", () => {
  const candidate = crawl("health.example", []);
  candidate.homepage = null;
  candidate.discovery = {
    ...rememberedCandidate(),
    sourceUrl: "https://health.example/products/unverified-honey",
    observedAdmission: false,
  };
  assert.equal(investigationGapSourceUrl(candidate), "");
  candidate.discovery.observedAdmission = true;
  assert.equal(investigationGapSourceUrl(candidate), "https://health.example/products/unverified-honey");
});

test("discovery exhaustion fails closed on candidate truncation or nonterminal verification failure", () => {
  const coverage = {
    eligibleAnchors: 20, searchedAnchors: 20, startIndex: 0, endIndex: 20, truncated: false,
    searchesComplete: true, candidateDomainsFound: 0, candidateDomainsInvestigated: 0,
    candidateTruncated: false, verificationComplete: false, batchComplete: false, complete: false,
  };
  const verified = crawl("verified.example", []);
  const timedOut = { ...crawl("timeout.example", []), homepage: null, gaps: [{ url: "https://timeout.example/", reason: "request timed out", observedAt: "2026-08-07T00:00:00.000Z" }] };
  const terminal404 = { ...timedOut, gaps: [{ ...timedOut.gaps[0], reason: "homepage returned HTTP 404." }] };

  const truncated = finalizedDiscoveryCoverage(coverage, 21, 20, Array(20).fill("fulfilled"), Array(20).fill(verified), true);
  assert.equal(truncated.candidateTruncated, true);
  assert.equal(truncated.complete, false);

  const transient = finalizedDiscoveryCoverage(coverage, 2, 2, ["fulfilled", "fulfilled"], [verified, timedOut], true);
  assert.equal(transient.verificationComplete, false);
  assert.equal(transient.complete, false);
  assert.equal(competitorInvestigationComplete(timedOut), false);

  const terminal = finalizedDiscoveryCoverage(coverage, 2, 2, ["fulfilled", "fulfilled"], [verified, terminal404], true);
  assert.equal(terminal.verificationComplete, true);
  assert.equal(terminal.complete, true);
  assert.equal(competitorInvestigationComplete(terminal404), true);

  const seededTimeout = {
    ...verified,
    discovery: { matchedProductUrl: "https://verified.example/products/beef-cubes" },
    gaps: [{ url: "https://verified.example/products/beef-cubes", reason: "request timed out", observedAt: "2026-08-07T00:00:00.000Z" }],
  };
  assert.equal(competitorInvestigationComplete(seededTimeout), false);
  const seededProcessingFailure = {
    ...verified,
    discovery: { matchedProductUrl: "https://verified.example/products/beef-cubes" },
    gaps: [{ url: "https://verified.example/products/beef-cubes", reason: "page processing failed before verification completed.", observedAt: "2026-08-07T00:00:00.000Z" }],
  };
  assert.equal(competitorInvestigationComplete(seededProcessingFailure), false);
  const persistenceFailed = finalizedDiscoveryCoverage(coverage, 1, 1, ["fulfilled"], [verified], true, false);
  assert.equal(persistenceFailed.batchComplete, false);
  assert.equal(persistenceFailed.complete, false);
});

test("a crawl-side pair target stops the batch without claiming final discovery exhaustion", () => {
  const coverage = {
    eligibleAnchors: 1_000, searchedAnchors: 10, startIndex: 0, endIndex: 10, truncated: true,
    searchesComplete: true, candidateDomainsFound: 24, candidateDomainsInvestigated: 20,
    candidateTruncated: true, verificationComplete: false, batchComplete: false, complete: false,
  };
  const verified = crawl("verified.example", []);
  const finalized = finalizedComparisonTargetCoverage(
    coverage,
    24,
    Array(20).fill("fulfilled"),
    Array(20).fill(verified),
    20,
    20,
  );
  assert.equal(finalized.acceptedPairCount, 20);
  assert.equal(finalized.batchComplete, true);
  assert.equal(finalized.complete, false);
});

test("a transient candidate verification failure cannot advance an under-target comparison batch", () => {
  const coverage = {
    eligibleAnchors: 1_000, searchedAnchors: 10, startIndex: 0, endIndex: 10, truncated: true,
    searchesComplete: true, candidateDomainsFound: 2, candidateDomainsInvestigated: 0,
    candidateTruncated: false, verificationComplete: false, batchComplete: false, complete: false,
  };
  const verified = crawl("verified.example", []);
  const timedOut = { ...crawl("timeout.example", []), homepage: null, gaps: [{ url: "https://timeout.example/", reason: "request timed out", observedAt: "2026-08-23T00:00:00.000Z" }] };
  const base = finalizedDiscoveryCoverage(coverage, 2, 2, ["fulfilled", "fulfilled"], [verified, timedOut], true);
  const finalized = finalizedComparisonTargetCoverage(base, 2, ["fulfilled", "fulfilled"], [verified, timedOut], 12, 20);
  assert.equal(finalized.verificationComplete, false);
  assert.equal(finalized.batchComplete, false);
  assert.equal(finalized.complete, false);
});
