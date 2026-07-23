import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchPublicText } from "../app/lib/public-fetch.ts";

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
  assert.match(report, /Competitors and products were not checked/);
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
