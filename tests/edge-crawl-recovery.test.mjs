import assert from "node:assert/strict";
import test from "node:test";

import { EDGE_CRAWL_MARKER, isEdgeRecoveryEligible, recoverCrawlThroughEdge, validatedEdgeCrawlUrl } from "../app/lib/edge-crawl-recovery.ts";
import { POST as crawlPost } from "../app/api/crawl/route.ts";

const edgeUrl = "https://market-signal.abdulla617931.chatgpt.site/api/crawl";
const token = "a-valid-test-callback-token-with-32-chars";

test("permits only a distinct exact HTTPS Sites crawl endpoint", () => {
  assert.equal(validatedEdgeCrawlUrl(edgeUrl, "https://signal.blyzr.com/api/crawl")?.toString(), edgeUrl);
  assert.equal(validatedEdgeCrawlUrl(edgeUrl, edgeUrl), null);
  assert.equal(validatedEdgeCrawlUrl("http://market-signal.abdulla617931.chatgpt.site/api/crawl", "https://signal.blyzr.com/api/crawl"), null);
  assert.equal(validatedEdgeCrawlUrl("https://market-signal.abdulla617931.chatgpt.site/api/reports", "https://signal.blyzr.com/api/crawl"), null);
  assert.equal(validatedEdgeCrawlUrl("https://another-site.chatgpt.site/api/crawl", "https://signal.blyzr.com/api/crawl"), null);
  assert.equal(validatedEdgeCrawlUrl("https://example.com/api/crawl", "https://signal.blyzr.com/api/crawl"), null);
  assert.equal(validatedEdgeCrawlUrl(`${edgeUrl}?target=elsewhere`, "https://signal.blyzr.com/api/crawl"), null);
});

test("permits recovery only for a typed dual-host HTTP 403", () => {
  assert.equal(isEdgeRecoveryEligible({ homepage: null, homepageAccessDenied: { status: 403, hosts: ["shop.test", "www.shop.test"] } }), true);
  assert.equal(isEdgeRecoveryEligible({ homepage: null }), false);
  assert.equal(isEdgeRecoveryEligible({ homepage: {}, homepageAccessDenied: { status: 403, hosts: ["shop.test", "www.shop.test"] } }), false);
  assert.equal(isEdgeRecoveryEligible({ homepage: null, homepageAccessDenied: { status: 403, hosts: ["shop.test"] } }), false);
});

test("rejects a marked edge request without the shared internal credential before crawling", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  let fetchCalls = 0;
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = token;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("must not fetch"); };
  try {
    const response = await crawlPost(new Request(edgeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [EDGE_CRAWL_MARKER]: "1", Authorization: "Bearer invalid" },
      body: JSON.stringify({ primary: "shop.test", domains: ["shop.test"] }),
    }));
    assert.equal(response.status, 401);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN; else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = originalToken;
  }
});

test("accepts a bounded identity-matched live edge result and records provenance", async () => {
  let request;
  const recovered = await recoverCrawlThroughEdge(
    { primary: "shop.test", domains: ["shop.test"] },
    {
      configuredUrl: edgeUrl,
      requestUrl: "https://signal.blyzr.com/api/crawl",
      callbackToken: token,
      deployTarget: "node",
      fetchImpl: async (input, init) => {
        request = { input: String(input), init };
        return Response.json({
          ok: true,
          live: true,
          primaryDomain: "shop.test",
          results: [{ domain: "shop.test", homepage: { sourceUrl: "https://www.shop.test/" }, products: [{ name: "Honey" }], gaps: [] }],
          document: { blocks: [] },
        });
      },
    },
  );
  assert.equal(request.input, edgeUrl);
  assert.equal(request.init.headers[EDGE_CRAWL_MARKER], undefined);
  assert.equal(request.init.headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(request), new RegExp(token));
  assert.deepEqual(JSON.parse(request.init.body), { primary: "shop.test", domains: ["shop.test"] });
  assert.equal(recovered.edgeRecovery.recovered, true);
  assert.equal(recovered.results[0].coverage.crawlEgress, "edge-recovered");
  assert.match(recovered.results[0].gaps[0].reason, /recovered through the configured/);
  assert.equal(recovered.document.blocks.at(-1).id, "edge-crawl-recovery-shop.test");
});

