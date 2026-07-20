import { dispatchReportJob } from "../../lib/report-dispatch.ts";
import { createReportRun, markReportDispatched, markReportDispatchFailed } from "../../lib/report-store.ts";

type ReportCreationDependencies = {
  create: typeof createReportRun;
  dispatch: typeof dispatchReportJob;
  markDispatched: typeof markReportDispatched;
  markDispatchFailed: typeof markReportDispatchFailed;
};

const dependencies: ReportCreationDependencies = {
  create: createReportRun,
  dispatch: dispatchReportJob,
  markDispatched: markReportDispatched,
  markDispatchFailed: markReportDispatchFailed,
};

export async function createPersistentReport(request: Request, services: ReportCreationDependencies = dependencies) {
  let publicId = "";
  try {
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown };
    const report = await services.create({
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
    });
    publicId = report.publicId;
    let job: Awaited<ReturnType<typeof dispatchReportJob>>;
    try {
      job = await services.dispatch(report);
    } catch {
      try { await services.markDispatchFailed(report.publicId); } catch { /* the dispatch response still fails closed */ }
      return Response.json({ ok: false, error: "The background report job could not be started.", publicId: report.publicId }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    try { await services.markDispatched(report.publicId, job.runId); } catch { /* accepted work remains live even if dispatch telemetry races or is temporarily unavailable */ }
    return Response.json({ ok: true, report, job: { dispatched: true, runId: job.runId } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be created.";
    const status = /valid public domain/i.test(message) ? 400 : 503;
    const publicMessage = status === 400 ? message : "The persistent report could not be created.";
    return Response.json({ ok: false, error: publicMessage, ...(publicId ? { publicId } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = createPersistentReport;
