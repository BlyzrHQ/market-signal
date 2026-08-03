import assert from "node:assert/strict";
import test from "node:test";

import { mergeEdgeProductEnrichment, recoverProductEnrichmentThroughEdge, validatedEdgeEnrichmentUrl } from "../app/lib/edge-product-enrichment-recovery.ts";

const edgeUrl = "https://market-signal.abdulla617931.chatgpt.site/api/enrich-products";
const token = "a-valid-test-callback-token-with-32-chars";
const target = {
  domain: "shop.test",
  sourceUrl: "https://shop.test/product/maamoul-date-250g",
  productId: "maamoul-date",
  expectedName: "Maamoul Date 250g",
  expectedType: "Product",
  pairScore: 0.9,
  role: "primary",
};
const product = {
  id: "maamoul-date",
  domain: "shop.test",
  name: "Maamoul Date 250g",
  normalizedName: "maamoul date 250g",
  description: "",
  category: "product",
  jsonLdType: "Product",
  priceSignals: [{ raw: "USD 10.8", currency: "USD", amount: 10.8 }],
  attributes: [],
  ownership: "path-inferred",
  extraction: "json-ld",
  confidence: "Medium",
  sourceUrl: target.sourceUrl,
  imageUrl: "https://cdn.shop.test/maamoul.jpg",
  observedAt: "2026-08-03T00:00:00.000Z",
  claimIds: [],
};

test("permits only the distinct exact Sites enrichment endpoint", () => {
  assert.equal(validatedEdgeEnrichmentUrl(edgeUrl, "https://signal.blyzr.com/api/enrich-products")?.toString(), edgeUrl);
  assert.equal(validatedEdgeEnrichmentUrl(edgeUrl, edgeUrl), null);
  assert.equal(validatedEdgeEnrichmentUrl("https://example.com/api/enrich-products", "https://signal.blyzr.com/api/enrich-products"), null);
  assert.equal(validatedEdgeEnrichmentUrl(`${edgeUrl}?domain=shop.test`, "https://signal.blyzr.com/api/enrich-products"), null);
});

test("recovers a bounded identity-matched product without transmitting secrets", async () => {
  let request;
  const recovered = await recoverProductEnrichmentThroughEdge([target], {
    configuredUrl: edgeUrl,
    requestUrl: "https://signal.blyzr.com/api/enrich-products",
    callbackToken: token,
    deployTarget: "node",
    fetchImpl: async (input, init) => {
      request = { input: String(input), init };
      return Response.json({ ok: true, products: [product], coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 64, gaps: [] } });
    },
  });
  assert.equal(request.input, edgeUrl);
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(request.init.headers["x-market-signal-edge-fallback"], undefined);
  assert.doesNotMatch(JSON.stringify(request), new RegExp(token));
  assert.deepEqual(JSON.parse(request.init.body), { targets: [target] });
  assert.equal(recovered[0].priceSignals[0].amount, 10.8);
  assert.equal(recovered[0].imageUrl, product.imageUrl);
});

test("does zero egress whenever a recovery gate is absent", async (t) => {
  const cases = [
    ["no targets", [], "node", edgeUrl, token, "https://signal.blyzr.com/api/enrich-products"],
    ["Sites target", [target], "sites", edgeUrl, token, "https://signal.blyzr.com/api/enrich-products"],
    ["unset URL", [target], "node", undefined, token, "https://signal.blyzr.com/api/enrich-products"],
    ["same origin", [target], "node", edgeUrl, token, edgeUrl],
    ["short token", [target], "node", edgeUrl, "short", "https://signal.blyzr.com/api/enrich-products"],
  ];
  for (const [name, targets, deployTarget, configuredUrl, callbackToken, requestUrl] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await recoverProductEnrichmentThroughEdge(targets, { configuredUrl, requestUrl, callbackToken, deployTarget, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
      assert.equal(result, undefined);
      assert.equal(calls, 0);
    });
  }
});

test("rejects the whole edge response on identity, URL, image, price, or bounds violations", async (t) => {
  const invalidProducts = [
    { ...product, id: "unknown" },
    { ...product, domain: "other.test" },
    { ...product, sourceUrl: "https://shop.test/product/other" },
    { ...product, imageUrl: "http://cdn.shop.test/maamoul.jpg" },
    { ...product, priceSignals: [{ raw: "USD NaN", currency: "USD", amount: Number.NaN }] },
  ];
  for (const invalid of invalidProducts) {
    await t.test(invalid.id + invalid.sourceUrl + invalid.imageUrl, async () => {
      const result = await recoverProductEnrichmentThroughEdge([target], {
        configuredUrl: edgeUrl,
        requestUrl: "https://signal.blyzr.com/api/enrich-products",
        callbackToken: token,
        deployTarget: "node",
        fetchImpl: async () => Response.json({ ok: true, products: [invalid], coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1 } }),
      });
      assert.equal(result, null);
    });
  }
  const impossibleCoverage = await recoverProductEnrichmentThroughEdge([target], {
    configuredUrl: edgeUrl,
    requestUrl: "https://signal.blyzr.com/api/enrich-products",
    callbackToken: token,
    deployTarget: "node",
    fetchImpl: async () => Response.json({ ok: true, products: [], coverage: { pagesRequested: 2, pagesFetched: 0, maxPages: 1 } }),
  });
  assert.equal(impossibleCoverage, null);
});

test("merges recovered products, removes only their original gaps, and records provenance", () => {
  const local = { products: [], coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: 64, gaps: [{ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "robots unreachable", code: "robots_unreachable" }] } };
  const merged = mergeEdgeProductEnrichment(local, [target], [product], "market-signal.abdulla617931.chatgpt.site");
  assert.equal(merged.products.length, 1);
  assert.equal(merged.coverage.pagesFetched, 1);
  assert.equal(merged.coverage.gaps.length, 0);
  assert.deepEqual({ recovered: merged.coverage.edgeRecovery.recovered, requested: merged.coverage.edgeRecovery.requested }, { recovered: 1, requested: 1 });
});

test("keeps the original gap and adds a visible gap when the edge response fails validation", () => {
  const local = { products: [], coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: 64, gaps: [{ url: target.sourceUrl, productId: target.productId, role: target.role, reason: "robots unreachable", code: "robots_unreachable" }] } };
  const merged = mergeEdgeProductEnrichment(local, [target], null, "market-signal.abdulla617931.chatgpt.site");
  assert.deepEqual(merged.coverage.gaps.map((gap) => gap.code), ["robots_unreachable", "fetch_failed"]);
  assert.deepEqual({ recovered: merged.coverage.edgeRecovery.recovered, requested: merged.coverage.edgeRecovery.requested }, { recovered: 0, requested: 1 });
});

test("rejects oversized images and invalid observation timestamps instead of silently dropping them", async () => {
  for (const invalid of [{ ...product, imageUrl: `https://cdn.shop.test/${"a".repeat(2_100)}` }, { ...product, observedAt: "not-a-date" }]) {
    const result = await recoverProductEnrichmentThroughEdge([target], {
      configuredUrl: edgeUrl,
      requestUrl: "https://signal.blyzr.com/api/enrich-products",
      callbackToken: token,
      deployTarget: "node",
      fetchImpl: async () => Response.json({ ok: true, products: [invalid], coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 64 } }),
    });
    assert.equal(result, null);
  }
});
