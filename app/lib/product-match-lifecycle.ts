import { hasValidObservedRivalPrice, isSupportedCurrency, type ProductComparison, type ProductRecord } from "./product-intelligence.ts";

export type ProductMatchLifecycle = "idle" | "matching" | "retrying" | "complete" | "limited";

type ReportBlock = { type: string; id: string } & Record<string, unknown>;
type ReportDocument = { blocks: ReportBlock[] } & Record<string, unknown>;

function matching(comparison: ProductComparison) {
  return comparison.matching;
}

function selectedIds(comparison: ProductComparison) {
  const explicit = matching(comparison)?.selectedPrimaryIds || [];
  return new Set(explicit.length ? explicit : comparison.rows.map((row) => row.primary.id));
}

function assessedIds(comparison: ProductComparison) {
  return new Set(matching(comparison)?.assessedPrimaryIds || []);
}

function gapCount(comparison: ProductComparison) {
  return matching(comparison)?.gaps.length || 0;
}

function withoutUnassessedMatches(comparison: ProductComparison) {
  const rows = comparison.rows.map((row) => ({
    ...row,
    matches: row.matches.map((match) => ({ ...match, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null, assessment: undefined })),
  }));
  return { ...comparison, rows, coverage: { ...comparison.coverage, assignedPairCount: 0, verifiedPairCount: 0 } };
}

export function hasProductMatchCoverageDefect(comparison: ProductComparison | null | undefined) {
  if (!comparison?.matching || comparison.matching.method !== "ai-hybrid" || !comparison.matching.available) return true;
  const selected = selectedIds(comparison);
  const assessed = assessedIds(comparison);
  const assessedCount = Math.max(assessed.size, comparison.matching.primaryProductsAssessed);
  return gapCount(comparison) > 0 || assessedCount < selected.size;
}

export function shouldRetryProductMatch(comparison: ProductComparison | null | undefined, transportFailed = false) {
  if (transportFailed) return true;
  const unavailableBecauseUnconfigured = comparison?.matching?.available === false
    && comparison.matching.gaps.some((gap) => /not configured/i.test(gap));
  return !unavailableBecauseUnconfigured && hasProductMatchCoverageDefect(comparison);
}

function attemptRank(left: ProductComparison, right: ProductComparison) {
  const assessedDifference = assessedIds(right).size - assessedIds(left).size;
  if (assessedDifference) return assessedDifference;
  const gapDifference = gapCount(left) - gapCount(right);
  if (gapDifference) return gapDifference;
  return (right.matching?.primaryProductsAssessed || 0) - (left.matching?.primaryProductsAssessed || 0);
}

