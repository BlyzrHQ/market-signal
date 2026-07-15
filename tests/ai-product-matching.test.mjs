import test from "node:test";
import assert from "node:assert/strict";
import { buildAIProductComparison } from "../app/lib/ai-product-matching.ts";

function product(id, domain, name, options = {}) {
  return {
    id,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description: options.description || "",
    category: options.category || "grocery",
    jsonLdType: options.jsonLdType || "Product",
    priceSignals: options.price ? [{ raw: options.price.raw, currency: options.price.currency, amount: options.price.amount }] : [],
    attributes: options.attributes || [],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: options.sourceUrl || `https://${domain}/products/${id}`,
    imageUrl: options.imageUrl || "",
    observedAt: "2026-07-15T00:00:00.000Z",
    claimIds: [`claim-${id}`],
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("falls back honestly without an API key", async () => {
  let calls = 0;
  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [product("p1", "shop.test", "Sidr Honey 500g")] },
    { domain: "rival.test", products: [product("r1", "rival.test", "Sidr Honey 500g")] },
  ], {}, { apiKey: "", fetch: async () => { calls += 1; throw new Error("should not call"); } });

  assert.equal(calls, 0);
  assert.equal(comparison.matching?.method, "lexical-fallback");
  assert.match(comparison.matching?.gaps[0] || "", /not configured/i);
});

test("embedding retrieval gives a cross-language pair to the structured judge", async () => {
  const primary = product("p-ar", "shop.test", "عسل سدر فاخر 500 جرام", { description: "عسل يمني طبيعي" });
  const rival = product("r-en", "rival.test", "Premium Yemeni Sidr Honey 500g", { description: "Pure raw sidr honey" });
  const noise = product("r-noise", "rival.test", "Olive Oil Gift Set", { description: "Cold pressed olive oil" });
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/embeddings")) {
      return response({ data: body.input.map((text, index) => ({ index, embedding: /سدر|sidr/i.test(text) ? [1, 0] : [0, 1] })) });
    }
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups[0].candidates.map((candidate) => candidate.id === rival.id ? {
      primaryId: primary.id,
      candidateId: candidate.id,
      verdict: "close_substitute",
      confidence: 0.93,
      normalizedCategory: "sidr honey",
      normalizedVariant: "yemeni",
      normalizedSize: "500g",
      reasons: ["Sidr honey is the same product family across Arabic and English names."],
      contradictions: [],
      needsImageReview: false,
    } : {
      primaryId: primary.id,
      candidateId: candidate.id,
      verdict: "no_match",
      confidence: 0.99,
      normalizedCategory: "",
      normalizedVariant: "",
      normalizedSize: "",
      reasons: ["Different product category."],
      contradictions: [],
      needsImageReview: false,
    }) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [noise, rival] },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 10, maxCandidatesPerPrimary: 4 });

  const match = comparison.rows[0].matches.find((item) => item.domain === "rival.test");
  assert.equal(match?.product?.id, rival.id);
  assert.equal(match?.assessment?.method, "ai-hybrid");
  assert.equal(match?.assessment?.claimType, "Inferred");
  assert.equal(match?.assessment?.verdict, "close_substitute");
  assert.equal(comparison.matching?.method, "ai-hybrid");
  assert.equal(calls.filter((call) => call.url.endsWith("/responses")).length, 1);
});

test("deterministic veto rejects an AI same-product service mismatch", async () => {
  const primary = product("p1", "shop.test", "Baklava Box");
  const service = product("s1", "rival.test", "Baklava Box Catering", { jsonLdType: "Service" });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: service.id, verdict: "same_product", confidence: 0.99, normalizedCategory: "baklava", normalizedVariant: "", normalizedSize: "", reasons: ["Names overlap."], contradictions: [], needsImageReview: false }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [service] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
});

