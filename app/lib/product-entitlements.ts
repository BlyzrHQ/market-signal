import { canonicalDomain } from "./domain.ts";

export const PRODUCT_PLAN_LIMITS = {
  starter: 20,
  solo: 20,
  growth: 20,
  agency: 20,
} as const;

export type ProductPlan = keyof typeof PRODUCT_PLAN_LIMITS;
export type ProductEntitlement = { plan: ProductPlan; productLimit: number; reportObservedAt?: string };

function productPlan(value: unknown): ProductPlan | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized in PRODUCT_PLAN_LIMITS ? normalized as ProductPlan : null;
}

function registryPlan(primaryDomain: string, registryJson: string) {
  if (!registryJson) return null;
  try {
    const value = JSON.parse(registryJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const registry = value as Record<string, unknown>;
    const direct = productPlan(registry[canonicalDomain(primaryDomain)]);
    if (direct) return direct;
    for (const [domain, plan] of Object.entries(registry)) {
      if (canonicalDomain(domain) === canonicalDomain(primaryDomain)) return productPlan(plan);
    }
  } catch { /* Invalid server configuration falls back safely. */ }
  return null;
}

export function resolveProductEntitlement(primaryDomain: string, options: { defaultPlan?: string; registryJson?: string } = {}): ProductEntitlement {
  const plan = registryPlan(primaryDomain, options.registryJson || "") || productPlan(options.defaultPlan) || "starter";
  return { plan, productLimit: PRODUCT_PLAN_LIMITS[plan] };
}
