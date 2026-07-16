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
    identifiers: options.identifiers,
    quantity: options.quantity,
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
  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
});

test("an incomplete Responses API output is visible and never exposes a fallback pair", async () => {
  const primary = product("p1", "shop.test", "Sidr Honey 500g");
  const rival = product("r1", "rival.test", "Sidr Honey 500g");
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.matching?.method, "lexical-fallback");
  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
  assert.match(comparison.matching?.gaps.join(" ") || "", /incomplete model output/i);
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
  assert.equal(calls.find((call) => call.url.endsWith("/embeddings"))?.body.dimensions, 256);
  assert.equal(calls.find((call) => call.url.endsWith("/responses"))?.body.max_output_tokens, 6_000);
});

test("bilingual quantity retrieval reaches the judge when embeddings are unavailable", async () => {
  const quantity = { kind: "mass", amount: 500, unit: "g" };
  const identifiers = { gtins: [], brand: "Sidr House" };
  const primary = product("p-ar-quantity", "shop.test", "\u0639\u0633\u0644 \u0633\u062f\u0631 \u0665\u0660\u0660 \u062c\u0631\u0627\u0645", { quantity, identifiers });
  const rival = product("r-en-quantity", "rival.test", "Premium Sidr Honey 500g", { quantity, identifiers });
  const noise = product("r-noise-quantity", "rival.test", "Olive Oil 1L", { quantity: { kind: "volume", amount: 1000, unit: "ml" } });
  let judgedCandidates = [];
  const fetch = async (url, init) => {
    if (String(url).endsWith("/embeddings")) return response({ error: "unavailable" }, 503);
    const body = JSON.parse(init.body);
    const request = JSON.parse(body.input[1].content);
    judgedCandidates = request.groups[0].candidates.map((candidate) => candidate.id);
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "close_substitute", confidence: 0.91, reason: "Same honey family and observed 500g quantity.", contradiction: "Language and branding differ." }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [noise, rival] },
  ], {}, { apiKey: "test", fetch, maxCandidatesPerPrimary: 1, maxCandidatesPerDomain: 1 });

  assert.deepEqual(judgedCandidates, [rival.id]);
  assert.equal(comparison.rows[0].matches[0].product?.id, rival.id);
  assert.match(comparison.matching?.gaps.join(" ") || "", /semantic product retrieval was unavailable/i);
});

test("embedding outage does not send zero-signal random products to the judge", async () => {
  const primary = product("p-no-signal", "shop.test", "\u0641\u0637\u0631 \u0639\u0636\u0648\u064a");
  const rival = product("r-no-signal", "rival.test", "Olive Oil Gift Set");
  let judgeCalls = 0;
  const fetch = async (url) => {
    if (String(url).endsWith("/embeddings")) return response({ error: "unavailable" }, 503);
    judgeCalls += 1;
    throw new Error("zero-signal candidates must not reach the judge");
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(judgeCalls, 0);
  assert.equal(comparison.matching?.candidatePairsAssessed, 0);
  assert.equal(comparison.rows[0].matches[0].product, null);
});

test("generic bilingual container words cannot produce an accepted battle", async () => {
  const primary = product("p-fiber-bundle", "shop.test", "\u0645\u062c\u0645\u0648\u0639\u0629 \u0627\u0644\u0627\u062d\u062a\u064a\u0627\u062c \u0627\u0644\u064a\u0648\u0645\u064a \u0645\u0646 \u0645\u0646\u062a\u062c\u0627\u062a \u0627\u0644\u0623\u0644\u064a\u0627\u0641 \u0627\u0644\u0637\u0628\u064a\u0639\u064a\u0629");
  const rival = product("r-flour-bundle", "rival.test", "Flours Value Bundle");
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "close_substitute", confidence: 0.96, reason: "Both are bundles.", contradiction: "The contents differ." }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
});

test("low-confidence close substitutes are not assigned without deterministic identity", async () => {
  const primary = product("p-low", "shop.test", "\u0639\u0633\u0644 \u0633\u062f\u0631 \u0641\u0627\u062e\u0631");
  const rival = product("r-low", "rival.test", "Premium Yemeni Sidr Honey");
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "close_substitute", confidence: 0.61, reason: "Possibly the same honey family.", contradiction: "Cross-language identity is uncertain." }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
});

test("localized rival URLs collapse to one physical product and one assignment", async () => {
  const primaries = [
    product("p-vinegar-original", "shop.test", "Organic Apple Vinegar 500ml Original"),
    product("p-vinegar-unfiltered", "shop.test", "Organic Apple Vinegar 500ml Unfiltered"),
  ];
  const rivals = [
    product("r-vinegar-ar", "rival.test", "Organic Apple Vinegar 500ml", { sourceUrl: "https://rival.test/ar/products/apple-vinegar-500ml" }),
    product("r-vinegar-en", "rival.test", "Organic Apple Vinegar 500ml", { sourceUrl: "https://rival.test/products/apple-vinegar-500ml", price: { raw: "KWD 1.00", currency: "KWD", amount: 1 } }),
  ];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: "close_substitute",
      confidence: 0.94,
      reason: "Same apple vinegar family.",
      contradiction: "Variant detail differs.",
    }))) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaries },
    { domain: "rival.test", products: rivals },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.matching?.competitorProductsSynchronized, 1);
  assert.equal(comparison.coverage.assignedPairCount, 1);
  assert.equal(comparison.rows.flatMap((row) => row.matches).filter((match) => match.product).length, 1);
});

