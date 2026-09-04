import { crawlDomain, crawlPrimaryDomain, sallaRecoveryDomainCrawl, shopifyRecoveryDomainCrawl, enrichPrimaryProductPrices, primaryProductPricePageBudget } from "../../app/api/crawl/route.ts";
import { isSallaCatalogRecoveryEligible } from "../../app/lib/salla-mcp-catalog-recovery.ts";
import { isShopifyUcpCatalogRecoveryEligible } from "../../app/lib/shopify-ucp-catalog-recovery.ts";
import { boundedPrimaryCatalogProducts } from "../../app/lib/competitor-discovery.ts";
import type { DirectDependencies } from "./core.ts";

// Call research functions directly, never POST route handlers. There is no
// report-store, customer entitlement, callback token, or VPS transport here.
export const directDependencies: DirectDependencies = {
  searchConfigured: () => Boolean(process.env.OPENAI_API_KEY?.trim()),
  crawl: async (domain) => {
    let result: Awaited<ReturnType<typeof crawlDomain>> = await crawlPrimaryDomain(domain);
    if (isSallaCatalogRecoveryEligible(result)) result = await sallaRecoveryDomainCrawl(result, 1000) || result;
    if (isShopifyUcpCatalogRecoveryEligible(result)) result = await shopifyRecoveryDomainCrawl(result, 1000) || result;
    if (result.homepage) result = await enrichPrimaryProductPrices(result, undefined, primaryProductPricePageBudget(true));
    return { domain: result.domain, products: boundedPrimaryCatalogProducts(result.products, 1000), regionCountryCode: result.homepage?.regionCountryCode || "",
      sourceUrl: result.homepage?.sourceUrl || `https://${result.domain}/`, observedAt: result.fetchedAt,
      gaps: result.gaps.map((gap) => gap.reason), accessible: Boolean(result.homepage) && result.siteState?.status !== "parked" };
  },
};
