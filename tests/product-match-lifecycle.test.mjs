import test from "node:test";
import assert from "node:assert/strict";
import {
  compactPublishedProductComparisonCheckpoint,
  composeProductMatchAttempts,
  hasProductMatchCoverageDefect,
  limitPublishedProductComparison,
  MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY,
  mergePublishedProductComparisonState,
  mergePublishedProductComparisons,
  publishPricedProductComparison,
  shouldRetryProductMatch,
  upsertProductComparisonBlock,
} from "../app/lib/product-match-lifecycle.ts";
import { applyFinalProductEnrichment } from "../app/lib/product-intelligence.ts";
import { REPORT_CALLBACK_ENVELOPE_BYTES, REPORT_MATCH_CHECKPOINT_RESULT_BYTES } from "../src/shared/report-document-compaction.ts";

const TEST_NOW = new Date().toISOString();

function product(id, domain = "shop.test") {
  return {
    id,
    domain,
    name: id,
    normalizedName: id,
    description: "",
    category: "grocery",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://${domain}/products/${id}?country=US`,
    imageUrl: "",
    observedAt: TEST_NOW,
    claimIds: [`claim-${id}`],
  };
}

function row(id, rivalId = null) {
  return {
    primary: product(id),
    matches: [{
      domain: "rival.test",
      product: rivalId ? product(rivalId, "rival.test") : null,
      score: rivalId ? 0.9 : 0,
      confidence: rivalId ? "Medium" : null,
      sharedTerms: [],
      claimIds: [`claim-${id}`],
      decision: null,
    }],
  };
}

function comparison({ selected = ["p1", "p2"], assessed = selected, rows = selected.map((id) => row(id)), gaps = [], method = "ai-hybrid", available = true, accepted = 0 } = {}) {
  return {
    primaryDomain: "shop.test",
    marketCountryCode: "US",
    comparisonDomains: ["rival.test"],
    rows,
    unmatched: [],
    coverage: {
      primaryProductsAvailable: 20,
      primaryProductsScanned: 20,
      primaryProductFamiliesCompared: rows.length,
      competitorProductsAvailable: 20,
      competitorProductsScanned: 20,
      assignedPairCount: accepted,
      verifiedPairCount: accepted,
      rowsReturned: rows.length,
      rowLimit: 30,
      truncated: false,
    },
    matching: {
      method,
      available,
      model: "gpt-5.4-mini",
      embeddingModel: "text-embedding-3-small",
      promptVersion: "test",
      primaryProductsAssessed: assessed.length,
      candidatePairsAssessed: assessed.length * 2,
      retrievalPairsScored: assessed.length * 4,
      judgeCalls: 1,
      embeddingCalls: 1,
      durationMs: 100,
      gaps,
      selectedPrimaryIds: selected,
      assessedPrimaryIds: assessed,
      attempts: 1,
    },
  };
}

test("a defect-free thin AI result completes without a retry", () => {
  const thin = comparison({
    rows: [row("p1", "r1"), row("p2", "r2")],
    accepted: 2,
  });

  assert.equal(hasProductMatchCoverageDefect(thin), false);
  assert.equal(shouldRetryProductMatch(thin), false);
});

test("transport, unavailable semantic matching, gaps, and missing assessments trigger one retry gate", () => {
  assert.equal(shouldRetryProductMatch(null, true), true);
  assert.equal(shouldRetryProductMatch(comparison({ method: "lexical-fallback", available: false })), true);
  assert.equal(shouldRetryProductMatch(comparison({ gaps: ["deadline reached"] })), true);
  assert.equal(shouldRetryProductMatch(comparison({ selected: ["p1", "p2"], assessed: ["p1"] })), true);
});

test("an explicitly unconfigured matcher stays limited without wasting a retry", () => {
  const unconfigured = comparison({ method: "lexical-fallback", available: false, gaps: ["AI product matching is not configured; lexical matching was used."] });
  assert.equal(hasProductMatchCoverageDefect(unconfigured), true);
  assert.equal(shouldRetryProductMatch(unconfigured), false);
});

test("transport failure without a usable AI attempt strips the lexical baseline", () => {
  const baseline = comparison({ method: "lexical-fallback", available: false, rows: [row("p1", "lexical-rival")], accepted: 1 });

  const result = composeProductMatchAttempts(baseline, [], 2);

  assert.equal(result.rows[0].matches[0].product, null);
  assert.equal(result.coverage.assignedPairCount, 0);
});

test("an unavailable AI attempt is defensively stripped and records the request count", () => {
  const unsafeAttempt = comparison({ method: "lexical-fallback", available: false, rows: [row("p1", "stale-lexical")], accepted: 1 });

  const result = composeProductMatchAttempts(null, [unsafeAttempt], 2);

  assert.equal(result.rows[0].matches[0].product, null);
  assert.equal(result.coverage.assignedPairCount, 0);
  assert.equal(result.matching.attempts, 2);
});

test("AI no-match remains authoritative instead of restoring a lexical false positive", () => {
  const baseline = comparison({ method: "lexical-fallback", available: false, rows: [row("p1", "lexical-rival")], accepted: 1 });
  const ai = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1")], accepted: 0 });

  const result = composeProductMatchAttempts(baseline, [ai]);

  assert.equal(result.rows[0].matches[0].product, null);
  assert.equal(result.coverage.assignedPairCount, 0);
});

test("an unresolved primary never restores a lexical baseline pair", () => {
  const baseline = comparison({ method: "lexical-fallback", available: false, selected: ["p1", "p2"], assessed: [], rows: [row("p1", "lexical-1"), row("p2", "lexical-2")], accepted: 2 });
  const partial = comparison({ selected: ["p1", "p2"], assessed: ["p1"], rows: [row("p1", "ai-1"), row("p2")], gaps: ["AI product judging reached the report deadline for 1 primary product."], accepted: 1 });

  const result = composeProductMatchAttempts(baseline, [partial]);

  assert.equal(result.rows.find((item) => item.primary.id === "p1").matches[0].product.id, "ai-1");
  assert.equal(result.rows.find((item) => item.primary.id === "p2").matches[0].product, null);
  assert.equal(result.coverage.assignedPairCount, 1);
});

test("a retry fills only primaries the first attempt did not assess", () => {
  const baseline = comparison({ method: "lexical-fallback", available: false, selected: ["p1", "p2"], assessed: [], rows: [row("p1", "lexical-1"), row("p2", "lexical-2")], accepted: 2 });
  const first = comparison({ selected: ["p1", "p2"], assessed: ["p1"], rows: [row("p1"), row("p2", "lexical-2")], gaps: ["AI product judging reached the report deadline for 1 primary product."], accepted: 1 });
  const retry = comparison({ selected: ["p1", "p2"], assessed: ["p2"], rows: [row("p1", "invented-more"), row("p2", "ai-2")], gaps: ["AI product judging reached the report deadline for 1 primary product."], accepted: 2 });

  const result = composeProductMatchAttempts(baseline, [first, retry], 2);

  assert.equal(result.rows.find((item) => item.primary.id === "p1").matches[0].product, null);
  assert.equal(result.rows.find((item) => item.primary.id === "p2").matches[0].product.id, "ai-2");
  assert.deepEqual(result.matching.assessedPrimaryIds, ["p1", "p2"]);
  assert.equal(result.matching.attempts, 2);
  assert.equal(hasProductMatchCoverageDefect(result), false);
});

