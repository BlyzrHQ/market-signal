import { canonicalDomain, normalizeDomain } from "../../lib/domain.ts";
import { applyPreMatchCatalogEnrichment, buildProductComparison, extractFirstPartyOfferings, extractProductsFromHtml, extractProductsFromSitemapWithCoverage, hasComparablePublicPricePair, hasValidObservedRivalPrice, planPreliminaryCatalogReconciliation, selectPreferredProducts, selectProductEnrichmentTargets, validateProductPageIdentity, type ProductComparison, type ProductRecord } from "../../lib/product-intelligence.ts";
import { sharedRobotsPolicyResolver } from "../../lib/robots-policy.ts";
import { boundedPrimaryCatalogProducts, discoverCompetitors, publicDiscoveryCandidate, publicDiscoverySnapshot, type DiscoveryCandidate, type DiscoveryResult } from "../../lib/competitor-discovery.ts";
import { compareVerifiedCompetitors, resolveVerificationMarket, verifyCompetitorEntity, type CompetitorVerification, type FirstPartyRegionSource, type VerificationMarket } from "../../lib/competitor-verification.ts";
import { inferBusinessProfile } from "../../lib/business-profile.ts";
import { seededCrawlPaths } from "../../lib/crawl-planning.ts";
import { combineRegionSignals, displayRegion, inferRegion as inferRegionEvidence, type RegionSignal } from "../../lib/region-inference.ts";
import { hasValidAnalysisAuthorization, unauthorizedInternalResponse } from "../../lib/internal-auth.ts";
import { forgetRememberedCompetitors, loadRememberedCompetitors, mergeRememberedCandidateCoverage, rememberVerifiedCompetitors, type MemoryCandidate } from "../../lib/competitor-memory.ts";
import { discoverDomainAlternatives, extractStaticClientRedirect, parkingProvider } from "../../lib/domain-recovery.ts";
import { boundedExtractionDocument, compactCatalogSnapshots, createRequestLimiter, preferredEndpointFailure, settleWithConcurrency, unavailableAfterBoundedAttempts, unavailablePrimaryMessaging, type PublicEndpointFailure } from "../../lib/crawl-runtime.ts";
import { fetchPublicText } from "../../lib/public-fetch.ts";
import { claimablePagePricePatterns, enrichProductTargets, MAX_ENRICHMENT_TARGETS, selectPrimaryProductPriceTargets, type EnrichmentDependencies } from "../../lib/storefront-product-enrichment.ts";
import { buildExperienceBenchmark } from "../../lib/experience-benchmark.ts";
import { hasObservedAddToCartControl } from "../../lib/experience-signals.ts";
import { buildAIProductComparison, type AIProductMatchingOptions } from "../../lib/ai-product-matching.ts";
import { isSallaCatalogRecoveryEligible, recoverSallaStorefrontCatalog, type SallaStorefrontRecovery } from "../../lib/salla-mcp-catalog-recovery.ts";
import { isShopifyUcpCatalogRecoveryEligible, recoverShopifyUcpCatalog, type ShopifyUcpCatalogRecovery } from "../../lib/shopify-ucp-catalog-recovery.ts";
import { redirectedMarketRetryUrl } from "../../lib/market-localization.ts";
import { workerOnlyResponse } from "../../lib/process-role.ts";
import { MARKET_SIGNAL_USER_AGENT } from "../../lib/crawler-identity.ts";

type ClaimType = "Observed" | "Inferred";
type Confidence = "High" | "Medium" | "Low";

type Claim = {
  id: string;
  claimType: ClaimType;
  text: string;
  sourceUrl: string;
  observedAt: string;
  confidence: Confidence;
};

type CrawlPage = {
  ok: true;
  live: true;
  domain: string;
  url: string;
  path: string;
  sourceUrl: string;
  requestedSourceUrl?: string;
  fetchedAt: string;
  title: string;
  description: string;
  language: string;
  region: string;
  regionCountryCode: string;
  regionConfidence: Confidence;
  regionSignals: RegionSignal[];
  headings: string[];
  prices: string[];
  socialLinks: string[];
  internalLinks: string[];
  wordCount: number;
  truncated: boolean;
  contentHash: string;
  claims: Claim[];
  products: ProductRecord[];
  productGaps: string[];
  thirdPartyProductCount: number;
  responseTimeMs: number;
  responseBytes: number;
  imageCount: number;
  imagesWithAlt: number;
  responsiveImageCount: number;
  hasViewport: boolean;
  hasDocumentLanguage: boolean;
  productLinkCount: number;
  hasProductPath: boolean;
  hasAddToCart: boolean;
  hasCartLink: boolean;
  hasCheckoutLink: boolean;
  trustSignals: string[];
};

type Gap = { url: string; reason: string; observedAt: string };
type Candidate = { domain: string; reason: string; sourceUrl: string; claimIds: string[] };
type DomainCrawl = {
  domain: string;
  role: "primary" | "submitted-comparison" | "discovered-competitor";
  homepage: CrawlPage | null;
  pages: CrawlPage[];
  products: ProductRecord[];
  candidates: Candidate[];
  gaps: Gap[];
  coverage: { pagesRequested: number; pagesFetched: number; maxPages: number; robotsChecked: boolean; attempts?: number };
  productCoverage: { scannedPages: number; catalogProductsDiscovered: number; thirdPartyReferenced: number; sitemapTruncated?: boolean };
  fetchedAt: string;
  discovery?: DiscoveryCandidate & CompetitorVerification;
  enrichmentPages?: CrawlPage[];
  priceEnrichment?: { pagesRequested: number; pagesFetched: number; maxPages: number };
  primaryPriceEnrichment?: { pagesRequested: number; pagesFetched: number; maxPages: number };
  catalogReconciliation?: { pagesRequested: number; pagesFetched: number; maxPages: number; eligibleProducts: number; truncated: boolean };
  siteState?: { status: "parked"; provider: string; evidenceUrl: string; redirectDomain: string } | { status: "unavailable"; attemptedUrl: string; reason: string; observedAt: string };
  homepageFailure?: PublicEndpointFailure;
  homepageAccessDenied?: { status: 403; hosts: string[] };
  benchmarkEligible?: boolean;
  verifiedExactProductPairs?: Array<{ primary: ProductRecord; rival: ProductRecord; confidence: number }>;
};

type ReportBlock = Record<string, unknown> & { type: string; id: string };

const MAX_DOMAINS = 4;
const MAX_HTML_PAGES = 5;
// The complete 1,000-anchor screen can emit at most 6,000 attributable
// seller-product leads. Include the homepage plus that full bounded universe.
const MAX_DISCOVERED_HTML_PAGES = 6_001;
const MAX_SITEMAP_DOCUMENTS = 4;
const MAX_DISCOVERED_SITEMAP_DOCUMENTS = 2;
const MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES = 16;
const MAX_PRIMARY_PRODUCT_PRICE_PAGES = 16;
export const MAX_PRIMARY_CATALOG_PRODUCTS = 1_000;
const MAX_CATALOG_RECONCILIATION_PAGES = 64;
const MAX_DOCUMENT_BYTES = 1_500_000;
const MAX_HTML_EXTRACTION_BYTES = 400_000;
const COMPETITOR_CRAWL_CONCURRENCY = 48;
const COMPARISON_SEARCH_BATCH_SIZE = 10;
const COMPARISON_VERIFICATION_BATCH_SIZE = 4;
// A request-scoped limiter below makes this a global ceiling across all rival
// domains, including the pathological case where one seller owns every lead.
const COMPETITOR_PAGE_CONCURRENCY = 256;
// Two hundred product lanes and two company lanes can each contribute six
// fresh domains, plus the 500 strongest remembered rivals.
const MAX_COMPETITOR_INVESTIGATIONS = 1_712;
const REQUEST_TIMEOUT_MS = 6_000;
const USER_AGENT = MARKET_SIGNAL_USER_AGENT;
const PRIORITY_PATHS = ["/pricing", "/plans", "/products", "/features", "/compare", "/integrations", "/about", "/customers", "/blog"];
const PRODUCT_ROUTE_PATH = /\/(?:products?|shop|store|collections?|catalog|pricing|plans?)(?:\/|$)|\/(?:-\/)?p\d+(?:\/|$)/i;
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com", "x.com", "twitter.com"];

export function primaryProductPricePageBudget(directProductSearch: boolean) {
  return directProductSearch ? MAX_ENRICHMENT_TARGETS : MAX_PRIMARY_PRODUCT_PRICE_PAGES;
}

export function crawlResponseMetadata(
  directProductSearch: boolean,
  overrides: Partial<{
    maxPagesPerDiscoveredCompetitor: number;
    maxMatchedProductEnrichmentPages: number;
    competitorCrawlConcurrency: number;
  }> = {},
) {
  return {
    maxPagesPerDomain: MAX_HTML_PAGES,
    maxPagesPerDiscoveredCompetitor: overrides.maxPagesPerDiscoveredCompetitor ?? MAX_DISCOVERED_HTML_PAGES,
    maxPrimaryProductPricePages: primaryProductPricePageBudget(directProductSearch),
    maxMatchedProductEnrichmentPages: overrides.maxMatchedProductEnrichmentPages ?? MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES,
    competitorCrawlConcurrency: overrides.competitorCrawlConcurrency ?? COMPETITOR_CRAWL_CONCURRENCY,
    htmlExtractionBytes: MAX_HTML_EXTRACTION_BYTES,
    robotsAware: true,
    generatedAt: new Date().toISOString(),
  };
}

function firstPartyRegionSource(page: CrawlPage): FirstPartyRegionSource {
  return page.regionSignals.some((signal) => signal.countryCode === page.regionCountryCode && signal.claimType === "Observed")
    ? "first-party-observed"
    : "first-party-inferred";
}

function discoveryInputForPrimary(primary: DomainCrawl) {
  if (!primary.homepage) throw new Error("Primary homepage is required before competitor discovery.");
  return {
    domain: primary.domain,
    title: primary.homepage.title,
    description: primary.homepage.description,
    region: primary.homepage.region,
    language: primary.homepage.language,
    products: primary.products,
    pages: primary.pages.map((page) => ({ title: page.title, description: page.description, path: page.path, sourceUrl: page.sourceUrl, headings: page.headings })),
  };
}

export function resolvePrimaryDiscoveryPolicy(primary: DomainCrawl) {
  const input = discoveryInputForPrimary(primary);
  const business = inferBusinessProfile(input);
  return {
    input,
    businessType: business.businessType,
    intendedStrategy: business.businessType === "ecommerce" ? "product-first" as const : "company-first" as const,
    requireProductOverlap: business.businessType === "ecommerce",
  };
}

export function verifyDiscoveredCompetitor(
  primary: DomainCrawl,
  candidate: DomainCrawl,
  discovery: DiscoveryCandidate,
  targetMarket: VerificationMarket,
  requireProductOverlap = false,
  verifiedExactProductPair?: { primary: ProductRecord; rival: ProductRecord; confidence: number },
) {
  if (!primary.homepage || !candidate.homepage) return {
    ...candidate,
    discovery: {
      ...discovery,
      accepted: false,
      verificationScore: 0,
      confidence: "Low" as const,
      categoryAlignment: false,
      regionCompatibility: false,
      primaryRegionKnown: Boolean(targetMarket.regionCode),
      candidateRegionKnown: false,
      targetRegion: targetMarket.region,
      targetRegionCode: targetMarket.regionCode,
      targetRegionSource: targetMarket.source,
      candidateRegion: candidate.homepage?.region || "Not enough public signal",
      candidateRegionCode: "",
      candidateCombinedRegionCode: "",
      candidateRegionSource: "first-party-inferred" as const,
      candidateRegionBasis: "combined-first-party" as const,
      regionDecisionReason: `Target market ${targetMarket.regionCode || "unknown"} (${targetMarket.source}); candidate region could not be observed because its public homepage was unavailable.`,
      overlapTerms: [],
      hasProductOverlap: false,
      categoryBasis: "none" as const,
      exactProductPairVerified: false,
    },
  };
  const verification = verifyCompetitorEntity(
    { domain: primary.domain, title: primary.homepage.title, description: primary.homepage.description, region: primary.homepage.region, regionEvidenceSource: firstPartyRegionSource(primary.homepage), headings: primary.pages.flatMap((page) => page.headings), products: primary.products },
    { domain: candidate.domain, title: candidate.homepage.title, description: candidate.homepage.description, region: candidate.homepage.region, regionEvidenceSource: firstPartyRegionSource(candidate.homepage), countryTldRegionCode: candidate.homepage.regionSignals.find((signal) => signal.kind === "tld")?.countryCode || "", headings: candidate.pages.flatMap((page) => page.headings), products: candidate.products },
    discovery,
    targetMarket,
    { requireProductOverlap, verifiedExactProductPair },
  );
  return { ...candidate, discovery: { ...discovery, ...verification } };
}

