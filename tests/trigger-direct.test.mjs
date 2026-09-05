import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { capabilities, requestSchema, runDirectCrawl, runDirectReport } from "../src/trigger-direct/core.ts";

// Synthetic fixtures only. All transport is injected; no provider or site calls.
const domain = "primary.example";
const request = { contractVersion: "1", domain, comparisons: 2, rivals: 1, requestId: "fixture:1" };
function product(host, id, amount = 10) {
  return { id, domain: host, name: "Fixture product", normalizedName: "fixture product", description: "", category: "food", jsonLdType: "Product",
    priceSignals: amount === null ? [] : [{ raw: `GBP ${amount}`, amount, currency: "GBP" }], attributes: [], ownership: "self-declared-brand", extraction: "json-ld", confidence: "High",
    sourceUrl: `https://${host}/products/${id}`, observedAt: new Date().toISOString(), imageUrl: "", claimIds: [id] };
}
function dependencies() {
  return { searchConfigured: () => true,
    crawl: async () => ({ domain, products: [product(domain, "primary")], regionCountryCode: "GB", gaps: [], sourceUrl: `https://${domain}/`, observedAt: new Date().toISOString(), accessible: true }),
    search: async () => ({ completed: true, queries: ["fixture query"], candidates: [
      { domain: "empty.example", sourceUrl: "https://empty.example/products/empty", title: "Fixture product" },
      { domain: "rival.example", sourceUrl: "https://rival.example/products/a", title: "Fixture product" },
      { domain: "rival.example", sourceUrl: "https://rival.example/products/b", title: "Fixture product" },
      { domain: "other.example", sourceUrl: "https://other.example/products/c", title: "Fixture product" },
    ] }),
    enrich: async () => ({ products: [product("empty.example", "empty", null), product("rival.example", "a"), product("rival.example", "b"), product("other.example", "c")],
      coverage: { pagesRequested: 4, pagesFetched: 4, maxPages: 4, gaps: [] } }),
  };
}
test("direct report produces priced pairs and rivals without website/DB/auth dependencies", async () => {
  const result = await runDirectReport(request, dependencies());
  assert.equal(result.comparisons.length, 2);
  assert.equal(result.competitors.length, 1);
  assert.equal(result.competitors[0].domain, "rival.example");
  assert.equal(result.metrics.pricedComparisons, 2);
  assert.equal(result.evaluation.basis, "deterministic-report-quality-gate");
  assert.equal(result.costMicrousd, null);
  assert.ok(result.comparisons.every(pair => pair.rivalProduct.priceSignals[0].amount > 0));
});
test("empty price sites do not consume rival allowance; shortages stay limited", async () => {
  const result = await runDirectReport({ ...request, comparisons: 3 }, dependencies());
  assert.equal(result.status, "limited");
  assert.equal(result.metrics.pricedComparisons, 2);
  assert.equal(result.evaluation.missingComparisonCount, 1);
});
test("missing provider fails before crawl and does not fabricate a result", async () => {
  let calls = 0;
  await assert.rejects(runDirectReport(request, { ...dependencies(), searchConfigured: () => false, crawl: async () => { calls++; } }), /SEARCH_NOT_CONFIGURED/);
  assert.equal(calls, 0);
});
test("failed crawl is explicit and search never runs", async () => {
  const deps = dependencies(); const catalog = await deps.crawl(); let searches = 0;
  const result = await runDirectReport(request, { ...deps, crawl: async () => ({ ...catalog, accessible: false, gaps: ["access denied"] }), search: async () => { searches++; } });
  assert.equal(result.status, "failed"); assert.equal(searches, 0);
});
test("crawl task does not need a research provider", async () => {
  const result = await runDirectCrawl(request, { ...dependencies(), searchConfigured: () => false });
  assert.equal(result.catalog.products.length, 1);
  assert.equal(result.status, "complete");
});
test("missing domains, invalid targets, private hosts and extra auth/endpoint flags fail closed", () => {
  for (const value of ["", "<domain>", "127.0.0.1", "localhost", "https://user:pass@primary.example/"]) assert.equal(requestSchema.safeParse({ ...request, domain: value }).success, false);
  for (const extra of [{ comparisons: 0 }, { rivals: 0 }, { rivals: 1001 }, { comparisons: 1001 }, { apiKey: "fixture" }, { appOrigin: "https://primary.example" }]) assert.equal(requestSchema.safeParse({ ...request, ...extra }).success, false);
  assert.equal(requestSchema.safeParse({ ...request, comparisons: 1000, rivals: 1000 }).success, true);
  assert.equal(capabilities(false).providerConfigured, false);
  assert.equal(capabilities(true).websiteRequired, false);
});
test("standalone adapter does not call website endpoints or load report storage", async () => {
  const runtime = await readFile(new URL("../src/trigger-direct/runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /process\.env\.(?:MARKET_SIGNAL_APP_ORIGIN|MARKET_SIGNAL_CALLBACK_TOKEN)|fetch\(|from ["'][^"']*report-store|POST\(/);
  const config = await readFile(new URL("../trigger.direct.config.ts", import.meta.url), "utf8");
  assert.match(config, /\.\/src\/trigger", "\.\/src\/trigger-direct/);
});
