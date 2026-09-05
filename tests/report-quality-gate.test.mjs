import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_REPORT_QUALITY_REPAIR_PRODUCTS,
  evaluateReportDraftQuality,
  parseReportQualityRepairFeedback,
  sanitizeReportDraftQuality,
} from "../src/shared/report-quality-gate.ts";

const observedAt = "2026-09-02T10:00:00.000Z";
const referenceTimeMs = Date.parse(observedAt);

function product(domain, id, amount = 10, currency = "GBP") {
  return {
    id,
    domain,
    name: `Product ${id}`,
    normalizedName: `product ${id}`,
    description: "Observed public product",
    category: "grocery",
    jsonLdType: "Product",
    priceSignals: amount === undefined ? [] : [{ raw: `${currency} ${amount}`, currency, amount }],
    attributes: [],
    ownership: "self-declared-brand",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://${domain}/products/${id}`,
    imageUrl: "",
    observedAt,
    claimIds: [`claim-${id}`],
  };
}

function comparison(pairCount = 2) {
  const rows = Array.from({ length: pairCount }, (_, index) => {
    const primary = product("shop.test", `primary-${index}`);
    const rival = product(`rival-${index}.test`, `rival-${index}`, 8);
    return {
      primary,
      matches: [{
        domain: rival.domain,
        product: rival,
        score: 1,
        confidence: "Medium",
        sharedTerms: [],
        claimIds: rival.claimIds,
        decision: null,
        publication: { priceEligible: true },
      }],
    };
  });
  return {
    primaryDomain: "shop.test",
    marketCountryCode: "GB",
    comparisonDomains: rows.map((row) => row.matches[0].domain),
    rows,
    unmatched: [],
    coverage: {
      primaryProductsAvailable: pairCount,
      primaryProductsScanned: pairCount,
      primaryProductFamiliesCompared: pairCount,
      competitorProductsAvailable: pairCount,
      competitorProductsScanned: pairCount,
      assignedPairCount: pairCount,
      verifiedPairCount: pairCount,
      rowsReturned: pairCount,
      rowLimit: pairCount,
      truncated: false,
    },
    matching: {
      method: "direct-web-search",
      available: true,
      model: "test",
      embeddingModel: "",
      promptVersion: "direct-product-search-v1",
      primaryProductsAssessed: pairCount,
      primaryProductsScreened: pairCount,
      resultTarget: pairCount,
      publishedPairs: pairCount,
      publishedPrimaryProducts: pairCount,
      resultShortfall: 0,
      candidatePairsAssessed: pairCount,
      retrievalPairsScored: 0,
      judgeCalls: 0,
      embeddingCalls: 0,
      durationMs: 1,
      gaps: [],
      selectedPrimaryIds: rows.map((row) => row.primary.id),
      assessedPrimaryIds: rows.map((row) => row.primary.id),
      processedPrimaryIds: rows.map((row) => row.primary.id),
    },
  };
}

test("repair feedback deduplicates repeated catalog identities before rotating rounds", () => {
  const draft = comparison(0);
  const a = product("shop.test", "a");
  const b = product("shop.test", "b");
  for (let repairRound = 0; repairRound < 3; repairRound++) {
    const verdict = evaluateReportDraftQuality({ comparison: draft, comparisonTarget: 20,
      primaryDomain: "shop.test", primaryProducts: [a, { ...a }, b], referenceTimeMs, repairRound });
    assert.equal(verdict.status, "repair");
    assert.equal(new Set(verdict.feedback.primaryProductIds).size, verdict.feedback.primaryProductIds.length);
    assert.deepEqual(parseReportQualityRepairFeedback(verdict.feedback), verdict.feedback);
  }
});

test("repair feedback excludes an ID that names conflicting source pages", () => {
  const a = product("shop.test", "a");
  const b = product("shop.test", "b");
  const verdict = evaluateReportDraftQuality({ comparison: comparison(0), comparisonTarget: 20,
    primaryDomain: "shop.test", primaryProducts: [a, { ...a, sourceUrl: "https://shop.test/products/different" }, b], referenceTimeMs });
  assert.deepEqual(verdict.feedback.primaryProductIds, [b.id]);
});

