import assert from "node:assert/strict";
import test from "node:test";

import {
  compactTerminalReportDocument,
  encodedJsonBytes,
  REPORT_PRESENTATION_TARGET_BYTES,
  ReportDocumentCompactionError,
} from "../src/shared/report-document-compaction.ts";
import { babanujScaleDocument } from "./fixtures/babanuj-report-document.mjs";

test("Babanuj-scale presentation compacts deterministically below the UTF-8 budget", () => {
  const source = babanujScaleDocument();
  const counts = { companies: 7, products: 2665, matches: 23, ads: 0 };
  const compacted = compactTerminalReportDocument(source, undefined, { factsAuthoritative: true, factCounts: counts });
  const twice = compactTerminalReportDocument(compacted);
  assert.deepEqual(twice, compacted);
  assert.equal(JSON.stringify(twice), JSON.stringify(compacted));
  assert.ok(encodedJsonBytes(compacted) <= REPORT_PRESENTATION_TARGET_BYTES);
  assert.equal(source.document.blocks.filter((block) => block.type === "product-catalog").reduce((sum, block) => sum + block.products.length, 0), 2665);

  const blocks = compacted.document.blocks;
  for (const required of ["summary", "market-profile", "experience-benchmark", "competitor", "coverage", "product-comparison"]) assert.ok(blocks.some((block) => block.type === required));
  const primaryCatalog = blocks.find((block) => block.id === "catalog-shop-0.test");
  assert.equal(primaryCatalog.totalProductCount, 81);
  assert.equal(primaryCatalog.persistedProductCount, primaryCatalog.products.length);
  assert.equal(primaryCatalog.productsTruncated, true);
  assert.ok(primaryCatalog.products[0].sourceUrl && primaryCatalog.products[0].imageUrl && primaryCatalog.products[0].priceSignals.length);
  assert.equal("description" in primaryCatalog.products[0], false);
  assert.equal("claimIds" in primaryCatalog.products[0], false);
  const summary = blocks.find((block) => block.type === "presentation-compaction");
  assert.equal(summary.totalEvidenceBlockCount, 300);
  assert.equal(summary.evidenceBlocksTruncated, true);
  assert.equal(summary.totalGapCount, 120);
  assert.equal(summary.gapsTruncated, true);
  assert.equal(summary.relationalFactsAuthoritative, true);
  assert.deepEqual(summary.factCounts, counts);
});

test("UTF-8 byte limits reject oversized essential content instead of counting code units", () => {
  const blocks = Array.from({ length: 100 }, (_, index) => ({ type: "summary", id: `summary-${index}`, body: "مرحبا".repeat(2_000) }));
  assert.throws(() => compactTerminalReportDocument({ document: { blocks } }), ReportDocumentCompactionError);
});

test("compaction preserves raw-only public prices and prioritizes accepted source-linked comparisons", () => {
  const product = (index) => ({ id: `p-${index}`, domain: "shop.test", name: `Product ${index}`, sourceUrl: `https://shop.test/${index}`, imageUrl: "", priceSignals: [{ raw: "From 10" }] });
  const rows = Array.from({ length: 120 }, (_, index) => ({ primary: product(index), matches: index === 119 ? [{ domain: "rival.test", confidence: "High", product: { ...product(999), domain: "rival.test", sourceUrl: "https://rival.test/999" } }] : [] }));
  const compacted = compactTerminalReportDocument({ primaryDomain: "shop.test", document: { blocks: [{ type: "product-catalog", id: "catalog", products: [product(0)] }, { type: "product-comparison", id: "comparison", rows, unmatched: [] }] } });
  const blocks = compacted.document.blocks;
  assert.deepEqual(blocks.find((block) => block.id === "catalog").products[0].priceSignals, [{ raw: "From 10" }]);
  assert.ok(blocks.find((block) => block.id === "comparison").rows.some((row) => row.primary.id === "p-119"));
  assert.equal(blocks.find((block) => block.type === "presentation-compaction").relationalFactsAuthoritative, false);
});

test("explicit de-authoritization clears stale counts and ad truncation remains visible", () => {
  const concepts = Array.from({ length: 10 }, (_, index) => ({ id: `ad-${index}`, headline: `Creative ${index}` }));
  const platforms = Array.from({ length: 5 }, (_, index) => ({ platform: `Platform ${index}`, creativeConcepts: concepts }));
  const source = { document: { blocks: [{ type: "ad-intelligence", id: "ads", companies: [{ domain: "shop.test", platforms }] }, { type: "presentation-compaction", id: "presentation-compaction", relationalFactsAuthoritative: true, factCounts: { companies: 1, products: 5, matches: 0, ads: 50 } }] } };
  const compacted = compactTerminalReportDocument(source, undefined, { factsAuthoritative: false, factCounts: null });
  const summary = compacted.document.blocks.find((block) => block.type === "presentation-compaction");
  const company = compacted.document.blocks.find((block) => block.type === "ad-intelligence").companies[0];
  assert.equal(summary.relationalFactsAuthoritative, false);
  assert.equal(summary.factCounts, null);
  assert.equal(company.totalPlatformCount, 5);
  assert.equal(company.persistedPlatformCount, 3);
  assert.equal(company.platformsTruncated, true);
  assert.equal(company.platforms[0].totalCreativeConceptCount, 10);
  assert.equal(company.platforms[0].persistedCreativeConceptCount, 6);
  assert.equal(company.platforms[0].creativeConceptsTruncated, true);
  assert.deepEqual(compactTerminalReportDocument(compacted), compacted);
});
