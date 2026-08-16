import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { POST as crawl } from "../app/api/crawl/route.ts";
import { POST as ads } from "../app/api/ads/route.ts";
import { POST as enrichProducts } from "../app/api/enrich-products/route.ts";

const TOKEN = "worker-endpoint-auth-test-token-1234567890";
const routes = [
  ["crawl", crawl],
  ["ads", ads],
  ["enrich-products", enrichProducts],
];

const routeSources = ["crawl", "report", "ads", "enrich-products"];

async function request(handler, authorization) {
  return handler(new Request("https://signal.example/api/internal-worker", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: "not-json",
  }));
}

test("worker endpoints fail closed before parsing the request body", async () => {
  const previous = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = TOKEN;
  try {
    for (const [name, handler] of routes) {
      for (const authorization of [undefined, `Basic ${TOKEN}`, "Bearer wrong-token"]) {
        const response = await request(handler, authorization);
        assert.equal(response.status, 401, `${name} must reject ${authorization || "a missing authorization header"}`);
        assert.deepEqual(await response.json(), { ok: false, error: "Unauthorized." });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
    else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = previous;
  }
});

test("worker endpoints fail closed when the callback token is unconfigured", async () => {
  const previous = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  try {
    for (const [name, handler] of routes) {
      const response = await request(handler, `Bearer ${TOKEN}`);
      assert.equal(response.status, 401, `${name} must reject requests when its server credential is absent`);
    }
  } finally {
    if (previous === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
    else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = previous;
  }
});

test("worker endpoints accept the configured callback token", async () => {
  const previous = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = TOKEN;
  try {
    for (const [name, handler] of routes) {
      const response = await request(handler, `Bearer ${TOKEN}`);
      assert.equal(response.status, 400, `${name} must reach its existing body validation with a valid callback token`);
    }
  } finally {
    if (previous === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
    else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = previous;
  }
});

test("every worker endpoint checks authorization before parsing or doing work", async () => {
  for (const name of routeSources) {
    const source = await readFile(new URL(`../app/api/${name}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /hasValidInternalAuthorization/);
    assert.match(source, /unauthorizedInternalResponse/);
    const post = source.indexOf("export async function POST");
    const authorization = source.indexOf("hasValidInternalAuthorization", post);
    const bodyParsing = source.indexOf("request.json()", post);
    assert.ok(post >= 0, `${name} must expose a POST handler`);
    assert.ok(authorization > post, `${name} must authorize inside its POST handler`);
    assert.ok(bodyParsing < 0 || authorization < bodyParsing, `${name} must authorize before parsing its request body`);
  }
});
