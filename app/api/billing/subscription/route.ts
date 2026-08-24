import { accountContext } from "../../../lib/account-auth.ts";
import { BILLING_PLANS } from "../../../lib/billing-plans.ts";
import { getWorkspaceSubscription, openBillingDatabase, workspaceUsage } from "../../../lib/billing-store.ts";
import { priceWatchUsage } from "../../../lib/price-watch-store.ts";

export async function GET(request: Request) {
  const account = await accountContext(request);
  if (!account) return Response.json({ authenticated: false }, { status: 401, headers: { "cache-control": "no-store" } });
  const database = await openBillingDatabase();
  try {
    const subscription = getWorkspaceSubscription(database, account.workspaceId);
    const usage = workspaceUsage(database, account.workspaceId);
    const monitoringUsage = priceWatchUsage(database, account.workspaceId);
    const plan = subscription?.planTier ? BILLING_PLANS[subscription.planTier] : null;
    return Response.json({
      authenticated: true,
      user: account.user,
      subscription: subscription ? {
        plan: plan ? { id: plan.id, name: plan.name, reportsPerMonth: plan.reportsPerMonth, productLimit: plan.productLimit, monitoringCredits: plan.monitoringCredits } : null,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      } : null,
      usage,
      monitoringUsage,
    }, { headers: { "cache-control": "no-store" } });
  } finally {
    database.close();
  }
}