function exactProductPageKey(value: string, expectedDomain: string) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || canonicalDomain(url.hostname) !== canonicalDomain(expectedDomain)) return "";
    const tracking = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|srsltid)$/i;
    const identity = [...url.searchParams.entries()]
      .filter(([key]) => !tracking.test(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const search = new URLSearchParams(identity).toString();
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "") || "/"}${search ? `?${search}` : ""}`;
  } catch {
    return "";
  }
}

function redirectedProductIdentityMatches(requested: string, final: string, expectedDomain: string) {
  const key = (value: string) => {
    try {
      const parsed = new URL(value);
      if (canonicalDomain(parsed.hostname) !== canonicalDomain(expectedDomain)) return [];
      const segments = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
      while (segments.length && /^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(segments[0])) segments.shift();
      return segments.join(" ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .split(/[^\p{L}\p{N}]+/gu)
        .filter((token) => token.length > 1 && !/^(?:items?|products?|produits?|productos?|produtos?|produkte?|prodotto|prodotti|shop|store)$/i.test(token));
    } catch {
      return [];
    }
  };
  const requestedTokens = [...new Set(key(requested))];
  const finalTokens = [...new Set(key(final))];
  const shared = requestedTokens.filter((token) => finalTokens.includes(token));
  const minimum = Math.min(requestedTokens.length, finalTokens.length);
  return minimum > 0 && shared.length >= Math.min(2, minimum) && shared.length / minimum >= 0.8;
}

function exactPageProductFingerprint(product: ProductRecord, expectedDomain: string) {
  const identifiers: NonNullable<ProductRecord["identifiers"]> = product.identifiers || { gtins: [] };
  const prices = product.priceSignals.map((signal) => ({
    amount: signal.amount,
    currency: String(signal.currency || "").toUpperCase(),
    period: signal.period || "",
    raw: signal.raw,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    name: product.normalizedName || product.name.toLowerCase().normalize("NFKC"),
    quantity: product.quantity || null,
    identifiers: {
      gtins: [...(identifiers.gtins || [])].sort(),
      sku: identifiers.sku || "",
      mpn: identifiers.mpn || "",
      brand: identifiers.brand || "",
    },
    prices,
    attributes: [...product.attributes].map((value) => value.toLowerCase().normalize("NFKC").trim()).filter(Boolean).sort(),
    source: exactProductPageKey(product.sourceUrl, expectedDomain),
  });
}

type ExactPairJudge = typeof buildAIProductComparison;

export async function verifyInferredProductLeads(
  primary: DomainCrawl,
  candidate: DomainCrawl,
  discovery: DiscoveryCandidate,
  judge: ExactPairJudge = buildAIProductComparison,
) {
  const eligiblePairs: Array<{ primary: ProductRecord; rival: ProductRecord; lead: NonNullable<DiscoveryCandidate["inferredProductLeads"]>[number] }> = [];
  for (const lead of discovery.inferredProductLeads || []) {
    if (canonicalDomain(lead.candidateDomain) !== canonicalDomain(candidate.domain)) continue;
    const primaryProduct = primary.products.find((product) => product.id === lead.primaryProductId
      && exactProductPageKey(product.sourceUrl, primary.domain) === exactProductPageKey(lead.primarySourceUrl, primary.domain));
    const candidateKey = exactProductPageKey(lead.candidateSourceUrl, candidate.domain);
    const exactPage = candidate.pages.find((page) => {
      if (!candidateKey) return false;
      const finalKey = exactProductPageKey(page.sourceUrl, candidate.domain);
      if (finalKey === candidateKey) return true;
      const requestedKey = exactProductPageKey(page.requestedSourceUrl || "", candidate.domain);
      return requestedKey === candidateKey && redirectedProductIdentityMatches(page.requestedSourceUrl || "", page.sourceUrl, candidate.domain);
    });
    const finalPageKey = exactPage ? exactProductPageKey(exactPage.sourceUrl, candidate.domain) : "";
    const eligiblePageProducts = (exactPage?.products || []).filter((product) => finalPageKey
      && exactProductPageKey(product.sourceUrl, candidate.domain) === finalPageKey
      && product.jsonLdType === "Product"
      && product.ownership !== "third-party-referenced"
      && (product.extraction === "json-ld" || product.extraction === "storefront-api")
      && hasValidObservedRivalPrice(product));
    const exactPageProducts = selectPreferredProducts(eligiblePageProducts);
    const identities = new Set(eligiblePageProducts.map((product) => exactPageProductFingerprint(product, candidate.domain)));
    if (!primaryProduct || exactPageProducts.length !== 1 || identities.size !== 1) continue;
    const rivalProduct = exactPageProducts[0];
    if (!eligiblePairs.some((pair) => pair.primary.id === primaryProduct.id && pair.rival.id === rivalProduct.id)) eligiblePairs.push({ primary: primaryProduct, rival: rivalProduct, lead });
  }
  if (!eligiblePairs.length) return [];
  const comparison = await judge(primary.domain, [
    { domain: primary.domain, products: selectPreferredProducts(eligiblePairs.map((pair) => pair.primary)) },
    { domain: candidate.domain, products: selectPreferredProducts(eligiblePairs.map((pair) => pair.rival)) },
  ], {
    maxPrimaryProducts: Math.min(1_000, eligiblePairs.length),
    maxCandidatesPerPrimary: 6_000,
    maxCandidatesPerDomain: 6_000,
    maxProductsPerCompetitor: 6_000,
    maxRetrievalPoolPerDomain: 6_000,
    primaryProductsPerJudgeCall: 25,
    maxPairsPerJudgeCall: 25,
    concurrency: 12,
    totalBudgetMs: 720_000,
    pinnedPairs: eligiblePairs.map((pair) => ({ primaryId: pair.primary.id, rivalDomain: candidate.domain, rivalId: pair.rival.id })),
  });
  return eligiblePairs.flatMap(({ primary: primaryProduct, rival: rivalProduct, lead }) => {
    const match = comparison.rows.find((row) => row.primary.id === primaryProduct.id)?.matches
      .find((item) => item.product?.id === rivalProduct.id && canonicalDomain(item.domain) === canonicalDomain(candidate.domain));
    if (!match?.product || match.confidence !== "Medium" || !match.assessment
      || (match.assessment.verdict !== "same_product" && match.assessment.verdict !== "close_substitute")
      || match.assessment.confidence < 0.8 || match.assessment.contradictions.length) return [];
    return [{ primary: primaryProduct, rival: rivalProduct, confidence: match.assessment.confidence, lead }];
  });
}

export async function verifyInferredProductLead(
  primary: DomainCrawl,
  candidate: DomainCrawl,
  discovery: DiscoveryCandidate,
  judge: ExactPairJudge = buildAIProductComparison,
) {
  return (await verifyInferredProductLeads(primary, candidate, discovery, judge))[0];
}

export async function verifyDiscoveredCompetitorWithInferredLeads(
  primary: DomainCrawl,
  candidate: DomainCrawl,
  discovery: DiscoveryCandidate,
  targetMarket: VerificationMarket,
  requireProductOverlap = false,
  judge: ExactPairJudge = buildAIProductComparison,
) {
  const verifiedExactProductPairs = discovery.inferredProductLeads?.length
    ? await verifyInferredProductLeads(primary, candidate, discovery, judge)
    : [];
  const verifiedExactProductPair = verifiedExactProductPairs[0];
  const attributableDiscoveryEvidence = discovery.evidence.filter((item) => {
    try { return canonicalDomain(new URL(item.url).hostname) === canonicalDomain(discovery.domain); } catch { return false; }
  });
  const attributableMatchedUrls = (discovery.matchedProductUrls || (discovery.matchedProductUrl ? [discovery.matchedProductUrl] : [])).filter((value) => {
    try { return canonicalDomain(new URL(value).hostname) === canonicalDomain(discovery.domain); } catch { return false; }
  });
  const verificationDiscovery = verifiedExactProductPair ? {
    ...discovery,
    reason: `The exact seeded product page exposed a priced first-party Product and the targeted semantic judge verified it against “${verifiedExactProductPair.primary.name}”.`,
    searchQuery: verifiedExactProductPair.lead.laneQuery,
    sourceUrl: verifiedExactProductPair.lead.candidateSourceUrl,
    sharedOfferings: [verifiedExactProductPair.primary.name],
    evidence: [...attributableDiscoveryEvidence, { url: verifiedExactProductPair.lead.candidateSourceUrl, title: verifiedExactProductPair.rival.name, method: "product-search" as const }]
      .filter((item, index, all) => all.findIndex((other) => other.url === item.url && other.method === item.method) === index),
    mentionCount: Math.max(discovery.mentionCount, discovery.evidence.length + 1),
    matchedPrimaryProductName: verifiedExactProductPair.primary.name,
    matchedProductUrl: verifiedExactProductPair.rival.sourceUrl,
    matchedPrimaryProductNames: [...new Set([verifiedExactProductPair.primary.name, ...(discovery.matchedPrimaryProductNames || (discovery.matchedPrimaryProductName ? [discovery.matchedPrimaryProductName] : []))])],
    matchedProductUrls: [...new Set([verifiedExactProductPair.rival.sourceUrl, ...attributableMatchedUrls])],
  } : discovery;
  const verified = verifyDiscoveredCompetitor(primary, candidate, verificationDiscovery, targetMarket, requireProductOverlap, verifiedExactProductPair);
  if (discovery.inferredProductLeads?.length && !discovery.observedAdmission && !verifiedExactProductPair) return {
    ...verified,
    discovery: {
      ...verified.discovery,
      accepted: false,
      verificationScore: 0,
      confidence: "Low" as const,
      categoryAlignment: false,
      hasProductOverlap: false,
      categoryBasis: "none" as const,
      exactProductPairVerified: false,
      overlapTerms: [],
      provenPrimaryProduct: undefined,
      provenRivalProduct: undefined,
    },
  };
  return { ...verified, verifiedExactProductPairs: verifiedExactProductPairs.map(({ primary: exactPrimary, rival, confidence }) => ({ primary: exactPrimary, rival, confidence })) };
}

export function rememberedReverificationFailures(candidates: MemoryCandidate[], results: Array<DomainCrawl | null>) {
  return candidates.filter((candidate, index) => candidate.provenance === "remembered-reverified" && competitorInvestigationComplete(results[index]) && !results[index]?.discovery?.accepted);
}

export function competitorInvestigationComplete(result: Pick<DomainCrawl, "homepage" | "gaps" | "discovery"> | null) {
  if (!result) return false;
  if (!result.homepage) return result.gaps.some((gap) => /(?:HTTP|status)\s+(?:404|410)\b/i.test(gap.reason));
  const seedUrls = new Set([
    ...(result.discovery?.matchedProductUrls || (result.discovery?.matchedProductUrl ? [result.discovery.matchedProductUrl] : [])),
    ...(result.discovery?.inferredProductLeads || []).map((lead) => lead.candidateSourceUrl),
  ].flatMap((value) => {
    try { const url = new URL(value); return [`${canonicalDomain(url.hostname)}${url.pathname.replace(/\/$/, "")}`]; } catch { return []; }
  }));
  if (seedUrls.size && result.gaps.some((gap) => /robots\.txt was unreachable/i.test(gap.reason))) return false;
  return !result.gaps.some((gap) => {
    let key = "";
    try { const url = new URL(gap.url); key = `${canonicalDomain(url.hostname)}${url.pathname.replace(/\/$/, "")}`; } catch { return false; }
    if (!seedUrls.has(key) || /(?:HTTP|status)\s+(?:404|410)\b/i.test(gap.reason)) return false;
    return /timeout|timed out|network|robots|unavailable|access|denied|processing failed before verification completed|(?:HTTP|status)\s+(?:401|403|407|408|425|429|5\d\d)\b/i.test(gap.reason);
  });
}

export function finalizedDiscoveryCoverage(
  coverage: DiscoveryResult["productSearchCoverage"],
  candidateDomainsFound: number,
  candidateDomainsInvestigated: number,
  settledStatuses: Array<"fulfilled" | "rejected">,
  results: Array<Pick<DomainCrawl, "homepage" | "gaps"> | null>,
  priorCoverageComplete: boolean,
  persistenceComplete = true,
) {
  const verificationComplete = settledStatuses.every((status, index) => status === "fulfilled" && competitorInvestigationComplete(results[index]));
  const candidateTruncated = candidateDomainsFound > candidateDomainsInvestigated;
  const batchComplete = (coverage.searchAttemptsComplete ?? coverage.searchesComplete) && !candidateTruncated && verificationComplete && persistenceComplete;
  return {
    ...coverage,
    candidateDomainsFound,
    candidateDomainsInvestigated,
    candidateTruncated,
    verificationComplete,
    batchComplete,
    complete: priorCoverageComplete && coverage.searchesComplete && coverage.endIndex >= coverage.eligibleAnchors && batchComplete,
  };
}

export function finalizedComparisonTargetCoverage(
  coverage: DiscoveryResult["productSearchCoverage"],
  candidateDomainsScheduled: number,
  settledStatuses: Array<"fulfilled" | "rejected">,
  results: Array<Pick<DomainCrawl, "homepage" | "gaps"> | null>,
  acceptedPairCount: number,
  pairTarget: number,
) {
  const target = Math.max(0, Math.floor(pairTarget));
  const accepted = Math.max(0, Math.floor(acceptedPairCount));
  const pairTargetComplete = target > 0 && accepted >= target;
  const verificationComplete = pairTargetComplete || settledStatuses.every((status, index) => status === "fulfilled" && competitorInvestigationComplete(results[index]));
  const candidateTruncated = !pairTargetComplete && (coverage.candidateTruncated || candidateDomainsScheduled > settledStatuses.length);
  const batchComplete = pairTargetComplete || (coverage.batchComplete && !candidateTruncated && candidateDomainsScheduled === settledStatuses.length && verificationComplete);
  return {
    ...coverage,
    candidateDomainsInvestigated: settledStatuses.length,
    candidateTruncated,
    verificationComplete,
    batchComplete,
    // A crawl-side pair target is provisional. Final enrichment and the
    // publication graph may still suppress or collapse a pair, so only true
    // exhaustion of the searched universe may close discovery permanently.
    complete: coverage.complete,
    acceptedPairCount: accepted,
    pairTarget: target,
  };
}

export function verifiedExactMatchHints(confirmed: DomainCrawl[]) {
  const candidates = confirmed.flatMap((result) => result.verifiedExactProductPairs?.length
    ? result.verifiedExactProductPairs.map((pair) => ({ primaryId: pair.primary.id, rivalDomain: result.domain, rivalId: pair.rival.id, confidence: pair.confidence }))
    : result.discovery?.exactProductPairVerified && result.discovery.provenPrimaryProduct && result.discovery.provenRivalProduct
      ? [{ primaryId: result.discovery.provenPrimaryProduct.id, rivalDomain: result.domain, rivalId: result.discovery.provenRivalProduct.id, confidence: 0.8 }]
      : []).sort((left, right) => right.confidence - left.confidence || left.primaryId.localeCompare(right.primaryId) || left.rivalDomain.localeCompare(right.rivalDomain) || left.rivalId.localeCompare(right.rivalId));
  const primaryAssignments = new Set<string>();
  const rivalAssignments = new Set<string>();
  return candidates.flatMap(({ primaryId, rivalDomain, rivalId }) => {
    const primaryKey = `${primaryId}|${rivalDomain}`;
    const rivalKey = `${rivalDomain}|${rivalId}`;
    if (primaryAssignments.has(primaryKey) || rivalAssignments.has(rivalKey)) return [];
    primaryAssignments.add(primaryKey);
    rivalAssignments.add(rivalKey);
    return [{ primaryId, rivalDomain, rivalId }];
  }).slice(0, 6_000);
}

export function selectComparisonTarget(primaryProducts: ProductRecord[], confirmed: DomainCrawl[], pairTarget: number, marketCountryCode: string, referenceTimeMs = Date.now()) {
  const target = Math.max(0, Math.floor(pairTarget));
  if (!target) return { hints: [], competitors: [] as DomainCrawl[] };
  const primaryById = new Map(primaryProducts.map((product) => [product.id, product]));
  const candidates = confirmed.flatMap((result) => (result.verifiedExactProductPairs || []).map((pair) => {
    const primary = primaryById.get(pair.primary.id) || pair.primary;
    const rival = result.products.find((product) => product.id === pair.rival.id) || pair.rival;
    return { primary, rival, rivalDomain: result.domain, confidence: pair.confidence };
  })).filter((pair) => hasComparablePublicPricePair(pair.primary, pair.rival, referenceTimeMs, marketCountryCode))
    .sort((left, right) => right.confidence - left.confidence
      || left.primary.id.localeCompare(right.primary.id)
      || left.rivalDomain.localeCompare(right.rivalDomain)
      || left.rival.id.localeCompare(right.rival.id));
  const selected: typeof candidates = [];
  const pairKeys = new Set<string>();
  const primaryDomains = new Set<string>();
  const rivalAssignments = new Set<string>();
  for (const pair of candidates) {
    const pairKey = `${pair.primary.id}|${pair.rivalDomain}|${pair.rival.id}`;
    const primaryDomainKey = `${pair.primary.id}|${pair.rivalDomain}`;
    const rivalKey = `${pair.rivalDomain}|${pair.rival.id}`;
    if (pairKeys.has(pairKey) || primaryDomains.has(primaryDomainKey) || rivalAssignments.has(rivalKey)) continue;
    pairKeys.add(pairKey);
    primaryDomains.add(primaryDomainKey);
    rivalAssignments.add(rivalKey);
    selected.push(pair);
    if (selected.length >= target) break;
  }
  const hints = selected.map((pair) => ({ primaryId: pair.primary.id, rivalDomain: pair.rivalDomain, rivalId: pair.rival.id }));
  const selectedKeys = new Set(selected.map((pair) => `${pair.primary.id}|${pair.rivalDomain}|${pair.rival.id}`));
  const selectedDomains = [...new Set(hints.map((hint) => hint.rivalDomain))];
  const byDomain = new Map(confirmed.map((result) => [result.domain, result]));
  const competitors = selectedDomains.flatMap((domain) => {
    const result = byDomain.get(domain);
    if (!result) return [];
    const verifiedExactProductPairs = (result.verifiedExactProductPairs || []).filter((pair) => selectedKeys.has(`${pair.primary.id}|${domain}|${pair.rival.id}`));
    const rivalIds = new Set(verifiedExactProductPairs.map((pair) => pair.rival.id));
    return [{ ...result, verifiedExactProductPairs, products: result.products.filter((product) => rivalIds.has(product.id)) }];
  });
  return { hints, competitors };
}

function productPathPriority(path: string) {
  if (/\/(?:pricing|plans?)(?:\/|$)/i.test(path)) return -10;
  if (/\/(?:products?)\/[^/]+/i.test(path) || /\/(?:-\/)?p\d+(?:\/|$)/i.test(path)) return -5;
  if (/\/(?:boxes?|bundles?|subscriptions?|products?|shop|store|collections?|catalog|solutions?|services?|capabilities|expertise|platform|features?)(?:\/|$)/i.test(path)) return 0;
  if (/^\/[^/]+\/?$/.test(path) && !/\/(?:about|blog|careers?|contact|customers?|docs?|help|login|news|press|privacy|resources?|support|terms)(?:\/|$)/i.test(path)) return 30;
  const exact = PRIORITY_PATHS.indexOf(path);
  if (exact >= 0) return 200 + exact;
  return 999;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").replace(/&nbsp;/gi, " ").trim();
}

function decodeEntities(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function stripMarkup(value: string) {
  return cleanText(decodeEntities(value.replace(/<[^>]*>/g, " ")));
}

function firstMatch(document: string, expression: RegExp) {
  return document.match(expression)?.[1] ?? "";
}

function allMatches(document: string, expression: RegExp) {
  return [...document.matchAll(expression)].map((match) => cleanText(decodeEntities(match[1] ?? ""))).filter(Boolean);
}

function unique(values: string[], limit = 20) {
  return [...new Set(values)].slice(0, limit);
}

function prices(text: string) {
  return unique(text.match(/(?:[$€£]\s?\d{1,5}(?:[,.]\d{1,2})?|\d{1,5}(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP))(?:\s*\/\s*(?:mo|month|year|yr|user))?/gi)?.map(cleanText) ?? [], 12);
}

function socialLinks(document: string, baseUrl: URL) {
  return unique(allMatches(document, /href\s*=\s*["']([^"']+)["']/gi).flatMap((href) => {
    try {
      const url = new URL(href, baseUrl);
      return SOCIAL_HOSTS.some((host) => url.hostname.includes(host)) ? [url.toString()] : [];
    } catch {
      return [];
    }
  }), 12);
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function fetchText(url: string, accept: string, expectedDomain?: string) {
  return fetchPublicText(url, accept, { expectedDomain, timeoutMs: REQUEST_TIMEOUT_MS, maxDocumentBytes: MAX_DOCUMENT_BYTES, userAgent: USER_AGENT });
}

function alternateHomepageBase(base: URL, domain: string) {
  const hostname = base.hostname.toLowerCase();
  const alternateHost = hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
  try {
    const alternate = normalizeDomain(`https://${alternateHost}`);
    return canonicalDomain(alternate.hostname) === canonicalDomain(domain) && alternate.hostname !== hostname ? alternate : null;
  } catch {
    return null;
  }
}

