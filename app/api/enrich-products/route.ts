import { enrichProductTargets, publicProductTarget } from "../../lib/storefront-product-enrichment.ts";
import { mergeEdgeProductEnrichment, recoverProductEnrichmentThroughEdge } from "../../lib/edge-product-enrichment-recovery.ts";
import { runtimeEnvironmentValue } from "../../lib/runtime-env.ts";

const MAX_TARGETS = 64;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { targets?: unknown };
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS).flatMap((value) => {
      const parsed = publicProductTarget(value);
      return parsed ? [parsed] : [];
    }) : [];
    if (!targets.length) return Response.json({ ok: false, error: "At least one verified selected product page is required." }, { status: 400 });
    const local = await enrichProductTargets(targets, MAX_TARGETS);
    const unreachableIds = new Set(local.coverage.gaps.filter((gap) => "code" in gap && gap.code === "robots_unreachable").map((gap) => gap.productId));
    const eligibleTargets = targets.filter((target) => unreachableIds.has(target.productId));
    const callbackToken = await runtimeEnvironmentValue("MARKET_SIGNAL_CALLBACK_TOKEN");
    const recovered = await recoverProductEnrichmentThroughEdge(eligibleTargets, {
      configuredUrl: process.env.MARKET_SIGNAL_EDGE_ENRICH_URL,
      requestUrl: request.url,
      callbackToken,
      deployTarget: process.env.MARKET_SIGNAL_DEPLOY_TARGET,
    });
    const result = mergeEdgeProductEnrichment(local, eligibleTargets, recovered, "market-signal.abdulla617931.chatgpt.site");
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Selected product enrichment was unavailable." }, { status: 400 });
  }
}
