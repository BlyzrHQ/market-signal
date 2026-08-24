import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildDirectProductSearchComparison } from "../app/lib/direct-product-search.ts";

const observedAt = "2026-08-23T10:00:00.000Z";

function product(domain, id, name, amount, currency = "GBP", sourceUrl = `https://${domain}/products/${id}`) {
  return {
    id,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description: "",
    category: "product",
    jsonLdType: "Product",
    priceSignals: amount === undefined ? [] : [{ raw: `${currency} ${String(amount)}`, currency, amount }],
    attributes: [],
    ownership: "self-declared-brand",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl,
    imageUrl: "",
    observedAt,
    claimIds: [`${id}-price`],
  };
}

function durableCheckpointCallbacks() {
  const records = new Map();
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    records,
    loadSearchCheckpoint: async (key) => records.get(key.primaryIndex) || null,
    saveSearchCheckpoint: async (key, checkpoint, expectedResultHash) => {
      const existing = records.get(key.primaryIndex);
      if (expectedResultHash === undefined) {
        if (existing) throw new Error("unexpected checkpoint replay");
      } else {
        assert.equal(existing?.resultHash, expectedResultHash);
      }
      const record = { result: structuredClone(checkpoint), resultHash: hash(checkpoint) };
      records.set(key.primaryIndex, record);
      return record;
    },
  };
}

test("direct search retains multiple priced URLs and drops every empty-price result", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const candidates = [
    { domain: "seller.test", sourceUrl: "https://seller.test/products/apple-a", title: "Apple Juice 1L" },
    { domain: "seller.test", sourceUrl: "https://seller.test/products/apple-b", title: "Pressed Apple Juice 1L" },
    { domain: "empty.test", sourceUrl: "https://empty.test/products/apple", title: "Apple Juice" },
    { domain: "zero.test", sourceUrl: "https://zero.test/products/apple", title: "Apple Juice" },
  ];
  const enriched = new Map([
    [candidates[0].sourceUrl, product("seller.test", "seller-a", candidates[0].title, 4, "GBP", candidates[0].sourceUrl)],
    [candidates[1].sourceUrl, product("seller.test", "seller-b", candidates[1].title, 4.5, "GBP", candidates[1].sourceUrl)],
    [candidates[2].sourceUrl, product("empty.test", "empty", candidates[2].title, undefined, "GBP", candidates[2].sourceUrl)],
    [candidates[3].sourceUrl, product("zero.test", "zero", candidates[3].title, 0, "GBP", candidates[3].sourceUrl)],
  ]);

  const comparison = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => ({ completed: true, queries: ["Apple Juice 1L"], candidates }),
    enrich: async (targets) => ({
      products: targets.map((target) => enriched.get(target.sourceUrl)).filter(Boolean),
      coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] },
    }),
  });

  assert.equal(comparison.matching?.method, "direct-web-search");
  assert.equal(comparison.matching?.judgeCalls, 0);
  assert.equal(comparison.matching?.embeddingCalls, 0);
  assert.equal(comparison.coverage.assignedPairCount, 2);
  assert.deepEqual(comparison.rows[0].matches.map((match) => match.product?.sourceUrl), [candidates[0].sourceUrl, candidates[1].sourceUrl]);
  assert.ok(comparison.rows[0].matches.every((match) => match.product?.priceSignals.some((signal) => Number.isFinite(signal.amount) && signal.amount > 0)));
  assert.ok(comparison.rows[0].matches.every((match) => match.assessment === undefined));
});

test("direct search never spends a search on a primary product with no displayable price", async () => {
  let searches = 0;
  const comparison = await buildDirectProductSearchComparison("shop.test", [{
    domain: "shop.test",
    products: [product("shop.test", "empty-primary", "No price", undefined)],
  }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => {
      searches += 1;
      return { completed: true, queries: [], candidates: [] };
    },
    enrich: async () => ({ products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } }),
  });

  assert.equal(searches, 0);
  assert.equal(comparison.coverage.assignedPairCount, 0);
  assert.deepEqual(comparison.rows, []);
});

test("direct search upgrades paid leads to a durable priced outcome and reuses it without enrichment", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const candidate = { domain: "seller.test", sourceUrl: "https://seller.test/products/apple", title: "Apple Juice 1L" };
  let searches = 0;
  let enrichments = 0;
  const durable = durableCheckpointCallbacks();
  const options = {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => {
      searches += 1;
      return { completed: true, queries: ["Apple Juice 1L"], candidates: [candidate] };
    },
    enrich: async () => {
      enrichments += 1;
      return {
        products: [product("seller.test", "seller-a", candidate.title, 4, "GBP", candidate.sourceUrl)],
        coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] },
      };
    },
    ...durable,
  };

  await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);
  await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);

  assert.equal(searches, 1);
  assert.equal(enrichments, 1);
  assert.equal(durable.records.get(0).result.version, 2);
  assert.equal(durable.records.get(0).result.primaryProductId, primary.id);
});