function isHtmlHomepage(result: Awaited<ReturnType<typeof fetchText>>) {
  return result.ok && /text\/html|application\/xhtml\+xml/i.test(result.contentType);
}

function canRecoverHomepageOnAlternateHost(result: Awaited<ReturnType<typeof fetchText>>) {
  if (result.redirectDomain || result.status === 429) return false;
  return result.failureKind === "network"
    || result.failureKind === "timeout"
    || result.status === 403
    || result.status === 404
    || result.status === 410
    || result.status >= 500;
}

function extractLinks(document: string, baseUrl: URL, domain: string) {
  const paths: string[] = [];
  const candidates = new Map<string, { domain: string; text: string; sourceUrl: string }>();
  for (const match of document.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1] ?? "";
    const anchorText = stripMarkup(match[2] ?? "");
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      url.search = "";
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (canonicalDomain(url.hostname) === domain) {
        if (url.pathname !== "/") paths.push(url.pathname);
      } else if (!SOCIAL_HOSTS.some((host) => url.hostname.includes(host)) && /\b(compare|alternative|competitor|similar|versus|vs\.?)/i.test(anchorText)) {
        const candidateDomain = canonicalDomain(url.hostname);
        if (candidateDomain !== domain && !candidates.has(candidateDomain)) candidates.set(candidateDomain, { domain: candidateDomain, text: anchorText || "linked market reference", sourceUrl: baseUrl.toString() });
      }
    } catch {
      continue;
    }
  }
  return { paths: unique(paths, 60), candidates: [...candidates.values()] };
}

function parseSitemapUrls(text: string, domain: string) {
  return unique([...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)].flatMap((match) => {
    try {
      const url = new URL(decodeEntities(match[1]));
      return canonicalDomain(url.hostname) === domain ? [url.toString()] : [];
    } catch {
      return [];
    }
  }), 500);
}

function sitemapDocumentPriority(value: string) {
  try {
    const path = decodeURIComponent(new URL(value).pathname).toLowerCase();
    if (/products?/.test(path)) return 0;
    if (/catalog|collections?|categories?/.test(path)) return 1;
    if (/pages?|blogs?|articles?|metaobjects?/.test(path)) return 3;
    return 2;
  } catch {
    return 4;
  }
}

export function prioritizedSitemapDocuments(values: string[], maxDocuments: number) {
  const limit = Math.max(0, Math.floor(maxDocuments));
  return [...values]
    .sort((left, right) => sitemapDocumentPriority(left) - sitemapDocumentPriority(right) || left.localeCompare(right))
    .slice(0, limit);
}

async function collectSitemapEvidence(sitemapUrl: string, domain: string, observedAt: string, maxDocuments = MAX_SITEMAP_DOCUMENTS, fetchPage = fetchText) {
  const root = await fetchPage(sitemapUrl, "application/xml,text/xml,text/plain", domain);
  if (!root.ok) return { paths: [] as string[], products: [] as ProductRecord[], truncated: true };
  const rootUrls = parseSitemapUrls(root.text, domain);
  const eligibleChildSitemaps = rootUrls.filter((value) => /sitemap[^/]*\.xml/i.test(new URL(value).pathname));
  const childSitemaps = prioritizedSitemapDocuments(eligibleChildSitemaps, maxDocuments);
  const documents = childSitemaps.length ? await Promise.all(childSitemaps.map(async (url) => ({ url, result: await fetchPage(url, "application/xml,text/xml,text/plain", domain) }))) : [{ url: sitemapUrl, result: root }];
  const urls = documents.flatMap(({ result }) => result.ok ? parseSitemapUrls(result.text, domain) : []);
  const sitemapFetchFailed = documents.some(({ result }) => !result.ok);
  const extracted = documents.map(({ result }) => result.ok ? extractProductsFromSitemapWithCoverage(result.text, domain, observedAt) : { products: [] as ProductRecord[], truncated: true });
  const products = extracted.flatMap((result) => result.products);
  const selectedProducts = selectPreferredProducts(products);
  return {
    paths: unique(urls.flatMap((value) => { try { return [new URL(value).pathname]; } catch { return []; } }), 500),
    products: selectedProducts,
    truncated: sitemapFetchFailed
      || extracted.some((result) => result.truncated)
      || (eligibleChildSitemaps.length > childSitemaps.length && selectedProducts.length < MAX_PRIMARY_CATALOG_PRODUCTS),
  };
}

function makeClaim(domain: string, suffix: string, text: string, sourceUrl: string, observedAt: string, claimType: ClaimType = "Observed", confidence: Confidence = "High"): Claim {
  return { id: `${domain}-${suffix}`, claimType, text: text.slice(0, 300), sourceUrl, observedAt, confidence };
}

