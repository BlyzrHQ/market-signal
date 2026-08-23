import assert from "node:assert/strict";
import test from "node:test";

import { profileDeterministicEvaluation } from "../app/lib/report-evaluator.ts";

function ecommerceInput() {
  const observedAt = "2026-07-31T00:00:00.000Z";
  const companies = [
    { domain: "shop.example", role: "primary", evidence_url: "https://shop.example/", evidence_json: JSON.stringify({ region: "GB" }) },
    ...[1, 2, 3].map((index) => ({ domain: `rival${index}.example`, role: "discovered-competitor", evidence_url: `https://rival${index}.example/`, evidence_json: JSON.stringify({ region: "GB" }) })),
  ];
  const products = [
    ...Array.from({ length: 50 }, (_, index) => ({ domain: "shop.example", product_id: `p${index}`, source_url: `https://shop.example/products/${index}`, image_url: `https://shop.example/images/${index}.jpg`, price_json: JSON.stringify([{ raw: "GBP 2", currency: "GBP", amount: 2 }]) })),
    ...Array.from({ length: 100 }, (_, index) => ({ domain: `rival${(index % 3) + 1}.example`, product_id: `r${index}`, source_url: `https://rival${(index % 3) + 1}.example/products/${index}`, image_url: `https://rival${(index % 3) + 1}.example/images/${index}.jpg`, price_json: JSON.stringify([{ raw: "GBP 1", currency: "GBP", amount: 1 }]) })),
  ];
  const evidenceBlocks = Array.from({ length: 10 }, (_, index) => ({ type: "evidence", id: `evidence-${index}`, claimId: `claim-${index}`, claimType: "Observed", text: `Observed product ${index}`, sourceUrl: `https://shop.example/products/${index}`, observedAt }));
  const matches = Array.from({ length: 10 }, (_, index) => {
    const rivalDomain = `rival${(index % 3) + 1}.example`;
    return {
      id: `m${index}`,
      primary_product_id: `p${index}`,
      rival_product_id: `r${index}`,
      rival_domain: rivalDomain,
      evidence_json: JSON.stringify({
        primarySourceUrl: `https://shop.example/products/${index}`,
        rivalSourceUrl: `https://${rivalDomain}/products/${index}`,
        publication: { priceEligible: true },
        claimIds: [`claim-${index}`],
        decision: index < 3 ? { recommendedMove: `Test action ${index}`, actionPlan: { actionEn: `Test action ${index}` } } : {},
      }),
    };
  });
  return {
    primaryDomain: "shop.example",
    terminalStatus: "complete",
    evaluatedAt: "2026-07-31T01:00:00.000Z",
    document: { blocks: evidenceBlocks },
    manifest: { companyCount: 4, productCount: 150, matchCount: 10, adCount: 0 },
    companies,
    products,
    matches,
    ads: [],
    events: [],
  };
}

test("deterministic ecommerce formulas reach 100 only from complete relational evidence", () => {
  const result = profileDeterministicEvaluation(ecommerceInput());
  assert.equal(result.status, "deterministic");
  assert.equal(result.deterministicScore, 100);
  assert.equal(result.deterministic.raw.primaryProducts, 50);
  assert.equal(result.deterministic.raw.rivalProducts, 100);
  assert.equal(result.deterministic.raw.acceptedSourceLinkedPairs, 10);
  assert.equal(result.deterministic.applicablePoints, 270);
  assert.deepEqual(result.deterministic.hardCaps, []);
  assert.equal(result.deterministic.components.evidenceIntegrity.unavailablePhaseExplanation.score, 5);
  assert.equal(result.deterministic.components.presentation.renderedGapCoverage.score, 15);
  assert.equal(result.signals.some((signal) => signal.issueKey === "ad-coverage-unknown"), false);
});

test("excluded semantic matches never earn accepted-pair or observed-price evaluation credit", () => {
  const input = ecommerceInput();
  const excluded = JSON.parse(input.matches[0].evidence_json);
  excluded.publication = { priceEligible: false, reason: "incompatible-price-currency" };
  input.matches[0].evidence_json = JSON.stringify(excluded);

  const result = profileDeterministicEvaluation(input);

  assert.equal(result.deterministic.raw.acceptedSourceLinkedPairs, 9);
  assert.equal(result.deterministic.components.userValue.observedPairPriceCoverage.denominator, 9);
});

