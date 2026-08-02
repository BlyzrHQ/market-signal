import assert from "node:assert/strict";
import test from "node:test";

import { createRobotsPolicyResolver } from "../app/lib/robots-policy.ts";

function result(url, overrides = {}) {
  return {
    ok: true,
    status: 200,
    contentType: "text/plain",
    url,
    text: "User-agent: *\nAllow: /",
    truncated: false,
    responseTimeMs: 1,
    responseBytes: 24,
    redirectCount: 0,
    failureKind: "",
    ...overrides,
  };
}

test("reuses a recent successful robots policy without laundering path denials", async () => {
  let clock = 1_000;
  let calls = 0;
  const resolver = createRobotsPolicyResolver({
    now: () => clock,
    sleep: async () => {},
    fetchText: async (url) => {
      calls += 1;
      return result(url, { text: "User-agent: *\nDisallow: /private" });
    },
  });
  const first = await resolver.resolve("shop.test", "www.shop.test");
  clock += 500;
  const cached = await resolver.resolve("shop.test", "shop.test");
  assert.equal(first.fromCache, false);
  assert.equal(cached.fromCache, true);
  assert.equal(calls, 1);
  assert.equal(cached.policy.allows("/products/maamoul"), true);
  assert.equal(cached.policy.allows("/private"), false);
});

test("does not reuse a robots policy after its TTL", async () => {
  let clock = 1_000;
  let fail = false;
  const resolver = createRobotsPolicyResolver({
    now: () => clock,
    ttlMs: 1_000,
    attemptsPerHost: 1,
    maxHosts: 1,
    sleep: async () => {},
    fetchText: async (url) => fail
      ? result(url, { ok: false, status: 0, text: "", failureKind: "network" })
      : result(url),
  });
  await resolver.resolve("shop.test");
  clock += 1_001;
  fail = true;
  const expired = await resolver.resolve("shop.test");
  assert.equal(expired.availability, "unreachable");
  assert.equal(expired.fromCache, false);
});

test("recovers a transient apex failure through the same-domain www robots host", async () => {
  const calls = [];
  const resolver = createRobotsPolicyResolver({
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      if (url === "https://www.shop.test/robots.txt") return result(url);
      return result(url, { ok: false, status: 0, text: "", failureKind: "network" });
    },
  });
  const resolved = await resolver.resolve("shop.test", "shop.test");
  assert.equal(resolved.availability, "available");
  assert.equal(resolved.sourceUrl, "https://www.shop.test/robots.txt");
  assert.deepEqual(calls, [
    "https://shop.test/robots.txt",
    "https://shop.test/robots.txt",
    "https://www.shop.test/robots.txt",
  ]);
});

test("does not retry or route around explicit robots refusals", async () => {
  const calls = [];
  const resolver = createRobotsPolicyResolver({
    sleep: async () => {},
    fetchText: async (url) => {
      calls.push(url);
      return result(url, { ok: false, status: 429, text: "rate limited" });
    },
  });
  assert.equal((await resolver.resolve("shop.test")).availability, "unreachable");
  assert.equal((await resolver.resolve("shop.test")).availability, "unreachable");
  assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/robots.txt"]);
});

test("caches an explicitly missing robots file but keeps it distinguishable from success", async () => {
  let calls = 0;
  const resolver = createRobotsPolicyResolver({
    fetchText: async (url) => {
      calls += 1;
      return result(url, { ok: false, status: 404, text: "not found" });
    },
  });
  const first = await resolver.resolve("shop.test");
  const cached = await resolver.resolve("shop.test");
  assert.equal(first.availability, "missing");
  assert.equal(cached.availability, "missing");
  assert.equal(cached.fromCache, true);
  assert.equal(calls, 1);
});
