import { dispatchReportJob, ReportDispatchError } from "../../lib/report-dispatch.ts";
import { createReportRunResult, markReportDispatched, markReportDispatchFailed, reportStorageDiagnosticCode, type ReportCreateDiagnostic } from "../../lib/report-store.ts";

type CreatedReport = {
  id: string;
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  status: "queued";
  currentPhase: "queued";
  attemptCount: number;
  createdAt: string;
  expiresAt: string;
};

type CreationBoundaryDiagnostic = "create-not-callable" | "create-rejected" | "create-malformed" | "create-access-failed";
type CreationBoundaryResult =
  | { kind: "accepted"; report: CreatedReport }
  | { kind: "rejected"; diagnosticCode: ReportCreateDiagnostic }
  | { kind: "boundary-failed"; diagnosticCode: CreationBoundaryDiagnostic };

const PUBLIC_REPORT_ID = /^[a-f0-9]{32}$/;
const REPORT_CREATE_DIAGNOSTIC = /^(?:invalid-domain|storage-unavailable|database-(?:import-failed|binding-missing)|schema-statement-(?:[1-9]|1\d|2\d)-failed|run-create-batch-(?:schema-mismatch|constraint|binding-count|transaction|batch-api)|run-create-unclassified)$/;

async function consumeReportCreation(create: unknown, input: { primaryDomain: string; locale: "en" | "ar" }): Promise<CreationBoundaryResult> {
  if (typeof create !== "function") return { kind: "boundary-failed", diagnosticCode: "create-not-callable" };

  let value: unknown;
  try {
    value = await create(input);
  } catch {
    return { kind: "boundary-failed", diagnosticCode: "create-rejected" };
  }

  if (!value || typeof value !== "object") return { kind: "boundary-failed", diagnosticCode: "create-malformed" };

  let ok: unknown;
  try {
    ok = (value as { ok?: unknown }).ok;
  } catch {
    return { kind: "boundary-failed", diagnosticCode: "create-access-failed" };
  }
  if (ok !== true && ok !== false) return { kind: "boundary-failed", diagnosticCode: "create-malformed" };

  if (!ok) {
    try {
      const candidate = (value as { diagnosticCode?: unknown }).diagnosticCode;
      const diagnosticCode = typeof candidate === "string" && REPORT_CREATE_DIAGNOSTIC.test(candidate)
        ? candidate as ReportCreateDiagnostic
        : "run-create-unclassified";
      return { kind: "rejected", diagnosticCode };
    } catch {
      return { kind: "boundary-failed", diagnosticCode: "create-access-failed" };
    }
  }

  try {
    const report = (value as { report?: Record<string, unknown> }).report;
    if (!report || typeof report !== "object"
      || typeof report.id !== "string" || !report.id
      || typeof report.publicId !== "string" || !PUBLIC_REPORT_ID.test(report.publicId)
      || typeof report.primaryDomain !== "string" || !report.primaryDomain
      || (report.locale !== "en" && report.locale !== "ar")
      || report.status !== "queued"
      || report.currentPhase !== "queued"
      || typeof report.attemptCount !== "number" || !Number.isInteger(report.attemptCount) || report.attemptCount < 1
      || typeof report.createdAt !== "string" || !report.createdAt
      || typeof report.expiresAt !== "string" || !report.expiresAt) {
      return { kind: "boundary-failed", diagnosticCode: "create-access-failed" };
    }
    return {
      kind: "accepted",
      report: {
        id: report.id,
        publicId: report.publicId,
        primaryDomain: report.primaryDomain,
        locale: report.locale,
        status: report.status,
        currentPhase: report.currentPhase,
        attemptCount: report.attemptCount,
        createdAt: report.createdAt,
        expiresAt: report.expiresAt,
      },
    };
  } catch {
    return { kind: "boundary-failed", diagnosticCode: "create-access-failed" };
  }
}

type ReportCreationDependencies = {
  create: unknown;
  dispatch: typeof dispatchReportJob;
  markDispatched: typeof markReportDispatched;
  markDispatchFailed: typeof markReportDispatchFailed;
};

function defaultDependencies(): ReportCreationDependencies {
  return {
    create: (input: { primaryDomain: string; locale?: "en" | "ar" }) => createReportRunResult(input),
    dispatch: (report) => dispatchReportJob(report),
    markDispatched: (publicId, runId) => markReportDispatched(publicId, runId),
    markDispatchFailed: (publicId) => markReportDispatchFailed(publicId),
  };
}

export async function createPersistentReport(request: Request, services: ReportCreationDependencies = defaultDependencies()) {
  let publicId = "";
  let stage: "request" | "storage-create" | "dispatch" | "dispatch-telemetry" = "request";
  try {
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown };
    stage = "storage-create";
    const creation = await consumeReportCreation(services.create, {
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
    });
    if (creation.kind !== "accepted") {
      if (creation.kind === "boundary-failed") {
        console.error("report creation failed", { stage: "storage-create", diagnosticCode: creation.diagnosticCode });
        return Response.json({ ok: false, error: "The persistent report could not be created.", errorCode: "storage-create-failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      const status = creation.diagnosticCode === "invalid-domain" ? 400 : 503;
      if (status === 503) console.error("report creation failed", { stage: "storage-create", diagnosticCode: creation.diagnosticCode });
      return Response.json({ ok: false, error: status === 400 ? "A valid public domain is required." : "The persistent report could not be created.", errorCode: status === 400 ? "invalid-domain" : "storage-create-failed" }, { status, headers: { "Cache-Control": "no-store" } });
    }
    const report = creation.report;
    publicId = report.publicId;
    let job: Awaited<ReturnType<typeof dispatchReportJob>>;
    try {
      stage = "dispatch";
      job = await services.dispatch(report);
    } catch (error) {
      const diagnosticCode = error instanceof ReportDispatchError ? error.code : "dispatch-failed";
      console.error("report job dispatch failed", { stage, diagnosticCode });
      try { await services.markDispatchFailed(report.publicId); } catch { /* the dispatch response still fails closed */ }
      return Response.json({ ok: false, error: "The background report job could not be started.", errorCode: "dispatch-failed", publicId: report.publicId }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    stage = "dispatch-telemetry";
    try { await services.markDispatched(report.publicId, job.runId); } catch { /* accepted work remains live even if dispatch telemetry races or is temporarily unavailable */ }
    return Response.json({ ok: true, report, job: { dispatched: true, runId: job.runId } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The persistent report could not be created.";
    const status = /valid public domain/i.test(message) ? 400 : 503;
    const publicMessage = status === 400 ? message : "The persistent report could not be created.";
    const errorCode = status === 400 ? "invalid-domain" : stage === "storage-create" ? "storage-create-failed" : "report-create-failed";
    if (status === 503) console.error("report creation failed", { stage, diagnosticCode: reportStorageDiagnosticCode(error) || (/storage is unavailable/i.test(message) ? "storage-unavailable" : "storage-operation-failed") });
    return Response.json({ ok: false, error: publicMessage, errorCode, ...(publicId ? { publicId } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  return createPersistentReport(request);
}
