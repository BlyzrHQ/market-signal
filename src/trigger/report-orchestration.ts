import { AbortTaskRunError, task, tasks } from "@trigger.dev/sdk";

import { PermanentOrchestrationError, type ReportOrchestrationPayload } from "../shared/report-orchestration-contract.ts";
import { orchestrateReport } from "./report-orchestration-core.ts";
import { createReportOrchestrationHttpPort } from "./report-orchestration-http.ts";
import { REPORT_EVALUATION_TASK_ID } from "../shared/report-evaluation-contract.ts";
import { dispatchClaimedEvaluations } from "./report-evaluation-core.ts";
import { createReportEvaluationDispatchHttpPort } from "./report-evaluation-http.ts";

const MAX_ATTEMPTS = 2;

export const marketSignalReportOrchestration = task({
  id: "market-signal-report-orchestration",
  maxDuration: 900,
  retry: {
    maxAttempts: MAX_ATTEMPTS,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 20_000,
    factor: 2,
    randomize: true,
  },
  queue: {
    name: "market-signal-reports",
    concurrencyLimit: 4,
  },
  run: async (payload: ReportOrchestrationPayload, { ctx }) => {
    try {
      const port = createReportOrchestrationHttpPort({
        appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "",
        callbackToken: process.env.MARKET_SIGNAL_CALLBACK_TOKEN || "",
      });
      const result = await orchestrateReport(payload, {
        attemptNumber: payload.reportAttempt,
        taskAttemptNumber: ctx.attempt.number,
        isFinalAttempt: ctx.attempt.number >= (ctx.run.maxAttempts || MAX_ATTEMPTS),
      }, port);
      if (result.evaluation && process.env.MARKET_SIGNAL_EVALUATION_DISPATCH_ENABLED === "true") {
        try {
          await dispatchClaimedEvaluations(true, createReportEvaluationDispatchHttpPort({
            appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "",
            evaluationToken: process.env.MARKET_SIGNAL_EVALUATION_TOKEN || "",
          }), {
            trigger: (evaluation, options) => tasks.trigger(REPORT_EVALUATION_TASK_ID, evaluation, {
              idempotencyKey: options.idempotencyKey,
              idempotencyKeyTTL: options.idempotencyKeyTTL,
            }),
          }, { evaluationId: result.evaluation.id, limit: 1 });
        } catch (error) {
          console.error("report evaluation dispatch deferred to recovery", { evaluationId: result.evaluation.id, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      return result;
    } catch (error) {
      if (error instanceof PermanentOrchestrationError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
