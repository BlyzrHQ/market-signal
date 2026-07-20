import { dispatchReportJob, ReportDispatchError } from "../../lib/report-dispatch.ts";
import { createReportRun, markReportDispatched, markReportDispatchFailed, ReportStorageError } from "../../lib/report-store.ts";

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
  let stage: "request" | "storage-create" | "dispatch" | "dispatch-telemetry" = "request";
  try {
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown };
    stage = "storage-create";
    const report = await services.create({
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
    });
    publicId = report.publicId;
    let job: Awaited<ReturnType<typeof dispatchReportJob>>;
    try {
      stage = "dispatch";
      job = await services.dispatch(report);
    } catch (error) {
      const diagnosticCode = error instanceof ReportDispatchError ? error.code : "dispatch-failed";
      console.error("report job dispatch failed", { stage, diagnosticCode });
      try { await services.markDispatchFailed(report.publicId); } catch { /* the dispatch response still fails closed */ }
      return Response.json({ ok: false, error: "The background report job could not be started.", errorCode: "dispatch-failed", publicId: report.publicId }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    stage = "dispatch-telemetry";
    try { await services.markDispatched(report.publicId, job.runId); } catch { /* accepted work remains live even if dispatch telemetry races or is temporarily unavailable */ }
    return Response.json({ ok: true, report, job: { dispatched: true, runId: job.runId } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be created.";
    const status = /valid public domain/i.test(message) ? 400 : 503;
    const publicMessage = status === 400 ? message : "The persistent report could not be created.";
    const errorCode = status === 400 ? "invalid-domain" : stage === "storage-create" ? "storage-create-failed" : "report-create-failed";
    if (status === 503) console.error("report creation failed", { stage, diagnosticCode: error instanceof ReportStorageError ? error.code : /storage is unavailable/i.test(message) ? "storage-unavailable" : "storage-operation-failed" });
    return Response.json({ ok: false, error: publicMessage, errorCode, ...(publicId ? { publicId } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = createPersistentReport;
