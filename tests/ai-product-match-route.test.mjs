import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMatchHandler, MAX_MATCH_BODY_BYTES, parseCatalogs, parsePinnedPairs, persistedCheckpointIndex, productAnalysisBudgetMs, productAnalysisConcurrency, productAnalysisLimit, productBackfillPoolSize } from "../app/api/match/route.ts";

test("matching checkpoints have disjoint task-attempt namespaces", () => {
  assert.equal(persistedCheckpointIndex(1, 0), 1_400);
  assert.equal(persistedCheckpointIndex(1, 249), 1_649);
  assert.equal(persistedCheckpointIndex(2, 0), 1_650);
  assert.equal(persistedCheckpointIndex(10, 249), 3_899);
  assert.equal(persistedCheckpointIndex(1, 999), 3_900);
  assert.equal(persistedCheckpointIndex(10, 999), 3_909);
  assert.throws(() => persistedCheckpointIndex(1, 250), /exceeds/i);
});

test("AI matching input keeps a broad but bounded first-party catalog", () => {
  const products = Array.from({ length: 605 }, (_, index) => ({
    id: `p${index}`,
    domain: "shop.test",
    name: `Product ${index}`,
    normalizedName: `product ${index}`,
    description: "Public product description",
    category: "grocery",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://shop.test/products/${index}`,
    imageUrl: "https://cdn.shopify.com/public-product.jpg",
    observedAt: "2026-07-15T00:00:00.000Z",
    claimIds: [`claim-${index}`],
  }));
  products.push({ ...products[0], id: "external", sourceUrl: "https://external.test/products/0" });

  const catalogs = parseCatalogs([{ domain: "shop.test", products }]);

  assert.equal(catalogs.length, 1);
  assert.equal(catalogs[0].products.length, 605);
  assert.equal(catalogs[0].products[0].imageUrl, "https://cdn.shopify.com/public-product.jpg");
  assert.ok(catalogs[0].products.every((product) => new URL(product.sourceUrl).hostname === "shop.test"));
});

test("AI matching keeps up to 1,000 first-party products while rival catalogs remain bounded", () => {
  const product = (index, domain) => ({ name: `Product ${index}`, sourceUrl: `https://${domain}/products/${index}` });
  const primary = Array.from({ length: 1_010 }, (_, index) => product(index, "shop.test"));
  const rival = Array.from({ length: 700 }, (_, index) => product(index, "rival.test"));
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: primary },
    { domain: "rival.test", products: rival },
  ], "shop.test");

  assert.equal(catalogs[0].products.length, 1_000);
  assert.equal(catalogs[1].products.length, 700);
});

test("product analysis limits are server-controlled, clamped, and receive scaled budgets", () => {
  assert.equal(productAnalysisLimit(undefined), 20);
  assert.equal(productAnalysisLimit("0"), 20);
  assert.equal(productAnalysisLimit("50"), 50);
  assert.equal(productAnalysisLimit("500"), 500);
  assert.equal(productAnalysisLimit("1000"), 1_000);
  assert.equal(productAnalysisLimit("5000"), 20);
  assert.equal(productAnalysisBudgetMs(20), 90_000);
  assert.equal(productAnalysisBudgetMs(60), 90_000);
  assert.equal(productAnalysisBudgetMs(500), 360_000);
  assert.equal(productAnalysisBudgetMs(1_000), 720_000);
  assert.equal(productAnalysisConcurrency(20), 3);
  assert.equal(productAnalysisConcurrency(500), 6);
  assert.equal(productAnalysisConcurrency(1_000), 12);
  const worstEmbeddingWaves = Math.ceil(Math.ceil(4_000 / 256) / productAnalysisConcurrency(1_000));
  const worstJudgeWaves = Math.ceil(Math.ceil((1_000 * 5) / 25) / productAnalysisConcurrency(1_000));
  assert.ok((worstEmbeddingWaves + worstJudgeWaves) * 35_000 < productAnalysisBudgetMs(1_000));
  assert.equal(productBackfillPoolSize(20), 1_000);
  assert.equal(productBackfillPoolSize(50), 1_000);
  assert.equal(productBackfillPoolSize(500), 1_000);
  assert.equal(productBackfillPoolSize(1_000), 1_000);
});

