import { accountContext, type AccountContext } from "../../../lib/account-auth.ts";
import { authorizeStoredReport, PRIVATE_REPORT_HEADERS, reportResponseHeaders } from "../../../lib/report-access.ts";
import { getStoredReport, loadStoredReportAccess, type StoredReportAccess } from "../../../lib/report-store.ts";
import { recoverLegacyReport } from "../../../lib/legacy-report-recovery.ts";
import { settleTerminalReportReservation } from "../../../lib/report-terminal-billing.ts";
import { hostedBillingEnabled } from "../../../lib/billing-plans.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };

async function publicId(context: RouteContext) {
  return (await context.params).publicId;
}

export function publicReportPayload<T extends { run: Record<string, unknown> }>(report: T) {
  const run = { ...report.run };
  delete run.workspaceId;
  delete run.billingReservationId;
  return { ...report, run };
}

type ReportRouteDependencies = {
  now: () => Date;
  loadAccess: typeof loadStoredReportAccess;
  loadReport: typeof getStoredReport;
  recover: typeof recoverLegacyReport;
  authorize: (request: Request) => Promise<AccountContext | null>;
  settle: typeof settleTerminalReportReservation;
  allowLegacyPublic: () => boolean;
};

export function reportRouteDependencies(): ReportRouteDependencies {
  return {
    now: () => new Date(),
    loadAccess: loadStoredReportAccess,
    loadReport: getStoredReport,
    recover: recoverLegacyReport,
    authorize: accountContext,
    settle: settleTerminalReportReservation,
    allowLegacyPublic: () => !hostedBillingEnabled(process.env),
  };
}

function accessFromReport(report: { run: { id: string; publicId: string; workspaceId: string; expiresAt: string } }): StoredReportAccess {
  return {
    runId: report.run.id,
    publicId: report.run.publicId,
    workspaceId: report.run.workspaceId,
    expiresAt: report.run.expiresAt,
  };
}

export async function getReportResponse(request: Request, context: RouteContext, services: ReportRouteDependencies = reportRouteDependencies()) {
  try {
    const id = await publicId(context);
    const now = services.now();
    let access = await services.loadAccess(id);
    let report = null;
    if (!access) {
      report = await services.recover(id, { requestUrl: request.url });
      access = report ? accessFromReport(report) : null;
    }
    const authorization = await authorizeStoredReport(request, access, { authorize: services.authorize, now, allowLegacyPublic: services.allowLegacyPublic() });
    if (!authorization) return Response.json({ ok: false, error: "Report not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    report ||= await services.loadReport(id, now);
    if (!report) return Response.json({ ok: false, error: "Report not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    await services.settle(report.run);
    return Response.json({ ok: true, report: publicReportPayload(report) }, { headers: reportResponseHeaders(authorization) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be read.";
    const invalidId = /invalid report id/i.test(message);
    return Response.json({ ok: false, error: invalidId ? "Invalid report id." : "The persistent report could not be read." }, { status: invalidId ? 400 : 503, headers: PRIVATE_REPORT_HEADERS });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return getReportResponse(request, context);
}
