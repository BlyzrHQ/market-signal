import test from "node:test";
import assert from "node:assert/strict";
import { productCurrencyRequestUrl, soleProductCurrencySelector } from "../app/lib/product-currency-context.ts";

test("currency preference uses known ISO currency without overriding market or locale", () => {
  assert.equal(productCurrencyRequestUrl("https://seller.test/products/tea", "GBP"), "https://seller.test/products/tea?currency=GBP");
  for (const suffix of ["?currency=USD", "?country=US", "?locale=en-US", "?region=US"]) {
    const url = `https://seller.test/products/tea${suffix}`;
    assert.equal(productCurrencyRequestUrl(url, "GBP"), url);
  }
  for (const path of ["/en-us/products/tea", "/en/products/tea", "/product/tea", "/collections/tea"]) {
    const url = `https://seller.test${path}`;
    assert.equal(productCurrencyRequestUrl(url, "GBP"), url);
  }
  assert.equal(productCurrencyRequestUrl("https://seller.test/products/tea", ""), "https://seller.test/products/tea");
  for (const query of ["currency=GBP&currency=USD", "currency=GBP&country=GB", "currency=invalid"])
    assert.equal(soleProductCurrencySelector(`https://seller.test/products/tea?${query}`), "");
});
