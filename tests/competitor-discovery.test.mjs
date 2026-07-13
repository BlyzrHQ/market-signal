import assert from "node:assert/strict";
import test from "node:test";

import { discoverCompetitors } from "../app/lib/competitor-discovery.ts";

const profile = { domain: "myjam.co.uk", title: "MyJam", description: "International groceries delivered in the UK", region: "United Kingdom (inferred)", language: "en", products: [] };

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

test("sanitizes, deduplicates, and excludes the primary domain from searched candidates", async () => {
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
      { domain: "rival.example", companyName: "Duplicate", reason: "Duplicate", searchQuery: "same", sourceUrl: "https://rival.example/" },
      { domain: "myjam.co.uk", companyName: "Primary", reason: "Self", searchQuery: "same", sourceUrl: "https://myjam.co.uk/" },
      { domain: "bad.example", companyName: "Bad source", reason: "No evidence", searchQuery: "same", sourceUrl: "javascript:alert(1)" },
    ] }) }] }] });
  };
  try {
    const result = await discoverCompetitors(profile);
    assert.equal(result.available, true);
    assert.equal(result.model, "test-search-model");
    assert.deepEqual(result.candidates.map((candidate) => candidate.domain), ["rival.example"]);
    assert.equal(result.candidates[0].matchedPrimaryProductName, "Halal Lamb Chops 500g");
    assert.match(result.candidates[0].matchedProductUrl, /products\/halal-lamb-chops/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
    if (previousModel) process.env.MARKET_SIGNAL_DISCOVERY_MODEL = previousModel; else delete process.env.MARKET_SIGNAL_DISCOVERY_MODEL;
  }
});

