#!/usr/bin/env node

import { enrichProductTargets } from "../app/lib/storefront-product-enrichment.ts";

const observed = [
  ["kol-shkor", "zaitoune sweets kol and shkor with honey 500g", "zaitoune-sweets-kol-and-shkor-with-honey-500g"],
  ["nawashif", "zaitoune sweets mixed nawashif 500g", "zaitoune-sweets-mixed-nawashif-500g"],
  ["walnut", "zaitoune sweets maamoul with walnut 500g", "zaitoune-sweets-maamoul-with-walnut-500g"],
  ["mabrouma", "zaitoune sweets mabrouma 400g", "zaitoune-sweets-mabrouma-400g"],
].map(([productId, expectedName, slug]) => ({
  domain: "babanuj.com",
  sourceUrl: `https://www.babanuj.com/product/${slug}`,
  productId: `catalog-drift-${productId}`,
  expectedName,
  expectedType: "Product",
  pairScore: 0,
  role: "primary",
  allowCatalogReplacement: true,
}));

const result = await enrichProductTargets(observed, observed.length);
process.stdout.write(`${JSON.stringify({
  observedAt: new Date().toISOString(),
  domain: "babanuj.com",
  requested: result.coverage.pagesRequested,
  resolved: result.coverage.pagesFetched,
  gaps: result.coverage.gaps,
  products: result.products.map((product) => ({
    id: product.id,
    previousIdentity: product.attributes.find((attribute) => attribute.startsWith("Previous sitemap identity:")) || null,
    currentName: product.name,
    currentQuantity: product.quantity || null,
    imageUrl: product.imageUrl || null,
    prices: product.priceSignals,
    sourceUrl: product.sourceUrl,
    extraction: product.extraction,
    confidence: product.confidence,
  })),
}, null, 2)}\n`);
