import type Database from "better-sqlite3";
import { SHARED_REPORT_HEADERS } from "../../../../lib/report-access.ts";
import { openReportSharingDatabase, resolveActiveReportShare } from "../../../../lib/report-sharing-store.ts";
import { loadStoredReportMatchPage } from "../../../../lib/report-store.ts";

type RouteContext = { params: Promise<{ token: string }> | { token: string } };
type SharedMatchesDependencies = {
  openDatabase: () => Promise<Database.Database>;
  resolveShare: typeof resolveActiveReportShare;
  loadMatchPage: typeof loadStoredReportMatchPage;
  now: () => Date;
};

export function sharedMatchesDependencies(): SharedMatchesDependencies {
  return {
    openDatabase: openReportSharingDatabase,
    resolveShare: resolveActiveReportShare,
    loadMatchPage: loadStoredReportMatchPage,
    now: () => new Date(),
  };
}

export async function getSharedReportMatches(request: Request, context: RouteContext, services: SharedMatchesDependencies = sharedMatchesDependencies()) {
  try {
    const { token } = await context.params;
    const database = await services.openDatabase();
    let share;
    try { share = services.resolveShare(database, token, services.now()); } finally { database.close(); }
    if (!share) return Response.json({ ok: false, error: "Shared report not found.", errorCode: "not-found" }, { status: 404, headers: SHARED_REPORT_HEADERS });
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const page = await services.loadMatchPage(share.privatePublicId, {
      cursor: url.searchParams.get("cursor") || undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    return Response.json({ ok: true, page }, { headers: SHARED_REPORT_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const invalid = /invalid report (?:match cursor|match page size)/i.test(message);
    const unavailable = /authoritative report match facts are unavailable/i.test(message);
    return Response.json({
      ok: false,
      error: invalid ? "Invalid shared report match request." : unavailable ? "Shared report matches are unavailable." : "The shared report matches could not be read.",
      errorCode: invalid ? "invalid-request" : unavailable ? "facts-unavailable" : "storage-read-failed",
    }, { status: invalid ? 400 : unavailable ? 409 : 503, headers: SHARED_REPORT_HEADERS });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return getSharedReportMatches(request, context);
}
