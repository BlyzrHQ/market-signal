import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchPublicText, resolvePublicAddresses, resolvePublicAddressState, resolvesToPublicAddress } from "../app/lib/public-fetch.ts";

test("the crawl API returns a typed unavailable-domain result before market discovery", async () => {
  const route = await readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8");
  assert.match(route, /primary\?\.siteState\?\.status === "unavailable"/);
  assert.match(route, /code: "unavailable-domain"/);
  assert.match(route, /attempts: primary\.coverage\.attempts \|\| 2/);
  assert.match(route, /status: 409/);
  assert.ok(route.indexOf('code: "unavailable-domain"') < route.indexOf("let discovery: DiscoveryResult"));
});

test("the saved unavailable report hides empty market tabs and explains skipped work", async () => {
  const report = await readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
  assert.match(report, /\["parked", "unavailable"\]/);
  assert.match(report, /No public website response was available for this domain/);
  assert.match(report, /This is not a zero-result report/);
  assert.match(report, /Competitors, products, and ads were not checked/);
  assert.match(report, /Open attempted address/);
});

test("same-origin redirect loops are responding failures rather than unavailable network failures", async () => {
  let calls = 0;
  const result = await fetchPublicText("https://redirect-loop.example/", "text/html", {
    expectedDomain: "redirect-loop.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test",
    async fetchImpl() { calls += 1; return new Response("", { status: 302, headers: { location: "/still-redirecting" } }); },
  });
  assert.equal(calls, 4);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "");
  assert.equal(result.status, 0);
});

