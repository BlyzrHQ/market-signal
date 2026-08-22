import { hasValidObservedRivalPrice, isSupportedCurrency, productDecision, productIdentityKey, publicSourceMarketCountryCode, publicSourceMarketEvidence, type ProductComparison, type ProductMatch, type ProductRecord } from "./product-intelligence.ts";
import { canonicalDomain } from "./domain.ts";
import { publicHttpUrl } from "./public-url.ts";

export type ProductMatchLifecycle = "idle" | "matching" | "retrying" | "complete" | "limited";
export const MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY = 20;
const MAX_DURABLE_EVIDENCE_ROWS_BYTES = 1_200_000;

function compactEvidenceText(value: unknown, maxLength: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function durablePrimaryIdentity(product: ProductRecord) {
  if (/^[a-f0-9]{64}$/.test(product.recoveryIdentityHash || "")) return `bound:${product.recoveryIdentityHash}`;
  return JSON.stringify({
    id: product.id,
    domain: canonicalDomain(product.domain),
    name: compactEvidenceText(product.name, 220),
    normalizedName: product.normalizedName,
    category: compactEvidenceText(product.category, 160),
    type: product.jsonLdType,
    description: compactEvidenceText(product.description, 500),
    attributes: product.attributes.map((item) => compactEvidenceText(item, 100)).filter(Boolean).slice(0, 8),
    sourceUrl: product.sourceUrl,
    observedIdentifiers: product.identifiers ? { gtins: product.identifiers.gtins, sku: product.identifiers.sku || "", mpn: product.identifiers.mpn || "", brand: product.identifiers.brand || "" } : null,
    canonicalQuantity: product.quantity || null,
  });
}

function compactPricedEvidenceProduct(product: ProductRecord): ProductRecord {
  const identifiers = product.identifiers ? {
    gtins: product.identifiers.gtins.slice(0, 1),
    ...(product.identifiers.sku ? { sku: compactEvidenceText(product.identifiers.sku, 100) } : {}),
    ...(product.identifiers.mpn ? { mpn: compactEvidenceText(product.identifiers.mpn, 100) } : {}),
    ...(product.identifiers.brand ? { brand: compactEvidenceText(product.identifiers.brand, 100) } : {}),
  } : undefined;
  return {
    id: compactEvidenceText(product.id, 300),
    domain: product.domain,
    name: compactEvidenceText(product.name, 220),
    normalizedName: compactEvidenceText(product.normalizedName, 220),
    description: "",
    category: compactEvidenceText(product.category, 160),
    jsonLdType: product.jsonLdType,
    priceSignals: product.priceSignals.slice(0, 4).map((signal) => ({
      raw: compactEvidenceText(signal.raw, 120),
      ...(signal.currency ? { currency: compactEvidenceText(signal.currency, 8) } : {}),
      ...(typeof signal.amount === "number" ? { amount: signal.amount } : {}),
      ...(signal.period ? { period: compactEvidenceText(signal.period, 40) } : {}),
    })),
    attributes: [],
    ownership: product.ownership,
    extraction: product.extraction,
    confidence: product.confidence,
    sourceUrl: product.sourceUrl,
    imageUrl: "",
    observedAt: product.observedAt,
    claimIds: product.claimIds.slice(0, 2).map((claimId) => compactEvidenceText(claimId, 100)),
    ...(identifiers ? { identifiers } : {}),
    ...(product.quantity ? { quantity: product.quantity } : {}),
    ...(product.recoveryIdentityHash ? { recoveryIdentityHash: product.recoveryIdentityHash } : {}),
  };
}

function compactPricedEvidenceMatch(primary: ProductRecord, match: ProductMatch & { product: ProductRecord }): ProductMatch {
  const rival = compactPricedEvidenceProduct(match.product);
  const exactProduct = match.assessment?.verdict !== "close_substitute";
  return {
    domain: match.domain,
    product: rival,
    score: match.score,
    confidence: match.confidence,
    sharedTerms: [],
    claimIds: [],
    decision: productDecision(primary, rival, match.score, exactProduct),
    ...(match.assessment ? { assessment: {
      ...match.assessment,
      model: compactEvidenceText(match.assessment.model, 80),
      promptVersion: compactEvidenceText(match.assessment.promptVersion, 80),
      reasons: match.assessment.reasons.slice(0, 1).map((reason) => compactEvidenceText(reason, 160)),
      contradictions: match.assessment.contradictions.slice(0, 1).map((reason) => compactEvidenceText(reason, 160)),
      normalizedCategory: compactEvidenceText(match.assessment.normalizedCategory, 100),
      normalizedVariant: compactEvidenceText(match.assessment.normalizedVariant, 100),
      normalizedSize: compactEvidenceText(match.assessment.normalizedSize, 100),
      primarySourceUrl: "",
      rivalSourceUrl: "",
    } } : {}),
    publication: { priceEligible: true },
  };
}

function evidenceRowsWithinByteBudget(rows: ProductComparison["rows"], maxBytes = MAX_DURABLE_EVIDENCE_ROWS_BYTES) {
  const retained = rows.map((row) => ({ ...row, matches: row.matches.slice(0, 1) }));
  const byteLength = () => new TextEncoder().encode(JSON.stringify(retained)).byteLength;
  if (byteLength() > maxBytes) throw new Error("The minimum durable priced-evidence layer exceeds its persistence budget.");
  for (let alternativeIndex = 1; alternativeIndex < MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY; alternativeIndex += 1) {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const alternative = rows[rowIndex].matches[alternativeIndex];
      if (!alternative) continue;
      retained[rowIndex].matches.push(alternative);
      if (byteLength() > maxBytes) retained[rowIndex].matches.pop();
    }
  }
  return retained;
}