test("catalog bounds retain valid pinned records beyond both ordinary limits", () => {
  const records = (count, domain, prefix) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, name: `Product ${index}`, sourceUrl: `https://${domain}/products/${index}` }));
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: records(1_010, "shop.test", "p") },
    { domain: "rival.test", products: records(610, "rival.test", "r") },
  ], "shop.test", [{ primaryId: "p1009", rivalDomain: "rival.test", rivalId: "r609" }]);

  assert.equal(catalogs[0].products.length, 1_000);
  assert.equal(catalogs[1].products.length, 610);
  assert.ok(catalogs[0].products.some((item) => item.id === "p1009"));
  assert.ok(catalogs[1].products.some((item) => item.id === "r609"));
  assert.deepEqual(parsePinnedPairs([{ primaryId: "p1009", rivalDomain: "rival.test", rivalId: "r609" }], catalogs, "shop.test"), [{ primaryId: "p1009", rivalDomain: "rival.test", rivalId: "r609" }]);
});

test("rejects an oversized submitted catalog before pin scanning or allocation", () => {
  const oversized = Array.from({ length: 6_001 }, (_, index) => ({ id: `p${index}`, name: `Product ${index}`, sourceUrl: `https://shop.test/products/${index}` }));
  assert.deepEqual(parseCatalogs([{ domain: "shop.test", products: oversized }], "shop.test", [{ primaryId: "p6000", rivalDomain: "rival.test", rivalId: "r1" }]), []);
});

test("bounds nested product arrays before normalization", () => {
  const [catalog] = parseCatalogs([{ domain: "shop.test", products: [{
    id: "bounded", name: "Honey", sourceUrl: "https://shop.test/products/honey",
    attributes: Array.from({ length: 100 }, (_, index) => `Attribute ${index}`),
    claimIds: Array.from({ length: 100 }, (_, index) => `Claim ${index}`),
    priceSignals: Array.from({ length: 100 }, (_, index) => ({ raw: `USD ${index + 1}`, currency: "USD", amount: index + 1 })),
    identifiers: { gtins: Array.from({ length: 100 }, () => "4006381333931") },
  }] }], "shop.test");
  assert.equal(catalog.products[0].attributes.length, 12);
  assert.equal(catalog.products[0].claimIds.length, 20);
  assert.equal(catalog.products[0].priceSignals.length, 8);
  assert.equal(catalog.products[0].identifiers.gtins.length, 1);
});

test("rejects duplicate caller-controlled product IDs across the submitted catalogs", () => {
  assert.deepEqual(parseCatalogs([
    { domain: "shop.test", products: [{ id: "duplicate", name: "Honey", sourceUrl: "https://shop.test/products/honey" }] },
    { domain: "rival.test", products: [{ id: "duplicate", name: "Honey", sourceUrl: "https://rival.test/products/honey" }] },
  ], "shop.test"), []);
});

test("deduplicates repeated same-source IDs within one catalog without discarding valid catalogs", () => {
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [
      { id: "p1", name: "Honey", sourceUrl: "https://shop.test/products/honey" },
      { id: "p1", name: "Honey", sourceUrl: "https://shop.test/products/honey" },
      { id: "p2", name: "Oil", sourceUrl: "https://shop.test/products/oil" },
    ] },
    { domain: "rival.test", products: [{ id: "r1", name: "Honey", sourceUrl: "https://rival.test/products/honey" }] },
  ], "shop.test");

  assert.deepEqual(catalogs.map((catalog) => [catalog.domain, catalog.products.map((product) => product.id)]), [
    ["shop.test", ["p1", "p2"]],
    ["rival.test", ["r1"]],
  ]);
});

test("drops a conflicting repeated ID without discarding unrelated catalog records", () => {
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [{ id: "p1", name: "Honey", sourceUrl: "https://shop.test/products/honey" }] },
    { domain: "rival.test", products: [
      { id: "r1", name: "Wrong", sourceUrl: "https://rival.test/products/wrong" },
      { id: "r1", name: "Exact", sourceUrl: "https://rival.test/products/exact" },
      { id: "r2", name: "Oil", sourceUrl: "https://rival.test/products/oil" },
    ] },
  ], "shop.test", [{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }]);
  assert.deepEqual(catalogs.map((catalog) => [catalog.domain, catalog.products.map((product) => product.id)]), [
    ["shop.test", ["p1"]],
    ["rival.test", ["r2"]],
  ]);
  assert.deepEqual(parsePinnedPairs([{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }], catalogs, "shop.test"), []);
});

test("rejects duplicate canonical catalog domains", () => {
  assert.deepEqual(parseCatalogs([
    { domain: "rival.test", products: [{ id: "r1", name: "Honey", sourceUrl: "https://rival.test/products/honey" }] },
    { domain: "www.rival.test", products: [{ id: "r2", name: "Oil", sourceUrl: "https://www.rival.test/products/oil" }] },
  ], "shop.test"), []);
});

