import assert from "node:assert/strict";
import test from "node:test";

import { candidatesFromSearchEvidence, discoverCompetitors, entityCandidatesFromSearchEvidence, mergeCandidates, productSearchAnchors, sanitizeCandidate } from "../app/lib/competitor-discovery.ts";

function product(name, sourceUrl) {
  return {
    id: name,
    domain: "myjam.co.uk",
    name,
    normalizedName: name.toLowerCase(),
    description: "",
    category: "products",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl,
    imageUrl: "",
    observedAt: "2026-07-13T00:00:00.000Z",
    claimIds: [],
  };
}

const profile = {
  domain: "myjam.co.uk",
  title: "MyJam",
  description: "UK cultural grocery marketplace",
  region: "United Kingdom",
  language: "en",
  products: [
    product("Beef Sirloin Steak Halal 500g", "https://myjam.co.uk/products/beef-sirloin-steak-halal-500g"),
    product("Lamb Leg Halal apx 2500g", "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g"),
  ],
};

test("returns an explicit coverage gap when web discovery is not configured", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.available, false);
    assert.equal(result.candidates.length, 0);
    assert.match(result.gap, /not configured/i);
  } finally {
    if (previous) process.env.OPENAI_API_KEY = previous;
  }
});

test("sanitizes, deduplicates, and excludes the primary domain from model candidates", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.MARKET_SIGNAL_DISCOVERY_MODEL;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  process.env.MARKET_SIGNAL_DISCOVERY_MODEL = "test-search-model";
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.deepEqual(request.tools, [{ type: "web_search" }]);
    assert.equal(request.text.format.type, "json_schema");
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "International grocery delivery", region: "United Kingdom", queries: ["international grocery delivery UK"], candidates: [
      { domain: "https://rival.example/shop", companyName: "Rival", reason: "Sells Halal Lamb Chops 500g", searchQuery: "Halal Lamb Chops 500g UK", sourceUrl: "https://rival.example/products/halal-lamb-chops", evidenceTitle: "Halal Lamb Chops 500g", matchedPrimaryProductName: "Halal Lamb Chops 500g", matchedProductUrl: "https://rival.example/products/halal-lamb-chops" },
      { domain: "myjam.us", companyName: "MyJam US", reason: "Same brand storefront", searchQuery: "same", sourceUrl: "https://myjam.us/products/beef-sirloin-steak-halal-500g", matchedPrimaryProductName: "Beef Sirloin Steak Halal 500g", matchedProductUrl: "https://myjam.us/products/beef-sirloin-steak-halal-500g" },
      { domain: "which.co.uk", companyName: "Which?", reason: "Review publisher", searchQuery: "same", websiteUrl: "https://which.co.uk/", evidenceUrl: "https://which.co.uk/reviews/food-and-drink/article/best-grocery-delivery", evidenceTitle: "Best grocery delivery services reviewed" },
      { domain: "rival.example", companyName: "Duplicate", reason: "Duplicate", searchQuery: "same", sourceUrl: "https://rival.example/", matchedPrimaryProductName: "", matchedProductUrl: "https://rival.example/" },
      { domain: "myjam.co.uk", companyName: "Primary", reason: "Self", searchQuery: "same", sourceUrl: "https://myjam.co.uk/", matchedPrimaryProductName: "", matchedProductUrl: "https://myjam.co.uk/" },
      { domain: "bad.example", companyName: "Bad source", reason: "No evidence", searchQuery: "same", sourceUrl: "javascript:alert(1)", matchedPrimaryProductName: "", matchedProductUrl: "javascript:alert(1)" },
    ] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.available, true);
    assert.equal(result.model, "test-search-model");
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["rival.example"]);
    assert.equal(result.candidates[0].matchedPrimaryProductName, "Halal Lamb Chops 500g");
    assert.match(result.candidates[0].matchedProductUrl, /products\/halal-lamb-chops/);
    assert.equal(result.candidates[0].evidenceMethod, "model-summarized");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
    if (previousModel) process.env.MARKET_SIGNAL_DISCOVERY_MODEL = previousModel; else delete process.env.MARKET_SIGNAL_DISCOVERY_MODEL;
  }
});

test("recovers a search-source candidate when the AI structured candidate array is empty", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  globalThis.fetch = async () => Response.json({ output: [
    { type: "web_search_call", action: { query: "UK buy halal beef sirloin steak 500g", sources: [{ title: "Halal Beef Sirloin Steak 500g | Oasis Market UK", url: "https://oasismarket.co.uk/product/beef-sirloin-steak-halal-500g?utm_source=chatgpt.com" }] } },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: ["UK buy halal beef sirloin steak 500g"], candidates: [] }) }] },
  ] });
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].domain, "oasismarket.co.uk");
    assert.equal(result.candidates[0].evidenceMethod, "search-source");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("retains a visible lane gap instead of exposing an upstream JSON parser error", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  globalThis.fetch = async () => new Response("<!DOCTYPE html><title>Gateway error</title>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.candidates.length, 0);
    assert.ok(result.gaps.length >= 1);
    assert.match(result.gaps.join(" "), /unreadable response/i);
    assert.doesNotMatch(result.gaps.join(" "), /Unexpected token|JSON/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("retains a successful company fallback after product searches return no sellers", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input[1].content);
    if (input.lane === "product") return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: [], candidates: [] }) }] }] });
    if (input.lane === "category") return new Response("<!DOCTYPE html><title>Gateway error</title>", { status: 200, headers: { "content-type": "text/html" } });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: ["MyJam alternatives UK"], candidates: [{ domain: "rival.example", companyName: "Rival", reason: "Same grocery market", searchQuery: "MyJam alternatives UK", websiteUrl: "https://rival.example/", evidenceUrl: "https://rival.example/", evidenceTitle: "Rival halal grocery", marketCategory: "Halal grocery", relationship: "direct", sharedOfferings: ["halal grocery"], matchedPrimaryProductName: "", matchedProductUrl: "" }] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.available, true);
    assert.equal(result.strategy, "company-fallback");
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["rival.example"]);
    assert.ok(result.gaps.length >= 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("turns direct web-search product sources into deterministic seller candidates", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "UK buy halal beef sirloin steak 500g",
        sources: [
          { title: "Halal Beef Sirloin Steak 500g | Oasis Market UK", url: "https://oasismarket.co.uk/product/beef-sirloin-steak-halal-500g?utm_source=chatgpt.com" },
          { title: "Meat products: sell them legally", url: "https://www.gov.uk/guidance/meat-products-sell-them-legally-in-england" },
        ],
      },
    }],
  };
  const candidates = candidatesFromSearchEvidence(payload, profile);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].domain, "oasismarket.co.uk");
  assert.equal(candidates[0].matchedPrimaryProductName, "Beef Sirloin Steak Halal 500g");
  assert.equal(candidates[0].matchedProductUrl, "https://oasismarket.co.uk/product/beef-sirloin-steak-halal-500g");
  assert.equal(candidates[0].evidenceMethod, "search-source");
});

