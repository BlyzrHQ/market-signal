import type Stripe from "stripe";
import { planForConfiguredPrice } from "../../../lib/billing-plans.ts";
import { applySubscriptionUpdate, getSubscriptionByCustomer, openBillingDatabase, recordWebhookEvent, saveWorkspaceCustomer, type SubscriptionUpdate } from "../../../lib/billing-store.ts";
import { stripeFromEnvironment } from "../../../lib/stripe-server.ts";
import { hostedBillingEnabled } from "../../../lib/billing-plans.ts";

function id(value: string | { id: string } | null): string {
  return typeof value === "string" ? value : value?.id || "";
}

function subscriptionUpdate(event: Stripe.Event, subscription: Stripe.Subscription, environment: Record<string, string | undefined>, workspaceFallback = ""): SubscriptionUpdate | null {
  const item = subscription.items.data[0];
  const priceId = item?.price?.id || "";
  const plan = planForConfiguredPrice(priceId, environment);
  const workspaceId = String(workspaceFallback || subscription.metadata.workspace_id || "").trim();
  if (!workspaceId || !item) return null;
  return {
    workspaceId,
    stripeCustomerId: id(subscription.customer),
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    planTier: plan?.id || "",
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: new Date(item.current_period_start * 1_000).toISOString(),
    currentPeriodEnd: new Date(item.current_period_end * 1_000).toISOString(),
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
  };
}

type WebhookServices = {
  stripe: typeof stripeFromEnvironment;
  openDatabase: typeof openBillingDatabase;
  environment: Record<string, string | undefined>;
};

const webhookServices: WebhookServices = { stripe: stripeFromEnvironment, openDatabase: openBillingDatabase, environment: process.env };

export async function handleStripeWebhook(request: Request, services: WebhookServices = webhookServices) {
  if (!hostedBillingEnabled(services.environment)) return Response.json({ code: "billing_not_configured" }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  const secret = String(services.environment.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!signature || !secret) return Response.json({ code: "invalid_webhook" }, { status: 400 });
  let event: Stripe.Event;
  try {
    event = services.stripe().webhooks.constructEvent(await request.text(), signature, secret);
  } catch {
    return Response.json({ code: "invalid_webhook" }, { status: 400 });
  }

  const database = await services.openDatabase();
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = String(session.metadata?.workspace_id || session.client_reference_id || "").trim();
      const customerId = id(session.customer);
      if (workspaceId && customerId) {
        saveWorkspaceCustomer(database, workspaceId, customerId);
        recordWebhookEvent(database, event.id, event.type, event.created);
      }
    }
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const eventSubscription = event.data.object as Stripe.Subscription;
      const subscription = await services.stripe().subscriptions.retrieve(eventSubscription.id);
      const customerId = id(subscription.customer);
      const mappedWorkspace = customerId ? getSubscriptionByCustomer(database, customerId)?.workspaceId || "" : "";
      const update = subscriptionUpdate(event, subscription, services.environment, mappedWorkspace);
      if (!update) {
        recordWebhookEvent(database, event.id, event.type, event.created);
        console.info("Ignoring an unmapped Stripe subscription event.", { eventId: event.id, subscriptionId: subscription.id });
        return Response.json({ received: true, ignored: "unmapped_subscription" });
      }
      applySubscriptionUpdate(database, update);
    }
    if (!event.type.startsWith("customer.subscription.") && event.type !== "checkout.session.completed") {
      recordWebhookEvent(database, event.id, event.type, event.created);
    }
    return Response.json({ received: true });
  } finally {
    database.close();
  }
}

export async function POST(request: Request) {
  return handleStripeWebhook(request);
}
