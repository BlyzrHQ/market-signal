import assert from "node:assert/strict";
import test from "node:test";

import { reconcilePreliminaryPrimaryCatalog } from "../app/api/crawl/route.ts";
import { buildProductComparison } from "../app/lib/product-intelligence.ts";
import { resetSharedRobotsPolicyResolverForTests } from "../app/lib/robots-policy.ts";

function product(id, domain, name, sourceUrl) {
  return {
    id,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description: "public product",
    category: "sweets",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl,
    imageUrl: "",
    observedAt: "2026-08-03T00:00:00.000Z",
    claimIds: [`${id}-stale`],
  };
}

function crawl(domain, role, products) {
  return {
    domain,
    role,
    homepage: null,
    pages: [],
    products,
    candidates: [],
    gaps: [],
    coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 5, robotsChecked: true },
    productCoverage: { scannedPages: 1, catalogProductsDiscovered: products.length, thirdPartyReferenced: 0 },
    fetchedAt: "2026-08-03T00:00:00.000Z",
  };
}

test("route reconciliation discards preliminary pairs and rebuilds from matched and unmatched live identities", async () => {
  const originalFetch = globalThis.fetch;
  resetSharedRobotsPolicyResolverForTests();
  const staleMatched = product("stale-matched", "shop.test", "Walnut Maamoul 500g", "https://shop.test/shop/walnut-maamoul");
  const staleUnmatched = product("stale-unmatched", "shop.test", "Old Nougat 500g", "https://shop.test/shop/old-nougat");
  const rival = product("rival", "rival.test", "Walnut Maamoul 500g", "https://rival.test/shop/walnut-maamoul");
  const filler = Array.from({ length: 68 }, (_, index) => product(`filler-${index}`, "shop.test", `ZZ Filler Product ${String(index).padStart(2, "0")}`, `https://shop.test/shop/filler-${index}`));
  const liveByPath = {
    "/shop/walnut-maamoul": { name: "Pistachio Baklava 600g", price: "18.50", image: "pistachio.jpg" },
    "/shop/old-nougat": { name: "Sesame Cookies 300g", price: "9.25", image: "sesame.jpg" },
  };
  for (const item of filler) liveByPath[new URL(item.sourceUrl).pathname] = { name: item.name, price: "5.00", image: `${item.id}.jpg` };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
    const live = liveByPath[url.pathname];
    if (!live) return new Response("not found", { status: 404 });
    return new Response(`<html><head><title>${live.name} | Shop</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: live.name,
      image: `https://cdn.shop.test/${live.image}`,
      offers: { "@type": "Offer", price: live.price, priceCurrency: "USD" },
    })}</script></head><body><h1>${live.name}</h1></body></html>`, { headers: { "content-type": "text/html" } });
  };
  try {
    const initial = [crawl("shop.test", "primary", [staleMatched, staleUnmatched, ...filler]), crawl("rival.test", "discovered-competitor", [rival])];
    const preliminary = buildProductComparison("shop.test", initial.map((entry) => ({ domain: entry.domain, products: entry.products })));
    assert.equal(preliminary.rows.some((row) => row.primary.name === staleMatched.name && row.matches.some((match) => match.product.id === rival.id)), true);

    const reconciled = await reconcilePreliminaryPrimaryCatalog(initial, "shop.test");
    const primary = reconciled.find((entry) => entry.domain === "shop.test");
    assert.equal(primary.catalogReconciliation.pagesRequested, 64);
    assert.equal(primary.catalogReconciliation.pagesFetched, 64);
    assert.equal(primary.catalogReconciliation.eligibleProducts, 70);
    assert.equal(primary.catalogReconciliation.truncated, true);
    assert.equal(primary.products.some((entry) => entry.name === "Pistachio Baklava 600g"), true);
    assert.equal(primary.products.some((entry) => entry.name === "Sesame Cookies 300g"), true);
    assert.equal(primary.products.filter((entry) => ["Pistachio Baklava 600g", "Sesame Cookies 300g"].includes(entry.name)).every((entry) => entry.attributes.some((attribute) => attribute.startsWith("Previous sitemap identity:"))), true);
    assert.equal(primary.products.some((entry) => entry.claimIds.includes("stale-matched-stale") || entry.claimIds.includes("stale-unmatched-stale")), false);
    assert.equal(primary.gaps.some((gap) => /selected 64 of 70 price-less primary products/.test(gap.reason)), true);

    const finalComparison = buildProductComparison("shop.test", reconciled.map((entry) => ({ domain: entry.domain, products: entry.products })));
    assert.equal(finalComparison.rows.some((row) => row.primary.name === staleMatched.name || row.primary.name === staleUnmatched.name), false);
    assert.equal(finalComparison.rows.some((row) => row.matches.some((match) => match.product?.id === rival.id)), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetSharedRobotsPolicyResolverForTests();
  }
});
