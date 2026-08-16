import { accountContext } from "../../../lib/account-auth.ts";
import { getWorkspaceSubscription, openBillingDatabase } from "../../../lib/billing-store.ts";
import { publicApplicationUrl, stripeFromEnvironment } from "../../../lib/stripe-server.ts";
import { hostedBillingEnabled } from "../../../lib/billing-plans.ts";

type PortalServices = {
  authorize: typeof accountContext;
  openDatabase: typeof openBillingDatabase;
  stripe: typeof stripeFromEnvironment;
  applicationUrl: typeof publicApplicationUrl;
  environment: Record<string, string | undefined>;
};

const portalServices: PortalServices = {
  authorize: accountContext,
  openDatabase: openBillingDatabase,
  stripe: stripeFromEnvironment,
  applicationUrl: publicApplicationUrl,
  environment: process.env,
};

export async function createPortal(request: Request, services: PortalServices = portalServices) {
  if (!hostedBillingEnabled(services.environment)) return Response.json({ code: "billing_not_configured", error: "Hosted billing is not enabled." }, { status: 503 });
  const account = await services.authorize(request);
  if (!account) return Response.json({ code: "authentication_required", error: "Sign in to manage billing." }, { status: 401 });
  const database = await services.openDatabase();
  try {
    const customerId = getWorkspaceSubscription(database, account.workspaceId)?.stripeCustomerId;
    if (!customerId) return Response.json({ code: "subscription_missing", error: "Choose a plan before opening billing settings." }, { status: 404 });
    const session = await services.stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${services.applicationUrl()}/account`,
    });
    return Response.json({ url: session.url }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Stripe Portal could not be created.", error instanceof Error ? error.message : "unknown");
    return Response.json({ code: "portal_unavailable", error: "Billing settings are temporarily unavailable." }, { status: 503 });
  } finally {
    database.close();
  }
}

export async function POST(request: Request) {
  return createPortal(request);
}
