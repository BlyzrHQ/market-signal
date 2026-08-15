import assert from "node:assert/strict";
import test from "node:test";

import { boundedExtractionDocument, compactCatalogSnapshots, interruptedReportRecovery, preferredEndpointFailure, settleWithConcurrency, unavailableAfterBoundedAttempts, unavailablePrimaryMessaging } from "../app/lib/crawl-runtime.ts";
import { IPV6_ONLY_ORIGIN_REASON } from "../app/lib/public-fetch.ts";

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
  assert.equal(catalog.pricedProductCount, 0);
  assert.equal(catalog.totalPricedProductCount, 0);
  assert.equal(products.length, 312);
});

test("keeps observed-price products in a stable, truthfully labeled catalog sample", () => {
  const products = Array.from({ length: 605 }, (_, index) => ({
    id: `p-${index}`,
    name: `Product ${index}`,
    priceSignals: index >= 500 && index < 516
      ? [{ amount: index + 0.5, currency: "GBP", source: "json-ld" }]
      : [],
  }));
  const document = { version: "1", blocks: [{ type: "product-catalog", id: "primary", domain: "myjam.co.uk", products }] };

  const catalog = compactCatalogSnapshots(document, 40).blocks[0];

  assert.deepEqual(catalog.products.slice(0, 16).map((product) => product.id), Array.from({ length: 16 }, (_, index) => `p-${500 + index}`));
  assert.deepEqual(catalog.products.slice(16).map((product) => product.id), Array.from({ length: 24 }, (_, index) => `p-${index}`));
  assert.equal(catalog.persistedProductCount, 40);
  assert.equal(catalog.totalProductCount, 605);
  assert.equal(catalog.pricedProductCount, 16);
  assert.equal(catalog.totalPricedProductCount, 16);
  assert.equal(catalog.productsTruncated, true);
  assert.equal(document.blocks[0].products[0].id, "p-0");
});

test("limits an over-cap priced catalog while preserving priced order", () => {
  const products = Array.from({ length: 50 }, (_, index) => ({
    id: `priced-${index}`,
    priceSignals: [{ amount: index + 1, currency: "USD" }],
  }));
  const catalog = compactCatalogSnapshots({ version: "1", blocks: [{ type: "product-catalog", id: "rival", products }] }, 10).blocks[0];

  assert.deepEqual(catalog.products.map((product) => product.id), Array.from({ length: 10 }, (_, index) => `priced-${index}`));
  assert.equal(catalog.pricedProductCount, 10);
  assert.equal(catalog.totalPricedProductCount, 50);
});

test("does not classify incomplete or invalid price signals as comparable prices", () => {
  const products = [
    { id: "no-currency", priceSignals: [{ amount: 10, currency: "" }] },
    { id: "zero", priceSignals: [{ amount: 0, currency: "GBP" }] },
    { id: "not-a-number", priceSignals: [{ amount: "unknown", currency: "GBP" }] },
    { id: "valid", priceSignals: [{ amount: 4.5, currency: "GBP" }] },
  ];
  const catalog = compactCatalogSnapshots({ version: "1", blocks: [{ type: "product-catalog", id: "catalog", products }] }, 4).blocks[0];

  assert.deepEqual(catalog.products.map((product) => product.id), ["valid", "no-currency", "zero", "not-a-number"]);
  assert.equal(catalog.pricedProductCount, 1);
  assert.equal(catalog.totalPricedProductCount, 1);
});

test("leaves non-catalog and legacy catalog-shaped blocks untouched", () => {
  const blocks = [
    { type: "product-comparison", id: "comparison", products: [{ id: "comparison-product" }] },
    { type: "product-catalog", id: "legacy", products: "not-an-array" },
  ];
  const compacted = compactCatalogSnapshots({ version: "1", blocks }, 1);
  assert.deepEqual(compacted.blocks, blocks);
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

test("classifies only two same-origin non-timeout network failures as unavailable", () => {
  const first = { kind: "network", attemptedUrl: "https://missing.example/", reason: "request failed", observedAt: "2026-07-20T10:00:00.000Z" };
  const second = { ...first, observedAt: "2026-07-20T10:00:01.000Z" };
  assert.deepEqual(unavailableAfterBoundedAttempts(first, second), {
    status: "unavailable",
    attemptedUrl: "https://missing.example/",
    reason: "The submitted public HTTPS endpoint did not return a network response after two bounded attempts.",
    observedAt: second.observedAt,
  });
  assert.equal(unavailableAfterBoundedAttempts({ ...first, kind: "timeout" }, second), null);
  assert.equal(unavailableAfterBoundedAttempts(first, { ...second, attemptedUrl: "https://other.example/" }), null);
  assert.equal(unavailableAfterBoundedAttempts(first, undefined), null);
  assert.equal(unavailableAfterBoundedAttempts({ ...first, attemptedUrl: "http://missing.example/" }, { ...second, attemptedUrl: "http://missing.example/" }), null);
});

test("preserves an IPv6-only reason through the final customer messaging", () => {
  const reason = IPV6_ONLY_ORIGIN_REASON;
  const first = { kind: "network", attemptedUrl: "https://ipv6-only.example/", reason, observedAt: "2026-08-15T06:00:00.000Z" };
  const state = unavailableAfterBoundedAttempts(first, { ...first, observedAt: "2026-08-15T06:00:01.000Z" });
  assert.ok(state);
  assert.equal(state.reason, reason);
  const messaging = unavailablePrimaryMessaging("ipv6-only.example", state);
  assert.match(messaging.explanation, /does not support IPv6-only origins/);
  assert.match(messaging.summaryBody, /Add a public IPv4 A record/);
  assert.match(messaging.error, /^ipv6-only\.example: The public crawler/);
});

test("prefers the submitted IPv6-only failure over a generic www recovery failure", () => {
  const observedAt = "2026-08-15T06:00:00.000Z";
  const submitted = { kind: "network", attemptedUrl: "https://shop.example/", reason: IPV6_ONLY_ORIGIN_REASON, observedAt };
  const alternate = { kind: "network", attemptedUrl: "https://www.shop.example/", reason: "The hostname did not resolve to an exclusively public IPv4 address.", observedAt };
  assert.deepEqual(preferredEndpointFailure(submitted, alternate), submitted);
  assert.deepEqual(preferredEndpointFailure({ ...submitted, reason: "request failed" }, alternate), alternate);
});

test("does not preserve appended text as a typed IPv6-only reason", () => {
  const observedAt = "2026-08-15T06:00:00.000Z";
  const injected = `${IPV6_ONLY_ORIGIN_REASON} REMOTE_MARKER=<img src=x onerror=alert(1)>`;
  const failure = { kind: "network", attemptedUrl: "https://shop.example/", reason: injected, observedAt };
  const alternate = { ...failure, attemptedUrl: "https://www.shop.example/" };
  assert.deepEqual(preferredEndpointFailure(failure, alternate), alternate);
  const state = unavailableAfterBoundedAttempts(failure, { ...failure, attemptedUrl: "https://shop.example/" });
  assert.equal(state?.reason, "The submitted public HTTPS endpoint did not return a network response after two bounded attempts.");
  assert.doesNotMatch(state?.reason || "", /REMOTE_MARKER/);
});
