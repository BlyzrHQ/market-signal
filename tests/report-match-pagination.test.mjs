import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRun, finalizeReportFactManifest, loadStoredReportMatchPage, saveReportDocument, saveReportFactChunk } from "../app/lib/report-store.ts";
import { buildReportFactBundle } from "../src/shared/report-facts.ts";

function product(domain, index, observedAt) {
  return {
    id: `${domain}-product-${index}`,
    domain,
    name: `Observed product ${index}`,
    normalizedName: `observed product ${index}`,
    category: "grocery",
    quantity: { kind: "mass", amount: 500, unit: "g" },
    priceSignals: [{ raw: `GBP ${index + 1}.00`, currency: "GBP", amount: index + 1 }],
    sourceUrl: `https://${domain}/products/${index}`,
    imageUrl: `https://${domain}/images/${index}.jpg`,
    observedAt,
    extraction: "json-ld",
    confidence: "High",
    jsonLdType: "Product",
    ownership: "path-inferred",
  };
}

async function persistBundle(database, created, count, now, publicationForIndex = () => ({ priceEligible: true })) {
  const primary = Array.from({ length: count }, (_, index) => product("shop.example", index, now.toISOString()));
  const rivals = Array.from({ length: count }, (_, index) => product("rival.example", index, now.toISOString()));
  const comparison = {
    primaryDomain: "shop.example",
    comparisonDomains: ["rival.example"],
    rows: primary.map((item, index) => ({
      primary: item,
      matches: [{
        domain: "rival.example",
        product: rivals[index],
        score: 0.95,
        confidence: "High",
        sharedTerms: ["observed product"],
        claimIds: [`claim-${index}`],
        assessment: { method: "ai-hybrid", claimType: "Inferred", verdict: index < 60 ? "same_product" : "close_substitute", confidence: 0.95, model: "test-model", promptVersion: "test-v1", reasons: ["Observed identity aligns."], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "500g", primarySourceUrl: item.sourceUrl, rivalSourceUrl: rivals[index].sourceUrl },
        decision: { priceVerdict: "Observed comparison.", whyTheyMayWin: "Public price is visible.", recommendedMove: "Review the observed offer.", ...(index < 60 ? { priceComparison: { primaryRaw: item.priceSignals[0].raw, rivalRaw: rivals[index].priceSignals[0].raw } } : {}), actionPlan: { source: "deterministic", claimType: "Recommendation", actionEn: "Review the observed offer.", actionAr: "Review the observed offer.", rationaleEn: "Both sources are public.", rationaleAr: "Both sources are public.", leverType: "price", evidenceKeys: ["primary.price.0", "rival.price.0"], model: "", promptVersion: "" } },
        publication: publicationForIndex(index),
      }],
    })),
    unmatched: [],
    coverage: { primaryProductsAvailable: count, primaryProductsScanned: count, primaryProductFamiliesCompared: count, competitorProductsAvailable: count, competitorProductsScanned: count, assignedPairCount: count, verifiedPairCount: count, rowsReturned: count, rowLimit: count, truncated: false },
    matching: { primaryProductsAssessed: count },
  };
  const bundle = await buildReportFactBundle({
    publicId: created.publicId,
    crawlResults: [
      { domain: "shop.example", role: "primary", homepage: { sourceUrl: "https://shop.example/", title: "Shop" }, products: primary, fetchedAt: now.toISOString() },
      { domain: "rival.example", role: "discovered-competitor", homepage: { sourceUrl: "https://rival.example/", title: "Rival" }, products: rivals, fetchedAt: now.toISOString() },
    ],
    comparison,
    adBlock: null,
    observedAt: now.toISOString(),
  });
  for (const chunk of bundle.chunks) await saveReportFactChunk(created.publicId, chunk, now, database);
  await finalizeReportFactManifest(created.publicId, bundle.manifest, now, database);
  await saveReportDocument(created.publicId, { blocks: [{ type: "product-comparison", id: "products", ...comparison }] }, { status: "complete", expectedFactManifestHash: bundle.manifest.manifestHash }, now, database);
}