test("a full priced draft passes the report quality gate", () => {
  const draft = comparison(2);
  const verdict = evaluateReportDraftQuality({
    comparison: draft,
    comparisonTarget: 2,
    primaryDomain: "shop.test",
    primaryProducts: draft.rows.map((row) => row.primary),
    referenceTimeMs,
  });
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.validComparisonCount, 2);
  assert.equal(verdict.feedback, null);
  assert.deepEqual(verdict.deficiencies, []);
});

test("a quantity shortfall produces deterministic, hash-bound, bounded repair feedback", () => {
  const draft = comparison(1);
  draft.coverage.primaryProductsAvailable = 31;
  const primaryProducts = [draft.rows[0].primary, ...Array.from({ length: 30 }, (_, index) => product("shop.test", `unmatched-${String(index).padStart(2, "0")}`))];
  const input = { comparison: draft, comparisonTarget: 20, primaryDomain: "shop.test", primaryProducts, referenceTimeMs };
  const first = evaluateReportDraftQuality(input);
  const second = evaluateReportDraftQuality(input);
  assert.equal(first.status, "repair");
  assert.equal(first.missingComparisonCount, 19);
  assert.equal(first.feedback.primaryProductIds.length, MAX_REPORT_QUALITY_REPAIR_PRODUCTS);
  assert.ok(first.feedback.primaryProductIds.every((id) => id.startsWith("unmatched-")));
  assert.deepEqual(first, second);
  assert.deepEqual(parseReportQualityRepairFeedback(first.feedback), first.feedback);
});

test("repair feedback rejects hash tampering and nondeterministic arrays", () => {
  const draft = comparison(1);
  const verdict = evaluateReportDraftQuality({
    comparison: draft,
    comparisonTarget: 2,
    primaryDomain: "shop.test",
    primaryProducts: [draft.rows[0].primary],
    referenceTimeMs,
  });
  assert.equal(verdict.status, "repair");
  assert.throws(() => parseReportQualityRepairFeedback({ ...verdict.feedback, feedbackHash: "f".repeat(64) }), /hash does not match/);
  assert.throws(() => parseReportQualityRepairFeedback({ ...verdict.feedback, reasonCodes: [...verdict.feedback.reasonCodes, ...verdict.feedback.reasonCodes] }), /deterministic|invalid reason/);
});

test("the third unsuccessful repair terminates as a transparent limited result", () => {
  const draft = comparison(1);
  const verdict = evaluateReportDraftQuality({
    comparison: draft,
    comparisonTarget: 2,
    primaryDomain: "shop.test",
    primaryProducts: [draft.rows[0].primary],
    referenceTimeMs,
    repairRound: 3,
  });
  assert.equal(verdict.status, "limited");
  assert.equal(verdict.feedback, null);
  assert.equal(verdict.missingComparisonCount, 1);
});

test("empty prices, duplicate sources, and currency drift are hard rejections", () => {
  const emptyPrice = comparison(1);
  emptyPrice.rows[0].matches[0].product.priceSignals = [];
  const emptyVerdict = evaluateReportDraftQuality({ comparison: emptyPrice, comparisonTarget: 1, primaryDomain: "shop.test", primaryProducts: [emptyPrice.rows[0].primary], referenceTimeMs });
  assert.equal(emptyVerdict.status, "reject");
  assert.ok(emptyVerdict.deficiencies.some((item) => item.code === "empty_rival_price"));

  const duplicate = comparison(2);
  duplicate.rows[1].matches[0].domain = duplicate.rows[0].matches[0].domain;
  duplicate.rows[1].matches[0].product = structuredClone(duplicate.rows[0].matches[0].product);
  const duplicateVerdict = evaluateReportDraftQuality({ comparison: duplicate, comparisonTarget: 2, primaryDomain: "shop.test", primaryProducts: duplicate.rows.map((row) => row.primary), referenceTimeMs });
  assert.equal(duplicateVerdict.status, "reject");
  assert.ok(duplicateVerdict.deficiencies.some((item) => item.code === "duplicate_rival_source"));

  const currency = comparison(1);
  currency.rows[0].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  const currencyVerdict = evaluateReportDraftQuality({ comparison: currency, comparisonTarget: 1, primaryDomain: "shop.test", primaryProducts: [currency.rows[0].primary], referenceTimeMs });
  assert.equal(currencyVerdict.status, "reject");
  assert.ok(currencyVerdict.deficiencies.some((item) => item.code === "incompatible_price_currency"));
});