test("uses URL citations when the structured model candidate list is empty", () => {
  const payload = {
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: "",
        annotations: [{ type: "url_citation", title: "Halal Whole Lamb Leg | SaveCo", url: "https://savecobradford.co.uk/products/halal-whole-lamb-leg" }],
      }],
    }],
  };
  const candidates = candidatesFromSearchEvidence(payload, profile, ["halal whole lamb leg UK product"]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].domain, "savecobradford.co.uk");
  assert.equal(candidates[0].matchedPrimaryProductName, "Lamb Leg Halal apx 2500g");
});

test("rejects same-domain, publisher, social, and weak one-word source matches", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        sources: [
          { title: "Lamb Leg Halal apx 2500g", url: "https://myjam.co.uk/products/lamb-leg-halal-apx-2500g" },
          { title: "Lamb Leg Halal apx 2500g", url: "https://shop.myjam.co.uk/products/lamb-leg-halal-apx-2500g" },
          { title: "Halal lamb discussion", url: "https://reddit.com/r/food/example" },
          { title: "Sirloin recipes", url: "https://recipes.example/sirloin" },
          { title: "How to roast a lamb leg", url: "https://food.example/recipes/lamb-leg" },
        ],
      },
    }],
  };
  assert.deepEqual(candidatesFromSearchEvidence(payload, profile), []);
});

test("caps ranked candidate investigations to six companies", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "UK buy halal beef sirloin steak 500g",
        sources: Array.from({ length: 9 }, (_, index) => ({
          title: `Halal Beef Sirloin Steak 500g | Rival ${index + 1}`,
          url: `https://rival-${index + 1}.co.uk/products/halal-beef-sirloin-steak-500g`,
        })),
      },
    }],
  };
  const candidates = candidatesFromSearchEvidence(payload, profile);
  assert.equal(candidates.length, 6);
  assert.deepEqual(candidates.map((candidate) => candidate.domain), Array.from({ length: 6 }, (_, index) => `rival-${index + 1}.co.uk`));
});

test("rejects homepages and ranks URL-confirmed product pages over weaker same-domain leads", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "UK buy halal beef sirloin steak 500g",
        sources: [
          { title: "Halal Beef Sirloin Steak 500g | Grocer", url: "https://grocer.example/" },
          { title: "Halal Beef Sirloin Steak 500g | Meat collection", url: "https://grocer.example/collections/products" },
          { title: "Halal Beef Sirloin Steak 500g | Grocer", url: "https://grocer.example/products/halal-beef-sirloin-steak-500g" },
        ],
      },
    }],
  };
  assert.deepEqual(candidatesFromSearchEvidence(payload, profile).map((candidate) => candidate.matchedProductUrl), [
    "https://grocer.example/products/halal-beef-sirloin-steak-500g",
  ]);
});

test("keeps a single translated product search result as an atomic inferred lead", () => {
  const arabicProfile = {
    ...profile,
    domain: "noororganicfood.com",
    title: "نور للأغذية العضوية",
    products: [product("عسل الريشي 500 غرام", "https://noororganicfood.com/product/reishi-honey-500g")],
  };
  const payload = { output: [{ type: "web_search_call", action: {
    query: "reishi honey 500g kuwait buy",
    sources: [{ title: "Organic Reishi Honey 500g", url: "https://health.example/products/organic-reishi-honey-500g" }],
  } }] };
  const candidates = candidatesFromSearchEvidence(payload, arabicProfile);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].inferredProductLeads, [{
    primaryProductId: "عسل الريشي 500 غرام",
    primarySourceUrl: "https://noororganicfood.com/product/reishi-honey-500g",
    laneQuery: "reishi honey 500g kuwait buy",
    candidateDomain: "health.example",
    candidateSourceUrl: "https://health.example/products/organic-reishi-honey-500g",
    admission: "inferred-cross-language",
  }]);
  assert.deepEqual(candidates[0].sharedOfferings, ["عسل الريشي 500 غرام"]);
});

