import { createHash } from "node:crypto";
import { canonicalProductSourceKey, hasPriceCurrencyIntegrity, hasValidObservedRivalPrice, isSupportedCurrency, productDecision, productIdentityKey, publicSourceMarketCountryCode, publicSourceMarketEvidence, type ProductComparison, type ProductMatch, type ProductRecord } from "./product-intelligence.ts";
import { canonicalDomain } from "./domain.ts";
import { canonicalGtin } from "./product-normalization.ts";
import { publicHttpUrl } from "./public-url.ts";

export type ProductMatchLifecycle = "idle" | "matching" | "retrying" | "complete" | "limited";
export const MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY = 20;
const MAX_DURABLE_EVIDENCE_ROWS_BYTES = 3_500_000;

function compactEvidenceText(value: unknown, maxLength: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function durablePrimaryIdentity(product: ProductRecord) {
  if (/^[a-f0-9]{64}$/.test(product.recoveryIdentityHash || "")) return `bound:${product.recoveryIdentityHash}`;
  return JSON.stringify({
    id: product.id,
    domain: canonicalDomain(product.domain),
    name: compactEvidenceText(product.name, 120),
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
  const durableGtins = [...new Set(product.identifiers?.gtins.map(canonicalGtin).filter((gtin): gtin is string => Boolean(gtin)) || [])].slice(0, 20);
  const identifiers = product.identifiers ? {
    gtins: durableGtins,
    ...(product.identifiers.sku ? { sku: compactEvidenceText(product.identifiers.sku, 100) } : {}),
    ...(product.identifiers.mpn ? { mpn: compactEvidenceText(product.identifiers.mpn, 100) } : {}),
    ...(product.identifiers.brand ? { brand: compactEvidenceText(product.identifiers.brand, 100) } : {}),
  } : undefined;
  return {
    id: compactEvidenceText(product.id, 300),
    domain: product.domain,
    name: compactEvidenceText(product.name, 120),
    // The durable layer is a priced assignment graph, not a second catalog
    // snapshot. The display name, immutable identifiers, source, quantity and
    // price are sufficient to revalidate identity and publication. Omitting the
    // duplicated normalized/category prose keeps every bounded alternative
    // edge instead of making recovery depend on string length.
    normalizedName: "",
    description: "",
    category: product.category.startsWith("saas-plan") ? compactEvidenceText(product.category, 40) : "",
    jsonLdType: product.jsonLdType,
    priceSignals: product.priceSignals.slice(0, 1).map((signal) => ({
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
    claimIds: [],
    ...(identifiers ? { identifiers } : {}),
    ...(product.quantity ? { quantity: product.quantity } : {}),
    ...(product.recoveryIdentityHash ? { recoveryIdentityHash: product.recoveryIdentityHash } : {}),
    ...(product.assignmentComponentHash ? { assignmentComponentHash: product.assignmentComponentHash } : {}),
  };
}

function compactPricedEvidenceMatch(primary: ProductRecord, match: ProductMatch & { product: ProductRecord }, assignmentComponentHash = ""): ProductMatch {
  const rival = { ...compactPricedEvidenceProduct(match.product), ...(assignmentComponentHash ? { assignmentComponentHash } : {}) };
  return {
    domain: match.domain,
    product: rival,
    score: match.score,
    confidence: match.confidence,
    sharedTerms: [],
    claimIds: [],
    // Decision prose is reproducible from the retained products and score. It
    // is restored only for the globally selected edge, instead of being
    // duplicated across every durable backup edge.
    decision: null,
    ...(match.assessment?.verdict === "close_substitute" ? { assessment: {
      method: match.assessment.method,
      claimType: match.assessment.claimType,
      verdict: match.assessment.verdict,
      confidence: match.assessment.confidence,
      model: "",
      promptVersion: "",
      reasons: [],
      contradictions: [],
      normalizedCategory: "",
      normalizedVariant: "",
      normalizedSize: "",
      primarySourceUrl: "",
      rivalSourceUrl: "",
    } } : {}),
    publication: { priceEligible: true },
  };
}

function exactProductPriority(match: ProductMatch) {
  // Accepted legacy and compact same-product evidence may omit the assessment;
  // close substitutes are always retained explicitly so retry ranking is stable.
  return Number(!match.assessment || match.assessment.verdict === "same_product");
}

export function durablePublishedMatchAssessment(primary: ProductRecord, match: ProductMatch, comparison: ProductComparison): ProductMatch["assessment"] | null {
  if (comparison.matching?.method === "direct-web-search") {
    if (!match.product || match.publication?.priceEligible !== true) return null;
    return {
      method: "direct-web-search",
      claimType: "Inferred",
      verdict: "search_result",
      confidence: typeof match.score === "number" && Number.isFinite(match.score) ? match.score : 0,
      model: comparison.matching.model || "",
      promptVersion: comparison.matching.promptVersion || "direct-product-search-v1",
      reasons: ["Returned by a direct web search for the primary product and verified as a public product page with a positive observed price."],
      contradictions: [],
      normalizedCategory: "",
      normalizedVariant: "",
      normalizedSize: "",
      primarySourceUrl: primary.sourceUrl,
      rivalSourceUrl: match.product.sourceUrl,
    };
  }
  if (match.assessment && ["same_product", "close_substitute"].includes(match.assessment.verdict)) return match.assessment;
  if (!match.product || match.publication?.priceEligible !== true) return null;
  // Compact durable checkpoints intentionally encode an accepted exact match
  // by omitting the prose-heavy assessment. Rehydrate only the semantic fields
  // already proven by the publication gate; never infer an unpublished edge.
  return {
    method: "ai-hybrid",
    claimType: "Inferred",
    verdict: "same_product",
    confidence: typeof match.score === "number" && Number.isFinite(match.score) ? match.score : 0,
    model: comparison.matching?.model || "",
    promptVersion: comparison.matching?.promptVersion || "",
    reasons: [],
    contradictions: [],
    normalizedCategory: "",
    normalizedVariant: "",
    normalizedSize: "",
    primarySourceUrl: primary.sourceUrl,
    rivalSourceUrl: match.product.sourceUrl,
  };
}

function evidenceRowsWithinByteBudget(rows: ProductComparison["rows"], maxBytes = MAX_DURABLE_EVIDENCE_ROWS_BYTES) {
  const byteLength = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
  if (byteLength > maxBytes) throw new Error("The complete durable priced-evidence graph exceeds its persistence budget.");
  return rows;
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
  if (!comparison?.matching || !comparison.matching.available) return true;
  if (comparison.matching.method === "direct-web-search") return comparison.matching.resultShortfallReason === "processing-incomplete";
  if (comparison.matching.method !== "ai-hybrid") return true;
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
  const usable = attempts.filter((attempt) => (attempt.matching?.method === "ai-hybrid" || attempt.matching?.method === "direct-web-search") && attempt.matching.available);
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
    ? [...preferredGaps, `${preferred.matching?.method === "direct-web-search" ? "Direct product search did not process" : "AI product matching did not assess"} ${unresolved.length} selected primary product${unresolved.length === 1 ? "" : "s"} after the bounded retry.`]
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
    && hasPriceCurrencyIntegrity(product)
    && validPublicSource(product)
    && validObservedAt(product.observedAt);
  const suppress = (reason: string) => {
    suppressedAcceptedPairs += 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  const rows = comparison.rows.map((row) => ({
    ...row,
    matches: row.matches.flatMap((match) => {
      if (!match.product) return comparison.matching?.method === "direct-web-search" ? [] : [match];
      const directSearch = comparison.matching?.method === "direct-web-search";
      if (directSearch) {
        if (!completeObservedPrice(row.primary)) {
          suppress("missing-valid-primary-price");
          return [];
        }
        if (!completeObservedPrice(match.product)) {
          suppress("missing-valid-rival-price");
          return [];
        }
        return [{ ...match, publication: { priceEligible: true } }];
      }
      if (match.confidence !== "Medium") suppress("insufficient-match-confidence");
      else if (!completeObservedPrice(row.primary)) suppress("missing-valid-primary-price");
      else if (!completeObservedPrice(match.product)) suppress("missing-valid-rival-price");
      else if (!marketCompatible(row.primary, match.product)) suppress("incompatible-market");
      else {
        const primaryCurrencies = observedCurrencies(row.primary);
        const rivalCurrencies = observedCurrencies(match.product);
        if (primaryCurrencies.size === 1 && rivalCurrencies.size === 1 && [...primaryCurrencies][0] === [...rivalCurrencies][0]) {
          return [{ ...match, publication: { priceEligible: true } }];
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
      return [{
        ...match,
        excludedProduct: match.product,
        product: null,
        decision: null,
        publication: { priceEligible: false, reason },
      }];
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

type PublishedResultTargetKind = "primary-products" | "pairs";

function compareCodepoint(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function primaryAlphabeticalKey(product: ProductRecord) {
  return String(product.name || product.normalizedName || "").normalize("NFKC").toLowerCase();
}

function publishedPairCount(comparison: ProductComparison) {
  return comparison.rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product).length, 0);
}

export function limitPublishedProductComparison(comparison: ProductComparison, resultTarget: number, targetKind: PublishedResultTargetKind = "primary-products"): ProductComparison {
  const requestedTarget = Math.max(1, Math.floor(resultTarget));
  const target = requestedTarget;
  if (targetKind === "pairs") {
    let remaining = target;
    const rows = [...comparison.rows]
      .sort((left, right) => compareCodepoint(primaryAlphabeticalKey(left.primary), primaryAlphabeticalKey(right.primary))
        || compareCodepoint(left.primary.normalizedName, right.primary.normalizedName)
        || compareCodepoint(left.primary.id, right.primary.id)
        || compareCodepoint(left.primary.sourceUrl, right.primary.sourceUrl))
      .flatMap((row) => {
        if (remaining <= 0) return [];
        const matches = row.matches
          .filter((match): match is ProductMatch & { product: ProductRecord } => Boolean(match.product && match.publication?.priceEligible === true))
          .sort((left, right) => exactProductPriority(right) - exactProductPriority(left)
            || right.score - left.score
            || compareCodepoint(productIdentityKey(left.product), productIdentityKey(right.product))
            || compareCodepoint(left.product.sourceUrl, right.product.sourceUrl))
          .slice(0, remaining);
        remaining -= matches.length;
        return matches.length ? [{ ...row, matches }] : [];
      });
    const pairs = publishedPairCount({ ...comparison, rows });
    const publishedPrimaryProducts = rows.length;
    const resultShortfall = Math.max(0, target - pairs);
    const priorMatching = comparison.matching;
    const screened = priorMatching?.primaryProductsScreened || priorMatching?.primaryProductsAssessed || 0;
    const selectedIds = new Set(priorMatching?.selectedPrimaryIds || []);
    const completedIds = new Set(priorMatching?.processedPrimaryIds?.length ? priorMatching.processedPrimaryIds : priorMatching?.assessedPrimaryIds || []);
    const marketResolved = /^[A-Z]{2}$/.test(String(comparison.marketCountryCode || "").toUpperCase());
    const emptyRivalPool = priorMatching?.competitorProductsSynchronized === 0 && priorMatching?.candidatePairsAssessed === 0;
    const matchingCompleted = priorMatching?.available === true
      && (priorMatching.method === "direct-web-search"
        ? priorMatching.resultShortfallReason !== "processing-incomplete"
        : (marketResolved || emptyRivalPool) && priorMatching.gaps.length === 0)
      && [...selectedIds].every((id) => completedIds.has(id));
    const enrichmentCompleted = !comparison.enrichment?.failedBatchCount && comparison.enrichment?.pagesTruncated !== true;
    const resultShortfallReason = resultShortfall
      ? matchingCompleted && enrichmentCompleted ? "bounded-candidate-pool-exhausted" as const : "processing-incomplete" as const
      : undefined;
    const shortfallGap = resultShortfall
      ? resultShortfallReason === "bounded-candidate-pool-exhausted"
        ? `Published ${pairs} of ${target} requested priced product comparisons after fully processing the bounded pool of ${screened} screened primary products; no additional eligible priced pair remained in that pool.`
        : `Published ${pairs} of ${target} requested priced product comparisons after screening ${screened} primary products; matching or enrichment did not fully process the bounded pool.`
      : "";
    return {
      ...comparison,
      rows,
      coverage: {
        ...comparison.coverage,
        primaryProductFamiliesCompared: publishedPrimaryProducts,
        assignedPairCount: pairs,
        verifiedPairCount: rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product && match.confidence === "Medium").length, 0),
        rowsReturned: publishedPrimaryProducts,
        rowLimit: target,
        truncated: pairs > target || comparison.coverage.truncated,
      },
      matching: priorMatching ? {
        ...priorMatching,
        primaryProductsScreened: screened,
        resultTarget: target,
        publishedPairs: pairs,
        publishedPrimaryProducts,
        resultShortfall,
        resultShortfallReason,
        gaps: shortfallGap
          ? [...new Set([...priorMatching.gaps.filter((gap) => !/^Published \d+ of \d+ requested priced product comparisons/i.test(gap)), shortfallGap])]
          : priorMatching.gaps.filter((gap) => !/^Published \d+ of \d+ requested priced product comparisons/i.test(gap)),
      } : priorMatching,
    };
  }
  const candidates = comparison.rows.flatMap((row) => {
    const strongest = row.matches
      .filter((match) => match.product && match.publication?.priceEligible === true)
      .sort((left, right) => exactProductPriority(right) - exactProductPriority(left)
        || right.score - left.score
        || left.domain.localeCompare(right.domain))[0];
    return strongest ? [{ row, match: strongest }] : [];
  }).sort((left, right) => exactProductPriority(right.match) - exactProductPriority(left.match)
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
    && (priorMatching.method === "direct-web-search"
      ? priorMatching.resultShortfallReason !== "processing-incomplete"
      : (marketResolved || emptyRivalPool) && priorMatching.gaps.length === 0)
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

function mergePublishedPairComparisonState(current: ProductComparison, prior: ProductComparison | null, resultTarget: number, referenceTimeMs: number) {
  const target = Math.min(1_000, Math.max(1, Math.floor(resultTarget)));
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
    const identity = durablePrimaryIdentity(row.primary);
    const index = rowByPrimary.get(identity);
    if (index === undefined) {
      rowByPrimary.set(identity, candidateRows.length);
      candidateRows.push(row);
    } else {
      candidateRows[index] = { ...candidateRows[index], matches: [...candidateRows[index].matches, ...row.matches] };
    }
  }
  candidateRows.sort((left, right) => compareCodepoint(primaryAlphabeticalKey(left.primary), primaryAlphabeticalKey(right.primary))
    || compareCodepoint(left.primary.normalizedName, right.primary.normalizedName)
    || compareCodepoint(left.primary.id, right.primary.id)
    || compareCodepoint(left.primary.sourceUrl, right.primary.sourceUrl));

  const rivalConstraintKeys = (product: ProductRecord) => {
    const source = canonicalProductSourceKey(product);
    const domain = canonicalDomain(product.domain);
    const market = publicSourceMarketCountryCode(product.sourceUrl) || "";
    const gtins = [...new Set((product.identifiers?.gtins || []).map(canonicalGtin).filter((gtin): gtin is string => Boolean(gtin)))];
    return [
      `physical:${productIdentityKey(product)}`,
      ...gtins.map((gtin) => `gtin:${domain}|${market}|${gtin}`),
      ...(source ? [`source:${source}`] : []),
      `merchant:${domain}|${product.id}`,
      ...(/^[a-f0-9]{64}$/.test(product.assignmentComponentHash || "") ? [`assignment:${product.assignmentComponentHash}`] : []),
    ];
  };
  const rankedCandidates = candidateRows.map((row) => row.matches
    .filter((match): match is ProductMatch & { product: ProductRecord } => Boolean(match.product && match.publication?.priceEligible === true))
    .sort((left, right) => exactProductPriority(right) - exactProductPriority(left)
      || right.score - left.score
      || compareCodepoint(productIdentityKey(left.product), productIdentityKey(right.product))
      || compareCodepoint(left.product.sourceUrl, right.product.sourceUrl)));
  const allCandidates = rankedCandidates.flat();
  const parents = allCandidates.map((_match, index) => index);
  const findRoot = (index: number): number => parents[index] === index ? index : (parents[index] = findRoot(parents[index]));
  const union = (left: number, right: number) => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstByConstraint = new Map<string, number>();
  allCandidates.forEach((match, index) => {
    for (const key of rivalConstraintKeys(match.product)) {
      const first = firstByConstraint.get(key);
      if (first === undefined) firstByConstraint.set(key, index);
      else union(first, index);
    }
  });
  const candidateIndex = new Map(allCandidates.map((match, index) => [match, index]));
  const componentKey = (match: ProductMatch) => {
    const index = candidateIndex.get(match as ProductMatch & { product: ProductRecord });
    return index === undefined ? "missing" : `component:${findRoot(index)}`;
  };
  const componentConstraints = new Map<number, Set<string>>();
  allCandidates.forEach((match, index) => {
    const root = findRoot(index);
    const constraints = componentConstraints.get(root) || new Set<string>();
    rivalConstraintKeys(match.product).forEach((key) => constraints.add(key));
    componentConstraints.set(root, constraints);
  });
  const componentHash = (match: ProductMatch) => {
    const index = candidateIndex.get(match as ProductMatch & { product: ProductRecord });
    if (index === undefined) return "";
    const root = findRoot(index);
    const members = allCandidates.filter((_candidate, memberIndex) => findRoot(memberIndex) === root);
    const priorHashes = [...new Set(members.map((member) => member.product.assignmentComponentHash || "").filter((hash) => /^[a-f0-9]{64}$/.test(hash)))];
    if (members.length === 1 && priorHashes.length <= 1) return priorHashes[0] || "";
    return createHash("sha256").update(JSON.stringify([...(componentConstraints.get(root) || [])].sort())).digest("hex");
  };
  const dedupedCandidates = rankedCandidates.map((matches) => {
    const seen = new Set<string>();
    return matches.filter((match) => {
      const key = componentKey(match);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  const usedComponents = new Set<string>();
  const selectedByRow = new Map<number, Set<ProductMatch>>();
  let selectedCount = 0;
  for (let rowIndex = 0; rowIndex < candidateRows.length && selectedCount < target; rowIndex += 1) {
    const selected = new Set<ProductMatch>();
    for (const match of dedupedCandidates[rowIndex]) {
      const key = componentKey(match);
      if (usedComponents.has(key)) continue;
      usedComponents.add(key);
      selected.add(match);
      selectedCount += 1;
      if (selectedCount >= target) break;
    }
    if (selected.size) selectedByRow.set(rowIndex, selected);
  }
  const rows = candidateRows.flatMap((row, rowIndex) => {
    const selected = selectedByRow.get(rowIndex);
    if (!selected) return [];
    return [{
      ...row,
      matches: dedupedCandidates[rowIndex].filter((match) => selected.has(match)).map((match) => ({
        ...match,
        decision: match.product
          ? (match.decision || productDecision(row.primary, match.product, match.score, match.assessment?.verdict !== "close_substitute"))
          : null,
      })),
    }];
  });
  const currentMatching = publishedCurrent.matching;
  const priorMatching = publishedPrior?.matching;
  const unionIds = (left: string[] = [], right: string[] = []) => [...new Set([...left, ...right])];
  const merged: ProductComparison = {
    ...publishedCurrent,
    rows,
    coverage: {
      ...publishedCurrent.coverage,
      primaryProductFamiliesCompared: rows.length,
      rowsReturned: rows.length,
      assignedPairCount: selectedCount,
      verifiedPairCount: rows.reduce((sum, row) => sum + row.matches.filter((match) => match.confidence === "Medium").length, 0),
      truncated: selectedCount > target || Boolean(publishedCurrent.coverage.truncated || publishedPrior?.coverage.truncated),
    },
    matching: currentMatching ? {
      ...currentMatching,
      primaryProductsScreened: Math.max(currentMatching.primaryProductsScreened || 0, priorMatching?.primaryProductsScreened || 0),
      selectedPrimaryIds: unionIds(currentMatching.selectedPrimaryIds, priorMatching?.selectedPrimaryIds),
      assessedPrimaryIds: unionIds(currentMatching.assessedPrimaryIds, priorMatching?.assessedPrimaryIds).sort(),
      processedPrimaryIds: unionIds(currentMatching.processedPrimaryIds, priorMatching?.processedPrimaryIds).sort(),
    } : currentMatching,
  };
  const comparison = limitPublishedProductComparison(publishPricedProductComparison(merged, referenceTimeMs), target, "pairs");
  const allEvidenceEntries = candidateRows.flatMap((row, rowIndex) => {
    const compactPrimary = compactPricedEvidenceProduct(row.primary);
    const selected = selectedByRow.get(rowIndex) || new Set<ProductMatch>();
    const ordered = [
      ...dedupedCandidates[rowIndex].filter((match) => selected.has(match)),
      ...dedupedCandidates[rowIndex].filter((match) => !selected.has(match)).slice(0, MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY),
    ];
    return ordered.length ? [{
      selectedCount: selected.size,
      row: {
        primary: compactPrimary,
        matches: ordered.map((match) => compactPricedEvidenceMatch(compactPrimary, match, componentHash(match))),
      },
    }] : [];
  });
  const selectedEvidenceEntries = allEvidenceEntries.filter((entry) => entry.selectedCount > 0);
  const evidenceEntries = [
    ...selectedEvidenceEntries,
    ...allEvidenceEntries.filter((entry) => entry.selectedCount === 0).slice(0, Math.max(0, target - selectedEvidenceEntries.length)),
  ];
  const evidenceRows = evidenceEntries.map((entry) => entry.row);
  let durableRows = evidenceRows;
  try {
    evidenceRowsWithinByteBudget(durableRows, MAX_DURABLE_EVIDENCE_ROWS_BYTES);
  } catch {
    durableRows = evidenceRows.map((row, rowIndex) => ({
      ...row,
      matches: row.matches.slice(0, evidenceEntries[rowIndex].selectedCount),
    })).filter((row) => row.matches.length > 0);
    evidenceRowsWithinByteBudget(durableRows, MAX_DURABLE_EVIDENCE_ROWS_BYTES);
  }
  const evidencePrimaryIds = durableRows.map((row) => row.primary.id);
  const evidence: ProductComparison = {
    ...comparison,
    rows: durableRows,
    coverage: {
      ...comparison.coverage,
      primaryProductFamiliesCompared: durableRows.length,
      rowsReturned: durableRows.length,
      assignedPairCount: durableRows.reduce((sum, row) => sum + row.matches.length, 0),
      verifiedPairCount: durableRows.reduce((sum, row) => sum + row.matches.filter((match) => match.confidence === "Medium").length, 0),
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

export function mergePublishedProductComparisonState(current: ProductComparison, prior: ProductComparison | null, resultTarget: number, referenceTimeMs = Date.now(), targetKind: PublishedResultTargetKind = "primary-products") {
  if (targetKind === "pairs") return mergePublishedPairComparisonState(current, prior, resultTarget, referenceTimeMs);
  const boundedResultTarget = Math.min(MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY, Math.max(1, Math.floor(resultTarget)));
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
  candidateRows.sort((left, right) => durablePrimaryIdentity(left.primary).localeCompare(durablePrimaryIdentity(right.primary))
    || left.primary.id.localeCompare(right.primary.id)
    || left.primary.sourceUrl.localeCompare(right.primary.sourceUrl));
  const rivalConstraintKeys = (product: ProductRecord) => {
    const source = canonicalProductSourceKey(product);
    const domain = canonicalDomain(product.domain);
    const market = publicSourceMarketCountryCode(product.sourceUrl) || "";
    const gtins = [...new Set((product.identifiers?.gtins || []).map(canonicalGtin).filter((gtin): gtin is string => Boolean(gtin)))];
    return [
      `physical:${productIdentityKey(product)}`,
      ...gtins.map((gtin) => `gtin:${domain}|${market}|${gtin}`),
      ...(source ? [`source:${source}`] : []),
      `merchant:${domain}|${product.id}`,
      ...(/^[a-f0-9]{64}$/.test(product.assignmentComponentHash || "") ? [`assignment:${product.assignmentComponentHash}`] : []),
    ];
  };
  const rankedCandidates = candidateRows.map((row) => {
    return row.matches
      .filter((match): match is ProductMatch & { product: ProductRecord } => Boolean(match.product && match.publication?.priceEligible === true))
      .sort((left, right) => exactProductPriority(right) - exactProductPriority(left)
        || right.score - left.score
        || productIdentityKey(left.product).localeCompare(productIdentityKey(right.product)));
  });
  const allCandidates = rankedCandidates.flat();
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
  const componentConstraints = new Map<number, Set<string>>();
  const componentAssignmentHashes = new Map<number, Set<string>>();
  const componentMemberCounts = new Map<number, number>();
  allCandidates.forEach((match, index) => {
    const root = findRoot(index);
    componentMemberCounts.set(root, (componentMemberCounts.get(root) || 0) + 1);
    const constraints = componentConstraints.get(root) || new Set<string>();
    rivalConstraintKeys(match.product).forEach((key) => constraints.add(key));
    componentConstraints.set(root, constraints);
    const priorHash = match.product.assignmentComponentHash || "";
    if (/^[a-f0-9]{64}$/.test(priorHash)) {
      const hashes = componentAssignmentHashes.get(root) || new Set<string>();
      hashes.add(priorHash);
      componentAssignmentHashes.set(root, hashes);
    }
  });
  const componentHashByRoot = new Map([...componentConstraints.entries()].map(([root, constraints]) => [
    root,
    componentAssignmentHashes.get(root)?.size === 1
      ? [...componentAssignmentHashes.get(root)!][0]
      : (componentAssignmentHashes.get(root)?.size || 0) > 1 || (componentMemberCounts.get(root) || 0) > 1
        ? createHash("sha256").update(JSON.stringify([...constraints].sort())).digest("hex")
        : "",
  ]));
  const candidateIndex = new Map(allCandidates.map((match, index) => [match, index]));
  const rivalAssignmentKey = (match: ProductMatch) => {
    const index = candidateIndex.get(match as ProductMatch & { product: ProductRecord });
    return index === undefined ? "missing-candidate" : `component:${findRoot(index)}`;
  };
  const rivalAssignmentHash = (match: ProductMatch) => {
    const index = candidateIndex.get(match as ProductMatch & { product: ProductRecord });
    return index === undefined ? "" : componentHashByRoot.get(findRoot(index)) || "";
  };
  // Collapse transitive source/merchant/physical aliases before applying the
  // per-primary cap. Twenty distinct rival components are sufficient for a
  // twenty-row assignment; twenty raw edges are not when aliases collapse.
  const candidates = rankedCandidates.map((matches) => {
    const seenComponents = new Set<string>();
    return matches.filter((match) => {
      const component = rivalAssignmentKey(match);
      if (seenComponents.has(component)) return false;
      seenComponents.add(component);
      return true;
    }).slice(0, MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY);
  });

  type ResidualEdge = { to: number; reverse: number; capacity: number; cost: number; match?: ProductMatch; rowIndex?: number };
  const componentKeys = [...new Set(candidates.flatMap((matches) => matches.map(rivalAssignmentKey)))];
  const rowNodeStart = 1;
  const componentNodeStart = rowNodeStart + candidateRows.length;
  const sink = componentNodeStart + componentKeys.length;
  const graph: ResidualEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const addEdge = (from: number, to: number, capacity: number, cost: number, metadata: Pick<ResidualEdge, "match" | "rowIndex"> = {}) => {
    const forward: ResidualEdge = { to, reverse: graph[to].length, capacity, cost, ...metadata };
    const reverse: ResidualEdge = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  };
  const componentNodeByKey = new Map(componentKeys.map((key, index) => [key, componentNodeStart + index]));
  const flowTarget = Math.min(boundedResultTarget, candidateRows.length);
  const exactBonus = flowTarget + 1;
  const assignmentEdges: ResidualEdge[] = [];
  for (let rowIndex = 0; rowIndex < candidateRows.length; rowIndex += 1) {
    const rowNode = rowNodeStart + rowIndex;
    addEdge(0, rowNode, 1, 0);
    for (const match of candidates[rowIndex]) {
      const componentNode = componentNodeByKey.get(rivalAssignmentKey(match));
      if (componentNode === undefined) continue;
      const benefit = (exactProductPriority(match) * exactBonus) + Math.max(0, Math.min(1, match.score));
      assignmentEdges.push(addEdge(rowNode, componentNode, 1, -benefit, { match, rowIndex }));
    }
  }
  for (const componentNode of componentNodeByKey.values()) addEdge(componentNode, sink, 1, 0);

  for (let flow = 0; flow < flowTarget; flow += 1) {
    const distance = Array(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array(graph.length).fill(-1);
    const previousEdge = Array(graph.length).fill(-1);
    const queued = Array(graph.length).fill(false);
    const queue = [0];
    distance[0] = 0;
    queued[0] = true;
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      queued[node] = false;
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
        const edge = graph[node][edgeIndex];
        const nextDistance = distance[node] + edge.cost;
        if (edge.capacity <= 0 || nextDistance >= distance[edge.to]) continue;
        distance[edge.to] = nextDistance;
        previousNode[edge.to] = node;
        previousEdge[edge.to] = edgeIndex;
        if (!queued[edge.to]) {
          queued[edge.to] = true;
          queue.push(edge.to);
        }
      }
    }
    if (previousNode[sink] < 0) break;
    for (let node = sink; node !== 0; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]];
      edge.capacity -= 1;
      graph[node][edge.reverse].capacity += 1;
    }
  }

  const selectedByRow = new Map<number, ProductMatch>();
  for (const edge of assignmentEdges) if (edge.capacity === 0 && edge.match !== undefined && edge.rowIndex !== undefined) selectedByRow.set(edge.rowIndex, edge.match);
  const rows = candidateRows.flatMap((row, rowIndex) => {
    const selected = selectedByRow.get(rowIndex);
    if (!selected) return [];
    return [{
      ...row,
      matches: row.matches.map((match) => match === selected
        ? {
          ...match,
          decision: match.product
            ? (match.decision || productDecision(row.primary, match.product, match.score, match.assessment?.verdict !== "close_substitute"))
            : null,
        }
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
  const limited = limitPublishedProductComparison(publishPricedProductComparison(merged, referenceTimeMs), boundedResultTarget);
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
  ].slice(0, boundedResultTarget);
  const uncompactedEvidenceRows = evidenceCandidates.map((row) => {
    const compactPrimary = compactPricedEvidenceProduct(row.primary);
    const seenComponents = new Set<string>();
    const selected = selectedByRow.get(candidateRows.indexOf(row));
    const matches = row.matches.filter((match): match is ProductMatch & { product: ProductRecord } => Boolean(match.product && match.publication?.priceEligible === true))
      .sort((left, right) => Number(right === selected) - Number(left === selected)
        || exactProductPriority(right) - exactProductPriority(left)
        || right.score - left.score)
      .filter((match) => {
        const component = rivalAssignmentKey(match);
        if (seenComponents.has(component)) return false;
        seenComponents.add(component);
        return true;
      })
      .slice(0, MAX_DURABLE_PRICED_ALTERNATIVES_PER_PRIMARY).map((match) => compactPricedEvidenceMatch(compactPrimary, match, rivalAssignmentHash(match)));
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

export function mergePublishedProductComparisons(current: ProductComparison, prior: ProductComparison | null, resultTarget: number, referenceTimeMs = Date.now(), targetKind: PublishedResultTargetKind = "primary-products") {
  return mergePublishedProductComparisonState(current, prior, resultTarget, referenceTimeMs, targetKind).comparison;
}
