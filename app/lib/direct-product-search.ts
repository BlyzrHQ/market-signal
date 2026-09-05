import { createHash } from "node:crypto";
import { canonicalDomain } from "./domain.ts";
import { searchDirectProductPages, type DirectProductPageSearchResult } from "./competitor-discovery.ts";
import { hasComparablePublicPrice, type ProductComparison, type ProductEnrichmentTarget, type ProductMatch, type ProductRecord } from "./product-intelligence.ts";
import { publishedRivalConstraintKeys } from "./product-match-lifecycle.ts";
import { publicHttpUrl } from "./public-url.ts";
import { enrichProductTargets, type ProductEnrichmentCoverage } from "./storefront-product-enrichment.ts";
import type { ReportQualityRepairFeedback } from "../../src/shared/report-quality-gate.ts";
import { directProductContradictions } from "./direct-product-compatibility.ts";
import { productCurrencyRequestUrl } from "./product-currency-context.ts";

export type DirectProductSearchCheckpointKey = {
  primaryIndex: number;
  inputHash: string;
};

export type DirectProductSearchLeadCheckpoint = {
  version: 1;
  primaryProductId: string;
  primarySourceUrl: string;
  completed: boolean;
  queries: string[];
  candidates: DirectProductPageSearchResult["candidates"];
  gap?: string;
};

export type DirectProductSearchCheckpoint = DirectProductSearchLeadCheckpoint | {
  version: 2;
  primaryProductId: string;
  primarySourceUrl: string;
  completed: boolean;
  queries: string[];
  candidates: DirectProductPageSearchResult["candidates"];
  gap?: string;
  outcome: {
    products: ProductRecord[];
    pagesRequested: number;
    pagesFetched: number;
    gaps: string[];
  };
};

export type DirectProductSearchCheckpointRecord = {
  result: unknown;
  resultHash: string;
};

type DirectSearch = (primaryDomain: string, primary: ProductRecord, marketCountryCode?: string, repairFeedback?: ReportQualityRepairFeedback) => Promise<DirectProductPageSearchResult>;
type DirectEnrichment = (targets: ProductEnrichmentTarget[], maxPages?: number) => Promise<{ products: ProductRecord[]; coverage: ProductEnrichmentCoverage }>;

