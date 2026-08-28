import { hostedBillingEnabled } from "./billing-plans.ts";
import {
  finishReportReservation,
  openBillingDatabase,
  reserveReport,
  type ReportReservation,
} from "./billing-store.ts";
import { dispatchReportJob, ReportDispatchError } from "./report-dispatch.ts";
import { resolveProductEntitlement, type ProductPlan } from "./product-entitlements.ts";
import {
  createReportRunResult,
  markReportDispatched,
  markReportDispatchFailed,
  reportStorageDiagnosticCode,
  type ReportCreateDiagnostic,
} from "./report-store.ts";
import { runtimeEnvironmentValue } from "./runtime-env.ts";

export type CreatedReport = {
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
  productTargetKind: "pairs";
};

type CreationBoundaryDiagnostic = "create-not-callable" | "create-rejected" | "create-malformed" | "create-access-failed";
type CreationBoundaryResult =
  | { kind: "accepted"; report: CreatedReport }
  | { kind: "rejected"; diagnosticCode: ReportCreateDiagnostic }
  | { kind: "boundary-failed"; diagnosticCode: CreationBoundaryDiagnostic };

export type ReportCommandActor = {
  workspaceId: string;
  userId: string;
};

export type ReportCommandInput = {
  primaryDomain: string;
  locale: "en" | "ar";
  actor?: ReportCommandActor;
};

export type ReportCommandDependencies = {
  create: unknown;
  dispatch: typeof dispatchReportJob;
  markDispatched: typeof markReportDispatched;
  markDispatchFailed: typeof markReportDispatchFailed;
  reserve?: (workspaceId: string) => Promise<ReportReservation | null>;
  finishReservation?: (reservationId: string, outcome: "committed" | "released", runId?: string) => Promise<void>;
};

export type ReportCommandFailure = {
  ok: false;
  status: 400 | 402 | 429 | 503;
  error: string;
  errorCode: "invalid-domain" | "subscription-required" | "report-limit-reached" | "storage-create-failed" | "dispatch-failed" | "report-create-failed";
  publicId?: string;
  usage?: { used: number; limit: number };
  diagnosticCode?: string;
  stage: "reservation" | "storage-create" | "dispatch" | "request";
};

export type ReportCommandResult =
  | { ok: true; report: CreatedReport; job: { dispatched: true; runId: string } }
  | ReportCommandFailure;

export type PublicReportCommandFailure = Omit<ReportCommandFailure, "status" | "diagnosticCode" | "stage">;

export function publicReportCommandFailure(result: ReportCommandFailure): PublicReportCommandFailure {
  return {
    ok: false,
    error: result.error,
    errorCode: result.errorCode,
    ...(result.publicId ? { publicId: result.publicId } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

const PUBLIC_REPORT_ID = /^[a-f0-9]{32}$/;
const REPORT_CREATE_DIAGNOSTIC = /^(?:invalid-domain|storage-unavailable|database-(?:import-failed|binding-missing)|schema-statement-[1-9]\d?-failed|run-create-batch-(?:schema-mismatch|constraint|binding-count|transaction|batch-api)|run-create-unclassified)$/;

async function consumeReportCreation(
  create: unknown,
  input: {
    primaryDomain: string;
    locale: "en" | "ar";
    entitlement?: { plan: ProductPlan; productLimit: number };
    workspaceId?: string;
    billingReservationId?: string;
  },
): Promise<CreationBoundaryResult> {
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
        productTargetKind: "pairs",
      },
    };
  } catch {
    return { kind: "boundary-failed", diagnosticCode: "create-access-failed" };
  }
}

export function reportCommandDependencies(environment: Record<string, string | undefined> = process.env): ReportCommandDependencies {
  const dependencies: ReportCommandDependencies = {
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

async function safelyReleaseReservation(services: ReportCommandDependencies, reservationId: string) {
  if (!reservationId || !services.finishReservation) return;
  try { await services.finishReservation(reservationId, "released"); } catch { /* preserve the original closed result */ }
}

export async function createReportCommand(input: ReportCommandInput, services: ReportCommandDependencies = reportCommandDependencies()): Promise<ReportCommandResult> {
  let reservation: ReportReservation | null = null;
  let reservationId = "";
  let publicId = "";
  try {
    if (input.actor) {
      reservation = services.reserve ? await services.reserve(input.actor.workspaceId) : null;
      if (!reservation) {
        return { ok: false, status: 402, error: "An active paid plan is required to create a report.", errorCode: "subscription-required", stage: "reservation" };
      }
      if (!reservation.id) {
        return {
          ok: false,
          status: 429,
          error: `Your ${reservation.plan.name} plan has used all ${reservation.limit} reports for this billing period.`,
          errorCode: "report-limit-reached",
          usage: { used: reservation.used, limit: reservation.limit },
          stage: "reservation",
        };
      }
      reservationId = reservation.id;
    }

    const creation = await consumeReportCreation(services.create, {
      primaryDomain: input.primaryDomain,
      locale: input.locale,
      ...(input.actor && reservation ? {
        workspaceId: input.actor.workspaceId,
        billingReservationId: reservation.id,
        entitlement: { plan: reservation.plan.id, productLimit: reservation.plan.productLimit },
      } : {}),
    });
    if (creation.kind !== "accepted") {
      await safelyReleaseReservation(services, reservationId);
      const diagnosticCode = creation.diagnosticCode;
      if (creation.kind === "rejected" && diagnosticCode === "invalid-domain") {
        return { ok: false, status: 400, error: "A valid public domain is required.", errorCode: "invalid-domain", diagnosticCode, stage: "storage-create" };
      }
      return { ok: false, status: 503, error: "The persistent report could not be created.", errorCode: "storage-create-failed", diagnosticCode, stage: "storage-create" };
    }

    const report = creation.report;
    publicId = report.publicId;
    let job: Awaited<ReturnType<typeof dispatchReportJob>>;
    try {
      job = await services.dispatch(report);
    } catch (error) {
      const diagnosticCode = error instanceof ReportDispatchError ? error.code : "dispatch-failed";
      try { await services.markDispatchFailed(report.publicId); } catch { /* the command still fails closed */ }
      await safelyReleaseReservation(services, reservationId);
      return { ok: false, status: 503, error: "The background report job could not be started.", errorCode: "dispatch-failed", publicId, diagnosticCode, stage: "dispatch" };
    }

    try { await services.markDispatched(report.publicId, job.runId); } catch { /* accepted work remains live if telemetry races */ }
    return { ok: true, report, job: { dispatched: true, runId: job.runId } };
  } catch (error) {
    await safelyReleaseReservation(services, reservationId);
    const message = error instanceof Error ? error.message : "The persistent report could not be created.";
    if (/valid public domain/i.test(message)) {
      return { ok: false, status: 400, error: message, errorCode: "invalid-domain", diagnosticCode: "invalid-domain", stage: "request" };
    }
    return {
      ok: false,
      status: 503,
      error: "The persistent report could not be created.",
      errorCode: "report-create-failed",
      ...(publicId ? { publicId } : {}),
      diagnosticCode: reportStorageDiagnosticCode(error) || (/storage is unavailable/i.test(message) ? "storage-unavailable" : "storage-operation-failed"),
      stage: "request",
    };
  }
}
