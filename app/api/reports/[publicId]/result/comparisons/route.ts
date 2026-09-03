import { type AccountContext } from "../../../../../lib/account-auth.ts";
import { authorizeStoredReport, PRIVATE_REPORT_HEADERS } from "../../../../../lib/report-access.ts";
import { reportApiAccountContext } from "../../../../../lib/report-api-auth.ts";
import {
  agentComparisons,
  decodeAgentComparisonCursor,
  encodeAgentComparisonCursor,
  ReportLoopFactsError,
} from "../../../../../lib/report-loop-projection.ts";
import {
  getStoredReport,
  loadStoredReportLoopAccess,
  loadStoredReportMatchPage,
} from "../../../../../lib/report-store.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };

type ReportComparisonResultDependencies = {
  now: () => Date;
  loadAccess: typeof loadStoredReportLoopAccess;
  loadReport: typeof getStoredReport;
  loadMatches: typeof loadStoredReportMatchPage;
  authorize: (request: Request) => Promise<AccountContext | null>;
};

export function reportComparisonResultDependencies(): ReportComparisonResultDependencies {
  return {
    now: () => new Date(),
    loadAccess: loadStoredReportLoopAccess,
    loadReport: getStoredReport,
    loadMatches: loadStoredReportMatchPage,
    authorize: reportApiAccountContext,
  };
}

function boundedLimit(value: string | null) {
  if (value === null || value === "") return 50;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : null;
}

export async function getReportComparisonResult(
  request: Request,
  context: RouteContext,
  services: ReportComparisonResultDependencies = reportComparisonResultDependencies(),
) {
  try {
    const { publicId } = await context.params;
    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId") || "";
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(requestId)) {
      return Response.json({ ok: false, error: "A valid request id is required.", errorCode: "invalid-request-id" }, { status: 400, headers: PRIVATE_REPORT_HEADERS });
    }
    const limit = boundedLimit(url.searchParams.get("limit"));
    if (limit === null) return Response.json({ ok: false, error: "Comparison page limit must be between 1 and 50.", errorCode: "invalid-limit" }, { status: 400, headers: PRIVATE_REPORT_HEADERS });
    const cursor = decodeAgentComparisonCursor(publicId, url.searchParams.get("cursor") || "");
    if (cursor === null) return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });

    const access = await services.loadAccess(publicId);
    if (!access || access.commandId !== requestId) {
      return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    }
    const authorization = await authorizeStoredReport(request, access, {
      authorize: services.authorize,
      now: services.now(),
      allowLegacyPublic: false,
    });
    if (!authorization) return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });

    const report = await services.loadReport(publicId, services.now());
    if (!report || report.run.id !== access.runId || report.run.workspaceId !== access.workspaceId) {
      return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    }
    if (report.run.status !== "complete" && report.run.status !== "limited") {
      return Response.json({ ok: false, error: "The report has not published terminal comparison facts.", errorCode: "report-not-terminal" }, { status: 409, headers: PRIVATE_REPORT_HEADERS });
    }

    const matches = await services.loadMatches(publicId, { cursor: cursor || undefined, limit });
    const items = agentComparisons(matches, report);
    return Response.json({
      schemaVersion: "1",
      requestId,
      publicReportId: publicId,
      authoritative: true,
      manifestHash: matches.manifestHash,
      totalCount: matches.totalCount,
      returnedCount: items.length,
      items,
      nextCursor: encodeAgentComparisonCursor(publicId, matches.nextCursor),
    }, { headers: PRIVATE_REPORT_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report comparisons could not be read.";
    const invalid = /invalid report id|invalid report match page size/i.test(message);
    const unavailable = /authoritative report match(?:es)? facts are unavailable/i.test(message);
    const inconsistent = error instanceof ReportLoopFactsError;
    return Response.json({
      ok: false,
      error: invalid
        ? "Invalid comparison page request."
        : unavailable
          ? "Authoritative report matches are unavailable."
          : inconsistent
            ? "Authoritative report comparison facts are inconsistent."
            : "The report comparisons could not be read.",
      errorCode: invalid ? "invalid-request" : unavailable ? "facts-unavailable" : inconsistent ? "facts-inconsistent" : "comparison-read-failed",
    }, { status: invalid ? 400 : unavailable || inconsistent ? 409 : 503, headers: PRIVATE_REPORT_HEADERS });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return getReportComparisonResult(request, context);
}
