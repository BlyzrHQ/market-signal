import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildDirectProductSearchComparison } from "../app/lib/direct-product-search.ts";
import { mergePublishedProductComparisonState } from "../app/lib/product-match-lifecycle.ts";
import { evaluateReportDraftQuality } from "../src/shared/report-quality-gate.ts";

const observedAt = "2026-08-23T10:00:00.000Z";

test("bounded parallel waves retain deterministic output and stop after the target", async () => {
  const primaries = Array.from({ length: 12 }, (_, i) => product("shop.test", `p${i.toString().padStart(2, "0")}`, `Product ${i}`, 10));
  let active = 0, peak = 0, searches = 0;
  const result = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: primaries }], {
    resultTarget: 4, concurrency: 4, referenceTimeMs: Date.parse(observedAt),
    search: async (_domain, p) => {
      searches++; active++; peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { completed: true, queries: [p.name], candidates: [{ domain: "seller.test", sourceUrl: `https://seller.test/products/${p.id}`, title: p.name }] };
    },
    enrich: async targets => ({ products: targets.map(t => product(t.domain, t.productId, t.expectedName, 11, "GBP", t.sourceUrl)), coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] } }),
  });
  assert.equal(peak, 4);
  assert.equal(searches, 4);
  assert.equal(result.coverage.assignedPairCount, 4);
  assert.deepEqual(result.rows.map(r => r.primary.name), ["Product 0", "Product 1", "Product 10", "Product 11"]);
});

test("unpriced primaries do not occupy parallel slots and checkpoint indices stay stable", async () => {
  const primaries = Array.from({length:8}, (_,i)=>product("shop.test",`p${i}`,`Product ${i}`,i%2 ? 10 : undefined));
  const savedIndices = [];
  let active=0, peak=0;
  await buildDirectProductSearchComparison("shop.test",[{domain:"shop.test",products:primaries}],{
    resultTarget:20,concurrency:4,referenceTimeMs:Date.parse(observedAt),
    search:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return {completed:true,queries:[],candidates:[]};},
    loadSearchCheckpoint:async key=>{savedIndices.push(key.primaryIndex);return null;},
  });
  assert.equal(peak,4);
  assert.deepEqual(savedIndices,[1,3,5,7]);
});

test("wrong-currency sellers never consume the target or rival cap", async () => {
  const p = product("shop.test", "p", "Honey 500g", 10);
  const wrong = product("aaa.test", "wrong", "Honey 500g", 12, "USD");
  const good = product("zzz.test", "good", "Honey 500g", 12);
  const result = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [p] }], {
    resultTarget: 1, maxRivalDomains: 1, referenceTimeMs: Date.parse(observedAt),
    search: async () => ({ completed: true, queries: [p.name], candidates: [wrong, good].map(p=>({domain:p.domain,sourceUrl:p.sourceUrl,title:p.name})) }),
    enrich: async () => ({ products: [wrong, good], coverage: { pagesRequested: 2, pagesFetched: 2, maxPages: 2, gaps: [] } }),
  });
  assert.equal(result.rows[0].matches[0].domain, "zzz.test");
});

test("CLI compatibility screening runs before seller allocation and also on saved outcomes", async () => {
  const primary = product("shop.test", "p", "Body Sunscreen", 10);
  const bad = product("aaa.test", "bad", "Body Wash", 9);
  const good = product("zzz.test", "good", "Body Sunscreen", 12);
  const saved = new Map(); let calls = 0;
  const options = { resultTarget: 1, maxRivalDomains: 1, enforceCompatibility: true, referenceTimeMs: Date.parse(observedAt),
    search: async () => { calls++; return {completed:true, queries:[], candidates:[bad,good].map(p=>({domain:p.domain,sourceUrl:p.sourceUrl,title:p.name}))}; },
    enrich: async () => ({products:[bad,good],coverage:{pagesRequested:2,pagesFetched:2,maxPages:2,gaps:[]}}),
    loadSearchCheckpoint: async key => saved.get(key.inputHash) || null,
    saveSearchCheckpoint: async (key, result) => { const record={result,resultHash:createHash("sha256").update(JSON.stringify(result)).digest("hex")}; saved.set(key.inputHash,record);return record; },
  };
  for (let i=0;i<2;i++) {
    const result = await buildDirectProductSearchComparison("shop.test",[{domain:"shop.test",products:[primary]}],options);
    assert.equal(result.rows[0].matches[0].domain,"zzz.test");
    assert.ok(result.matching.gaps.some(gap=>gap.includes("different-product-functions")));
  }
  assert.equal(calls,1);
});