test("attempt preference is based on assessed coverage and gaps, never match count", () => {
  const broadNoMatch = comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows: [row("p1"), row("p2")], accepted: 0 });
  const narrowManyMatches = comparison({ selected: ["p1", "p2"], assessed: ["p1"], rows: [row("p1", "r1"), row("p2", "r2")], gaps: ["deadline reached"], accepted: 2 });

  const result = composeProductMatchAttempts(null, [narrowManyMatches, broadNoMatch]);

  assert.equal(result.rows.every((item) => item.matches[0].product === null), true);
  assert.equal(result.matching.gaps.length, 0);
});

test("comparison blocks are replaced or appended atomically", () => {
  const result = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1")], accepted: 0 });
  const without = { version: "1", generatedAt: "now", blocks: [{ type: "summary", id: "summary" }] };
  const appended = upsertProductComparisonBlock(without, result);
  assert.equal(appended.blocks.length, 2);
  assert.equal(appended.blocks[1].type, "product-comparison");

  const replaced = upsertProductComparisonBlock({ ...without, blocks: [...without.blocks, { type: "product-comparison", id: "old", rows: [] }] }, result);
  assert.equal(replaced.blocks.length, 2);
  assert.equal(replaced.blocks[1].id, "product-comparison");
  assert.equal(replaced.blocks[1].rows.length, 1);
});

test("the composed attempt count records a failed transport request before a successful retry", () => {
  const ai = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1")], accepted: 0 });
  const result = composeProductMatchAttempts(null, [ai], 2);
  assert.equal(result.matching.attempts, 2);
});

test("the final publication gate removes a rival whose enrichment replaces its price with an invalid signal", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].primary.priceSignals = [{ raw: "GBP 10", currency: "GBP", amount: 10 }];
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "GBP 8", currency: "GBP", amount: 8 }];
  const invalidFresh = { ...candidate.rows[0].matches[0].product, priceSignals: [{ raw: "GBP 0", currency: "GBP", amount: 0 }], observedAt: "2026-08-07T00:00:00.000Z" };
  const enriched = applyFinalProductEnrichment(candidate, [invalidFresh], { pagesRequested: 1, pagesFetched: 1, maxPages: 64, gaps: [] });
  const published = publishPricedProductComparison(enriched);

  assert.equal(enriched.rows[0].matches[0].product.priceSignals[0].amount, 0);
  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.coverage.assignedPairCount, 0);
  assert.equal(published.matching.publication.suppressedAcceptedPairs, 1);
  assert.equal(published.matching.publication.reasons["missing-valid-rival-price"], 1);
});

test("the final publication gate requires a valid observed primary price", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  candidate.rows[0].matches[0].assessment = { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.9, model: "test", promptVersion: "test", reasons: ["same product"], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "", primarySourceUrl: candidate.rows[0].primary.sourceUrl, rivalSourceUrl: candidate.rows[0].matches[0].product.sourceUrl };

  const published = publishPricedProductComparison(candidate);

  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].excludedProduct.id, "r1");
  assert.equal(published.rows[0].matches[0].assessment.verdict, "same_product");
  assert.deepEqual(published.rows[0].matches[0].publication, { priceEligible: false, reason: "missing-valid-primary-price" });
  assert.equal(published.matching.publication.reasons["missing-valid-primary-price"], 1);
});

test("direct search publishes every priced result and omits empty or zero-price results entirely", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "priced")], accepted: 3, method: "direct-web-search" });
  const primary = candidate.rows[0].primary;
  const priced = candidate.rows[0].matches[0];
  const empty = { ...priced, product: product("empty", "rival.test") };
  const zero = { ...priced, product: product("zero", "rival.test") };
  primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  priced.product.priceSignals = [{ raw: "GBP 8", currency: "GBP", amount: 8 }];
  zero.product.priceSignals = [{ raw: "USD 0", currency: "USD", amount: 0 }];
  candidate.rows[0].matches = [priced, empty, zero];

  const published = publishPricedProductComparison(candidate);

  assert.deepEqual(published.rows[0].matches.map((match) => match.product.id), ["priced"]);
  assert.equal(published.rows[0].matches[0].publication.priceEligible, true);
  assert.equal(published.coverage.assignedPairCount, 1);
  assert.equal(published.matching.publication.reasons["missing-valid-rival-price"], 2);
  assert.ok(published.rows[0].matches.every((match) => !match.excludedProduct));
});

test("the final publication gate excludes cross-currency product prices without FX conversion", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "GBP 100", currency: "GBP", amount: 100 }];

  const published = publishPricedProductComparison(candidate);

  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].excludedProduct.id, "r1");
  assert.deepEqual(published.rows[0].matches[0].publication, { priceEligible: false, reason: "incompatible-price-currency" });
  assert.equal(published.matching.publication.reasons["incompatible-price-currency"], 1);
});

test("the final publication gate excludes explicit cross-market locale prices", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.sourceUrl = "https://shop.test/en-us/products/p1";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/en-sg/products/r1";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  const published = publishPricedProductComparison(candidate);
  assert.equal(published.rows[0].matches[0].product, null);
  assert.deepEqual(published.rows[0].matches[0].publication, { priceEligible: false, reason: "incompatible-market" });
  assert.equal(published.matching.publication.reasons["incompatible-market"], 1);
});

test("the final publication gate excludes a country-domain rival outside the report market", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.domain = "rival.co.uk";
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.co.uk/products/r1";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  const published = publishPricedProductComparison(candidate);
  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate excludes a query-selected regional rival outside the report market", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.sourceUrl = "https://shop.test/products/p1?country=US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/products/r1?country=GB";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  const published = publishPricedProductComparison(candidate);
  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate rejects conflicting repeated market selectors", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/products/r1?country=US&country=GB";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate rejects conflicting country selectors across query keys", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.sourceUrl = "https://shop.test/products/p1?country=US&currency=USD";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/products/r1?country=US&locale=en-GB&currency=USD";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate excludes a country-path rival outside the report market", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.sourceUrl = "https://shop.test/us/products/p1";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/sg/products/r1";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate rejects an unknown genericized country TLD for a known market", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.domain = "rival.la";
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.la/products/r1";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate rejects a region grouping without country proof", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/en-eu/products/r1?region=EU";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate keeps complete same-currency observations", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];

  const published = publishPricedProductComparison(candidate);

  assert.equal(published.rows[0].matches[0].product.id, "r1");
  assert.deepEqual(published.rows[0].matches[0].publication, { priceEligible: true });
  assert.equal(published.matching.publication.suppressedAcceptedPairs, 0);
  assert.deepEqual(published.matching.publication.reasons, {});
});