async function parsePage(document: string, sourceUrl: string, fetchedAt: string, domain: string, truncated: boolean, transport: { responseTimeMs: number; responseBytes: number }, preparedExtractionDocument?: string): Promise<CrawlPage> {
  const url = new URL(sourceUrl);
  const extractionDocument = preparedExtractionDocument || boundedExtractionDocument(document, MAX_HTML_EXTRACTION_BYTES);
  const readable = stripMarkup(extractionDocument.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " "));
  const title = stripMarkup(firstMatch(extractionDocument, /<title[^>]*>([\s\S]*?)<\/title>/i)) || domain;
  const description = decodeEntities(firstMatch(extractionDocument, /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i) || firstMatch(extractionDocument, /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["']/i));
  const headings = unique(allMatches(extractionDocument, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi).map(stripMarkup), 16);
  const internalLinks = unique(extractLinks(extractionDocument, url, domain).paths, 20);
  const language = firstMatch(extractionDocument, /<html[^>]*\blang\s*=\s*["']([^"']+)["']/i).toLowerCase() || "unknown";
  const imageTags = [...extractionDocument.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const imagesWithAlt = imageTags.filter((tag) => /\balt\s*=\s*["'][^"']+[^\s"'][^"']*["']/i.test(tag)).length;
  const responsiveImageCount = imageTags.filter((tag) => /\bsrcset\s*=|\bsizes\s*=/i.test(tag)).length;
  const hasViewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(extractionDocument);
  const productLinkCount = internalLinks.filter((path) => PRODUCT_ROUTE_PATH.test(path)).length;
  const hasProductPath = PRODUCT_ROUTE_PATH.test(url.pathname);
  const hasAddToCart = hasObservedAddToCartControl(extractionDocument);
  const hasCartLink = /href\s*=\s*["'][^"']*\/cart(?:[/?#"'])/i.test(extractionDocument);
  const hasCheckoutLink = /href\s*=\s*["'][^"']*\/(?:checkout|checkouts)(?:[/?#"'])/i.test(extractionDocument);
  const trustSignals = unique([
    ...internalLinks.flatMap((path) => /\b(?:shipping|delivery)\b/i.test(path) ? ["shipping"] : []),
    ...internalLinks.flatMap((path) => /\b(?:returns?|refunds?)\b/i.test(path) ? ["returns"] : []),
    ...internalLinks.flatMap((path) => /\b(?:contact|support|help)\b/i.test(path) ? ["contact"] : []),
    ...internalLinks.flatMap((path) => /\b(?:privacy|terms|legal)\b/i.test(path) ? ["legal"] : []),
    ...internalLinks.flatMap((path) => /\b(?:about|reviews?|testimonials?)\b/i.test(path) ? ["company"] : []),
  ], 5);
  const observedAt = fetchedAt;
  const textContent = `${title} ${description} ${readable}`;
  const observedPrices = prices(readable);
  const claimablePrices = claimablePagePricePatterns(observedPrices);
  const priceSignals = PRODUCT_ROUTE_PATH.test(url.pathname) ? observedPrices : [];
  const claimablePriceSignals = PRODUCT_ROUTE_PATH.test(url.pathname) ? claimablePrices : [];
  const regionInference = inferRegionEvidence({ domain, language, document: extractionDocument, text: textContent, priceSignals: observedPrices, sourceUrl });
  const productExtraction = extractProductsFromHtml({ document: extractionDocument, sourceUrl, domain, observedAt, pageTitle: title, pageDescription: description, headings, pagePriceSignals: priceSignals });
  const claims: Claim[] = [
    makeClaim(domain, `${url.pathname}-title`, `${domain} presents itself as “${title}”.`, sourceUrl, observedAt),
    ...(description ? [makeClaim(domain, `${url.pathname}-description`, `${domain} describes itself as “${description}”.`, sourceUrl, observedAt)] : []),
    ...(claimablePriceSignals.length ? [makeClaim(domain, `${url.pathname}-prices`, `${domain} exposes these public price patterns: ${claimablePriceSignals.join(", ")}.`, sourceUrl, observedAt)] : []),
    ...(headings.length ? [makeClaim(domain, `${url.pathname}-headings`, `${domain} uses these public headings: ${headings.slice(0, 5).join("; ")}.`, sourceUrl, observedAt)] : []),
    makeClaim(domain, `${url.pathname}-language`, `${domain} exposes language ${language || "unknown"} and region signal ${displayRegion(regionInference)}.`, sourceUrl, observedAt, "Inferred", regionInference.confidence),
    makeClaim(domain, `${url.pathname}-social`, `${domain} links to ${socialLinks(extractionDocument, url).length} public social profiles from this page.`, sourceUrl, observedAt),
    ...productExtraction.products.map((product) => ({ id: product.claimIds[0], claimType: "Observed" as const, text: `${domain} exposes product or service “${product.name}” via ${product.extraction === "json-ld" ? "structured JSON-LD" : product.extraction === "storefront-api" ? "a structured public storefront endpoint" : "a product-like public page"}.`, sourceUrl: product.sourceUrl, observedAt: product.observedAt, confidence: product.confidence })),
  ];
  return { ok: true, live: true, domain, url: sourceUrl, path: url.pathname, sourceUrl, fetchedAt, title, description: description || "No meta description was exposed on the public page.", language: language || "unknown", region: displayRegion(regionInference), regionCountryCode: regionInference.countryCode, regionConfidence: regionInference.confidence, regionSignals: regionInference.signals, headings, prices: claimablePriceSignals, socialLinks: socialLinks(extractionDocument, url), internalLinks, wordCount: readable ? readable.split(/\s+/).length : 0, truncated, contentHash: await hash(document), claims, products: productExtraction.products, productGaps: productExtraction.gaps, thirdPartyProductCount: productExtraction.thirdPartyReferenced.length, responseTimeMs: transport.responseTimeMs, responseBytes: transport.responseBytes, imageCount: imageTags.length, imagesWithAlt, responsiveImageCount, hasViewport, hasDocumentLanguage: language !== "unknown", productLinkCount, hasProductPath, hasAddToCart, hasCartLink, hasCheckoutLink, trustSignals };
}

type CrawlDomainDependencies = {
  fetchText?: typeof fetchText;
  robotsResolver?: Pick<typeof sharedRobotsPolicyResolver, "resolve">;
  schedule?: <T>(work: () => Promise<T>) => Promise<T>;
};

export async function crawlDomain(input: string, role: DomainCrawl["role"], seededProductUrls: string[] = [], dependencies: CrawlDomainDependencies = {}): Promise<DomainCrawl> {
  const startedAt = new Date().toISOString();
  const rawFetchPage = dependencies.fetchText || fetchText;
  const fetchPage: typeof fetchText = (...args) => dependencies.schedule
    ? dependencies.schedule(() => rawFetchPage(...args))
    : rawFetchPage(...args);
  const robotsResolver = dependencies.robotsResolver || sharedRobotsPolicyResolver;
  const maxHtmlPages = role === "discovered-competitor" ? MAX_DISCOVERED_HTML_PAGES : MAX_HTML_PAGES;
  const maxSitemapDocuments = role === "discovered-competitor" ? MAX_DISCOVERED_SITEMAP_DOCUMENTS : MAX_SITEMAP_DOCUMENTS;
  let base: URL;
  try {
    base = normalizeDomain(input);
  } catch (error) {
    const domain = canonicalDomain(input);
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps: [{ url: input, reason: error instanceof Error ? error.message : "invalid or private domain.", observedAt: startedAt }], coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: false }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const domain = canonicalDomain(base.hostname);
  const gaps: Gap[] = [];
  let robotsResult = await robotsResolver.resolve(domain, base.hostname);
  let robotsState = robotsResult.availability;
  let robots = robotsResult.policy;
  if (robotsState === "available" && !robots.allows("/")) {
    gaps.push({ url: base.toString(), reason: "robots.txt disallows the homepage for this scanner.", observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 0, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: true }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  let homepageRequests = 1;
  const submittedBase = new URL(base.toString());
  const submittedHomepageResult = await fetchPage(base.toString(), "text/html,application/xhtml+xml", domain);
  let homepageResult = submittedHomepageResult;
  const alternateBase = alternateHomepageBase(base, domain);
  let attemptedAlternateBase: URL | null = null;
  const robotsThrottled = robotsState === "unreachable" && robotsResult.status === 429;
  if (!robotsThrottled && !isHtmlHomepage(homepageResult) && alternateBase && canRecoverHomepageOnAlternateHost(homepageResult)) {
    const robotsRefusedSubmittedHost = robotsState === "unreachable" && [401, 403, 407, 451].includes(robotsResult.status);
    if (robotsRefusedSubmittedHost) {
      robotsResult = await robotsResolver.resolve(domain, alternateBase.hostname);
      robotsState = robotsResult.availability;
      robots = robotsResult.policy;
    }
    const alternateRobotsThrottled = robotsState === "unreachable" && robotsResult.status === 429;
    if (!alternateRobotsThrottled) {
      if (robotsState === "available" && !robots.allows("/")) {
        gaps.push({ url: alternateBase.toString(), reason: "robots.txt disallows the homepage for this scanner; the alternate host was not fetched.", observedAt: startedAt });
        return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: homepageRequests, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: true }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
      }
      homepageRequests += 1;
      attemptedAlternateBase = alternateBase;
      homepageResult = await fetchPage(alternateBase.toString(), "text/html,application/xhtml+xml", domain);
      if (isHtmlHomepage(homepageResult)) {
        gaps.push({
          url: submittedBase.toString(),
          reason: `${submittedBase.toString()} returned ${submittedHomepageResult.error || `HTTP ${submittedHomepageResult.status}`}; the crawl continued on the same company's canonical host ${alternateBase.toString()}.`,
          observedAt: startedAt,
        });
        base = normalizeDomain(homepageResult.url || alternateBase.toString());
      } else {
        gaps.push({ url: submittedBase.toString(), reason: submittedHomepageResult.error || `homepage returned HTTP ${submittedHomepageResult.status}.`, observedAt: startedAt });
      }
    }
  }
  if (robotsState === "missing") gaps.push({ url: robotsResult.sourceUrl, reason: `No robots.txt was published (HTTP ${robotsResult.status}); the bounded public crawl proceeded.`, observedAt: startedAt });
  if (robotsState === "unreachable") gaps.push({ url: robotsResult.sourceUrl, reason: "robots.txt was unreachable; expansion is limited to the homepage.", observedAt: startedAt });
  if (!isHtmlHomepage(homepageResult)) {
    const failedUrl = attemptedAlternateBase?.toString() || base.toString();
    gaps.push({ url: failedUrl, reason: homepageResult.error || `homepage returned HTTP ${homepageResult.status}.`, observedAt: startedAt });
    const noHostResponded = Boolean(submittedHomepageResult.failureKind && homepageResult.failureKind);
    const homepageAccessDenied = attemptedAlternateBase && submittedHomepageResult.status === 403 && homepageResult.status === 403
      ? { status: 403 as const, hosts: [submittedBase.hostname, attemptedAlternateBase.hostname] }
      : null;
    const submittedFailure = { kind: submittedHomepageResult.failureKind as "network" | "timeout", attemptedUrl: submittedBase.toString(), reason: submittedHomepageResult.error || "request failed", observedAt: startedAt };
    const finalFailure = { kind: homepageResult.failureKind as "network" | "timeout", attemptedUrl: failedUrl, reason: homepageResult.error || "request failed", observedAt: startedAt };
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: homepageRequests, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: robotsState === "available" }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt, ...(noHostResponded ? { homepageFailure: preferredEndpointFailure(submittedFailure, finalFailure) } : {}), ...(homepageAccessDenied ? { homepageAccessDenied } : {}) };
  }
  const homepageHost = new URL(homepageResult.url).hostname.toLowerCase().replace(/^www\./, "");
  if (homepageHost !== domain.replace(/^www\./, "")) {
    gaps.push({ url: base.toString(), reason: "homepage redirected off the submitted domain.", observedAt: startedAt });
    return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: 1, pagesFetched: 0, maxPages: maxHtmlPages, robotsChecked: robotsState === "available" }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt };
  }
  const clientRedirect = extractStaticClientRedirect(homepageResult.text, homepageResult.url);
  if (clientRedirect) {
    const redirectResult = await fetchPage(clientRedirect, "text/html,application/xhtml+xml", domain);
    const provider = redirectResult.redirectDomain ? parkingProvider(redirectResult.redirectDomain) : "";
    if (provider) {
      gaps.push({ url: clientRedirect, reason: `${domain} redirects to a ${provider} domain-for-sale service; no company report was generated.`, observedAt: startedAt });
      return { domain, role, homepage: null, pages: [], products: [], candidates: [], gaps, coverage: { pagesRequested: homepageRequests + 1, pagesFetched: 1, maxPages: maxHtmlPages, robotsChecked: robotsState === "available" }, productCoverage: { scannedPages: 0, catalogProductsDiscovered: 0, thirdPartyReferenced: 0 }, fetchedAt: startedAt, siteState: { status: "parked", provider, evidenceUrl: clientRedirect, redirectDomain: redirectResult.redirectDomain! } };
    }
  }
  const homepageExtractionDocument = boundedExtractionDocument(homepageResult.text, MAX_HTML_EXTRACTION_BYTES);
  const homepage = await parsePage(homepageResult.text, homepageResult.url, startedAt, domain, homepageResult.truncated, homepageResult, homepageExtractionDocument);
  const discovered = extractLinks(homepageExtractionDocument, new URL(homepageResult.url), domain);
  let sitemapPaths: string[] = [];
  let sitemapProducts: ProductRecord[] = [];
  let sitemapTruncated = false;
  const sitemapUrl = (() => { try { const candidate = new URL(robots.sitemaps[0] || "/sitemap.xml", base); return canonicalDomain(candidate.hostname) === canonicalDomain(domain) && /^https?:$/.test(candidate.protocol) ? candidate.toString() : new URL("/sitemap.xml", base).toString(); } catch { return new URL("/sitemap.xml", base).toString(); } })();
  if (robotsState !== "unreachable" && role !== "discovered-competitor") {
    const sitemapEvidence = await collectSitemapEvidence(sitemapUrl, domain, startedAt, maxSitemapDocuments, fetchPage);
    sitemapPaths = sitemapEvidence.paths;
    sitemapProducts = sitemapEvidence.products;
    sitemapTruncated = sitemapEvidence.truncated;
  }
  const candidates = discovered.candidates.slice(0, 12).map((candidate, index) => ({ domain: candidate.domain, reason: `A public page linked to this domain with “${candidate.text.slice(0, 120)}”. This is a possible match, not a confirmed competitor.`, sourceUrl: candidate.sourceUrl, claimIds: [`${domain}-candidate-${index}`] }));
  candidates.forEach((candidate, index) => homepage.claims.push(makeClaim(domain, `candidate-${index}`, `${domain} linked to possible market candidate ${candidate.domain}; anchor context supports investigation only.`, candidate.sourceUrl, startedAt, "Inferred", "Low")));
  const seededPaths = seededCrawlPaths(seededProductUrls, domain);
  const observedPaths = robotsState !== "unreachable" && role !== "discovered-competitor" ? unique([...discovered.paths, ...sitemapPaths], 500) : [];
  const sortedObservedPaths = observedPaths.sort((left, right) => {
    return productPathPriority(left) - productPathPriority(right) || left.localeCompare(right);
  });
  const expandablePaths = unique([...seededPaths, ...sortedObservedPaths], maxHtmlPages - 1);
  const paths = expandablePaths.filter((path) => robots.allows(new URL(path, base).pathname));
  for (const path of expandablePaths) if (!robots.allows(new URL(path, base).pathname)) gaps.push({ url: new URL(path, base).toString(), reason: "robots.txt disallows this crawl path.", observedAt: startedAt });
  const fetchedPageResults = await settleWithConcurrency(paths, COMPETITOR_PAGE_CONCURRENCY, async (path) => {
    const url = new URL(path, base).toString();
    const result = await fetchPage(url, "text/html,application/xhtml+xml", domain);
    if (!result.ok || !/text\/html|application\/xhtml\+xml/i.test(result.contentType)) { gaps.push({ url, reason: result.error || `page returned HTTP ${result.status} or non-HTML content.`, observedAt: startedAt }); return null; }
    const finalHost = new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
    if (finalHost !== domain.replace(/^www\./, "")) { gaps.push({ url, reason: "redirected off the submitted domain.", observedAt: startedAt }); return null; }
    const page = await parsePage(result.text, result.url, new Date().toISOString(), domain, result.truncated, result);
    return { ...page, requestedSourceUrl: url };
  });
  const fetchedPages = fetchedPageResults.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    gaps.push({ url: new URL(paths[index], base).toString(), reason: "page processing failed before verification completed.", observedAt: startedAt });
    return null;
  });
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const pages: CrawlPage[] = [homepage, ...(fetchedPages.filter(Boolean) as CrawlPage[])].filter((page) => {
    const normalizedUrl = page.sourceUrl.split("#")[0];
    if (seenUrls.has(normalizedUrl) || seenHashes.has(page.contentHash)) return false;
    seenUrls.add(normalizedUrl);
    seenHashes.add(page.contentHash);
    return true;
  });
  const combinedRegion = combineRegionSignals(pages.flatMap((page) => page.regionSignals));
  if (combinedRegion.countryCode) {
    homepage.region = displayRegion(combinedRegion);
    homepage.regionCountryCode = combinedRegion.countryCode;
    homepage.regionConfidence = combinedRegion.confidence;
    homepage.regionSignals = combinedRegion.signals;
  }
  for (const page of pages) for (const reason of page.productGaps) gaps.push({ url: page.sourceUrl, reason, observedAt: page.fetchedAt });
  const observedProducts = selectPreferredProducts([...sitemapProducts, ...pages.flatMap((page) => page.products)]);
  const business = inferBusinessProfile({
    domain,
    title: homepage.title,
    description: homepage.description,
    region: homepage.region,
    language: homepage.language,
    products: observedProducts,
    pages: pages.map((page) => ({ title: page.title, description: page.description, path: page.path, sourceUrl: page.sourceUrl, headings: page.headings })),
  });
  const fallbackOfferings = observedProducts.length >= 5 ? [] : extractFirstPartyOfferings({
    domain,
    observedAt: startedAt,
    businessType: business.businessType,
    pages: pages.map((page) => ({ sourceUrl: page.sourceUrl, title: page.title, description: page.description, headings: page.headings })),
  });
  for (const offering of fallbackOfferings) {
    const page = pages.find((candidate) => candidate.sourceUrl === offering.sourceUrl);
    if (page && !page.claims.some((claim) => claim.id === offering.claimIds[0])) page.claims.push({ id: offering.claimIds[0], claimType: "Observed", text: `${domain} presents “${offering.name}” as a first-party ${business.businessType === "ecommerce" ? "subscription or product option" : "service or capability"}.`, sourceUrl: offering.sourceUrl, observedAt: offering.observedAt, confidence: "Medium" });
  }
  const products = selectPreferredProducts([...observedProducts, ...fallbackOfferings]);
  return { domain, role, homepage, pages, products, candidates, gaps, coverage: { pagesRequested: homepageRequests + paths.length, pagesFetched: pages.length, maxPages: maxHtmlPages, robotsChecked: robotsState === "available" }, productCoverage: { scannedPages: pages.length, catalogProductsDiscovered: sitemapProducts.length, thirdPartyReferenced: pages.reduce((sum, page) => sum + page.thirdPartyProductCount, 0), sitemapTruncated }, fetchedAt: startedAt };
}

