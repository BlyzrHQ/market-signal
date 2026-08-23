import { createHash } from "node:crypto";
import { canonicalDomain } from "./domain.ts";
import { searchDirectProductPages, type DirectProductPageSearchResult } from "./competitor-discovery.ts";
import { hasComparablePublicPrice, type ProductComparison, type ProductEnrichmentTarget, type ProductMatch, type ProductRecord } from "./product-intelligence.ts";
import { enrichProductTargets, type ProductEnrichmentCoverage } from "./storefront-product-enrichment.ts";

export type DirectProductSearchCheckpointKey = {
  primaryIndex: number;
  inputHash: string;
};

export type DirectProductSearchCheckpoint = {
  version: 1;
  primaryProductId: string;
  primarySourceUrl: string;
  completed: boolean;
  queries: string[];
  candidates: DirectProductPageSearchResult["candidates"];
  gap?: string;
};

type DirectSearch = (primaryDomain: string, primary: ProductRecord, marketCountryCode?: string) => Promise<DirectProductPageSearchResult>;
type DirectEnrichment = (targets: ProductEnrichmentTarget[], maxPages?: number) => Promise<{ products: ProductRecord[]; coverage: ProductEnrichmentCoverage }>;

export type DirectProductSearchOptions = {
  resultTarget: number;
  maxPrimaryProducts?: number;
  marketCountryCode?: string;
  referenceTimeMs?: number;
  search?: DirectSearch;
  enrich?: DirectEnrichment;
  loadSearchCheckpoint?: (key: DirectProductSearchCheckpointKey) => Promise<unknown>;
  saveSearchCheckpoint?: (key: DirectProductSearchCheckpointKey, checkpoint: DirectProductSearchCheckpoint) => Promise<void>;
};

function canonicalProductUrl(value: string, expectedDomain?: string) {
  try {
    const url = new URL(value);
    const domain = canonicalDomain(url.hostname);
    if (url.protocol !== "https:" || !domain || (expectedDomain && domain !== canonicalDomain(expectedDomain))) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function searchInputHash(primaryDomain: string, primary: ProductRecord, marketCountryCode: string) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    primaryDomain: canonicalDomain(primaryDomain),
    primaryProductId: primary.id,
    primarySourceUrl: canonicalProductUrl(primary.sourceUrl, primaryDomain),
    primaryName: primary.name,
    marketCountryCode,
  })).digest("hex");
}

function validSearchCheckpoint(value: unknown, primary: ProductRecord): DirectProductSearchCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<DirectProductSearchCheckpoint>;
  if (candidate.version !== 1 || candidate.primaryProductId !== primary.id || canonicalProductUrl(candidate.primarySourceUrl || "", primary.domain) !== canonicalProductUrl(primary.sourceUrl, primary.domain)) return null;
  if (typeof candidate.completed !== "boolean" || !Array.isArray(candidate.queries) || !candidate.queries.every((query) => typeof query === "string")) return null;
  if (!Array.isArray(candidate.candidates) || candidate.candidates.length > 12) return null;
  const candidates = candidate.candidates.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as DirectProductPageSearchResult["candidates"][number];
    const domain = canonicalDomain(item.domain);
    const sourceUrl = canonicalProductUrl(item.sourceUrl, domain);
    const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    return domain && sourceUrl && title ? [{ domain, sourceUrl, title }] : [];
  });
  if (candidates.length !== candidate.candidates.length) return null;
  return {
    version: 1,
    primaryProductId: primary.id,
    primarySourceUrl: canonicalProductUrl(primary.sourceUrl, primary.domain),
    completed: candidate.completed,
    queries: candidate.queries.slice(0, 8),
    candidates,
    ...(typeof candidate.gap === "string" && candidate.gap.trim() ? { gap: candidate.gap.replace(/\s+/g, " ").trim().slice(0, 500) } : {}),
  };
}

function pricedProduct(product: ProductRecord, referenceTimeMs: number) {
  return hasComparablePublicPrice(product, referenceTimeMs);
}

function resultProductId(primary: ProductRecord, sourceUrl: string) {
  return `direct-${createHash("sha256").update(`${primary.id}\n${sourceUrl}`).digest("hex").slice(0, 32)}`;
}