test("rejects an oversized rival catalog set instead of silently dropping later rivals", () => {
  const catalogs = Array.from({ length: 1_714 }, (_, index) => ({
    domain: `rival-${index}.test`,
    products: [{ id: `r${index}`, name: `Product ${index}`, sourceUrl: `https://rival-${index}.test/products/${index}` }],
  }));
  assert.deepEqual(parseCatalogs(catalogs, "rival-0.test"), []);
});

test("rejects conflicting pins instead of silently dropping assignment contention", () => {
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [
      { id: "p1", name: "Honey", sourceUrl: "https://shop.test/products/honey" },
      { id: "p2", name: "Oil", sourceUrl: "https://shop.test/products/oil" },
    ] },
    { domain: "rival.test", products: [
      { id: "r1", name: "Honey", sourceUrl: "https://rival.test/products/honey" },
      { id: "r2", name: "Oil", sourceUrl: "https://rival.test/products/oil" },
    ] },
  ], "shop.test");
  assert.deepEqual(parsePinnedPairs([{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }, { primaryId: "p1", rivalDomain: "rival.test", rivalId: "r2" }], catalogs, "shop.test"), []);
  assert.deepEqual(parsePinnedPairs([{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }, { primaryId: "p2", rivalDomain: "rival.test", rivalId: "r1" }], catalogs, "shop.test"), []);
});

test("pinned pairs reject mixed valid and invalid records without partial admission", () => {
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [{ id: "p1", name: "Honey", sourceUrl: "https://shop.test/products/honey" }] },
    { domain: "rival.test", products: [{ id: "r1", name: "Honey", sourceUrl: "https://rival.test/products/honey" }] },
  ], "shop.test");
  const pins = parsePinnedPairs([
    { primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" },
    { primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" },
    { primaryId: "missing", rivalDomain: "rival.test", rivalId: "r1" },
    { primaryId: "p1", rivalDomain: "shop.test", rivalId: "p1" },
    { primaryId: "p1", rivalDomain: "evil.test", rivalId: "r1" },
  ], catalogs, "shop.test");
  assert.deepEqual(pins, []);
  assert.deepEqual(parsePinnedPairs([
    { primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" },
    { primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" },
  ], catalogs, "shop.test"), [{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }]);
});

test("the match boundary accepts more than twelve bounded exact-pair pins", () => {
  const primaryProducts = Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, name: `Product ${index}`, sourceUrl: `https://shop.test/products/${index}` }));
  const rivalProducts = Array.from({ length: 13 }, (_, index) => ({ id: `r${index}`, name: `Product ${index}`, sourceUrl: `https://rival.test/products/${index}` }));
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: primaryProducts },
    { domain: "rival.test", products: rivalProducts },
  ], "shop.test");
  const pins = primaryProducts.map((primary, index) => ({ primaryId: primary.id, rivalDomain: "rival.test", rivalId: rivalProducts[index].id }));

  assert.equal(parsePinnedPairs(pins, catalogs, "shop.test").length, 13);
});

test("a single seller can retain the complete 6000-product pinned universe", () => {
  const rivalProducts = Array.from({ length: 6_000 }, (_, index) => ({ id: `r${index}`, name: `Product ${index}`, sourceUrl: `https://rival.test/products/${index}` }));
  const pin = { primaryId: "p1", rivalDomain: "rival.test", rivalId: "r5999" };
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [{ id: "p1", name: "Primary", sourceUrl: "https://shop.test/products/primary" }] },
    { domain: "rival.test", products: rivalProducts },
  ], "shop.test", [pin]);

  assert.equal(catalogs.find((catalog) => catalog.domain === "rival.test")?.products.length, 6_000);
  assert.deepEqual(parsePinnedPairs([pin], catalogs, "shop.test"), [pin]);
});

test("the 6000-product rival bound is global across submitted catalogs", () => {
  const records = (count, domain, prefix) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, name: `Product ${index}`, sourceUrl: `https://${domain}/products/${index}` }));
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [{ id: "p1", name: "Primary", sourceUrl: "https://shop.test/products/primary" }] },
    { domain: "rival-a.test", products: records(3_001, "rival-a.test", "a") },
    { domain: "rival-b.test", products: records(3_000, "rival-b.test", "b") },
  ], "shop.test");

  assert.deepEqual(catalogs, []);
});

