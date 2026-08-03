import assert from "node:assert/strict";
import test from "node:test";

import { crawlDomain } from "../app/api/crawl/route.ts";
import { resetSharedRobotsPolicyResolverForTests } from "../app/lib/robots-policy.ts";

function response(body, status = 200, contentType = "text/html") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

test("recovers an apex homepage failure through www and rebases downstream crawl URLs", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  resetSharedRobotsPolicyResolverForTests();
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://shop.test/robots.txt") return response("forbidden", 403, "text/plain");
    if (url === "https://shop.test/") return response("forbidden", 403);
    if (url === "https://www.shop.test/robots.txt") return response("User-agent: *\nAllow: /\nSitemap: https://www.shop.test/sitemap.xml", 200, "text/plain");
    if (url === "https://www.shop.test/") return response('<html><head><title>Recovered shop</title></head><body><a href="/products/honey">Honey</a></body></html>');
    if (url === "https://www.shop.test/sitemap.xml") return response('<?xml version="1.0"?><urlset><url><loc>https://www.shop.test/products/honey</loc></url></urlset>', 200, "application/xml");
    if (url === "https://www.shop.test/products/honey") return response('<html><head><title>Honey</title></head><body><h1>Honey</h1></body></html>');
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await crawlDomain("shop.test", "primary");
    assert.equal(result.homepage?.sourceUrl, "https://www.shop.test/");
    assert.ok(result.pages.some((page) => page.sourceUrl === "https://www.shop.test/products/honey"));
    assert.ok(result.gaps.some((gap) => /continued on.*www\.shop\.test/i.test(gap.reason)));
    assert.deepEqual(calls.slice(0, 4), [
      "https://shop.test/robots.txt",
      "https://shop.test/",
      "https://www.shop.test/robots.txt",
      "https://www.shop.test/",
    ]);
    assert.equal(calls.filter((url) => url === "https://shop.test/" || url === "https://www.shop.test/").length, 2);
    assert.ok(calls.includes("https://www.shop.test/sitemap.xml"));
    assert.ok(!calls.includes("https://shop.test/sitemap.xml"));
  } finally {
    globalThis.fetch = originalFetch;
    resetSharedRobotsPolicyResolverForTests();
  }
});

test("does not route around robots denial or homepage throttling", async (t) => {
  await t.test("robots denial", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    resetSharedRobotsPolicyResolverForTests();
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      return response("User-agent: *\nDisallow: /", 200, "text/plain");
    };
    try {
      const result = await crawlDomain("shop.test", "primary");
      assert.equal(result.homepage, null);
      assert.deepEqual(calls, ["https://shop.test/robots.txt"]);
    } finally {
      globalThis.fetch = originalFetch;
      resetSharedRobotsPolicyResolverForTests();
    }
  });

  await t.test("homepage throttling", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    resetSharedRobotsPolicyResolverForTests();
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /", 200, "text/plain");
      return response("slow down", 429);
    };
    try {
      const result = await crawlDomain("shop.test", "primary");
      assert.equal(result.homepage, null);
      assert.ok(!calls.some((url) => url.startsWith("https://www.shop.test/")));
    } finally {
      globalThis.fetch = originalFetch;
      resetSharedRobotsPolicyResolverForTests();
    }
  });
});

test("reports both host failures without misclassifying a responding apex as a network outage", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  resetSharedRobotsPolicyResolverForTests();
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return response("User-agent: *\nAllow: /", 200, "text/plain");
    if (url === "https://shop.test/") return response("forbidden", 403);
    if (url === "https://www.shop.test/") throw new Error("network down");
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await crawlDomain("shop.test", "primary");
    assert.equal(result.homepage, null);
    assert.equal(result.homepageFailure, undefined);
    assert.ok(result.gaps.some((gap) => gap.url === "https://shop.test/" && /HTTP 403/.test(gap.reason)));
    assert.ok(result.gaps.some((gap) => gap.url === "https://www.shop.test/" && /request failed/.test(gap.reason)));
    assert.equal(calls.filter((url) => url.endsWith("/robots.txt")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetSharedRobotsPolicyResolverForTests();
  }
});

test("does not re-resolve robots or fetch the alternate homepage after a robots 429", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  resetSharedRobotsPolicyResolverForTests();
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) return response("slow down", 429, "text/plain");
    return response("forbidden", 403);
  };
  try {
    const result = await crawlDomain("shop.test", "primary");
    assert.equal(result.homepage, null);
    assert.deepEqual(calls, ["https://shop.test/robots.txt", "https://shop.test/"]);
  } finally {
    globalThis.fetch = originalFetch;
    resetSharedRobotsPolicyResolverForTests();
  }
});