test("validated GTIN retrieval is guaranteed without semantic or lexical overlap", async () => {
  const identifiers = { gtins: ["04006381333931"], brand: "Acme" };
  const primary = product("p-gtin", "shop.test", "Local Item Alpha", { identifiers, price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const rival = product("r-gtin", "rival.test", "Imported Item Omega", { identifiers, price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  const noise = product("r-lexical", "rival.test", "Local Item Alpha Deluxe");
  let judgedCandidates = [];
  const fetch = async (url, init) => {
    if (String(url).endsWith("/embeddings")) return response({ error: "unavailable" }, 503);
    const body = JSON.parse(init.body);
    const request = JSON.parse(body.input[1].content);
    judgedCandidates = request.groups[0].candidates.map((candidate) => candidate.id);
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.94, reason: "Shared validated GTIN and compatible observed listing.", contradiction: "" }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [noise, rival] },
  ], {}, { apiKey: "test", fetch, maxCandidatesPerPrimary: 1, maxCandidatesPerDomain: 1 });

  assert.deepEqual(judgedCandidates, [rival.id]);
  assert.equal(comparison.rows[0].matches[0].assessment?.verdict, "same_product");
  assert.deepEqual(comparison.rows[0].matches[0].decision?.priceComparison, { primaryRaw: "GBP 10", rivalRaw: "GBP 8" });
});

test("conflicting validated GTINs veto an AI same-product verdict", async () => {
  const quantity = { kind: "mass", amount: 500, unit: "g" };
  const primary = product("p-gtin-conflict", "shop.test", "Sidr Honey 500g", { quantity, identifiers: { gtins: ["04006381333931"], brand: "Acme" } });
  const rival = product("r-gtin-conflict", "rival.test", "Sidr Honey 500g", { quantity, identifiers: { gtins: ["00036000291452"], brand: "Acme" } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.99, reason: "Names and quantities match.", contradiction: "" }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
});

test("quantity conflict overrides a shared GTIN and blocks an exact price delta", async () => {
  const identifiers = { gtins: ["04006381333931"], brand: "Acme" };
  const primary = product("p-quantity-conflict", "shop.test", "Sidr Honey 500g", { quantity: { kind: "mass", amount: 500, unit: "g" }, identifiers, price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const rival = product("r-quantity-conflict", "rival.test", "Sidr Honey 1kg", { quantity: { kind: "mass", amount: 1000, unit: "g" }, identifiers, price: { raw: "GBP 15", currency: "GBP", amount: 15 } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.99, reason: "Shared validated GTIN.", contradiction: "" }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
});

test("merchant-scoped SKU equality cannot create an exact price delta across brands", async () => {
  const primary = product("p-sku", "shop.test", "Organic Chia Seeds", { identifiers: { gtins: [], sku: "SKU-42", brand: "Brand One" }, price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const rival = product("r-sku", "rival.test", "Organic Chia Seeds", { identifiers: { gtins: [], sku: "SKU-42", brand: "Brand Two" }, price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.96, reason: "Names and submitted SKUs match.", contradiction: "" }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch });

  const match = comparison.rows[0].matches[0];
  assert.equal(match.assessment?.verdict, "close_substitute");
  assert.equal(match.decision?.priceComparison, null);
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

test("an incomplete AI batch never exposes an unassessed lexical fallback match", async () => {
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
  ], {}, { apiKey: "test", fetch, maxCandidatesPerPrimary: 2, maxCandidatesPerDomain: 2 });

  assert.equal(comparison.matching?.method, "lexical-fallback");
  assert.equal(comparison.rows[0].matches[0].product, null);
  assert.equal(comparison.coverage.assignedPairCount, 0);
  assert.match(comparison.matching?.gaps.join(" ") || "", /incomplete|failed/i);
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

test("candidate retrieval performs an exact semantic scan across the bounded catalogs", async () => {
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

  assert.equal(comparison.matching?.retrievalPairsScored, primaryProducts.length * rivalProducts.length);
});

test("a complete group is salvaged when another group is incomplete in the same judge response", async () => {
  const primaries = [product("p1", "shop.test", "Sidr Honey 500g"), product("p2", "shop.test", "Olive Oil 1L")];
  const rivals = [product("r1", "rival.test", "Sidr Honey 500g"), product("r2", "rival.test", "Olive Oil 1L")];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((text, index) => ({ index, embedding: /honey/i.test(text) ? [1, 0] : [0, 1] })) });
    const request = JSON.parse(body.input[1].content);
    const first = request.groups[0];
    return response({ output_text: JSON.stringify({ assessments: first.candidates.map((candidate) => ({
      primaryId: first.primary.id,
      candidateId: candidate.id,
      verdict: "same_product",
      confidence: 0.98,
      reason: "Same observed offer.",
      contradiction: "",
    })) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaries },
    { domain: "rival.test", products: rivals },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 2 });

  assert.equal(comparison.matching?.method, "ai-hybrid");
  assert.equal(comparison.matching?.primaryProductsAssessed, 1);
  assert.equal(comparison.coverage.assignedPairCount, 1);
  assert.equal(comparison.rows.find((row) => row.primary.id === primaries[1].id)?.matches[0].product, null);
  assert.match(comparison.matching?.gaps.join(" ") || "", /incomplete/i);
});

test("judge batches are bounded by candidate-pair count across many competitor domains", async () => {
  const primaries = Array.from({ length: 20 }, (_, index) => product(`p${index}`, "shop.test", `Local Item ${index}`));
  const catalogs = Array.from({ length: 5 }, (_, domainIndex) => ({
    domain: `rival-${domainIndex}.test`,
    products: primaries.map((_, index) => product(`r${domainIndex}-${index}`, `rival-${domainIndex}.test`, `Rival Item ${index}`)),
  }));
  const pairCounts = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index % 3, index % 5] })) });
    const request = JSON.parse(body.input[1].content);
    pairCounts.push(request.groups.reduce((sum, group) => sum + group.candidates.length, 0));
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: "no_match",
      confidence: 0.99,
      reason: "Different products.",
      contradiction: "",
    }))) }) });
  };

  await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: primaries }, ...catalogs], {}, {
    apiKey: "test",
    fetch,
    maxPrimaryProducts: 20,
    maxCandidatesPerPrimary: 5,
    maxCandidatesPerDomain: 1,
    maxPairsPerJudgeCall: 25,
  });

  assert.ok(pairCounts.length > 1);
  assert.ok(pairCounts.every((count) => count <= 25));
});