export type DirectProductSearchOptions = {
  resultTarget: number;
  maxPrimaryProducts?: number;
  maxNewPrimaryProducts?: number;
  maxWorkMs?: number;
  /** Bounded parallel lookahead; website callers retain serial behavior. */
  concurrency?: number;
  /** Internal readiness mode; legacy website calls remain unchanged. */
  enforceCompatibility?: boolean;
  requestPrimaryCurrency?: boolean;
  maxRivalDomains?: number;
  admittedRivalDomains?: string[];
  marketCountryCode?: string;
  referenceTimeMs?: number;
  repairFeedback?: ReportQualityRepairFeedback;
  now?: () => number;
  search?: DirectSearch;
  enrich?: DirectEnrichment;
  loadSearchCheckpoint?: (key: DirectProductSearchCheckpointKey) => Promise<DirectProductSearchCheckpointRecord | null>;
  saveSearchCheckpoint?: (key: DirectProductSearchCheckpointKey, checkpoint: DirectProductSearchCheckpoint, expectedResultHash?: string) => Promise<DirectProductSearchCheckpointRecord>;
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

function searchInputHash(primaryDomain: string, primary: ProductRecord, marketCountryCode: string, repairFeedback?: ReportQualityRepairFeedback) {
  return createHash("sha256").update(JSON.stringify({
    version: repairFeedback ? 2 : 1,
    primaryDomain: canonicalDomain(primaryDomain),
    primaryProductId: primary.id,
    primarySourceUrl: canonicalProductUrl(primary.sourceUrl, primaryDomain),
    primaryName: primary.name,
    marketCountryCode,
    ...(repairFeedback ? { repairFeedbackHash: repairFeedback.feedbackHash } : {}),
  })).digest("hex");
}

function boundedInteger(value: unknown, maximum: number) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function checkpointImageUrl(value: unknown) {
  try {
    const url = new URL(publicHttpUrl(value, true, 2_048));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function searchablePrimaryProduct(product: ProductRecord, referenceTimeMs: number) {
  return pricedProduct(product, referenceTimeMs) && Boolean(canonicalProductUrl(product.sourceUrl, product.domain));
}

function checkpointProduct(value: unknown, referenceTimeMs: number): ProductRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<ProductRecord>;
  const domain = canonicalDomain(item.domain);
  const sourceUrl = canonicalProductUrl(String(item.sourceUrl || ""), domain);
  const id = typeof item.id === "string" ? item.id.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  const jsonLdType = item.jsonLdType === "Product" || item.jsonLdType === "PageSignal" ? item.jsonLdType : null;
  if (!domain || !sourceUrl || !id || !name || !jsonLdType) return null;
  const priceSignals = Array.isArray(item.priceSignals) ? item.priceSignals.slice(0, 8).flatMap((signal) => {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) return [];
    const raw = typeof signal.raw === "string" ? signal.raw.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    const currency = typeof signal.currency === "string" ? signal.currency.trim().toUpperCase().slice(0, 8) : "";
    const amount = typeof signal.amount === "number" && Number.isFinite(signal.amount) ? signal.amount : undefined;
    return raw && currency && amount !== undefined ? [{ raw, currency, amount, ...(typeof signal.period === "string" && signal.period.trim() ? { period: signal.period.trim().slice(0, 40) } : {}) }] : [];
  }) : [];
  const ownership = ["self-declared-brand", "path-inferred", "third-party-referenced"].includes(String(item.ownership)) ? item.ownership as ProductRecord["ownership"] : "third-party-referenced";
  const extraction = ["json-ld", "storefront-api", "page-signal", "sitemap"].includes(String(item.extraction)) ? item.extraction as ProductRecord["extraction"] : "page-signal";
  const product: ProductRecord = {
    id,
    domain,
    name,
    normalizedName: typeof item.normalizedName === "string" ? item.normalizedName.slice(0, 200) : name.toLowerCase().normalize("NFKC"),
    description: typeof item.description === "string" ? item.description.replace(/\s+/g, " ").trim().slice(0, 400) : "",
    category: typeof item.category === "string" ? item.category.replace(/\s+/g, " ").trim().slice(0, 120) : "",
    jsonLdType,
    priceSignals,
    attributes: Array.isArray(item.attributes) ? item.attributes.slice(0, 12).map((entry) => String(entry).replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean) : [],
    ownership,
    extraction,
    confidence: item.confidence === "High" ? "High" : "Medium",
    sourceUrl,
    imageUrl: checkpointImageUrl(item.imageUrl),
    observedAt: typeof item.observedAt === "string" ? item.observedAt : "",
    claimIds: Array.isArray(item.claimIds) ? item.claimIds.slice(0, 20).map((entry) => String(entry).slice(0, 300)).filter(Boolean) : [],
  };
  return pricedProduct(product, referenceTimeMs) ? product : null;
}

function validSearchCheckpoint(value: unknown, primary: ProductRecord, referenceTimeMs: number): DirectProductSearchCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<DirectProductSearchCheckpoint>;
  if (![1, 2].includes(Number(candidate.version)) || candidate.primaryProductId !== primary.id || canonicalProductUrl(candidate.primarySourceUrl || "", primary.domain) !== canonicalProductUrl(primary.sourceUrl, primary.domain)) return null;
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
  // Search results are external input. Keep the paid checkpoint usable while
  // dropping individual malformed or non-HTTPS candidates instead of turning
  // one bad URL into a retry of every search completed earlier in this pass.
  const base = {
    version: candidate.version,
    primaryProductId: primary.id,
    primarySourceUrl: canonicalProductUrl(primary.sourceUrl, primary.domain),
    completed: candidate.completed,
    queries: candidate.queries.slice(0, 8),
    candidates,
    ...(typeof candidate.gap === "string" && candidate.gap.trim() ? { gap: candidate.gap.replace(/\s+/g, " ").trim().slice(0, 500) } : {}),
  };
  if (candidate.version === 1) return { ...base, version: 1 };
  const outcome = (candidate as Extract<DirectProductSearchCheckpoint, { version: 2 }>).outcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const pagesRequested = boundedInteger(outcome.pagesRequested, 12);
  const pagesFetched = boundedInteger(outcome.pagesFetched, 12);
  if (pagesRequested === null || pagesFetched === null || pagesFetched > pagesRequested || !Array.isArray(outcome.products) || outcome.products.length > 12 || !Array.isArray(outcome.gaps) || !outcome.gaps.every((gap) => typeof gap === "string")) return null;
  const products = outcome.products.map((product) => checkpointProduct(product, referenceTimeMs));
  if (products.some((product) => product === null)) return null;
  const sourceUrls = products.map((product) => canonicalProductUrl(product!.sourceUrl, product!.domain));
  if (new Set(sourceUrls).size !== sourceUrls.length) return null;
  return {
    ...base,
    version: 2,
    outcome: {
      products: products as ProductRecord[],
      pagesRequested,
      pagesFetched,
      gaps: outcome.gaps.slice(0, 12).map((gap) => gap.replace(/\s+/g, " ").trim().slice(0, 500)).filter(Boolean),
    },
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
  const now = options.now || Date.now;
  const startedAt = now();
  const primaryDomain = canonicalDomain(primaryDomainValue);
  const resultTarget = Math.max(0, Math.min(1_000, Math.floor(options.resultTarget)));
  const marketCountryCode = /^[A-Z]{2}$/.test(String(options.marketCountryCode || "").toUpperCase()) ? String(options.marketCountryCode).toUpperCase() : "";
  const referenceTimeMs = Number.isFinite(options.referenceTimeMs) ? Number(options.referenceTimeMs) : Date.now();
  const primaryProducts = [...(catalogs.find((catalog) => canonicalDomain(catalog.domain) === primaryDomain)?.products || [])]
    .filter((product) => product.jsonLdType === "Product" || product.jsonLdType === "PageSignal")
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.sourceUrl.localeCompare(right.sourceUrl) || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, Math.min(1_000, Math.floor(options.maxPrimaryProducts ?? 1_000))));
  const comparison = emptyComparison(primaryDomain, primaryProducts.length, resultTarget, marketCountryCode);
  if (!resultTarget || !primaryProducts.length) return comparison;

  const search = options.search || searchDirectProductPages;
  const enrich = options.enrich || enrichProductTargets;
  const maxNewPrimaryProducts = Math.max(1, Math.min(100, Math.floor(options.maxNewPrimaryProducts ?? 100)));
  const maxWorkMs = Math.max(1_000, Math.min(10 * 60 * 1_000, Math.floor(options.maxWorkMs ?? 8 * 60 * 1_000)));
  const repairPrimaryIds = options.repairFeedback ? new Set(options.repairFeedback.primaryProductIds) : null;
  const excludedRivalSourceUrls = new Set(options.repairFeedback?.excludedRivalSourceUrls || []);
  const searchProducts = primaryProducts
    .map((primary, primaryIndex) => ({ primary, primaryIndex }))
    .filter(({ primary }) => (!repairPrimaryIds || repairPrimaryIds.has(primary.id)) && searchablePrimaryProduct(primary, referenceTimeMs));
  const rows: ProductComparison["rows"] = [];
  const outcomes: Array<{ primary: ProductRecord; checkpoint: Extract<DirectProductSearchCheckpoint, { version: 2 }> }> = [];
  const processedPrimaryIds: string[] = [];
  const gaps: string[] = [];
  const seenPairs = new Set<string>();
  const seenRivalConstraints = new Set<string>();
  let candidatePages = 0;
  let pagesRequested = 0;
  let pagesFetched = 0;
  let newPrimaryProducts = 0;
  let stoppedEarly = false;

  const addOutcome = (primary: ProductRecord, checkpoint: Extract<DirectProductSearchCheckpoint, { version: 2 }>) => {
    processedPrimaryIds.push(primary.id);
    candidatePages += checkpoint.candidates.length;
    pagesRequested += checkpoint.outcome.pagesRequested;
    pagesFetched += checkpoint.outcome.pagesFetched;
    if (checkpoint.gap) gaps.push(`${primary.name}: ${checkpoint.gap}`);
    if (checkpoint.outcome.gaps.length) gaps.push(...checkpoint.outcome.gaps.map((gap) => `${primary.name}: ${gap}`));
    outcomes.push({ primary, checkpoint });
  };
  const assignOutcomes = () => {
    rows.length = 0;
    seenPairs.clear();
    seenRivalConstraints.clear();
    // Rank sellers by usable evidence, not arrival order. Invalid-currency
    // candidates must never consume a slot and starve later valid sellers.
    const compatible = (primary: ProductRecord, rival: ProductRecord) => {
      const domain = canonicalDomain(rival.domain);
      if (domain === primaryDomain || (options.enforceCompatibility && domain.endsWith(`.${primaryDomain}`))
        || primary.priceSignals[0]?.currency.toUpperCase() !== rival.priceSignals[0]?.currency.toUpperCase()) return false;
      const contradictions = options.enforceCompatibility ? directProductContradictions(primary, rival) : [];
      if (contradictions.length) {
        const gap = `${primary.name}: excluded ${rival.sourceUrl} (${contradictions.join(", ")}).`;
        if (!gaps.includes(gap)) gaps.push(gap);
        return false;
      }
      return true;
    };
    const sourcesByDomain = new Map<string, Set<string>>();
    for (const { primary, checkpoint } of outcomes) for (const rival of checkpoint.outcome.products) {
      if (!compatible(primary, rival)) continue;
      const domain = canonicalDomain(rival.domain);
      const sources = sourcesByDomain.get(domain) || new Set<string>();
      sources.add(canonicalProductUrl(rival.sourceUrl, rival.domain));
      sourcesByDomain.set(domain, sources);
    }
    const admitted = new Set([...sourcesByDomain].sort(([a, ac], [b, bc]) => bc.size - ac.size || a.localeCompare(b))
      .slice(0, options.maxRivalDomains || sourcesByDomain.size).map(([domain]) => domain));
    for (const { primary, checkpoint } of outcomes) {
    const matches: ProductMatch[] = [];
    for (const rival of checkpoint.outcome.products) {
      if (seenPairs.size >= resultTarget) break;
      if (!compatible(primary, rival) || !admitted.has(canonicalDomain(rival.domain))) continue;
      const pairKey = `${primary.id}\n${canonicalProductUrl(rival.sourceUrl, rival.domain)}`;
      if (seenPairs.has(pairKey)) continue;
      const rivalConstraints = publishedRivalConstraintKeys(rival);
      if (rivalConstraints.some((constraint) => seenRivalConstraints.has(constraint))) continue;
      seenPairs.add(pairKey);
      rivalConstraints.forEach((constraint) => seenRivalConstraints.add(constraint));
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
  };

  const processPrimary = async ({ primary, primaryIndex }: { primary: ProductRecord; primaryIndex: number }) => {
    // A row can never meet the user's no-empty-price contract if the submitted
    // product itself has no displayable observed price. Do not spend search on it.
    // Search checkpoints and queries must remain bound to a priced,
    // attributable public HTTPS product page. Canonicalization returns an
    // empty string for HTTP, off-domain, private, or otherwise unsafe sources.
    if (!searchablePrimaryProduct(primary, referenceTimeMs)) return;
    const key = { primaryIndex, inputHash: searchInputHash(primaryDomain, primary, marketCountryCode, options.repairFeedback) };
    const loaded = options.loadSearchCheckpoint ? await options.loadSearchCheckpoint(key) : null;
    const loadedResultHash = loaded && /^[a-f0-9]{64}$/.test(loaded.resultHash) ? loaded.resultHash : undefined;
    // Checkpoint rows are an optimization, not authority over the current
    // catalog. A structurally stale row must be repaired from fresh search
    // output instead of permanently poisoning every retry for this product.
    let checkpoint = loadedResultHash ? validSearchCheckpoint(loaded?.result, primary, referenceTimeMs) : null;
    if (checkpoint?.version === 2) {
      addOutcome(primary, checkpoint);
      return;
    }
    if (newPrimaryProducts >= maxNewPrimaryProducts || now() - startedAt >= maxWorkMs) {
      stoppedEarly = true;
      return;
    }
    newPrimaryProducts += 1;
    let resultHash = checkpoint ? loadedResultHash : undefined;
    if (!checkpoint) {
      const result = await search(primaryDomain, primary, marketCountryCode, options.repairFeedback);
      checkpoint = validSearchCheckpoint({
        version: 1,
        primaryProductId: primary.id,
        primarySourceUrl: primary.sourceUrl,
        completed: result.completed,
        queries: result.queries,
        candidates: result.candidates.filter((candidate) => !excludedRivalSourceUrls.has(canonicalProductUrl(candidate.sourceUrl, candidate.domain))),
        ...(result.gap ? { gap: result.gap } : {}),
      }, primary, referenceTimeMs);
      if (!checkpoint) throw new Error("Direct product search returned an invalid bounded result.");
      if (options.saveSearchCheckpoint) {
        const saved = await options.saveSearchCheckpoint(key, checkpoint);
        if (!/^[a-f0-9]{64}$/.test(saved.resultHash) || !validSearchCheckpoint(saved.result, primary, referenceTimeMs)) throw new Error("The paid product-search checkpoint save could not be verified.");
        resultHash = saved.resultHash;
      }
    }
    const targets: ProductEnrichmentTarget[] = checkpoint.candidates.map((candidate) => ({
      domain: candidate.domain,
      sourceUrl: options.requestPrimaryCurrency
        ? productCurrencyRequestUrl(candidate.sourceUrl, primary.priceSignals[0]?.currency || "")
        : candidate.sourceUrl,
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
    const byId = new Map(enriched.products.map((product) => [product.id, product]));
    const bySourceUrl = new Map(enriched.products.map((product) => [canonicalProductUrl(product.sourceUrl, product.domain), product]));
    const pricedProducts: ProductRecord[] = [];
    const outcomeSources = new Set<string>();
    for (const target of targets) {
      const rival = byId.get(target.productId) || bySourceUrl.get(canonicalProductUrl(target.sourceUrl, target.domain));
      if (!rival || !pricedProduct(rival, referenceTimeMs)) continue;
      const source = canonicalProductUrl(rival.sourceUrl, rival.domain);
      if (!source || outcomeSources.has(source)) continue;
      outcomeSources.add(source);
      pricedProducts.push(rival);
    }
    const completedCheckpoint = validSearchCheckpoint({
      ...checkpoint,
      version: 2,
      outcome: {
        products: pricedProducts,
        pagesRequested: enriched.coverage.pagesRequested,
        pagesFetched: enriched.coverage.pagesFetched,
        gaps: enriched.coverage.gaps.slice(0, 12).map((gap) => gap.reason),
      },
    }, primary, referenceTimeMs);
    if (!completedCheckpoint || completedCheckpoint.version !== 2) throw new Error("Direct product enrichment returned an invalid durable outcome.");
    if (options.saveSearchCheckpoint) {
      if (!resultHash) throw new Error("The paid product-search checkpoint is missing its durable revision.");
      const saved = await options.saveSearchCheckpoint(key, completedCheckpoint, resultHash);
      const verified = /^[a-f0-9]{64}$/.test(saved.resultHash) ? validSearchCheckpoint(saved.result, primary, referenceTimeMs) : null;
      if (!verified || verified.version !== 2) throw new Error("The priced product-search outcome save could not be verified.");
      checkpoint = verified;
    } else checkpoint = completedCheckpoint;
    addOutcome(primary, checkpoint as Extract<DirectProductSearchCheckpoint, { version: 2 }>);
  };
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency || 1)));
  for (let offset = 0; offset < searchProducts.length; offset += concurrency) {
    if (seenPairs.size >= resultTarget) break;
    // Await every started operation, including on one failure. Never leave
    // billable work running unobserved after the enclosing stage returns.
    const wave = searchProducts.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(wave.map(processPrimary));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    outcomes.sort((a, b) => primaryProducts.indexOf(a.primary) - primaryProducts.indexOf(b.primary));
    assignOutcomes();
  }

  const assignedPairCount = rows.reduce((total, row) => total + row.matches.length, 0);
  const comparisonDomains = [...new Set(rows.flatMap((row) => row.matches.map((match) => canonicalDomain(match.domain))))];
  const eligiblePrimaryCount = searchProducts.filter(({ primary }) => searchablePrimaryProduct(primary, referenceTimeMs)).length;
  const exhausted = processedPrimaryIds.length >= eligiblePrimaryCount;
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
      truncated: assignedPairCount >= resultTarget && processedPrimaryIds.length < eligiblePrimaryCount,
    },
    matching: {
      ...comparison.matching!,
      primaryProductsAssessed: processedPrimaryIds.length,
      primaryProductsScreened: processedPrimaryIds.length,
      publishedPairs: assignedPairCount,
      publishedPrimaryProducts: rows.length,
      resultShortfall,
      ...(resultShortfall ? { resultShortfallReason: exhausted && !stoppedEarly ? "bounded-candidate-pool-exhausted" as const : "processing-incomplete" as const } : { resultShortfallReason: undefined }),
      candidatePairsAssessed: candidatePages,
      durationMs: now() - startedAt,
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