test("authenticated matching binds durable judge checkpoints to the active report attempt", async () => {
  const token = "test-callback-token-that-is-at-least-32-characters";
  const saved = [];
  let receivedOptions;
  const priorPrimaryKey = "p".repeat(43);
  const priorCandidateKey = "r".repeat(43);
  const priorGroups = [{ primaryKey: priorPrimaryKey, candidateKeys: [priorCandidateKey] }];
  const priorPlan = { version: 3, planHash: "d".repeat(64), contentHash: createHash("sha256").update(JSON.stringify({ groups: priorGroups, candidatePairPoolTruncated: false })).digest("hex"), primaryCatalogCount: 1_000, selectedPrimaryCount: 1, candidatePairCount: 1, candidatePairPoolTruncated: false, groups: priorGroups };
  const adoptedCurrentGroups = [{ primaryKey: "q".repeat(43), candidateKeys: ["s".repeat(43)] }];
  const adoptedCurrentPlan = { ...priorPlan, planHash: "e".repeat(64), contentHash: createHash("sha256").update(JSON.stringify({ groups: adoptedCurrentGroups, candidatePairPoolTruncated: false })).digest("hex"), groups: adoptedCurrentGroups };
  const activeCurrentGroups = [{ primaryKey: "t".repeat(43), candidateKeys: ["u".repeat(43)] }];
  const activeCurrentPlan = { ...priorPlan, planHash: "f".repeat(64), contentHash: createHash("sha256").update(JSON.stringify({ groups: activeCurrentGroups, candidatePairPoolTruncated: false })).digest("hex"), groups: activeCurrentGroups };
  const fullPrimaryCatalog = Array.from({ length: 1_000 }, (_, index) => ({
    id: `p${index}`,
    name: `Product ${index}`,
    sourceUrl: `https://shop.test/products/${index}`,
  }));
  const handler = createMatchHandler({
    async build(_domain, _catalogs, options) {
      receivedOptions = options;
      const planKey = { batchIndex: 999, planHash: "c".repeat(64) };
      assert.equal(await options.loadCandidatePlan(planKey), null);
      await options.saveCandidatePlan(planKey, { version: 3, planHash: planKey.planHash, contentHash: createHash("sha256").update(JSON.stringify({ groups: [], candidatePairPoolTruncated: false })).digest("hex"), primaryCatalogCount: 1_000, selectedPrimaryCount: 0, candidatePairCount: 0, candidatePairPoolTruncated: false, groups: [] });
      const key = { batchIndex: 3, batchCount: 5, batchHash: "a".repeat(64), model: "test", promptVersion: "v1", primaryIds: ["p1"], candidatePairCount: 1 };
      assert.deepEqual(await options.loadJudgeBatchCheckpoint(key), { version: 1 });
      await options.saveJudgeBatchCheckpoint(key, { version: 1 });
      return { type: "product-comparison", id: "products", rows: [] };
    },
    async loadCheckpoints(publicId, input) {
      assert.equal(publicId, "b".repeat(32));
      if (input.batchIndexStart === 3_900) return [
        { attemptNumber: 1, batchIndex: 3_900, inputHash: priorPlan.planHash, result: priorPlan },
        { attemptNumber: 1, batchIndex: 3_902, inputHash: adoptedCurrentPlan.planHash, result: adoptedCurrentPlan },
        { attemptNumber: 2, batchIndex: 3_902, inputHash: activeCurrentPlan.planHash, result: activeCurrentPlan },
      ];
      if (input.batchIndex === 3_902) return [];
      assert.deepEqual(input, { attemptNumber: 2, batchIndex: 1_903 });
      return [{ inputHash: "a".repeat(64), result: { version: 1 } }];
    },
    async saveCheckpoint(publicId, input) {
      saved.push({ publicId, input });
      return { replayed: false };
    },
    async loadEntitlement(publicId, attemptNumber) {
      assert.equal(publicId, "b".repeat(32));
      assert.equal(attemptNumber, 2);
      return { plan: "agency", productLimit: 1_000, reportObservedAt: "2026-07-20T09:00:00.000Z" };
    },
  }, token);
  const response = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicId: "b".repeat(32), reportAttempt: 2, taskAttemptNumber: 3, reportObservedAt: "2026-07-20T09:00:00.000Z", primaryDomain: "shop.test", marketCountryCode: "GB", productLimit: 1_000, catalogs: [{ domain: "shop.test", products: fullPrimaryCatalog }] }),
  }));

  assert.equal(response.status, 200);
  assert.equal(receivedOptions.maxPrimaryProducts, 1_000);
  assert.equal(receivedOptions.totalBudgetMs, 720_000);
  assert.equal(receivedOptions.concurrency, 12);
  assert.equal(receivedOptions.referenceTimeMs, Date.parse("2026-07-20T09:00:00.000Z"));
  assert.equal(receivedOptions.marketCountryCode, "GB");
  assert.deepEqual(receivedOptions.priorCandidatePairKeys, [`${priorPrimaryKey}\n${priorCandidateKey}`, `${"q".repeat(43)}\n${"s".repeat(43)}`]);
  const savedJudge = saved.find((item) => item.input.batchIndex === 1_903);
  const savedPlan = saved.find((item) => item.input.batchIndex === 3_902);
  assert.equal(savedJudge.publicId, "b".repeat(32));
  assert.equal(savedJudge.input.attemptNumber, 2);
  assert.equal(savedPlan.input.inputHash, "c".repeat(64));

  const missingTaskAttempt = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicId: "b".repeat(32), reportAttempt: 2, reportObservedAt: "2026-07-20T09:00:00.000Z", primaryDomain: "shop.test", productLimit: 1_000, catalogs: [{ domain: "shop.test", products: fullPrimaryCatalog }] }),
  }));
  assert.equal(missingTaskAttempt.status, 400);

  const mismatch = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicId: "b".repeat(32), reportAttempt: 2, taskAttemptNumber: 3, reportObservedAt: "2026-07-20T09:00:00.000Z", primaryDomain: "shop.test", productLimit: 50, catalogs: [{ domain: "shop.test", products: [{ name: "Honey", sourceUrl: "https://shop.test/products/honey" }] }] }),
  }));
  assert.equal(mismatch.status, 409);
  assert.equal(savedJudge.input.inputHash, "a".repeat(64));

  const malformedPins = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicId: "b".repeat(32), reportAttempt: 2, taskAttemptNumber: 3, primaryDomain: "shop.test", productLimit: 1_000, pinnedPairs: { primaryId: "p1" }, catalogs: [{ domain: "shop.test", products: [{ name: "Honey", sourceUrl: "https://shop.test/products/honey" }] }] }),
  }));
  assert.equal(malformedPins.status, 400);

  const oversized = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_MATCH_BODY_BYTES + 1)); controller.close(); } }),
    duplex: "half",
  }));
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).error, /too large/i);
});