test("a service-typed subscription box can match a product-typed box substitute", async () => {
  const primary = product("p1", "shop.test", "Fruit and Veg Box", { jsonLdType: "Service", category: "produce box subscription" });
  const rival = product("r1", "rival.test", "Organic Fruit & Veg Box", { jsonLdType: "Product", category: "produce box" });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "close_substitute", confidence: 0.96, normalizedCategory: "produce subscription box", normalizedVariant: "organic", normalizedSize: "", reasons: ["Both are delivered produce boxes."], contradictions: [], needsImageReview: false }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product?.id, rival.id);
  assert.equal(comparison.rows[0].matches[0].assessment?.verdict, "close_substitute");
});

test("close substitutes never produce exact price deltas", async () => {
  const primary = product("p1", "shop.test", "Sidr Honey 250g", { price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const rival = product("r1", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 15", currency: "GBP", amount: 15 } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "close_substitute", confidence: 0.95, normalizedCategory: "sidr honey", normalizedVariant: "", normalizedSize: "different pack sizes", reasons: ["Same product family but a different pack size."], contradictions: ["250g versus 500g"], needsImageReview: false }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  const match = comparison.rows[0].matches[0];
  assert.equal(match.product?.id, rival.id);
  assert.equal(match.decision?.priceComparison, null);
  assert.match(match.decision?.priceVerdict || "", /substitute|pack|variant/i);
});

test("an incomplete AI batch is rejected and preserves lexical fallback matches", async () => {
  const primary = product("p1", "shop.test", "Sidr Honey 500g");
  const rivals = [
    product("r1", "rival.test", "Sidr Honey 500g"),
    product("r2", "rival.test", "Yemeni Sidr Honey 500g"),
  ];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rivals[0].id, verdict: "same_product", confidence: 0.99, normalizedCategory: "sidr honey", normalizedVariant: "", normalizedSize: "500g", reasons: ["Same observed offer."], contradictions: [], needsImageReview: false }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: rivals },
  ], {}, { apiKey: "test", fetch, maxCandidatesPerPrimary: 2 });

  assert.equal(comparison.matching?.method, "lexical-fallback");
  assert.equal(comparison.rows[0].matches[0].product?.id, "r1");
  assert.match(comparison.matching?.gaps.join(" ") || "", /failed/i);
});

test("AI coverage is not limited to the lexical fallback's sixteen visible rows", async () => {
  const primaryProducts = Array.from({ length: 20 }, (_, index) => product(`p${index}`, "shop.test", `Local Item ${index}`));
  const rival = product("r1", "rival.test", "Different Rival Item");
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: "no_match",
      confidence: 0.98,
      normalizedCategory: "",
      normalizedVariant: "",
      normalizedSize: "",
      reasons: ["Different products."],
      contradictions: [],
      needsImageReview: false,
    }))) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaryProducts },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 20, primaryProductsPerJudgeCall: 5 });

  assert.equal(comparison.matching?.method, "ai-hybrid");
  assert.equal(comparison.matching?.primaryProductsAssessed, 20);
  assert.equal(comparison.rows.length, 20);
});

test("candidate retrieval scores a hard-bounded pool instead of every catalog pair", async () => {
  const primaryProducts = Array.from({ length: 10 }, (_, index) => product(`p${index}`, "shop.test", `Primary ${index}`));
  const rivalProducts = Array.from({ length: 500 }, (_, index) => product(`r${index}`, "rival.test", `Rival ${index}`));
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index % 2] })) });
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({ primaryId: group.primary.id, candidateId: candidate.id, verdict: "no_match", confidence: 0.99, normalizedCategory: "", normalizedVariant: "", normalizedSize: "", reasons: ["Different products."], contradictions: [], needsImageReview: false }))) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaryProducts },
    { domain: "rival.test", products: rivalProducts },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 10, maxProductsPerCompetitor: 500, maxRetrievalPoolPerDomain: 12 });

  assert.ok((comparison.matching?.retrievalPairsScored || 0) <= 120);
  assert.ok((comparison.matching?.retrievalPairsScored || 0) < primaryProducts.length * rivalProducts.length);
});