test("the final publication gate rejects currency evidence that contradicts its source selector or raw price", () => {
  const sourceConflict = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  sourceConflict.marketCountryCode = "US";
  sourceConflict.rows[0].primary.sourceUrl = "https://shop.test/products/honey?country=US&currency=CAD";
  sourceConflict.rows[0].matches[0].product.sourceUrl = "https://rival.test/products/honey?country=US&currency=CAD";
  sourceConflict.rows[0].primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  sourceConflict.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  assert.equal(publishPricedProductComparison(sourceConflict).coverage.assignedPairCount, 0);

  const rawConflict = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  rawConflict.marketCountryCode = "US";
  rawConflict.rows[0].primary.sourceUrl = "https://shop.test/products/honey?country=US&currency=USD";
  rawConflict.rows[0].matches[0].product.sourceUrl = "https://rival.test/products/honey?country=US&currency=USD";
  rawConflict.rows[0].primary.priceSignals = [{ raw: "CAD 10", currency: "USD", amount: 10 }];
  rawConflict.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  assert.equal(publishPricedProductComparison(rawConflict).coverage.assignedPairCount, 0);
});

test("the final publication gate rejects structured amounts that contradict raw price evidence", () => {
  for (const mismatchedSide of ["primary", "rival"]) {
    const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
    candidate.rows[0].primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: mismatchedSide === "primary" ? 999 : 10 }];
    candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: mismatchedSide === "rival" ? 1 : 8 }];
    assert.equal(publishPricedProductComparison(candidate).coverage.assignedPairCount, 0, mismatchedSide);
  }
});

test("publication freshness is stable against the report observation timestamp", () => {
  const primary = { ...product("p1"), observedAt: "2025-08-01T00:00:00.000Z", priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }] };
  const rival = { ...product("r1", "rival.test"), observedAt: "2025-08-01T00:00:00.000Z", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
  const input = comparison({ selected: ["p1"], assessed: ["p1"], rows: [{ primary, matches: [{ domain: rival.domain, product: rival, score: 0.95, confidence: "Medium", sharedTerms: [], claimIds: [], assessment: { verdict: "same_product", priceComparable: true, reasons: [], contradictions: [], claimType: "Inferred" }, decision: null }] }], accepted: 1 });

  const published = publishPricedProductComparison(input, Date.parse("2025-08-02T00:00:00.000Z"));
  assert.equal(published.rows[0].matches[0].publication.priceEligible, true);
});

function pricedPairRow(primaryName, primaryId, rivalIds) {
  const primary = product(primaryId);
  primary.name = primaryName;
  primary.normalizedName = primaryName.toLowerCase();
  primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  return {
    primary,
    matches: rivalIds.map((rivalId, index) => {
      const rival = product(rivalId, "rival.test");
      rival.priceSignals = [{ raw: `USD ${8 + index}`, currency: "USD", amount: 8 + index }];
      return { domain: rival.domain, product: rival, score: 0.99 - (index / 100), confidence: "Medium", sharedTerms: [], claimIds: [], decision: null };
    }),
  };
}

test("pair targets exhaust alphabetically ordered primaries and retain several rivals per product", () => {
  const rows = [
    pricedPairRow("Blueberry Jam", "blueberry", ["blue-1", "blue-2", "blue-3"]),
    pricedPairRow("Apricot Jam", "apricot", ["apricot-1", "apricot-2", "apricot-3"]),
  ];
  const selected = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(comparison({ selected, assessed: selected, rows, accepted: 6 }), null, 4, Date.now(), "pairs");

  assert.equal(state.comparison.coverage.assignedPairCount, 4);
  assert.equal(state.comparison.matching.publishedPairs, 4);
  assert.equal(state.comparison.matching.publishedPrimaryProducts, 2);
  assert.equal(state.comparison.coverage.truncated, false);
  assert.deepEqual(state.comparison.rows.map((item) => [item.primary.name, item.matches.length]), [["Apricot Jam", 3], ["Blueberry Jam", 1]]);
});

test("pair publication is deterministic when input rows and rivals are shuffled", () => {
  const apricot = pricedPairRow("Apricot Jam", "apricot", ["apricot-1", "apricot-2", "apricot-3"]);
  const blueberry = pricedPairRow("Blueberry Jam", "blueberry", ["blue-1", "blue-2", "blue-3"]);
  const selected = ["apricot", "blueberry"];
  const first = mergePublishedProductComparisonState(comparison({ selected, assessed: selected, rows: [blueberry, apricot], accepted: 6 }), null, 4, Date.now(), "pairs").comparison;
  const shuffled = structuredClone([apricot, blueberry]);
  shuffled.forEach((item) => item.matches.reverse());
  const second = mergePublishedProductComparisonState(comparison({ selected, assessed: selected, rows: shuffled, accepted: 6 }), null, 4, Date.now(), "pairs").comparison;

  assert.deepEqual(second.rows.map((item) => [item.primary.id, item.matches.map((match) => match.product.id)]), first.rows.map((item) => [item.primary.id, item.matches.map((match) => match.product.id)]));
});

test("every plan target is measured in valid published pairs rather than rows", () => {
  const rows = Array.from({ length: 50 }, (_, primaryIndex) => pricedPairRow(
    `Product ${String(primaryIndex).padStart(2, "0")}`,
    `primary-${primaryIndex}`,
    Array.from({ length: 20 }, (_, rivalIndex) => `rival-${primaryIndex}-${rivalIndex}`),
  ));
  const selected = rows.map((item) => item.primary.id);
  const source = comparison({ selected, assessed: selected, rows, accepted: 1_000 });

  for (const target of [20, 50, 500, 1_000]) {
    const result = mergePublishedProductComparisonState(source, null, target, Date.now(), "pairs").comparison;
    assert.equal(result.coverage.assignedPairCount, target);
    assert.equal(result.matching.publishedPairs, target);
    assert.equal(result.matching.resultShortfall, 0);
  }
});

test("pair checkpoint evidence stays within the target row bound when surplus primaries are available", () => {
  const rows = Array.from({ length: 5 }, (_, index) => pricedPairRow(
    `Product ${String(index).padStart(2, "0")}`,
    `primary-${index}`,
    [`rival-${index}`],
  ));
  const selected = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(
    comparison({ selected, assessed: selected, rows, accepted: rows.length }),
    null,
    2,
    Date.now(),
    "pairs",
  );

  assert.equal(state.comparison.coverage.assignedPairCount, 2);
  assert.equal(state.evidence.rows.length, 2);
  assert.deepEqual(state.evidence.rows.map((item) => item.primary.id), ["primary-0", "primary-1"]);
});

