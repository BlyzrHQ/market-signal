import { auth, tasks } from "@trigger.dev/sdk";
import type { marketSignalReportSearchChallenge } from "../../src/trigger/report-search-challenge.ts";
import { REPORT_SEARCH_CHALLENGE_TASK_ID, type ReportSearchChallengePayload } from "../../src/shared/report-search-challenge-contract.ts";
import { runtimeEnvironmentValue } from "./runtime-env.ts";

export async function reportSearchChallengeEnabled(override?: string) { return (override ?? await runtimeEnvironmentValue("MARKET_SIGNAL_SEARCH_CHALLENGER_ENABLED")) === "true"; }
export function reportSearchChallengeDispatchKey(payload: ReportSearchChallengePayload) { return `search-challenge:${payload.challengeId}:${payload.challengerVersion}:dispatch:${payload.dispatchAttempt}`; }
export async function dispatchReportSearchChallenge(payload: ReportSearchChallengePayload, options: { secret?: string; trigger?: (payload: ReportSearchChallengePayload, options: { idempotencyKey: string; idempotencyKeyTTL: "90d"; tags: string[] }) => Promise<{ id: string }> } = {}) {
  const secret = await runtimeEnvironmentValue("TRIGGER_SECRET_KEY", options.secret);
  if (!options.trigger && !/^tr_(?:prod|dev)_[A-Za-z0-9_-]+$/.test(secret)) throw new Error("The report search challenge dispatcher is not configured.");
  const triggerOptions = { idempotencyKey: reportSearchChallengeDispatchKey(payload), idempotencyKeyTTL: "90d" as const, tags: [`search-challenge:${payload.challengeId}`] };
  const handle = options.trigger ? await options.trigger(payload, triggerOptions) : await auth.withAuth({ accessToken: secret }, () => tasks.trigger<typeof marketSignalReportSearchChallenge>(REPORT_SEARCH_CHALLENGE_TASK_ID, payload, triggerOptions));
  if (!handle || typeof handle.id !== "string" || !/^run_[A-Za-z0-9]+$/.test(handle.id)) throw new Error("The report search challenge dispatch failed.");
  return { runId: handle.id, idempotencyKey: triggerOptions.idempotencyKey };
}