test("binds one query from a grouped translated action while rejecting citations and collection pages", () => {
  const arabicProfile = { ...profile, products: [product("عسل الريشي 500 غرام", "https://myjam.co.uk/products/reishi-honey")] };
  const payload = { output: [
    { type: "web_search_call", action: { queries: ["reishi honey 500g", "organic honey kuwait"], sources: [{ title: "Reishi Honey 500g", url: "https://health.example/products/reishi-honey-500g" }] } },
    { type: "web_search_call", action: { query: "reishi honey 500g", sources: [{ title: "Reishi Honey 500g", url: "https://health.example/collections/honey" }] } },
    { type: "message", content: [{ type: "output_text", text: "", annotations: [{ type: "url_citation", title: "Reishi Honey 500g", url: "https://health.example/products/reishi-honey-500g" }] }] },
  ] };
  const candidates = candidatesFromSearchEvidence(payload, arabicProfile);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].inferredProductLeads?.[0].laneQuery, "reishi honey 500g");
  assert.equal(candidates[0].matchedProductUrl, "https://health.example/products/reishi-honey-500g");
});

test("keeps a grouped-query exact source private when no individual query matches the path", () => {
  const translatedProfile = { ...profile, products: [product("Arabic Reishi Product", "https://myjam.co.uk/products/reishi-honey")] };
  const payload = { output: [{ type: "web_search_call", action: {
    queries: ["reishi supplement", "honey kuwait"],
    sources: [{ title: "Reishi Honey 500g", url: "https://health.example/products/reishi-honey-500g" }],
  } }] };
  const candidates = candidatesFromSearchEvidence(payload, translatedProfile);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].observedAdmission, undefined);
  assert.equal(candidates[0].inferredProductLeads?.[0].admission, "source-first-cross-language");
  assert.equal(candidates[0].inferredProductLeads?.[0].laneQuery, "reishi supplement");
});

test("admits an attributed opaque product-detail URL only as a source-first investigation lead", () => {
  const arabicProfile = {
    ...profile,
    domain: "noororganicfood.com",
    title: "نور للأغذية العضوية",
    products: [product("عسل الريشي 500 غرام", "https://noororganicfood.com/product/reishi-honey-500g")],
  };
  const payload = { output: [{ type: "web_search_call", action: {
    query: "reishi honey 500g kuwait buy",
    sources: [{ title: "Wellness product", url: "https://health.example/products/sku-8472" }],
  } }] };
  const candidates = candidatesFromSearchEvidence(payload, arabicProfile);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].domain, "health.example");
  assert.equal(candidates[0].observedAdmission, undefined);
  assert.equal(candidates[0].inferredProductLeads?.[0].admission, "source-first-cross-language");
  assert.equal(candidates[0].inferredProductLeads?.[0].candidateSourceUrl, "https://health.example/products/sku-8472");
});

test("does not source-first admit citation-only opaque links or listing routes", () => {
  const arabicProfile = { ...profile, products: [product("عسل الريشي 500 غرام", "https://myjam.co.uk/products/reishi-honey")] };
  const payload = { output: [
    { type: "message", content: [{ type: "output_text", text: "", annotations: [{ type: "url_citation", title: "Wellness product", url: "https://health.example/products/sku-8472" }] }] },
    { type: "web_search_call", action: { query: "reishi honey 500g", sources: [{ title: "Wellness catalog", url: "https://health.example/collections/sku-8472" }] } },
  ] };
  assert.deepEqual(candidatesFromSearchEvidence(payload, arabicProfile), []);
});

test("bounds source-first investigations before domain deduplication", () => {
  const arabicProfile = { ...profile, products: [product("عسل الريشي 500 غرام", "https://myjam.co.uk/products/reishi-honey")] };
  const payload = { output: [{ type: "web_search_call", action: {
    query: "reishi honey 500g kuwait buy",
    sources: [1, 2, 3].map((index) => ({ title: `Opaque result ${index}`, url: `https://seller-${index}.example/products/sku-${index}` })),
  } }] };
  const candidates = candidatesFromSearchEvidence(payload, arabicProfile);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.inferredProductLeads?.[0].admission === "source-first-cross-language"));
});

test("rejects translated terminal listing words and pagination-shaped weak product leads without a finite dictionary", () => {
  const arabicProfile = { ...profile, products: [product("Ø¹Ø³Ù„ Ø§Ù„Ø±ÙŠØ´ÙŠ 500 ØºØ±Ø§Ù…", "https://myjam.co.uk/products/reishi-honey")] };
  for (const url of [
    "https://health.example/products/hledat",
    "https://health.example/products/honey?strona=2",
    "https://health.example/products/organic-sidr-honey-500g?offset=24",
    "https://health.example/products/organic-sidr-honey-500g?limit=24",
    "https://health.example/products/organic-sidr-honey-500g?cursor=next-page",
    "https://health.example/products/organic-sidr-honey-500g?start=24",
    "https://health.example/products/organic-sidr-honey-500g?from=24",
    "https://health.example/products/organic-sidr-honey-500g?skip=24",
    "https://health.example/products/organic-sidr-honey-500g?take=24",
    "https://health.example/products/organic-sidr-honey-500g?per_page=24",
    "https://health.example/products/organic-sidr-honey-500g?page_size=24",
    "https://health.example/products/organic-sidr-honey-500g?pagesize=24",
    "https://health.example/products/organic-sidr-honey-500g?startIndex=24",
    "https://health.example/products/organic-sidr-honey-500g?after=opaque-cursor",
  ]) {
    const payload = { output: [{ type: "web_search_call", action: { query: "reishi honey 500g", sources: [{ title: "Reishi Honey 500g", url }] } }] };
    assert.deepEqual(candidatesFromSearchEvidence(payload, arabicProfile), [], url);
  }
  const originalLanguage = { ...profile, products: [product("Organic Sidr Honey 500g", "https://myjam.co.uk/products/organic-sidr-honey-500g")] };
  for (const url of [
    "https://health.example/hledat/organic-sidr-honey-500g",
    "https://health.example/szukaj/organic-sidr-honey-500g",
    "https://health.example/hledat/products/organic-sidr-honey-500g",
    "https://health.example/szukaj/products/organic-sidr-honey-500g",
  ]) {
    const payload = { output: [{ type: "web_search_call", action: { query: "organic sidr honey 500g", sources: [{ title: "Organic Sidr Honey 500g", url }] } }] };
    assert.deepEqual(candidatesFromSearchEvidence(payload, originalLanguage), [], url);
  }
});

