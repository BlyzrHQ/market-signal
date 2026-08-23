import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MARKET_SIGNAL_ROBOTS_TOKENS, MARKET_SIGNAL_USER_AGENT } from "../app/lib/crawler-identity.ts";

test("crawler identity is honest, centralized, and does not impersonate a browser", () => {
  assert.deepEqual(MARKET_SIGNAL_ROBOTS_TOKENS, ["MarketSignal", "MarketSignalPublicScanner"]);
  assert.match(MARKET_SIGNAL_USER_AGENT, /^MarketSignal\/1\.0 /);
  assert.match(MARKET_SIGNAL_USER_AGENT, /https:\/\/signal\.blyzr\.com\/how-it-works/);
  assert.doesNotMatch(MARKET_SIGNAL_USER_AGENT, /Mozilla|Chrome|Safari/i);
});

test("public collection call sites import the shared crawler identity", async () => {
  const files = [
    "../app/api/analyze/route.ts",
    "../app/api/crawl/route.ts",
    "../app/lib/robots-policy.ts",
    "../app/lib/salla-mcp-catalog-recovery.ts",
    "../app/lib/storefront-product-enrichment.ts",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /MARKET_SIGNAL_USER_AGENT/, file);
    assert.doesNotMatch(source, /MarketSignalPublicScanner\/0\.1/, file);
  }
});

test("the crawler information URL documents identity and robots opt-out", async () => {
  const source = await readFile(new URL("../app/how-it-works/page.tsx", import.meta.url), "utf8");
  assert.match(source, /MarketSignal\/1\.0/);
  assert.match(source, /User-agent: MarketSignal\\nDisallow: \//);
});
