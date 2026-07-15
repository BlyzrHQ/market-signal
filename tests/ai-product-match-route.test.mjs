import test from "node:test";
import assert from "node:assert/strict";
import { parseCatalogs } from "../app/api/match/route.ts";

test("AI matching input keeps only bounded first-party product evidence", () => {
  const products = Array.from({ length: 405 }, (_, index) => ({
    id: `p${index}`,
    domain: "shop.test",
    name: `Product ${index}`,
    normalizedName: `product ${index}`,
    description: "Public product description",
    category: "grocery",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://shop.test/products/${index}`,
    imageUrl: "https://images.example.test/untrusted.jpg",
    observedAt: "2026-07-15T00:00:00.000Z",
    claimIds: [`claim-${index}`],
  }));
  products.push({ ...products[0], id: "external", sourceUrl: "https://external.test/products/0" });

  const catalogs = parseCatalogs([{ domain: "shop.test", products }]);

  assert.equal(catalogs.length, 1);
  assert.equal(catalogs[0].products.length, 400);
  assert.equal(catalogs[0].products[0].imageUrl, "");
  assert.ok(catalogs[0].products.every((product) => new URL(product.sourceUrl).hostname === "shop.test"));
});

test("AI matching input rejects missing and off-domain product sources", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [
    { name: "No source" },
    { name: "Wrong source", sourceUrl: "https://other.test/products/1" },
  ] }]);

  assert.equal(catalogs[0].products.length, 0);
});
