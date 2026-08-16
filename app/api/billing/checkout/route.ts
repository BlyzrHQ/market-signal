import type Stripe from "stripe";
import { accountContext } from "../../../lib/account-auth.ts";
import { billingPlan, configuredPriceId, hostedBillingEnabled } from "../../../lib/billing-plans.ts";
import { getWorkspaceSubscription, openBillingDatabase, saveWorkspaceCustomer } from "../../../lib/billing-store.ts";
import { publicApplicationUrl, stripeFromEnvironment } from "../../../lib/stripe-server.ts";

const BLOCKING_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "incomplete"]);

type CheckoutServices = {
  authorize: typeof accountContext;
  openDatabase: typeof openBillingDatabase;
  stripe: () => Stripe;
  applicationUrl: () => string;
  now: () => Date;
  environment: Record<string, string | undefined>;
};

const checkoutServices: CheckoutServices = {
  authorize: accountContext,
  openDatabase: openBillingDatabase,
  stripe: stripeFromEnvironment,
  applicationUrl: publicApplicationUrl,
  now: () => new Date(),
  environment: process.env,
};

export async function createCheckout(request: Request, services: CheckoutServices = checkoutServices) {
  if (!hostedBillingEnabled(services.environment)) return Response.json({ code: "billing_not_configured", error: "Hosted billing is not enabled." }, { status: 503 });
  const account = await services.authorize(request);
  if (!account) return Response.json({ code: "authentication_required", error: "Sign in to choose a plan." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { plan?: unknown };
  const plan = billingPlan(body.plan);
  if (!plan) return Response.json({ code: "invalid_plan", error: "Choose a valid plan." }, { status: 400 });
  const priceId = configuredPriceId(plan, services.environment);
  if (!priceId) return Response.json({ code: "billing_not_configured", error: "Billing is temporarily unavailable." }, { status: 503 });

  const database = await services.openDatabase();
  try {
    const existing = getWorkspaceSubscription(database, account.workspaceId);
    if (existing && (existing.status === "active" || existing.status === "trialing")) {
      return Response.json({ code: "subscription_active", error: "Manage your existing plan from the billing portal." }, { status: 409 });
    }
    const stripe = services.stripe();
    let customerId = existing?.stripeCustomerId || "";
    if (customerId) {
      const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
      if (subscriptions.data.some((subscription) => BLOCKING_SUBSCRIPTION_STATUSES.has(subscription.status))) {
        return Response.json({ code: "subscription_active", error: "Manage your existing plan from the billing portal." }, { status: 409 });
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: account.user.email,
        name: account.user.name || undefined,
        metadata: { workspace_id: account.workspaceId, app: "market-signal" },
      }, { idempotencyKey: `market-signal-customer-${account.workspaceId}` });
      customerId = customer.id;
      saveWorkspaceCustomer(database, account.workspaceId, customerId);
    }
    const baseURL = services.applicationUrl();
    const now = services.now();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: account.workspaceId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseURL}/account?checkout=success`,
      cancel_url: `${baseURL}/pricing?checkout=cancelled`,
      allow_promotion_codes: true,
      integration_identifier: "market_signal",
      expires_at: Math.floor(now.getTime() / 1_000) + 30 * 60,
      metadata: { workspace_id: account.workspaceId, plan: plan.id },
      subscription_data: { metadata: { workspace_id: account.workspaceId, app: "market-signal" } },
    }, { idempotencyKey: `market-signal-checkout-${account.workspaceId}-${plan.id}-${Math.floor(now.getTime() / (30 * 60 * 1_000))}` });
    if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
    return Response.json({ url: session.url }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Stripe Checkout could not be created.", error instanceof Error ? error.message : "unknown");
    return Response.json({ code: "checkout_unavailable", error: "Checkout is temporarily unavailable." }, { status: 503 });
  } finally {
    database.close();
  }
}

export async function POST(request: Request) {
  return createCheckout(request);
}
