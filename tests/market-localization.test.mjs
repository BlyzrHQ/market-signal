import assert from "node:assert/strict";
import test from "node:test";

import { redirectedMarketRetryUrl } from "../app/lib/market-localization.ts";

test("retries a geo-inserted storefront locale in the primary market", () => {
  assert.equal(
    redirectedMarketRetryUrl(
      "https://hana.com.sa/products/golden-sidr-blend-500g",
      "https://hana.com.sa/ar-de/products/golden-sidr-blend-500g",
      "SA",
    ),
    "https://hana.com.sa/ar-sa/products/golden-sidr-blend-500g",
  );
});

test("does not override explicit, unrelated, or same-market storefront URLs", () => {
  assert.equal(redirectedMarketRetryUrl("https://hana.com.sa/ar-de/products/honey", "https://hana.com.sa/ar-de/products/honey", "SA"), "");
  assert.equal(redirectedMarketRetryUrl("https://hana.com.sa/products/honey?country=DE", "https://hana.com.sa/ar-de/products/honey?country=DE", "SA"), "");
  assert.equal(redirectedMarketRetryUrl("https://hana.com.sa/products/honey", "https://evil.example/ar-de/products/honey", "SA"), "");
  assert.equal(redirectedMarketRetryUrl("https://hana.com.sa/products/honey", "https://hana.com.sa/ar-sa/products/honey", "SA"), "");
  assert.equal(redirectedMarketRetryUrl("https://hana.com.sa/products/honey", "https://hana.com.sa/ar-de/collections/honey", "SA"), "");
});
