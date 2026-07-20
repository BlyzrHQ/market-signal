import { task } from "@trigger.dev/sdk";

import { createHealthcheckOutput, type HealthcheckPayload } from "./contracts/healthcheck.ts";

export const marketSignalHealthcheck = task({
  id: "market-signal-healthcheck",
  maxDuration: 60,
  retry: {
    maxAttempts: 1,
  },
  queue: {
    name: "market-signal-healthcheck",
    concurrencyLimit: 1,
  },
  run: async (payload: HealthcheckPayload) => createHealthcheckOutput(payload),
});
