import assert from "node:assert/strict";
import test from "node:test";

import { boundedExtractionDocument, compactCatalogSnapshots, interruptedReportRecovery, settleWithConcurrency } from "../app/lib/crawl-runtime.ts";

test("settles every crawl while keeping large-document work within the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await settleWithConcurrency(["a", "b", "c", "d", "e", "f"], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value === "b" ? 8 : 2));
    active -= 1;
    if (value === "d") throw new Error("blocked site");
    return `${value}-done`;
  });

  assert.equal(peak, 2);
  assert.equal(results.length, 6);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(results[0].status === "fulfilled" && results[0].value, "a-done");
});

test("bounds regex extraction input while retaining both metadata and footer evidence", () => {
  const document = `<html><head><title>Market</title></head><body>${"x".repeat(1_200_000)}<footer><a href="https://instagram.com/market">Social</a></footer></body></html>`;
  const bounded = boundedExtractionDocument(document, 400_000);

  assert.ok(new TextEncoder().encode(bounded).byteLength <= 400_000);
  assert.match(bounded, /<title>Market<\/title>/);
  assert.match(bounded, /instagram\.com\/market/);
  assert.match(bounded, /content omitted from regex extraction/i);
});

test("keeps the extraction byte ceiling for multilingual documents", () => {
  const bounded = boundedExtractionDocument(`مرحبا${"😀".repeat(1_000)}النهاية`, 1_024);
  assert.ok(new TextEncoder().encode(bounded).byteLength <= 1_024);
  assert.doesNotMatch(bounded, /�/);
});

test("retains product structured data found in the middle of a large storefront page", () => {
  const jsonLd = '<script type="application/ld+json">{"@type":"Product","name":"Sidr Honey"}</script>';
  const document = `<html><head><title>Store</title></head><body>${"a".repeat(600_000)}${jsonLd}${"b".repeat(600_000)}<footer>End</footer></body></html>`;
  const bounded = boundedExtractionDocument(document, 400_000);

  assert.match(bounded, /"@type":"Product"/);
  assert.match(bounded, /"name":"Sidr Honey"/);
  assert.ok(new TextEncoder().encode(bounded).byteLength <= 400_000);
});

test("returns truthful bounded catalog snapshots without mutating the aggregate catalog", () => {
  const products = Array.from({ length: 312 }, (_, index) => ({ id: `p-${index}`, name: `Product ${index}` }));
  const document = { version: "1", blocks: [{ type: "product-catalog", id: "catalog", domain: "shop.example", products }] };
  const compacted = compactCatalogSnapshots(document, 40);
  const catalog = compacted.blocks[0];

  assert.equal(catalog.products.length, 40);
  assert.equal(catalog.persistedProductCount, 40);
  assert.equal(catalog.totalProductCount, 312);
  assert.equal(catalog.productsTruncated, true);
  assert.equal(products.length, 312);
});

test("keeps an interrupted crawl addressable through its durable report URL", () => {
  const recovery = interruptedReportRecovery("abc123", "The competitor scan was temporarily interrupted.");

  assert.equal(recovery.path, "/reports/abc123");
  assert.deepEqual(recovery.event, {
    action: "event",
    idempotencyKey: "crawl-request-interrupted",
    phase: "failed",
    status: "failed",
    message: "The competitor scan was temporarily interrupted.",
    errorCode: "crawl-service-interrupted",
  });
});
