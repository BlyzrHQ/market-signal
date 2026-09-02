import { type AccountContext } from "../../../../lib/account-auth.ts";
import { authorizeStoredReport, PRIVATE_REPORT_HEADERS } from "../../../../lib/report-access.ts";
import { reportApiAccountContext } from "../../../../lib/report-api-auth.ts";
import { buildMarketSignalLoopResult } from "../../../../lib/report-loop-result.ts";
import {
  getReportEvaluation,
  getStoredReport,
  loadStoredReportLoopAccess,
  loadStoredReportMatchPage,
} from "../../../../lib/report-store.ts";
import { settleTerminalReportReservation } from "../../../../lib/report-terminal-billing.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };

type ReportLoopResultDependencies = {
  now: () => Date;
  loadAccess: typeof loadStoredReportLoopAccess;
  loadReport: typeof getStoredReport;
  loadMatches: typeof loadStoredReportMatchPage;
  loadEvaluation: typeof getReportEvaluation;
  authorize: (request: Request) => Promise<AccountContext | null>;
  settle: typeof settleTerminalReportReservation;
};

export function reportLoopResultDependencies(): ReportLoopResultDependencies {
  return {
    now: () => new Date(),
    loadAccess: loadStoredReportLoopAccess,
    loadReport: getStoredReport,
    loadMatches: loadStoredReportMatchPage,
    loadEvaluation: getReportEvaluation,
    authorize: reportApiAccountContext,
    settle: settleTerminalReportReservation,
  };
}

export async function getReportLoopResult(
  request: Request,
  context: RouteContext,
  services: ReportLoopResultDependencies = reportLoopResultDependencies(),
) {
  try {
    const { publicId } = await context.params;
    const requestId = new URL(request.url).searchParams.get("requestId") || "";
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(requestId)) {
      return Response.json({ ok: false, error: "A valid request id is required.", errorCode: "invalid-request-id" }, { status: 400, headers: PRIVATE_REPORT_HEADERS });
    }
    const access = await services.loadAccess(publicId);
    if (!access || access.commandId !== requestId) {
      return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    }
    const authorization = await authorizeStoredReport(request, access, {
      authorize: services.authorize,
      now: services.now(),
      allowLegacyPublic: false,
    });
    if (!authorization) return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });

    const report = await services.loadReport(publicId, services.now());
    if (!report || report.run.id !== access.runId || report.run.workspaceId !== access.workspaceId) {
      return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    }
    if (report.run.status !== "queued" && report.run.status !== "running") await services.settle(report.run);
    const terminalSuccess = report.run.status === "complete" || report.run.status === "limited";
    const [matches, evaluation] = await Promise.all([
      terminalSuccess ? services.loadMatches(publicId, { limit: 50 }) : Promise.resolve(null),
      terminalSuccess || report.run.status === "failed" ? services.loadEvaluation(publicId) : Promise.resolve(null),
    ]);
    return Response.json(await buildMarketSignalLoopResult({ requestId, report, matches, evaluation }), { headers: PRIVATE_REPORT_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report result could not be read.";
    const invalid = /invalid report id/i.test(message);
    const unavailable = /authoritative report matches are unavailable/i.test(message);
    return Response.json({
      ok: false,
      error: invalid ? "Invalid report id." : unavailable ? "Authoritative report matches are unavailable." : "The report result could not be read.",
      errorCode: invalid ? "invalid-request" : unavailable ? "facts-unavailable" : "result-read-failed",
    }, { status: invalid ? 400 : unavailable ? 409 : 503, headers: PRIVATE_REPORT_HEADERS });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return getReportLoopResult(request, context);
}
