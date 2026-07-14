import assert from "node:assert/strict";
import test from "node:test";

import { attributableFacebookUrl, buildOfficialAdSearches, queryMetaAdLibrary, queryMetapiAdvertiser, resolveFacebookPageIdentity, safeAdDestination, safeMetaMediaUrl, scanOfficialAdLibraries } from "../app/lib/ad-intelligence.ts";

test("accepts only attributable Facebook company-profile links", () => {
  assert.equal(attributableFacebookUrl(["https://www.facebook.com/sharer/sharer.php?u=x", "https://m.facebook.com/MyJamFood/?ref=footer"]), "https://www.facebook.com/MyJamFood");
  assert.equal(attributableFacebookUrl(["https://example.com/facebook.com/brand", "https://facebook.com/groups/123"]), "");
});

test("preserves a numeric Page ID explicitly linked by the company website", async () => {
  const identity = await resolveFacebookPageIdentity("https://facebook.com/1148679501654585", async () => new Response('<meta property="al:android:url" content="fb://profile/999999999"><meta property="og:title" content="Exact Brand">'));
  assert.equal(identity.pageId, "1148679501654585");
  assert.equal(identity.pageName, "");
});

test("queries Metapi by exact company Page ID and groups duplicate placements into useful concepts", async () => {
  const requests = [];
  const result = await queryMetapiAdvertiser({ domain: "rival.example", brand: "Rival Foods", facebookUrl: "https://facebook.com/RivalFoods" }, "United Kingdom", "temporary-secret", async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url) === "https://www.facebook.com/RivalFoods") return new Response('<meta property="al:android:url" content="fb://profile/123456789"><meta property="og:title" content="Rival Foods">');
    if (String(url).endsWith("/tasks")) {
      assert.equal(String(init.headers?.Authorization || ""), "Bearer temporary-secret");
      const body = JSON.parse(init.body);
      assert.equal(body.advertiser_id, "123456789");
      assert.equal(body.country, "GB");
      assert.equal(body.active_status, "active");
      assert.equal("q" in body, false);
      return Response.json({ task_id: "task-1" });
    }
    if (String(url).endsWith("/tasks/task-1/status")) return Response.json({ status: "succeeded" });
    return Response.json({ data: [
      { provider_id: 7001, provider_page_id: "123456789", provider_page_name: "Rival Foods", bodies: ["Fresh bread delivered today"], captions: ["Order bakery"], creative_link_titles: ["Bread in 30 minutes"], creative_link_descriptions: ["Freshly baked"], cta_text: "Shop now", original_image_url: "https://scontent-lhr8-1.xx.fbcdn.net/ad.jpg", link_url: "https://rival.example/bread", data_sources: ["facebook"], languages: ["en"], countries: ["GB"], delivery_start_time: "2026-07-01", delivery_stop_time: "2026-07-05" },
      { provider_id: 7002, provider_page_id: "123456789", provider_page_name: "Rival Foods", bodies: ["Fresh bread delivered today"], captions: ["Order bakery"], creative_link_titles: ["Bread in 30 minutes"], creative_link_descriptions: ["Freshly baked"], cta_text: "Shop now", original_image_url: "https://scontent-lhr8-1.xx.fbcdn.net/ad-2.jpg", link_url: "https://rival.example/bread", data_sources: ["instagram"], languages: ["ar"], countries: ["GB"], delivery_start_time: "2026-06-28", delivery_stop_time: "2026-07-08" },
      { provider_id: 9999, provider_page_id: "999999999", provider_page_name: "Wrong Advertiser", bodies: ["Must be rejected"] },
    ] });
  }, async () => {});
  assert.equal(result.status, "verified-active");
  assert.equal(result.activeCreativeCount, 2);
  assert.equal(result.creativeConceptCount, 1);
  assert.equal(result.creativeConcepts[0].placementCount, 2);
  assert.equal(result.creativeConcepts[0].pageId, "123456789");
  assert.equal(result.creativeConcepts[0].headline, "Bread in 30 minutes");
  assert.equal(result.creativeConcepts[0].description, "Freshly baked");
  assert.equal(result.creativeConcepts[0].destinationUrl, "https://rival.example/bread");
  assert.equal(result.creativeConcepts[0].mediaUrl, "https://scontent-lhr8-1.xx.fbcdn.net/ad.jpg");
  assert.equal(result.creativeConcepts[0].startDate, "2026-06-28");
  assert.equal(result.creativeConcepts[0].stopDate, "2026-07-08");
  assert.deepEqual(result.creativeConcepts[0].platforms, ["facebook", "instagram"]);
  assert.deepEqual(result.creativeConcepts[0].languages, ["en", "ar"]);
  assert.equal(result.discardedRecordCount, 1);
  assert.deepEqual(result.evidenceUrls, ["https://www.facebook.com/ads/library/?id=7001", "https://www.facebook.com/ads/library/?id=7002"]);
  assert.equal(JSON.stringify(requests).includes("temporary-secret"), true);
  assert.equal(JSON.stringify(result).includes("temporary-secret"), false);
  assert.equal(JSON.stringify(result).includes("9999"), false);
});