test("AI matching keeps public HTTPS CDN images but rejects unsafe image URLs", () => {
  const products = [
    { name: "Public image", sourceUrl: "https://shop.test/products/public", imageUrl: "https://cdn.shopify.com/public.jpg" },
    { name: "Private image", sourceUrl: "https://shop.test/products/private", imageUrl: "https://127.0.0.1/private.jpg" },
    { name: "Script image", sourceUrl: "https://shop.test/products/script", imageUrl: "javascript:alert(1)" },
  ];
  const [catalog] = parseCatalogs([{ domain: "shop.test", products }]);

  assert.equal(catalog.products[0].imageUrl, "https://cdn.shopify.com/public.jpg");
  assert.equal(catalog.products[1].imageUrl, "");
  assert.equal(catalog.products[2].imageUrl, "");
});

test("AI matching input rejects missing and off-domain product sources", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [
    { name: "No source" },
    { name: "Wrong source", sourceUrl: "https://other.test/products/1" },
  ] }]);

  assert.equal(catalogs[0].products.length, 0);
});

test("AI matching input rejects private and credential-bearing product sources", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [
    { id: "private", name: "Private", sourceUrl: "http://127.0.0.1/secret" },
    { id: "credentials", name: "Credentials", sourceUrl: "https://secret:pass@shop.test/products/secret" },
    { id: "public", name: "Public", sourceUrl: "https://shop.test/products/public" },
  ] }], "shop.test");

  assert.deepEqual(catalogs[0].products.map((item) => item.id), ["public"]);
});

test("AI matching input revalidates identifiers and recomputes canonical quantity", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [{
    id: "p1",
    name: "\u0639\u0633\u0644 \u0665\u0660\u0660 \u062c\u0631\u0627\u0645",
    sourceUrl: "https://shop.test/products/honey",
    identifiers: { gtins: ["4006381333931", "4006381333932"], sku: "SKU-42", brand: "Noor" },
    attributes: [],
  }] }]);

  assert.deepEqual(catalogs[0].products[0].identifiers, { gtins: ["04006381333931"], sku: "SKU-42", mpn: undefined, brand: "Noor" });
  assert.deepEqual(catalogs[0].products[0].quantity, { kind: "mass", amount: 500, unit: "g" });
});

test("AI matching input does not infer quantity from an identifier attribute", () => {
  const catalogs = parseCatalogs([{ domain: "shop.test", products: [{
    name: "Organic Honey",
    sourceUrl: "https://shop.test/products/honey",
    attributes: ["sku: HONEY-500G"],
  }] }]);

  assert.equal(catalogs[0].products[0].quantity, undefined);
});
