import type Database from "better-sqlite3";
import { accountContext, type AccountContext } from "../../../../lib/account-auth.ts";
import { hostedBillingEnabled } from "../../../../lib/billing-plans.ts";
import { authorizeStoredReport, PRIVATE_REPORT_HEADERS } from "../../../../lib/report-access.ts";
import {
  getReportShareState,
  openReportSharingDatabase,
  ReportShareStoreError,
  shareReport,
  unshareReport,
  type ReportShareState,
} from "../../../../lib/report-sharing-store.ts";
import { loadStoredReportAccess } from "../../../../lib/report-store.ts";
import { mutationRequestIsSameOrigin, readBoundedJsonObject } from "../../../../lib/request-json.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };
type ReportSharingDependencies = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  loadAccess: typeof loadStoredReportAccess;
  openDatabase: () => Promise<Database.Database>;
  now: () => Date;
};

export function reportSharingDependencies(): ReportSharingDependencies {
  return {
    enabled: () => hostedBillingEnabled(process.env),
    authorize: accountContext,
    loadAccess: loadStoredReportAccess,
    openDatabase: openReportSharingDatabase,
    now: () => new Date(),
  };
}

function publicShareState(request: Request, state: ReportShareState) {
  return {
    shared: state.shared,
    publicUrl: state.shared ? new URL(`/shared/${state.token}`, request.url).toString() : "",
    rotation: state.rotation,
    sharedAt: state.sharedAt,
    revokedAt: state.revokedAt,
  };
}

function routeError(error: unknown) {
  if (error instanceof ReportShareStoreError) {
    return Response.json({ ok: false, error: error.message, errorCode: error.code }, { status: error.httpStatus, headers: PRIVATE_REPORT_HEADERS });
  }
  console.error("Report sharing request failed.", { errorCode: "report-sharing-request-failed" });
  return Response.json({ ok: false, error: "Report sharing is temporarily unavailable.", errorCode: "storage-unavailable" }, { status: 503, headers: PRIVATE_REPORT_HEADERS });
}

async function ownerContext(request: Request, publicId: string, services: ReportSharingDependencies) {
  const authorization = await authorizeStoredReport(request, await services.loadAccess(publicId), {
    authorize: services.authorize,
    now: services.now(),
    allowLegacyPublic: false,
  });
  return authorization?.visibility === "owned-private" ? authorization.account : null;
}

export async function getReportSharing(request: Request, context: RouteContext, services: ReportSharingDependencies = reportSharingDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const { publicId } = await context.params;
    const account = await ownerContext(request, publicId, services);
    if (!account) return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const database = await services.openDatabase();
    try {
      const state = getReportShareState(database, publicId, account.workspaceId, services.now());
      return Response.json({ ok: true, ...publicShareState(request, state) }, { headers: PRIVATE_REPORT_HEADERS });
    } finally { database.close(); }
  } catch (error) { return routeError(error); }
}

export async function updateReportSharing(request: Request, context: RouteContext, services: ReportSharingDependencies = reportSharingDependencies()) {
  try {
    if (!services.enabled()) return Response.json({ ok: false, error: "Not found." }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin.", errorCode: "invalid-origin" }, { status: 403, headers: PRIVATE_REPORT_HEADERS });
    let action: "share" | "unshare";
    try {
      const body = await readBoundedJsonObject(request, 256);
      if (body.action !== "share" && body.action !== "unshare") throw new Error("invalid-action");
      action = body.action;
    } catch {
      return Response.json({ ok: false, error: "Choose share or unshare.", errorCode: "invalid-request" }, { status: 400, headers: PRIVATE_REPORT_HEADERS });
    }
    const { publicId } = await context.params;
    const account = await ownerContext(request, publicId, services);
    if (!account) return Response.json({ ok: false, error: "Report not found.", errorCode: "not-found" }, { status: 404, headers: PRIVATE_REPORT_HEADERS });
    const database = await services.openDatabase();
    try {
      const state = action === "share"
        ? shareReport(database, publicId, account.workspaceId, account.user.id, services.now())
        : unshareReport(database, publicId, account.workspaceId, account.user.id, services.now());
      return Response.json({ ok: true, ...publicShareState(request, state) }, { headers: PRIVATE_REPORT_HEADERS });
    } finally { database.close(); }
  } catch (error) { return routeError(error); }
}

export async function GET(request: Request, context: RouteContext) {
  return getReportSharing(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return updateReportSharing(request, context);
}
