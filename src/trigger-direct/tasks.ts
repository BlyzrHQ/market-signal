import { task } from "@trigger.dev/sdk";
import { capabilities, runDirectCrawl, runDirectReport } from "./core.ts";
import { directDependencies } from "./runtime.ts";

const settings = { maxDuration: 3600, retry: { maxAttempts: 1 }, queue: { name: "market-signal-direct", concurrencyLimit: 2 } };
function boundedOutput<T>(value: T): T {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 8 * 1024 * 1024) throw new Error("OUTPUT_TOO_LARGE: select a smaller target; no automatic rerun");
  // The external agent contract is plain JSON, not JS Date/undefined/Map types.
  // Keep Trigger's superjson artifact free of type-rehydration metadata.
  return JSON.parse(json) as T;
}
export const directCapabilities = task({ id: "market-signal-direct-capabilities", ...settings, maxDuration: 30,
  run: async () => capabilities(directDependencies.searchConfigured()) });
export const directCrawl = task({ id: "market-signal-direct-crawl", ...settings,
  run: async (payload: unknown) => boundedOutput(await runDirectCrawl(payload, directDependencies)) });
export const directCompare = task({ id: "market-signal-direct-compare", ...settings,
  run: async (payload: unknown) => boundedOutput(await runDirectReport(payload, directDependencies, false)) });
export const directReport = task({ id: "market-signal-direct-report", ...settings,
  run: async (payload: unknown) => boundedOutput(await runDirectReport(payload, directDependencies)) });
