import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildExperienceBenchmark } from "../app/lib/experience-benchmark.ts";
import { benchmarkGapAction, orderBenchmarkPositions } from "../app/lib/benchmark-presentation.ts";
import { hasObservedAddToCartControl } from "../app/lib/experience-signals.ts";
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

test("missing image markup is not converted into a losing readiness score", () => {
  const result = buildExperienceBenchmark([{
    domain: "shop.example",
    role: "primary",
    fetchedAt: "2026-07-22T00:00:00Z",
    pages: [page({ imageCount: 0, imagesWithAlt: 0, responsiveImageCount: 0 })],
    products: [product()],
    catalogProductsDiscovered: 1,
  }]);
  const primary = result.domains[0];
  assert.equal(primary.images.observed.altCoverage, null);
  assert.equal(primary.images.observed.responsiveCoverage, null);
  assert.equal(primary.images.score, 100);
  assert.equal(primary.mobileAccessibility.observed.altCoverage, null);
  assert.equal(primary.mobileAccessibility.score, 100);
  assert.match(primary.images.formula, /only the components observed/i);
  assert.match(primary.mobileAccessibility.formula, /only the components observed/i);
});

test("orders benchmark decisions by proven urgency and keeps unknowns last", () => {
  const ordered = orderBenchmarkPositions([
    { key: "small-edge", yours: 70, median: 65, leader: 90 },
    { key: "unknown", yours: null, median: 60, leader: 90 },
    { key: "level", yours: 60, median: 60, leader: 90 },
    { key: "large-gap", yours: 20, median: 60, leader: 90 },
    { key: "large-edge", yours: 80, median: 65, leader: 90 },
    { key: "small-gap", yours: 55, median: 60, leader: 90 },
  ]);
  assert.deepEqual(ordered.map(({ key, band, delta }) => ({ key, band, delta })), [
    { key: "large-gap", band: "behind", delta: -40 },
    { key: "small-gap", band: "behind", delta: -5 },
    { key: "level", band: "level", delta: 0 },
    { key: "large-edge", band: "ahead", delta: 15 },
    { key: "small-edge", band: "ahead", delta: 5 },
    { key: "unknown", band: "unknown", delta: null },
  ]);
});

test("benchmark gap actions use observed evidence and stay localized", () => {
  assert.equal(benchmarkGapAction("images", { products: 10, productsWithImage: 7 }, false), "Add images to 3 public products currently missing one.");
  assert.equal(benchmarkGapAction("information", { completedFields: 15, possibleFields: 18 }, false), "Complete 3 missing public fields in the product sample.");
  assert.equal(benchmarkGapAction("purchasePath", { hasProductPath: false, hasAddToCart: true, hasCartLink: true, hasCheckoutLink: true }, false), "Expose a direct public path to product pages.");
  assert.match(benchmarkGapAction("trust", { shipping: true, returns: false, contact: false, legal: true, company: true }, false), /returns, contact/);
  assert.match(benchmarkGapAction("mobileAccessibility", { viewport: false }, true), /عرض/);
});

test("add-to-cart detection rejects ordinary address fields", () => {
  assert.equal(hasObservedAddToCartControl('<form><input name="address"><textarea name="additional_notes"></textarea></form>'), false);
  assert.equal(hasObservedAddToCartControl('<button name="add">Add item</button>'), true);
  assert.equal(hasObservedAddToCartControl('<form action="/cart/add"><button>Add to bag</button></form>'), true);
  assert.equal(hasObservedAddToCartControl("<product-form data-product-form>Buy</product-form>"), true);
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
  assert.match(component, /points behind market median/);
  assert.match(component, /Your score was not measured/);
  assert.doesNotMatch(component, /function ScoreBar/);
  assert.match(css, /\.benchmark-scorecard-row/);
  assert.match(css, /inset-inline-start/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(css, /\[dir="rtl"\] \.benchmark-track i \{ transform: translate\(50%,-50%\)/);
  assert.match(css, /\.experience-map-plot/);
});
