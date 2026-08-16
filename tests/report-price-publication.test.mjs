import assert from "node:assert/strict";
import test from "node:test";
import { countLegacyUngatedProductMatches } from "../app/lib/report-price-publication.ts";

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
