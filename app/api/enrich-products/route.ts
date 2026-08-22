import { enrichProductTargets, publicProductTarget, type EnrichmentDependencies } from "../../lib/storefront-product-enrichment.ts";
import { canonicalDomain } from "../../lib/domain.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../lib/internal-auth.ts";

const MAX_TARGETS = 64;

export function exclusiveDurableEnrichmentResult(result: Awaited<ReturnType<typeof enrichProductTargets>>) {
  const gapKeys = new Set(result.coverage.gaps.flatMap((gap) => {
    try {
      const url = new URL(gap.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];
      return [`${canonicalDomain(url.hostname)}\n${gap.productId}`];
    } catch { return []; }
  }));
  const products = result.products.filter((product) => !gapKeys.has(`${canonicalDomain(product.domain)}\n${product.id}`));
  return { products, coverage: { ...result.coverage, pagesFetched: products.length } };
}

export async function handleProductEnrichmentRequest(request: Request, localDependencies?: EnrichmentDependencies) {
  try {
    const body = await request.json() as { targets?: unknown };
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS).flatMap((value) => {
      const parsed = publicProductTarget(value);
      return parsed ? [parsed] : [];
    }) : [];
    if (!targets.length) return Response.json({ ok: false, error: "At least one verified selected product page is required." }, { status: 400 });
    const result = exclusiveDurableEnrichmentResult(await enrichProductTargets(targets, MAX_TARGETS, localDependencies));
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Selected product enrichment was unavailable." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!await hasValidInternalAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
  return handleProductEnrichmentRequest(request);
}
