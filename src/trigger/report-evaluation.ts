import { AbortTaskRunError, schedules, task, tasks } from "@trigger.dev/sdk";

import {
  REPORT_EVALUATION_IDEMPOTENCY_TTL,
  REPORT_EVALUATION_TASK_ID,
  ReportEvaluationContractError,
  type ReportEvaluationPayload,
} from "../shared/report-evaluation-contract.ts";
import { evaluateReport, recoverReportEvaluations } from "./report-evaluation-core.ts";
import { createReportEvaluationDispatchHttpPort, createReportEvaluationHttpPort } from "./report-evaluation-http.ts";

function applicationConfiguration() {
  return {
    appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "",
    evaluationToken: process.env.MARKET_SIGNAL_EVALUATION_TOKEN || "",
  };
}

export const marketSignalReportEvaluation = task({
  id: REPORT_EVALUATION_TASK_ID,
  maxDuration: 300,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 20_000,
    factor: 2,
    randomize: true,
  },
  queue: { name: "market-signal-report-evaluations", concurrencyLimit: 2 },
  run: async (payload: ReportEvaluationPayload) => {
    try {
      return await evaluateReport(payload, createReportEvaluationHttpPort({
        ...applicationConfiguration(),
        openaiApiKey: process.env.OPENAI_API_KEY || "",
      }));
    } catch (error) {
      if (error instanceof ReportEvaluationContractError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});

export const marketSignalReportEvaluationRecovery = schedules.task({
  id: "market-signal-report-evaluation-recovery",
  cron: "*/15 * * * *",
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  queue: { name: "market-signal-report-evaluation-recovery", concurrencyLimit: 1 },
  run: async () => recoverReportEvaluations(
    process.env.MARKET_SIGNAL_EVALUATION_DISPATCH_ENABLED === "true",
    createReportEvaluationDispatchHttpPort(applicationConfiguration()),
    {
      trigger: (payload, options) => tasks.trigger(REPORT_EVALUATION_TASK_ID, payload, {
        idempotencyKey: options.idempotencyKey,
        idempotencyKeyTTL: options.idempotencyKeyTTL || REPORT_EVALUATION_IDEMPOTENCY_TTL,
      }),
    },
  ),
});