function comparisonSourceUrls(results: DomainCrawl[], primaryDomain: string) {
  const primary = results.find((result) => result.domain === primaryDomain);
  const required = Object.fromEntries(results.map((result) => [result.domain, [
    result.discovery?.provenPrimaryProduct?.sourceUrl,
    result.discovery?.provenRivalProduct?.sourceUrl,
    ...(result.verifiedExactProductPairs || []).map((pair) => pair.rival.sourceUrl),
  ].filter((value): value is string => Boolean(value))]));
  for (const result of results.filter((candidate) => candidate.role === "discovered-competitor" && candidate.discovery?.accepted)) {
    if (primary && result.discovery?.provenPrimaryProduct?.sourceUrl) (required[primary.domain] ||= []).push(result.discovery.provenPrimaryProduct.sourceUrl);
    if (primary) (required[primary.domain] ||= []).push(...(result.verifiedExactProductPairs || []).map((pair) => pair.primary.sourceUrl));
  }
  return required;
}

export async function reconcilePreliminaryPrimaryCatalog(results: DomainCrawl[], primaryDomain: string, localDependencies?: EnrichmentDependencies) {
  const preliminary = buildProductComparison(primaryDomain, results.map((result) => ({ domain: result.domain, products: result.products })), comparisonSourceUrls(results, primaryDomain));
  const primary = results.find((result) => result.domain === primaryDomain);
  if (!primary) return results;
  const plan = planPreliminaryCatalogReconciliation(preliminary, primary.products, MAX_CATALOG_RECONCILIATION_PAGES);
  const targets = plan.targets;
  if (!targets.length) return results;
  const enrichment = await enrichProductTargets(targets, MAX_CATALOG_RECONCILIATION_PAGES, localDependencies);
  const observedAt = new Date().toISOString();
  return results.map((result) => result.domain === primaryDomain ? {
    ...result,
    products: applyPreMatchCatalogEnrichment(result.products, enrichment.products),
    gaps: [
      ...result.gaps,
      ...enrichment.coverage.gaps.map((gap) => ({ url: gap.url, reason: `Preliminary catalog reconciliation: ${gap.reason}`, observedAt })),
      ...(plan.truncated ? [{ url: result.homepage?.sourceUrl || `https://${primaryDomain}/`, reason: `Preliminary catalog reconciliation selected ${targets.length} of ${plan.totalEligible} price-less primary products; the remaining catalog was not refreshed in this report.`, observedAt }] : []),
    ],
    catalogReconciliation: {
      pagesRequested: enrichment.coverage.pagesRequested,
      pagesFetched: enrichment.coverage.pagesFetched,
      maxPages: MAX_CATALOG_RECONCILIATION_PAGES,
      eligibleProducts: plan.totalEligible,
      truncated: plan.truncated,
    },
  } : result);
}

async function enrichMatchedProductPages(inputResults: DomainCrawl[], primaryDomain: string) {
  const results = await reconcilePreliminaryPrimaryCatalog(inputResults, primaryDomain);
  const primaryMarketCountryCode = results.find((result) => result.domain === primaryDomain)?.homepage?.regionCountryCode || "";
  const comparison = buildProductComparison(primaryDomain, results.map((result) => ({ domain: result.domain, products: result.products })), comparisonSourceUrls(results, primaryDomain));
  const targets = selectProductEnrichmentTargets(comparison, MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES);
  if (!targets.length) return results;
  const grouped = new Map<string, string[]>();
  for (const target of targets) {
    const urls = grouped.get(target.domain) || [];
    if (!urls.includes(target.sourceUrl)) urls.push(target.sourceUrl);
    grouped.set(target.domain, urls);
  }
  const updates = await Promise.all([...grouped].map(async ([domain, sourceUrls]) => {
    const result = results.find((candidate) => candidate.domain === domain);
    const observedAt = new Date().toISOString();
    const gaps: Gap[] = [];
    if (!result?.homepage) return { domain, sourceUrls, pages: [] as CrawlPage[], gaps };
    const base = normalizeDomain(result.homepage.sourceUrl);
    const robotsResult = await sharedRobotsPolicyResolver.resolve(domain, base.hostname);
    const robotsUrl = robotsResult.sourceUrl;
    const robotsState = robotsResult.availability;
    if (robotsState === "unreachable") {
      for (const sourceUrl of sourceUrls) gaps.push({ url: sourceUrl, reason: "Matched product price enrichment was skipped because robots.txt was unreachable.", observedAt });
      return { domain, sourceUrls, pages: [] as CrawlPage[], gaps };
    }
    if (robotsState === "missing") gaps.push({ url: robotsUrl, reason: `No robots.txt was published (HTTP ${robotsResult.status}); bounded matched-product enrichment proceeded.`, observedAt });
    const robots = robotsResult.policy;
    const entries = await Promise.all(sourceUrls.map(async (sourceUrl) => {
      const path = new URL(sourceUrl).pathname;
      if (!robots.allows(path)) return { page: null, gap: { url: sourceUrl, reason: "robots.txt disallows this matched product price-enrichment page.", observedAt } as Gap };
      let fetched = await fetchText(sourceUrl, "text/html,application/xhtml+xml", domain);
      if (!fetched.ok || !/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) return { page: null, gap: { url: sourceUrl, reason: fetched.error || `Matched product price-enrichment page returned HTTP ${fetched.status} or non-HTML content.`, observedAt } as Gap };
      const marketRetryUrl = redirectedMarketRetryUrl(sourceUrl, fetched.url, primaryMarketCountryCode);
      if (marketRetryUrl && robots.allows(new URL(marketRetryUrl).pathname)) {
        const marketFetch = await fetchText(marketRetryUrl, "text/html,application/xhtml+xml", domain);
        if (marketFetch.ok && /text\/html|application\/xhtml\+xml/i.test(marketFetch.contentType)) fetched = marketFetch;
      }
      try {
        const page = await parsePage(fetched.text, fetched.url, new Date().toISOString(), domain, fetched.truncated, fetched);
        const sourceKey = (value: string) => value.split("#")[0].replace(/\/$/, "");
        const expected = result.products.filter((product) => sourceKey(product.sourceUrl) === sourceKey(sourceUrl));
        const identity = validateProductPageIdentity(expected, page.products, page.title);
        if (!identity.accepted) return { page: null, gap: { url: sourceUrl, reason: identity.reason, observedAt } as Gap };
        const acceptedPage = { ...page, products: identity.products };
        const hasPrice = identity.products.some((product) => product.priceSignals.some((signal) => typeof signal.amount === "number" && Boolean(signal.currency)));
        return { page: acceptedPage, gap: hasPrice ? null : { url: sourceUrl, reason: "The matched public product page was fetched but did not expose comparable structured price evidence.", observedAt } as Gap };
      } catch {
        return { page: null, gap: { url: sourceUrl, reason: "The matched public product page could not be parsed for price evidence.", observedAt } as Gap };
      }
    }));
    return { domain, sourceUrls, pages: entries.flatMap((entry) => entry.page ? [entry.page] : []), gaps: [...gaps, ...entries.flatMap((entry) => entry.gap ? [entry.gap] : [])] };
  }));
  const updateByDomain = new Map(updates.map((update) => [update.domain, update]));
  return results.map((result) => {
    const update = updateByDomain.get(result.domain);
    if (!update) return result;
    return {
      ...result,
      enrichmentPages: update.pages,
      priceEnrichment: { pagesRequested: update.sourceUrls.length, pagesFetched: update.pages.length, maxPages: MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES },
      products: selectPreferredProducts([...result.products, ...update.pages.flatMap((page) => page.products)]),
      gaps: [...result.gaps, ...update.gaps],
    };
  });
}

export async function crawlPrimaryDomain(domain: string) {
  const first = await crawlDomain(domain, "primary");
  if (first.homepage) return { ...first, coverage: { ...first.coverage, attempts: 1 } };
  if (first.siteState?.status === "parked") return { ...first, coverage: { ...first.coverage, attempts: 1 } };

  const retry = await crawlDomain(domain, "primary");
  const unavailable = unavailableAfterBoundedAttempts(first.homepageFailure, retry.homepageFailure);
  return {
    ...retry,
    gaps: retry.homepage ? retry.gaps : [...first.gaps, ...retry.gaps],
    coverage: { ...retry.coverage, attempts: 2 },
    ...(unavailable ? { siteState: unavailable } : {}),
  };
}