test("pair checkpoint evidence prioritizes every selected row over intermediate alias-only backups", () => {
  const first = pricedPairRow("A Product", "a", ["shared-rival"]);
  const aliasOnly = pricedPairRow("B Product", "b", ["shared-rival"]);
  const last = pricedPairRow("C Product", "c", ["c-rival"]);
  const rows = [first, aliasOnly, last];
  const selected = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(
    comparison({ selected, assessed: selected, rows, accepted: 3 }),
    null,
    2,
    Date.now(),
    "pairs",
  );

  assert.deepEqual(state.comparison.rows.map((item) => item.primary.id), ["a", "c"]);
  assert.deepEqual(state.evidence.rows.map((item) => item.primary.id), ["a", "c"]);
  assert.equal(state.evidence.coverage.assignedPairCount, 2);
});

test("pair evidence byte-budget fallback retains every selected edge and removes surplus backup rows", () => {
  const longPath = "x".repeat(1_700);
  const rows = Array.from({ length: 1_000 }, (_, primaryIndex) => {
    const item = pricedPairRow(
      `Oversized Product ${String(primaryIndex).padStart(4, "0")}`,
      `oversized-primary-${primaryIndex}`,
      [`oversized-rival-${primaryIndex}-a`, `oversized-rival-${primaryIndex}-b`],
    );
    item.primary.sourceUrl = `https://shop.test/products/${primaryIndex}/${longPath}?country=US`;
    item.matches.forEach((match, rivalIndex) => {
      match.product.sourceUrl = `https://rival.test/products/${primaryIndex}/${rivalIndex}/${longPath}?country=US`;
    });
    return item;
  });
  const selected = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(
    comparison({ selected, assessed: selected, rows, accepted: 2_000 }),
    null,
    1_000,
    Date.now(),
    "pairs",
  );

  assert.equal(state.comparison.coverage.assignedPairCount, 1_000);
  assert.equal(state.evidence.coverage.assignedPairCount, 1_000);
  assert.equal(state.evidence.rows.length, 500);
  assert.ok(state.evidence.rows.every((item) => item.matches.length === 2));
});

test("priced result backfill exposes exactly the requested number of publishable products", () => {
  const rows = Array.from({ length: 4 }, (_, index) => row(`p${index}`, `r${index}`));
  for (const [index, item] of rows.entries()) {
    item.primary.priceSignals = [{ raw: `USD ${10 + index}`, currency: "USD", amount: 10 + index }];
    item.matches[0].product.priceSignals = [{ raw: `USD ${8 + index}`, currency: "USD", amount: 8 + index }];
    item.matches[0].assessment = { method: "ai-hybrid", claimType: "Inferred", verdict: index < 2 ? "same_product" : "close_substitute", confidence: 0.9, model: "test", promptVersion: "test", reasons: ["same"], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "", primarySourceUrl: item.primary.sourceUrl, rivalSourceUrl: item.matches[0].product.sourceUrl };
  }
  const screened = comparison({ selected: rows.map((item) => item.primary.id), assessed: rows.map((item) => item.primary.id), rows, accepted: 4 });
  const result = limitPublishedProductComparison(publishPricedProductComparison(screened), 2);

  assert.equal(result.rows.length, 2);
  assert.equal(result.coverage.assignedPairCount, 2);
  assert.equal(result.matching.primaryProductsScreened, 4);
  assert.equal(result.matching.primaryProductsAssessed, 4);
  assert.equal(result.matching.publishedPrimaryProducts, 2);
  assert.equal(result.matching.resultTarget, 2);
  assert.equal(result.matching.resultShortfall, 0);
  assert.equal(result.matching.gaps.length, 0);
  assert.deepEqual(result.matching.assessedPrimaryIds, rows.map((item) => item.primary.id));
});

test("priced result backfill accumulates distinct publishable products across discovery waves", () => {
  const pricedRow = (primaryId, rivalId) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const prior = comparison({ selected: ["p1"], assessed: ["p1"], rows: [pricedRow("p1", "r1")], accepted: 1 });
  const current = comparison({ selected: ["p2"], assessed: ["p2"], rows: [pricedRow("p2", "r2")], accepted: 1 });
  const result = mergePublishedProductComparisons(current, limitPublishedProductComparison(publishPricedProductComparison(prior), 2), 2);

  assert.deepEqual(result.rows.map((item) => item.primary.id).sort(), ["p1", "p2"]);
  assert.equal(result.matching.publishedPrimaryProducts, 2);
  assert.equal(result.matching.resultShortfall, 0);
});

test("priced result backfill never counts the same rival offering twice across discovery waves", () => {
  const pricedRow = (primaryId, rivalId) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const prior = comparison({ selected: ["p1"], assessed: ["p1"], rows: [pricedRow("p1", "shared-rival")], accepted: 1 });
  const current = comparison({ selected: ["p2"], assessed: ["p2"], rows: [pricedRow("p2", "shared-rival")], accepted: 1 });
  const result = mergePublishedProductComparisons(current, limitPublishedProductComparison(publishPricedProductComparison(prior), 2), 2);

  assert.equal(result.rows.length, 1);
  assert.equal(result.matching.publishedPrimaryProducts, 1);
  assert.equal(result.matching.resultShortfall, 1);
  assert.equal(new Set(result.rows.flatMap((item) => item.matches.flatMap((match) => match.product ? [match.product.id] : []))).size, 1);
});

test("priced result backfill keeps historical alternatives when a primary is observed again", () => {
  const pricedRow = (primaryId, rivalId) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const prior = comparison({ selected: ["p1"], assessed: ["p1"], rows: [pricedRow("p1", "r-old")], accepted: 1 });
  const current = comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows: [pricedRow("p1", "r-shared"), pricedRow("p2", "r-shared")], accepted: 2 });
  const result = mergePublishedProductComparisons(current, limitPublishedProductComparison(publishPricedProductComparison(prior), 2), 2);

  assert.equal(result.rows.length, 2);
  assert.equal(result.matching.publishedPrimaryProducts, 2);
  assert.equal(result.matching.resultShortfall, 0);
  assert.deepEqual(new Set(result.rows.flatMap((item) => item.matches.flatMap((match) => match.product ? [match.product.id] : []))), new Set(["r-old", "r-shared"]));
});

