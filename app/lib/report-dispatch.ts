import { auth, tasks } from "@trigger.dev/sdk";
import type { marketSignalReportOrchestration } from "../../src/trigger/report-orchestration.ts";
import { REPORT_ORCHESTRATION_CONTRACT_VERSION, type ReportOrchestrationPayload } from "../../src/shared/report-orchestration-contract.ts";
import { runtimeEnvironmentValue } from "./runtime-env.ts";
import type { ProductPlan } from "./product-entitlements.ts";

export const REPORT_TASK_ID = "market-signal-report-orchestration" as const;
export const REPORT_DISPATCH_IDEMPOTENCY_TTL = "24h" as const;

export type DispatchableReport = {
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  attemptCount: number;
  productPlan?: ProductPlan;
  productLimit?: number;
};

type TriggerHandle = { id: string };
type TriggerReport = (payload: ReportOrchestrationPayload, options: { idempotencyKey: string; idempotencyKeyTTL: string; tags: string[] }) => Promise<TriggerHandle>;

export function reportDispatchIdempotencyKey(report: Pick<DispatchableReport, "publicId" | "attemptCount">) {
  return `${report.publicId}:${REPORT_ORCHESTRATION_CONTRACT_VERSION}:${report.attemptCount}`;
}

export class ReportDispatchError extends Error {
  readonly code: "trigger-secret-unavailable" | "trigger-request-failed";

  constructor(code: ReportDispatchError["code"]) {
    super("The background report job could not be started.");
    this.name = "ReportDispatchError";
    this.code = code;
  }
}

function publicDispatchError(code: ReportDispatchError["code"]) {
  return new ReportDispatchError(code);
}

export async function dispatchReportJob(report: DispatchableReport, options: { secret?: string; trigger?: TriggerReport } = {}) {
  const secret = await runtimeEnvironmentValue("TRIGGER_SECRET_KEY", options.secret);
  if (!options.trigger && !/^tr_(?:prod|dev)_[A-Za-z0-9_-]+$/.test(secret)) throw publicDispatchError("trigger-secret-unavailable");
  const payload: ReportOrchestrationPayload = {
    contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION,
    publicId: report.publicId,
    primaryDomain: report.primaryDomain,
    locale: report.locale,
    reportAttempt: report.attemptCount,
    productPlan: report.productPlan || "starter",
    productLimit: report.productLimit || 20,
  };
  const triggerOptions = {
    idempotencyKey: reportDispatchIdempotencyKey(report),
    idempotencyKeyTTL: REPORT_DISPATCH_IDEMPOTENCY_TTL,
    tags: [`report:${report.publicId}`],
  };
  try {
    const handle = options.trigger
      ? await options.trigger(payload, triggerOptions)
      : await auth.withAuth({ accessToken: secret }, () => tasks.trigger<typeof marketSignalReportOrchestration>(REPORT_TASK_ID, payload, triggerOptions));
    if (!handle || typeof handle.id !== "string" || !/^run_[A-Za-z0-9]+$/.test(handle.id)) throw publicDispatchError("trigger-request-failed");
    return { runId: handle.id, idempotencyKey: triggerOptions.idempotencyKey };
  } catch (error) {
    if (error instanceof ReportDispatchError) throw error;
    throw publicDispatchError("trigger-request-failed");
  }
}
