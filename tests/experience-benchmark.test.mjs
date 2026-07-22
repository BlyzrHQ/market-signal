import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildExperienceBenchmark } from "../app/lib/experience-benchmark.ts";
import { fetchPublicText } from "../app/lib/public-fetch.ts";

const page = (overrides = {}) => ({
  sourceUrl: "https://shop.example/products/honey",
  responseTimeMs: 840,
  responseBytes: 42_000,
  imageCount: 4,
  imagesWithAlt: 3,
  responsiveImageCount: 2,
  hasViewport: true,
  hasDocumentLanguage: true,
  productLinkCount: 5,
  hasProductPath: true,
  hasAddToCart: true,
  hasCartLink: true,
  hasCheckoutLink: false,
  trustSignals: ["shipping", "returns", "contact", "legal"],
  ...overrides,
});

const product = (overrides = {}) => ({
  name: "Wildflower honey 500g",
  description: "Raw regional honey",
  category: "Honey",
  imageUrl: "https://shop.example/honey.jpg",
  priceSignals: [{ amount: 12, currency: "GBP" }],
  quantity: { value: 500, unit: "g" },
  sourceUrl: "https://shop.example/products/honey",
  ...overrides,
});

test("builds reproducible experience metrics without claiming unknown values are zero", () => {
  const result = buildExperienceBenchmark([
    { domain: "shop.example", role: "primary", fetchedAt: "2026-07-22T00:00:00Z", pages: [page()], products: [product()], catalogProductsDiscovered: 20 },
    { domain: "limited.example", role: "discovered-competitor", fetchedAt: "2026-07-22T00:00:00Z", pages: [], products: [], catalogProductsDiscovered: 0 },
  ]);

  const primary = result.domains[0];
  assert.equal(primary.response.observed.medianMs, 840);
  assert.equal(primary.response.score, null);
  assert.equal(primary.images.observed.productImageCoverage, 100);
  assert.equal(primary.information.score, 100);
  assert.equal(primary.productAccess.score, 100);
  assert.equal(primary.purchasePath.minimumPublicSteps, 2);
  assert.equal(primary.trust.score, 80);
  assert.equal(primary.mobileAccessibility.score, 91);
  assert.match(primary.response.formula, /not Core Web Vitals/i);
  assert.match(primary.purchasePath.formula, /never completed-checkout time/i);
  assert.match(primary.images.formula, /not subjective visual quality/i);

  const limited = result.domains[1];
  assert.equal(limited.response.score, null);
  assert.equal(limited.images.score, null);
  assert.equal(limited.information.score, null);
  assert.equal(limited.purchasePath.score, null);
  assert.equal(limited.mobileAccessibility.score, null);
});

test("information and image scores reflect missing public product evidence", () => {
  const result = buildExperienceBenchmark([{ domain: "shop.example", role: "primary", fetchedAt: "2026-07-22T00:00:00Z", pages: [page({ imagesWithAlt: 0, responsiveImageCount: 0 })], products: [product({ description: "", imageUrl: "", priceSignals: [], quantity: undefined })], catalogProductsDiscovered: 1 }]);
  const primary = result.domains[0];
  assert.equal(primary.information.score, 33);
  assert.equal(primary.images.score, 0);
  assert.equal(primary.images.observed.productImageCoverage, 0);
});

test("public fetch exposes bounded response timing and payload bytes", async () => {
  const result = await fetchPublicText("https://timing.example/", "text/html", {
    expectedDomain: "timing.example",
    timeoutMs: 1000,
    maxDocumentBytes: 100,
    userAgent: "test",
    fetchImpl: async () => new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.responseBytes, 18);
  assert.equal(typeof result.responseTimeMs, "number");
  assert.ok(result.responseTimeMs >= 0);
  assert.equal(result.redirectCount, 0);
});

test("crawl document and report route persist and render the benchmark truth boundary", async () => {
  const crawl = await readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8");
  const report = await readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../app/components/experience-benchmark.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(crawl, /type: "experience-benchmark"/);
  assert.match(crawl, /responseTimeMs/);
  assert.match(crawl, /hasAddToCart/);
  assert.match(report, /en: "Benchmark"/);
  assert.match(report, /<ExperienceBenchmark/);
  assert.match(component, /not Core Web Vitals/);
  assert.match(component, /Unknown/);
  assert.match(css, /\.benchmark-gap-chart/);
  assert.match(css, /\.experience-map-plot/);
});
