function httpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function reduceCompetitorForPanel(result) {
  const discovery = result?.discovery || {};
  const homepageEvidenceUrl = httpUrl(result?.homepage?.sourceUrl);
  const discoveryEvidenceUrl = httpUrl(discovery?.sourceUrl || discovery?.websiteUrl);
  const sharedOfferings = Array.isArray(discovery?.sharedOfferings) ? discovery.sharedOfferings.map(String).filter(Boolean).slice(0, 8) : [];
  const marketCategory = String(discovery?.marketCategory || "").trim();
  const fetchedPaths = [...new Set((Array.isArray(result?.pages) ? result.pages : []).flatMap((page) => {
    if (typeof page?.path === "string" && page.path) return [page.path];
    try { return [new URL(String(page?.sourceUrl || "")).pathname]; } catch { return []; }
  }))];
  const gapReasons = [...new Set((Array.isArray(result?.gaps) ? result.gaps : []).map((gap) => String(gap?.reason || "").trim()).filter(Boolean))];
  const positioningAvailable = Boolean(discovery?.accepted && discovery?.categoryAlignment && homepageEvidenceUrl && discoveryEvidenceUrl && (marketCategory || sharedOfferings.length));
  return {
    domain: String(result?.domain || ""),
    companyName: String(discovery?.companyName || ""),
    score: Number(discovery?.verificationScore || 0),
    confidence: String(discovery?.confidence || ""),
    category: marketCategory,
    homepageEvidenceUrl,
    discoveryEvidenceUrl,
    fetchedPaths,
    gapReasons,
    positioningComparison: {
      available: positioningAvailable,
      marketCategory,
      sharedOfferings,
      homepageEvidenceUrl,
      discoveryEvidenceUrl,
    },
  };
}

export function usefulnessBreakdown({ ok, regionCorrect, competitorCount, offeringCount, matchCount, positioningComparisonCount, exactPriceCount, competitorEvidenceComplete, actionableMatchCount }) {
  const comparisonScore = matchCount >= 3 ? 30 : matchCount === 2 ? 25 : matchCount === 1 || positioningComparisonCount >= 3 ? 18 : 0;
  const breakdown = {
    reliableLiveReport: ok ? 10 : 0,
    correctRegion: regionCorrect ? 10 : 0,
    credibleCompetitorSet: competitorCount >= 3 ? 20 : competitorCount === 2 ? 12 : competitorCount === 1 ? 5 : 0,
    specificOfferings: offeringCount >= 5 ? 10 : offeringCount >= 3 ? 6 : offeringCount ? 3 : 0,
    productOrPositioningComparison: comparisonScore,
    exactComparablePrice: exactPriceCount ? 10 : 0,
    firstPartyCompetitorEvidence: competitorEvidenceComplete && competitorCount ? 5 : 0,
    actionableComparison: actionableMatchCount ? 5 : 0,
  };
  return { breakdown, score: Object.values(breakdown).reduce((sum, value) => sum + value, 0) };
}
