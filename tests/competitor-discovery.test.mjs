import assert from "node:assert/strict";
import test from "node:test";

import { candidatesFromSearchEvidence, discoverCompetitors } from "../app/lib/competitor-discovery.ts";

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
      { domain: "https://rival.example/shop", companyName: "Rival", reason: "Sells Halal Lamb Chops 500g", searchQuery: "Halal Lamb Chops 500g UK", sourceUrl: "https://rival.example/products/halal-lamb-chops", matchedPrimaryProductName: "Halal Lamb Chops 500g", matchedProductUrl: "https://rival.example/products/halal-lamb-chops" },
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

test("retains successful entity candidates when other discovery lanes fail", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call !== 1) return new Response("<!DOCTYPE html><title>Gateway error</title>", { status: 200, headers: { "content-type": "text/html" } });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ category: "Halal grocery", region: "United Kingdom", queries: ["MyJam alternatives UK"], candidates: [{ domain: "rival.example", companyName: "Rival", reason: "Same grocery market", searchQuery: "MyJam alternatives UK", websiteUrl: "https://rival.example/", evidenceUrl: "https://rival.example/", evidenceTitle: "Rival halal grocery", marketCategory: "Halal grocery", relationship: "direct", sharedOfferings: ["halal grocery"], matchedPrimaryProductName: "", matchedProductUrl: "" }] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.available, true);
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["rival.example"]);
    assert.equal(result.gaps.length, 2);
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
