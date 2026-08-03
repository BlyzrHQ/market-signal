import assert from "node:assert/strict";
import test from "node:test";

import { EDGE_PRODUCT_ENRICHMENT_MARKER, edgeRecoverableProductTargets, mergeEdgeProductEnrichment, recoverProductEnrichmentThroughEdge, validatedEdgeEnrichmentUrl } from "../app/lib/edge-product-enrichment-recovery.ts";

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

test("recovers a bounded identity-matched product through an authenticated edge request", async () => {
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
  assert.equal(request.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.init.headers[EDGE_PRODUCT_ENRICHMENT_MARKER], "1");
  assert.doesNotMatch(request.init.body, new RegExp(token));
  assert.deepEqual(JSON.parse(request.init.body), { targets: [target] });
  assert.equal(recovered[0].priceSignals[0].amount, 10.8);
  assert.equal(recovered[0].imageUrl, product.imageUrl);
});

test("selects only unresolved robots or typed access-block failures for one edge batch", () => {
  const targets = [
    target,
    { ...target, productId: "local-success", sourceUrl: "https://shop.test/product/local-success" },
    { ...target, productId: "blocked-403", sourceUrl: "https://shop.test/product/blocked-403" },
    { ...target, productId: "network", sourceUrl: "https://shop.test/product/network" },
    { ...target, productId: "missing-404", sourceUrl: "https://shop.test/product/missing-404" },
    { ...target, productId: "non-html", sourceUrl: "https://shop.test/product/non-html" },
    { ...target, productId: "identity", sourceUrl: "https://shop.test/product/identity" },
  ];
  const localSuccess = { ...product, id: "local-success", sourceUrl: targets[1].sourceUrl };
  const gap = (productId, code, httpStatus) => ({
    url: targets.find((item) => item.productId === productId)?.sourceUrl || target.sourceUrl,
    productId,
    role: "primary",
    reason: code,
    code,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(code === "fetch_failed" ? { failureKind: httpStatus === 0 ? "network" : httpStatus === 200 ? "content" : "http" } : {}),
  });
  const selected = edgeRecoverableProductTargets({
    products: [localSuccess],
    coverage: {
      pagesRequested: targets.length,
      pagesFetched: 1,
      maxPages: 64,
      gaps: [
        gap("local-success", "fetch_failed", 403),
        gap("blocked-403", "fetch_failed", 403),
        gap("network", "fetch_failed", 0),
        gap("missing-404", "fetch_failed", 404),
        gap("non-html", "fetch_failed", 200),
        gap("identity", "identity_mismatch"),
        gap("maamoul-date", "robots_unreachable"),
      ],
    },
  }, [...targets, { ...targets[2] }]);
  assert.deepEqual(selected.map((item) => item.productId), ["maamoul-date", "blocked-403", "network"]);
});

test("uses the explicit HTTP recovery allowlist and rejects ordinary failures", () => {
  const statuses = [401, 403, 407, 429, 451, 404, 410, 500, 503, 200];
  const targets = statuses.map((status) => ({ ...target, productId: `status-${status}`, sourceUrl: `https://shop.test/product/status-${status}` }));
  const selected = edgeRecoverableProductTargets({
    products: [],
    coverage: {
      pagesRequested: targets.length,
      pagesFetched: 0,
      maxPages: 64,
      gaps: statuses.map((status) => ({
        url: `https://shop.test/product/status-${status}`,
        productId: `status-${status}`,
        role: "primary",
        reason: `HTTP ${status}`,
        code: "fetch_failed",
        httpStatus: status,
        failureKind: status === 200 ? "content" : "http",
      })),
    },
  }, targets);
  assert.deepEqual(selected.map((item) => item.productId), ["status-401", "status-403", "status-407", "status-429", "status-451"]);
});

test("edge recovery permits a marked replacement only for an explicitly eligible target", async () => {
  const eligible = { ...target, expectedName: "Maamoul Walnut 500g", allowCatalogReplacement: true };
  const replacement = {
    ...product,
    name: "Maamoul Walnut 600g",
    normalizedName: "untrusted edge normalization",
    attributes: [`Previous sitemap identity: ${eligible.expectedName} (${eligible.sourceUrl})`],
    identifiers: { gtins: [], sku: "LIVE-600", brand: "Live Brand" },
  };
  const call = (targets) => recoverProductEnrichmentThroughEdge(targets, {
    configuredUrl: edgeUrl,
    requestUrl: "https://signal.blyzr.com/api/enrich-products",
    callbackToken: token,
    deployTarget: "node",
    fetchImpl: async () => Response.json({ ok: true, products: [replacement], coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] } }),
  });
  const accepted = await call([eligible]);
  assert.equal(accepted[0].normalizedName, "maamoul walnut 600g");
  assert.equal(accepted[0].quantity.amount, 600);
  assert.equal(accepted[0].identifiers.sku, "LIVE-600");
  assert.equal(await call([target]), null);
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

test("allows exactly 64 targets and rejects 65 targets with zero egress", async () => {
  const targets64 = Array.from({ length: 64 }, (_, index) => ({
    ...target,
    productId: `product-${index}`,
    sourceUrl: `https://shop.test/product/product-${index}`,
  }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ ok: true, products: [], coverage: { pagesRequested: 64, pagesFetched: 0, maxPages: 64, gaps: [] } });
  };
  assert.deepEqual(await recoverProductEnrichmentThroughEdge(targets64, {
    configuredUrl: edgeUrl,
    requestUrl: "https://signal.blyzr.com/api/enrich-products",
    callbackToken: token,
    deployTarget: "node",
    fetchImpl,
  }), []);
  assert.equal(calls, 1);
  assert.equal(await recoverProductEnrichmentThroughEdge([...targets64, { ...target, productId: "product-64", sourceUrl: "https://shop.test/product/product-64" }], {
    configuredUrl: edgeUrl,
    requestUrl: "https://signal.blyzr.com/api/enrich-products",
    callbackToken: token,
    deployTarget: "node",
    fetchImpl,
  }), undefined);
  assert.equal(calls, 1);
});

test("rejects contradictory edge coverage metadata", async (t) => {
  const cases = [
    ["requested count differs", { pagesRequested: 0, pagesFetched: 1, maxPages: 1, gaps: [] }, [product]],
    ["fetched count differs", { pagesRequested: 1, pagesFetched: 0, maxPages: 1, gaps: [] }, [product]],
    ["max pages is below requested", { pagesRequested: 1, pagesFetched: 1, maxPages: 0, gaps: [] }, [product]],
  ];
  for (const [name, coverage, products] of cases) {
    await t.test(name, async () => {
      const result = await recoverProductEnrichmentThroughEdge([target], {
        configuredUrl: edgeUrl,
        requestUrl: "https://signal.blyzr.com/api/enrich-products",
        callbackToken: token,
        deployTarget: "node",
        fetchImpl: async () => Response.json({ ok: true, products, coverage }),
      });
      assert.equal(result, null);
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
