import { schedules } from "@trigger.dev/sdk";

const REQUEST_TIMEOUT_MS = 120_000;

function configuration() {
  const origin = new URL(process.env.MARKET_SIGNAL_APP_ORIGIN || "");
  const token = process.env.MARKET_SIGNAL_CALLBACK_TOKEN || "";
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || token.length < 32 || /\s/.test(token)) throw new Error("Report evaluation recovery is not configured.");
  return { origin: origin.origin, token };
}

export const marketSignalReportEvaluationRecovery = schedules.task({
  id: "market-signal-report-evaluation-recovery",
  cron: "*/15 * * * *",
  maxDuration: 150,
  retry: { maxAttempts: 1 },
  queue: { name: "market-signal-report-evaluation-recovery", concurrencyLimit: 1 },
  run: async () => {
    const { origin, token } = configuration();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/api/internal/evaluations/recovery`, { method: "POST", signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")) throw new Error("Report evaluation recovery request failed.");
      const result = await response.json() as Record<string, unknown>;
      if (result.ok !== true) throw new Error("Report evaluation recovery was rejected.");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  },
});
