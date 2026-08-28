import {
  getStoredReport,
  listWorkspaceReports,
  loadStoredReportAccess,
  loadStoredReportMatchPage,
  type StoredReportMatchPage,
  type StoredReportSnapshot,
  type WorkspaceReportSummary,
} from "./report-store.ts";
import { settleTerminalReportReservation } from "./report-terminal-billing.ts";

export type ReportQueryDependencies = {
  now: () => Date;
  listReports: typeof listWorkspaceReports;
  loadAccess: typeof loadStoredReportAccess;
  loadReport: typeof getStoredReport;
  loadMatchPage: typeof loadStoredReportMatchPage;
  settle: typeof settleTerminalReportReservation;
};

export class ReportQueryError extends Error {
  readonly code: "not-found";
  readonly httpStatus = 404;

  constructor() {
    super("Report not found.");
    this.name = "ReportQueryError";
    this.code = "not-found";
  }
}

export function reportQueryDependencies(): ReportQueryDependencies {
  return {
    now: () => new Date(),
    listReports: listWorkspaceReports,
    loadAccess: loadStoredReportAccess,
    loadReport: getStoredReport,
    loadMatchPage: loadStoredReportMatchPage,
    settle: settleTerminalReportReservation,
  };
}

export function customerReportPayload<T extends { run: Record<string, unknown> }>(report: T) {
  const run = { ...report.run };
  delete run.workspaceId;
  delete run.billingReservationId;
  return { ...report, run };
}

function accessIsOwnedAndCurrent(
  access: Awaited<ReturnType<typeof loadStoredReportAccess>>,
  workspaceId: string,
  now: Date,
) {
  return Boolean(
    access
    && workspaceId
    && access.workspaceId === workspaceId
    && access.expiresAt > now.toISOString(),
  );
}

export async function listWorkspaceReportSummaries(
  workspaceId: string,
  input: { limit?: number } = {},
  services: ReportQueryDependencies = reportQueryDependencies(),
): Promise<WorkspaceReportSummary[]> {
  if (!workspaceId) return [];
  return services.listReports(workspaceId, { limit: input.limit, now: services.now() });
}

export async function getWorkspaceReport(
  workspaceId: string,
  publicReportId: string,
  services: ReportQueryDependencies = reportQueryDependencies(),
): Promise<ReturnType<typeof customerReportPayload<StoredReportSnapshot>>> {
  const now = services.now();
  const access = await services.loadAccess(publicReportId);
  if (!accessIsOwnedAndCurrent(access, workspaceId, now)) throw new ReportQueryError();
  const report = await services.loadReport(publicReportId, now);
  if (!report || report.run.workspaceId !== workspaceId || report.run.expiresAt <= now.toISOString()) throw new ReportQueryError();
  await services.settle(report.run);
  return customerReportPayload(report);
}

export async function getWorkspaceReportMatches(
  workspaceId: string,
  publicReportId: string,
  input: { cursor?: string; limit?: number } = {},
  services: ReportQueryDependencies = reportQueryDependencies(),
): Promise<StoredReportMatchPage> {
  const now = services.now();
  const access = await services.loadAccess(publicReportId);
  if (!accessIsOwnedAndCurrent(access, workspaceId, now)) throw new ReportQueryError();
  return services.loadMatchPage(publicReportId, input);
}
