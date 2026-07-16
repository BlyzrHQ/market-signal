import { appendReportEvent, getStoredReport, saveReportDocument, type ReportPhase, type ReportRunStatus } from "../../../lib/report-store.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };

async function publicId(context: RouteContext) {
  return (await context.params).publicId;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const report = await getStoredReport(await publicId(context));
    if (!report) return Response.json({ ok: false, error: "Report not found." }, { status: 404 });
    return Response.json({ ok: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be read.";
    return Response.json({ ok: false, error: message }, { status: /invalid report id/i.test(message) ? 400 : 503 });
  }
}

export async function mutateReport(request: Request, context: RouteContext) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = await publicId(context);
    if (body.action === "event") {
      const event = await appendReportEvent(id, {
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        phase: body.phase as ReportPhase,
        status: body.status as ReportRunStatus,
        message: typeof body.message === "string" ? body.message : "",
        metadata: body.metadata,
        errorCode: typeof body.errorCode === "string" ? body.errorCode : "",
      });
      return Response.json({ ok: true, event });
    }
    if (body.action === "document") {
      const saved = await saveReportDocument(id, body.document, {
        status: body.status === "limited" ? "limited" : "complete",
        observedAt: typeof body.observedAt === "string" ? body.observedAt : undefined,
      });
      return Response.json({ ok: true, saved });
    }
    return Response.json({ ok: false, error: "Unknown report persistence action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be updated.";
    const status = /invalid|not found|too large|terminal report/i.test(message) ? 400 : 503;
    return Response.json({ ok: false, error: message }, { status });
  }
}

export const POST = mutateReport;
export const PATCH = mutateReport;
