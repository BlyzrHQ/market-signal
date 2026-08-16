function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
