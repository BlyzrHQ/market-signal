import { buildAIProductActions, type ProductActionFact, type ProductActionInput } from "../../lib/ai-action-planner.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../lib/internal-auth.ts";
import type { ProductActionLever } from "../../lib/product-intelligence.ts";
import { workerOnlyResponse } from "../../lib/process-role.ts";

const MAX_INPUTS = 480;
const MAX_FACTS = 32;
const LEVERS = new Set<ProductActionLever>(["price_response", "merchandising", "positioning", "price_transparency", "evidence_gap", "packaging"]);
const FACT_KINDS = new Set<ProductActionFact["kind"]>(["identity", "attribute", "price", "match", "source"]);

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function parseFact(value: unknown): ProductActionFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const key = text(item.key, 100);
  const factText = text(item.text, 240);
  const kind = item.kind as ProductActionFact["kind"];
  if (!/^[a-z0-9._-]+$/i.test(key) || !FACT_KINDS.has(kind) || !factText) return null;
  return { key, kind, text: factText };
}

function parseActionInput(value: unknown): ProductActionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const facts = Array.isArray(item.facts) ? item.facts.map(parseFact) : [];
  if (!facts.length || facts.length > MAX_FACTS || facts.some((fact) => !fact)) return null;
  const typedFacts = facts as ProductActionFact[];
  if (new Set(typedFacts.map((fact) => fact.key)).size !== typedFacts.length) return null;
  const input: ProductActionInput = {
    pairKey: text(item.pairKey, 620),
    fallbackActionEn: text(item.fallbackActionEn, 240),
    fallbackActionAr: text(item.fallbackActionAr, 240),
    fallbackRationaleEn: text(item.fallbackRationaleEn, 300),
    fallbackRationaleAr: text(item.fallbackRationaleAr, 300),
    fallbackLeverType: item.fallbackLeverType as ProductActionLever,
    hasComparablePrice: item.hasComparablePrice === true,
    facts: typedFacts,
  };
  if (!input.pairKey || !input.fallbackActionEn || !input.fallbackActionAr || !input.fallbackRationaleEn || !input.fallbackRationaleAr || !LEVERS.has(input.fallbackLeverType)) return null;
  return input;
}

export function parseActionInputs(value: unknown): ProductActionInput[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_INPUTS) throw new Error(`Between 1 and ${MAX_INPUTS} product pairs are required.`);
  const inputs = value.map(parseActionInput);
  if (inputs.some((input) => !input)) throw new Error("Every product pair must contain bounded fallback text and attributable facts.");
  const parsed = inputs as ProductActionInput[];
  if (new Set(parsed.map((input) => input.pairKey)).size !== parsed.length) throw new Error("Product pair identifiers must be unique.");
  return parsed;
}

export async function POST(request: Request) {
  const roleResponse = workerOnlyResponse();
  if (roleResponse) return roleResponse;
  if (!await hasValidInternalAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
  try {
    const body = await request.json() as { inputs?: unknown };
    const inputs = parseActionInputs(body.inputs);
    const result = await buildAIProductActions(inputs);
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Product action planning was unavailable." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
