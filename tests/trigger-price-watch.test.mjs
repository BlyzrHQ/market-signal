import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createPriceWatchHandler, PRICE_WATCH_DRAIN_BUDGET_MS, PRICE_WATCH_DRAIN_MAX_PASSES } from "../app/api/internal/price-watch/route.ts";
import { runPriceWatchSchedule } from "../src/trigger/price-watch-core.ts";
import { createPriceWatchHttpPort } from "../src/trigger/price-watch-http.ts";
import { createWorkerApiManifest, PRICE_WATCH_CAPABILITY } from "../src/shared/worker-api-contract.ts";

const callbackToken = "price_watch_callback_token_1234567890";

test("the schedule explicitly skips only when the deployed worker lacks the price-watch capability", async () => {
  const logs = [];
  let runs = 0;
  const skipped = await runPriceWatchSchedule({
    preflight: async () => false,
    runDue: async () => { runs += 1; return { ok: true }; },
  }, (message, metadata) => logs.push({ message, metadata }));
  assert.deepEqual(skipped, { ok: true, skipped: "capability-unavailable" });
  assert.equal(runs, 0);
  assert.match(logs[0].message, /skipped/);

  await assert.rejects(() => runPriceWatchSchedule({
    preflight: async () => { throw new Error("network failure"); },
    runDue: async () => ({ ok: true }),
  }), /network failure/);
});

test("the HTTP scheduler preflights capability then sends one authenticated bounded action", async () => {
  const calls = [];
  const manifest = createWorkerApiManifest(() => new Date("2026-08-24T12:00:00.000Z"));
  const port = createPriceWatchHttpPort({
    appOrigin: "https://signal.example",
    callbackToken,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      if (url.endsWith("/capabilities")) return Response.json(manifest);
      return Response.json({ ok: true, checks: { claimed: 1, baseline: 1, unchanged: 0, changed: 0, failed: 0 }, email: { configured: true, delivered: 0, pending: 0 } });
    },
  });
  assert.equal(await port.preflight(), true);
  const result = await port.runDue();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://signal.example/api/internal/capabilities");
  assert.equal(calls[1].url, "https://signal.example/api/internal/price-watch");
  assert.equal(calls[1].init.headers.authorization, `Bearer ${callbackToken}`);
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: "run-due" });
});

test("the HTTP scheduler reports an older deployment as unavailable and never treats runtime errors as a skip", async () => {
  const manifest = createWorkerApiManifest(() => new Date("2026-08-24T12:00:00.000Z"));
  manifest.capabilities = manifest.capabilities.filter((capability) => capability !== PRICE_WATCH_CAPABILITY);
  const older = createPriceWatchHttpPort({ appOrigin: "https://signal.example", callbackToken, fetchImpl: async () => Response.json(manifest) });
  assert.equal(await older.preflight(), false);

  let calls = 0;
  const failing = createPriceWatchHttpPort({
    appOrigin: "https://signal.example",
    callbackToken,
    async fetchImpl() { calls += 1; return new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } }); },
  });
  await assert.rejects(() => failing.runDue(), /request failed/);
  assert.equal(calls, 1);
  assert.throws(() => createPriceWatchHttpPort({ appOrigin: "http://signal.example", callbackToken }), /HTTPS origin/);
  assert.throws(() => createPriceWatchHttpPort({ appOrigin: "https://signal.example/path", callbackToken }), /without a path/);
  assert.throws(() => createPriceWatchHttpPort({ appOrigin: "https://signal.example", callbackToken: "short" }), /not configured correctly/);
});

