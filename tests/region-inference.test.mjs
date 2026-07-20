import assert from "node:assert/strict";
import test from "node:test";

import { combineRegionSignals, inferRegion, strictRegionCode } from "../app/lib/region-inference.ts";

test("uses a country-code domain as strong market evidence", () => {
  const result = inferRegion({
    domain: "myjam.co.uk",
    language: "en",
    text: "Cultural groceries delivered to your door",
    sourceUrl: "https://myjam.co.uk/",
  });
  assert.equal(result.countryCode, "GB");
  assert.equal(result.confidence, "Medium");
});

test("prefers structured address and locale over a stray foreign currency mention", () => {
  const result = inferRegion({
    domain: "example.com",
    language: "en-GB",
    document: '<script type="application/ld+json">{"address":{"addressCountry":"GB"}}</script>',
    text: "Ships throughout the United Kingdom. Some international orders display USD.",
    priceSignals: ["USD 20"],
    sourceUrl: "https://example.com/",
  });
  assert.equal(result.countryCode, "GB");
  assert.equal(result.confidence, "High");
});

test("does not invent a region from language alone without a country locale", () => {
  const result = inferRegion({
    domain: "example.com",
    language: "en",
    text: "Software for modern teams",
    sourceUrl: "https://example.com/",
  });
  assert.equal(result.countryCode, "");
  assert.equal(result.country, "Unknown");
});

test("uses an observed page locale and GBP evidence for a UK dot-com store", () => {
  const result = inferRegion({
    domain: "shop.example",
    language: "en",
    document: '<meta property="og:locale" content="en_GB"><a href="https://facebook.com/shop?locale=en_GB">Facebook</a>',
    text: "Natural food delivered to your door",
    priceSignals: ["GBP 12"],
    sourceUrl: "https://shop.example/",
  });
  assert.equal(result.countryCode, "GB");
  assert.equal(result.confidence, "High");
});

test("labels an explicitly worldwide served market as global without inventing a country", () => {
  const result = inferRegion({
    domain: "software.example",
    language: "en",
    text: "A collaboration platform used by teams around the world",
    sourceUrl: "https://software.example/",
  });
  assert.equal(result.countryCode, "GLOBAL");
  assert.equal(result.country, "Global market");
  assert.equal(result.confidence, "Medium");
});

test("combines independent page signals without counting repeated footer evidence twice", () => {
  const homepage = inferRegion({
    domain: "brand.example",
    language: "en",
    text: "Call +44 20 1234 5678",
    sourceUrl: "https://brand.example/",
  });
  const pricing = inferRegion({
    domain: "brand.example",
    language: "en",
    text: "Call +44 20 1234 5678",
    priceSignals: ["GBP 20"],
    sourceUrl: "https://brand.example/pricing",
  });
  const combined = combineRegionSignals([...homepage.signals, ...pricing.signals]);
  assert.equal(combined.countryCode, "GB");
  assert.equal(combined.confidence, "Medium");
  assert.equal(combined.signals.filter((signal) => signal.kind === "phone").length, 1);
});

test("keeps concrete India evidence ahead of worldwide marketing language", () => {
  const result = inferRegion({
    domain: "store.in",
    language: "en-IN",
    document: '<script type="application/ld+json">{"address":{"addressCountry":"IN"}}</script>',
    text: "Made in India, available worldwide. Call +91 98765 43210.",
    priceSignals: ["INR 499", "₹599"],
    sourceUrl: "https://store.in/",
  });
  assert.equal(result.countryCode, "IN");
  assert.equal(result.country, "India");
  assert.equal(result.confidence, "High");
  assert.ok(result.scores.GLOBAL > 0);
});

test("strict discovery parsing accepts only supported exact market names or codes", () => {
  assert.equal(strictRegionCode("United States (inferred)"), "US");
  assert.equal(strictRegionCode("India"), "IN");
  assert.equal(strictRegionCode("SA"), "SA");
  assert.equal(strictRegionCode("South Africa"), "");
  assert.equal(strictRegionCode("US and Canada"), "");
});
