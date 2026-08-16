import { getStoredReport } from "../../../lib/report-store.ts";
import { recoverLegacyReport } from "../../../lib/legacy-report-recovery.ts";
import { settleTerminalReportReservation } from "../../../lib/report-terminal-billing.ts";

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

export async function GET(request: Request, context: RouteContext) {
  try {
    const id = await publicId(context);
    const report = await getStoredReport(id) || await recoverLegacyReport(id, { requestUrl: request.url });
    if (!report) return Response.json({ ok: false, error: "Report not found." }, { status: 404 });
    await settleTerminalReportReservation(report.run);
    return Response.json({ ok: true, report: publicReportPayload(report) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be read.";
    const invalidId = /invalid report id/i.test(message);
    return Response.json({ ok: false, error: invalidId ? "Invalid report id." : "The persistent report could not be read." }, { status: invalidId ? 400 : 503 });
  }
}
