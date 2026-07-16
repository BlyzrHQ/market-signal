import { createReportRun } from "../../lib/report-store.ts";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown };
    const report = await createReportRun({
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
    });
    return Response.json({ ok: true, report }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be created.";
    const status = /valid public domain/i.test(message) ? 400 : 503;
    return Response.json({ ok: false, error: message }, { status });
  }
}
