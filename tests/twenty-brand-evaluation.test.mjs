import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { summarize, validPrice, validProductSource } from "../scripts/run-twenty-brand-evaluation.mjs";

test("twenty-brand production matrix is bounded and preserves the required cohort", async () => {
  const source = await readFile(new URL("../scripts/run-twenty-brand-evaluation.mjs", import.meta.url), "utf8");
  const domainBlock = source.match(/const domains = \[([\s\S]*?)\];/);
  assert.ok(domainBlock);
  const cohort = [...domainBlock[1].matchAll(/"([a-z0-9.-]+\.(?:com|co\.uk))"/g)].map((match) => match[1]);
  assert.equal(cohort.length, 20);
  assert.equal(new Set(cohort).size, 20);
  assert.ok(cohort.includes("wearform.com"));
  assert.ok(cohort.includes("myjam.co.uk"));
  assert.match(source, /Math\.min\(3,/);
  assert.match(source, /20 \* 60_000/);
  assert.match(source, /missingRivalPriceViolations/);
  assert.match(source, /sourceViolations/);
  assert.match(source, /identityViolations/);
  assert.match(source, /acceptedPairEvidence/);
  assert.match(source, /documentAvailable \? Number/);
  assert.match(source, /comparisonUsefulness/);
  assert.match(source, /await persist\(artifact\)/);
  assert.match(source, /persistQueue = persistQueue\.then/);
  assert.match(source, /await saveProgress\(\)/);
  assert.match(source, /phase !== lastPhase/);
});

test("price validation requires an observed numeric amount, raw value, and supported currency", () => {
  assert.equal(validPrice({ amount: 10, raw: "USD 10.00", currency: "USD" }), true);
  assert.equal(validPrice({ amount: "10", raw: "USD 10.00", currency: "USD" }), false);
  assert.equal(validPrice({ amount: 10, raw: "", currency: "USD" }), false);
  assert.equal(validPrice({ amount: 10, raw: "XYZ 10", currency: "XYZ" }), false);
  assert.equal(validPrice({ amount: 0, raw: "USD 0", currency: "USD" }), false);
});

test("product evidence must be bound to the claimed product domain", () => {
  assert.equal(validProductSource({ domain: "example.com", sourceUrl: "https://shop.example.com/products/a" }), true);
  assert.equal(validProductSource({ domain: "example.com", sourceUrl: "https://unrelated.test/products/a" }), false);
  assert.equal(validProductSource({ domain: "example.com", sourceUrl: "not a URL" }), false);
});

function reportPayload({ rivalPrice = { amount: 10, raw: "USD 10.00", currency: "USD" }, rivalSourceUrl = "https://rival.example/products/b", status = "complete", blocks = null } = {}) {
  const documentBlocks = blocks || [
    { type: "competitor", domain: "rival.example" },
    {
      type: "product-comparison",
      coverage: { primaryProductsAvailable: 4, competitorProductsAvailable: 3 },
      matching: { primaryProductsAssessed: 1, publication: { suppressedAcceptedPairs: 0 } },
      rows: [{
        primary: {
          id: "a",
          name: "Primary A",
          domain: "brand.example",
          sourceUrl: "https://brand.example/products/a",
          imageUrl: "https://brand.example/a.jpg",
          priceSignals: [{ amount: 12, raw: "USD 12.00", currency: "USD" }],
        },
        matches: [{
          product: {
            id: "b",
            name: "Rival B",
            domain: "rival.example",
            sourceUrl: rivalSourceUrl,
            imageUrl: "https://rival.example/b.jpg",
            priceSignals: [rivalPrice],
          },
          decision: { priceComparison: { delta: 2 } },
          assessment: { verdict: "same_product", reasons: ["synthetic test"] },
        }],
      }],
    },
  ];
  return {
    report: {
      run: {
        publicId: "synthetic-report",
        primaryDomain: "brand.example",
        productPlan: "starter",
        productLimit: 20,
        status,
        currentPhase: "complete",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
      },
      primaryProducts: { totalCount: 4 },
      document: { document: { blocks: documentBlocks } },
    },
  };
}

test("summarizer passes a healthy published pair and preserves evidence", () => {
  const result = summarize(reportPayload(), "", "");
  assert.equal(result.verdict, "PASS");
  assert.equal(result.acceptedPricedMatches, 1);
  assert.equal(result.dualPricedMatches, 1);
  assert.equal(result.directPriceDeltas, 1);
  assert.equal(result.sourceViolations, 0);
  assert.equal(result.acceptedPairEvidence.length, 1);
});

test("summarizer fails malformed price or domain-mismatched source evidence", () => {
  const malformedPrice = summarize(reportPayload({ rivalPrice: { amount: "10", raw: "USD 10", currency: "USD" } }), "", "");
  assert.equal(malformedPrice.verdict, "FAIL");
  assert.equal(malformedPrice.acceptedPricedMatches, 0);
  assert.equal(malformedPrice.missingRivalPriceViolations, 1);

  const wrongSource = summarize(reportPayload({ rivalSourceUrl: "https://unrelated.test/products/b" }), "", "");
  assert.equal(wrongSource.verdict, "FAIL");
  assert.equal(wrongSource.sourceViolations, 1);
});

test("failed report leaves unavailable catalog metrics unknown", () => {
  const result = summarize(reportPayload({ status: "failed", blocks: [] }), "", "");
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.documentAvailable, false);
  assert.equal(result.primaryProducts, null);
  assert.equal(result.acceptedPricedMatches, null);
});