test("seller allocation can replace an early low-yield seller with later coverage", async () => {
  const primaries = [product("shop.test", "p1", "A", 10), product("shop.test", "p2", "B", 10)];
  const result = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: primaries }], {
    resultTarget: 2, maxRivalDomains: 1, referenceTimeMs: Date.parse(observedAt),
    search: async (_domain, p) => ({ completed:true, queries:[p.name], candidates: (p.id === "p1" ? [product("early.test","a","A",12)] : [product("later.test","b","B pack",12),product("later.test","c","B large",15)]).map(p=>({domain:p.domain,sourceUrl:p.sourceUrl,title:p.name})) }),
    enrich: async targets => ({ products:targets.map(t=>product(t.domain,t.productId,t.expectedName,12,"GBP",t.sourceUrl)),coverage:{pagesRequested:targets.length,pagesFetched:targets.length,maxPages:targets.length,gaps:[]} }),
  });
  assert.equal(result.coverage.assignedPairCount, 2);
  assert.deepEqual(result.comparisonDomains, ["later.test"]);
});

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

test("direct search replaces a repeated global rival with a later distinct priced result", async () => {
  const primaries = [
    product("shop.test", "primary-a", "Alpha Beard Oil", 20),
    product("shop.test", "primary-b", "Beta Beard Oil", 21),
    product("shop.test", "primary-c", "Gamma Beard Oil", 22),
  ];
  const sharedSource = "https://seller.test/products/shared-beard-oil";
  let searches = 0;

  const comparison = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: primaries }], {
    resultTarget: 2,
    referenceTimeMs: Date.parse(observedAt),
    search: async (_domain, primary) => {
      searches += 1;
      const sourceUrl = primary.id === "primary-c" ? "https://seller.test/products/gamma-beard-oil" : sharedSource;
      return { completed: true, queries: [primary.name], candidates: [{ domain: "seller.test", sourceUrl, title: primary.name }] };
    },
    enrich: async (targets) => ({
      products: targets.map((target) => product("seller.test", target.productId, target.expectedName, 24, "GBP", target.sourceUrl)),
      coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] },
    }),
  });

  assert.equal(searches, 3);
  assert.equal(comparison.coverage.assignedPairCount, 2);
  assert.deepEqual(comparison.rows.map((row) => row.primary.id), ["primary-a", "primary-c"]);
  assert.equal(new Set(comparison.rows.flatMap((row) => row.matches.map((match) => match.product?.sourceUrl))).size, 2);

  const published = mergePublishedProductComparisonState(comparison, null, 2, Date.parse(observedAt), "pairs").comparison;
  assert.equal(published.coverage.assignedPairCount, 2);
  assert.equal(published.matching?.resultShortfall, 0);
});

test("direct search durably retains priced page-scoped product evidence", async () => {
  const primary = product("shop.test", "primary-a", "Seven Spices 500g", 11.12);
  const candidate = { domain: "seller.test", sourceUrl: "https://seller.test/products/seven-spices", title: "Seven Spices 500g" };
  const pageSignal = {
    ...product("seller.test", "seller-a", candidate.title, 9.99, "GBP", candidate.sourceUrl),
    jsonLdType: "PageSignal",
    extraction: "page-signal",
    confidence: "Medium",
  };
  const durable = durableCheckpointCallbacks();
  let enrichments = 0;
  const options = {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => ({ completed: true, queries: [candidate.title], candidates: [candidate] }),
    enrich: async () => {
      enrichments += 1;
      return {
        products: [pageSignal],
        coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] },
      };
    },
    ...durable,
  };

  const first = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);
  const replay = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], options);

  assert.equal(enrichments, 1);
  assert.equal(first.coverage.assignedPairCount, 1);
  assert.equal(replay.coverage.assignedPairCount, 1);
  assert.equal(first.rows[0].matches[0].product.jsonLdType, "PageSignal");
  assert.equal(durable.records.get(0).result.version, 2);
  assert.equal(durable.records.get(0).result.outcome.products[0].jsonLdType, "PageSignal");
});

test("direct search includes priced first-party page-signal products in its primary pool", async () => {
  const primary = {
    ...product("shop.test", "primary-page", "Custom Work Coverall", 89.5),
    jsonLdType: "PageSignal",
    extraction: "page-signal",
    confidence: "Medium",
  };
  const candidate = { domain: "seller.test", sourceUrl: "https://seller.test/products/work-coverall", title: "Custom Work Coverall" };
  let searches = 0;

  const comparison = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => {
      searches += 1;
      return { completed: true, queries: [primary.name], candidates: [candidate] };
    },
    enrich: async () => ({
      products: [product("seller.test", "seller-page", candidate.title, 95, "GBP", candidate.sourceUrl)],
      coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] },
    }),
  });

  assert.equal(searches, 1);
  assert.deepEqual(comparison.matching?.processedPrimaryIds, [primary.id]);
  assert.equal(comparison.coverage.assignedPairCount, 1);
  assert.equal(comparison.rows[0].primary.jsonLdType, "PageSignal");
  assert.equal(comparison.rows[0].matches[0].publication?.priceEligible, true);
});