test("permits only recognized product-identity query keys on detail routes", () => {
  const single = { ...profile, products: [product("Organic Sidr Honey 500g", "https://myjam.co.uk/products/organic-sidr-honey-500g")] };
  for (const url of [
    "https://health.example/products/organic-sidr-honey-500g?variant=123",
    "https://health.example/products/organic-sidr-honey-500g?id=123",
    "https://health.example/products/organic-sidr-honey-500g?attribute_pa_size=500g",
  ]) {
    const payload = { output: [{ type: "web_search_call", action: { query: "organic sidr honey 500g", sources: [{ title: "Organic Sidr Honey 500g", url }] } }] };
    assert.equal(candidatesFromSearchEvidence(payload, single).length, 1, url);
  }
});

test("keeps translated query-path admission when the search title matches the original language", () => {
  const single = { ...profile, products: [product("Beef Sirloin Steak 500g", "https://myjam.co.uk/products/beef-sirloin-steak-500g")] };
  const payload = { output: [{ type: "web_search_call", action: {
    query: "rind lende 500g",
    sources: [{ title: "Beef Sirloin Steak 500g", url: "https://rival.example/produkte/rind-lende-500g" }],
  } }] };
  const candidates = candidatesFromSearchEvidence(payload, single);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].observedAdmission, undefined);
  assert.equal(candidates[0].inferredProductLeads?.[0].laneQuery, "rind lende 500g");
});

test("admits Arabic, Chinese, and Italian-singular product-detail containers", () => {
  for (const example of [
    { name: "عسل ريشي عضوي", query: "عسل ريشي عضوي", url: "https://rival.example/منتج/عسل-ريشي-عضوي", observed: true },
    { name: "有机 灵芝 蜂蜜", query: "有机 灵芝 蜂蜜", url: "https://rival.example/商品/有机-灵芝-蜂蜜", observed: true },
    { name: "Organic Reishi Honey", query: "miele reishi biologico", url: "https://rival.example/prodotto/miele-reishi-biologico", observed: false },
  ]) {
    const single = { ...profile, products: [product(example.name, `https://myjam.co.uk/products/${encodeURIComponent(example.name)}`)] };
    const payload = { output: [{ type: "web_search_call", action: { query: example.query, sources: [{ title: example.name, url: example.url }] } }] };
    const candidates = candidatesFromSearchEvidence(payload, single);
    assert.equal(candidates.length, 1, example.url);
    assert.equal(Boolean(candidates[0].observedAdmission), example.observed, example.url);
    assert.equal(Boolean(candidates[0].inferredProductLeads?.length), !example.observed, example.url);
  }
});

test("rejects a title-matching collection page on its own domain", () => {
  const payload = { output: [{ type: "web_search_call", action: { sources: [
    { title: "Halal Beef Sirloin Steak 500g", url: "https://collection.example/collections/halal-beef-sirloin-steak-500g" },
    { title: "Halal Beef Sirloin Steak 500g", url: "https://woocommerce.example/product-category/halal-beef-sirloin-steak-500g" },
    { title: "Halal Beef Sirloin Steak 500g", url: "https://german.example/kategorie/halal-beef-sirloin-steak-500g" },
    { title: "Halal Beef Sirloin Steak 500g", url: "https://french.example/categorie/halal-beef-sirloin-steak-500g" },
    { title: "Halal Beef Sirloin Steak 500g", url: "https://arabic.example/تصنيف/halal-beef-sirloin-steak-500g" },
  ] } }] };
  assert.deepEqual(candidatesFromSearchEvidence(payload, profile), []);
});

test("rejects private-address and credential-bearing search sources", () => {
  const single = { ...profile, products: [product("Organic Sidr Honey 500g", "https://myjam.co.uk/products/organic-sidr-honey-500g")] };
  for (const url of [
    "http://[::ffff:127.0.0.1]/products/organic-sidr-honey-500g",
    "https://secret:pass@rival.example/products/organic-sidr-honey-500g",
  ]) {
    const payload = { output: [{ type: "web_search_call", action: { query: "organic sidr honey 500g", sources: [{ title: "Organic Sidr Honey 500g", url }] } }] };
    assert.deepEqual(candidatesFromSearchEvidence(payload, single), [], url);
  }
});

test("model-summarized product candidates cannot bypass the listing-route gate", () => {
  const candidate = sanitizeCandidate({
    domain: "rival.example",
    websiteUrl: "https://rival.example/",
    evidenceUrl: "https://rival.example/products?search=organic+honey",
    matchedProductUrl: "https://rival.example/products?search=organic+honey",
    evidenceTitle: "Organic Honey",
  }, "myjam.co.uk", "product", { ...profile, products: [product("Organic Honey", "https://myjam.co.uk/products/organic-honey")] });
  assert.equal(candidate, null);
  for (const lane of ["entity", "category"]) {
    assert.equal(sanitizeCandidate({ domain: "rival.example", websiteUrl: "https://rival.example/", evidenceUrl: "https://rival.example/ar/search?q=organic+honey" }, "myjam.co.uk", lane, profile), null);
  }
});

