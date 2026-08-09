import { auth, tasks } from "@trigger.dev/sdk";

import type { marketSignalReportEvaluation } from "../../src/trigger/report-evaluation.ts";
import { REPORT_EVALUATION_TASK_ID, type ReportEvaluationPayload } from "../../src/shared/report-evaluation-contract.ts";
import { runtimeEnvironmentValue } from "./runtime-env.ts";

export const REPORT_EVALUATION_DISPATCH_TTL = "90d" as const;

type TriggerHandle = { id: string };
type TriggerEvaluation = (payload: ReportEvaluationPayload, options: { idempotencyKey: string; idempotencyKeyTTL: string; tags: string[] }) => Promise<TriggerHandle>;

export function reportEvaluationDispatchKey(payload: ReportEvaluationPayload) {
  return `evaluation:${payload.evaluationId}:${payload.evaluatorVersion}:dispatch:${payload.dispatchAttempt}`;
}

type EvaluationPilotOverrides = { enabled?: string; domains?: string };

function pilotDomains(value: string) {
  return [...new Set(value.split(",").map((domain) => domain.trim().toLowerCase()).filter((domain) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)))];
}

export async function reportEvaluationPilotEnabled(primaryDomain?: string, overrides: EvaluationPilotOverrides = {}) {
  const enabled = overrides.enabled ?? await runtimeEnvironmentValue("MARKET_SIGNAL_EVALUATION_PILOT_ENABLED");
  if (enabled !== "true") return false;
  const rawDomains = overrides.domains ?? await runtimeEnvironmentValue("MARKET_SIGNAL_EVALUATION_PILOT_DOMAINS");
  if (rawDomains.trim() === "__all__") return true;
  if (!rawDomains.trim()) return false;
  const domains = pilotDomains(rawDomains);
  if (!domains.length) return false;
  return typeof primaryDomain === "string" && domains.includes(primaryDomain.trim().toLowerCase());
}

export async function dispatchReportEvaluation(payload: ReportEvaluationPayload, options: { secret?: string; trigger?: TriggerEvaluation } = {}) {
  const secret = await runtimeEnvironmentValue("TRIGGER_SECRET_KEY", options.secret);
  if (!options.trigger && !/^tr_(?:prod|dev)_[A-Za-z0-9_-]+$/.test(secret)) throw new Error("The report evaluation dispatcher is not configured.");
  const triggerOptions = { idempotencyKey: reportEvaluationDispatchKey(payload), idempotencyKeyTTL: REPORT_EVALUATION_DISPATCH_TTL, tags: [`evaluation:${payload.evaluationId}`] };
  const handle = options.trigger
    ? await options.trigger(payload, triggerOptions)
    : await auth.withAuth({ accessToken: secret }, () => tasks.trigger<typeof marketSignalReportEvaluation>(REPORT_EVALUATION_TASK_ID, payload, triggerOptions));
  if (!handle || typeof handle.id !== "string" || !/^run_[A-Za-z0-9]+$/.test(handle.id)) throw new Error("The report evaluation dispatch failed.");
  return { runId: handle.id, idempotencyKey: triggerOptions.idempotencyKey };
}