test("published backfill never inherits a historical rival across a reused primary id", () => {
  const priced = (primaryName, primaryUrl, rivalId) => {
    const item = row("reused-id", rivalId);
    item.primary.name = primaryName;
    item.primary.normalizedName = primaryName.toLowerCase();
    item.primary.sourceUrl = primaryUrl;
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const prior = comparison({ selected: ["reused-id"], assessed: ["reused-id"], rows: [priced("Old Honey 500g", "https://shop.test/products/old-honey?country=US", "old-honey-rival")], accepted: 1 });
  const current = comparison({ selected: ["reused-id"], assessed: ["reused-id"], rows: [priced("New Coffee 1kg", "https://shop.test/products/new-coffee?country=US", "new-coffee-rival")], accepted: 1 });
  const merged = mergePublishedProductComparisonState(current, prior, 1);
  assert.deepEqual(merged.comparison.rows.flatMap((item) => item.matches.flatMap((match) => match.product ? [match.product.id] : [])), ["new-coffee-rival"]);

  const unpricedCurrent = structuredClone(current);
  unpricedCurrent.rows[0].matches[0].product.priceSignals = [];
  const withoutCurrentPrice = mergePublishedProductComparisonState(unpricedCurrent, prior, 1);
  assert.equal(withoutCurrentPrice.comparison.rows.length, 0);
});

test("durable priced evidence preserves backup rivals until a later global assignment", () => {
  const pricedRow = (primaryId, rivalId, score = 0.9) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    item.matches[0].score = score;
    return item;
  };
  const firstRow = pricedRow("p1", "r-shared", 0.99);
  firstRow.matches.push(pricedRow("p1", "r-backup", 0.9).matches[0]);
  const first = mergePublishedProductComparisonState(comparison({ selected: ["p1"], assessed: ["p1"], rows: [firstRow], accepted: 2 }), null, 2);
  assert.equal(first.comparison.rows.length, 1);
  assert.equal(first.evidence.rows[0].matches.length, 2);

  const second = mergePublishedProductComparisonState(comparison({ selected: ["p2"], assessed: ["p2"], rows: [pricedRow("p2", "r-shared", 0.95)], accepted: 1 }), first.evidence, 2);
  assert.equal(second.comparison.rows.length, 2);
  assert.equal(second.comparison.matching.publishedPrimaryProducts, 2);
  assert.deepEqual(new Set(second.comparison.rows.flatMap((item) => item.matches.flatMap((match) => match.product ? [match.product.id] : []))), new Set(["r-shared", "r-backup"]));
});

test("checkpoint compaction preserves the late edge required by a 20-row augmenting path", () => {
  const legalId = (prefix) => `${prefix}-${"i".repeat(Math.max(0, 299 - prefix.length))}`.slice(0, 300);
  const legalUrl = (domain, prefix) => {
    const head = `https://${domain}/products/${prefix}/`;
    const tail = "?country=US";
    return `${head}${"x".repeat(2_000 - head.length - tail.length)}${tail}`;
  };
  const priced = (primaryId, rivalId, rivalIndex) => {
    const item = row(legalId(primaryId), legalId(rivalId));
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.primary.sourceUrl = legalUrl("shop.test", primaryId);
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    item.matches[0].product.sourceUrl = legalUrl("rival.test", rivalId);
    item.matches[0].score = 1 - (rivalIndex / 1_000);
    return item;
  };
  const first = priced("p00", "r00", 0);
  first.matches = Array.from({ length: 20 }, (_, index) => priced("p00", `r${String(index).padStart(2, "0")}`, index).matches[0]);
  const rows = [first, ...Array.from({ length: 19 }, (_, index) => priced(
    `p${String(index + 1).padStart(2, "0")}`,
    `r${String(index).padStart(2, "0")}`,
    0,
  ))];
  const selected = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(comparison({ selected, assessed: selected, rows, accepted: 39 }), null, 20);
  const checkpoint = compactPublishedProductComparisonCheckpoint(state.evidence);
  const recovered = mergePublishedProductComparisonState(checkpoint, null, 20);

  assert.equal(state.comparison.rows.length, 20);
  assert.equal(checkpoint.rows.find((item) => item.primary.id === legalId("p00")).matches.length, 20);
  assert.equal(recovered.comparison.rows.length, 20);
  assert.ok(recovered.comparison.rows.some((item) => item.matches.some((match) => match.product?.id === legalId("r19"))));
});

test("maximum-size durable evidence preserves the rival needed when the twentieth row arrives", () => {
  const legalId = (prefix) => `${prefix}-${"i".repeat(Math.max(0, 299 - prefix.length))}`.slice(0, 300);
  const legalUrl = (domain, prefix) => {
    const head = `https://${domain}/products/${prefix}/`;
    const tail = "?country=US";
    return `${head}${"x".repeat(2_000 - head.length - tail.length)}${tail}`;
  };
  const priced = (primaryIndex, rivalIndex) => {
    const item = row(legalId(`p${primaryIndex}`), legalId(`r${rivalIndex}`));
    item.primary.sourceUrl = legalUrl("shop.test", `p${primaryIndex}`);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.sourceUrl = legalUrl("rival.test", `r${rivalIndex}`);
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    item.matches[0].score = 1 - (rivalIndex / 1_000);
    return item;
  };
  const firstRows = Array.from({ length: 19 }, (_, primaryIndex) => {
    const item = priced(primaryIndex, 0);
    item.matches = Array.from({ length: 20 }, (_, rivalIndex) => priced(primaryIndex, rivalIndex).matches[0]);
    return item;
  });
  const firstIds = firstRows.map((item) => item.primary.id);
  const first = mergePublishedProductComparisonState(comparison({ selected: firstIds, assessed: firstIds, rows: firstRows, accepted: 380 }), null, 20);
  const checkpoint = compactPublishedProductComparisonCheckpoint(first.evidence);
  const twentieth = priced(19, 0);
  const second = mergePublishedProductComparisonState(comparison({ selected: [twentieth.primary.id], assessed: [twentieth.primary.id], rows: [twentieth], accepted: 1 }), checkpoint, 20);

  assert.ok(checkpoint.rows.some((item) => item.matches.some((match) => match.product?.id === legalId("r19"))), JSON.stringify(checkpoint.rows.map((item) => item.matches.length)));
  assert.equal(second.comparison.rows.length, 20);
});

test("maximum legal compact fields preserve twenty alternatives for every target row", () => {
  const legalId = (prefix) => `${prefix}-${"i".repeat(Math.max(0, 299 - prefix.length))}`.slice(0, 300);
  const legalUrl = (prefix) => {
    const head = `https://rival.test/products/${prefix}/`;
    const tail = "?country=US";
    return `${head}${"x".repeat(2_000 - head.length - tail.length)}${tail}`;
  };
  const validGtin = (seed) => {
    const body = String(seed).padStart(13, "0").slice(-13);
    let sum = 0;
    for (let index = body.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) sum += Number(body[index]) * weight;
    return `${body}${(10 - (sum % 10)) % 10}`;
  };
  const rows = Array.from({ length: 20 }, (_, primaryIndex) => {
    const item = row(legalId(`p${primaryIndex}`));
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches = Array.from({ length: 20 }, (_, rivalIndex) => {
      const match = row(item.primary.id, legalId(`r${primaryIndex}-${rivalIndex}`)).matches[0];
      match.product.name = `Rival ${primaryIndex}-${rivalIndex} ${"n".repeat(220)}`;
      match.product.sourceUrl = legalUrl(`${primaryIndex}-${rivalIndex}`);
      match.product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
      match.product.identifiers = { gtins: Array.from({ length: 20 }, (_, gtinIndex) => validGtin(1 + (primaryIndex * 400) + (rivalIndex * 20) + gtinIndex)) };
      match.product.identifiers.sku = "s".repeat(100);
      match.product.identifiers.mpn = "m".repeat(100);
      match.product.identifiers.brand = "b".repeat(100);
      match.product.quantity = { kind: "mass", amount: 500, unit: "g" };
      match.product.assignmentComponentHash = String(primaryIndex * 20 + rivalIndex).padStart(64, "a").slice(-64);
      match.score = 1 - (rivalIndex / 1_000);
      return match;
    });
    return item;
  });
  const ids = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(comparison({ selected: ids, assessed: ids, rows, accepted: 400 }), null, 20);
  const checkpoint = { version: 3, comparison: compactPublishedProductComparisonCheckpoint(state.comparison), evidence: compactPublishedProductComparisonCheckpoint(state.evidence) };

  assert.equal(state.comparison.rows.length, 20);
  assert.deepEqual(state.evidence.rows.map((item) => item.matches.length), Array(20).fill(20));
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), "utf8") <= REPORT_MATCH_CHECKPOINT_RESULT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ action: "match-batch-checkpoint-save", attemptNumber: 20, batchIndex: 3_999, inputHash: "a".repeat(64), result: checkpoint }), "utf8") < REPORT_CALLBACK_ENVELOPE_BYTES);
});