test("malformed redirect locations are responding failures rather than unavailable network failures", async () => {
  const result = await fetchPublicText("https://malformed-redirect.example/", "text/html", {
    expectedDomain: "malformed-redirect.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test",
    async fetchImpl() { return new Response("", { status: 302, headers: { location: "https://[" } }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "");
  assert.equal(result.status, 0);
});

test("only an actual fetch transport rejection is classified as a network failure", async () => {
  const result = await fetchPublicText("https://missing.example/", "text/html", {
    expectedDomain: "missing.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test",
    async fetchImpl() { throw new TypeError("network unavailable"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "network");
  assert.equal(result.status, 0);
});

test("a Cloudflare Worker origin DNS 1016 response is classified as a network failure", async () => {
  const result = await fetchPublicText("https://missing.example/", "text/html", {
    expectedDomain: "missing.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test",
    async fetchImpl() {
      return new Response("error code: 1016", {
        status: 530,
        headers: { "content-type": "text/plain" },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "network");
  assert.equal(result.status, 530);
  assert.match(result.error, /could not resolve/i);
});

test("an ordinary 530 response is not treated as a DNS transport failure", async () => {
  const result = await fetchPublicText("https://responding.example/", "text/html", {
    expectedDomain: "responding.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test",
    async fetchImpl() {
      return new Response("<html><title>Temporary origin failure</title></html>", {
        status: 530,
        headers: { "content-type": "text/html" },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "");
  assert.equal(result.status, 530);
});

test("a 530 page merely mentioning 1016 without the exact Cloudflare error shape remains an HTTP failure", async () => {
  const result = await fetchPublicText("https://responding.example/", "text/html", {
    expectedDomain: "responding.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test",
    async fetchImpl() {
      return new Response("<html><p>Read our guide to resolving code 1016.</p></html>", {
        status: 530,
        headers: { "content-type": "text/html" },
      });
    },
  });
  assert.equal(result.failureKind, "");
  assert.equal(result.status, 530);
});

test("public fetch DNS preflight rejects any private resolution", async () => {
  const resolve = async (url) => Response.json({ Answer: String(url).includes("type=1") ? [{ type: 1, data: "127.0.0.1" }] : [] });
  assert.equal(await resolvesToPublicAddress("private-resolution.example", resolve), false);
});

test("public fetch rejects private IPv4 destinations embedded in standard NAT64 answers", async () => {
  for (const address of ["64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::a9fe:101", "::ffff:0:7f00:1", "2002:7f00:1::", "3ffe:831f::1", "3000::1", "2420::1", "24ff::1", "2610:200::1", "2640::1", "2810::1", "2a20::1", "2c10::1"]) {
    const resolve = async (url) => Response.json({ Answer: String(url).includes("type=28") ? [{ type: 28, data: address }] : [] });
    assert.equal(await resolvesToPublicAddress("nat64-rebinding.example", resolve), false, address);
  }
});

test("public fetch DNS preflight accepts exclusively public resolutions", async () => {
  const resolve = async (url) => Response.json({ Answer: String(url).includes("type=1") ? [{ type: 1, data: "93.184.216.34" }] : [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] });
  assert.equal(await resolvesToPublicAddress("public-resolution.example", resolve), true);
});

test("public fetch DNS preflight rejects IPv6-only targets even in allocated space", async () => {
  for (const address of ["2410::1", "2610::1", "2620::1", "2630::1", "2a10::1"]) {
    const resolve = async (url) => Response.json({ Answer: String(url).includes("type=28") ? [{ type: 28, data: address }] : [] });
    assert.equal(await resolvesToPublicAddress("public-allocation.example", resolve), false, address);
  }
});

test("an IPv6-only origin returns a typed user-visible crawler limitation", async () => {
  const dnsFetchImpl = async (url) => Response.json({ Answer: String(url).includes("type=28") ? [{ type: 28, data: "2001:4860:4860::8888" }] : [] });
  const state = await resolvePublicAddressState("ipv6-only.example", dnsFetchImpl);
  assert.deepEqual(state, { addresses: [], ipv6Only: true });
  const result = await fetchPublicText("https://ipv6-only.example/", "text/html", {
    expectedDomain: "ipv6-only.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 1_000,
    userAgent: "test",
    dnsFetchImpl,
    async fetchImpl() { throw new Error("the page transport must not run"); },
  });
  assert.equal(result.failureKind, "network");
  assert.match(result.error, /does not support IPv6-only origins/);
});

test("public fetch pins only public IPv4 when an unused AAAA answer is unsafe", async () => {
  const requestedTypes = [];
  const resolve = async (url) => {
    const type = Number(new URL(url).searchParams.get("type"));
    requestedTypes.push(type);
    return Response.json({ Answer: type === 1 ? [{ type: 1, data: "93.184.216.34" }] : [{ type: 28, data: "2001:4860:4860:1:0:0:a00:1" }] });
  };
  assert.deepEqual(await resolvePublicAddresses("public-resolution.example", resolve), ["93.184.216.34"]);
  assert.deepEqual(requestedTypes, [1]);
});

test("public fetch DNS preflight never trusts a stale public resolution", async () => {
  let request = 0;
  const resolve = async (url) => {
    if (!String(url).includes("type=1")) return Response.json({ Answer: [] });
    request += 1;
    return Response.json({ Answer: [{ type: 1, data: request === 1 ? "93.184.216.34" : "127.0.0.1" }] });
  };
  assert.equal(await resolvesToPublicAddress("rebinding.example", resolve), true);
  assert.equal(await resolvesToPublicAddress("rebinding.example", resolve), false);
});

test("public fetch streams and cancels response bodies at the configured byte limit", async () => {
  const result = await fetchPublicText("https://large.example/", "text/html", {
    expectedDomain: "large.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 8,
    userAgent: "test",
    async fetchImpl() { return new Response("x".repeat(2_000_000), { headers: { "content-type": "text/html" } }); },
  });
  assert.equal(result.text.length, 8);
  assert.equal(result.responseBytes, 9);
  assert.equal(result.truncated, true);
});

test("public fetch distinguishes an exact-size body from a longer next chunk", async () => {
  const exact = await fetchPublicText("https://exact.example/", "text/html", {
    expectedDomain: "exact.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 8,
    userAgent: "test",
    async fetchImpl() { return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("12345678")); controller.close(); } })); },
  });
  assert.equal(exact.text, "12345678");
  assert.equal(exact.responseBytes, 8);
  assert.equal(exact.truncated, false);

  let cancelled = false;
  const longer = await fetchPublicText("https://longer.example/", "text/html", {
    expectedDomain: "longer.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 8,
    userAgent: "test",
    async fetchImpl() {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("12345678")); controller.enqueue(new TextEncoder().encode("abcdefgh")); },
        cancel() { cancelled = true; },
      }));
    },
  });
  assert.equal(longer.text, "12345678");
  assert.equal(longer.responseBytes, 9);
  assert.equal(longer.truncated, true);
  assert.equal(cancelled, true);
});

test("public fetch skips empty overflow-probe chunks and cancels a longer body", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345678"));
      controller.enqueue(new Uint8Array());
      controller.enqueue(new TextEncoder().encode("OVERFLOW"));
    },
    cancel() { cancelled = true; },
  });
  const result = await fetchPublicText("https://empty-chunk.example/", "text/html", {
    timeoutMs: 1_000,
    maxDocumentBytes: 8,
    userAgent: "test",
    async fetchImpl() { return new Response(stream); },
  });
  assert.equal(result.text, "12345678");
  assert.equal(result.responseBytes, 9);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test("public fetch can skip and cancel an unsuccessful response body", async () => {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(100_000)); },
    cancel() { cancelled = true; },
  });
  const result = await fetchPublicText("https://error-body.example/", "text/html", {
    timeoutMs: 1_000,
    maxDocumentBytes: 8,
    userAgent: "test",
    readErrorBody: false,
    async fetchImpl() { return new Response(stream, { status: 503 }); },
  });
  assert.equal(result.status, 503);
  assert.equal(result.text, "");
  assert.equal(result.responseBytes, 0);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 1);
});

test("public fetch sends a bounded same-domain JSON-RPC POST without weakening redirect handling", async () => {
  let captured;
  const result = await fetchPublicText("https://mcp.example/mcp", "application/json", {
    expectedDomain: "mcp.example",
    timeoutMs: 1_000,
    maxDocumentBytes: 10_000,
    userAgent: "test-agent",
    jsonRpcBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "store://info" } }),
    protocolVersion: "2025-06-18",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, "https://mcp.example/mcp");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.equal(captured.init.headers["MCP-Protocol-Version"], "2025-06-18");
  assert.match(captured.init.body, /store:\/\/info/);
});
