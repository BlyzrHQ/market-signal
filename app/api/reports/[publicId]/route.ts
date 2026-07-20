import { getStoredReport } from "../../../lib/report-store.ts";

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