export async function sallaRecoveryDomainCrawl(previous: DomainCrawl, maxProducts: number): Promise<DomainCrawl | null> {
  let recovery: SallaStorefrontRecovery | null = null;
  try { recovery = await recoverSallaStorefrontCatalog(previous.domain, { maxProducts }); } catch { return null; }
  if (!recovery) return null;
  const language = recovery.languages.includes("ar") ? "ar" : recovery.languages[0] || "unknown";
  const pricePatterns = recovery.products.flatMap((product) => product.priceSignals.map((price) => price.raw)).slice(0, 12);
  const inferredRegion = inferRegionEvidence({
    domain: previous.domain,
    language,
    text: `${recovery.title} ${recovery.description}`,
    priceSignals: pricePatterns,
    sourceUrl: recovery.sourceUrl,
  });
  const regionInference = combineRegionSignals([
    ...inferredRegion.signals,
    { countryCode: recovery.countryCode, kind: "explicit-market", value: `official-salla-scope-${recovery.countryCode}`, weight: 80, sourceUrl: recovery.sourceUrl, claimType: "Observed" },
  ]);
  const claims: Claim[] = [
    makeClaim(previous.domain, "salla-store-title", `${previous.domain} identifies its store as “${recovery.title}” through its official public Salla storefront interface.`, recovery.sourceUrl, recovery.observedAt),
    ...(recovery.description ? [makeClaim(previous.domain, "salla-store-description", `${previous.domain} describes its store as “${recovery.description}”.`, recovery.sourceUrl, recovery.observedAt)] : []),
    ...recovery.products.map((product) => ({
      id: product.claimIds[0],
      claimType: "Observed" as const,
      text: `${previous.domain} exposes product “${product.name}” through its official public Salla storefront interface.`,
      sourceUrl: product.sourceUrl,
      observedAt: product.observedAt,
      confidence: "High" as const,
    })),
  ];
  const productPaths = recovery.products.flatMap((product) => { try { return [new URL(product.sourceUrl).pathname]; } catch { return []; } });
  const page: CrawlPage = {
    ok: true,
    live: true,
    domain: previous.domain,
    url: recovery.storeUrl,
    path: new URL(recovery.storeUrl).pathname,
    sourceUrl: recovery.sourceUrl,
    fetchedAt: recovery.observedAt,
    title: recovery.title,
    description: recovery.description || `Official public Salla storefront for ${recovery.name}.`,
    language,
    region: displayRegion(regionInference),
    regionCountryCode: regionInference.countryCode,
    regionConfidence: regionInference.confidence,
    regionSignals: regionInference.signals,
    headings: [recovery.name],
    prices: pricePatterns,
    socialLinks: recovery.socialLinks,
    internalLinks: unique(productPaths, 20),
    wordCount: `${recovery.title} ${recovery.description}`.trim().split(/\s+/).filter(Boolean).length,
    truncated: recovery.products.length >= maxProducts,
    contentHash: await hash(JSON.stringify({ title: recovery.title, description: recovery.description, products: recovery.products.map((product) => [product.id, product.name, product.sourceUrl, product.priceSignals, product.imageUrl]) })),
    claims,
    products: recovery.products,
    productGaps: [],
    thirdPartyProductCount: 0,
    responseTimeMs: 0,
    responseBytes: 0,
    imageCount: recovery.products.filter((product) => product.imageUrl).length,
    imagesWithAlt: 0,
    responsiveImageCount: 0,
    hasViewport: false,
    hasDocumentLanguage: recovery.languages.length > 0,
    productLinkCount: recovery.products.length,
    hasProductPath: false,
    hasAddToCart: false,
    hasCartLink: false,
    hasCheckoutLink: false,
    trustSignals: [],
  };
  return {
    domain: previous.domain,
    role: previous.role,
    homepage: page,
    pages: [page],
    products: recovery.products,
    candidates: [],
    gaps: [...previous.gaps, {
      url: recovery.sourceUrl,
      reason: `Homepage HTML was unavailable from this runtime; recovered ${recovery.products.length} observed products from the store's official public Salla MCP catalog.`,
      observedAt: recovery.observedAt,
    }],
    coverage: {
      pagesRequested: previous.coverage.pagesRequested + recovery.requests,
      pagesFetched: 1,
      maxPages: previous.coverage.maxPages,
      robotsChecked: previous.coverage.robotsChecked,
      attempts: previous.coverage.attempts,
    },
    productCoverage: { scannedPages: 1, catalogProductsDiscovered: recovery.products.length, thirdPartyReferenced: 0 },
    fetchedAt: recovery.observedAt,
    benchmarkEligible: false,
  };
}

export async function shopifyRecoveryDomainCrawl(
  previous: DomainCrawl,
  maxProducts: number,
  recoverCatalog: typeof recoverShopifyUcpCatalog = recoverShopifyUcpCatalog,
): Promise<DomainCrawl | null> {
  let recovery: ShopifyUcpCatalogRecovery | null = null;
  try { recovery = await recoverCatalog(previous.domain, { maxProducts }); } catch { return null; }
  if (!recovery) return null;
  const language = recovery.products.some((product) => /\p{Script=Arabic}/u.test(`${product.name} ${product.description}`)) ? "ar" : "en";
  const pricePatterns = recovery.products.flatMap((product) => product.priceSignals.map((price) => price.raw)).slice(0, 12);
  const regionInference = combineRegionSignals(inferRegionEvidence({
    domain: previous.domain,
    language,
    text: recovery.products.slice(0, 20).map((product) => `${product.name} ${product.description}`).join(" "),
    priceSignals: pricePatterns,
    sourceUrl: recovery.sourceUrl,
  }).signals);
  const claims: Claim[] = [
    makeClaim(previous.domain, "shopify-ucp-catalog", `${previous.domain} exposes an official public Shopify storefront catalog.`, recovery.sourceUrl, recovery.observedAt),
    ...recovery.products.map((product) => ({
      id: product.claimIds[0],
      claimType: "Observed" as const,
      text: `${previous.domain} exposes product “${product.name}” with a positive public price through its official Shopify storefront catalog.`,
      sourceUrl: product.sourceUrl,
      observedAt: product.observedAt,
      confidence: "High" as const,
    })),
  ];
  const productPaths = recovery.products.flatMap((product) => { try { return [new URL(product.sourceUrl).pathname]; } catch { return []; } });
  const page: CrawlPage = {
    ok: true,
    live: true,
    domain: previous.domain,
    url: recovery.storeUrl,
    path: new URL(recovery.storeUrl).pathname,
    sourceUrl: recovery.sourceUrl,
    fetchedAt: recovery.observedAt,
    title: recovery.title,
    description: recovery.description,
    language,
    region: displayRegion(regionInference),
    regionCountryCode: regionInference.countryCode,
    regionConfidence: regionInference.confidence,
    regionSignals: regionInference.signals,
    headings: [recovery.title],
    prices: pricePatterns,
    socialLinks: [],
    internalLinks: unique(productPaths, 20),
    wordCount: recovery.products.slice(0, 20).reduce((total, product) => total + `${product.name} ${product.description}`.trim().split(/\s+/).filter(Boolean).length, 0),
    truncated: recovery.truncated,
    contentHash: await hash(JSON.stringify({ products: recovery.products.map((product) => [product.id, product.name, product.sourceUrl, product.priceSignals, product.imageUrl]) })),
    claims,
    products: recovery.products,
    productGaps: [],
    thirdPartyProductCount: 0,
    responseTimeMs: 0,
    responseBytes: 0,
    imageCount: recovery.products.filter((product) => product.imageUrl).length,
    imagesWithAlt: 0,
    responsiveImageCount: 0,
    hasViewport: false,
    hasDocumentLanguage: false,
    productLinkCount: recovery.products.length,
    hasProductPath: true,
    hasAddToCart: false,
    hasCartLink: false,
    hasCheckoutLink: false,
    trustSignals: [],
  };
  return {
    domain: previous.domain,
    role: previous.role,
    homepage: page,
    pages: [page],
    products: recovery.products,
    candidates: [],
    gaps: [...previous.gaps, {
      url: recovery.sourceUrl,
      reason: `Homepage HTML was unavailable from this runtime; recovered ${recovery.products.length} positively priced products from the store's official public Shopify UCP catalog.`,
      observedAt: recovery.observedAt,
    }],
    coverage: {
      pagesRequested: previous.coverage.pagesRequested + recovery.requests,
      pagesFetched: 1,
      maxPages: previous.coverage.maxPages,
      robotsChecked: previous.coverage.robotsChecked,
      attempts: previous.coverage.attempts,
    },
    productCoverage: { scannedPages: 1, catalogProductsDiscovered: recovery.products.length, thirdPartyReferenced: 0, sitemapTruncated: recovery.truncated },
    fetchedAt: recovery.observedAt,
    benchmarkEligible: false,
  };
}

export async function enrichPrimaryProductPrices(result: DomainCrawl, localDependencies?: EnrichmentDependencies, maxPages = MAX_PRIMARY_PRODUCT_PRICE_PAGES) {
  const pageBudget = Math.max(0, Math.min(MAX_ENRICHMENT_TARGETS, Math.floor(maxPages)));
  const targets = selectPrimaryProductPriceTargets(result.products, result.domain, pageBudget);
  if (!targets.length) return { ...result, primaryPriceEnrichment: { pagesRequested: 0, pagesFetched: 0, maxPages: pageBudget } };
  const enrichment = await enrichProductTargets(targets, pageBudget, localDependencies);
  const observedAt = new Date().toISOString();
  return {
    ...result,
    products: applyPreMatchCatalogEnrichment(result.products, enrichment.products),
    gaps: [
      ...result.gaps,
      ...enrichment.coverage.gaps.map((gap) => ({ url: gap.url, reason: `Primary product price enrichment: ${gap.reason}`, observedAt })),
    ],
    primaryPriceEnrichment: {
      pagesRequested: enrichment.coverage.pagesRequested,
      pagesFetched: enrichment.coverage.pagesFetched,
      maxPages: pageBudget,
    },
  };
}

export function investigationGapSourceUrl(candidate: DomainCrawl) {
  return candidate.homepage?.sourceUrl || (candidate.discovery?.observedAdmission ? candidate.discovery.sourceUrl : "");
}

