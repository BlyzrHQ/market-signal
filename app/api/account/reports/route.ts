import { accountContext, type AccountContext } from "../../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../../lib/billing-plans.ts";
import { activeWorkspacePlan, openBillingDatabase } from "../../../lib/billing-store.ts";
import { listWorkspaceReports, type WorkspaceReportSummary } from "../../../lib/report-store.ts";

type AccountReportsDependencies = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  activePlan: (workspaceId: string) => Promise<boolean>;
  listReports: (workspaceId: string) => Promise<WorkspaceReportSummary[]>;
};

const PRIVATE_HEADERS = { "cache-control": "private, no-store", vary: "Cookie" };

export function accountReportsDependencies(): AccountReportsDependencies {
  return {
    enabled: () => hostedBillingEnabled(process.env),
    authorize: (request) => accountContext(request),
    activePlan: async (workspaceId) => {
      const database = await openBillingDatabase();
      try {
        return Boolean(activeWorkspacePlan(database, workspaceId));
      } finally { database.close(); }
    },
    listReports: (workspaceId) => listWorkspaceReports(workspaceId, { limit: 5 }),
  };
}

export async function getAccountReports(request: Request, services: AccountReportsDependencies = accountReportsDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ authenticated: false, eligible: false, reports: [] }, { status: 404, headers: PRIVATE_HEADERS });
    const account = await services.authorize(request);
    if (!account) return Response.json({ authenticated: false, eligible: false, reports: [] }, { status: 401, headers: PRIVATE_HEADERS });
    if (!await services.activePlan(account.workspaceId)) return Response.json({ authenticated: true, eligible: false, reports: [] }, { status: 402, headers: PRIVATE_HEADERS });
    const reports = await services.listReports(account.workspaceId);
    return Response.json({ authenticated: true, eligible: true, reports }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    console.error("Account report history is unavailable.", error);
    return Response.json({ authenticated: false, eligible: false, reports: [], error: "Report history is temporarily unavailable." }, { status: 503, headers: PRIVATE_HEADERS });
  }
}

export async function GET(request: Request) {
  return getAccountReports(request);
}