export function compactPublishedProductComparisonCheckpoint(comparison: ProductComparison): ProductComparison {
  const rows = comparison.rows.map((row) => {
    const primary = compactPricedEvidenceProduct(row.primary);
    return {
      primary,
      matches: row.matches.flatMap((match) => match.product && match.publication?.priceEligible === true
        ? [compactPricedEvidenceMatch(primary, match as ProductMatch & { product: ProductRecord })]
        : []),
    };
  });
  const retainedPrimaryIds = rows.map((row) => row.primary.id);
  return {
    ...comparison,
    rows,
    unmatched: [],
    comparisonDomains: [...new Set(rows.flatMap((row) => row.matches.map((match) => match.domain)))],
    matching: comparison.matching ? {
      ...comparison.matching,
      gaps: comparison.matching.gaps.map((gap) => compactEvidenceText(gap, 500)).slice(0, 20),
      selectedPrimaryIds: retainedPrimaryIds,
      assessedPrimaryIds: retainedPrimaryIds,
      processedPrimaryIds: retainedPrimaryIds,
      candidateSlotsByDomain: undefined,
    } : comparison.matching,
    enrichment: comparison.enrichment ? {
      ...comparison.enrichment,
      gaps: comparison.enrichment.gaps.slice(0, 20).map((gap) => ({
        ...gap,
        url: compactEvidenceText(gap.url, 2_048),
        reason: compactEvidenceText(gap.reason, 300),
        ...(gap.productId ? { productId: compactEvidenceText(gap.productId, 300) } : {}),
      })),
    } : comparison.enrichment,
  };
}

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

function processedIds(comparison: ProductComparison) {
  const explicit = matching(comparison)?.processedPrimaryIds || [];
  return new Set(explicit.length ? explicit : [...assessedIds(comparison)]);
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
  const processed = processedIds(comparison);
  return gapCount(comparison) > 0 || processed.size < selected.size;
}

export function shouldRetryProductMatch(comparison: ProductComparison | null | undefined, transportFailed = false) {
  if (transportFailed) return true;
  const unavailableBecauseUnconfigured = comparison?.matching?.available === false
    && comparison.matching.gaps.some((gap) => /not configured/i.test(gap));
  return !unavailableBecauseUnconfigured && hasProductMatchCoverageDefect(comparison);
}

function attemptRank(left: ProductComparison, right: ProductComparison) {
  const processedDifference = processedIds(right).size - processedIds(left).size;
  if (processedDifference) return processedDifference;
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
  const processed = new Set(ranked.flatMap((attempt) => [...processedIds(attempt)]));
  const unresolved = [...selected].filter((id) => !processed.has(id));
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
      primaryProductsScreened: selected.size,
      candidatePairsAssessed: sumMetric("candidatePairsAssessed"),
      retrievalPairsScored: sumMetric("retrievalPairsScored"),
      judgeCalls: sumMetric("judgeCalls"),
      embeddingCalls: sumMetric("embeddingCalls"),
      durationMs: sumMetric("durationMs"),
      gaps: [...new Set(gaps)],
      selectedPrimaryIds: [...selected],
      assessedPrimaryIds: [...assessed].sort(),
      processedPrimaryIds: [...processed].sort(),
      attempts: Math.max(ranked.length, requestCount),
    },
  } satisfies ProductComparison;
}

