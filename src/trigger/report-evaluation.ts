import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import { REPORT_EVALUATION_TASK_ID, parseReportEvaluationPayload } from "../shared/report-evaluation-contract.ts";
import { runReportEvaluation } from "./report-evaluation-core.ts";
import { createReportEvaluationHttpPort } from "./report-evaluation-http.ts";

export const marketSignalReportEvaluation = task({
  id: REPORT_EVALUATION_TASK_ID,
  maxDuration: 150,
  retry: { maxAttempts: 1 },
  queue: { name: "market-signal-report-evaluations", concurrencyLimit: 4 },
  run: async (input: unknown) => {
    try {
      const payload = parseReportEvaluationPayload(input);
      const port = createReportEvaluationHttpPort({
        appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "",
        callbackToken: process.env.MARKET_SIGNAL_CALLBACK_TOKEN || "",
      });
      await port.preflight();
      return await runReportEvaluation(payload, port, { apiKey: process.env.OPENAI_API_KEY || "" });
    } catch (error) {
      throw new AbortTaskRunError(error instanceof Error ? error.message : "Report evaluation failed.");
    }
  },
});

