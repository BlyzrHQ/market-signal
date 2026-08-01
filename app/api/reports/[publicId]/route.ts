import { getStoredReport } from "../../../lib/report-store.ts";
import { recoverLegacyReport } from "../../../lib/legacy-report-recovery.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };

async function publicId(context: RouteContext) {
  return (await context.params).publicId;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const id = await publicId(context);
    const report = await getStoredReport(id) || await recoverLegacyReport(id, { requestUrl: request.url });
    if (!report) return Response.json({ ok: false, error: "Report not found." }, { status: 404 });
    return Response.json({ ok: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be read.";
    const invalidId = /invalid report id/i.test(message);
    return Response.json({ ok: false, error: invalidId ? "Invalid report id." : "The persistent report could not be read." }, { status: invalidId ? 400 : 503 });
  }
}
