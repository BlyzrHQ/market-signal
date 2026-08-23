import { dispatchReportJob, ReportDispatchError } from "../../../lib/report-dispatch.ts";
import { hasValidOwnerAuthorization, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import {
  appendReportEvent,
  createReportRunResult,
  markReportDispatched,
  markReportDispatchFailed,
} from "../../../lib/report-store.ts";
import type { ProductPlan } from "../../../lib/product-entitlements.ts";

const MAX_BODY_BYTES = 512;
const PLAN_LIMITS: Record<ProductPlan, number> = {
  starter: 20,
  solo: 50,
  growth: 500,
  agency: 1_000,
};

type AcceptanceReportServices = {
  authorize(authorization: string | null): Promise<boolean>;
  create(input: { primaryDomain: string; locale: "en" | "ar"; entitlement: { plan: ProductPlan; productLimit: number } }): ReturnType<typeof createReportRunResult>;
  dispatch: typeof dispatchReportJob;
  markDispatched: typeof markReportDispatched;
  markDispatchFailed: typeof markReportDispatchFailed;
  append: typeof appendReportEvent;
};

const liveServices: AcceptanceReportServices = {
  authorize: (authorization) => hasValidOwnerAuthorization(authorization, "write"),
  create: (input) => createReportRunResult(input),
  dispatch: (report) => dispatchReportJob(report),
  markDispatched: (publicId, runId) => markReportDispatched(publicId, runId),
  markDispatchFailed: (publicId) => markReportDispatchFailed(publicId),
  append: (publicId, input) => appendReportEvent(publicId, input),
};

async function boundedJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("body-too-large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("body-too-large");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-body");
  return value as Record<string, unknown>;
}

export function createAcceptanceReportHandler(services: AcceptanceReportServices = liveServices) {
  return async function post(request: Request) {
    if (!await services.authorize(request.headers.get("authorization"))) return unauthorizedInternalResponse();

    let body: Record<string, unknown>;
    try {
      body = await boundedJson(request);
    } catch {
      return Response.json({ ok: false, error: "Invalid request." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const primaryDomain = typeof body.primaryDomain === "string" ? body.primaryDomain.trim() : "";
    const plan = typeof body.plan === "string" && Object.hasOwn(PLAN_LIMITS, body.plan) ? body.plan as ProductPlan : null;
    const locale = body.locale === "ar" ? "ar" : "en";
    if (!primaryDomain || !plan) {
      return Response.json({ ok: false, error: "A public domain and supported plan are required." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const creation = await services.create({
      primaryDomain,
      locale,
      entitlement: { plan, productLimit: PLAN_LIMITS[plan] },
    });
    if (!creation.ok) {
      const status = creation.diagnosticCode === "invalid-domain" ? 400 : 503;
      return Response.json({
        ok: false,
        error: status === 400 ? "A valid public domain is required." : "The acceptance report could not be created.",
        errorCode: status === 400 ? "invalid-domain" : "storage-create-failed",
      }, { status, headers: { "Cache-Control": "no-store" } });
    }

    const report = creation.report;
    try {
      await services.append(report.publicId, {
        phase: "queued",
        status: "queued",
        message: "An internal production-acceptance report was created.",
        metadata: { purpose: "production-acceptance", plan, productLimit: PLAN_LIMITS[plan], productTargetKind: "pairs" },
        idempotencyKey: `production-acceptance-created-attempt-${report.attemptCount}`,
        attemptNumber: report.attemptCount,
      });
    } catch {
      try { await services.markDispatchFailed(report.publicId); } catch { /* preserve the closed response */ }
      return Response.json({ ok: false, error: "The acceptance report audit event could not be stored.", errorCode: "audit-write-failed", publicId: report.publicId }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    let job: Awaited<ReturnType<typeof dispatchReportJob>>;
    try {
      job = await services.dispatch(report);
    } catch (error) {
      try { await services.markDispatchFailed(report.publicId); } catch { /* preserve the closed response */ }
      const errorCode = error instanceof ReportDispatchError ? error.code : "dispatch-failed";
      return Response.json({ ok: false, error: "The acceptance report could not be dispatched.", errorCode, publicId: report.publicId }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    try { await services.markDispatched(report.publicId, job.runId); } catch { /* accepted work remains live if telemetry races */ }
    return Response.json({
      ok: true,
      report: {
        publicId: report.publicId,
        primaryDomain: report.primaryDomain,
        plan: report.productPlan,
        comparisonTarget: report.productLimit,
        productTargetKind: "pairs",
        url: `/reports/${report.publicId}?view=products&layout=table`,
      },
      job: { runId: job.runId },
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  };
}

export const POST = createAcceptanceReportHandler();