function emptyComparison(primaryDomain: string, primaryAvailable: number, resultTarget: number, marketCountryCode: string): ProductComparison {
  return {
    primaryDomain,
    ...(marketCountryCode ? { marketCountryCode } : {}),
    comparisonDomains: [],
    rows: [],
    unmatched: [],
    coverage: {
      primaryProductsAvailable: primaryAvailable,
      primaryProductsScanned: 0,
      primaryProductFamiliesCompared: 0,
      competitorProductsAvailable: 0,
      competitorProductsScanned: 0,
      assignedPairCount: 0,
      verifiedPairCount: 0,
      rowsReturned: 0,
      rowLimit: resultTarget,
      truncated: false,
    },
    matching: {
      method: "direct-web-search",
      available: true,
      model: process.env.MARKET_SIGNAL_DISCOVERY_MODEL || "gpt-5.4-mini",
      embeddingModel: "",
      promptVersion: "direct-product-search-v1",
      primaryProductsAssessed: 0,
      primaryProductsScreened: 0,
      resultTarget,
      publishedPairs: 0,
      publishedPrimaryProducts: 0,
      resultShortfall: resultTarget,
      resultShortfallReason: "bounded-candidate-pool-exhausted",
      candidatePairsAssessed: 0,
      retrievalPairsScored: 0,
      judgeCalls: 0,
      embeddingCalls: 0,
      durationMs: 0,
      gaps: [],
      selectedPrimaryIds: [],
      assessedPrimaryIds: [],
      processedPrimaryIds: [],
    },
  };
}

