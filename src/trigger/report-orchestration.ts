import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import { PermanentOrchestrationError, type ReportOrchestrationPayload } from "../shared/report-orchestration-contract.ts";
import { orchestrateReport } from "./report-orchestration-core.ts";
import { createReportOrchestrationHttpPort } from "./report-orchestration-http.ts";

// Ten 100-anchor attempts can truthfully cover the full 1,000-product catalog.
const MAX_ATTEMPTS = 10;

export const marketSignalReportOrchestration = task({
  id: "market-signal-report-orchestration",
  maxDuration: 14_700,
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
      return await orchestrateReport(payload, {
        attemptNumber: payload.reportAttempt,
        taskAttemptNumber: ctx.attempt.number,
        isFinalAttempt: ctx.attempt.number >= (ctx.run.maxAttempts || MAX_ATTEMPTS),
      }, port);
    } catch (error) {
      if (error instanceof PermanentOrchestrationError) throw new AbortTaskRunError(error.message);
      throw error;
    }
  },
});
