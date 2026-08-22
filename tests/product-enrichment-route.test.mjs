import assert from "node:assert/strict";
import test from "node:test";

import { exclusiveDurableEnrichmentResult } from "../app/api/enrich-products/route.ts";
import { validEnrichmentCheckpoint } from "../src/trigger/report-orchestration-core.ts";

function product(id, priceSignals = []) {
  return {
    id,
    domain: "shop.test",
    name: id,
    normalizedName: id,
    description: "",
    category: "",
    jsonLdType: "Product",
    priceSignals,
    attributes: [],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "Medium",
    sourceUrl: `https://shop.test/products/${id}`,
    imageUrl: "",
    observedAt: "2026-08-23T00:00:00.000Z",
    claimIds: [`${id}-observed`],
  };
}

function target(id) {
  return { domain: "shop.test", sourceUrl: `https://shop.test/products/${id}`, productId: id, expectedName: id, expectedType: "Product", pairScore: 1, role: "rival" };
}

test("the worker endpoint makes product and gap outcomes exclusive before durable validation", () => {
  const result = exclusiveDurableEnrichmentResult({
    products: [product("unresolved"), product("priced", [{ raw: "USD 9.99", currency: "USD", amount: 9.99 }])],
    coverage: {
      pagesRequested: 2,
      pagesFetched: 2,
      maxPages: 2,
      gaps: [{ url: "https://shop.test/products/unresolved", productId: "unresolved", role: "rival", reason: "No same-page currency.", code: "adapter_limited", failureKind: "adapter" }],
    },
  });
  assert.deepEqual(result.products.map((item) => item.id), ["priced"]);
  assert.equal(result.coverage.pagesFetched, 1);
  assert.ok(validEnrichmentCheckpoint({ ok: true, ...result }, [target("unresolved"), target("priced")]));
});

test("a non-HTTP gap cannot erase a valid product or pass durable validation", () => {
  const result = exclusiveDurableEnrichmentResult({
    products: [product("priced", [{ raw: "USD 9.99", currency: "USD", amount: 9.99 }])],
    coverage: {
      pagesRequested: 1,
      pagesFetched: 1,
      maxPages: 1,
      gaps: [{ url: "ftp://shop.test/products/priced", productId: "priced", role: "rival", reason: "Invalid adapter source.", code: "adapter_limited", failureKind: "adapter" }],
    },
  });
  assert.deepEqual(result.products.map((item) => item.id), ["priced"]);
  assert.equal(result.coverage.pagesFetched, 1);
  assert.equal(validEnrichmentCheckpoint({ ok: true, ...result }, [target("priced")]), null);
});