test("the fixed two-slot budget follows the strongest candidates instead of forcing domain diversity", async () => {
  const primary = product("p1", "shop.test", "Organic Honey");
  const strong = [product("a1", "strong.test", "Organic Honey 500g"), product("a2", "strong.test", "Raw Organic Honey")];
  const weak = [product("b1", "weak.test", "Unrelated Soup"), product("b2", "weak.test", "Kitchen Towels")];
  let judgedCandidates = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((text, index) => ({
      index,
      embedding: /Unrelated Soup|Kitchen Towels/i.test(text) ? [0, 1] : [1, index === 0 ? 0 : index / 100],
    })) });
    const request = JSON.parse(body.input[1].content);
    judgedCandidates = request.groups[0].candidates;
    return response({ output_text: JSON.stringify({ assessments: judgedCandidates.map((candidate) => ({
      primaryId: primary.id,
      candidateId: candidate.id,
      verdict: "no_match",
      confidence: 0.99,
      reason: "Test assessment.",
      contradiction: "",
    })) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "strong.test", products: strong },
    { domain: "weak.test", products: weak },
  ], {}, { apiKey: "test", fetch });

  assert.deepEqual(judgedCandidates.map((candidate) => candidate.domain), ["strong.test", "strong.test"]);
  assert.deepEqual(comparison.matching?.candidateSlotsByDomain, { "strong.test": 2 });
  assert.equal(comparison.matching?.candidatePairsAssessed, 2);
});

test("synchronizes complete catalogs before selecting the strongest groups for AI judging", async () => {
  const primaryProducts = Array.from({ length: 80 }, (_, index) => product(
    `p${index}`,
    "shop.test",
    index === 79 ? "عسل سدر عضوي 500 جرام" : `Unrelated local item ${index}`,
  ));
  const rivalProducts = Array.from({ length: 100 }, (_, index) => product(
    `r${index}`,
    "rival.test",
    index === 99 ? "Organic Sidr Honey 500g" : `Different imported item ${index}`,
  ));
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) {
      return response({ data: body.input.map((text, index) => ({
        index,
        embedding: /سدر|sidr/i.test(text) ? [1, 0, 0, 0] : (/name: Unrelated/i.test(text) ? [0, 1, 0, 0] : [0, -1, 0, 0]),
      })) });
    }
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: group.primary.id === "p79" && candidate.id === "r99" ? "close_substitute" : "no_match",
      confidence: 0.97,
      normalizedCategory: group.primary.id === "p79" && candidate.id === "r99" ? "sidr honey" : "",
      normalizedVariant: "",
      normalizedSize: group.primary.id === "p79" && candidate.id === "r99" ? "500g" : "",
      reasons: group.primary.id === "p79" && candidate.id === "r99" ? ["Same product family across Arabic and English."] : ["Different products."],
      contradictions: [],
      needsImageReview: false,
    }))) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaryProducts },
    { domain: "rival.test", products: rivalProducts },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 10, maxProductsPerCompetitor: 100, primaryProductsPerJudgeCall: 5 });

  assert.equal(comparison.matching?.primaryProductsSynchronized, 80);
  assert.equal(comparison.matching?.competitorProductsSynchronized, 100);
  assert.ok(comparison.matching?.selectedPrimaryIds?.includes("p79"));
  assert.equal(comparison.rows.find((row) => row.primary.id === "p79")?.matches[0].product?.id, "r99");
});
