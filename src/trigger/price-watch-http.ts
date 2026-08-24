import { PRICE_WATCH_CAPABILITY, parseWorkerApiManifest } from "../shared/worker-api-contract.ts";
import type { PriceWatchSchedulePort, PriceWatchScheduleResult } from "./price-watch-core.ts";

type FetchLike = typeof fetch;
const REQUEST_TIMEOUT_MS = 290_000;

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("MARKET_SIGNAL_APP_ORIGIN must be an HTTPS origin without a path or credentials.");
  return url.origin;
}

function configuredToken(value: string) {
  if (!value || value.length < 32 || /\s/.test(value)) throw new Error("MARKET_SIGNAL_CALLBACK_TOKEN is not configured correctly.");
  return value;
}

async function requestJson(fetchImpl: FetchLike, url: string, token: string, body?: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      signal: controller.signal,
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")) throw new Error("Price-watch worker API request failed.");
    return await response.json() as unknown;
  } finally { clearTimeout(timeout); }
}

export function createPriceWatchHttpPort(configuration: { appOrigin: string; callbackToken: string; fetchImpl?: FetchLike }): PriceWatchSchedulePort {
  const appOrigin = configuredOrigin(configuration.appOrigin);
  const callbackToken = configuredToken(configuration.callbackToken);
  const fetchImpl = configuration.fetchImpl || fetch;
  return {
    async preflight() {
      const manifest = parseWorkerApiManifest(await requestJson(fetchImpl, `${appOrigin}/api/internal/capabilities`, callbackToken));
      return manifest.capabilities.includes(PRICE_WATCH_CAPABILITY);
    },
    async runDue() {
      const value = await requestJson(fetchImpl, `${appOrigin}/api/internal/price-watch`, callbackToken, { action: "run-due" });
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).ok !== true) throw new Error("Price-watch worker API returned an invalid response.");
      return value as PriceWatchScheduleResult;
    },
  };
}
