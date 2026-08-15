import {
  edgeRecoverableProductTargets,
  mergeEdgeProductEnrichment,
  recoverProductEnrichmentThroughEdge,
} from "./edge-product-enrichment-recovery.ts";
import type { ProductEnrichmentTarget, ProductRecord } from "./product-intelligence.ts";
import { enrichProductTargets, type EnrichmentDependencies, type ProductEnrichmentCoverage } from "./storefront-product-enrichment.ts";

const EDGE_PROVIDER = "market-signal.abdulla617931.chatgpt.site";

export type ProductEnrichmentRecoveryOptions = {
  configuredUrl?: string;
  requestUrl: string;
  callbackToken: string;
  deployTarget?: string;
  fetchImpl?: typeof fetch;
};

export async function enrichProductTargetsWithRecovery(
  targets: ProductEnrichmentTarget[],
  maxPages: number,
  options?: ProductEnrichmentRecoveryOptions,
  localDependencies?: EnrichmentDependencies,
): Promise<{ products: ProductRecord[]; coverage: ProductEnrichmentCoverage }> {
  const local = await enrichProductTargets(targets, maxPages, localDependencies);
  if (!options) return local;
  const eligibleTargets = edgeRecoverableProductTargets(local, targets);
  const recovered = await recoverProductEnrichmentThroughEdge(eligibleTargets, options);
  return mergeEdgeProductEnrichment(local, eligibleTargets, recovered, EDGE_PROVIDER);
}
