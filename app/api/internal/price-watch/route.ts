import { openBillingDatabase } from "../../../lib/billing-store.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import { flushPriceWatchEmailOutbox } from "../../../lib/price-watch-email.ts";
import { PRICE_WATCH_BATCH_LIMIT, runPriceWatchBatch } from "../../../lib/price-watch-runner.ts";

const MAX_BODY_BYTES = 1_024;
export const PRICE_WATCH_DRAIN_BUDGET_MS = 240_000;
export const PRICE_WATCH_DRAIN_MAX_PASSES = 32;

async function boundedJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES || !request.body) throw new Error("invalid-body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body-too-large");
    }
    json += decoder.decode(value, { stream: true });
  }
  const parsed = JSON.parse(json + decoder.decode()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
  return parsed as Record<string, unknown>;
}

type PriceWatchInternalServices = {
  openDatabase: typeof openBillingDatabase;
  runBatch: typeof runPriceWatchBatch;
  flushEmail: typeof flushPriceWatchEmailOutbox;
  nowMs?: () => number;
};

export function createPriceWatchHandler(expectedToken?: string, services: PriceWatchInternalServices = { openDatabase: openBillingDatabase, runBatch: runPriceWatchBatch, flushEmail: flushPriceWatchEmailOutbox }) {
  return async function POST(request: Request) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    let body: Record<string, unknown>;
    try { body = await boundedJson(request); }
    catch { return Response.json({ ok: false, error: "Invalid price-watch request." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
    if (body.action !== "run-due" || Object.keys(body).length !== 1) return Response.json({ ok: false, error: "Unsupported price-watch action." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    let database;
    try {
      database = await services.openDatabase();
      const nowMs = services.nowMs || Date.now;
      const startedAt = nowMs();
      const checks = { claimed: 0, baseline: 0, unchanged: 0, changed: 0, failed: 0, passes: 0, saturated: false };
      let lastBatchClaimed = 0;
      do {
        const batch = await services.runBatch(database);
        lastBatchClaimed = Number(batch.claimed || 0);
        checks.claimed += lastBatchClaimed;
        checks.baseline += Number(batch.baseline || 0);
        checks.unchanged += Number(batch.unchanged || 0);
        checks.changed += Number(batch.changed || 0);
        checks.failed += Number(batch.failed || 0);
        checks.passes += 1;
        if (lastBatchClaimed < PRICE_WATCH_BATCH_LIMIT) break;
      } while (checks.passes < PRICE_WATCH_DRAIN_MAX_PASSES && nowMs() - startedAt < PRICE_WATCH_DRAIN_BUDGET_MS);
      checks.saturated = lastBatchClaimed >= PRICE_WATCH_BATCH_LIMIT;
      const email = await services.flushEmail(database);
      return Response.json({ ok: true, checks, email }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ ok: false, error: "The price-watch batch could not be completed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    } finally {
      database?.close();
    }
  };
}

export const POST = createPriceWatchHandler();