test("the internal endpoint authenticates, bounds input, runs checks before email, and always closes storage", async () => {
  const order = [];
  const database = { close() { order.push("close"); } };
  const handler = createPriceWatchHandler(callbackToken, {
    openDatabase: async () => { order.push("open"); return database; },
    runBatch: async (value) => { assert.equal(value, database); order.push("checks"); return { claimed: 2, baseline: 1, unchanged: 1, changed: 0, failed: 0 }; },
    flushEmail: async (value) => { assert.equal(value, database); order.push("email"); return { configured: true, delivered: 1, pending: 0 }; },
  });

  const unauthorized = await handler(new Request("https://signal.example/api/internal/price-watch", { method: "POST", body: JSON.stringify({ action: "run-due" }) }));
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(order, []);

  const unsupported = await handler(new Request("https://signal.example/api/internal/price-watch", {
    method: "POST",
    headers: { authorization: `Bearer ${callbackToken}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run-due", unexpected: true }),
  }));
  assert.equal(unsupported.status, 400);
  assert.deepEqual(order, []);

  const oversized = await handler(new Request("https://signal.example/api/internal/price-watch", {
    method: "POST",
    headers: { authorization: `Bearer ${callbackToken}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run-due", padding: "x".repeat(2_000) }),
  }));
  assert.equal(oversized.status, 400);
  assert.deepEqual(order, []);

  const accepted = await handler(new Request("https://signal.example/api/internal/price-watch", {
    method: "POST",
    headers: { authorization: `Bearer ${callbackToken}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run-due" }),
  }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await accepted.json(), {
    ok: true,
    checks: { claimed: 2, baseline: 1, unchanged: 1, changed: 0, failed: 0, passes: 1, saturated: false },
    email: { configured: true, delivered: 1, pending: 0 },
  });
  assert.deepEqual(order, ["open", "checks", "email", "close"]);
});

test("one scheduled invocation drains consecutive bounded batches and reports saturation", async () => {
  const database = { close() {} };
  let calls = 0;
  const batches = [
    { claimed: 8, baseline: 8, unchanged: 0, changed: 0, failed: 0 },
    { claimed: 8, baseline: 0, unchanged: 7, changed: 1, failed: 0 },
    { claimed: 3, baseline: 0, unchanged: 1, changed: 0, failed: 2 },
  ];
  const handler = createPriceWatchHandler(callbackToken, {
    openDatabase: async () => database,
    runBatch: async () => batches[calls++],
    flushEmail: async () => ({ configured: true, delivered: 0, pending: 0 }),
    nowMs: () => 0,
  });
  const response = await handler(new Request("https://signal.example/api/internal/price-watch", {
    method: "POST",
    headers: { authorization: `Bearer ${callbackToken}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run-due" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checks, {
    claimed: 19,
    baseline: 8,
    unchanged: 8,
    changed: 1,
    failed: 2,
    passes: 3,
    saturated: false,
  });
  assert.equal(calls, 3);

  let clock = 0;
  const saturated = createPriceWatchHandler(callbackToken, {
    openDatabase: async () => database,
    runBatch: async () => { clock = PRICE_WATCH_DRAIN_BUDGET_MS; return { claimed: 8, baseline: 0, unchanged: 8, changed: 0, failed: 0 }; },
    flushEmail: async () => ({ configured: true, delivered: 0, pending: 0 }),
    nowMs: () => clock,
  });
  const saturatedResponse = await saturated(new Request("https://signal.example/api/internal/price-watch", {
    method: "POST",
    headers: { authorization: `Bearer ${callbackToken}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run-due" }),
  }));
  const saturatedChecks = (await saturatedResponse.json()).checks;
  assert.equal(saturatedChecks.passes, 1);
  assert.equal(saturatedChecks.saturated, true);
  assert.equal(PRICE_WATCH_DRAIN_MAX_PASSES, 32);

  const logs = [];
  await runPriceWatchSchedule({
    preflight: async () => true,
    runDue: async () => ({ ok: true, checks: saturatedChecks }),
  }, (message, metadata) => logs.push({ message, metadata }));
  assert.equal(logs.some((entry) => /backlog remains/.test(entry.message) && entry.metadata.saturated === true), true);
});

test("the production price-watch path has no AI, discovery, or paid-search import", () => {
  for (const relative of [
    "../app/lib/price-watch-runner.ts",
    "../app/lib/price-watch-store.ts",
    "../src/trigger/price-watch.ts",
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*(?:openai|ai-product-matching|competitor-discovery|search-provider)[^"']*["']/i, relative);
  }
});
