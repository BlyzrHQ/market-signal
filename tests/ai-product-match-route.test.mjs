import test from "node:test";
import assert from "node:assert/strict";
import { createMatchHandler, parseCatalogs, parsePinnedPairs, productAnalysisBudgetMs, productAnalysisLimit } from "../app/api/match/route.ts";

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
  assert.equal(catalogs[0].products.length, 600);
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
  assert.equal(catalogs[1].products.length, 600);
});

test("product analysis limits are server-controlled, clamped, and receive scaled budgets", () => {
  assert.equal(productAnalysisLimit(undefined), 20);
  assert.equal(productAnalysisLimit("0"), 20);
  assert.equal(productAnalysisLimit("50"), 50);
  assert.equal(productAnalysisLimit("500"), 500);
  assert.equal(productAnalysisLimit("1000"), 1_000);
  assert.equal(productAnalysisLimit("5000"), 20);
  assert.equal(productAnalysisBudgetMs(60), 45_000);
  assert.equal(productAnalysisBudgetMs(500), 360_000);
  assert.equal(productAnalysisBudgetMs(1_000), 720_000);
});

test("catalog bounds retain valid pinned records beyond both ordinary limits", () => {
  const records = (count, domain, prefix) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, name: `Product ${index}`, sourceUrl: `https://${domain}/products/${index}` }));
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: records(1_010, "shop.test", "p") },
    { domain: "rival.test", products: records(610, "rival.test", "r") },
  ], "shop.test", [{ primaryId: "p1009", rivalDomain: "rival.test", rivalId: "r609" }]);

  assert.equal(catalogs[0].products.length, 1_000);
  assert.equal(catalogs[1].products.length, 600);
  assert.ok(catalogs[0].products.some((item) => item.id === "p1009"));
  assert.ok(catalogs[1].products.some((item) => item.id === "r609"));
  assert.deepEqual(parsePinnedPairs([{ primaryId: "p1009", rivalDomain: "rival.test", rivalId: "r609" }], catalogs, "shop.test"), [{ primaryId: "p1009", rivalDomain: "rival.test", rivalId: "r609" }]);
});

test("rejects an oversized submitted catalog before pin scanning or allocation", () => {
  const oversized = Array.from({ length: 5_001 }, (_, index) => ({ id: `p${index}`, name: `Product ${index}`, sourceUrl: `https://shop.test/products/${index}` }));
  assert.deepEqual(parseCatalogs([{ domain: "shop.test", products: oversized }], "shop.test", [{ primaryId: "p5000", rivalDomain: "rival.test", rivalId: "r1" }]), []);
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

test("rejects duplicate IDs before a requested pin can discard the conflicting record", () => {
  const catalogs = parseCatalogs([
    { domain: "shop.test", products: [{ id: "p1", name: "Honey", sourceUrl: "https://shop.test/products/honey" }] },
    { domain: "rival.test", products: [
      { id: "r1", name: "Wrong", sourceUrl: "https://rival.test/products/wrong" },
      { id: "r1", name: "Exact", sourceUrl: "https://rival.test/products/exact" },
    ] },
  ], "shop.test", [{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }]);
  assert.deepEqual(catalogs, []);
});

test("rejects duplicate canonical catalog domains", () => {
  assert.deepEqual(parseCatalogs([
    { domain: "rival.test", products: [{ id: "r1", name: "Honey", sourceUrl: "https://rival.test/products/honey" }] },
    { domain: "www.rival.test", products: [{ id: "r2", name: "Oil", sourceUrl: "https://www.rival.test/products/oil" }] },
  ], "shop.test"), []);
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

test("pinned pairs are bounded, deduplicated, and must reference submitted catalog records", () => {
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
  assert.deepEqual(pins, [{ primaryId: "p1", rivalDomain: "rival.test", rivalId: "r1" }]);
});

test("authenticated matching binds durable judge checkpoints to the active report attempt", async () => {
  const token = "test-callback-token-that-is-at-least-32-characters";
  const saved = [];
  let receivedOptions;
  const handler = createMatchHandler({
    async build(_domain, _catalogs, options) {
      receivedOptions = options;
      const key = { batchIndex: 3, batchCount: 5, batchHash: "a".repeat(64), model: "test", promptVersion: "v1", primaryIds: ["p1"], candidatePairCount: 1 };
      assert.deepEqual(await options.loadJudgeBatchCheckpoint(key), { version: 1 });
      await options.saveJudgeBatchCheckpoint(key, { version: 1 });
      return { type: "product-comparison", id: "products", rows: [] };
    },
    async loadCheckpoints(publicId, input) {
      assert.equal(publicId, "b".repeat(32));
      assert.deepEqual(input, { attemptNumber: 2, batchIndex: 3 });
      return [{ inputHash: "a".repeat(64), result: { version: 1 } }];
    },
    async saveCheckpoint(publicId, input) {
      saved.push({ publicId, input });
      return { replayed: false };
    },
    async loadEntitlement(publicId, attemptNumber) {
      assert.equal(publicId, "b".repeat(32));
      assert.equal(attemptNumber, 2);
      return { plan: "agency", productLimit: 1_000 };
    },
  }, token);
  const response = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicId: "b".repeat(32), reportAttempt: 2, primaryDomain: "shop.test", productLimit: 1_000, catalogs: [{ domain: "shop.test", products: [{ name: "Honey", sourceUrl: "https://shop.test/products/honey" }] }] }),
  }));

  assert.equal(response.status, 200);
  assert.equal(receivedOptions.maxPrimaryProducts, 1_000);
  assert.equal(receivedOptions.totalBudgetMs, 720_000);
  assert.equal(saved[0].publicId, "b".repeat(32));
  assert.equal(saved[0].input.attemptNumber, 2);
  assert.equal(saved[0].input.batchIndex, 3);

  const mismatch = await handler(new Request("https://signal.test/api/match", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ publicId: "b".repeat(32), reportAttempt: 2, primaryDomain: "shop.test", productLimit: 50, catalogs: [{ domain: "shop.test", products: [{ name: "Honey", sourceUrl: "https://shop.test/products/honey" }] }] }),
  }));
  assert.equal(mismatch.status, 409);
  assert.equal(saved[0].input.inputHash, "a".repeat(64));
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
