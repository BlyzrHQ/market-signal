import { z } from "zod";
import { normalizeDomain, canonicalDomain } from "../../app/lib/domain.ts";
import { buildDirectProductSearchComparison, type DirectProductSearchOptions } from "../../app/lib/direct-product-search.ts";
import { enrichProductTargets } from "../../app/lib/storefront-product-enrichment.ts";
import { hasValidObservedRivalPrice, type ProductRecord } from "../../app/lib/product-intelligence.ts";
import { evaluateReportDraftQuality } from "../shared/report-quality-gate.ts";
import { applyProductActionPlans, collectProductActionInputs, deterministicProductActionResult } from "../../app/lib/ai-action-planner.ts";

export const requestSchema = z.object({
  contractVersion: z.literal("1"),
  domain: z.string().min(1).max(253).transform((input, ctx) => {
    try {
      const url = normalizeDomain(input);
      if (url.username || url.password || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)) throw new Error();
      return canonicalDomain(url.hostname);
    } catch { ctx.addIssue({ code: "custom", message: "A public domain is required" }); return z.NEVER; }
  }),
  comparisons: z.number().int().min(1).max(1000),
  rivals: z.number().int().min(1).max(50),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/),
}).strict();
export type DirectRequest = z.infer<typeof requestSchema>;
export type Catalog = { domain: string; products: ProductRecord[]; regionCountryCode: string; gaps: string[]; sourceUrl: string; observedAt: string; accessible: boolean };
export type DirectDependencies = {
  crawl: (domain: string) => Promise<Catalog>;
  search?: DirectProductSearchOptions["search"];
  enrich?: DirectProductSearchOptions["enrich"];
  searchConfigured: () => boolean;
};

export function capabilities(searchConfigured: boolean) {
  return { contractVersion: "1", service: "market-signal-direct", status: "ready", websiteRequired: false,
    tasks: ["market-signal-direct-report", "market-signal-direct-crawl", "market-signal-direct-compare", "market-signal-direct-capabilities"],
    providerConfigured: searchConfigured,
    comparisonMeaning: "priced primary/rival pairs, not catalog size", rivalMeaning: "maximum distinct sellers among delivered comparisons",
    dailyQuota: null, retries: 1, limits: { comparisons: 1000, rivals: 50, newSearchesPerRun: 100, searchWorkMinutes: 8 },
    limitations: ["The Trigger key authorizes this environment; provider credentials are configured by the operator on Trigger.", "Independent AI recall evaluation and automatic repair are not included in this standalone task version."] };
}

export async function runDirectCrawl(input: unknown, deps: DirectDependencies) {
  const request = requestSchema.parse(input);
  const catalog = await deps.crawl(request.domain);
  return { contractVersion: "1", request, status: catalog.accessible ? "complete" : "failed", catalog: { ...catalog, products: catalog.products.slice(0, request.comparisons) },
    coverage: { discoveredProducts: catalog.products.length, returnedProducts: Math.min(catalog.products.length, request.comparisons) }, costMicrousd: null };
}

export async function runDirectReport(input: unknown, deps: DirectDependencies, recommendations = true) {
  const request = requestSchema.parse(input);
  // Fail before crawling if paid search is not configured. Never silently use
  // empty/fixture comparisons as though a live research report succeeded.
  if (!deps.searchConfigured()) throw new Error("SEARCH_NOT_CONFIGURED: operator must configure OPENAI_API_KEY in the Trigger environment");
  const startedAt = new Date().toISOString();
  const catalog = await deps.crawl(request.domain);
  if (!catalog.accessible) return { contractVersion: "1", request, status: "failed", failure: { code: "CRAWL_UNAVAILABLE" }, catalog,
    comparisons: [], competitors: [], limitations: catalog.gaps, costMicrousd: null };
  const selectedSellers = new Set<string>();
  const enrich = deps.enrich || enrichProductTargets;
  const cappedEnrich: NonNullable<DirectProductSearchOptions["enrich"]> = async (targets, maxPages) => {
    const result = await enrich(targets, maxPages);
    // Choose sellers only after observing valid prices. Empty-price sites do
    // not consume the user's rival slots.
    return { ...result, products: result.products.filter((product) => {
      if (!hasValidObservedRivalPrice(product)) return false;
      const domain = canonicalDomain(product.domain);
      if (domain === request.domain) return false;
      if (!selectedSellers.has(domain) && selectedSellers.size >= request.rivals) return false;
      selectedSellers.add(domain); return true;
    }) };
  };
  let comparison = await buildDirectProductSearchComparison(request.domain, [catalog], {
    resultTarget: request.comparisons, maxPrimaryProducts: 1000, maxNewPrimaryProducts: 100,
    maxWorkMs: 8 * 60 * 1000, marketCountryCode: catalog.regionCountryCode,
    search: deps.search, enrich: cappedEnrich,
  });
  if (recommendations) comparison = applyProductActionPlans(comparison, deterministicProductActionResult(collectProductActionInputs(comparison)));
  const evaluation = evaluateReportDraftQuality({ comparison, comparisonTarget: request.comparisons, primaryDomain: request.domain,
    primaryProducts: catalog.products, repairRound: 3 });
  // Keep only priced rows, retain source/observation metadata, and never invent
  // a price difference for different currencies or different pack sizes.
  const comparisons = comparison.rows.flatMap((row) => row.matches.flatMap((match) => match.product && hasValidObservedRivalPrice(row.primary) && hasValidObservedRivalPrice(match.product)
    ? [{ primaryProduct: row.primary, rivalProduct: match.product, assessment: match.assessment || { method: "direct-web-search", claimType: "Inferred", verdict: "search_result" }, recommendation: match.decision?.actionPlan || null }]
    : []));
  const domains = [...new Set(comparisons.map((pair) => canonicalDomain(pair.rivalProduct.domain)))];
  return { contractVersion: "1", request, startedAt, completedAt: new Date().toISOString(), status: evaluation.status === "pass" ? "complete" : "limited",
    comparisons, competitors: domains.map((domain) => ({ domain, comparisonCount: comparisons.filter((pair) => canonicalDomain(pair.rivalProduct.domain) === domain).length })),
    metrics: { requestedComparisons: request.comparisons, pricedComparisons: comparisons.length, competitors: domains.length, catalogProducts: catalog.products.length, searchedProducts: comparison.coverage.primaryProductsScanned },
    evaluation: { basis: "deterministic-report-quality-gate", ...evaluation },
    limitations: [...catalog.gaps, ...(comparison.matching?.gaps || []), "Search-result relevance is inferred, not an independent exact-product certification.", "Provider cost is unknown; null must not be interpreted as zero.", "This version performs one bounded search pass, not automatic repair or independent AI recall evaluation."],
    costMicrousd: null };
}
