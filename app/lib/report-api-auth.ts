import { accountContext, type AccountContext } from "./account-auth.ts";
import { hostedBillingEnabled } from "./billing-plans.ts";
import { hasValidApiAuthorization } from "./internal-auth.ts";

export const CONTROLLED_CLI_WORKSPACE_ID = "controlled-cli-workspace";

/**
 * Resolves either the normal browser account or the single-tenant token used
 * by a self-hosted/controlled deployment. Hosted billing deliberately refuses
 * the shared token because it is not a customer-scoped credential.
 */
export async function reportApiAccountContext(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): Promise<AccountContext | null> {
  const browserAccount = await accountContext(request);
  if (browserAccount) return browserAccount;
  if (hostedBillingEnabled(environment)) return null;
  if (!await hasValidApiAuthorization(request.headers.get("authorization"), String(environment.MARKET_SIGNAL_API_TOKEN || ""))) return null;
  return {
    user: { id: "controlled-cli", name: "Controlled CLI", email: "" },
    workspaceId: CONTROLLED_CLI_WORKSPACE_ID,
  };
}
