export const MAX_RETENTION_PASSES = 40;

export type RetentionPassResult = {
  deleted: Record<string, number>;
  remaining: number;
};

export type RetentionPort = {
  preflight(): Promise<void>;
  purge(): Promise<RetentionPassResult>;
};

function addCounts(target: Record<string, number>, source: Record<string, number>) {
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isInteger(value) || value < 0) throw new Error("Retention returned invalid deletion counts.");
    target[key] = (target[key] || 0) + value;
  }
}

export async function runReportRetention(port: RetentionPort, log: (message: string, metadata: Record<string, unknown>) => void = console.log) {
  await port.preflight();
  const deleted: Record<string, number> = {};
  let remaining = 0;
  let passes = 0;
  for (; passes < MAX_RETENTION_PASSES; passes += 1) {
    const result = await port.purge();
    if (!Number.isInteger(result.remaining) || result.remaining < 0) throw new Error("Retention returned an invalid backlog count.");
    addCounts(deleted, result.deleted);
    remaining = result.remaining;
    log("market signal retention pass", { pass: passes + 1, deleted: result.deleted, remaining });
    if (remaining === 0) break;
  }
  const completedPasses = passes + (passes < MAX_RETENTION_PASSES ? 1 : 0);
  const output = { ok: remaining === 0, passes: completedPasses, deleted, remaining, capped: remaining > 0 };
  log("market signal retention complete", output);
  return output;
}
