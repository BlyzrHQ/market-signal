import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { loadRememberedCompetitors, rememberVerifiedCompetitors } from "../app/lib/competitor-memory.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { appendReportEvent, createReportRun, finalizeReportFactManifest, getStoredReport, recoverInterruptedReport, saveReportDocument, saveReportFactChunk } from "../app/lib/report-store.ts";
import { buildReportFactBundle, canonicalReportFact, reportFactHash } from "../src/shared/report-facts.ts";
import { closeRuntimeDatabases, runtimeDatabase } from "../app/lib/runtime-database.ts";
import { publicHttpUrl } from "../app/lib/public-url.ts";
import { officialAdRecordUrl } from "../app/lib/ad-intelligence.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-sqlite-"));
  return { directory, databasePath: join(directory, "market-signal.sqlite") };
}

const factHash = (kind, items) => reportFactHash(items.map((item) => canonicalReportFact(kind, item)));

test("report fact URLs reject intranet and non-global address variants", () => {
  for (const value of ["http://intranet/path", "http://127.0.0.1/", "http://169.254.1.1/", "http://10.0.0.1/", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://[fe80::1]/"]) {
    assert.throws(() => publicHttpUrl(value), /Invalid report fact URL/);
  }
  assert.equal(publicHttpUrl("https://shop.example/product"), "https://shop.example/product");
  assert.equal(officialAdRecordUrl("https://facebook.com/ads/libraryevil?id=123", "Meta"), "");
  assert.match(officialAdRecordUrl("https://facebook.com/ads/library/?id=123", "Meta"), /ads\/library/);
});

test("Node SQLite preserves reports and competitor memory after reopening", async () => {
  const { directory, databasePath } = await fixture();
  let database;
  try {
    database = await NodeSqliteDatabase.open(databasePath);
    const created = await createReportRun({ primaryDomain: "myjam.co.uk" }, new Date("2026-07-27T00:00:00.000Z"), database);
    await appendReportEvent(created.publicId, {
      idempotencyKey: "crawl-started",
      phase: "crawl",
      status: "running",
      message: "Collecting public pages.",
    }, new Date("2026-07-27T00:01:00.000Z"), database);
    await appendReportEvent(created.publicId, {
      idempotencyKey: "crawl-started",
      phase: "crawl",
      status: "running",
      message: "Duplicate transport retry.",
    }, new Date("2026-07-27T00:01:01.000Z"), database);
    await saveReportDocument(created.publicId, { blocks: [{ type: "summary", id: "summary", title: "Saved on the VPS" }] }, { status: "complete" }, new Date("2026-07-27T00:02:00.000Z"), database);
    const remembered = await rememberVerifiedCompetitors("myjam.co.uk", [{
      candidate: {
        domain: "oasismarket.co.uk",
        companyName: "Oasis Market",
        reason: "Observed overlapping halal grocery products.",
        searchQuery: "UK halal grocery products",
        sourceUrl: "https://oasismarket.co.uk/product/example",
        websiteUrl: "https://oasismarket.co.uk/",
        marketCategory: "halal grocery",
        relationship: "direct",
        sharedOfferings: ["halal grocery"],
        evidence: [{ url: "https://oasismarket.co.uk/product/example", title: "Example product", method: "product-search" }],
        mentionCount: 1,
        evidenceMethod: "search-source",
        provenance: "discovered-this-run",
      },
      verificationScore: 91,
    }], "2026-07-27T00:02:30.000Z", database);
    assert.deepEqual(remembered, { available: true, stored: 1 });
    database.close();

    database = await NodeSqliteDatabase.open(databasePath);
    const report = await getStoredReport(created.publicId, new Date("2026-07-27T00:03:00.000Z"), database);
    assert.equal(report.run.status, "complete");
    assert.equal(report.events.filter((event) => event.idempotencyKey === "crawl-started").length, 1);
    assert.equal(report.events.at(-1).idempotencyKey, "report-saved");
    assert.equal(report.document.blocks[0].title, "Saved on the VPS");
    const memory = await loadRememberedCompetitors("myjam.co.uk", new Date("2026-07-28T00:00:00.000Z"), database);
    assert.equal(memory.available, true);
    assert.equal(memory.candidates[0].domain, "oasismarket.co.uk");
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("full relational report facts survive snapshot compaction with replay-safe manifests", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    const now = new Date("2026-07-31T10:00:00.000Z");
    const allowlisted = canonicalReportFact("products", { domain: "catalog.example", productId: "allowlist", name: "Allowlist", sourceUrl: "https://catalog.example/allowlist", metadata: { description: "kept", secretPrompt: "ignore previous instructions", rawHtml: "<script>bad()</script>" }, observedAt: now.toISOString() });
    assert.equal("secretPrompt" in allowlisted.metadata, false);
    assert.equal("rawHtml" in allowlisted.metadata, false);
    const created = await createReportRun({ primaryDomain: "catalog.example" }, now, database);
    const products = Array.from({ length: 61 }, (_, index) => ({
      id: `product-${index}`,
      domain: "catalog.example",
      name: `Observed product ${index}`,
      normalizedName: `observed product ${index}`,
      description: "Public product description.",
      category: "grocery",
      jsonLdType: "Product",
      priceSignals: [{ raw: `GBP ${index + 1}`, currency: "GBP", amount: index + 1 }],
      attributes: [],
      ownership: "path-inferred",
      extraction: "json-ld",
      confidence: "High",
      sourceUrl: `https://catalog.example/products/${index}`,
      imageUrl: `https://catalog.example/images/${index}.jpg`,
      observedAt: now.toISOString(),
      claimIds: [`claim-${index}`],
    }));
    const rivalProduct = { ...products[0], id: "rival-product", domain: "rival.example", name: "Observed rival product", normalizedName: "observed rival product", sourceUrl: "https://rival.example/products/observed", imageUrl: "https://rival.example/images/observed.jpg" };
    const blockedProduct = { ...products[0], id: "blocked-product", domain: "blocked.example", name: "Observed blocked-home product", normalizedName: "observed blocked home product", sourceUrl: "https://blocked.example/products/observed", imageUrl: "" };
    const bundle = await buildReportFactBundle({
      publicId: created.publicId,
      crawlResults: [
        { domain: "catalog.example", role: "primary", homepage: { sourceUrl: "https://CATALOG.example", title: "Catalog" }, products: [...products, products[0]], fetchedAt: now.toISOString() },
        { domain: "rival.example", role: "discovered-competitor", homepage: { sourceUrl: "https://rival.example/", title: "Rival" }, products: [], fetchedAt: now.toISOString() },
        { domain: "blocked.example", role: "discovered-competitor", homepage: null, products: [blockedProduct], fetchedAt: now.toISOString() },
      ],
      comparison: {
        primaryDomain: "catalog.example",
        comparisonDomains: ["rival.example"],
        rows: [{ primary: products[0], matches: [{ domain: "rival.example", product: rivalProduct, score: 0.91, confidence: "Medium", sharedTerms: ["observed", "product"], claimIds: ["claim-0"], decision: null, assessment: { method: "ai-hybrid", claimType: "Inferred", verdict: "same_product", confidence: 0.91, model: "test-model", promptVersion: "test-v1", reasons: ["Observed identity aligns."], contradictions: [], normalizedCategory: "grocery", normalizedVariant: "", normalizedSize: "", primarySourceUrl: products[0].sourceUrl, rivalSourceUrl: rivalProduct.sourceUrl } }] }],
        unmatched: [],
        coverage: { primaryProductsAvailable: 61, primaryProductsScanned: 61, primaryProductFamiliesCompared: 1, competitorProductsAvailable: 1, competitorProductsScanned: 1, assignedPairCount: 1, verifiedPairCount: 1, rowsReturned: 1, rowLimit: 30, truncated: false },
      },
      adBlock: { observedAt: now.toISOString(), companies: [{ domain: "rival.example", platforms: [{ platform: "Meta", status: "verified-active", creativeConcepts: [{ id: "meta-1", evidenceUrl: "https://www.facebook.com/ads/library/?id=1", pageId: "1", pageName: "Rival", message: "Observed offer", headline: "Shop", placementCount: 1, platforms: ["facebook"], languages: ["en"], countries: ["GB"] }, { id: "meta-1", evidenceUrl: "https://www.facebook.com/ads/library/?id=1", pageId: "1", pageName: "Rival" }] }, { platform: "Google", status: "no-verified-result", creativeConcepts: [] }] }] },
      observedAt: now.toISOString(),
    });
    assert.deepEqual(bundle.manifest.counts, { companies: 3, products: 63, matches: 1, ads: 1 });
    assert.equal(bundle.chunks.filter((chunk) => chunk.kind === "products").length, 2);
    const first = bundle.chunks[0];
    await saveReportFactChunk(created.publicId, first, now, database);
    const changedItems = first.items.map((item, index) => index ? item : { ...item, companyName: "Conflicting company" });
    await assert.rejects(saveReportFactChunk(created.publicId, { ...first, items: changedItems, contentHash: await factHash(first.kind, changedItems) }, now, database), /replay conflicts/);
    assert.equal((await database.prepare("SELECT company_name FROM report_companies WHERE domain = 'catalog.example'").all()).results[0].company_name, "Catalog");
    for (const chunk of bundle.chunks.slice(1)) await saveReportFactChunk(created.publicId, chunk, now, database);
    await assert.rejects(finalizeReportFactManifest(created.publicId, { ...bundle.manifest, manifestHash: "0".repeat(64) }, now, database), /hash does not match/);
    await assert.rejects(finalizeReportFactManifest(created.publicId, { ...bundle.manifest, counts: { ...bundle.manifest.counts, products: 999 } }, now, database), /incomplete|inconsistent/);
    const replay = await saveReportFactChunk(created.publicId, bundle.chunks[0], now, database);
    assert.equal(replay.replayed, true);
    const finalized = await finalizeReportFactManifest(created.publicId, bundle.manifest, now, database);
    assert.equal(finalized.replayed, false);
    assert.equal((await finalizeReportFactManifest(created.publicId, bundle.manifest, now, database)).replayed, true);
    assert.equal((await saveReportFactChunk(created.publicId, bundle.chunks[0], now, database)).replayed, true);
    await saveReportDocument(created.publicId, { blocks: [{ type: "product-catalog", id: "catalog", products }] }, { status: "complete" }, now, database);
    const savedProducts = await database.prepare("SELECT COUNT(*) AS count FROM report_products").all();
    const savedMatches = await database.prepare("SELECT COUNT(*) AS count FROM report_matches").all();
    const savedAds = await database.prepare("SELECT COUNT(*) AS count FROM report_ads").all();
    const snapshot = await database.prepare("SELECT document_json FROM report_documents").all();
    assert.equal(savedProducts.results[0].count, 63);
    assert.equal(savedMatches.results[0].count, 1);
    assert.equal(savedAds.results[0].count, 1);
    assert.equal(JSON.parse(snapshot.results[0].document_json).blocks[0].products.length, 40);
    await assert.rejects(saveReportFactChunk(created.publicId, { ...bundle.chunks[0], contentHash: "0".repeat(64) }, now, database), /hash does not match/);
    const terminalCompany = [{ domain: "catalog.example", role: "primary", companyName: "Catalog", evidenceUrl: "https://catalog.example/", evidence: {}, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(created.publicId, { manifestId: "d".repeat(64), kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", terminalCompany), items: terminalCompany }, now, database), /terminal report/);
    const collisionRun = await createReportRun({ primaryDomain: "collision.example" }, now, database);
    const collisionCompanies = [{ domain: "collision.example", role: "primary", companyName: "Collision", evidenceUrl: "https://collision.example/", evidence: {}, observedAt: now.toISOString() }, { domain: "rival.example", role: "discovered-competitor", companyName: "Rival", evidenceUrl: "https://rival.example/", evidence: {}, observedAt: now.toISOString() }];
    const collisionManifest = "c".repeat(64);
    await saveReportFactChunk(collisionRun.publicId, { manifestId: collisionManifest, kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", collisionCompanies), items: collisionCompanies }, now, database);
    const savedAd = (await database.prepare("SELECT id, evidence_json FROM report_ads LIMIT 1").all()).results[0];
    const collidingAd = [{ id: savedAd.id, domain: "rival.example", platform: "Meta", status: "verified-active", evidence: JSON.parse(savedAd.evidence_json), observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(collisionRun.publicId, { manifestId: collisionManifest, kind: "ads", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("ads", collidingAd), items: collidingAd }, now, database), /not attributable to this report/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial manifests can be atomically superseded while invalid domains and references fail closed", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    const now = new Date("2026-07-31T11:00:00.000Z");
    const created = await createReportRun({ primaryDomain: "shop.example" }, now, database);
    const oldItems = [{ domain: "shop.example", role: "primary", companyName: "Shop", evidenceUrl: "https://shop.example/", evidence: {}, observedAt: now.toISOString() }, { domain: "old.example", role: "discovered-competitor", companyName: "Old", evidenceUrl: "https://old.example/", evidence: {}, observedAt: now.toISOString() }];
    await saveReportFactChunk(created.publicId, { manifestId: "1".repeat(64), kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", oldItems), items: oldItems }, now, database);
    const product = { id: "p1", domain: "shop.example", name: "Honey", normalizedName: "honey", description: "", category: "honey", jsonLdType: "Product", priceSignals: [], attributes: [], ownership: "path-inferred", extraction: "json-ld", confidence: "High", sourceUrl: "https://shop.example/products/honey", imageUrl: "", observedAt: now.toISOString(), claimIds: [] };
    await database.prepare("UPDATE report_runs SET attempt_count = 2 WHERE public_id = ?").bind(created.publicId).run();
    await assert.rejects(saveReportFactChunk(created.publicId, { manifestId: "1".repeat(64), attemptNumber: 1, kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", oldItems), items: oldItems }, now, database), /stale/);
    const crawlResults = [{ domain: "shop.example", role: "primary", homepage: { sourceUrl: "https://shop.example/" }, products: [product], fetchedAt: now.toISOString() }];
    const bundle = await buildReportFactBundle({ publicId: created.publicId, crawlResults, comparison: null, adBlock: null, observedAt: now.toISOString(), attemptNumber: 2 });
    const retriedBundle = await buildReportFactBundle({ publicId: created.publicId, crawlResults, comparison: null, adBlock: null, observedAt: "2026-08-01T00:00:00.000Z", attemptNumber: 2 });
    assert.equal(retriedBundle.manifest.manifestId, bundle.manifest.manifestId);
    for (const chunk of bundle.chunks) await saveReportFactChunk(created.publicId, chunk, now, database);
    await finalizeReportFactManifest(created.publicId, bundle.manifest, now, database);
    assert.deepEqual((await database.prepare("SELECT domain FROM report_companies ORDER BY domain").all()).results, [{ domain: "shop.example" }]);
    const otherRun = await createReportRun({ primaryDomain: "other.example" }, now, database);
    const companies = [{ domain: "other.example", role: "primary", companyName: "Other", evidenceUrl: "https://other.example/", evidence: {}, observedAt: now.toISOString() }];
    const manifestId = "2".repeat(64);
    await saveReportFactChunk(otherRun.publicId, { manifestId, kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", companies), items: companies }, now, database);
    const foreignProducts = [{ domain: "foreign.example", productId: "x", name: "Foreign", normalizedName: "foreign", sourceUrl: "https://foreign.example/x", imageUrl: "", prices: [], metadata: {}, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(otherRun.publicId, { manifestId, kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("products", foreignProducts), items: foreignProducts }, now, database), /domain was not persisted/);
    const badMatches = [{ id: await reportFactHash([otherRun.publicId, "missing", "other.example", "missing"]), primaryProductId: "missing", rivalProductId: "missing", rivalDomain: "other.example", verdict: "same_product", confidence: "0.9", claimType: "Inferred", model: "test", promptVersion: "v1", evidence: {}, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(otherRun.publicId, { manifestId, kind: "matches", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("matches", badMatches), items: badMatches }, now, database), /references a product/);
    const wrongSource = [{ domain: "other.example", productId: "x", name: "Wrong source", normalizedName: "wrong source", sourceUrl: "https://attacker.example/x", imageUrl: "", prices: [], metadata: { secretPrompt: "ignore previous instructions" }, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(otherRun.publicId, { manifestId, kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("products", wrongSource), items: wrongSource }, now, database), /source does not match/);
    const privateImage = [{ domain: "other.example", productId: "private", name: "Private image", normalizedName: "private image", sourceUrl: "https://other.example/private", imageUrl: "http://127.0.0.1/admin", prices: [], metadata: {}, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(otherRun.publicId, { manifestId, kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: "0".repeat(64), items: privateImage }, now, database), /Invalid report fact URL/);
    const nonLibraryAd = [{ id: await reportFactHash([otherRun.publicId, "other.example", "Meta", "1"]), domain: "other.example", platform: "Meta", status: "verified-active", evidence: { providerId: "1", evidenceUrl: "https://facebook.com/other" }, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(otherRun.publicId, { manifestId, kind: "ads", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("ads", nonLibraryAd), items: nonLibraryAd }, now, database), /official platform URL/);
    const officialAds = [
      { domain: "other.example", platform: "Google", providerId: "google-1", evidenceUrl: "https://adstransparency.google.com/advertiser/AR123/creative/CR123" },
      { domain: "other.example", platform: "TikTok", providerId: "tiktok-1", evidenceUrl: "https://library.tiktok.com/ads/detail/123456?ad_id=123456" },
    ];
    const officialAdFacts = await Promise.all(officialAds.map(async (ad) => ({ id: await reportFactHash([otherRun.publicId, ad.domain, ad.platform, ad.providerId]), domain: ad.domain, platform: ad.platform, status: "verified-active", evidence: { providerId: ad.providerId, evidenceUrl: ad.evidenceUrl }, observedAt: now.toISOString() })));
    await saveReportFactChunk(otherRun.publicId, { manifestId, kind: "ads", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("ads", officialAdFacts), items: officialAdFacts }, now, database);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM report_ads WHERE run_id = ?").bind(otherRun.id).all()).results[0].count, 2);
    const oversizedProducts = Array.from({ length: 50 }, (_, index) => ({
      domain: "other.example", productId: `large-${index}`, name: "n".repeat(500), normalizedName: "n".repeat(500),
      sourceUrl: `https://other.example/products/${index}/${"s".repeat(1_800)}`, imageUrl: `https://cdn.example/images/${index}/${"i".repeat(1_800)}`,
      prices: Array.from({ length: 12 }, () => ({ raw: "p".repeat(500), currency: "GBP", amount: 10 })),
      metadata: { description: "d".repeat(8_000), attributes: Array.from({ length: 25 }, () => "a".repeat(240)) }, observedAt: now.toISOString(),
    }));
    const canonicalOversized = oversizedProducts.map((item) => canonicalReportFact("products", item));
    assert.ok(new TextEncoder().encode(JSON.stringify(canonicalOversized)).byteLength > 1_000_000);
    await assert.rejects(saveReportFactChunk(otherRun.publicId, { manifestId, kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: await reportFactHash(canonicalOversized), items: oversizedProducts }, now, database), /canonical content is too large/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent exact chunk callbacks remain idempotent and a finalizing lock blocks mutations", async () => {
  const { directory, databasePath } = await fixture();
  const first = await NodeSqliteDatabase.open(databasePath);
  const second = await NodeSqliteDatabase.open(databasePath);
  try {
    const now = new Date("2026-07-31T11:30:00.000Z");
    const created = await createReportRun({ primaryDomain: "race.example" }, now, first);
    const items = [{ domain: "race.example", role: "primary", companyName: "Race", evidenceUrl: "https://race.example/", evidence: {}, observedAt: now.toISOString() }];
    const chunk = { manifestId: "a".repeat(64), attemptNumber: 1, kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", items), items };
    const results = await Promise.allSettled([saveReportFactChunk(created.publicId, chunk, now, first), saveReportFactChunk(created.publicId, chunk, now, second)]);
    assert.ok(results.every((result) => result.status === "fulfilled"));
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_fact_chunks").all()).results[0].count, 1);
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_companies").all()).results[0].count, 1);
    const staleRun = await createReportRun({ primaryDomain: "stale-race.example" }, now, first);
    const staleItems = [{ domain: "stale-race.example", role: "primary", companyName: "Stale", evidenceUrl: "https://stale-race.example/", evidence: {}, observedAt: now.toISOString() }];
    const staleChunk = { manifestId: "c".repeat(64), attemptNumber: 1, kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", staleItems), items: staleItems };
    let advancedAttempt = false;
    const racingDatabase = {
      prepare: (query) => first.prepare(query),
      batch: async (statements) => {
        if (!advancedAttempt) {
          advancedAttempt = true;
          await second.prepare("UPDATE report_runs SET attempt_count = 2 WHERE public_id = ?").bind(staleRun.publicId).run();
        }
        return first.batch(statements);
      },
    };
    await assert.rejects(saveReportFactChunk(staleRun.publicId, staleChunk, now, racingDatabase), /replay conflicts/);
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_fact_chunks JOIN report_runs ON report_runs.id = report_fact_chunks.run_id WHERE report_runs.public_id = ?").bind(staleRun.publicId).all()).results[0].count, 0);
    await first.prepare("INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) SELECT id, ?, 1, ?, 1, 0, 0, 0, 'finalizing', 'test-lock', ?, '' FROM report_runs WHERE public_id = ?").bind(chunk.manifestId, "b".repeat(64), now.toISOString(), created.publicId).run();
    const productItems = [{ domain: "race.example", productId: "p1", name: "Race product", normalizedName: "race product", sourceUrl: "https://race.example/p1", imageUrl: "", prices: [], metadata: {}, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(created.publicId, { ...chunk, kind: "products", contentHash: await factHash("products", productItems), items: productItems }, now, first), /immutable/);
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_products").all()).results[0].count, 0);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent finalizers cannot delete or overwrite another owner's manifest lock", async () => {
  const { directory, databasePath } = await fixture();
  const first = await NodeSqliteDatabase.open(databasePath);
  const second = await NodeSqliteDatabase.open(databasePath);
  try {
    const now = new Date("2026-07-31T11:45:00.000Z");
    const created = await createReportRun({ primaryDomain: "finalize-race.example" }, now, first);
    const bundle = await buildReportFactBundle({ publicId: created.publicId, crawlResults: [{ domain: "finalize-race.example", role: "primary", homepage: { sourceUrl: "https://finalize-race.example/" }, products: [], fetchedAt: now.toISOString() }], comparison: null, adBlock: null, observedAt: now.toISOString(), attemptNumber: 1 });
    for (const chunk of bundle.chunks) await saveReportFactChunk(created.publicId, chunk, now, first);
    let validationStarted;
    let releaseValidation;
    const started = new Promise((resolve) => { validationStarted = resolve; });
    const release = new Promise((resolve) => { releaseValidation = resolve; });
    const failingOwner = {
      prepare: (query) => {
        if (query.startsWith("SELECT kind, chunk_index")) return {
          bind() { return this; },
          async all() {
            validationStarted();
            await release;
            throw new Error("injected owner validation failure");
          },
        };
        return first.prepare(query);
      },
      batch: (statements) => first.batch(statements),
    };
    const firstFinalize = finalizeReportFactManifest(created.publicId, bundle.manifest, now, failingOwner);
    await started;
    const secondFinalize = await finalizeReportFactManifest(created.publicId, bundle.manifest, now, second);
    assert.equal(secondFinalize.replayed, false);
    releaseValidation();
    await assert.rejects(firstFinalize, /injected owner validation failure/);
    const manifest = (await first.prepare("SELECT status, lock_owner FROM report_fact_manifests").all()).results[0];
    assert.deepEqual(manifest, { status: "complete", lock_owner: "" });

    const staleRun = await createReportRun({ primaryDomain: "stale-finalize.example" }, now, first);
    const staleBundle = await buildReportFactBundle({ publicId: staleRun.publicId, crawlResults: [{ domain: "stale-finalize.example", role: "primary", homepage: { sourceUrl: "https://stale-finalize.example/" }, products: [], fetchedAt: now.toISOString() }], comparison: null, adBlock: null, observedAt: now.toISOString(), attemptNumber: 1 });
    for (const chunk of staleBundle.chunks) await saveReportFactChunk(staleRun.publicId, chunk, now, first);
    let attemptAdvanced = false;
    const staleFinalizer = {
      prepare: (query) => {
        const statement = first.prepare(query);
        if (!query.startsWith("INSERT INTO report_fact_manifests")) return statement;
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              async run() {
                if (!attemptAdvanced) {
                  attemptAdvanced = true;
                  await second.prepare("UPDATE report_runs SET attempt_count = 2 WHERE public_id = ?").bind(staleRun.publicId).run();
                }
                return bound.run();
              },
            };
          },
        };
      },
      batch: (statements) => first.batch(statements),
    };
    await assert.rejects(finalizeReportFactManifest(staleRun.publicId, staleBundle.manifest, now, staleFinalizer), /acquire its lock/);
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_fact_manifests JOIN report_runs ON report_runs.id = report_fact_manifests.run_id WHERE report_runs.public_id = ?").bind(staleRun.publicId).all()).results[0].count, 0);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale workers cannot append progress or terminalize a recovered report during a callback race", async () => {
  const { directory, databasePath } = await fixture();
  const first = await NodeSqliteDatabase.open(databasePath);
  const second = await NodeSqliteDatabase.open(databasePath);
  try {
    const now = new Date("2026-07-31T11:50:00.000Z");
    const created = await createReportRun({ primaryDomain: "callback-race.example" }, now, first);
    let nextAttempt = 2;
    const racingDatabase = {
      prepare: (query) => first.prepare(query),
      batch: async (statements) => {
        await second.prepare("UPDATE report_runs SET attempt_count = ? WHERE public_id = ?").bind(nextAttempt, created.publicId).run();
        return first.batch(statements);
      },
    };
    await assert.rejects(appendReportEvent(created.publicId, { attemptNumber: 1, idempotencyKey: "stale-event", phase: "crawl", status: "running", message: "stale" }, now, racingDatabase), /stale/);
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_events WHERE idempotency_key = 'stale-event'").all()).results[0].count, 0);
    nextAttempt = 3;
    await assert.rejects(saveReportDocument(created.publicId, { blocks: [] }, { attemptNumber: 2, status: "complete" }, now, racingDatabase), /stale/);
    assert.equal((await first.prepare("SELECT COUNT(*) AS count FROM report_documents").all()).results[0].count, 0);
    assert.equal((await first.prepare("SELECT status, attempt_count FROM report_runs WHERE public_id = ?").bind(created.publicId).all()).results[0].status, "queued");
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replayed recovery cannot delete the new attempt's finalization lock", async () => {
  const { directory, databasePath } = await fixture();
  const first = await NodeSqliteDatabase.open(databasePath);
  const second = await NodeSqliteDatabase.open(databasePath);
  try {
    const createdAt = new Date("2026-07-31T10:00:00.000Z");
    const created = await createReportRun({ primaryDomain: "recovery-race.example" }, createdAt, first);
    await appendReportEvent(created.publicId, { attemptNumber: 1, idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "running" }, new Date("2026-07-31T10:01:00.000Z"), first);
    await getStoredReport(created.publicId, new Date("2026-07-31T10:20:00.000Z"), first);
    const runId = (await first.prepare("SELECT id FROM report_runs WHERE public_id = ?").bind(created.publicId).all()).results[0].id;
    await first.prepare("INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) VALUES (?, ?, 1, ?, 0, 0, 0, 0, 'finalizing', 'old', ?, '')").bind(runId, "1".repeat(64), "2".repeat(64), createdAt.toISOString()).run();
    let raced = false;
    const staleRecovery = {
      prepare: (query) => first.prepare(query),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await recoverInterruptedReport(created.publicId, new Date("2026-07-31T10:21:00.000Z"), second);
          await second.prepare("INSERT INTO report_fact_manifests (run_id, manifest_id, attempt_number, manifest_hash, company_count, product_count, match_count, ad_count, status, lock_owner, locked_at, completed_at) VALUES (?, ?, 2, ?, 0, 0, 0, 0, 'finalizing', 'new', ?, '')").bind(runId, "3".repeat(64), "4".repeat(64), createdAt.toISOString()).run();
          await second.prepare("UPDATE report_runs SET status = 'interrupted', current_phase = 'interrupted' WHERE id = ? AND attempt_count = 2").bind(runId).run();
        }
        return first.batch(statements);
      },
    };
    await assert.rejects(recoverInterruptedReport(created.publicId, new Date("2026-07-31T10:21:01.000Z"), staleRecovery), /recovery attempt is stale/);
    const manifest = (await first.prepare("SELECT attempt_number, lock_owner FROM report_fact_manifests WHERE run_id = ?").bind(runId).all()).results[0];
    assert.deepEqual(manifest, { attempt_number: 2, lock_owner: "new" });
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale detection cannot interrupt a worker that refreshed its heartbeat concurrently", async () => {
  const { directory, databasePath } = await fixture();
  const first = await NodeSqliteDatabase.open(databasePath);
  const second = await NodeSqliteDatabase.open(databasePath);
  try {
    const createdAt = new Date("2026-07-31T09:00:00.000Z");
    const created = await createReportRun({ primaryDomain: "heartbeat-race.example" }, createdAt, first);
    await appendReportEvent(created.publicId, { attemptNumber: 1, idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "start" }, new Date("2026-07-31T09:01:00.000Z"), first);
    let refreshed = false;
    const racingRead = {
      prepare: (query) => first.prepare(query),
      batch: async (statements) => {
        if (!refreshed) {
          refreshed = true;
          await appendReportEvent(created.publicId, { attemptNumber: 1, idempotencyKey: "crawl-heartbeat", phase: "crawl", status: "running", message: "fresh" }, new Date("2026-07-31T09:20:00.000Z"), second);
        }
        return first.batch(statements);
      },
    };
    const report = await getStoredReport(created.publicId, new Date("2026-07-31T09:20:01.000Z"), racingRead);
    assert.equal(report.run.status, "running");
    assert.equal(report.events.some((event) => event.idempotencyKey === "stale-worker-interrupted"), false);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest finalization rejects missing chunks and conflicting completed replay", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const created = await createReportRun({ primaryDomain: "large.example" }, now, database);
    const sparse = { id: "same", domain: "large.example", name: "Same", normalizedName: "same", description: "", category: "", jsonLdType: "Product", priceSignals: [], attributes: [], ownership: "path-inferred", extraction: "json-ld", confidence: "Medium", sourceUrl: "https://large.example/p/same", imageUrl: "", observedAt: now.toISOString(), claimIds: [] };
    const rich = { ...sparse, description: "Observed rich description", priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }], imageUrl: "https://large.example/images/same.jpg", confidence: "High" };
    const ordered = await buildReportFactBundle({ publicId: created.publicId, crawlResults: [{ domain: "large.example", role: "primary", homepage: { sourceUrl: "https://large.example/" }, products: [sparse, rich] }], comparison: null, adBlock: null, observedAt: now.toISOString() });
    const reversed = await buildReportFactBundle({ publicId: created.publicId, crawlResults: [{ domain: "large.example", role: "primary", homepage: { sourceUrl: "https://large.example/" }, products: [rich, sparse] }], comparison: null, adBlock: null, observedAt: now.toISOString() });
    assert.equal(ordered.manifest.manifestId, reversed.manifest.manifestId);
    const selected = ordered.chunks.find((chunk) => chunk.kind === "products").items[0];
    assert.equal(selected.imageUrl, rich.imageUrl);
    assert.equal(selected.prices[0].amount, 10);
    const products = Array.from({ length: 51 }, (_, index) => ({ id: `p${index}`, domain: "large.example", name: `P ${index}`, normalizedName: `p ${index}`, description: "", category: "", jsonLdType: "Product", priceSignals: [], attributes: [], ownership: "path-inferred", extraction: "json-ld", confidence: "High", sourceUrl: `https://large.example/p/${index}`, imageUrl: "", observedAt: now.toISOString(), claimIds: [] }));
    const bundle = await buildReportFactBundle({ publicId: created.publicId, crawlResults: [{ domain: "large.example", role: "primary", homepage: { sourceUrl: "https://large.example/" }, products }], comparison: null, adBlock: null, observedAt: now.toISOString() });
    for (const chunk of bundle.chunks.filter((chunk) => !(chunk.kind === "products" && chunk.chunkIndex === 1))) await saveReportFactChunk(created.publicId, chunk, now, database);
    await assert.rejects(finalizeReportFactManifest(created.publicId, bundle.manifest, now, database), /incomplete or inconsistent/);
    const missing = bundle.chunks.find((chunk) => chunk.kind === "products" && chunk.chunkIndex === 1);
    await saveReportFactChunk(created.publicId, missing, now, database);
    await finalizeReportFactManifest(created.publicId, bundle.manifest, now, database);
    await assert.rejects(finalizeReportFactManifest(created.publicId, { ...bundle.manifest, manifestHash: "f".repeat(64) }, now, database), /manifest replay conflicts/);
    const replacementCompanies = [{ domain: "large.example", role: "primary", companyName: "Changed", evidenceUrl: "https://large.example/", evidence: {}, observedAt: now.toISOString() }];
    await assert.rejects(saveReportFactChunk(created.publicId, { manifestId: "e".repeat(64), kind: "companies", chunkIndex: 0, chunkCount: 1, contentHash: await factHash("companies", replacementCompanies), items: replacementCompanies }, now, database), /immutable/);
    const bulkyProducts = products.slice(0, 50).map((product) => ({ ...product, description: "x".repeat(14_000), priceSignals: [{ raw: "y".repeat(7_000) }] }));
    const bulky = await buildReportFactBundle({ publicId: "b".repeat(32), crawlResults: [{ domain: "large.example", role: "primary", homepage: { sourceUrl: "https://large.example/" }, products: bulkyProducts }], comparison: null, adBlock: null, observedAt: now.toISOString() });
    const productChunks = bulky.chunks.filter((chunk) => chunk.kind === "products");
    assert.ok(productChunks.length > 1);
    assert.ok(productChunks.every((chunk) => new TextEncoder().encode(JSON.stringify(chunk)).byteLength <= 250_000));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node SQLite configures WAL and rolls back a failed batch atomically", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    const journal = await database.prepare("PRAGMA journal_mode").all();
    const foreignKeys = await database.prepare("PRAGMA foreign_keys").all();
    const busyTimeout = await database.prepare("PRAGMA busy_timeout").all();
    assert.equal(journal.results[0].journal_mode, "wal");
    assert.equal(foreignKeys.results[0].foreign_keys, 1);
    assert.equal(busyTimeout.results[0].timeout, 10_000);

    await database.prepare("CREATE TABLE atomic_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)").run();
    await assert.rejects(database.batch([
      database.prepare("INSERT INTO atomic_probe (id, value) VALUES (?, ?)").bind(1, "first"),
      database.prepare("INSERT INTO atomic_probe (id, value) VALUES (?, ?)").bind(1, "duplicate"),
    ]), /UNIQUE constraint failed/);
    const rows = await database.prepare("SELECT id, value FROM atomic_probe").all();
    assert.deepEqual(rows.results, []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node SQLite rejects relative paths and statements prepared by another connection", async () => {
  await assert.rejects(NodeSqliteDatabase.open("./market-signal.sqlite"), /absolute filesystem path/);
  const firstFixture = await fixture();
  const secondFixture = await fixture();
  const first = await NodeSqliteDatabase.open(firstFixture.databasePath);
  const second = await NodeSqliteDatabase.open(secondFixture.databasePath);
  try {
    await assert.rejects(first.batch([second.prepare("CREATE TABLE wrong_connection (id INTEGER)")]), /same Node adapter/);
  } finally {
    first.close();
    second.close();
    await rm(firstFixture.directory, { recursive: true, force: true });
    await rm(secondFixture.directory, { recursive: true, force: true });
  }
});

test("two SQLite connections complete a write after real lock contention", async () => {
  const { directory, databasePath } = await fixture();
  const database = await NodeSqliteDatabase.open(databasePath);
  try {
    await database.prepare("CREATE TABLE contention_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)").run();
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require("better-sqlite3");
      const database = new Database(workerData.databasePath);
      database.pragma("busy_timeout = 10000");
      database.exec("BEGIN IMMEDIATE");
      database.prepare("INSERT INTO contention_probe (id, value) VALUES (?, ?)").run(1, "worker");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
        parentPort.postMessage("committed");
      }, 150);
    `, { eval: true, workerData: { databasePath } });
    assert.deepEqual(await once(worker, "message"), ["locked"]);
    await database.batch([
      database.prepare("INSERT INTO contention_probe (id, value) VALUES (?, ?)").bind(2, "main"),
    ]);
    assert.deepEqual(await once(worker, "message"), ["committed"]);
    await once(worker, "exit");
    const rows = await database.prepare("SELECT id, value FROM contention_probe ORDER BY id").all();
    assert.deepEqual(rows.results, [{ id: 1, value: "worker" }, { id: 2, value: "main" }]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MARKET_SIGNAL_SQLITE_PATH selects durable SQLite without a database override", async () => {
  const { directory, databasePath } = await fixture();
  const previousPath = process.env.MARKET_SIGNAL_SQLITE_PATH;
  process.env.MARKET_SIGNAL_SQLITE_PATH = databasePath;
  try {
    const firstConnection = await runtimeDatabase();
    process.env.MARKET_SIGNAL_SQLITE_PATH = `${directory}${sep}.${sep}market-signal.sqlite`;
    const equivalentConnection = await runtimeDatabase();
    assert.equal(equivalentConnection, firstConnection);
    const created = await createReportRun({ primaryDomain: "noororganic.com" }, new Date("2026-07-27T02:00:00.000Z"));
    const stored = await getStoredReport(created.publicId, new Date("2026-07-27T02:01:00.000Z"));
    assert.equal(stored.run.primaryDomain, "noororganic.com");
    assert.equal(stored.run.status, "queued");
  } finally {
    await closeRuntimeDatabases();
    if (previousPath === undefined) delete process.env.MARKET_SIGNAL_SQLITE_PATH;
    else process.env.MARKET_SIGNAL_SQLITE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("competitor memory degrades safely when the SQLite path is invalid", async () => {
  const previousPath = process.env.MARKET_SIGNAL_SQLITE_PATH;
  process.env.MARKET_SIGNAL_SQLITE_PATH = "./relative.sqlite";
  try {
    const memory = await loadRememberedCompetitors("myjam.co.uk");
    assert.equal(memory.available, false);
    assert.deepEqual(memory.candidates, []);
    assert.match(memory.gap, /not configured/i);
  } finally {
    await closeRuntimeDatabases();
    if (previousPath === undefined) delete process.env.MARKET_SIGNAL_SQLITE_PATH;
    else process.env.MARKET_SIGNAL_SQLITE_PATH = previousPath;
  }
});
