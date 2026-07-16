import test from "node:test";
import assert from "node:assert/strict";
import { parseCatalogs } from "../app/api/match/route.ts";

test("AI matching input keeps a broad but bounded first-party catalog", () => {
  const products = Array.from({ length: 605 }, (_, index) => ({
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
  assert.equal(catalogs[0].products.length, 600);
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

test("AI matching input revalidates identifiers and recomputes canonical quantity", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [{
    id: "p1",
    name: "\u0639\u0633\u0644 \u0665\u0660\u0660 \u062c\u0631\u0627\u0645",
    sourceUrl: "https://shop.test/products/honey",
    identifiers: { gtins: ["4006381333931", "4006381333932"], sku: "SKU-42", brand: "Noor" },
    attributes: [],
  }] }]);

  assert.deepEqual(catalogs[0].products[0].identifiers, { gtins: ["04006381333931"], sku: "SKU-42", mpn: undefined, brand: "Noor" });
  assert.deepEqual(catalogs[0].products[0].quantity, { kind: "mass", amount: 500, unit: "g" });
});

test("AI matching input does not infer quantity from an identifier attribute", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [{
    name: "Organic Honey",
    sourceUrl: "https://shop.test/products/honey",
    attributes: ["sku: HONEY-500G"],
  }] }]);

  assert.equal(catalogs[0].products[0].quantity, undefined);
});