test("accepts explicitly declared third-party discovery evidence without opening product-source validation", async () => {
  const recovered = await recoverCrawlThroughEdge(
    { primary: "shop.test", domains: ["shop.test"] },
    {
      configuredUrl: edgeUrl,
      requestUrl: "https://signal.blyzr.com/api/crawl",
      callbackToken: token,
      deployTarget: "node",
      fetchImpl: async () => Response.json({
        ok: true,
        live: true,
        primaryDomain: "shop.test",
        discovery: { candidates: [{ domain: "rival.test", sourceUrl: "https://directory.test/shops", evidence: [{ url: "https://directory.test/shops" }] }] },
        results: [{ domain: "shop.test", homepage: { sourceUrl: "https://shop.test/" }, products: [], gaps: [] }],
        document: { blocks: [] },
      }),
    },
  );
  assert.equal(recovered.ok, true);
  const rejected = await recoverCrawlThroughEdge(
    { primary: "shop.test", domains: ["shop.test"] },
    {
      configuredUrl: edgeUrl,
      requestUrl: "https://signal.blyzr.com/api/crawl",
      callbackToken: token,
      deployTarget: "node",
      fetchImpl: async () => Response.json({ ok: true, live: true, primaryDomain: "shop.test", results: [{ domain: "shop.test", homepage: { sourceUrl: "https://shop.test/" }, products: [{ sourceUrl: "https://attacker.test/product" }] }] }),
    },
  );
  assert.equal(rejected, null);
  const reusedDiscoveryEvidence = await recoverCrawlThroughEdge(
    { primary: "shop.test", domains: ["shop.test"] },
    {
      configuredUrl: edgeUrl,
      requestUrl: "https://signal.blyzr.com/api/crawl",
      callbackToken: token,
      deployTarget: "node",
      fetchImpl: async () => Response.json({
        ok: true,
        live: true,
        primaryDomain: "shop.test",
        discovery: { candidates: [{ sourceUrl: "https://directory.test/shops" }] },
        results: [{ domain: "shop.test", homepage: { sourceUrl: "https://shop.test/" }, products: [{ sourceUrl: "https://directory.test/shops" }] }],
      }),
    },
  );
  assert.equal(reusedDiscoveryEvidence, null);
});

test("rejects oversized, non-JSON, failed, or identity-mismatched edge responses", async (t) => {
  const options = { configuredUrl: edgeUrl, requestUrl: "https://signal.blyzr.com/api/crawl", callbackToken: token, deployTarget: "node", maxResponseBytes: 128 };
  await t.test("declared oversize", async () => {
    const result = await recoverCrawlThroughEdge({ primary: "shop.test", domains: ["shop.test"] }, { ...options, fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "129" } }) });
    assert.equal(result, null);
  });
  await t.test("wrong content type", async () => {
    const result = await recoverCrawlThroughEdge({ primary: "shop.test", domains: ["shop.test"] }, { ...options, fetchImpl: async () => new Response("ok", { headers: { "content-type": "text/plain" } }) });
    assert.equal(result, null);
  });
  await t.test("wrong identity", async () => {
    const result = await recoverCrawlThroughEdge({ primary: "shop.test", domains: ["shop.test"] }, { ...options, maxResponseBytes: 2_000, fetchImpl: async () => Response.json({ ok: true, live: true, primaryDomain: "other.test", results: [] }) });
    assert.equal(result, null);
  });
  await t.test("off-domain evidence", async () => {
    const result = await recoverCrawlThroughEdge({ primary: "shop.test", domains: ["shop.test"] }, { ...options, maxResponseBytes: 2_000, fetchImpl: async () => Response.json({ ok: true, live: true, primaryDomain: "shop.test", results: [{ domain: "shop.test", homepage: { sourceUrl: "https://attacker.test/" }, products: [] }] }) });
    assert.equal(result, null);
  });
});

test("permits edge egress only from the VPS build target with a valid local gate", async (t) => {
  for (const [name, deployTarget, callbackToken] of [
    ["missing deploy target", undefined, token],
    ["Sites deploy target", "sites", token],
    ["missing local gate", "node", ""],
    ["short local gate", "node", "short"],
  ]) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      const result = await recoverCrawlThroughEdge(
        { primary: "shop.test", domains: ["shop.test"] },
        {
          configuredUrl: edgeUrl,
          requestUrl: "https://signal.blyzr.com/api/crawl",
          callbackToken,
          deployTarget,
          fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); },
        },
      );
      assert.equal(result, undefined);
      assert.equal(fetchCalls, 0);
    });
  }
});
