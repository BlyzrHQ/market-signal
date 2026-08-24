import { PRODUCT_PLAN_LIMITS, type ProductPlan } from "./product-entitlements.ts";

export type BillingPlan = {
  id: ProductPlan;
  name: string;
  monthlyPriceUsd: number;
  reportsPerMonth: number;
  productLimit: number;
  monitoringCredits: number;
  priceEnvironmentKey: string;
};

export const BILLING_PLANS: Record<ProductPlan, BillingPlan> = {
  starter: { id: "starter", name: "Starter", monthlyPriceUsd: 8, reportsPerMonth: 5, productLimit: PRODUCT_PLAN_LIMITS.starter, monitoringCredits: 1_000, priceEnvironmentKey: "STRIPE_PRICE_STARTER" },
  solo: { id: "solo", name: "Solo", monthlyPriceUsd: 29, reportsPerMonth: 10, productLimit: PRODUCT_PLAN_LIMITS.solo, monitoringCredits: 5_000, priceEnvironmentKey: "STRIPE_PRICE_SOLO" },
  growth: { id: "growth", name: "Growth", monthlyPriceUsd: 79, reportsPerMonth: 40, productLimit: PRODUCT_PLAN_LIMITS.growth, monitoringCredits: 25_000, priceEnvironmentKey: "STRIPE_PRICE_GROWTH" },
  agency: { id: "agency", name: "Agency", monthlyPriceUsd: 199, reportsPerMonth: 120, productLimit: PRODUCT_PLAN_LIMITS.agency, monitoringCredits: 100_000, priceEnvironmentKey: "STRIPE_PRICE_AGENCY" },
};

export function hostedBillingEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return String(environment.MARKET_SIGNAL_HOSTED_BILLING || "").trim().toLowerCase() === "true";
}

export function billingPlan(value: unknown): BillingPlan | null {
  const id = String(value || "").trim().toLowerCase() as ProductPlan;
  return BILLING_PLANS[id] || null;
}

export function configuredPriceId(plan: BillingPlan, environment: Record<string, string | undefined> = process.env): string | null {
  const priceId = String(environment[plan.priceEnvironmentKey] || "").trim();
  return /^price_[A-Za-z0-9]+$/.test(priceId) ? priceId : null;
}

export function planForConfiguredPrice(priceId: unknown, environment: Record<string, string | undefined> = process.env): BillingPlan | null {
  const candidate = String(priceId || "").trim();
  if (!candidate) return null;
  return Object.values(BILLING_PLANS).find((plan) => configuredPriceId(plan, environment) === candidate) || null;
}
