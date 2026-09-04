import { task } from "@trigger.dev/sdk";
import { capabilities, runDirectCrawl, runDirectReport } from "./core.ts";
import { directDependencies } from "./runtime.ts";

const settings = { maxDuration: 3600, retry: { maxAttempts: 1 }, queue: { name: "market-signal-direct", concurrencyLimit: 2 } };
function boundedOutput<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8 * 1024 * 1024) throw new Error("OUTPUT_TOO_LARGE: select a smaller target; no automatic rerun");
  return value;
}
export const directCapabilities = task({ id: "market-signal-direct-capabilities", ...settings, maxDuration: 30,
  run: async () => capabilities(directDependencies.searchConfigured()) });
export const directCrawl = task({ id: "market-signal-direct-crawl", ...settings,
  run: async (payload: unknown) => boundedOutput(await runDirectCrawl(payload, directDependencies)) });
export const directCompare = task({ id: "market-signal-direct-compare", ...settings,
  run: async (payload: unknown) => boundedOutput(await runDirectReport(payload, directDependencies, false)) });
export const directReport = task({ id: "market-signal-direct-report", ...settings,
  run: async (payload: unknown) => boundedOutput(await runDirectReport(payload, directDependencies)) });