export async function buildDirectProductSearchComparison(primaryDomainValue: string, catalogs: Array<{ domain: string; products: ProductRecord[] }>, options: DirectProductSearchOptions): Promise<ProductComparison> {
  const startedAt = Date.now();
  const primaryDomain = canonicalDomain(primaryDomainValue);
  const resultTarget = Math.max(0, Math.min(1_000, Math.floor(options.resultTarget)));
  const marketCountryCode = /^[A-Z]{2}$/.test(String(options.marketCountryCode || "").toUpperCase()) ? String(options.marketCountryCode).toUpperCase() : "";
  const referenceTimeMs = Number.isFinite(options.referenceTimeMs) ? Number(options.referenceTimeMs) : Date.now();
  const primaryProducts = [...(catalogs.find((catalog) => canonicalDomain(catalog.domain) === primaryDomain)?.products || [])]
    .filter((product) => product.jsonLdType === "Product")
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.sourceUrl.localeCompare(right.sourceUrl) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, Math.min(1_000, Math.floor(options.maxPrimaryProducts ?? 1_000))));
  const comparison = emptyComparison(primaryDomain, primaryProducts.length, resultTarget, marketCountryCode);
  if (!resultTarget || !primaryProducts.length) return comparison;

  const search = options.search || searchDirectProductPages;
  const enrich = options.enrich || enrichProductTargets;
  const rows: ProductComparison["rows"] = [];
  const processedPrimaryIds: string[] = [];
  const gaps: string[] = [];
  const seenPairs = new Set<string>();
  let candidatePages = 0;
  let pagesRequested = 0;
  let pagesFetched = 0;
  let allSearchesCompleted = true;

  for (let primaryIndex = 0; primaryIndex < primaryProducts.length && seenPairs.size < resultTarget; primaryIndex += 1) {
    const primary = primaryProducts[primaryIndex];
    // A row can never meet the user's no-empty-price contract if the submitted
    // product itself has no displayable observed price. Do not spend search on it.
    if (!pricedProduct(primary, referenceTimeMs)) continue;
    processedPrimaryIds.push(primary.id);
    const key = { primaryIndex, inputHash: searchInputHash(primaryDomain, primary, marketCountryCode) };
    let checkpoint = options.loadSearchCheckpoint ? validSearchCheckpoint(await options.loadSearchCheckpoint(key), primary) : null;
    if (!checkpoint) {
      const result = await search(primaryDomain, primary, marketCountryCode);
      checkpoint = validSearchCheckpoint({
        version: 1,
        primaryProductId: primary.id,
        primarySourceUrl: primary.sourceUrl,
        completed: result.completed,
        queries: result.queries,
        candidates: result.candidates,
        ...(result.gap ? { gap: result.gap } : {}),
      }, primary);
      if (!checkpoint) throw new Error("Direct product search returned an invalid bounded result.");
      if (options.saveSearchCheckpoint) await options.saveSearchCheckpoint(key, checkpoint);
    }
    if (!checkpoint.completed) allSearchesCompleted = false;
    if (checkpoint.gap) gaps.push(`${primary.name}: ${checkpoint.gap}`);
    candidatePages += checkpoint.candidates.length;
    const targets: ProductEnrichmentTarget[] = checkpoint.candidates.map((candidate) => ({
      domain: candidate.domain,
      sourceUrl: candidate.sourceUrl,
      productId: resultProductId(primary, candidate.sourceUrl),
      expectedName: candidate.title,
      expectedType: "Product",
      pairScore: 1,
      role: "rival",
      ...(marketCountryCode ? { marketCountryCode } : {}),
      allowCatalogReplacement: true,
    }));
    const enriched = targets.length
      ? await enrich(targets, targets.length)
      : { products: [], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: 0, gaps: [] } };
    pagesRequested += enriched.coverage.pagesRequested;
    pagesFetched += enriched.coverage.pagesFetched;
    if (enriched.coverage.gaps.length) gaps.push(...enriched.coverage.gaps.slice(0, 12).map((gap) => `${primary.name}: ${gap.reason}`));
    const byId = new Map(enriched.products.map((product) => [product.id, product]));
    const bySourceUrl = new Map(enriched.products.map((product) => [canonicalProductUrl(product.sourceUrl, product.domain), product]));
    const matches: ProductMatch[] = [];
    for (const target of targets) {
      if (seenPairs.size >= resultTarget) break;
      const rival = byId.get(target.productId) || bySourceUrl.get(canonicalProductUrl(target.sourceUrl, target.domain));
      if (!rival || !pricedProduct(rival, referenceTimeMs)) continue;
      const pairKey = `${primary.id}\n${canonicalProductUrl(rival.sourceUrl, rival.domain)}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      matches.push({
        domain: rival.domain,
        product: rival,
        score: 1,
        confidence: "Medium",
        sharedTerms: [],
        claimIds: [...new Set([...primary.claimIds, ...rival.claimIds])],
        decision: null,
        publication: { priceEligible: true },
      });
    }
    if (matches.length) rows.push({ primary, matches });
  }

  const assignedPairCount = rows.reduce((total, row) => total + row.matches.length, 0);
  const comparisonDomains = [...new Set(rows.flatMap((row) => row.matches.map((match) => canonicalDomain(match.domain))))];
  const exhausted = allSearchesCompleted && processedPrimaryIds.length >= primaryProducts.filter((product) => pricedProduct(product, referenceTimeMs)).length;
  const resultShortfall = Math.max(0, resultTarget - assignedPairCount);
  return {
    ...comparison,
    comparisonDomains,
    rows,
    coverage: {
      ...comparison.coverage,
      primaryProductsScanned: processedPrimaryIds.length,
      primaryProductFamiliesCompared: rows.length,
      competitorProductsAvailable: candidatePages,
      competitorProductsScanned: pagesRequested,
      assignedPairCount,
      verifiedPairCount: assignedPairCount,
      rowsReturned: rows.length,
      truncated: assignedPairCount >= resultTarget && processedPrimaryIds.length < primaryProducts.length,
    },
    matching: {
      ...comparison.matching!,
      primaryProductsAssessed: processedPrimaryIds.length,
      primaryProductsScreened: processedPrimaryIds.length,
      publishedPairs: assignedPairCount,
      publishedPrimaryProducts: rows.length,
      resultShortfall,
      ...(resultShortfall ? { resultShortfallReason: exhausted ? "bounded-candidate-pool-exhausted" as const : "processing-incomplete" as const } : { resultShortfallReason: undefined }),
      candidatePairsAssessed: candidatePages,
      durationMs: Date.now() - startedAt,
      gaps: [...new Set(gaps)].slice(0, 20),
      selectedPrimaryIds: processedPrimaryIds,
      assessedPrimaryIds: processedPrimaryIds,
      processedPrimaryIds,
    },
    enrichment: {
      pagesRequested,
      pagesFetched,
      maxPages: pagesRequested,
      gaps: [],
    },
  };
}
