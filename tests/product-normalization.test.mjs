import assert from "node:assert/strict";
import test from "node:test";

import {
  bilingualNormalize,
  canonicalGtin,
  conflictingValidGtins,
  extractProductIdentifiers,
  parseCanonicalQuantity,
  quantitiesConflict,
  sharedValidGtin,
} from "../app/lib/product-normalization.ts";
import { extractProductsFromHtml } from "../app/lib/product-intelligence.ts";

test("normalizes Arabic presentation forms without changing Latin product text", () => {
  const arabic = "\u0640\u0625\u0650\u0646\u062a\u0627\u062c \u0665\u0660\u0660 \u062c\u0631\u0627\u0645 \u0641\u0626\u0629";
  assert.equal(bilingualNormalize(arabic), "\u0627\u0646\u062a\u0627\u062c 500 \u062c\u0631\u0627\u0645 \u0641\u0626\u0647");
  assert.equal(bilingualNormalize("Premium Honey 500g"), "premium honey 500g");
  assert.equal(bilingualNormalize(bilingualNormalize(arabic)), bilingualNormalize(arabic));
  assert.equal(bilingualNormalize("\u06F1\u066B\u06F5 \u0643\u062c\u0645"), "1.5 \u0643\u062c\u0645");
});

test("parses exact Arabic and English mass, volume, count, and pack quantities", () => {
  assert.deepEqual(parseCanonicalQuantity("\u0665\u0660\u0660 \u062c\u0631\u0627\u0645"), { kind: "mass", amount: 500, unit: "g" });
  assert.deepEqual(parseCanonicalQuantity("1 kg"), { kind: "mass", amount: 1000, unit: "g" });
  assert.deepEqual(parseCanonicalQuantity("16 ozs"), { kind: "mass", amount: 453.59237, unit: "g" });
  assert.deepEqual(parseCanonicalQuantity("\u0662 \u0644\u062a\u0631"), { kind: "volume", amount: 2000, unit: "ml" });
  assert.deepEqual(parseCanonicalQuantity("\u0666 \u0642\u0637\u0639"), { kind: "count", amount: 6, unit: "pcs" });
  assert.deepEqual(parseCanonicalQuantity("\u0663 \u0639\u0628\u0648\u0627\u062a"), { kind: "count", amount: 3, unit: "pack" });
  assert.equal(parseCanonicalQuantity("Call 020 7946 0958 in 2026"), null);
  assert.equal(parseCanonicalQuantity("500g plus 1kg"), null);
  assert.equal(quantitiesConflict(parseCanonicalQuantity("500g"), parseCanonicalQuantity("1kg")), true);
});

test("validates and canonicalizes GTINs before comparison", () => {
  assert.equal(canonicalGtin("4006381333931"), "04006381333931");
  assert.equal(canonicalGtin("036000291452"), "00036000291452");
  assert.equal(canonicalGtin("0036000291452"), "00036000291452");
  assert.equal(canonicalGtin("4006381333932"), null);
  assert.equal(canonicalGtin("0000000000000"), null);
  assert.equal(canonicalGtin("<4006381333931>"), null);
});

test("extracts identifiers only from explicit JSON-LD fields", () => {
  const identifiers = extractProductIdentifiers({
    gtin13: "4006381333931",
    sku: " STORE-42 ",
    mpn: "MFG-9",
    brand: { name: "Noor" },
    description: "Untrusted prose contains 0036000291452",
  });
  assert.deepEqual(identifiers, { gtins: ["04006381333931"], sku: "STORE-42", mpn: "MFG-9", brand: "Noor" });
  assert.equal(sharedValidGtin(identifiers, { gtins: ["04006381333931"] }), "04006381333931");
  assert.equal(conflictingValidGtins(identifiers, { gtins: ["00036000291452"] }), true);
  assert.deepEqual(extractProductIdentifiers({ description: "4006381333931" }).gtins, []);
});

test("adds identifier and quantity evidence without changing legacy product IDs", () => {
  const base = {
    document: `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Acme Honey 500g", brand: { name: "Acme" } })}</script>`,
    sourceUrl: "https://acme.test/products/honey",
    domain: "acme.test",
    observedAt: "2026-07-16T00:00:00.000Z",
    pageTitle: "Acme Honey",
    pageDescription: "",
    headings: [],
    pagePriceSignals: [],
  };
  const legacy = extractProductsFromHtml(base).products[0];
  const enriched = extractProductsFromHtml({
    ...base,
    document: `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Acme Honey 500g", brand: { name: "Acme" }, gtin13: "4006381333931" })}</script>`,
  }).products[0];
  assert.equal(enriched.id, legacy.id);
  assert.equal(enriched.normalizedName, legacy.normalizedName);
  assert.equal(enriched.identifiers?.gtins[0], "04006381333931");
  assert.deepEqual(enriched.quantity, { kind: "mass", amount: 500, unit: "g" });
});
