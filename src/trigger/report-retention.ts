import { schedules } from "@trigger.dev/sdk";

import { runReportRetention } from "./report-retention-core.ts";
import { createReportRetentionHttpPort } from "./report-retention-http.ts";

export const marketSignalReportRetention = schedules.task({
  id: "market-signal-report-retention",
  cron: "17 3 * * *",
  maxDuration: 120,
  retry: { maxAttempts: 3 },
  queue: { name: "market-signal-report-retention", concurrencyLimit: 1 },
  run: async () => runReportRetention(createReportRetentionHttpPort({
    appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "",
    callbackToken: process.env.MARKET_SIGNAL_CALLBACK_TOKEN || "",
  })),
});
