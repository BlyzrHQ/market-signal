import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("publication freshness is stable against the report observation timestamp", () => {
  const primary = { ...product("p1"), observedAt: "2025-08-01T00:00:00.000Z", priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }] };
  const rival = { ...product("r1", "rival.test"), observedAt: "2025-08-01T00:00:00.000Z", priceSignals: [{ raw: "GBP 8", currency: "GBP", amount: 8 }] };
  const input = comparison({ selected: ["p1"], assessed: ["p1"], rows: [{ primary, matches: [{ domain: rival.domain, product: rival, score: 0.95, confidence: "Medium", sharedTerms: [], claimIds: [], assessment: { verdict: "same_product", priceComparable: true, reasons: [], contradictions: [], claimType: "Inferred" }, decision: null }] }], accepted: 1 });

  const published = publishPricedProductComparison(input, Date.parse("2025-08-02T00:00:00.000Z"));
  assert.equal(published.rows[0].matches[0].publication.priceEligible, true);
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
  const checkpoint = { version: 2, comparison: state.comparison, evidence: state.evidence };

  assert.equal(state.evidence.rows.length, 20);
  assert.ok(state.evidence.rows.every((item) => item.matches.length >= 1 && item.matches.length <= MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY));
  assert.ok(state.evidence.rows.every((item) => item.matches.some((match) => match.product?.sourceUrl.startsWith("https://rival.test/rival/"))));
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), "utf8") < 512_000);
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