test("completed relational matches paginate without duplicates and preserve product evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-match-page-"));
  const database = await NodeSqliteDatabase.open(join(directory, "market-signal.sqlite"));
  try {
    const now = new Date("2026-08-08T18:00:00.000Z");
    const created = await createReportRun({ primaryDomain: "shop.example", entitlement: { plan: "agency", productLimit: 1_000 } }, now, database);
    await persistBundle(database, created, 105, now);

    const first = await loadStoredReportMatchPage(created.publicId, { limit: 100 }, database);
    assert.equal(first.authoritative, true);
    assert.equal(first.totalCount, 105);
    assert.equal(first.directPriceCount, 60);
    assert.deepEqual(first.domainCounts, { "rival.example": 105 });
    assert.equal(first.items.length, 100);
    assert.match(first.nextCursor, /^rival\.example~[a-f0-9]{64}$/);
    assert.ok(first.items.every((item) => item.primary.domain === "shop.example" && item.rival.domain === "rival.example"));
    assert.ok(first.items.every((item) => item.primary.imageUrl && item.rival.imageUrl && item.primary.priceSignals.length && item.rival.priceSignals.length));
    assert.ok(first.items.every((item) => item.match.assessment.reasons[0] === "Observed identity aligns." && item.match.decision.recommendedMove === "Review the observed offer."));

    const second = await loadStoredReportMatchPage(created.publicId, { limit: 100, cursor: first.nextCursor }, database);
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.key)).size, 105);
    assert.equal(first.items.some((item) => second.items.some((candidate) => candidate.key === item.key)), false);

    await assert.rejects(loadStoredReportMatchPage(created.publicId, { limit: 101 }, database), /page size/);
    await assert.rejects(loadStoredReportMatchPage(created.publicId, { cursor: "rival.example~bad" }, database), /cursor/);
    const incomplete = await createReportRun({ primaryDomain: "other.example" }, now, database);
    await assert.rejects(loadStoredReportMatchPage(incomplete.publicId, {}, database), /facts are unavailable/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public relational pagination fails closed for absent or explicitly ineligible publication decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-match-publication-"));
  const database = await NodeSqliteDatabase.open(join(directory, "market-signal.sqlite"));
  try {
    const now = new Date("2026-08-08T18:00:00.000Z");
    const created = await createReportRun({ primaryDomain: "shop.example", entitlement: { plan: "agency", productLimit: 1_000 } }, now, database);
    await persistBundle(database, created, 3, now, (index) => index === 0 ? { priceEligible: true } : index === 1 ? { priceEligible: false, reason: "incompatible-price-currency" } : undefined);

    const page = await loadStoredReportMatchPage(created.publicId, { limit: 100 }, database);

    assert.equal(page.totalCount, 1);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].primary.id, "shop.example-product-0");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("approved comparison products override stale crawl facts with the same product identity", async () => {
  const observedAt = "2026-08-08T18:00:00.000Z";
  const primary = product("shop.example", 0, observedAt);
  const approvedRival = product("rival.example", 0, observedAt);
  const staleRival = { ...approvedRival, priceSignals: [{ raw: "USD 12000", currency: "USD", amount: 12000 }], description: "stale".repeat(2_000) };
  const comparison = {
    primaryDomain: "shop.example",
    comparisonDomains: ["rival.example"],
    rows: [{ primary, matches: [{ domain: "rival.example", product: approvedRival, score: 0.95, confidence: "Medium", sharedTerms: ["observed"], claimIds: [], assessment: { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.95, model: "test", promptVersion: "test", reasons: ["same"], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "", primarySourceUrl: primary.sourceUrl, rivalSourceUrl: approvedRival.sourceUrl }, decision: null, publication: { priceEligible: true } }] }],
    unmatched: [],
    coverage: { primaryProductsAvailable: 1, primaryProductsScanned: 1, primaryProductFamiliesCompared: 1, competitorProductsAvailable: 1, competitorProductsScanned: 1, assignedPairCount: 1, verifiedPairCount: 1, rowsReturned: 1, rowLimit: 1, truncated: false },
  };

  const bundle = await buildReportFactBundle({ publicId: "f".repeat(32), crawlResults: [{ domain: "shop.example", role: "primary", products: [primary], fetchedAt: observedAt }, { domain: "rival.example", role: "discovered-competitor", products: [staleRival], fetchedAt: observedAt }], comparison, adBlock: null, observedAt });
  const rivalFact = bundle.chunks.filter((chunk) => chunk.kind === "products").flatMap((chunk) => chunk.items).find((item) => item.domain === "rival.example" && item.productId === approvedRival.id);

  assert.deepEqual(rivalFact.prices.map(({ currency, amount }) => ({ currency, amount })), [{ currency: "GBP", amount: 1 }]);
});
