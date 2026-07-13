import assert from "node:assert/strict";
import test from "node:test";

import { buildOfficialAdSearches, scanOfficialAdLibraries } from "../app/lib/ad-intelligence.ts";

test("builds direct official-library searches for the inferred region", () => {
  const searches = buildOfficialAdSearches("MyJam Food", "United Kingdom (inferred)");
  assert.equal(searches.regionCode, "GB");
  assert.match(searches.Meta, /^https:\/\/www\.facebook\.com\/ads\/library\//);
  assert.match(searches.Google, /^https:\/\/adstransparency\.google\.com\//);
  assert.match(searches.TikTok, /^https:\/\/library\.tiktok\.com\/ads/);
  assert.ok(Object.values(searches).every((value) => typeof value === "string"));
});

test("never reports zero ads when automatic official-library access is unavailable", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival" }], "United Kingdom");
    assert.equal(result.available, false);
    assert.equal(result.companies[0].platforms.every((platform) => platform.status === "no-verified-result"), true);
    assert.match(result.companies[0].summary, /independently verified/i);
    assert.match(result.limitation, /exact spend/i);
  } finally {
    if (previous) process.env.OPENAI_API_KEY = previous;
  }
});

test("accepts verified ads only when evidence URLs are from the matching official platform", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.tool_choice, "required");
    assert.deepEqual(request.tools[0].filters.allowed_domains, ["facebook.com", "adstransparency.google.com", "library.tiktok.com"]);
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ companies: [{ domain: "rival.example", summary: "Active Meta offer", recommendedAction: "Counter the offer", platforms: [
      { platform: "Meta", status: "verified-active", activeCreativeCount: 3, message: "Three active ads", themes: ["Free delivery"], evidenceUrls: ["https://www.facebook.com/ads/library/?id=123"] },
      { platform: "Google", status: "verified-active", activeCreativeCount: 9, message: "Untrusted", themes: ["Fake"], evidenceUrls: ["https://example.com/fake"] },
      { platform: "TikTok", status: "access-limited", activeCreativeCount: 0, message: "Region unavailable", themes: [], evidenceUrls: [] },
    ] }] }) }] }] });
  };
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival" }], "United Kingdom");
    assert.equal(result.companies[0].platforms[0].status, "verified-active");
    assert.equal(result.companies[0].platforms[0].activeCreativeCount, 1);
    assert.equal(result.companies[0].platforms[1].status, "no-verified-result");
    assert.equal(result.companies[0].platforms[1].activeCreativeCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});

test("rejects brand pages and generic library searches as direct ad evidence", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  globalThis.fetch = async () => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ companies: [{ domain: "rival.example", summary: "Claimed active", recommendedAction: "Review", platforms: [
    { platform: "Meta", status: "verified-active", activeCreativeCount: 4, message: "Brand page only", themes: ["Offer"], evidenceUrls: ["https://www.facebook.com/RivalBrand"] },
    { platform: "Google", status: "verified-active", activeCreativeCount: 4, message: "Search only", themes: ["Offer"], evidenceUrls: ["https://adstransparency.google.com/?query=Rival"] },
    { platform: "TikTok", status: "verified-active", activeCreativeCount: 4, message: "Search only", themes: ["Offer"], evidenceUrls: ["https://library.tiktok.com/ads?adv_name=Rival"] },
  ] }] }) }] }] });
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival" }], "United Kingdom");
    assert.deepEqual(result.companies[0].platforms.map((platform) => platform.status), ["no-verified-result", "no-verified-result", "no-verified-result"]);
    assert.equal(result.companies[0].summary, "No active creative was independently verified in the automatic official-library search.");
    assert.doesNotMatch(result.companies[0].summary, /claimed active/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
  }
});