test("global assignment counts a merchant product id only once when its URL and name drift", () => {
  const pricedRow = (primaryId, rivalName, rivalUrl) => {
    const item = row(primaryId, "merchant-product-id");
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.name = rivalName;
    item.matches[0].product.normalizedName = rivalName.toLowerCase();
    item.matches[0].product.sourceUrl = rivalUrl;
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const rows = [
    pricedRow("p1", "Honey 500g", "https://rival.test/products/honey-500g?country=US"),
    pricedRow("p2", "Raw Honey 500g", "https://rival.test/products/raw-honey-500g?country=US"),
  ];

  const state = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows, accepted: 2 }), null, 2);

  assert.equal(state.comparison.rows.length, 1);
  assert.equal(state.comparison.matching.publishedPrimaryProducts, 1);
  assert.equal(state.comparison.matching.resultShortfall, 1);
});

test("global assignment counts one canonical rival source only once when ids and names drift", () => {
  const pricedRow = (primaryId, rivalId, rivalName) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.name = rivalName;
    item.matches[0].product.normalizedName = rivalName.toLowerCase();
    item.matches[0].product.sourceUrl = "https://rival.test/products/shared-widget?country=US";
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const rows = [pricedRow("p1", "r1", "Widget Original"), pricedRow("p2", "r2", "Widget Renamed")];

  const state = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows, accepted: 2 }), null, 2);

  assert.equal(state.comparison.rows.length, 1);
  assert.equal(state.comparison.matching.resultShortfall, 1);
});

test("global assignment counts one shop-route rival source only once when ids and names drift", () => {
  const pricedRow = (primaryId, rivalId, rivalName, route) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.name = rivalName;
    item.matches[0].product.normalizedName = rivalName.toLowerCase();
    item.matches[0].product.sourceUrl = `https://rival.test/${route}/shared-widget?country=US`;
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const rows = [pricedRow("p1", "r1", "Widget Original", "us/products"), pricedRow("p2", "r2", "Widget Renamed", "store/us/products")];
  const state = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows, accepted: 2 }), null, 2);

  assert.equal(state.comparison.rows.length, 1);
  assert.equal(mergePublishedProductComparisonState(JSON.parse(JSON.stringify(state.evidence)), null, 2).comparison.rows.length, 1);
});

test("global assignment keeps a product slug named store distinct from its parent product", () => {
  const pricedRow = (primaryId, rivalId, sourceUrl) => {
    const item = row(primaryId, rivalId);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.sourceUrl = sourceUrl;
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const rows = [
    pricedRow("p1", "r1", "https://rival.test/products/store/widget?country=US"),
    pricedRow("p2", "r2", "https://rival.test/products/widget?country=US"),
  ];
  const state = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows, accepted: 2 }), null, 2);

  assert.equal(state.comparison.rows.length, 2);
});

test("global assignment and compact recovery count a rival once when observations share the ninth GTIN", () => {
  const validGtin = (seed) => {
    const body = String(seed).padStart(13, "0").slice(-13);
    let sum = 0;
    for (let index = body.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) sum += Number(body[index]) * weight;
    return `${body}${(10 - (sum % 10)) % 10}`;
  };
  const bridge = validGtin(9);
  const rows = Array.from({ length: 20 }, (_, index) => {
    const item = row(`p${index}`, `r${index}`);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.sourceUrl = `https://rival.test/products/r${index}?country=US`;
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    item.matches[0].product.identifiers = { gtins: index === 0
      ? Array.from({ length: 9 }, (_, gtinIndex) => validGtin(gtinIndex + 1))
      : index === 1 ? [bridge] : [] };
    return item;
  });
  const ids = rows.map((item) => item.primary.id);
  const live = mergePublishedProductComparisonState(comparison({ selected: ids, assessed: ids, rows, accepted: 20 }), null, 20);

  assert.equal(live.comparison.rows.length, 19);
  const checkpoint = JSON.parse(JSON.stringify(compactPublishedProductComparisonCheckpoint(live.evidence)));
  assert.equal(checkpoint.rows[0].matches[0].product.identifiers.gtins.length, 9);
  assert.equal(mergePublishedProductComparisonState(checkpoint, null, 20).comparison.rows.length, 19);
});

test("global assignment is invariant to equivalent primary row ordering", () => {
  const pricedRow = (primaryId) => {
    const item = row(primaryId, "shared-rival");
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  };
  const rows = [pricedRow("p2"), pricedRow("p1")];
  const forward = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows, accepted: 2 }), null, 2);
  const reverse = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows: [...rows].reverse(), accepted: 2 }), null, 2);

  assert.deepEqual(forward.comparison.rows.map((item) => item.primary.id), reverse.comparison.rows.map((item) => item.primary.id));
  assert.deepEqual(forward.comparison.rows.map((item) => item.primary.id), ["p1"]);
});

