import test from "node:test";
import assert from "node:assert/strict";

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

test("direct search reuses a durable paid-search checkpoint", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const candidate = { domain: "seller.test", sourceUrl: "https://seller.test/products/apple", title: "Apple Juice 1L" };
  let searches = 0;
  let saved;
  const options = {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => {
      searches += 1;
      return { completed: true, queries: ["Apple Juice 1L"], candidates: [candidate] };
    },
    enrich: async () => ({
      products: [product("seller.test", "seller-a", candidate.title, 4, "GBP", candidate.sourceUrl)],
      coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] },
    }),
    loadSearchCheckpoint: async () => saved,
    saveSearchCheckpoint: async (_key, checkpoint) => { saved = checkpoint; },
  };

  await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);
  await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);

  assert.equal(searches, 1);
  assert.equal(saved.version, 1);
  assert.equal(saved.primaryProductId, primary.id);
});

test("a non-HTTPS search result is dropped without losing or repaying the checkpoint", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const pricedCandidate = { domain: "seller.test", sourceUrl: "https://seller.test/products/apple", title: "Apple Juice 1L" };
  const unsafeCandidate = { domain: "legacy.test", sourceUrl: "http://legacy.test/products/apple", title: "Apple Juice 1L" };
  let searches = 0;
  let saved;
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
    loadSearchCheckpoint: async () => saved,
    saveSearchCheckpoint: async (_key, checkpoint) => { saved = checkpoint; },
  };

  const first = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);
  const second = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);

  assert.equal(searches, 1);
  assert.deepEqual(saved.candidates, [pricedCandidate]);
  assert.equal(first.coverage.assignedPairCount, 1);
  assert.equal(second.coverage.assignedPairCount, 1);
});

test("an incomplete direct search reports processing incompleteness instead of false exhaustion", async () => {
  const primary = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const comparison = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => ({ completed: false, queries: ["Apple Juice 1L"], candidates: [], gap: "Search timed out." }),
    enrich: async () => ({ products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } }),
  });

  assert.equal(comparison.matching?.resultShortfall, 20);
  assert.equal(comparison.matching?.resultShortfallReason, "processing-incomplete");
  assert.match(comparison.matching?.gaps.join(" "), /timed out/i);
});
