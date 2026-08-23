import assert from "node:assert/strict";
import test from "node:test";
import { countLegacyUngatedProductMatches, publishedComparisonCompetitors } from "../app/lib/report-price-publication.ts";

test("fresh gated reports ignore unmatched competitor placeholders", () => {
  const comparison = {
    rows: [{
      matches: [
        { domain: "priced.example", product: { name: "Jacket" }, publication: { priceEligible: true } },
        { domain: "unmatched.example", product: null },
      ],
    }],
  };
  assert.equal(countLegacyUngatedProductMatches(comparison), 0);
});

test("legacy decided product pairs without a publication gate are disclosed", () => {
  const comparison = {
    rows: [{
      matches: [
        { domain: "legacy.example", product: { name: "Legacy jacket" } },
        { domain: "legacy-rejected.example", product: null, excludedProduct: { name: "Rejected legacy jacket" } },
      ],
    }],
  };
  assert.equal(countLegacyUngatedProductMatches(comparison), 2);
});

test("customer-visible competitors are projected only from accepted priced comparisons", () => {
  const blocks = [
    { type: "competitor", id: "kept", domain: "seller-one.example", companyName: "Seller One", verificationScore: 82 },
    { type: "competitor", id: "broad-discovery", domain: "unused.example", companyName: "Unused discovery" },
  ];
  const comparison = {
    rows: [
      { matches: [
        { domain: "seller-one.example", product: { name: "Rival A" }, publication: { priceEligible: true } },
        { domain: "seller-two.example", product: { name: "Rival B" }, publication: { priceEligible: true } },
        { domain: "unpriced.example", product: { name: "Rival C" }, publication: { priceEligible: false } },
      ] },
      { matches: [
        { domain: "seller-one.example", product: { name: "Rival D" }, publication: { priceEligible: true } },
      ] },
    ],
  };

  const projected = publishedComparisonCompetitors(blocks, comparison);
  assert.deepEqual(projected.map((item) => item.domain), ["seller-one.example", "seller-two.example"]);
  assert.equal(projected[0].companyName, "Seller One");
  assert.equal(projected[0].comparisonCount, 2);
  assert.equal(projected[1].comparisonCount, 1);
  assert.equal(projected[1].pairDerived, true);
});

test("legacy reports without publication gates retain their existing competitor blocks", () => {
  const blocks = [{ type: "competitor", id: "legacy", domain: "legacy.example" }];
  assert.deepEqual(publishedComparisonCompetitors(blocks, { rows: [] }), blocks);
});
