import { type AccountContext } from "../../../../lib/account-auth.ts";
import { authorizeStoredReport, PRIVATE_REPORT_HEADERS, reportResponseHeaders } from "../../../../lib/report-access.ts";
import { reportApiAccountContext } from "../../../../lib/report-api-auth.ts";
import { loadStoredReportAccess, loadStoredReportMatchPage } from "../../../../lib/report-store.ts";
import { hostedBillingEnabled } from "../../../../lib/billing-plans.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };
type ReportMatchesDependencies = {
  now: () => Date;
  loadAccess: typeof loadStoredReportAccess;
  loadMatchPage: typeof loadStoredReportMatchPage;
  authorize: (request: Request) => Promise<AccountContext | null>;
  allowLegacyPublic: () => boolean;
};

export function reportMatchesDependencies(): ReportMatchesDependencies {
  return {
    now: () => new Date(),
    loadAccess: loadStoredReportAccess,
    loadMatchPage: loadStoredReportMatchPage,
    authorize: reportApiAccountContext,
    allowLegacyPublic: () => !hostedBillingEnabled(process.env),
  };
}

export async function publicReportMatches(request: Request, context: RouteContext, services: ReportMatchesDependencies = reportMatchesDependencies()) {
  try {
    const { publicId } = await context.params;
    const authorization = await authorizeStoredReport(request, await services.loadAccess(publicId), {
      authorize: services.authorize,
      now: services.now(),
      allowLegacyPublic: services.allowLegacyPublic(),
    });
    if (!authorization) return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const page = await services.loadMatchPage(publicId, {
      cursor: url.searchParams.get("cursor") || undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    const headers = reportResponseHeaders(authorization);
    if (authorization.visibility === "owned-private") return Response.json({ ok: true, page }, { headers });
    const etag = `"${page.manifestHash}:${page.items[0]?.key || "start"}:${page.items.at(-1)?.key || "empty"}"`;
    const publicHeaders = { ETag: etag, "Cache-Control": "public, max-age=300, s-maxage=86400, immutable" };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: publicHeaders });
    return Response.json({ ok: true, page }, { headers: publicHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report matches could not be read.";
    const invalid = /invalid report (?:id|match cursor|match page size)/i.test(message);
    const missing = /report not found/i.test(message);
    const unavailable = /authoritative report match facts are unavailable/i.test(message);
    return Response.json({ ok: false, error: invalid ? "Invalid report match request." : missing ? "Report not found." : unavailable ? "Authoritative report matches are unavailable; the compact report remains available." : "The report matches could not be read.", errorCode: invalid ? "invalid-request" : missing ? "not-found" : unavailable ? "facts-unavailable" : "storage-read-failed" }, { status: invalid ? 400 : missing ? 404 : unavailable ? 409 : 503, headers: PRIVATE_REPORT_HEADERS });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return publicReportMatches(request, context);
}