test("entity and category search sources cannot publish listing routes", () => {
  const payload = { output: [{ type: "web_search_call", action: { sources: [{ title: "Organic Sidr Honey Grocery", url: "https://rival.example/ar/search?q=organic+honey" }] } }] };
  const business = { domain: "myjam.co.uk", categoryTerms: ["organic", "grocery"], category: "organic grocery", region: "United Kingdom" };
  assert.deepEqual(entityCandidatesFromSearchEvidence(payload, business, "entity"), []);
  assert.deepEqual(entityCandidatesFromSearchEvidence(payload, business, "category"), []);
});

test("unknown-language entity result paths are rebound to the first-party root", () => {
  const payload = { output: [{ type: "web_search_call", action: { sources: [
    { title: "Organic Sidr Honey Grocery", url: "https://rival.example/products/nabidka" },
    { title: "Organic Sidr Honey Grocery", url: "https://second.example/catalog?strona=2" },
  ] } }] };
  const business = { domain: "myjam.co.uk", categoryTerms: ["organic", "grocery"], category: "organic grocery", region: "United Kingdom" };
  const candidates = entityCandidatesFromSearchEvidence(payload, business, "entity");
  assert.deepEqual(candidates.map((candidate) => [candidate.sourceUrl, candidate.evidence[0].url]), [["https://rival.example/", "https://rival.example/"]]);
});

test("uses an inferred translated category only to recover a provisional company source", () => {
  const payload = { output: [{ type: "web_search_call", action: { query: "organic food stores Kuwait", sources: [
    { title: "Kuwait Organic Food Store", url: "https://rival.example/organic-food" },
  ] } }] };
  const business = { domain: "noororganicfood.com", categoryTerms: ["arabic", "category", "terms"], category: "Arabic category title", region: "Kuwait" };
  assert.deepEqual(entityCandidatesFromSearchEvidence(payload, business, "category"), []);
  const [candidate] = entityCandidatesFromSearchEvidence(payload, business, "category", "organic food stores");
  assert.equal(candidate.domain, "rival.example");
  assert.equal(candidate.sourceUrl, "https://rival.example/");
  assert.equal(candidate.marketCategory, "organic food stores");
  assert.equal(candidate.observedAdmission, true);
});

test("admits a root html product page but rejects title-only localized and id-only routes", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "beef sirloin steak halal 500g",
        sources: [
          { title: "Beef Sirloin Steak Halal 500g | Metzgerei", url: "https://metzgerei.example/produkt/rind-lende-500g" },
          { title: "Beef Sirloin Steak Halal 500g | Magento Shop", url: "https://magento.example/beef-sirloin-steak-500g.html" },
          { title: "Beef Sirloin Steak Halal 500g | Local Grocer", url: "https://local.example/goods/81492" },
        ],
      },
    }],
  };

  const candidates = candidatesFromSearchEvidence(payload, profile);
  assert.deepEqual(candidates.map((candidate) => candidate.domain), ["magento.example"]);
  assert.ok(candidates.every((candidate) => /crawlable product page/.test(candidate.reason)));
});

test("keeps publisher paths and weak titles outside the broader admission path", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        sources: [
          { title: "Beef Sirloin Steak Halal 500g review", url: "https://publisher.example/reviews/beef-steak" },
          { title: "Premium meat selection", url: "https://grocer.example/goods/81492" },
        ],
      },
    }],
  };

  assert.deepEqual(candidatesFromSearchEvidence(payload, profile), []);
});

test("uses an observed first-party locale alias to admit a cross-language product lead", () => {
  const localizedProduct = {
    ...product("تين مجفف طبيعي 500 جم", "https://noor.example/ar/products/natural-dried-figs-500g"),
    aliases: [{ name: "Natural Dried Figs 500g", normalizedName: "natural dried figs 500g", locale: "en", sourceUrl: "https://noor.example/en/products/natural-dried-figs-500g", extraction: "sitemap" }],
  };
  const localizedProfile = { ...profile, domain: "noor.example", title: "Noor", language: "ar", products: [localizedProduct] };
  const payload = { output: [{ type: "web_search_call", action: { sources: [{ title: "Natural Dried Figs 500g", url: "https://rival.example/products/natural-dried-figs-500g" }] } }] };

  const candidates = candidatesFromSearchEvidence(payload, localizedProfile);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].domain, "rival.example");
  assert.equal(candidates[0].matchedPrimaryProductName, localizedProduct.name);
});

test("accepts a pluralized product path for the same Wearform product family", () => {
  const wearformProfile = {
    domain: "wearform.com",
    title: "Wearform",
    description: "Custom work uniforms with logo",
    region: "United States",
    language: "en",
    products: [product("Men's S/S Blend Custom T-Shirt", "https://wearform.com/products/mens-blend-custom-t-shirt")],
  };
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "custom work t shirts with logo United States",
        sources: [
          { title: "Custom T-Shirts | CustomInk", url: "https://www.customink.com/products/psr-custom-t-shirts" },
          { title: "Custom T-Shirts | CustomInk", url: "https://www.customink.com/collections/products" },
        ],
      },
    }],
  };

  const candidates = candidatesFromSearchEvidence(payload, wearformProfile);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].domain, "customink.com");
  assert.equal(candidates[0].matchedPrimaryProductName, "Men's S/S Blend Custom T-Shirt");
  assert.equal(candidates[0].matchedProductUrl, "https://www.customink.com/products/psr-custom-t-shirts");
});