test("does not turn cross-advertiser Metapi records into competitor activity", async () => {
  const result = await queryMetapiAdvertiser({ domain: "rival.example", brand: "Rival", facebookUrl: "https://facebook.com/Rival" }, "United Kingdom", "secret", async (url) => {
    if (String(url) === "https://www.facebook.com/Rival") return new Response('<meta property="al:android:url" content="fb://profile/123456789">');
    if (String(url).endsWith("/tasks")) return Response.json({ task_id: "task-2" });
    if (String(url).endsWith("/status")) return Response.json({ status: "succeeded" });
    return Response.json({ data: [{ provider_id: 8001, provider_page_id: "444444444", bodies: ["Unrelated ad"] }] });
  }, async () => {});
  assert.equal(result.status, "access-limited");
  assert.equal(result.activeCreativeCount, 0);
  assert.equal(result.creativeConceptCount, undefined);
  assert.equal(result.discardedRecordCount, 1);
  assert.match(result.message, /all were discarded as unsafe attribution/i);
});

test("uses a bounded identity probe before an exact advertiser task when the linked Page hides its ID", async () => {
  const taskBodies = [];
  const result = await queryMetapiAdvertiser({ domain: "rival.example", brand: "Rival Foods", facebookUrl: "https://facebook.com/RivalFoods" }, "United Kingdom", "secret", async (url, init = {}) => {
    const href = String(url);
    if (href === "https://www.facebook.com/RivalFoods") return new Response("<html><title>Rival Foods</title></html>");
    if (href.endsWith("/tasks")) {
      const body = JSON.parse(init.body);
      taskBodies.push(body);
      return Response.json({ task_id: body.q ? "identity-probe" : "exact-page" });
    }
    if (href.endsWith("/identity-probe/status") || href.endsWith("/exact-page/status")) return Response.json({ status: "succeeded" });
    if (href.includes("/identity-probe/results")) return Response.json({ data: [
      { provider_id: 9100, provider_page_id: "123456789", provider_page_name: "Rival Foods", link_url: "https://rival.example/offer", bodies: ["Company-domain proof"] },
      { provider_id: 9101, provider_page_id: "777777777", provider_page_name: "Rival Fan Club", link_url: "https://fan.example/offer", bodies: ["Unrelated"] },
    ] });
    if (href.includes("/exact-page/results")) return Response.json({ data: [
      { provider_id: 9200, provider_page_id: "123456789", provider_page_name: "Rival Foods", bodies: ["Fresh bread today"], link_url: "https://rival.example/bread" },
    ] });
    throw new Error(`Unexpected request: ${href}`);
  }, async () => {});
  assert.equal(taskBodies.length, 2);
  assert.equal(taskBodies[0].q, "Rival Foods");
  assert.equal(taskBodies[0].count, 20);
  assert.equal(taskBodies[1].advertiser_id, "123456789");
  assert.equal(taskBodies[1].count, 100);
  assert.equal(result.status, "verified-active");
  assert.equal(result.exactPageId, "123456789");
  assert.equal(result.identityProbeRecordCount, 2);
  assert.equal(result.activeCreativeCount, 1);
});