export function upsertProductComparisonBlock<T extends ReportDocument>(document: T, comparison: ProductComparison): T {
  const block: ReportBlock = { type: "product-comparison", id: "product-comparison", ...comparison };
  const found = document.blocks.some((item) => item.type === "product-comparison");
  return { ...document, blocks: found ? document.blocks.map((item) => item.type === "product-comparison" ? block : item) : [...document.blocks, block] } as T;
}

export function publishPricedProductComparison(comparison: ProductComparison, referenceTimeMs = Date.now()): ProductComparison {
  const now = Number.isFinite(referenceTimeMs) ? referenceTimeMs : Date.now();
  const maxObservationAgeMs = 366 * 24 * 60 * 60 * 1000;
  let suppressedAcceptedPairs = 0;
  const reasons: Record<string, number> = {};
  const observedCurrencies = (product: ProductRecord) => new Set(product.priceSignals
    .filter((signal) => typeof signal.amount === "number" && Number.isFinite(signal.amount) && signal.amount > 0 && Boolean(String(signal.raw || "").trim()) && isSupportedCurrency(signal.currency))
    .map((signal) => String(signal.currency).trim().toUpperCase()));
  const targetMarket = /^[A-Z]{2}$/.test(String(comparison.marketCountryCode || "").toUpperCase())
    ? String(comparison.marketCountryCode).toUpperCase()
    : "";
  const marketCompatible = (primary: ProductRecord, rival: ProductRecord) => {
    if (!targetMarket) return false;
    const primaryEvidence = publicSourceMarketEvidence(primary.sourceUrl);
    const rivalEvidence = publicSourceMarketEvidence(rival.sourceUrl);
    if (primaryEvidence.conflict || rivalEvidence.conflict) return false;
    if ((primaryEvidence.explicit && !primaryEvidence.countryCode) || (rivalEvidence.explicit && !rivalEvidence.countryCode)) return false;
    const primaryMarket = publicSourceMarketCountryCode(primary.sourceUrl);
    const rivalMarket = publicSourceMarketCountryCode(rival.sourceUrl);
    return primaryMarket === targetMarket && rivalMarket === targetMarket;
  };
  const validPublicSource = (product: ProductRecord) => {
    try {
      const url = new URL(publicHttpUrl(product.sourceUrl, false));
      return canonicalDomain(url.hostname) === canonicalDomain(product.domain);
    } catch { return false; }
  };
  const validObservedAt = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return false;
    const age = now - parsed;
    return age >= -(24 * 60 * 60 * 1000) && age <= maxObservationAgeMs;
  };
  const completeObservedPrice = (product: ProductRecord) => product.priceSignals.length > 0
    && product.priceSignals.every((signal) => typeof signal.amount === "number"
      && Number.isFinite(signal.amount)
      && signal.amount > 0
      && Boolean(String(signal.raw || "").trim())
      && isSupportedCurrency(signal.currency))
    && hasValidObservedRivalPrice(product)
    && validPublicSource(product)
    && validObservedAt(product.observedAt);
  const suppress = (reason: string) => {
    suppressedAcceptedPairs += 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  const rows = comparison.rows.map((row) => ({
    ...row,
    matches: row.matches.map((match) => {
      if (!match.product) return match;
      if (match.confidence !== "Medium") suppress("insufficient-match-confidence");
      else if (!completeObservedPrice(row.primary)) suppress("missing-valid-primary-price");
      else if (!completeObservedPrice(match.product)) suppress("missing-valid-rival-price");
      else if (!marketCompatible(row.primary, match.product)) suppress("incompatible-market");
      else {
        const primaryCurrencies = observedCurrencies(row.primary);
        const rivalCurrencies = observedCurrencies(match.product);
        if (primaryCurrencies.size === 1 && rivalCurrencies.size === 1 && [...primaryCurrencies][0] === [...rivalCurrencies][0]) {
          return { ...match, publication: { priceEligible: true } };
        }
        suppress("incompatible-price-currency");
      }
      const reason: NonNullable<ProductMatch["publication"]>["reason"] = match.confidence !== "Medium"
        ? "insufficient-match-confidence"
        : !completeObservedPrice(row.primary)
          ? "missing-valid-primary-price"
          : !completeObservedPrice(match.product)
            ? "missing-valid-rival-price"
            : !marketCompatible(row.primary, match.product)
              ? "incompatible-market"
            : "incompatible-price-currency";
      return {
        ...match,
        excludedProduct: match.product,
        product: null,
        decision: null,
        publication: { priceEligible: false, reason },
      };
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

export function limitPublishedProductComparison(comparison: ProductComparison, resultTarget: number): ProductComparison {
  const requestedTarget = Math.max(1, Math.floor(resultTarget));
  const target = requestedTarget;
  const candidates = comparison.rows.flatMap((row) => {
    const strongest = row.matches
      .filter((match) => match.product && match.publication?.priceEligible === true)
      .sort((left, right) => Number(right.assessment?.verdict === "same_product") - Number(left.assessment?.verdict === "same_product")
        || right.score - left.score
        || left.domain.localeCompare(right.domain))[0];
    return strongest ? [{ row, match: strongest }] : [];
  }).sort((left, right) => Number(right.match.assessment?.verdict === "same_product") - Number(left.match.assessment?.verdict === "same_product")
    || right.match.score - left.match.score
    || left.row.primary.id.localeCompare(right.row.primary.id));
  const selected = candidates.slice(0, target);
  const selectedByPrimary = new Map(selected.map(({ row, match }) => [row.primary.id, match]));
  const rows = comparison.rows.flatMap((row) => {
    const selectedMatch = selectedByPrimary.get(row.primary.id);
    if (!selectedMatch) return [];
    return [{
      ...row,
      matches: row.matches.map((match) => match === selectedMatch
        ? match
        : { domain: match.domain, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null }),
    }];
  });
  const publishedPrimaryProducts = rows.length;
  const resultShortfall = Math.max(0, target - publishedPrimaryProducts);
  const priorMatching = comparison.matching;
  const screened = priorMatching?.primaryProductsScreened || priorMatching?.primaryProductsAssessed || 0;
  const selectedIds = new Set(priorMatching?.selectedPrimaryIds || []);
  const completedIds = new Set(priorMatching?.processedPrimaryIds?.length ? priorMatching.processedPrimaryIds : priorMatching?.assessedPrimaryIds || []);
  const marketResolved = /^[A-Z]{2}$/.test(String(comparison.marketCountryCode || "").toUpperCase());
  const emptyRivalPool = priorMatching?.competitorProductsSynchronized === 0
    && priorMatching?.candidatePairsAssessed === 0;
  const matchingCompleted = priorMatching?.available === true
    && (marketResolved || emptyRivalPool)
    && priorMatching.gaps.length === 0
    && [...selectedIds].every((id) => completedIds.has(id));
  const enrichmentCompleted = !comparison.enrichment?.failedBatchCount
    && comparison.enrichment?.pagesTruncated !== true;
  const resultShortfallReason = resultShortfall
    ? matchingCompleted && enrichmentCompleted
      ? "bounded-candidate-pool-exhausted" as const
      : "processing-incomplete" as const
    : undefined;
  const shortfallGap = resultShortfall
    ? resultShortfallReason === "bounded-candidate-pool-exhausted"
      ? `Published ${publishedPrimaryProducts} of ${target} requested priced product comparisons after fully processing the bounded pool of ${screened} screened primary products; no additional eligible priced pair remained in that pool.`
      : `Published ${publishedPrimaryProducts} of ${target} requested priced product comparisons after screening ${screened} primary products; matching or enrichment did not fully process the bounded pool.`
    : "";
  return {
    ...comparison,
    rows,
    coverage: {
      ...comparison.coverage,
      primaryProductFamiliesCompared: publishedPrimaryProducts,
      assignedPairCount: publishedPrimaryProducts,
      verifiedPairCount: publishedPrimaryProducts,
      rowsReturned: publishedPrimaryProducts,
      rowLimit: target,
      truncated: candidates.length > target || comparison.coverage.truncated,
    },
    matching: priorMatching ? {
      ...priorMatching,
      primaryProductsScreened: screened,
      resultTarget: target,
      publishedPrimaryProducts,
      resultShortfall,
      resultShortfallReason,
      gaps: shortfallGap
        ? [...new Set([...priorMatching.gaps.filter((gap) => !/^Published \d+ of \d+ requested priced product comparisons/i.test(gap)), shortfallGap])]
        : priorMatching.gaps.filter((gap) => !/^Published \d+ of \d+ requested priced product comparisons/i.test(gap)),
    } : priorMatching,
  };
}

export function mergePublishedProductComparisonState(current: ProductComparison, prior: ProductComparison | null, resultTarget: number, referenceTimeMs = Date.now()) {
  const evaluated = (comparison: ProductComparison) => comparison.rows.some((row) => row.matches.some((match) => match.publication !== undefined))
    ? comparison
    : publishPricedProductComparison(comparison, referenceTimeMs);
  const publishedCurrent = evaluated(current);
  const publishedPrior = prior ? evaluated(prior) : null;
  const publishable = (row: ProductComparison["rows"][number]) => row.matches.some((match) => match.product && match.publication?.priceEligible === true);
  const currentRows = publishedCurrent.rows.filter(publishable);
  const currentIdentityById = new Map(publishedCurrent.rows.map((row) => [row.primary.id, durablePrimaryIdentity(row.primary)]));
  const priorRows = (publishedPrior?.rows.filter(publishable) || []).filter((row) => {
    const currentIdentity = currentIdentityById.get(row.primary.id);
    return currentIdentity === undefined || currentIdentity === durablePrimaryIdentity(row.primary);
  });
  const candidateRows: ProductComparison["rows"] = [];
  const rowByPrimary = new Map<string, number>();
  for (const row of [...currentRows, ...priorRows]) {
    const primaryIdentity = durablePrimaryIdentity(row.primary);
    const existingIndex = rowByPrimary.get(primaryIdentity);
    if (existingIndex === undefined) {
      rowByPrimary.set(primaryIdentity, candidateRows.length);
      candidateRows.push(row);
      continue;
    }
    const existing = candidateRows[existingIndex];
    candidateRows[existingIndex] = { ...existing, matches: [...existing.matches, ...row.matches] };
  }
  const rivalConstraintKeys = (product: ProductRecord) => [
    `physical:${productIdentityKey(product)}`,
    `merchant:${canonicalDomain(product.domain)}|${product.id}`,
  ];
  const candidates = candidateRows.map((row) => {
    const seen = new Set<string>();
    return row.matches
      .filter((match): match is ProductMatch & { product: ProductRecord } => Boolean(match.product && match.publication?.priceEligible === true))
      .sort((left, right) => Number(right.assessment?.verdict === "same_product") - Number(left.assessment?.verdict === "same_product")
        || right.score - left.score
        || productIdentityKey(left.product).localeCompare(productIdentityKey(right.product)))
      .filter((match) => {
        const keys = rivalConstraintKeys(match.product);
        if (keys.some((key) => seen.has(key))) return false;
        keys.forEach((key) => seen.add(key));
        return true;
      })
      .slice(0, MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY);
  });
  const allCandidates = candidates.flat();
  const parents = allCandidates.map((_match, index) => index);
  const findRoot = (index: number): number => parents[index] === index ? index : (parents[index] = findRoot(parents[index]));
  const unionCandidateComponents = (left: number, right: number) => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstByConstraint = new Map<string, number>();
  allCandidates.forEach((match, index) => {
    for (const key of rivalConstraintKeys(match.product)) {
      const first = firstByConstraint.get(key);
      if (first === undefined) firstByConstraint.set(key, index);
      else unionCandidateComponents(first, index);
    }
  });
  const candidateIndex = new Map(allCandidates.map((match, index) => [match, index]));
  const rivalAssignmentKey = (match: ProductMatch) => {
    const index = candidateIndex.get(match as ProductMatch & { product: ProductRecord });
    return index === undefined ? "missing-candidate" : `component:${findRoot(index)}`;
  };
  const rivalOwners = new Map<string, number>();
  const selectedByRow = new Map<number, ProductMatch>();
  const assignUniqueRival = (rowIndex: number, visitedRivals: Set<string>): boolean => {
    for (const match of candidates[rowIndex]) {
      const rivalKey = rivalAssignmentKey(match);
      if (visitedRivals.has(rivalKey)) continue;
      visitedRivals.add(rivalKey);
      const owner = rivalOwners.get(rivalKey);
      if (owner !== undefined && !assignUniqueRival(owner, visitedRivals)) continue;
      rivalOwners.set(rivalKey, rowIndex);
      selectedByRow.set(rowIndex, match);
      return true;
    }
    return false;
  };
  candidateRows.forEach((_row, rowIndex) => assignUniqueRival(rowIndex, new Set()));
  const rows = candidateRows.flatMap((row, rowIndex) => {
    const selected = selectedByRow.get(rowIndex);
    if (!selected) return [];
    return [{
      ...row,
      matches: row.matches.map((match) => match === selected
        ? match
        : { domain: match.domain, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null }),
    }];
  });
  const currentMatching = publishedCurrent.matching;
  const priorMatching = publishedPrior?.matching;
  const union = (left: string[] = [], right: string[] = []) => [...new Set([...left, ...right])];
  const merged: ProductComparison = {
    ...publishedCurrent,
    rows,
    coverage: {
      ...publishedCurrent.coverage,
      primaryProductFamiliesCompared: rows.length,
      rowsReturned: rows.length,
      assignedPairCount: rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product).length, 0),
      verifiedPairCount: rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product && match.confidence === "Medium").length, 0),
      truncated: Boolean(publishedCurrent.coverage.truncated || publishedPrior?.coverage.truncated),
    },
    matching: currentMatching ? {
      ...currentMatching,
      primaryProductsScreened: Math.max(currentMatching.primaryProductsScreened || 0, priorMatching?.primaryProductsScreened || 0),
      selectedPrimaryIds: union(currentMatching.selectedPrimaryIds, priorMatching?.selectedPrimaryIds),
      assessedPrimaryIds: union(currentMatching.assessedPrimaryIds, priorMatching?.assessedPrimaryIds).sort(),
      processedPrimaryIds: union(currentMatching.processedPrimaryIds, priorMatching?.processedPrimaryIds).sort(),
    } : currentMatching,
  };
  const limited = limitPublishedProductComparison(publishPricedProductComparison(merged, referenceTimeMs), resultTarget);
  const limitedComparison: ProductComparison = {
    ...limited,
    rows: limited.rows.map((row) => ({ ...row, matches: row.matches.filter((match) => match.product) })),
  };
  const comparison = limitedComparison.matching && currentMatching?.publication
    ? { ...limitedComparison, matching: { ...limitedComparison.matching, publication: currentMatching.publication } }
    : limitedComparison;
  const selectedPrimaryIds = new Set(comparison.rows.map((row) => row.primary.id));
  const evidenceCandidates = [
    ...candidateRows.filter((row) => selectedPrimaryIds.has(row.primary.id)),
    ...candidateRows.filter((row) => !selectedPrimaryIds.has(row.primary.id)),
  ].slice(0, Math.max(1, Math.floor(resultTarget)));
  const uncompactedEvidenceRows = evidenceCandidates.map((row) => {
    const compactPrimary = compactPricedEvidenceProduct(row.primary);
    const seenRivals = new Set<string>();
    const selected = selectedByRow.get(candidateRows.indexOf(row));
    const matches = row.matches.filter((match): match is ProductMatch & { product: ProductRecord } => {
      if (!match.product || match.publication?.priceEligible !== true) return false;
      const keys = rivalConstraintKeys(match.product);
      if (keys.some((key) => seenRivals.has(key))) return false;
      keys.forEach((key) => seenRivals.add(key));
      return true;
    }).sort((left, right) => Number(right === selected) - Number(left === selected))
      .slice(0, MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY).map((match) => compactPricedEvidenceMatch(compactPrimary, match));
    return { primary: compactPrimary, matches };
  });
  const evidenceRows = evidenceRowsWithinByteBudget(uncompactedEvidenceRows);
  const evidencePrimaryIds = evidenceRows.map((row) => row.primary.id);
  const evidence: ProductComparison = {
    ...comparison,
    rows: evidenceRows,
    coverage: {
      ...comparison.coverage,
      primaryProductFamiliesCompared: evidenceRows.length,
      rowsReturned: evidenceRows.length,
      assignedPairCount: evidenceRows.reduce((sum, row) => sum + row.matches.length, 0),
      verifiedPairCount: evidenceRows.reduce((sum, row) => sum + row.matches.filter((match) => match.confidence === "Medium").length, 0),
    },
    matching: comparison.matching ? {
      ...comparison.matching,
      selectedPrimaryIds: evidencePrimaryIds,
      assessedPrimaryIds: evidencePrimaryIds,
      processedPrimaryIds: evidencePrimaryIds,
      gaps: comparison.matching.gaps.slice(0, 4).map((gap) => compactEvidenceText(gap, 240)),
    } : comparison.matching,
  };
  return { comparison, evidence };
}

export function mergePublishedProductComparisons(current: ProductComparison, prior: ProductComparison | null, resultTarget: number, referenceTimeMs = Date.now()) {
  return mergePublishedProductComparisonState(current, prior, resultTarget, referenceTimeMs).comparison;
}