test("does not collapse an unrelated word ending in s into a product token", () => {
  const profile = {
    domain: "example.com",
    title: "Example",
    description: "Custom apparel",
    region: "United States",
    language: "en",
    products: [product("Canva Custom Design Shirt", "https://example.com/products/canva-custom-shirt")],
  };
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "custom apparel United States",
        sources: [{ title: "Canvas Custom Prints", url: "https://prints.example.net/products/canvas-custom" }],
      },
    }],
  };

  assert.deepEqual(candidatesFromSearchEvidence(payload, profile), []);
});

test("does not treat a word already ending in s as a singular token", () => {
  const profile = {
    domain: "example.com",
    title: "Example",
    description: "Custom wall art",
    region: "United States",
    language: "en",
    products: [product("Premium Custom Canvas Design", "https://example.com/products/custom-canvas")],
  };
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "custom wall art United States",
        sources: [{ title: "Custom Canvass Services", url: "https://services.example.net/products/custom-canvass" }],
      },
    }],
  };

  assert.deepEqual(candidatesFromSearchEvidence(payload, profile), []);
});

test("selects a bounded product-search set across distinct name families", () => {
  const products = [
    product("Lamb Leg Halal 2500g", "https://myjam.co.uk/products/lamb-leg"),
    product("Lamb Shoulder Halal 1500g", "https://myjam.co.uk/products/lamb-shoulder"),
    product("Beef Sirloin Steak Halal 500g", "https://myjam.co.uk/products/beef-sirloin"),
    product("Minced Beef Halal 500g", "https://myjam.co.uk/products/minced-beef"),
    product("Chicken Shawarma Halal 500g", "https://myjam.co.uk/products/chicken-shawarma"),
  ];
  assert.deepEqual(productSearchAnchors(products, 4).map((item) => item.name), [
    "Lamb Leg Halal 2500g",
    "Minced Beef Halal 500g",
    "Chicken Shawarma Halal 500g",
    "Lamb Shoulder Halal 1500g",
  ]);
});

test("prefers concise recurring sweets families before niche variants", () => {
  const products = [
    product("Ballourie Orange Pistachio Baklava", "https://sweets.example/products/ballourie-orange-pistachio-baklava"),
    product("Pistachio Baklava", "https://sweets.example/products/pistachio-baklava"),
    product("Walnut Baklava", "https://sweets.example/products/walnut-baklava"),
    product("Bird Nest Baklava with Pistachio", "https://sweets.example/products/bird-nest-baklava-pistachio"),
    product("Maamoul Pistachio", "https://sweets.example/products/maamoul-pistachio"),
    product("Maamoul Walnut", "https://sweets.example/products/maamoul-walnut"),
  ];
  const names = productSearchAnchors(products, 4, "Sweets Example").map((item) => item.name);
  assert.ok(names.includes("Pistachio Baklava"));
  assert.ok(names.includes("Maamoul Pistachio"));
  assert.equal(names.includes("Ballourie Orange Pistachio Baklava"), false);
});

test("removes repeated brand words before family grouping", () => {
  const products = [
    product("Al Hamdani Pistachio Baklava", "https://sweets.example/products/pistachio-baklava"),
    product("Al Hamdani Walnut Baklava", "https://sweets.example/products/walnut-baklava"),
    product("Al Hamdani Maamoul Pistachio", "https://sweets.example/products/maamoul-pistachio"),
    product("Al Hamdani Maamoul Walnut", "https://sweets.example/products/maamoul-walnut"),
  ];
  assert.deepEqual(productSearchAnchors(products, 3, "Al Hamdani").map((item) => item.name), [
    "Al Hamdani Pistachio Baklava",
    "Al Hamdani Walnut Baklava",
    "Al Hamdani Maamoul Pistachio",
  ]);
});

test("keeps deterministic source order when a small catalog has no recurring family terms", () => {
  const products = [
    product("Apricot Preserve", "https://grocer.example/products/apricot-preserve"),
    product("Sesame Crackers", "https://grocer.example/products/sesame-crackers"),
    product("Mint Tea", "https://grocer.example/products/mint-tea"),
  ];
  assert.deepEqual(productSearchAnchors(products, 3).map((item) => item.name), products.map((item) => item.name));
});