test("durable priced evidence stays below the checkpoint limit for a legal 6000-pair universe", () => {
  const legalUrl = (domain, role, primaryIndex, rivalIndex = 0) => `https://${domain}/${role}/${primaryIndex}/${rivalIndex}/${"x".repeat(900)}?country=US`;
  const rows = Array.from({ length: 20 }, (_, primaryIndex) => {
    const item = row(`p${primaryIndex + 1}`, `r${primaryIndex + 1}-1`);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.primary.description = "p".repeat(500);
    item.primary.attributes = Array.from({ length: 8 }, () => "a".repeat(100));
    item.primary.sourceUrl = legalUrl("shop.test", "primary", primaryIndex);
    item.matches = Array.from({ length: 300 }, (_, rivalIndex) => {
      const match = row(item.primary.id, `r${primaryIndex + 1}-${rivalIndex + 1}`).matches[0];
      match.product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
      match.product.description = "r".repeat(500);
      match.product.attributes = Array.from({ length: 8 }, () => "b".repeat(100));
      match.product.sourceUrl = legalUrl("rival.test", "rival", primaryIndex, rivalIndex);
      match.assessment = { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.99, model: "test", promptVersion: "v1", reasons: ["r".repeat(500)], contradictions: [], normalizedCategory: "food", normalizedVariant: "standard", normalizedSize: "1kg", primarySourceUrl: item.primary.sourceUrl, rivalSourceUrl: match.product.sourceUrl };
      match.score = 1 - (rivalIndex / 10_000);
      return match;
    });
    return item;
  });
  const ids = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(comparison({ selected: ids, assessed: ids, rows, accepted: 6_000 }), null, 20);
  state.evidence.enrichment = {
    pagesRequested: 7_000,
    pagesFetched: 7_000,
    maxPages: 7_000,
    gaps: Array.from({ length: 7_000 }, (_, index) => ({ url: `https://rival.test/missing/${index}`, reason: "Terminal HTTP 404 product-page outcome" })),
  };
  const checkpoint = { version: 3, comparison: compactPublishedProductComparisonCheckpoint(state.comparison), evidence: compactPublishedProductComparisonCheckpoint(state.evidence) };

  assert.equal(state.evidence.rows.length, 20);
  assert.ok(state.evidence.rows.every((item) => item.matches.length === MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY));
  assert.ok(state.evidence.rows.every((item) => item.matches.some((match) => match.product?.sourceUrl.startsWith("https://rival.test/rival/"))));
  assert.ok(checkpoint.evidence.rows.every((item) => item.matches.length === MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY));
  assert.equal(checkpoint.evidence.enrichment.gaps.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), "utf8") < REPORT_CALLBACK_ENVELOPE_BYTES - 100_000);
});

test("durable publication and evidence remain capped at twenty rows for legacy larger targets", () => {
  const rows = Array.from({ length: 50 }, (_, index) => {
    const item = row(`legacy-p${index}`, `legacy-r${index}`);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  });
  const ids = rows.map((item) => item.primary.id);
  const state = mergePublishedProductComparisonState(comparison({ selected: ids, assessed: ids, rows, accepted: 50 }), null, 1_000);

  assert.equal(state.comparison.rows.length, 20);
  assert.equal(state.evidence.rows.length, 20);
});

test("a later unpriced observation does not evict an earlier valid priced comparison", () => {
  const priorRow = row("p1", "r1");
  priorRow.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  priorRow.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const prior = limitPublishedProductComparison(publishPricedProductComparison(comparison({ selected: ["p1"], assessed: ["p1"], rows: [priorRow], accepted: 1 })), 1);
  const current = publishPricedProductComparison(comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "new-unpriced")], accepted: 1 }));
  const result = mergePublishedProductComparisons(current, prior, 1);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].matches.find((match) => match.product)?.product.id, "r1");
});

test("compact recovery preserves exact-product priority over a higher-scored substitute", () => {
  const candidateRow = row("p1", "r-exact");
  candidateRow.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  candidateRow.matches[0].score = 0.8;
  candidateRow.matches[0].assessment = { verdict: "same_product" };
  candidateRow.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const substitute = structuredClone(candidateRow.matches[0]);
  substitute.product = product("r-close", "rival.test");
  substitute.product.priceSignals = [{ raw: "USD 7", currency: "USD", amount: 7 }];
  substitute.score = 0.9;
  substitute.assessment = { verdict: "close_substitute" };
  candidateRow.matches.push(substitute);
  const screened = comparison({ selected: ["p1"], assessed: ["p1"], rows: [candidateRow], accepted: 2 });

  const rich = mergePublishedProductComparisonState(screened, null, 1);
  assert.equal(rich.comparison.rows[0].matches.find((match) => match.product)?.product.id, "r-exact");
  const checkpoint = JSON.parse(JSON.stringify(compactPublishedProductComparisonCheckpoint(rich.evidence)));
  const recovered = mergePublishedProductComparisonState(checkpoint, null, 1);

  assert.equal(recovered.comparison.rows[0].matches.find((match) => match.product)?.product.id, "r-exact");
});

test("global alias collapse retains the twenty-first raw edge required for twenty rows", () => {
  const primaryRow = row("p-main");
  primaryRow.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  primaryRow.matches = Array.from({ length: 21 }, (_, index) => {
    const rival = product(index === 20 ? "late-unique" : `alias-${index}`, "rival.test");
    rival.sourceUrl = `https://rival.test/products/${index === 20 ? "late-unique" : `source-${index}`}?country=US`;
    rival.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return { domain: rival.domain, product: rival, score: index === 20 ? 0.5 : 0.99 - (index / 1_000), confidence: "Medium", sharedTerms: [], claimIds: [], decision: null };
  });
  const connectorRows = Array.from({ length: 20 }, (_, index) => {
    const item = row(`p-connector-${index}`, "shared-alias");
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.sourceUrl = `https://rival.test/products/source-${index}?country=US`;
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  });
  const uniqueRows = Array.from({ length: 18 }, (_, index) => {
    const item = row(`p-unique-${index}`, `r-unique-${index}`);
    item.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    item.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    return item;
  });
  const rows = [primaryRow, ...connectorRows, ...uniqueRows];
  const ids = rows.map((item) => item.primary.id);
  const screened = comparison({ selected: ids, assessed: ids, rows, accepted: rows.length });

  const result = mergePublishedProductComparisonState(screened, null, 20);

  assert.equal(result.comparison.rows.length, 20);
  assert.equal(result.comparison.rows.find((item) => item.primary.id === "p-main")?.matches.find((match) => match.product)?.product.id, "late-unique");
});

test("global alias collapse retains a locally duplicate bridge edge", () => {
  const first = row("p1", "a");
  first.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  first.matches[0].product.sourceUrl = "https://rival.test/products/shared-source?country=US";
  first.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const bridge = structuredClone(first.matches[0]);
  bridge.product = product("bridge", "rival.test");
  bridge.product.sourceUrl = first.matches[0].product.sourceUrl;
  bridge.product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  first.matches.push(bridge);

  const second = row("p2", "bridge");
  second.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  second.matches[0].product.sourceUrl = "https://rival.test/products/other-source?country=US";
  second.matches[0].product.priceSignals = [{ raw: "USD 7", currency: "USD", amount: 7 }];
  const screened = comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows: [first, second], accepted: 3 });

  const state = mergePublishedProductComparisonState(screened, null, 2);
  assert.equal(state.comparison.rows.length, 1);
  const checkpoint = JSON.parse(JSON.stringify(compactPublishedProductComparisonCheckpoint(state.evidence)));
  const recovered = mergePublishedProductComparisonState(checkpoint, null, 2);
  assert.equal(recovered.comparison.rows.length, 1);
  const recoveredCheckpoint = JSON.parse(JSON.stringify(compactPublishedProductComparisonCheckpoint(recovered.evidence)));
  assert.deepEqual(
    recoveredCheckpoint.rows.flatMap((item) => item.matches.map((match) => match.product?.assignmentComponentHash)),
    checkpoint.rows.flatMap((item) => item.matches.map((match) => match.product?.assignmentComponentHash)),
  );
});

