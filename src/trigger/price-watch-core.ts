export type PriceWatchScheduleResult = {
  ok: true;
  skipped?: "capability-unavailable";
  checks?: Record<string, number>;
  email?: { configured: boolean; delivered: number; pending: number };
};

export type PriceWatchSchedulePort = {
  preflight(): Promise<boolean>;
  runDue(): Promise<PriceWatchScheduleResult>;
};

export async function runPriceWatchSchedule(port: PriceWatchSchedulePort, log: (message: string, metadata: Record<string, unknown>) => void = console.log): Promise<PriceWatchScheduleResult> {
  const available = await port.preflight();
  if (!available) {
    const result = { ok: true as const, skipped: "capability-unavailable" as const };
    log("market signal price watch skipped", result);
    return result;
  }
  const result = await port.runDue();
  log("market signal price watch complete", result);
  return result;
}
