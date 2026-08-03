import { publicProductTarget } from "../../lib/storefront-product-enrichment.ts";
import { EDGE_PRODUCT_ENRICHMENT_MARKER } from "../../lib/edge-product-enrichment-recovery.ts";
import { enrichProductTargetsWithRecovery } from "../../lib/product-enrichment-recovery.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../lib/internal-auth.ts";
import { runtimeEnvironmentValue } from "../../lib/runtime-env.ts";

const MAX_TARGETS = 64;

export async function POST(request: Request) {
  try {
    const edgeRequest = request.headers.get(EDGE_PRODUCT_ENRICHMENT_MARKER) === "1";
    if (edgeRequest && !await hasValidInternalAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
    const body = await request.json() as { targets?: unknown };
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS).flatMap((value) => {
      const parsed = publicProductTarget(value);
      return parsed ? [parsed] : [];
    }) : [];
    if (!targets.length) return Response.json({ ok: false, error: "At least one verified selected product page is required." }, { status: 400 });
    const callbackToken = await runtimeEnvironmentValue("MARKET_SIGNAL_CALLBACK_TOKEN");
    const result = await enrichProductTargetsWithRecovery(targets, MAX_TARGETS, {
      configuredUrl: process.env.MARKET_SIGNAL_EDGE_ENRICH_URL,
      requestUrl: request.url,
      callbackToken,
      deployTarget: process.env.MARKET_SIGNAL_DEPLOY_TARGET,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Selected product enrichment was unavailable." }, { status: 400 });
  }
}
