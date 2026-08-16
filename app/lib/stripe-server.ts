import Stripe from "stripe";

let stripeClient: Stripe | null = null;

export function stripeFromEnvironment(environment: Record<string, string | undefined> = process.env): Stripe {
  const key = String(environment.STRIPE_RESTRICTED_KEY || "").trim();
  if (!key) throw new Error("Stripe is not configured.");
  if (environment === process.env && stripeClient) return stripeClient;
  const stripe = new Stripe(key, { apiVersion: "2026-07-29.dahlia", appInfo: { name: "Market Signal" } });
  if (environment === process.env) stripeClient = stripe;
  return stripe;
}

export function publicApplicationUrl(environment: Record<string, string | undefined> = process.env): string {
  const candidate = String(environment.BETTER_AUTH_URL || "").trim();
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("The public application URL is invalid.");
  return parsed.origin;
}