export function buildDocument(results: DomainCrawl[], primaryDomain: string, discovery?: DiscoveryResult, investigated: Array<DomainCrawl | null> = [], productComparison?: ProductComparison): { version: "1"; generatedAt: string; blocks: ReportBlock[] } {
  const discovered = results.filter((result) => result.role === "discovered-competitor" && result.homepage && result.discovery);
  const productMatched = discovered.filter((result) => result.discovery?.hasProductOverlap).length;
  const productLed = discovery?.businessType === "ecommerce";
  const blocks: ReportBlock[] = [{ type: "summary", id: "scan-summary", title: discovered.length ? `We verified ${discovered.length} market competitor${discovered.length === 1 ? "" : "s"}` : "No company passed independent verification", body: discovered.length ? (productLed ? `${productMatched} had a comparable public product match. Every included ecommerce competitor was found or confirmed through product evidence, then independently crawled for category and regional fit.` : `${productMatched} had a comparable public product match. Every included company was crawled and had to describe itself in the same core category; product overlap increased confidence but was not required.`) : discovery?.gap || "No searched company exposed enough first-party category evidence to include without guessing." }];
  if (discovery) blocks.push({ type: "market-profile", id: "market-profile", category: discovery.category, region: discovery.region, businessType: discovery.businessType, strategy: discovery.strategy, queries: discovery.queries, provider: discovery.provider, model: discovery.model, available: discovery.available, gaps: discovery.gaps, gap: discovery.gap || "" });
  const benchmarkInputs = results.filter((result) => result.homepage && result.benchmarkEligible !== false && (result.role === "primary" || result.role === "discovered-competitor"));
  if (benchmarkInputs.length) blocks.push({ type: "experience-benchmark", id: "experience-benchmark", ...buildExperienceBenchmark(benchmarkInputs.map((result) => ({ domain: result.domain, role: result.role, fetchedAt: result.fetchedAt, pages: result.pages, products: result.products, catalogProductsDiscovered: result.productCoverage.catalogProductsDiscovered }))) });
  for (const result of discovered) blocks.push({ type: "competitor", id: `competitor-${result.domain}`, domain: result.domain, companyName: result.discovery?.companyName, title: result.homepage?.title, description: result.homepage?.description, reason: result.discovery?.reason, marketCategory: result.discovery?.marketCategory, relationship: result.discovery?.relationship, sharedOfferings: result.discovery?.sharedOfferings, categoryAlignment: result.discovery?.categoryAlignment, regionCompatibility: result.discovery?.regionCompatibility, hasProductOverlap: result.discovery?.hasProductOverlap, matchedPrimaryProductName: result.discovery?.provenPrimaryProduct?.name, matchedProductName: result.discovery?.provenRivalProduct?.name, matchedProductUrl: result.discovery?.provenRivalProduct?.sourceUrl || result.discovery?.websiteUrl, searchQuery: result.discovery?.searchQuery, discoverySourceUrl: result.discovery?.sourceUrl, websiteSourceUrl: result.homepage?.sourceUrl, verificationScore: result.discovery?.verificationScore, confidence: result.discovery?.confidence, overlapTerms: result.discovery?.overlapTerms, productCount: result.products.length, prices: result.products.flatMap((product) => product.priceSignals.map((price) => price.raw)).slice(0, 6), provenance: result.discovery?.provenance || "discovered-this-run", rememberedVerifiedAt: result.discovery?.rememberedVerifiedAt || "" });
  for (const result of results) {
    blocks.push({
      type: "coverage",
      id: `coverage-${result.domain}`,
      domain: result.domain,
      role: result.role,
      pagesRequested: result.coverage.pagesRequested,
      pagesFetched: result.coverage.pagesFetched,
      maxPages: result.coverage.maxPages,
      robotsChecked: result.coverage.robotsChecked,
      attempts: result.coverage.attempts || 1,
      primaryPriceEnrichmentPagesRequested: result.primaryPriceEnrichment?.pagesRequested || 0,
      primaryPriceEnrichmentPagesFetched: result.primaryPriceEnrichment?.pagesFetched || 0,
      primaryPriceEnrichmentMaxPagesPerReport: result.primaryPriceEnrichment?.maxPages ?? MAX_PRIMARY_PRODUCT_PRICE_PAGES,
      catalogReconciliationPagesRequested: result.catalogReconciliation?.pagesRequested || 0,
      catalogReconciliationPagesFetched: result.catalogReconciliation?.pagesFetched || 0,
      catalogReconciliationEligibleProducts: result.catalogReconciliation?.eligibleProducts || 0,
      catalogReconciliationTruncated: result.catalogReconciliation?.truncated || false,
      catalogReconciliationMaxPagesPerReport: MAX_CATALOG_RECONCILIATION_PAGES,
      priceEnrichmentPagesRequested: result.priceEnrichment?.pagesRequested || 0,
      priceEnrichmentPagesFetched: result.priceEnrichment?.pagesFetched || 0,
      priceEnrichmentMaxPagesPerReport: MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES,
      gaps: result.gaps,
    });
    if (result.homepage) {
      blocks.push({ type: "company", id: `company-${result.domain}`, domain: result.domain, role: result.role, title: result.homepage.title, description: result.homepage.description, pages: result.pages.map((page) => ({ url: page.sourceUrl, path: page.path, title: page.title, claimIds: page.claims.map((claim) => claim.id) })) });
      blocks.push({ type: "product-catalog", id: `product-catalog-${result.domain}`, domain: result.domain, role: result.role, products: result.products, scannedPages: result.productCoverage.scannedPages, primaryPriceEnrichmentPagesFetched: result.primaryPriceEnrichment?.pagesFetched || 0, catalogReconciliationPagesFetched: result.catalogReconciliation?.pagesFetched || 0, priceEnrichmentPagesFetched: result.priceEnrichment?.pagesFetched || 0, catalogProductsDiscovered: result.productCoverage.catalogProductsDiscovered, thirdPartyReferenced: result.productCoverage.thirdPartyReferenced, coverageNote: `Discovered ${result.productCoverage.catalogProductsDiscovered} product URLs from public sitemaps, fetched ${result.productCoverage.scannedPages} representative public page${result.productCoverage.scannedPages === 1 ? "" : "s"}, fetched ${result.primaryPriceEnrichment?.pagesFetched || 0} primary catalog page${result.primaryPriceEnrichment?.pagesFetched === 1 ? "" : "s"} before discovery, reconciled ${result.catalogReconciliation?.pagesFetched || 0} preliminary-match catalog page${result.catalogReconciliation?.pagesFetched === 1 ? "" : "s"}, and fetched ${result.priceEnrichment?.pagesFetched || 0} final matched product page${result.priceEnrichment?.pagesFetched === 1 ? "" : "s"}.` });
      for (const candidate of result.candidates) blocks.push({ type: "candidate", id: `candidate-${result.domain}-${candidate.domain}`, domain: candidate.domain, reason: candidate.reason, sourceUrl: candidate.sourceUrl, claimIds: candidate.claimIds });
      for (const claim of [...result.pages, ...(result.enrichmentPages || [])].flatMap((page) => page.claims)) blocks.push({ type: "evidence", id: `evidence-${claim.id}`, claimId: claim.id, claimType: claim.claimType, text: claim.text, sourceUrl: claim.sourceUrl, observedAt: claim.observedAt, confidence: claim.confidence });
    }
    for (const gap of result.gaps) blocks.push({ type: "gap", id: `gap-${result.domain}-${blocks.length}`, domain: result.domain, url: gap.url, reason: gap.reason, observedAt: gap.observedAt });
  }
  const primary = results.find((result) => result.domain === primaryDomain);
  if (primary?.products.length) {
    const comparison = productComparison || buildProductComparison(primaryDomain, results.map((result) => ({ domain: result.domain, products: result.products })), comparisonSourceUrls(results, primaryDomain));
    if (comparison.comparisonDomains.length) blocks.push({ type: "product-comparison", id: "product-comparison", ...comparison });
    for (const unmatched of comparison.unmatched) if (unmatched.products.length) blocks.push({ type: "product-unmatched", id: `product-unmatched-${unmatched.domain}`, domain: unmatched.domain, products: unmatched.products, reason: "Observed competitor products that were not assigned to a primary-product row." });
    for (const gap of comparison.matching?.gaps || []) blocks.push({ type: "gap", id: `product-matching-gap-${blocks.length}`, domain: primary.domain, url: primary.homepage?.sourceUrl || "", reason: gap, observedAt: new Date().toISOString() });
  } else if (primary?.homepage) {
    blocks.push({ type: "gap", id: "product-coverage-gap", domain: primary.domain, url: primary.homepage.sourceUrl, reason: `No attributable public product or service record was observed across ${primary.productCoverage.scannedPages} scanned page${primary.productCoverage.scannedPages === 1 ? "" : "s"}. No product comparison was generated.`, observedAt: new Date().toISOString() });
  }
  if (discovered.length === 0) blocks.push({ type: "gap", id: "candidate-gap", domain: primary?.domain || primaryDomain, url: primary?.homepage?.sourceUrl || "", reason: discovery?.gap || "No searched candidate passed independent public-site verification.", observedAt: new Date().toISOString() });
  for (const candidate of investigated) {
    if (!candidate || results.some((result) => result.domain === candidate.domain)) continue;
    const rememberedPrefix = candidate.discovery?.provenance === "remembered-reverified" ? "Remembered lead was re-crawled, not reconfirmed, and removed from memory: " : "Investigated but not confirmed: ";
    blocks.push({ type: "gap", id: `investigation-gap-${candidate.domain}`, domain: candidate.domain, url: investigationGapSourceUrl(candidate), reason: candidate.homepage ? (!candidate.discovery?.regionCompatibility ? `${rememberedPrefix}${candidate.discovery?.regionDecisionReason || "first-party evidence placed this company in a different market region."}` : !candidate.discovery?.categoryAlignment ? `${rememberedPrefix}the company's own website did not establish the same core market category.` : discovery?.businessType === "ecommerce" && !candidate.discovery?.hasProductOverlap ? `${rememberedPrefix}the current first-party crawl did not prove a comparable product, so this seller was not included as an ecommerce competitor.` : `${rememberedPrefix}entity verification score ${candidate.discovery?.verificationScore || 0}/100 did not meet the inclusion threshold.`) : `${rememberedPrefix}${candidate.gaps[0]?.reason || "the public site could not be verified."}`, observedAt: candidate.fetchedAt });
  }
  return { version: "1", generatedAt: new Date().toISOString(), blocks };
}

export function shouldSkipLegacyCompetitorDiscovery(directProductSearch: boolean, comparisonTargetMode: boolean) {
  return directProductSearch && comparisonTargetMode;
}

