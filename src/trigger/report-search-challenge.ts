import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { REPORT_SEARCH_CHALLENGE_TASK_ID, parseReportSearchChallengePayload } from "../shared/report-search-challenge-contract.ts";
import { runReportSearchChallenge } from "./report-search-challenge-core.ts";
import { createReportSearchChallengeHttpPort } from "./report-search-challenge-http.ts";

export const marketSignalReportSearchChallenge = task({
  id: REPORT_SEARCH_CHALLENGE_TASK_ID,
  maxDuration: 180,
  retry: { maxAttempts: 1 },
  queue: { name: "market-signal-report-search-challenges", concurrencyLimit: 2 },
  run: async (input: unknown) => {
    try {
      const payload = parseReportSearchChallengePayload(input);
      const port = createReportSearchChallengeHttpPort({ appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "", callbackToken: process.env.MARKET_SIGNAL_CALLBACK_TOKEN || "" });
      await port.preflight();
      return await runReportSearchChallenge(payload, port, { apiKey: process.env.OPENAI_API_KEY || "" });
    } catch (error) { throw new AbortTaskRunError(error instanceof Error ? error.message : "Report search challenge failed."); }
  },
});
