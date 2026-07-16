import test from "node:test";
import assert from "node:assert/strict";
import {
  composeProductMatchAttempts,
  hasProductMatchCoverageDefect,
  shouldRetryProductMatch,
  upsertProductComparisonBlock,
} from "../app/lib/product-match-lifecycle.ts";

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
    observedAt: "2026-07-15T00:00:00.000Z",
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
