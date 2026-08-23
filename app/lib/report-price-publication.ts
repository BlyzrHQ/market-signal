function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function domain(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

function acceptedComparisonDomains(comparison: unknown) {
  const counts = new Map<string, number>();
  const rows = record(comparison)?.rows;
  if (!Array.isArray(rows)) return counts;
  for (const row of rows) {
    const matches = record(row)?.matches;
    if (!Array.isArray(matches)) continue;
    for (const match of matches) {
      const candidate = record(match);
      const rival = record(candidate?.product);
      if (!candidate || !rival || record(candidate.publication)?.priceEligible !== true) continue;
      const rivalDomain = domain(candidate.domain || rival.domain);
      if (!rivalDomain) continue;
      counts.set(rivalDomain, (counts.get(rivalDomain) || 0) + 1);
    }
  }
  return counts;
}

export function publishedComparisonCompetitors(blocks: unknown, comparison: unknown) {
  const companyBlocks = Array.isArray(blocks)
    ? blocks.map(record).filter((block): block is Record<string, unknown> => block?.type === "competitor")
    : [];
  const pairDomains = acceptedComparisonDomains(comparison);
  if (!pairDomains.size) return companyBlocks;
  const byDomain = new Map(companyBlocks.map((block) => [domain(block.domain), block]));
  return [...pairDomains].map(([rivalDomain, comparisonCount]) => {
    const existing = byDomain.get(rivalDomain);
    return {
      type: "competitor",
      id: `competitor-${rivalDomain}`,
      domain: rivalDomain,
      companyName: rivalDomain,
      reason: "Included because this seller supplies at least one accepted priced product comparison.",
      relationship: "priced product comparison",
      confidence: "Verified pair",
      hasProductOverlap: true,
      ...(existing || {}),
      comparisonCount,
      pairDerived: true,
    };
  });
}

export function countLegacyUngatedProductMatches(comparison: unknown) {
  const rows = record(comparison)?.rows;
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((total, row) => {
    const matches = record(row)?.matches;
    if (!Array.isArray(matches)) return total;
    return total + matches.filter((match) => {
      const candidate = record(match);
      if (!candidate || (!record(candidate.product) && !record(candidate.excludedProduct))) return false;
      return typeof record(candidate.publication)?.priceEligible !== "boolean";
    }).length;
  }, 0);
}