export async function POST(request: Request) {
  const roleResponse = workerOnlyResponse();
  if (roleResponse) return roleResponse;
  if (!await hasValidAnalysisAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
  try {
    const payload = await request.json() as { primary?: unknown; domains?: unknown; productLimit?: unknown; comparisonPairsNeeded?: unknown; catalogProductLimit?: unknown; discoverySearchOffset?: unknown; discoveryPriorCoverageComplete?: unknown; discoveryExpectedAnchorSetHash?: unknown; discoverySearchLedger?: unknown; directProductSearch?: unknown; benchmarkOnly?: unknown };
    const productLimit = Number.isInteger(Number(payload.productLimit)) ? Math.max(1, Math.min(MAX_PRIMARY_CATALOG_PRODUCTS, Number(payload.productLimit))) : 20;
    const comparisonPairsNeeded = Number.isInteger(Number(payload.comparisonPairsNeeded)) ? Math.max(0, Math.min(productLimit, Number(payload.comparisonPairsNeeded))) : productLimit;
    const catalogProductLimit = Number.isInteger(Number(payload.catalogProductLimit)) ? Math.max(1, Math.min(MAX_PRIMARY_CATALOG_PRODUCTS, Number(payload.catalogProductLimit))) : MAX_PRIMARY_CATALOG_PRODUCTS;
    const discoverySearchOffset = Number.isInteger(Number(payload.discoverySearchOffset)) ? Math.max(0, Math.min(MAX_PRIMARY_CATALOG_PRODUCTS, Number(payload.discoverySearchOffset))) : 0;
    if (payload.directProductSearch !== undefined && payload.directProductSearch !== true) return Response.json({ ok: false, live: false, error: "directProductSearch must be true when provided." }, { status: 400 });
    const directProductSearch = payload.directProductSearch === true;
    if (payload.benchmarkOnly !== undefined && payload.benchmarkOnly !== true) return Response.json({ ok: false, live: false, error: "benchmarkOnly must be true when provided." }, { status: 400 });
    const benchmarkOnly = payload.benchmarkOnly === true;
    if (benchmarkOnly && directProductSearch) return Response.json({ ok: false, live: false, error: "benchmarkOnly and directProductSearch cannot be combined." }, { status: 400 });
    const discoveryPriorCoverageComplete = payload.discoveryPriorCoverageComplete !== false;
    const discoveryExpectedAnchorSetHash = typeof payload.discoveryExpectedAnchorSetHash === "string" && /^[a-f0-9]{64}$/.test(payload.discoveryExpectedAnchorSetHash) ? payload.discoveryExpectedAnchorSetHash : "";
    const rawDomains = Array.isArray(payload.domains) ? payload.domains.filter((domain): domain is string => typeof domain === "string" && Boolean(domain.trim())).map((domain) => canonicalDomain(domain)) : [];
    const domains = [...new Set(rawDomains)].slice(0, MAX_DOMAINS);
    if (!domains.length) return Response.json({ ok: false, live: false, error: "Enter at least one public domain to crawl." }, { status: 400 });
    if (benchmarkOnly && domains.length !== 1) return Response.json({ ok: false, live: false, error: "A benchmark-only crawl accepts exactly one public domain." }, { status: 400 });
    const primaryDomain = canonicalDomain(typeof payload.primary === "string" ? payload.primary : domains[0]);
    let submittedResults = await Promise.all(domains.map((domain) => domain === primaryDomain ? crawlPrimaryDomain(domain) : crawlDomain(domain, "submitted-comparison")));
    let primary = submittedResults.find((result) => result.domain === primaryDomain);
    if (isSallaCatalogRecoveryEligible(primary)) {
      const recovered = primary ? await sallaRecoveryDomainCrawl(primary, MAX_PRIMARY_CATALOG_PRODUCTS) : null;
      if (recovered) {
        submittedResults = submittedResults.map((result) => result.domain === primaryDomain ? recovered : result);
        primary = recovered;
      }
    }
    if (isShopifyUcpCatalogRecoveryEligible(primary)) {
      const recovered = primary ? await shopifyRecoveryDomainCrawl(primary, MAX_PRIMARY_CATALOG_PRODUCTS) : null;
      if (recovered) {
        submittedResults = submittedResults.map((result) => result.domain === primaryDomain ? recovered : result);
        primary = recovered;
      }
    }
    if (primary?.siteState?.status === "parked") {
      const alternatives = benchmarkOnly ? [] : await discoverDomainAlternatives(primaryDomain, 3);
      const observedAt = primary.fetchedAt;
      const document = buildDocument(submittedResults, primaryDomain);
      document.blocks.unshift({
        type: "domain-status",
        id: "primary-domain-status",
        domain: primaryDomain,
        status: "parked",
        provider: primary.siteState.provider,
        evidenceUrl: primary.siteState.evidenceUrl,
        redirectDomain: primary.siteState.redirectDomain,
        observedAt,
        explanation: `${primaryDomain} redirects to a public domain-for-sale service, so competitor and product analysis did not run.`,
        alternatives: alternatives.map((item) => ({ ...item, verifiedIdentity: false })),
      });
      return Response.json({ ok: false, live: false, code: "parked-domain", primaryDomain, error: `${primaryDomain} appears to be parked or offered for sale through ${primary.siteState.provider}. Select another domain only if it belongs to your company.`, alternatives, results: submittedResults, document }, { status: 409 });
    }
    if (primary?.siteState?.status === "unavailable") {
      const unavailableState = primary.siteState;
      const unavailableMessaging = unavailablePrimaryMessaging(primaryDomain, unavailableState);
      const document = buildDocument(submittedResults, primaryDomain);
      document.blocks = [
        {
          type: "domain-status",
          id: "primary-domain-status",
          domain: primaryDomain,
          status: "unavailable",
          attemptedUrl: unavailableState.attemptedUrl,
          attempts: primary.coverage.attempts || 2,
          observedAt: unavailableState.observedAt,
          explanation: unavailableMessaging.explanation,
        },
        {
          type: "gap",
          id: "primary-domain-unavailable-gap",
          domain: primaryDomain,
          url: unavailableState.attemptedUrl,
          reason: unavailableState.reason,
          observedAt: unavailableState.observedAt,
        },
        ...document.blocks
          .filter((block) => block.id !== "candidate-gap" && !(block.type === "gap" && block.domain === primaryDomain && block.url === unavailableState.attemptedUrl))
          .map((block) => block.type === "summary" ? { ...block, title: "The submitted website was unavailable", body: unavailableMessaging.summaryBody } : block),
      ];
      return Response.json({ ok: false, live: false, code: "unavailable-domain", primaryDomain, error: unavailableMessaging.error, results: submittedResults, document }, { status: 409 });
    }
    if (!primary?.homepage) {
      const reason = primary?.gaps[0]?.reason;
      const error = reason ? `The primary domain could not be crawled: ${reason}` : "The primary domain could not be crawled.";
      return Response.json({
        ok: false,
        live: false,
        code: "primary-page-unavailable",
        errorCode: "primary-page-unavailable",
        error,
        primaryDomain,
      }, { status: 422 });
    }
    primary = await enrichPrimaryProductPrices(primary, undefined, primaryProductPricePageBudget(directProductSearch && !benchmarkOnly));
    primary = { ...primary, products: boundedPrimaryCatalogProducts(primary.products, catalogProductLimit) };
    submittedResults = submittedResults.map((result) => result.domain === primaryDomain ? primary! : result);
    if (benchmarkOnly) {
      const discovery: DiscoveryResult = {
        available: true,
        provider: "unavailable",
        model: "",
        category: "",
        region: primary.homepage.region,
        businessType: "ecommerce",
        strategy: "not-run",
        queries: [],
        candidates: [],
        gaps: [],
        productSearchCoverage: {
          eligibleAnchors: primary.products.length,
          anchorSetHash: discoveryExpectedAnchorSetHash,
          searchedAnchors: 0,
          startIndex: 0,
          endIndex: 0,
          truncated: false,
          searchesComplete: true,
          candidateDomainsFound: 0,
          candidateDomainsInvestigated: 0,
          candidateTruncated: false,
          verificationComplete: true,
          batchComplete: true,
          complete: true,
          searchAttemptsComplete: true,
          paidSearchesStarted: 0,
          reusedSearches: 0,
        },
      };
      const document = compactCatalogSnapshots(buildDocument([primary], primaryDomain, discovery, []));
      return Response.json({
        ok: true,
        live: true,
        primaryDomain,
        results: [primary],
        discovery,
        matchHints: [],
        document,
        crawl: crawlResponseMetadata(false, { maxPagesPerDiscoveredCompetitor: 0, maxMatchedProductEnrichmentPages: 0, competitorCrawlConcurrency: 0 }),
      });
    }
    const publicationMarketCountryCode = /^[A-Z]{2}$/.test(String(primary.homepage.regionCountryCode || "").toUpperCase())
      ? String(primary.homepage.regionCountryCode).toUpperCase()
      : "";
    const discoveryPolicy = resolvePrimaryDiscoveryPolicy(primary);
    const comparisonTargetMode = discoveryPolicy.requireProductOverlap;
    if (shouldSkipLegacyCompetitorDiscovery(directProductSearch, comparisonTargetMode)) {
      const discovery: DiscoveryResult = {
        available: true,
        provider: "unavailable",
        model: "",
        category: "",
        region: primary.homepage.region,
        businessType: discoveryPolicy.businessType,
        strategy: "not-run",
        queries: [],
        candidates: [],
        gaps: [],
        productSearchCoverage: {
          eligibleAnchors: primary.products.length,
          anchorSetHash: discoveryExpectedAnchorSetHash,
          searchedAnchors: 0,
          startIndex: 0,
          endIndex: 0,
          truncated: false,
          searchesComplete: true,
          candidateDomainsFound: 0,
          candidateDomainsInvestigated: 0,
          candidateTruncated: false,
          verificationComplete: true,
          batchComplete: true,
          complete: true,
          searchAttemptsComplete: true,
          paidSearchesStarted: 0,
          reusedSearches: 0,
        },
      };
      const document = compactCatalogSnapshots(buildDocument([primary], primaryDomain, discovery, []));
      return Response.json({
        ok: true,
        live: true,
        primaryDomain,
        results: [primary],
        discovery,
        matchHints: [],
        document,
        crawl: crawlResponseMetadata(directProductSearch, { maxPagesPerDiscoveredCompetitor: 0, maxMatchedProductEnrichmentPages: 0, competitorCrawlConcurrency: 0 }),
      });
    }
    let discovery: DiscoveryResult;
    try {
      discovery = await discoverCompetitors(discoveryPolicy.input, {
        searchOffset: discoverySearchOffset,
        priorCoverageComplete: discoveryPriorCoverageComplete,
        expectedAnchorSetHash: discoveryExpectedAnchorSetHash,
        priorProductSearchLedger: payload.discoverySearchLedger,
        ...(comparisonTargetMode ? { productComparisonsOnly: true, maxProductSearches: Math.min(COMPARISON_SEARCH_BATCH_SIZE, Math.max(1, comparisonPairsNeeded)) } : {}),
      });
    } catch {
      const gap = "Web competitor discovery stopped because its internal provider result could not be processed.";
      discovery = { available: false, provider: "unavailable", model: process.env.MARKET_SIGNAL_DISCOVERY_MODEL || "gpt-5.4-mini", category: "", region: primary.homepage.region, businessType: discoveryPolicy.businessType, strategy: discoveryPolicy.intendedStrategy, queries: [], candidates: [], gaps: [gap], gap, productSearchCoverage: { eligibleAnchors: primary.products.length, anchorSetHash: discoveryExpectedAnchorSetHash, searchedAnchors: 0, startIndex: discoverySearchOffset, endIndex: discoverySearchOffset, truncated: primary.products.length > discoverySearchOffset, searchesComplete: false, candidateDomainsFound: 0, candidateDomainsInvestigated: 0, candidateTruncated: false, verificationComplete: false, batchComplete: false, complete: false, searchAttemptsComplete: false, paidSearchesStarted: 0, reusedSearches: 0, providerFailureCategory: "internal", providerFailureCount: 1, providerCircuitOpen: true } };
    }
    const memory = comparisonTargetMode ? null : await loadRememberedCompetitors(primary.domain);
    const freshCandidates = discovery.candidates.filter((candidate) => !domains.includes(candidate.domain));
    const mergedInvestigationCoverage = comparisonTargetMode
      ? { candidates: freshCandidates.map((candidate): MemoryCandidate => ({ ...candidate, provenance: "discovered-this-run" })), truncated: false, freshTruncated: false, rememberedTruncated: false }
      : mergeRememberedCandidateCoverage(
        freshCandidates,
        memory!.candidates.filter((candidate) => !domains.includes(candidate.domain)),
        MAX_COMPETITOR_INVESTIGATIONS,
      );
    const allInvestigationCandidates = mergedInvestigationCoverage.candidates;
    const investigationCandidates = allInvestigationCandidates.slice(0, MAX_COMPETITOR_INVESTIGATIONS);
    const mergedCoverageGaps = [
      ...(mergedInvestigationCoverage.freshTruncated ? ["Fresh competitor product evidence exceeded the declared 6,000-lead universe; this discovery batch remains retryable."] : []),
      ...(mergedInvestigationCoverage.rememberedTruncated ? ["Historical competitor product evidence exceeded the 6,000-lead carry-forward window; current discovery may advance, but a result shortfall cannot claim full exhaustion."] : []),
      ...(primary.productCoverage.sitemapTruncated ? ["The primary sitemap index contained additional child sitemaps beyond the bounded crawl before 1,000 products were collected; a result shortfall cannot claim full catalog exhaustion."] : []),
    ];
    discovery = {
      ...discovery,
      candidates: investigationCandidates,
      gaps: [...discovery.gaps, ...(memory?.gap ? [memory.gap] : []), ...mergedCoverageGaps],
    };
    const verificationMarket = resolveVerificationMarket(discovery.region, primary.homepage.region, firstPartyRegionSource(primary.homepage));
    const scheduleCompetitorRequest = createRequestLimiter(COMPETITOR_PAGE_CONCURRENCY);
    const scheduleCompetitorJudge = createRequestLimiter(COMPETITOR_CRAWL_CONCURRENCY);
    const scheduledJudge = ((primaryDomain: string, catalogs: Array<{ domain: string; products: ProductRecord[] }>, requiredSourceUrlsOrOptions: Record<string, string[]> | AIProductMatchingOptions = {}, providedOptions?: AIProductMatchingOptions) => scheduleCompetitorJudge(() => providedOptions
      ? buildAIProductComparison(primaryDomain, catalogs, requiredSourceUrlsOrOptions as Record<string, string[]>, providedOptions)
      : buildAIProductComparison(primaryDomain, catalogs, requiredSourceUrlsOrOptions as AIProductMatchingOptions))) as ExactPairJudge;
    const investigate = async (candidate: MemoryCandidate) => {
      const seedUrls = [...new Set([
        ...(candidate.matchedProductUrls || (candidate.matchedProductUrl ? [candidate.matchedProductUrl] : [])),
        ...(candidate.inferredProductLeads || []).map((lead) => lead.candidateSourceUrl),
      ])];
      return verifyDiscoveredCompetitorWithInferredLeads(primary, await crawlDomain(candidate.domain, "discovered-competitor", seedUrls.length ? seedUrls : [candidate.websiteUrl], { schedule: scheduleCompetitorRequest }), candidate, verificationMarket, discoveryPolicy.requireProductOverlap, scheduledJudge);
    };
    const investigatedSettled: PromiseSettledResult<DomainCrawl>[] = [];
    if (comparisonTargetMode) {
      for (let start = 0; start < investigationCandidates.length; start += COMPARISON_VERIFICATION_BATCH_SIZE) {
        const batch = investigationCandidates.slice(start, start + COMPARISON_VERIFICATION_BATCH_SIZE);
        investigatedSettled.push(...await settleWithConcurrency(batch, COMPARISON_VERIFICATION_BATCH_SIZE, investigate));
        const verified = investigatedSettled.flatMap((result) => result.status === "fulfilled" && result.value.homepage && result.value.discovery?.accepted ? [result.value] : []);
        if (selectComparisonTarget(primary.products, verified, comparisonPairsNeeded, publicationMarketCountryCode, Date.now()).hints.length >= comparisonPairsNeeded) break;
      }
    } else {
      investigatedSettled.push(...await settleWithConcurrency(investigationCandidates, COMPETITOR_CRAWL_CONCURRENCY, investigate));
    }
    const discoveredResults = investigatedSettled.map((result) => result.status === "fulfilled" ? result.value : null);
    const continuityIncomplete = Boolean(memory?.truncated)
      || mergedInvestigationCoverage.rememberedTruncated
      || primary.productCoverage.sitemapTruncated === true;
    const finalizedCoverage = finalizedDiscoveryCoverage(
      discovery.productSearchCoverage,
      allInvestigationCandidates.length + Number(mergedInvestigationCoverage.freshTruncated),
      investigatedSettled.length,
      investigatedSettled.map((result) => result.status),
      discoveredResults,
      discoveryPriorCoverageComplete,
    );
    discovery = {
      ...discovery,
      productSearchCoverage: { ...finalizedCoverage, complete: finalizedCoverage.complete && !continuityIncomplete },
    };
    const confirmed: DomainCrawl[] = discoveredResults.filter((result): result is NonNullable<typeof result> => Boolean(result?.homepage && result.discovery?.accepted)).sort((left, right) => compareVerifiedCompetitors(left.discovery!, right.discovery!));
    if (!comparisonTargetMode) {
      const rememberedFailures = rememberedReverificationFailures(investigationCandidates, discoveredResults);
      const forgotten = await forgetRememberedCompetitors(primary.domain, rememberedFailures.map((candidate) => candidate.domain));
      const remembered = await rememberVerifiedCompetitors(primary.domain, confirmed.map((result) => ({ candidate: result.discovery as MemoryCandidate, verificationScore: result.discovery!.verificationScore })));
      if ((!forgotten.available && rememberedFailures.length) || (!remembered.available && confirmed.length)) {
        discovery = { ...discovery, gaps: [...discovery.gaps, "Verified competitor memory could not be updated; this batch remains retryable so verified rivals are not lost."], productSearchCoverage: { ...discovery.productSearchCoverage, batchComplete: false, complete: false } };
      }
    }
    const preEnrichmentSelection = comparisonTargetMode
      ? selectComparisonTarget(primary.products, confirmed, comparisonPairsNeeded, publicationMarketCountryCode, Date.now())
      : { hints: verifiedExactMatchHints(confirmed), competitors: confirmed };
    const results = await enrichMatchedProductPages([...submittedResults, ...preEnrichmentSelection.competitors], primaryDomain);
    const enrichedPrimary = results.find((result) => result.domain === primaryDomain) || primary;
    const enrichedCandidates = results.filter((result) => result.role === "discovered-competitor");
    const finalSelection = comparisonTargetMode
      ? selectComparisonTarget(enrichedPrimary.products, enrichedCandidates, comparisonPairsNeeded, publicationMarketCountryCode, Date.now())
      : { hints: verifiedExactMatchHints(enrichedCandidates), competitors: enrichedCandidates };
    const enrichedConfirmed = finalSelection.competitors;
    if (comparisonTargetMode) discovery = {
      ...discovery,
      candidates: enrichedConfirmed.map((result) => result.discovery!).filter(Boolean),
      productSearchCoverage: finalizedComparisonTargetCoverage(
        discovery.productSearchCoverage,
        investigationCandidates.length,
        investigatedSettled.map((result) => result.status),
        discoveredResults,
        finalSelection.hints.length,
        comparisonPairsNeeded,
      ),
    };
    const publishedResultsForPairs = comparisonTargetMode
      ? [enrichedPrimary, ...enrichedConfirmed]
      : results;
    const document = compactCatalogSnapshots(buildDocument(publishedResultsForPairs, primaryDomain, discovery, comparisonTargetMode ? [] : discoveredResults));
    const matchHints = finalSelection.hints;
    const publishedDiscovery = publicDiscoverySnapshot(discovery, enrichedConfirmed.map((result) => result.discovery!));
    const publishedResults = publishedResultsForPairs.map((result) => result.discovery
      ? { ...result, verifiedExactProductPairs: undefined, discovery: publicDiscoveryCandidate(result.discovery) }
      : { ...result, verifiedExactProductPairs: undefined });
    return Response.json({ ok: true, live: true, primaryDomain, results: publishedResults, discovery: publishedDiscovery, ...(discovery.productSearchLedger ? { discoverySearchLedger: discovery.productSearchLedger } : {}), matchHints, document, crawl: crawlResponseMetadata(directProductSearch) });
  } catch {
    return Response.json({ ok: false, live: false, error: "Unable to crawl the submitted domains." }, { status: 400 });
  }
}
