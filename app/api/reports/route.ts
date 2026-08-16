import { dispatchReportJob, ReportDispatchError } from "../../lib/report-dispatch.ts";
import { createReportRunResult, markReportDispatched, markReportDispatchFailed, reportStorageDiagnosticCode, type ReportCreateDiagnostic } from "../../lib/report-store.ts";
import { resolveProductEntitlement, type ProductPlan } from "../../lib/product-entitlements.ts";
import { accountContext, type AccountContext } from "../../lib/account-auth.ts";
import { finishReportReservation, openBillingDatabase, reserveReport, type ReportReservation } from "../../lib/billing-store.ts";
import { hostedBillingEnabled } from "../../lib/billing-plans.ts";
import { runtimeEnvironmentValue } from "../../lib/runtime-env.ts";

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
  productPlan: ProductPlan;
  productLimit: number;
};

type CreationBoundaryDiagnostic = "create-not-callable" | "create-rejected" | "create-malformed" | "create-access-failed";
type CreationBoundaryResult =
  | { kind: "accepted"; report: CreatedReport }
  | { kind: "rejected"; diagnosticCode: ReportCreateDiagnostic }
  | { kind: "boundary-failed"; diagnosticCode: CreationBoundaryDiagnostic };

const PUBLIC_REPORT_ID = /^[a-f0-9]{32}$/;
const REPORT_CREATE_DIAGNOSTIC = /^(?:invalid-domain|storage-unavailable|database-(?:import-failed|binding-missing)|schema-statement-[1-9]\d?-failed|run-create-batch-(?:schema-mismatch|constraint|binding-count|transaction|batch-api)|run-create-unclassified)$/;

async function consumeReportCreation(create: unknown, input: { primaryDomain: string; locale: "en" | "ar"; entitlement?: { plan: ProductPlan; productLimit: number }; workspaceId?: string; billingReservationId?: string }): Promise<CreationBoundaryResult> {
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
        productPlan: ["starter", "solo", "growth", "agency"].includes(String(report.productPlan)) ? report.productPlan as ProductPlan : "starter",
        productLimit: Number.isInteger(report.productLimit) && Number(report.productLimit) > 0 && Number(report.productLimit) <= 1_000 ? Number(report.productLimit) : 20,
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
  authorize?: (request: Request) => Promise<AccountContext | null>;
  reserve?: (workspaceId: string) => Promise<ReportReservation | null>;
  finishReservation?: (reservationId: string, outcome: "committed" | "released", runId?: string) => Promise<void>;
};

export function reportCreationDependencies(environment: Record<string, string | undefined> = process.env): ReportCreationDependencies {
  const dependencies: ReportCreationDependencies = {
    create: async (input: { primaryDomain: string; locale?: "en" | "ar"; entitlement?: { plan: ProductPlan; productLimit: number }; workspaceId?: string; billingReservationId?: string }) => createReportRunResult({
      ...input,
      entitlement: input.entitlement || resolveProductEntitlement(input.primaryDomain, {
        defaultPlan: environment.MARKET_SIGNAL_DEFAULT_PLAN || await runtimeEnvironmentValue("MARKET_SIGNAL_DEFAULT_PLAN"),
        registryJson: environment.MARKET_SIGNAL_PLAN_REGISTRY_JSON || await runtimeEnvironmentValue("MARKET_SIGNAL_PLAN_REGISTRY_JSON"),
      }),
    }),
    dispatch: (report) => dispatchReportJob(report),
    markDispatched: (publicId, runId) => markReportDispatched(publicId, runId),
    markDispatchFailed: (publicId) => markReportDispatchFailed(publicId),
  };
  if (!hostedBillingEnabled(environment)) return dependencies;
  return {
    ...dependencies,
    authorize: (request) => accountContext(request),
    reserve: async (workspaceId) => {
      const database = await openBillingDatabase();
      try { return reserveReport(database, workspaceId); } finally { database.close(); }
    },
    finishReservation: async (reservationId, outcome, runId = "") => {
      const database = await openBillingDatabase();
      try { finishReportReservation(database, reservationId, outcome, runId); } finally { database.close(); }
    },
  };
}

export async function createPersistentReport(request: Request, services: ReportCreationDependencies = reportCreationDependencies()) {
  let publicId = "";
  let reservationId = "";
  let stage: "request" | "storage-create" | "dispatch" | "dispatch-telemetry" = "request";
  try {
    let account: AccountContext | null = null;
    let reservation: ReportReservation | null = null;
    if (services.authorize) {
      account = await services.authorize(request);
      if (!account) return Response.json({ ok: false, error: "Sign in to create a report.", errorCode: "authentication-required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      reservation = services.reserve ? await services.reserve(account.workspaceId) : null;
      if (!reservation) return Response.json({ ok: false, error: "An active paid plan is required to create a report.", errorCode: "subscription-required" }, { status: 402, headers: { "Cache-Control": "no-store" } });
      if (!reservation.id) return Response.json({ ok: false, error: `Your ${reservation.plan.name} plan has used all ${reservation.limit} reports for this billing period.`, errorCode: "report-limit-reached", usage: { used: reservation.used, limit: reservation.limit } }, { status: 429, headers: { "Cache-Control": "no-store" } });
      reservationId = reservation.id;
    }
    const body = await request.json() as { primaryDomain?: unknown; locale?: unknown };
    stage = "storage-create";
    const creation = await consumeReportCreation(services.create, {
      primaryDomain: typeof body.primaryDomain === "string" ? body.primaryDomain : "",
      locale: body.locale === "ar" ? "ar" : "en",
      ...(account && reservation ? {
        workspaceId: account.workspaceId,
        billingReservationId: reservation.id,
        entitlement: { plan: reservation.plan.id, productLimit: reservation.plan.productLimit },
      } : {}),
    });
    if (creation.kind !== "accepted") {
      if (reservationId && services.finishReservation) await services.finishReservation(reservationId, "released");
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
      if (reservationId && services.finishReservation) await services.finishReservation(reservationId, "released");
      return Response.json({ ok: false, error: "The background report job could not be started.", errorCode: "dispatch-failed", publicId: report.publicId }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    stage = "dispatch-telemetry";
    try { await services.markDispatched(report.publicId, job.runId); } catch { /* accepted work remains live even if dispatch telemetry races or is temporarily unavailable */ }
    return Response.json({ ok: true, report, job: { dispatched: true, runId: job.runId } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (reservationId && services.finishReservation) {
      try { await services.finishReservation(reservationId, "released"); } catch { /* preserve the original closed response */ }
    }
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
