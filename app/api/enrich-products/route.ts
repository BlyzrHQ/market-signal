import { enrichProductTargets, publicProductTarget } from "../../lib/storefront-product-enrichment.ts";

const MAX_TARGETS = 24;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { targets?: unknown };
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, MAX_TARGETS).flatMap((value) => {
      const parsed = publicProductTarget(value);
      return parsed ? [parsed] : [];
    }) : [];
    if (!targets.length) return Response.json({ ok: false, error: "At least one verified selected product page is required." }, { status: 400 });
    const result = await enrichProductTargets(targets, MAX_TARGETS);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Selected product enrichment was unavailable." }, { status: 400 });
  }
}