test("a non-HTTPS search result is dropped without losing or repaying the checkpoint", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const pricedCandidate = { domain: "seller.test", sourceUrl: "https://seller.test/products/apple", title: "Apple Juice 1L" };
  const unsafeCandidate = { domain: "legacy.test", sourceUrl: "http://legacy.test/products/apple", title: "Apple Juice 1L" };
  let searches = 0;
  const durable = durableCheckpointCallbacks();
  const options = {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => {
      searches += 1;
      return { completed: true, queries: ["Apple Juice 1L"], candidates: [unsafeCandidate, pricedCandidate] };
    },
    enrich: async (targets) => ({
      products: targets.map((target) => product("seller.test", "seller-a", pricedCandidate.title, 4, "GBP", target.sourceUrl)),
      coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] },
    }),
    ...durable,
  };

  const first = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);
  const second = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);

  assert.equal(searches, 1);
  assert.deepEqual(durable.records.get(0).result.candidates, [pricedCandidate]);
  assert.equal(durable.records.get(0).result.version, 2);
  assert.equal(first.coverage.assignedPairCount, 1);
  assert.equal(second.coverage.assignedPairCount, 1);
});

test("a provider-bounded search is a terminal primary outcome instead of an infinite retry", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const comparison = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => ({ completed: false, queries: ["Apple Juice 1L"], candidates: [], gap: "Search timed out." }),
    enrich: async () => ({ products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } }),
  });

  assert.equal(comparison.matching?.resultShortfall, 20);
  assert.equal(comparison.matching?.resultShortfallReason, "bounded-candidate-pool-exhausted");
  assert.match(comparison.matching?.gaps.join(" "), /timed out/i);
});

test("each call processes bounded new primaries while returning every previously committed priced row", async () => {
  const primaries = [
    product("shop.test", "primary-a", "Apple Juice 1L", 3.5),
    product("shop.test", "primary-b", "Banana Juice 1L", 4),
  ];
  const durable = durableCheckpointCallbacks();
  let searches = 0;
  let enrichments = 0;
  const options = {
    resultTarget: 20,
    maxNewPrimaryProducts: 1,
    referenceTimeMs: Date.parse(observedAt),
    search: async (_domain, primary) => {
      searches += 1;
      return { completed: true, queries: [primary.name], candidates: [{ domain: "seller.test", sourceUrl: `https://seller.test/products/${primary.id}`, title: primary.name }] };
    },
    enrich: async (targets) => {
      enrichments += 1;
      return {
        products: targets.map((target) => product("seller.test", target.productId, target.expectedName, 5, "GBP", target.sourceUrl)),
        coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] },
      };
    },
    ...durable,
  };

  const first = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: primaries }], options);
  assert.equal(first.coverage.assignedPairCount, 1);
  assert.equal(first.matching?.resultShortfallReason, "processing-incomplete");
  assert.deepEqual(first.matching?.processedPrimaryIds, ["primary-a"]);

  const second = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: primaries }], options);
  assert.equal(second.coverage.assignedPairCount, 2);
  assert.equal(second.matching?.resultShortfallReason, "bounded-candidate-pool-exhausted");
  assert.deepEqual(second.matching?.processedPrimaryIds, ["primary-a", "primary-b"]);
  assert.equal(searches, 2);
  assert.equal(enrichments, 2);
});

test("an invalid durable priced outcome is repaired from fresh bounded search", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  let searches = 0;
  const saves = [];
  const result = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => { searches += 1; return { completed: true, queries: [], candidates: [] }; },
    enrich: async () => ({ products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } }),
    loadSearchCheckpoint: async () => ({
      resultHash: "a".repeat(64),
      result: {
        version: 2,
        primaryProductId: primary.id,
        primarySourceUrl: primary.sourceUrl,
        completed: true,
        queries: [],
        candidates: [],
        outcome: { products: [product("seller.test", "empty", "No price", undefined)], pagesRequested: 1, pagesFetched: 1, gaps: [] },
      },
    }),
    saveSearchCheckpoint: async (_key, checkpoint, expectedResultHash) => {
      saves.push({ checkpoint: structuredClone(checkpoint), expectedResultHash });
      return { result: checkpoint, resultHash: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex") };
    },
  });
  assert.equal(searches, 1);
  assert.equal(saves.length, 2);
  assert.equal(saves[0].expectedResultHash, undefined);
  assert.equal(saves[1].expectedResultHash, createHash("sha256").update(JSON.stringify(saves[0].checkpoint)).digest("hex"));
  assert.equal(result.coverage.assignedPairCount, 0);
  assert.equal(result.matching?.resultShortfallReason, "bounded-candidate-pool-exhausted");
});
