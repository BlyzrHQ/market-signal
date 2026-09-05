import assert from "node:assert/strict";
import test from "node:test";

import { exclusiveDurableEnrichmentResult, handleProductEnrichmentRequest } from "../app/api/enrich-products/route.ts";
import { publicProductTarget } from "../app/lib/storefront-product-enrichment.ts";
import { createRobotsPolicyResolver } from "../app/lib/robots-policy.ts";
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

for (const mixed of [false, true]) test(`short product routes survive ${mixed ? "mixed" : "single"} handler batches and durable enrichment validation`, async () => {
  const selected = { ...target("glass-cup"), expectedName: "Glass Cup", sourceUrl: "https://shop.test/p/glass-cup/12345/", role: "primary" };
  const selectedTargets = mixed ? [selected, { ...target("glass-cup-rival"), expectedName: "Glass Cup" }] : [selected];
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    if (mixed && String(input) === selectedTargets[1].sourceUrl + ".js") return new Response("Not found", { status: 404 });
    assert.ok(selectedTargets.some(item => item.sourceUrl === String(input)));
    return new Response(`<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: "Glass Cup", url: String(input),
      offers: { "@type": "Offer", price: "12.99", priceCurrency: "GBP" },
    })}</script></head><body><h1>Glass Cup</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  const robotsResolver = createRobotsPolicyResolver({ fetchText: async () => ({ ok: true, status: 200, text: "User-agent: *\nAllow: /", url: "https://shop.test/robots.txt" }) });
  const response = await handleProductEnrichmentRequest(new Request("http://internal.invalid/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targets: selectedTargets }),
  }), { fetchImpl, robotsResolver });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.coverage.pagesFetched, selectedTargets.length);
  assert.equal(result.products[0].sourceUrl, selected.sourceUrl);
  assert.equal(result.products[0].priceSignals[0].amount, 12.99);
  assert.ok(validEnrichmentCheckpoint(result, selectedTargets));
  assert.deepEqual(calls.sort(), [...selectedTargets.map(item => item.sourceUrl), ...(mixed ? [selectedTargets[1].sourceUrl + ".js"] : [])].sort());
});

test("short-route admission retains source-domain, scheme, and product-path boundaries", () => {
  const selected = { ...target("glass-cup"), sourceUrl: "https://shop.test/p/glass-cup/12345/" };
  assert.ok(publicProductTarget(selected));
  for (const sourceUrl of ["https://other.test/p/glass-cup/12345/", "ftp://shop.test/p/glass-cup/12345/", "https://shop.test/account/glass-cup", "https://shop.test/c/tea"]) {
    assert.equal(publicProductTarget({ ...selected, sourceUrl }), null);
  }
});

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
