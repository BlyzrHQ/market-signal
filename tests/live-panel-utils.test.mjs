import assert from "node:assert/strict";
import test from "node:test";

import { reduceCompetitorForPanel, usefulnessBreakdown } from "../scripts/live-panel-utils.mjs";

test("panel competitor evidence records fetched paths, gaps, and cited positioning", () => {
  const reduced = reduceCompetitorForPanel({
    domain: "rival.example",
    homepage: { sourceUrl: "https://rival.example/" },
    pages: [
      { path: "/", sourceUrl: "https://rival.example/" },
      { path: "/services", sourceUrl: "https://rival.example/services" },
    ],
    gaps: [{ reason: "pricing page timed out" }],
    discovery: {
      accepted: true,
      companyName: "Rival",
      verificationScore: 82,
      confidence: "Medium",
      marketCategory: "Digital product agency",
      categoryAlignment: true,
      sharedOfferings: ["Product design", "Mobile development"],
      sourceUrl: "https://search.example/evidence",
    },
  });
  assert.deepEqual(reduced.fetchedPaths, ["/", "/services"]);
  assert.deepEqual(reduced.gapReasons, ["pricing page timed out"]);
  assert.equal(reduced.positioningComparison.available, true);
  assert.equal(reduced.positioningComparison.marketCategory, "Digital product agency");
  assert.deepEqual(reduced.positioningComparison.sharedOfferings, ["Product design", "Mobile development"]);
});

test("panel usefulness credits only cited positioning when no product pair exists", () => {
  const common = { ok: true, regionCorrect: true, competitorCount: 3, offeringCount: 5, matchCount: 0, exactPriceCount: 0, competitorEvidenceComplete: true, actionableMatchCount: 0 };
  const cited = usefulnessBreakdown({ ...common, positioningComparisonCount: 3 });
  const missing = usefulnessBreakdown({ ...common, positioningComparisonCount: 0 });
  assert.equal(cited.breakdown.productOrPositioningComparison, 18);
  assert.equal(missing.breakdown.productOrPositioningComparison, 0);
});