test("hard defects are deterministically removed before a paid report continues as repairable", () => {
  const draft = comparison(3);
  draft.rows[0].matches[0].product.priceSignals = [];
  draft.rows[1].matches[0].product.priceSignals = [{ raw: "USD 8", currency: "USD", amount: 8 }];
  draft.rows[2].matches[0].domain = draft.rows[0].matches[0].domain;
  draft.rows[2].matches[0].product = structuredClone(draft.rows[0].matches[0].product);

  const sanitized = sanitizeReportDraftQuality({ comparison: draft, comparisonTarget: 3, primaryDomain: "shop.test", referenceTimeMs });
  const verdict = evaluateReportDraftQuality({ comparison: sanitized.comparison, comparisonTarget: 3, primaryDomain: "shop.test", primaryProducts: draft.rows.map((row) => row.primary), referenceTimeMs });

  assert.equal(sanitized.comparison.coverage.assignedPairCount, 0);
  assert.equal(sanitized.removedComparisonCount, 3);
  assert.deepEqual(sanitized.reasonCodes, ["coverage_count_mismatch", "duplicate_rival_source", "empty_rival_price", "incompatible_price_currency"]);
  assert.equal(verdict.status, "repair");
  assert.equal(verdict.deficiencies.some((item) => item.code !== "comparison_target_shortfall"), false);
});

test("the gate catches the historical empty-primary-price defect in the stored Wearform production evidence", () => {
  const evidence = JSON.parse(readFileSync(new URL("../docs/tasks/134-twenty-brand-production-results.json", import.meta.url), "utf8"));
  const report = evidence.reports.find((candidate) => candidate.domain === "wearform.com");
  assert.ok(report);
  const observedAt = report.completedAt;
  const fromEvidence = (pair, role) => ({
    id: role === "primary" ? pair.primaryId : pair.rivalId,
    domain: role === "primary" ? pair.primaryExpectedDomain : pair.rivalExpectedDomain,
    name: role === "primary" ? pair.primaryName : pair.rivalName,
    normalizedName: (role === "primary" ? pair.primaryName : pair.rivalName).toLowerCase(),
    description: "Stored production evidence",
    category: "apparel",
    jsonLdType: "Product",
    priceSignals: role === "primary" ? pair.primaryPrices : pair.rivalPrices,
    attributes: [],
    ownership: "self-declared-brand",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: role === "primary" ? pair.primarySourceUrl : pair.rivalSourceUrl,
    imageUrl: "",
    observedAt,
    claimIds: [],
  });
  const rows = report.acceptedPairEvidence.map((pair) => {
    const primary = fromEvidence(pair, "primary");
    const rival = fromEvidence(pair, "rival");
    return { primary, matches: [{ domain: rival.domain, product: rival, score: 1, confidence: "Medium", sharedTerms: [], claimIds: [], decision: null, publication: { priceEligible: true } }] };
  });
  const draft = {
    primaryDomain: report.domain,
    comparisonDomains: [...new Set(rows.flatMap((row) => row.matches.map((match) => match.domain)))],
    rows,
    unmatched: [],
    coverage: { primaryProductsAvailable: report.primaryProducts, primaryProductsScanned: rows.length, primaryProductFamiliesCompared: rows.length, competitorProductsAvailable: rows.length, competitorProductsScanned: rows.length, assignedPairCount: rows.length, verifiedPairCount: rows.length, rowsReturned: rows.length, rowLimit: report.productLimit, truncated: false },
  };

  const verdict = evaluateReportDraftQuality({ comparison: draft, comparisonTarget: report.productLimit, primaryDomain: report.domain, primaryProducts: rows.map((row) => row.primary), referenceTimeMs: Date.parse(observedAt) });

  assert.equal(verdict.status, "reject");
  assert.equal(verdict.validComparisonCount, 3);
  assert.equal(verdict.deficiencies.filter((item) => item.code === "empty_primary_price").length, 14);
});