test("rejects an ambiguous identity probe instead of mixing advertiser Pages", async () => {
  const result = await queryMetapiAdvertiser({ domain: "rival.example", brand: "Rival Foods", facebookUrl: "https://facebook.com/RivalFoods" }, "United Kingdom", "secret", async (url, init = {}) => {
    const href = String(url);
    if (href === "https://www.facebook.com/RivalFoods") return new Response("<html></html>");
    if (href.endsWith("/tasks")) return Response.json({ task_id: JSON.parse(init.body).q ? "probe" : "unexpected-exact" });
    if (href.endsWith("/probe/status")) return Response.json({ status: "succeeded" });
    if (href.includes("/probe/results")) return Response.json({ data: [
      { provider_id: 1, provider_page_id: "111111111", provider_page_name: "Rival Foods", link_url: "https://rival.example/a" },
      { provider_id: 2, provider_page_id: "222222222", provider_page_name: "Rival Foods UK", link_url: "https://rival.example/b" },
    ] });
    throw new Error(`An exact task must not run after ambiguity: ${href}`);
  }, async () => {});
  assert.equal(result.status, "access-limited");
  assert.equal(result.identityProbeRecordCount, 2);
  assert.match(result.message, /ambiguous/i);
});

test("permits only public destinations and Meta-owned creative media", () => {
  assert.equal(safeAdDestination("https://rival.example/offer"), "https://rival.example/offer");
  assert.equal(safeAdDestination("https://l.facebook.com/l.php?u=https%3A%2F%2Frival.example%2Foffer"), "https://rival.example/offer");
  assert.equal(safeAdDestination("http://127.0.0.1/admin"), "");
  assert.equal(safeAdDestination("https://user:password@rival.example/offer"), "");
  assert.equal(safeMetaMediaUrl("https://scontent-lhr8-1.xx.fbcdn.net/ad.jpg"), "https://scontent-lhr8-1.xx.fbcdn.net/ad.jpg");
  assert.equal(safeMetaMediaUrl("https://cdn.example/ad.jpg"), "");
  assert.equal(safeMetaMediaUrl("http://scontent-lhr8-1.xx.fbcdn.net/ad.jpg"), "");
});

test("runs the exact-Page provider concurrently with the official-library search", { timeout: 2_000 }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousMetapi = process.env.METAPI_API_KEY;
  const previousMeta = process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "openai-test";
  process.env.METAPI_API_KEY = "metapi-test";
  delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  let releaseProfile;
  const profileResponse = new Promise((resolve) => { releaseProfile = resolve; });
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href === "https://www.facebook.com/Rival") return profileResponse;
    if (href.endsWith("/responses")) {
      releaseProfile(new Response('<meta property="al:android:url" content="fb://profile/123456789">'));
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ companies: [] }) }] }] });
    }
    if (href.endsWith("/tasks")) return Response.json({ task_id: "parallel-task" });
    if (href.endsWith("/status")) return Response.json({ status: "succeeded" });
    if (href.includes("/results")) return Response.json({ data: [] });
    throw new Error(`Unexpected request: ${href}`);
  };
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival", facebookUrl: "https://facebook.com/Rival" }], "United Kingdom");
    assert.equal(result.provider, "metapi-exact-page-and-official-search");
    assert.equal(result.companies[0].platforms[0].status, "no-verified-result");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
    if (previousMetapi) process.env.METAPI_API_KEY = previousMetapi; else delete process.env.METAPI_API_KEY;
    if (previousMeta) process.env.META_AD_LIBRARY_ACCESS_TOKEN = previousMeta; else delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  }
});

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
  const previousMeta = process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival" }], "United Kingdom");
    assert.equal(result.available, false);
    assert.equal(result.companies[0].platforms.every((platform) => platform.status === "access-limited"), true);
    assert.match(result.companies[0].summary, /coverage is limited/i);
    assert.match(result.limitation, /exact spend/i);
  } finally {
    if (previous) process.env.OPENAI_API_KEY = previous;
    if (previousMeta) process.env.META_AD_LIBRARY_ACCESS_TOKEN = previousMeta;
  }
});

