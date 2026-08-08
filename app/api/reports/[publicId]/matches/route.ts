import { loadStoredReportMatchPage } from "../../../../lib/report-store.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };
type MatchPageLoader = typeof loadStoredReportMatchPage;

export async function publicReportMatches(request: Request, context: RouteContext, loadMatchPage: MatchPageLoader = loadStoredReportMatchPage) {
  try {
    const { publicId } = await context.params;
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const page = await loadMatchPage(publicId, {
      cursor: url.searchParams.get("cursor") || undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    const etag = `"${page.manifestHash}:${page.items[0]?.key || "start"}:${page.items.at(-1)?.key || "empty"}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "public, max-age=300, s-maxage=86400, immutable" } });
    return Response.json({ ok: true, page }, { headers: { ETag: etag, "Cache-Control": "public, max-age=300, s-maxage=86400, immutable" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report matches could not be read.";
    const invalid = /invalid report (?:id|match cursor|match page size)/i.test(message);
    const missing = /report not found/i.test(message);
    const unavailable = /authoritative report match facts are unavailable/i.test(message);
    return Response.json({ ok: false, error: invalid ? "Invalid report match request." : missing ? "Report not found." : unavailable ? "Authoritative report matches are unavailable; the compact report remains available." : "The report matches could not be read.", errorCode: invalid ? "invalid-request" : missing ? "not-found" : unavailable ? "facts-unavailable" : "storage-read-failed" }, { status: invalid ? 400 : missing ? 404 : unavailable ? 409 : 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return publicReportMatches(request, context);
}