test("zero denominators and unsupported evidence remain explicit and trigger future caps", () => {
  const input = ecommerceInput();
  input.companies = input.companies.slice(0, 1);
  input.matches = [];
  input.document = { blocks: [{ type: "evidence", claimId: "unsupported", claimType: "Observed", text: "Unsupported", sourceUrl: "https://publisher.example/story", observedAt: input.evaluatedAt }] };
  input.manifest = { companyCount: 1, productCount: 150, matchCount: 0, adCount: 0 };
  const result = profileDeterministicEvaluation(input);
  assert.equal(result.deterministic.components.userValue.observedPairPriceCoverage.denominator, 0);
  assert.equal(result.deterministic.components.userValue.observedPairPriceCoverage.score, 0);
  assert.equal(result.deterministic.components.userValue.recommendationEvidenceCoverage.denominator, 0);
  assert.equal(result.deterministic.components.userValue.recommendationEvidenceCoverage.score, 0);
  assert.deepEqual(result.deterministic.hardCaps.map((cap) => cap.issueKey).sort(), ["no-accepted-competitor", "unsupported-material-claims"]);
  assert.equal(result.deterministic.unknowns.some((item) => item.field === "acceptedPairs"), true);
});

test("non-ecommerce facts receive evidence diagnostics but no ecommerce rubric", () => {
  const result = profileDeterministicEvaluation({
    primaryDomain: "agency.example",
    terminalStatus: "limited",
    evaluatedAt: "2026-07-31T00:00:00.000Z",
    document: { blocks: [{ type: "gap", reason: "No product catalog applies." }] },
    manifest: { companyCount: 1, productCount: 0, matchCount: 0, adCount: 0 },
    companies: [{ domain: "agency.example", role: "primary", evidence_url: "https://agency.example/", evidence_json: "{}" }],
    products: [],
    matches: [],
    ads: [],
    events: [],
  });
  assert.equal(result.status, "rubric_unavailable");
  assert.equal(result.deterministic.businessType, "non-ecommerce");
  assert.equal(result.deterministic.applicablePoints, 80);
  assert.equal(result.deterministicScore, 6);
});

test("invalid persisted schema fails without producing a score", () => {
  const input = ecommerceInput();
  input.document = { title: "missing blocks" };
  const result = profileDeterministicEvaluation(input);
  assert.equal(result.status, "failed");
  assert.equal(result.deterministicScore, null);
  assert.equal(result.errorCode, "invalid-report-schema");
});

test("a completed manifest that disagrees with relational facts cannot be scored", () => {
  const input = ecommerceInput();
  input.manifest.productCount = 149;
  const result = profileDeterministicEvaluation(input);
  assert.equal(result.status, "failed");
  assert.equal(result.deterministicScore, null);
  assert.equal(result.errorCode, "fact-manifest-count-mismatch");
  assert.equal(result.signals[0].severity, "critical");
});

test("legacy ad events and gaps do not affect current report scoring", () => {
  const input = ecommerceInput();
  input.events = [
    { phase: "crawl", status: "limited", message: "Website crawl was limited." },
    { phase: "ads", status: "limited", message: "Ad lookup was unavailable." },
  ];
  input.document.blocks.push(
    { type: "gap", reason: "Meta ad library access was unavailable." },
    { type: "gap", reason: "Google campaign evidence was unavailable." },
  );
  const result = profileDeterministicEvaluation(input);
  const evidenceGap = result.deterministic.components.evidenceIntegrity.unavailablePhaseExplanation;
  const presentationGap = result.deterministic.components.presentation.renderedGapCoverage;
  assert.equal(evidenceGap.numerator, 0);
  assert.equal(evidenceGap.denominator, 1);
  assert.equal(evidenceGap.score, 0);
  assert.equal(presentationGap.score, 0);
  assert.deepEqual(result.deterministic.raw.explainedUnavailablePhases, []);
});