test("uses the Meta token only in the authorization header and returns safe direct records", async () => {
  const result = await queryMetaAdLibrary({ domain: "rival.example", brand: "Rival Foods", facebookUrl: "https://facebook.com/123456789" }, "Germany", "server-secret", async (url, init) => {
    assert.doesNotMatch(String(url), /server-secret|access_token/i);
    assert.match(String(url), /search_page_ids=%5B%22123456789%22%5D/);
    assert.doesNotMatch(String(url), /search_terms=/);
    assert.equal(init.headers.Authorization, "Bearer server-secret");
    assert.equal(init.signal instanceof AbortSignal, true);
    return Response.json({
      data: [
        { id: "123", page_id: "123456789", page_name: "Rival Foods", ad_creative_bodies: ["Free delivery this weekend"] },
        { id: "456", page_id: "123456789", page_name: "Rival Foods", ad_creative_bodies: ["New grocery range"] },
      ],
      paging: { next: "https://graph.facebook.com/next?access_token=must-not-leak" },
    });
  });
  assert.equal(result.status, "verified-active");
  assert.equal(result.activeCreativeCount, 2);
  assert.equal(result.exactPageId, "123456789");
  assert.equal(result.creativeConceptCount, 2);
  assert.equal(result.activeCreativeCountIsLowerBound, true);
  assert.deepEqual(result.evidenceUrls, ["https://www.facebook.com/ads/library/?id=123", "https://www.facebook.com/ads/library/?id=456"]);
  assert.equal(JSON.stringify(result).includes("server-secret"), false);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("surfaces Meta app authorization failures instead of reporting no ads", async () => {
  const result = await queryMetaAdLibrary({ domain: "rival.example", brand: "Rival", facebookUrl: "https://facebook.com/123456789" }, "Germany", "server-secret", async () => Response.json({ error: { code: 10, error_subcode: 2332002 } }));
  assert.equal(result.status, "access-limited");
  assert.equal(result.activeCreativeCount, 0);
  assert.match(result.message, /10\/2332002/);
  assert.match(result.message, /authorization/i);
});

test("describes an empty Meta query as scoped evidence, not global zero activity", async () => {
  const result = await queryMetaAdLibrary({ domain: "rival.example", brand: "Rival", facebookUrl: "https://facebook.com/123456789" }, "Germany", "server-secret", async () => Response.json({ data: [] }));
  assert.equal(result.status, "no-verified-result");
  assert.match(result.message, /not proof of zero advertising/i);
});

test("does not query ordinary commercial ads in a region without Meta API coverage", async () => {
  let called = false;
  const result = await queryMetaAdLibrary({ domain: "rival.example", brand: "Rival" }, "United Kingdom", "server-secret", async () => { called = true; return Response.json({ data: [] }); });
  assert.equal(called, false);
  assert.equal(result.status, "access-limited");
  assert.match(result.message, /does not provide ordinary commercial-ad coverage for GB/i);
});

test("does not turn un-linkable Meta records into a false empty result", async () => {
  const result = await queryMetaAdLibrary({ domain: "rival.example", brand: "Rival", facebookUrl: "https://facebook.com/123456789" }, "Germany", "server-secret", async () => Response.json({ data: [{ id: "not-public", page_id: "123456789", page_name: "Rival", ad_creative_bodies: ["x".repeat(400)] }] }));
  assert.equal(result.status, "access-limited");
  assert.match(result.message, /no usable public ad IDs/i);
  assert.deepEqual(result.themes, []);
});

test("accepts verified ads only when evidence URLs are from the matching official platform", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousMeta = process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
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
    if (previousMeta) process.env.META_AD_LIBRARY_ACCESS_TOKEN = previousMeta; else delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  }
});

