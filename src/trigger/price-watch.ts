import { schedules } from "@trigger.dev/sdk";
import { runPriceWatchSchedule } from "./price-watch-core.ts";
import { createPriceWatchHttpPort } from "./price-watch-http.ts";

export const marketSignalPriceWatch = schedules.task({
  id: "market-signal-price-watch",
  cron: "*/5 * * * *",
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  queue: { name: "market-signal-price-watch", concurrencyLimit: 1 },
  run: async () => runPriceWatchSchedule(createPriceWatchHttpPort({
    appOrigin: process.env.MARKET_SIGNAL_APP_ORIGIN || "",
    callbackToken: process.env.MARKET_SIGNAL_CALLBACK_TOKEN || "",
  })),
});
