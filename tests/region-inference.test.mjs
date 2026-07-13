import assert from "node:assert/strict";
import test from "node:test";

import { inferRegion } from "../app/lib/region-inference.ts";

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