test("token-enabled scan preserves stronger official-search evidence when Meta API access is limited", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousMeta = process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "openai-test";
  process.env.META_AD_LIBRARY_ACCESS_TOKEN = "meta-test";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://graph.facebook.com/")) {
      assert.equal(init.headers.Authorization, "Bearer meta-test");
      return Response.json({ error: { code: 10, error_subcode: 2332002 } }, { status: 403 });
    }
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ companies: [{ domain: "rival.example", summary: "Verified library evidence", recommendedAction: "Review the offer", platforms: [
      { platform: "Meta", status: "verified-active", activeCreativeCount: 1, message: "One active Meta ad", themes: ["Offer"], evidenceUrls: ["https://www.facebook.com/ads/library/?id=123"] },
      { platform: "Google", status: "verified-active", activeCreativeCount: 1, message: "One active Google ad", themes: ["Range"], evidenceUrls: ["https://adstransparency.google.com/advertiser/AR123"] },
      { platform: "TikTok", status: "no-verified-result", activeCreativeCount: 0, message: "None verified", themes: [], evidenceUrls: [] },
    ] }] }) }] }] });
  };
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival", facebookUrl: "https://facebook.com/123456789" }], "Germany");
    assert.equal(result.provider, "openai-official-library-search");
    assert.equal(result.companies[0].platforms[0].status, "verified-active");
    assert.equal(result.companies[0].platforms[1].status, "verified-active");
    assert.match(result.companies[0].summary, /Verified library evidence/);
    assert.match(result.companies[0].summary, /10\/2332002/);
    assert.equal(JSON.stringify(result).includes("meta-test"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
    if (previousMeta) process.env.META_AD_LIBRARY_ACCESS_TOKEN = previousMeta; else delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  }
});

test("rejects brand pages and generic library searches as direct ad evidence", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousMeta = process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only";
  delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  globalThis.fetch = async () => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ companies: [{ domain: "rival.example", summary: "Claimed active", recommendedAction: "Review", platforms: [
    { platform: "Meta", status: "verified-active", activeCreativeCount: 4, message: "Brand page only", themes: ["Offer"], evidenceUrls: ["https://www.facebook.com/RivalBrand"] },
    { platform: "Google", status: "verified-active", activeCreativeCount: 4, message: "Search only", themes: ["Offer"], evidenceUrls: ["https://adstransparency.google.com/?query=Rival"] },
    { platform: "TikTok", status: "verified-active", activeCreativeCount: 4, message: "Search only", themes: ["Offer"], evidenceUrls: ["https://library.tiktok.com/ads?adv_name=Rival"] },
  ] }] }) }] }] });
  try {
    const result = await scanOfficialAdLibraries([{ domain: "rival.example", brand: "Rival" }], "United Kingdom");
    assert.deepEqual(result.companies[0].platforms.map((platform) => platform.status), ["no-verified-result", "no-verified-result", "no-verified-result"]);
    assert.equal(result.companies[0].summary, "Automatic ad-library coverage is limited; no claim about advertising activity can be made yet.");
    assert.doesNotMatch(result.companies[0].summary, /claimed active/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey) process.env.OPENAI_API_KEY = previousKey; else delete process.env.OPENAI_API_KEY;
    if (previousMeta) process.env.META_AD_LIBRARY_ACCESS_TOKEN = previousMeta; else delete process.env.META_AD_LIBRARY_ACCESS_TOKEN;
  }
});
