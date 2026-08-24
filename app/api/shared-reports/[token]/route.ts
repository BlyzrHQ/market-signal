import type Database from "better-sqlite3";
import { SHARED_REPORT_HEADERS } from "../../../lib/report-access.ts";
import { openReportSharingDatabase, resolveActiveReportShare } from "../../../lib/report-sharing-store.ts";
import { getStoredReport } from "../../../lib/report-store.ts";

type RouteContext = { params: Promise<{ token: string }> | { token: string } };
type SharedReportDependencies = {
  openDatabase: () => Promise<Database.Database>;
  resolveShare: typeof resolveActiveReportShare;
  loadReport: typeof getStoredReport;
  now: () => Date;
};

export function sharedReportDependencies(): SharedReportDependencies {
  return {
    openDatabase: openReportSharingDatabase,
    resolveShare: resolveActiveReportShare,
    loadReport: getStoredReport,
    now: () => new Date(),
  };
}

export function sharedReportPayload(report: {
  run: { primaryDomain: string; locale: "en" | "ar"; status: string; createdAt: string; updatedAt: string };
  document: unknown;
  documentSchemaVersion: number;
  documentObservedAt?: string;
  primaryProducts?: unknown;
}) {
  return {
    run: {
      primaryDomain: report.run.primaryDomain,
      locale: report.run.locale,
      status: report.run.status,
      createdAt: report.run.createdAt,
      updatedAt: report.run.updatedAt,
    },
    events: [],
    document: report.document,
    documentSchemaVersion: report.documentSchemaVersion,
    documentObservedAt: String(report.documentObservedAt || ""),
    ...(report.primaryProducts ? { primaryProducts: report.primaryProducts } : {}),
  };
}

export async function getSharedReport(request: Request, context: RouteContext, services: SharedReportDependencies = sharedReportDependencies()) {
  try {
    const { token } = await context.params;
    const now = services.now();
    const database = await services.openDatabase();
    let share;
    try { share = services.resolveShare(database, token, now); } finally { database.close(); }
    if (!share) return Response.json({ ok: false, error: "Shared report not found.", errorCode: "not-found" }, { status: 404, headers: SHARED_REPORT_HEADERS });
    const report = await services.loadReport(share.privatePublicId, now);
    if (!report?.document || !["complete", "limited"].includes(report.run.status)) {
      return Response.json({ ok: false, error: "Shared report not found.", errorCode: "not-found" }, { status: 404, headers: SHARED_REPORT_HEADERS });
    }
    return Response.json({ ok: true, report: sharedReportPayload(report) }, { headers: SHARED_REPORT_HEADERS });
  } catch {
    return Response.json({ ok: false, error: "The shared report could not be read.", errorCode: "storage-read-failed" }, { status: 503, headers: SHARED_REPORT_HEADERS });
  }
}

export async function GET(request: Request, context: RouteContext) {
  return getSharedReport(request, context);
}