export function composeProductMatchAttempts(baseline: ProductComparison | null, attempts: ProductComparison[], requestCount = attempts.length) {
  const usable = attempts.filter((attempt) => attempt.matching?.method === "ai-hybrid" && attempt.matching.available);
  if (!usable.length) {
    const latest = attempts.at(-1) || baseline;
    if (!latest) return latest;
    const stripped = withoutUnassessedMatches(latest);
    return stripped.matching ? { ...stripped, matching: { ...stripped.matching, attempts: Math.max(stripped.matching.attempts || 1, requestCount) } } : stripped;
  }
  const ranked = usable.map((attempt, index) => ({ attempt, index })).sort((left, right) => attemptRank(left.attempt, right.attempt) || left.index - right.index).map((item) => item.attempt);
  const preferred = ranked[0];
  const assessedByAttempt = new Map(ranked.map((attempt) => [attempt, assessedIds(attempt)]));
  const rowMaps = new Map(ranked.map((attempt) => [attempt, new Map(attempt.rows.map((row) => [row.primary.id, row]))]));
  const baselineRows = new Map((baseline?.rows || []).map((row) => [row.primary.id, row]));
  const orderedIds = [...new Set([...ranked.flatMap((attempt) => attempt.rows.map((row) => row.primary.id)), ...(baseline?.rows || []).map((row) => row.primary.id)])];
  const rows = orderedIds.flatMap((id) => {
    const authoritative = ranked.find((attempt) => assessedByAttempt.get(attempt)?.has(id));
    const row = authoritative ? rowMaps.get(authoritative)?.get(id) : rowMaps.get(preferred)?.get(id) || baselineRows.get(id);
    if (!row) return [];
    if (authoritative) return [row];
    return [{ ...row, matches: row.matches.map((match) => ({ ...match, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null, assessment: undefined })) }];
  });
  const selected = new Set(ranked.flatMap((attempt) => [...selectedIds(attempt)]));
  const assessed = new Set(ranked.flatMap((attempt) => [...assessedIds(attempt)]));
  const unresolved = [...selected].filter((id) => !assessed.has(id));
  const preferredGaps = preferred.matching?.gaps || [];
  const gaps = unresolved.length
    ? [...preferredGaps, `AI product matching did not assess ${unresolved.length} selected primary product${unresolved.length === 1 ? "" : "s"} after the bounded retry.`]
    : preferredGaps.filter((gap) => !/judging (?:reached|failed|returned incomplete|hit an incomplete)|deadline for \d+ primary/i.test(gap));
  const assignedPairCount = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product).length, 0);
  const verifiedPairCount = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product && match.confidence === "Medium").length, 0);
  const sumMetric = (key: "candidatePairsAssessed" | "retrievalPairsScored" | "judgeCalls" | "embeddingCalls" | "durationMs") => ranked.reduce((sum, attempt) => sum + (attempt.matching?.[key] || 0), 0);
  return {
    ...preferred,
    rows,
    coverage: {
      ...(baseline?.coverage || preferred.coverage),
      primaryProductFamiliesCompared: rows.length,
      assignedPairCount,
      verifiedPairCount,
      rowsReturned: rows.length,
      truncated: Boolean(baseline?.coverage.truncated || preferred.coverage.truncated),
    },
    matching: {
      ...preferred.matching!,
      primaryProductsAssessed: assessed.size,
      candidatePairsAssessed: sumMetric("candidatePairsAssessed"),
      retrievalPairsScored: sumMetric("retrievalPairsScored"),
      judgeCalls: sumMetric("judgeCalls"),
      embeddingCalls: sumMetric("embeddingCalls"),
      durationMs: sumMetric("durationMs"),
      gaps: [...new Set(gaps)],
      selectedPrimaryIds: [...selected],
      assessedPrimaryIds: [...assessed].sort(),
      attempts: Math.max(ranked.length, requestCount),
    },
  } satisfies ProductComparison;
}

export function upsertProductComparisonBlock<T extends ReportDocument>(document: T, comparison: ProductComparison): T {
  const block: ReportBlock = { type: "product-comparison", id: "product-comparison", ...comparison };
  const found = document.blocks.some((item) => item.type === "product-comparison");
  return { ...document, blocks: found ? document.blocks.map((item) => item.type === "product-comparison" ? block : item) : [...document.blocks, block] } as T;
}

export function publishPricedProductComparison(comparison: ProductComparison): ProductComparison {
  let suppressedAcceptedPairs = 0;
  const reasons: Record<string, number> = {};
  const observedCurrencies = (product: ProductRecord) => new Set(product.priceSignals
    .filter((signal) => typeof signal.amount === "number" && Number.isFinite(signal.amount) && signal.amount > 0 && Boolean(String(signal.raw || "").trim()) && isSupportedCurrency(signal.currency))
    .map((signal) => String(signal.currency).trim().toUpperCase()));
  const completeObservedPrice = (product: ProductRecord) => hasValidObservedRivalPrice(product)
    && /^https?:\/\//i.test(product.sourceUrl)
    && Boolean(product.observedAt);
  const suppress = (reason: string) => {
    suppressedAcceptedPairs += 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  const rows = comparison.rows.map((row) => ({
    ...row,
    matches: row.matches.map((match) => {
      if (!match.product) return match;
      if (!completeObservedPrice(row.primary)) suppress("missing-valid-primary-price");
      else if (!completeObservedPrice(match.product)) suppress("missing-valid-rival-price");
      else {
        const primaryCurrencies = observedCurrencies(row.primary);
        const rivalCurrencies = observedCurrencies(match.product);
        if (primaryCurrencies.size === 1 && rivalCurrencies.size === 1 && [...primaryCurrencies][0] === [...rivalCurrencies][0]) return match;
        suppress("incompatible-price-currency");
      }
      return { ...match, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null, assessment: undefined };
    }),
  }));
  const assignedPairCount = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product).length, 0);
  const verifiedPairCount = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product && match.confidence === "Medium").length, 0);
  return {
    ...comparison,
    rows,
    coverage: { ...comparison.coverage, assignedPairCount, verifiedPairCount },
    matching: comparison.matching ? {
      ...comparison.matching,
      publication: { suppressedAcceptedPairs, reasons },
    } : comparison.matching,
  };
}