test("direct search never spends on a priced page signal without a canonical HTTPS source", async () => {
  const primary = {
    ...product("shop.test", "unsafe-primary", "Custom Work Coverall", 89.5, "GBP", "http://shop.test/products/unsafe-primary"),
    jsonLdType: "PageSignal",
    extraction: "page-signal",
    confidence: "Medium",
  };
  let searches = 0;
  let checkpointLoads = 0;

  const comparison = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {
    resultTarget: 20,
    referenceTimeMs: Date.parse(observedAt),
    search: async () => {
      searches += 1;
      return { completed: true, queries: [primary.name], candidates: [] };
    },
    enrich: async () => ({ products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } }),
    loadSearchCheckpoint: async () => {
      checkpointLoads += 1;
      return null;
    },
    saveSearchCheckpoint: async () => {
      throw new Error("unsafe primary must not save a checkpoint");
    },
  });

  assert.equal(searches, 0);
  assert.equal(checkpointLoads, 0);
  assert.deepEqual(comparison.matching?.processedPrimaryIds, []);
  assert.equal(comparison.coverage.assignedPairCount, 0);
  assert.equal(comparison.matching?.resultShortfallReason, "bounded-candidate-pool-exhausted");
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

test("quality repair searches only named primaries, excludes accepted URLs, and replays without another search", async () => {
  const primaryA = product("shop.test", "primary-a", "Apple Juice 1L", 3.5);
  const primaryB = product("shop.test", "primary-b", "Banana Juice 1L", 4);
  const acceptedUrl = "https://seller.test/products/apple";
  const freshUrl = "https://other.test/products/banana";
  const records = new Map();
  const checkpointKeys = [];
  let searches = 0;
  const callbacks = {
    loadSearchCheckpoint: async (key) => records.get(key.inputHash) || null,
    saveSearchCheckpoint: async (key, checkpoint, expectedResultHash) => {
      checkpointKeys.push(key.inputHash);
      const existing = records.get(key.inputHash);
      if (expectedResultHash !== undefined) assert.equal(existing?.resultHash, expectedResultHash);
      const record = { result: structuredClone(checkpoint), resultHash: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex") };
      records.set(key.inputHash, record);
      return record;
    },
  };
  const search = async (_domain, primary, _market, feedback) => {
    searches += 1;
    if (primary.id === primaryA.id) {
      assert.equal(feedback, undefined);
      return { completed: true, queries: [primary.name], candidates: [{ domain: "seller.test", sourceUrl: acceptedUrl, title: primary.name }] };
    }
    assert.equal(primary.id, primaryB.id);
    assert.equal(feedback.round, 1);
    return { completed: true, queries: [primary.name], candidates: [
      { domain: "seller.test", sourceUrl: acceptedUrl, title: "Repeated Apple Juice" },
      { domain: "other.test", sourceUrl: freshUrl, title: primary.name },
    ] };
  };
  const enrich = async (targets) => ({
    products: targets.map((target) => product(target.domain, target.productId, target.expectedName, 5, "GBP", target.sourceUrl)),
    coverage: { pagesRequested: targets.length, pagesFetched: targets.length, maxPages: targets.length, gaps: [] },
  });

  const base = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primaryA, primaryB] }], {
    resultTarget: 2,
    maxNewPrimaryProducts: 1,
    referenceTimeMs: Date.parse(observedAt),
    search,
    enrich,
    ...callbacks,
  });
  const verdict = evaluateReportDraftQuality({
    comparison: base,
    comparisonTarget: 2,
    primaryDomain: "shop.test",
    primaryProducts: [primaryB],
    referenceTimeMs: Date.parse(observedAt),
  });
  assert.equal(verdict.status, "repair");
  assert.deepEqual(verdict.feedback.primaryProductIds, [primaryB.id]);
  assert.deepEqual(verdict.feedback.excludedRivalSourceUrls, [acceptedUrl]);

  const repairOptions = {
    resultTarget: 2,
    maxNewPrimaryProducts: 1,
    referenceTimeMs: Date.parse(observedAt),
    repairFeedback: verdict.feedback,
    search,
    enrich,
    ...callbacks,
  };
  const repaired = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primaryA, primaryB] }], repairOptions);
  const replay = await buildDirectProductSearchComparison("shop.test", [{ domain: "shop.test", products: [primaryA, primaryB] }], repairOptions);

  assert.equal(searches, 2);
  assert.equal(new Set(checkpointKeys).size, 2);
  assert.equal(repaired.coverage.assignedPairCount, 1);
  assert.equal(replay.coverage.assignedPairCount, 1);
  assert.deepEqual(repaired.rows.map((row) => row.primary.id), [primaryB.id]);
  assert.deepEqual(repaired.rows[0].matches.map((match) => match.product.sourceUrl), [freshUrl]);
});
