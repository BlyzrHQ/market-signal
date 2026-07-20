import { auth, tasks } from "@trigger.dev/sdk";
import type { marketSignalReportOrchestration } from "../../src/trigger/report-orchestration.ts";
import { REPORT_ORCHESTRATION_CONTRACT_VERSION, type ReportOrchestrationPayload } from "../../src/trigger/contracts/report-orchestration.ts";
import { runtimeEnvironmentValue } from "./runtime-env.ts";

export const REPORT_TASK_ID = "market-signal-report-orchestration" as const;
export const REPORT_DISPATCH_IDEMPOTENCY_TTL = "24h" as const;

export type DispatchableReport = {
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  attemptCount: number;
};

type TriggerHandle = { id: string };
type TriggerReport = (payload: ReportOrchestrationPayload, options: { idempotencyKey: string; idempotencyKeyTTL: string; tags: string[] }) => Promise<TriggerHandle>;

export function reportDispatchIdempotencyKey(report: Pick<DispatchableReport, "publicId" | "attemptCount">) {
  return `${report.publicId}:${REPORT_ORCHESTRATION_CONTRACT_VERSION}:${report.attemptCount}`;
}

function publicDispatchError() {
  return new Error("The background report job could not be started.");
}

export async function dispatchReportJob(report: DispatchableReport, options: { secret?: string; trigger?: TriggerReport } = {}) {
  const secret = await runtimeEnvironmentValue("TRIGGER_SECRET_KEY", options.secret);
  if (!options.trigger && !/^tr_(?:prod|dev)_[A-Za-z0-9_-]+$/.test(secret)) throw publicDispatchError();
  const payload: ReportOrchestrationPayload = {
    contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION,
    publicId: report.publicId,
    primaryDomain: report.primaryDomain,
    locale: report.locale,
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
    if (!handle || typeof handle.id !== "string" || !/^run_[A-Za-z0-9]+$/.test(handle.id)) throw publicDispatchError();
    return { runId: handle.id, idempotencyKey: triggerOptions.idempotencyKey };
  } catch {
    throw publicDispatchError();
  }
}