test("global assignment maximizes exact products after cardinality", () => {
  const first = row("p1", "shared");
  first.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  first.matches[0].score = 0.99;
  first.matches[0].assessment = { verdict: "same_product" };
  first.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const firstBackup = structuredClone(first.matches[0]);
  firstBackup.product = product("a", "rival.test");
  firstBackup.product.priceSignals = [{ raw: "USD 7", currency: "USD", amount: 7 }];
  firstBackup.score = 0.8;
  firstBackup.assessment = { verdict: "close_substitute" };
  first.matches.push(firstBackup);

  const second = row("p2", "shared");
  second.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  second.matches[0].score = 0.95;
  second.matches[0].assessment = { verdict: "close_substitute" };
  second.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const secondBackup = structuredClone(second.matches[0]);
  secondBackup.product = product("b", "rival.test");
  secondBackup.product.priceSignals = [{ raw: "USD 6", currency: "USD", amount: 6 }];
  secondBackup.score = 0.7;
  second.matches.push(secondBackup);
  const screened = comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows: [first, second], accepted: 4 });

  const result = mergePublishedProductComparisonState(screened, null, 2).comparison;

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find((item) => item.primary.id === "p1")?.matches.find((match) => match.product)?.product.id, "shared");
  assert.equal(result.rows.find((item) => item.primary.id === "p2")?.matches.find((match) => match.product)?.product.id, "b");
});

test("global assignment maximizes unrounded total score after cardinality and exactness", () => {
  const candidate = (primaryId, rivalId, score) => {
    const match = row(primaryId, rivalId).matches[0];
    match.product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    match.score = score;
    match.assessment = { verdict: "same_product" };
    return match;
  };
  const first = row("p1");
  first.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  first.matches = [candidate("p1", "A", 0.9000001), candidate("p1", "B", 0.9)];
  const second = row("p2");
  second.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  second.matches = [candidate("p2", "A", 0.9), candidate("p2", "B", 0.8999998)];
  const state = mergePublishedProductComparisonState(comparison({ selected: ["p1", "p2"], assessed: ["p1", "p2"], rows: [first, second], accepted: 4 }), null, 2);

  assert.deepEqual(state.comparison.rows.map((item) => [item.primary.id, item.matches[0].product.id]), [["p1", "B"], ["p2", "A"]]);
});

test("priced result backfill records an explicit bounded-pool shortfall", () => {
  const priced = row("p1", "r1");
  priced.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  priced.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const screened = comparison({ selected: ["p1", "p2", "p3"], assessed: ["p1", "p2", "p3"], rows: [priced, row("p2"), row("p3")], accepted: 1 });
  const result = limitPublishedProductComparison(publishPricedProductComparison(screened), 3);

  assert.equal(result.coverage.assignedPairCount, 1);
  assert.equal(result.matching.primaryProductsScreened, 3);
  assert.equal(result.matching.resultShortfall, 2);
  assert.equal(result.matching.resultShortfallReason, "bounded-candidate-pool-exhausted");
  assert.match(result.matching.gaps.join(" "), /Published 1 of 3.*fully processing.*3 screened/i);
  assert.equal(hasProductMatchCoverageDefect(result), true);
});

test("a completely empty rival pool can exhaust without inventing a market code", () => {
  const screened = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1")], accepted: 0 });
  delete screened.marketCountryCode;
  screened.matching.processedPrimaryIds = ["p1"];
  screened.matching.competitorProductsSynchronized = 0;
  screened.matching.candidatePairsAssessed = 0;
  const result = limitPublishedProductComparison(publishPricedProductComparison(screened), 1);

  assert.equal(result.matching.resultShortfallReason, "bounded-candidate-pool-exhausted");
});

test("priced result backfill reports processing incompleteness without claiming pool exhaustion", () => {
  const screened = comparison({ selected: ["p1", "p2"], assessed: ["p1"], rows: [row("p1"), row("p2")], accepted: 0 });
  const result = limitPublishedProductComparison(publishPricedProductComparison(screened), 2);
  assert.equal(result.matching.resultShortfallReason, "processing-incomplete");
  assert.match(result.matching.gaps.join(" "), /did not fully process/i);
  assert.doesNotMatch(result.matching.gaps.join(" "), /exhausted/i);
});

test("priced result backfill does not shrink the purchased target to a small catalog", () => {
  const priced = row("p1", "r1");
  priced.primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  priced.matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const screened = comparison({ selected: ["p1"], assessed: ["p1"], rows: [priced], accepted: 1 });
  screened.coverage.primaryProductsAvailable = 1;
  const result = limitPublishedProductComparison(publishPricedProductComparison(screened), 20);

  assert.equal(result.matching.resultTarget, 20);
  assert.equal(result.matching.publishedPrimaryProducts, 1);
  assert.equal(result.matching.resultShortfall, 19);
  assert.match(result.matching.gaps.join(" "), /Published 1 of 20/i);
});

test("the final publication gate keeps low-confidence pairs as excluded semantic evidence", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  candidate.rows[0].matches[0].confidence = "Low";

  const published = publishPricedProductComparison(candidate);

  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].excludedProduct.id, "r1");
  assert.deepEqual(published.rows[0].matches[0].publication, { priceEligible: false, reason: "insufficient-match-confidence" });
  assert.equal(published.matching.publication.reasons["insufficient-match-confidence"], 1);
});

test("the final publication gate rejects a mixed invalid and positive price range", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 0", currency: "USD", amount: 0 }, { raw: "USD 10", currency: "USD", amount: 10 }];
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];

  const published = publishPricedProductComparison(candidate);

  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].publication.reason, "missing-valid-primary-price");
});

test("the final publication gate requires parseable source and observation provenance", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  candidate.rows[0].primary.sourceUrl = "https://";
  candidate.rows[0].primary.observedAt = "not-a-date";

  const published = publishPricedProductComparison(candidate);

  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.rows[0].matches[0].publication.reason, "missing-valid-primary-price");
});

test("the final publication gate requires canonical and temporally bounded observation timestamps", () => {
  for (const observedAt of ["1", "1900-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z", "2026-08-16T00:00:00Z"]) {
    const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
    candidate.rows[0].primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    candidate.rows[0].primary.observedAt = observedAt;

    const published = publishPricedProductComparison(candidate);

    assert.equal(published.rows[0].matches[0].product, null, observedAt);
    assert.equal(published.rows[0].matches[0].publication.reason, "missing-valid-primary-price", observedAt);
  }
});

test("the final publication gate requires a public source owned by the product domain", () => {
  for (const sourceUrl of ["http://localhost/products/r1", "https://user:secret@rival.test/products/r1", "https://other.test/products/r1"]) {
    const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
    candidate.rows[0].primary.priceSignals = [{ raw: "USD 10", currency: "USD", amount: 10 }];
    candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
    candidate.rows[0].matches[0].product.sourceUrl = sourceUrl;

    const published = publishPricedProductComparison(candidate);

    assert.equal(published.rows[0].matches[0].product, null, sourceUrl);
    assert.equal(published.rows[0].matches[0].publication.reason, "missing-valid-rival-price", sourceUrl);
  }
});
