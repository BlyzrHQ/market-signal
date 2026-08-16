import test from "node:test";
import assert from "node:assert/strict";
import {
  composeProductMatchAttempts,
  hasProductMatchCoverageDefect,
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
    sourceUrl: `https://${domain}/products/${id}`,
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

test("the final publication gate excludes a country-path rival outside the report market", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.sourceUrl = "https://shop.test/us/products/p1";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/sg/products/r1";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.reason, "incompatible-market");
});

test("the final publication gate does not infer a market from a genericized country TLD", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.domain = "rival.la";
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.la/products/r1";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.priceEligible, true);
});

test("the final publication gate does not treat a region grouping as a country market", () => {
  const candidate = comparison({ selected: ["p1"], assessed: ["p1"], rows: [row("p1", "r1")], accepted: 1 });
  candidate.marketCountryCode = "US";
  candidate.rows[0].primary.priceSignals = [{ raw: "USD 90", currency: "USD", amount: 90 }];
  candidate.rows[0].matches[0].product.sourceUrl = "https://rival.test/en-eu/products/r1?region=EU";
  candidate.rows[0].matches[0].product.priceSignals = [{ raw: "USD 80", currency: "USD", amount: 80 }];
  assert.equal(publishPricedProductComparison(candidate).rows[0].matches[0].publication.priceEligible, true);
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