test("runs company lanes even when a product-backed ecommerce candidate exists", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  const searchProfile = { ...profile, products: [
    product("Pistachio Baklava", "https://myjam.co.uk/products/pistachio-baklava"),
    product("Walnut Baklava", "https://myjam.co.uk/products/walnut-baklava"),
  ] };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input[1].content);
    if (input.lane === "product") return Response.json({ output: [
      { type: "web_search_call", action: { query: "Pistachio Baklava UK product", sources: [{ title: "Pistachio Baklava | Rival", url: "https://rival.example/products/pistachio-baklava" }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Baklava", region: "United Kingdom", queries: ["Pistachio Baklava UK product"], candidates: [] }) }] },
    ] });
    const candidate = { domain: "company.example", companyName: "Company Rival", reason: "Same bakery market", searchQuery: "baklava competitors UK", websiteUrl: "https://company.example/", evidenceUrl: "https://company.example/baklava", evidenceTitle: "Baklava shop and delivery", marketCategory: "Baklava", relationship: "direct", sharedOfferings: ["baklava"], matchedPrimaryProductName: "", matchedProductUrl: "" };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Baklava", region: "United Kingdom", queries: ["baklava competitors UK"], candidates: [candidate] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(searchProfile);
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["rival.example", "company.example"]);
    assert.equal(result.strategy, "product-first");
    assert.equal(result.candidates[0].evidenceMethod, "search-source");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("runs one bounded search request per selected ecommerce product", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  const searchedProducts = [];
  const searchProfile = {
    ...profile,
    products: [
      product("Lamb Leg Halal 2500g", "https://myjam.co.uk/products/lamb-leg"),
      product("Lamb Shoulder Halal 1500g", "https://myjam.co.uk/products/lamb-shoulder"),
      product("Beef Sirloin Steak Halal 500g", "https://myjam.co.uk/products/beef-sirloin"),
      product("Minced Beef Halal 500g", "https://myjam.co.uk/products/minced-beef"),
      product("Chicken Shawarma Halal 500g", "https://myjam.co.uk/products/chicken-shawarma"),
    ],
  };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input[1].content);
    if (input.lane === "product") {
      assert.equal(input.profile.offerings.length, 1);
      assert.match(input.task, /target-market-language and English bridge translations/i);
      searchedProducts.push(input.profile.offerings[0].name);
    }
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: [], candidates: [] }) }] }] });
  };
  try {
    await discoverCompetitors(searchProfile);
    assert.deepEqual(searchedProducts, productSearchAnchors(searchProfile.products).map((item) => item.name));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("excludes marketplaces and stockists carrying the primary brand", () => {
  const payload = {
    output: [{
      type: "web_search_call",
      action: {
        query: "UK buy beef sirloin steak halal 500g",
        sources: [
          { title: "Beef Sirloin Steak Halal 500g", url: "https://amazon.co.uk/products/beef-sirloin-steak-halal-500g" },
          { title: "MyJam Beef Sirloin Steak Halal 500g", url: "https://stockist.example/products/myjam-beef-sirloin-steak-halal-500g" },
          { title: "Beef Sirloin Steak Halal 500g | Oasis Market", url: "https://oasismarket.co.uk/product/beef-sirloin-steak-halal-500g" },
        ],
      },
    }],
  };
  assert.deepEqual(candidatesFromSearchEvidence(payload, profile).map((candidate) => candidate.domain), ["oasismarket.co.uk"]);
});

test("rejects two-token overlap when it covers too little of the anchor product", () => {
  const longProfile = { ...profile, products: [product("Organic Crunchy Peanut Butter", "https://myjam.co.uk/products/organic-crunchy-peanut-butter")] };
  const payload = { output: [{ type: "web_search_call", action: { sources: [{ title: "Peanut Butter", url: "https://rival.example/products/peanut-butter" }] } }] };
  assert.deepEqual(candidatesFromSearchEvidence(payload, longProfile), []);
});

test("rejects search, browse, and catalog listing routes as inferred exact-product leads", () => {
  const single = { ...profile, products: [product("Organic Sidr Honey 500g", "https://myjam.co.uk/products/organic-sidr-honey-500g")] };
  for (const url of [
    "https://rival.example/search/results.html",
    "https://rival.example/search-results.html",
    "https://rival.example/product-list.html",
    "https://rival.example/browse/organic-sidr-honey-500g.html",
    "https://rival.example/catalog/organic-sidr-honey-500g.html",
    "https://rival.example/fr/recherche.html",
    "https://rival.example/de/suche.html",
    "https://rival.example/ar/بحث.html",
    "https://rival.example/products/all",
    "https://rival.example/products/index",
    "https://rival.example/products/filter",
    "https://rival.example/products/page/2",
    "https://rival.example/products/kategori/organic-sidr-honey-500g",
    "https://rival.example/products/pagina/2",
    "https://rival.example/products/seite/2",
    "https://rival.example/products/katalog/organic-sidr-honey-500g",
    "https://rival.example/pt/pesquisa.html",
    "https://rival.example/es/resultados-busqueda.html",
    "https://rival.example/searchResults.html",
    "https://rival.example/fr/resultats-recherche.html",
    "https://rival.example/de/suchergebnisse.html",
    "https://rival.example/it/risultati-ricerca.html",
    "https://rival.example/nl/zoekresultaten.html",
    "https://rival.example/products/página/2/organic-sidr-honey-500g",
    "https://rival.example/products/catalogo/organic-sidr-honey-500g",
    "https://rival.example/products/resultados-de-busqueda/organic-sidr-honey-500g",
    "https://rival.example/products/pesquisar/organic-sidr-honey-500g",
    "https://rival.example/products/honey?pagina=2",
    "https://rival.example/products/arama/organic-sidr-honey-500g",
    "https://rival.example/products/wyniki-wyszukiwania/organic-sidr-honey-500g",
    "https://rival.example/products/honey?sayfa=2",
    "https://rival.example/produits/liste",
    "https://rival.example/produits/tous",
    "https://rival.example/prodotti/tutti",
    "https://rival.example/منتجات/الكل",
    "https://rival.example/products/honey?q=honey",
  ]) {
    const payload = { output: [{ type: "web_search_call", action: { query: "organic sidr honey 500g", sources: [{ title: "Organic Sidr Honey 500g", url }] } }] };
    assert.deepEqual(candidatesFromSearchEvidence(payload, single), [], url);
  }
});

test("observed company evidence replaces provisional inferred publication fields without dropping the private lead", () => {
  const inferred = {
    domain: "rival.example", companyName: "rival.example", reason: "inferred lead", searchQuery: "translated honey", sourceUrl: "https://rival.example/products/honey", websiteUrl: "https://rival.example/", marketCategory: "", relationship: "adjacent", sharedOfferings: ["Arabic honey"], evidence: [{ url: "https://rival.example/products/honey", title: "Honey", method: "product-search" }], mentionCount: 1, matchedPrimaryProductName: "Arabic honey", matchedProductUrl: "https://rival.example/products/honey", matchedPrimaryProductNames: ["Arabic honey"], matchedProductUrls: ["https://rival.example/products/honey"], inferredProductLeads: [{ primaryProductId: "p1", primarySourceUrl: "https://shop.test/products/honey", laneQuery: "translated honey", candidateDomain: "rival.example", candidateSourceUrl: "https://rival.example/products/honey", admission: "inferred-cross-language" }], evidenceMethod: "search-source",
  };
  const observed = {
    domain: "rival.example", companyName: "Rival Foods", reason: "observed category company", searchQuery: "organic food competitors", sourceUrl: "https://rival.example/about", websiteUrl: "https://rival.example/", marketCategory: "organic food", relationship: "direct", sharedOfferings: ["organic food"], evidence: [{ url: "https://rival.example/about", title: "Rival Foods", method: "category-search" }], mentionCount: 1, evidenceMethod: "search-source", observedAdmission: true,
  };
  const [merged] = mergeCandidates([inferred, observed]);
  assert.equal(merged.sourceUrl, observed.sourceUrl);
  assert.equal(merged.searchQuery, observed.searchQuery);
  assert.deepEqual(merged.evidence, observed.evidence);
  assert.equal(merged.matchedProductUrl, undefined);
  assert.deepEqual(merged.inferredProductLeads, inferred.inferredProductLeads);
});

test("ranks product-backed sellers ahead of company-first results", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  const searchProfile = {
    ...profile,
    products: [
      product("Lamb Leg Halal 2500g", "https://myjam.co.uk/products/lamb-leg"),
      product("Beef Sirloin Steak Halal 500g", "https://myjam.co.uk/products/beef-sirloin"),
      product("Minced Beef Halal 500g", "https://myjam.co.uk/products/minced-beef"),
      product("Chicken Shawarma Halal 500g", "https://myjam.co.uk/products/chicken-shawarma"),
    ],
  };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input[1].content);
    if (input.lane === "product") {
      const name = input.profile.offerings[0].name;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return Response.json({ output: [
        { type: "web_search_call", action: { query: `UK buy ${name}`, sources: [{ title: `${name} | Seller`, url: `https://seller-${slug}.example/products/${slug}` }] } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: [`UK buy ${name}`], candidates: [] }) }] },
      ] });
    }
    const candidate = { domain: "company-only.example", companyName: "Company only", reason: "Same grocery market", searchQuery: "halal grocery competitors UK", websiteUrl: "https://company-only.example/", evidenceUrl: "https://company-only.example/", evidenceTitle: "Halal grocery company", marketCategory: "Halal grocery", relationship: "direct", sharedOfferings: ["halal grocery"], matchedPrimaryProductName: "", matchedProductUrl: "" };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: ["halal grocery competitors UK"], candidates: [candidate] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(searchProfile);
    assert.equal(result.strategy, "product-first");
    assert.equal(result.candidates.length, 5);
    assert.equal(result.candidates.slice(0, 4).every((candidate) => candidate.evidenceMethod === "search-source" && candidate.matchedProductUrl), true);
    assert.equal(result.candidates[4].domain, "company-only.example");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("retains company discovery when product searches return no attributable sellers", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  const calls = [];
  const searchProfile = { ...profile, products: [
    product("Pistachio Baklava", "https://myjam.co.uk/products/pistachio-baklava"),
    product("Walnut Baklava", "https://myjam.co.uk/products/walnut-baklava"),
  ] };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input[1].content);
    calls.push(input.lane);
    if (input.lane === "product") return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Baklava", region: "United Kingdom", queries: ["Pistachio Baklava UK"], candidates: [] }) }] }] });
    const candidate = { domain: "fallback.example", companyName: "Fallback", reason: "Same grocery market", searchQuery: "baklava competitors UK", websiteUrl: "https://fallback.example/", evidenceUrl: "https://fallback.example/", evidenceTitle: "Fallback baklava shop", marketCategory: "Baklava", relationship: "direct", sharedOfferings: ["baklava"], matchedPrimaryProductName: "", matchedProductUrl: "" };
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Baklava", region: "United Kingdom", queries: ["baklava competitors UK"], candidates: [candidate] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(searchProfile);
    assert.equal(result.strategy, "company-fallback");
    const firstCompanyCall = calls.findIndex((lane) => lane !== "product");
    assert.ok(firstCompanyCall > 0);
    assert.equal(calls.slice(0, firstCompanyCall).every((lane) => lane === "product"), true);
    assert.deepEqual(new Set(calls.slice(firstCompanyCall)), new Set(["entity", "category"]));
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["fallback.example"]);
    assert.match(result.gaps.join(" "), /product searches completed with no attributable seller/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("groups several matched products under one seller and ranks broader overlap first", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  const searchProfile = { ...profile, products: [
    product("Pistachio Baklava", "https://myjam.co.uk/products/pistachio-baklava"),
    product("Walnut Baklava", "https://myjam.co.uk/products/walnut-baklava"),
  ] };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.input[1].content);
    const name = input.profile.offerings[0].name;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const sources = [{ title: `${name} | Broad Seller`, url: `https://broad.example/products/${slug}` }];
    if (name.includes("Pistachio")) sources.push({ title: `${name} | Narrow Seller`, url: `https://narrow.example/products/${slug}` });
    return Response.json({ output: [
      { type: "web_search_call", action: { query: `UK buy ${name}`, sources } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Baklava", region: "United Kingdom", queries: [`UK buy ${name}`], candidates: [] }) }] },
    ] });
  };
  try {
    const result = await discoverCompetitors(searchProfile);
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["broad.example", "narrow.example"]);
    assert.deepEqual(result.candidates[0].matchedPrimaryProductNames, ["Pistachio Baklava", "Walnut Baklava"]);
    assert.equal(result.candidates[0].matchedProductUrls.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});
