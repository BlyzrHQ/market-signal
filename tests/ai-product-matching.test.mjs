import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { boundJudgeCandidatePairs, boundJudgeCandidatePairsWithCoverage, buildAIProductComparison, judgeBatchKey, MAX_COMPETITOR_PRODUCTS_PER_CATALOG, MAX_JUDGE_CANDIDATE_PAIRS, screenedComparisonFromJudgeCheckpoints } from "../app/lib/ai-product-matching.ts";
import { hasValidObservedRivalPrice } from "../app/lib/product-intelligence.ts";
import { publishPricedProductComparison } from "../app/lib/product-match-lifecycle.ts";

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
    observedAt: options.observedAt || "2026-07-15T00:00:00.000Z",
    claimIds: [`claim-${id}`],
    identifiers: options.identifiers,
    quantity: options.quantity,
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("publishes only rival products with a finite positive observed ISO price", () => {
  const priced = (price) => product("rival", "rival.test", "Honey", { price });
  assert.equal(hasValidObservedRivalPrice(priced({ raw: "GBP 8.00", currency: "GBP", amount: 8 })), true);
  assert.equal(hasValidObservedRivalPrice(priced({ raw: "", currency: "GBP", amount: 8 })), false);
  assert.equal(hasValidObservedRivalPrice(priced({ raw: "GBP 0", currency: "GBP", amount: 0 })), false);
  assert.equal(hasValidObservedRivalPrice(priced({ raw: "GBP -1", currency: "GBP", amount: -1 })), false);
  assert.equal(hasValidObservedRivalPrice(priced({ raw: "8", currency: "ZZZ", amount: 8 })), false);
  assert.equal(hasValidObservedRivalPrice(priced({ raw: "GBP 8", currency: "GBP", amount: Number.NaN })), false);
  assert.equal(hasValidObservedRivalPrice(product("rival", "rival.test", "Honey")), false);
});

test("the final publication gate suppresses an AI-accepted pair without a rival price", async () => {
  const primary = product("p-priced", "shop.test", "Sidr Honey 500g", { price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const rival = product("r-unpriced", "rival.test", "Sidr Honey 500g");
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.99, reason: "Same product.", contradiction: "" }] }) });
  };
  const comparison = await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "rival.test", products: [rival] }], {}, { apiKey: "test", fetch });

  assert.equal(comparison.rows[0].matches[0].product?.id, rival.id);
  const published = publishPricedProductComparison(comparison);
  assert.equal(published.rows[0].matches[0].product, null);
  assert.equal(published.coverage.assignedPairCount, 0);
  assert.deepEqual(published.matching?.publication, { suppressedAcceptedPairs: 1, reasons: { "missing-valid-rival-price": 1 } });
});

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
  const rival = product("r-en", "rival.test", "Premium Yemeni Sidr Honey 500g", { description: "Pure raw sidr honey", price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
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

test("a validated exact-pair pin survives primary and rival catalog limits", async () => {
  const strongestPrimary = product("p-strong", "shop.test", "Popular Coffee Beans 1kg", { price: { raw: "GBP 12", currency: "GBP", amount: 12 } });
  const pinnedPrimary = product("p-ar", "shop.test", "عسل الريشي 500 غرام");
  const strongestRival = product("r-strong", "rival.test", "Popular Coffee Beans 1kg", { price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const pinnedRival = product("r-en", "rival.test", "Organic Reishi Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  const judged = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [0, 0] })) });
    const request = JSON.parse(body.input[1].content);
    judged.push(...request.groups);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({ primaryId: group.primary.id, candidateId: candidate.id, verdict: "close_substitute", confidence: 0.9, reason: "Same customer product family.", contradiction: "" }))) }) });
  };
  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [strongestPrimary, pinnedPrimary] },
    { domain: "rival.test", products: [strongestRival, pinnedRival] },
  ], {}, {
    apiKey: "test",
    fetch,
    maxPrimaryProducts: 1,
    maxProductsPerCompetitor: 1,
    maxCandidatesPerPrimary: 1,
    pinnedPairs: [{ primaryId: pinnedPrimary.id, rivalDomain: "rival.test", rivalId: pinnedRival.id }],
  });
  assert.deepEqual(judged.map((group) => group.primary.id), [pinnedPrimary.id]);
  assert.deepEqual(judged[0].candidates.map((candidate) => candidate.id), [pinnedRival.id]);
  assert.equal(comparison.rows[0].primary.id, pinnedPrimary.id);
  assert.equal(comparison.rows[0].matches[0].product?.id, pinnedRival.id);
});

test("a fully screened catalog with no rival products is a completed empty match pool", async () => {
  const primary = product("p-empty-rivals", "shop.test", "Sidr Honey 500g");
  const comparison = await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }], {}, {
    apiKey: "",
    fetch: async () => { throw new Error("an empty rival pool must not call the model"); },
  });

  assert.equal(comparison.matching?.method, "ai-hybrid");
  assert.equal(comparison.matching?.available, true);
  assert.deepEqual(comparison.matching?.selectedPrimaryIds, [primary.id]);
  assert.deepEqual(comparison.matching?.processedPrimaryIds, [primary.id]);
  assert.deepEqual(comparison.matching?.gaps, []);
});

test("candidate judging retains every pin while staying inside the global 6000-pair bound", () => {
  const groups = Array.from({ length: 1_000 }, (_, primaryIndex) => {
    const primary = product(`bounded-p-${primaryIndex}`, "shop.test", `Primary ${primaryIndex}`);
    const count = primaryIndex < 750 ? 7 : 5;
    return {
      primary,
      candidates: Array.from({ length: count }, (_, candidateIndex) => ({
        product: product(`bounded-r-${primaryIndex}-${candidateIndex}`, `rival-${candidateIndex}.test`, `Rival ${primaryIndex} ${candidateIndex}`),
        retrievalScore: 1,
        lexicalScore: 1,
        lexicalEligible: true,
        semanticScore: 1,
        identitySignal: true,
      })),
    };
  });
  const pins = groups.slice(0, 750).flatMap((group) => group.candidates.map((candidate) => ({ primaryId: group.primary.id, rivalDomain: candidate.product.domain, rivalId: candidate.product.id })));
  const bounded = boundJudgeCandidatePairs(groups, pins, MAX_JUDGE_CANDIDATE_PAIRS);

  assert.equal(pins.length, 5_250);
  assert.equal(bounded.reduce((total, group) => total + group.candidates.length, 0), 6_000);
  assert.equal(bounded.slice(0, 750).every((group) => group.candidates.length === 7), true);
});

test("candidate judging reports when pins consume capacity needed by ordinary backups", () => {
  const primary = product("p-budget", "shop.test", "Primary");
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    product: product(`r-budget-${index}`, "rival.test", `Rival ${index}`),
    retrievalScore: 1,
    lexicalScore: 1,
    lexicalEligible: true,
    semanticScore: 1,
    identitySignal: true,
  }));
  const pins = candidates.slice(0, 6).map((candidate) => ({ primaryId: primary.id, rivalDomain: candidate.product.domain, rivalId: candidate.product.id }));
  const bounded = boundJudgeCandidatePairsWithCoverage([{ primary, candidates }], pins, 6);

  assert.equal(bounded.groups[0].candidates.length, 6);
  assert.equal(bounded.truncated, true);
});

test("exact-pair backfill preserves more than twelve bounded pins", async () => {
  const primaries = Array.from({ length: 13 }, (_, index) => product(`p-pin-${index}`, "shop.test", `Pinned Product ${index} 500g`));
  const rivals = Array.from({ length: 13 }, (_, index) => product(`r-pin-${index}`, "rival.test", `Pinned Product ${index} 500g`, { price: { raw: `GBP ${index + 1}`, currency: "GBP", amount: index + 1 } }));
  const judged = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [0, 0] })) });
    const request = JSON.parse(body.input[1].content);
    judged.push(...request.groups.flatMap((group) => group.candidates.map((candidate) => `${group.primary.id}|${candidate.id}`)));
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({ primaryId: group.primary.id, candidateId: candidate.id, verdict: "same_product", confidence: 0.95, reason: "Exact bounded backfill pair.", contradiction: "" }))) }) });
  };
  const pinnedPairs = primaries.map((primary, index) => ({ primaryId: primary.id, rivalDomain: "rival.test", rivalId: rivals[index].id }));
  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaries },
    { domain: "rival.test", products: rivals },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 13, maxCandidatesPerPrimary: 13, maxCandidatesPerDomain: 13, maxProductsPerCompetitor: 13, pinnedPairs });

  assert.equal(judged.length, 13);
  assert.equal(comparison.rows.filter((row) => row.matches[0]?.product).length, 13);
  assert.ok(judged.includes("p-pin-12|r-pin-12"));
});

test("an eligible pin wins global rival contention over a higher-confidence unpinned proposal", async () => {
  const unpinnedPrimary = product("p-unpinned", "shop.test", "Sidr Honey 500g");
  const pinnedPrimary = product("p-pinned", "shop.test", "عسل سدر ٥٠٠ جرام");
  const rival = product("r-shared", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: group.primary.id === unpinnedPrimary.id ? "same_product" : "close_substitute",
      confidence: group.primary.id === unpinnedPrimary.id ? 0.99 : 0.82,
      reason: "Same product family.",
      contradiction: "",
    }))) }) });
  };
  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [unpinnedPrimary, pinnedPrimary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 2, pinnedPairs: [{ primaryId: pinnedPrimary.id, rivalDomain: "rival.test", rivalId: rival.id }] });

  assert.equal(comparison.rows.find((row) => row.primary.id === pinnedPrimary.id)?.matches[0].product?.id, rival.id);
  assert.equal(comparison.rows.find((row) => row.primary.id === unpinnedPrimary.id)?.matches[0].product, null);
});

test("a pinned deterministic pair still requires semantic confidence of at least 0.80", async () => {
  const primary = product("p-low-pin", "shop.test", "Sidr Honey 500g");
  const rival = product("r-low-pin", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return response({ output_text: JSON.stringify({ assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "close_substitute", confidence: 0.2, reason: "Weak model guess.", contradiction: "" }] }) });
  };
  const comparison = await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "rival.test", products: [rival] }], {}, { apiKey: "test", fetch, pinnedPairs: [{ primaryId: primary.id, rivalDomain: "rival.test", rivalId: rival.id }] });
  assert.equal(comparison.rows[0].matches[0].product, null);
});

test("bilingual quantity retrieval reaches the judge when embeddings are unavailable", async () => {
  const quantity = { kind: "mass", amount: 500, unit: "g" };
  const identifiers = { gtins: [], brand: "Sidr House" };
  const primary = product("p-ar-quantity", "shop.test", "\u0639\u0633\u0644 \u0633\u062f\u0631 \u0665\u0660\u0660 \u062c\u0631\u0627\u0645", { quantity, identifiers });
  const rival = product("r-en-quantity", "rival.test", "Premium Sidr Honey 500g", { quantity, identifiers, price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
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

  const pinned = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, { apiKey: "test", fetch, pinnedPairs: [{ primaryId: primary.id, rivalDomain: "rival.test", rivalId: rival.id }] });
  assert.equal(pinned.rows[0].matches[0].product, null);
  assert.equal(pinned.coverage.assignedPairCount, 0);
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
  const rival = product("r1", "rival.test", "Organic Fruit & Veg Box", { jsonLdType: "Product", category: "produce box", price: { raw: "GBP 20", currency: "GBP", amount: 20 } });
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

test("the bounded backfill pool judges already-priced product pairs before unpriced ties", async () => {
  const pricedPrimary = product("z-priced", "shop.test", "Sidr Honey 500g", { price: { raw: "GBP 10", currency: "GBP", amount: 10 } });
  const unpricedPrimary = product("a-unpriced", "shop.test", "Sidr Honey 500g");
  const pricedRival = product("r-priced", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  let judgedPrimaryId = "";
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    const request = JSON.parse(body.input[1].content);
    judgedPrimaryId = request.groups[0].primary.id;
    return response({ output_text: JSON.stringify({ assessments: request.groups[0].candidates.map((candidate) => ({
      primaryId: judgedPrimaryId,
      candidateId: candidate.id,
      verdict: "same_product",
      confidence: 0.99,
      reason: "Same observed offer.",
      contradiction: "",
    })) }) });
  };

  await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [unpricedPrimary, pricedPrimary] },
    { domain: "rival.test", products: [pricedRival] },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 1, maxCandidatesPerPrimary: 1 });

  assert.equal(judgedPrimaryId, "z-priced");
});

test("the bounded backfill pool prioritizes fresh target-market priced pairs", async () => {
  const viablePrimary = product("z-viable", "shop.test", "Sidr Honey 500g", { price: { raw: "GBP 10", currency: "GBP", amount: 10 }, sourceUrl: "https://shop.test/en-gb/products/viable" });
  const stalePrimary = product("a-stale", "shop.test", "Sidr Honey 500g", { price: { raw: "GBP 10", currency: "GBP", amount: 10 }, observedAt: "2020-01-01T00:00:00.000Z" });
  const ukRival = product("r-uk", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 }, sourceUrl: "https://rival.test/en-gb/products/honey" });
  const usRival = product("r-us", "other.test", "Sidr Honey 500g", { price: { raw: "USD 8", currency: "USD", amount: 8 }, sourceUrl: "https://other.test/en-us/products/honey" });
  let judgedPrimaryId = "";
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    const request = JSON.parse(body.input[1].content);
    judgedPrimaryId = request.groups[0].primary.id;
    return response({ output_text: JSON.stringify({ assessments: request.groups[0].candidates.map((candidate) => ({ primaryId: judgedPrimaryId, candidateId: candidate.id, verdict: "no_match", confidence: 0.99, reason: "Test selection.", contradiction: "" })) }) });
  };

  await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [stalePrimary, viablePrimary] },
    { domain: "rival.test", products: [ukRival] },
    { domain: "other.test", products: [usRival] },
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 1, maxCandidatesPerPrimary: 2, referenceTimeMs: Date.parse("2026-07-20T00:00:00.000Z"), marketCountryCode: "GB" });

  assert.equal(judgedPrimaryId, "z-viable");
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
  const rivals = [product("r1", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 } }), product("r2", "rival.test", "Olive Oil 1L", { price: { raw: "GBP 9", currency: "GBP", amount: 9 } })];
  let savedCheckpoints = 0;
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
  ], {}, { apiKey: "test", fetch, maxPrimaryProducts: 2, saveJudgeBatchCheckpoint: async () => { savedCheckpoints += 1; } });

  assert.equal(comparison.matching?.method, "ai-hybrid");
  assert.equal(comparison.matching?.primaryProductsAssessed, 1);
  assert.equal(comparison.coverage.assignedPairCount, 1);
  assert.equal(savedCheckpoints, 0);
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

test("one primary with more than 25 pins is split into complete bounded judge batches", async () => {
  const primary = product("p-many-pins", "shop.test", "Beef Cubes Halal 500g");
  const rivals = Array.from({ length: 26 }, (_, index) => product(`r-many-${index}`, "rival.test", `Beef Cubes Halal 500g option ${index}`, { price: { raw: `GBP ${index + 1}`, currency: "GBP", amount: index + 1 } }));
  const pairCounts = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index / 100] })) });
    const request = JSON.parse(body.input[1].content);
    pairCounts.push(request.groups.reduce((sum, group) => sum + group.candidates.length, 0));
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({ primaryId: group.primary.id, candidateId: candidate.id, verdict: "no_match", confidence: 0.99, reason: "Bounded split test.", contradiction: "" }))) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "rival.test", products: rivals }], {}, {
    apiKey: "test",
    fetch,
    maxPrimaryProducts: 1,
    maxCandidatesPerPrimary: 26,
    maxCandidatesPerDomain: 26,
    maxProductsPerCompetitor: 26,
    maxRetrievalPoolPerDomain: 26,
    maxPairsPerJudgeCall: 25,
    pinnedPairs: rivals.map((rival) => ({ primaryId: primary.id, rivalDomain: "rival.test", rivalId: rival.id })),
  });

  assert.deepEqual(pairCounts, [25, 1]);
  assert.equal(comparison.matching?.primaryProductsAssessed, 1);
  assert.equal(comparison.matching?.totalJudgeBatches, 2);
});

test("the default retrieval budget judges five viable candidates for one primary product", async () => {
  const primary = product("five-p", "shop.test", "Beef Cubes Halal 500g");
  const rivals = Array.from({ length: 5 }, (_, index) => product(
    `five-r${index}`,
    "rival.test",
    `Beef Cubes Halal 500g option ${index}`,
  ));
  let judgedCandidateIds = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index / 100] })) });
    const request = JSON.parse(body.input[1].content);
    judgedCandidateIds = request.groups[0].candidates.map((candidate) => candidate.id);
    return response({ output_text: JSON.stringify({ assessments: request.groups[0].candidates.map((candidate) => ({
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
    { domain: "rival.test", products: rivals },
  ], {}, { apiKey: "test", fetch });

  assert.equal(judgedCandidateIds.length, 5);
  assert.equal(new Set(judgedCandidateIds).size, 5);
  assert.equal(comparison.matching?.candidatePairsAssessed, 5);
});

test("one exact pin supplements rather than displaces the five ordinary candidates", async () => {
  const primary = product("pin-plus-five-p", "shop.test", "Beef Cubes Halal 500g");
  const rivals = Array.from({ length: 6 }, (_, index) => product(`pin-plus-five-r${index}`, "rival.test", `Beef Cubes Halal 500g option ${index}`));
  let judgedCandidateIds = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index / 100] })) });
    const request = JSON.parse(body.input[1].content);
    judgedCandidateIds = request.groups[0].candidates.map((candidate) => candidate.id);
    return response({ output_text: JSON.stringify({ assessments: request.groups[0].candidates.map((candidate) => ({ primaryId: primary.id, candidateId: candidate.id, verdict: "no_match", confidence: 0.99, reason: "Test assessment.", contradiction: "" })) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "rival.test", products: rivals }], {}, {
    apiKey: "test",
    fetch,
    pinnedPairs: [{ primaryId: primary.id, rivalDomain: "rival.test", rivalId: rivals[5].id }],
  });

  assert.equal(judgedCandidateIds.length, 6);
  assert.equal(new Set(judgedCandidateIds).size, 6);
  assert.equal(comparison.matching?.candidatePairsAssessed, 6);
});

test("the matcher default admits the complete single-seller 6000-product universe", () => {
  assert.equal(MAX_COMPETITOR_PRODUCTS_PER_CATALOG, 6_000);
});

test("accepted backup candidates survive matching until the final priced-result selection", async () => {
  const primary = product("backup-p", "shop.example", "Beef Cubes Halal 500g", { price: { raw: "GBP 10", currency: "GBP", amount: 10 }, sourceUrl: "https://shop.example/products/beef?country=GB" });
  const unpriced = product("backup-r1", "rival.example", "Beef Cubes Halal 500g", { sourceUrl: "https://rival.example/products/beef-one?country=GB" });
  const priced = product("backup-r2", "rival.example", "Beef Cubes Halal 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 }, sourceUrl: "https://rival.example/products/beef-two?country=GB" });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index / 100] })) });
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups[0].candidates.map((candidate) => ({ primaryId: primary.id, candidateId: candidate.id, verdict: "same_product", confidence: candidate.id === unpriced.id ? 0.99 : 0.98, reason: "Same observed product identity.", contradiction: "" })) }) });
  };

  const screened = await buildAIProductComparison("shop.example", [
    { domain: "shop.example", products: [primary] },
    { domain: "rival.example", products: [unpriced, priced] },
  ], {}, { apiKey: "test", fetch, maxCandidatesPerPrimary: 2, maxCandidatesPerDomain: 2, marketCountryCode: "GB" });
  assert.deepEqual(screened.rows[0].matches.flatMap((match) => match.product?.id || []), [unpriced.id, priced.id]);

  screened.marketCountryCode = "GB";
  const published = publishPricedProductComparison(screened, Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(published.rows[0].matches.find((match) => match.product?.id === priced.id)?.publication?.priceEligible, true);
  assert.equal(published.rows[0].matches.find((match) => match.excludedProduct?.id === unpriced.id)?.publication?.reason, "missing-valid-rival-price");
});

test("products with no viable candidates still count as screened for honest exhaustion", async () => {
  const primaries = Array.from({ length: 4 }, (_, index) => product(`empty-p${index}`, "shop.test", `Unique local item ${index}`));
  const rival = product("empty-r", "rival.test", "Unrelated imported service");
  let judgeCalls = 0;
  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaries },
    { domain: "rival.test", products: [rival] },
  ], {}, {
    apiKey: "test",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [0, 0] })) });
      judgeCalls += 1;
      return response({ output_text: JSON.stringify({ assessments: [] }) });
    },
    maxPrimaryProducts: 4,
  });

  assert.equal(judgeCalls, 0);
  assert.equal(comparison.matching?.primaryProductsScreened, 4);
  assert.deepEqual(comparison.matching?.selectedPrimaryIds, primaries.map((item) => item.id));
  assert.equal(comparison.matching?.primaryProductsAssessed, 0);
  assert.deepEqual(comparison.matching?.processedPrimaryIds, primaries.map((item) => item.id));
  assert.equal(comparison.matching?.method, "ai-hybrid");
});

test("durable candidate-plan failures stop matching before any judge call", async () => {
  const primary = product("durable-p", "shop.test", "Sidr Honey 500g");
  const rival = product("durable-r", "rival.test", "Sidr Honey 500g");
  for (const failure of ["load", "save"]) {
    let judgeCalls = 0;
    const comparison = await buildAIProductComparison("shop.test", [{ domain: "shop.test", products: [primary] }, { domain: "rival.test", products: [rival] }], {}, {
      apiKey: "test",
      loadCandidatePlan: async () => { if (failure === "load") throw new Error("storage unavailable"); return null; },
      saveCandidatePlan: async () => { if (failure === "save") throw new Error("storage unavailable"); },
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
        judgeCalls += 1;
        return response({ output_text: JSON.stringify({ assessments: [] }) });
      },
    });
    assert.equal(judgeCalls, 0);
    assert.equal(comparison.matching?.available, false);
    assert.match(comparison.matching?.gaps.join(" ") || "", /candidate-plan/i);
  }
});

test("the candidate budget follows the strongest candidates instead of forcing domain diversity", async () => {
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
    index === 99 ? { price: { raw: "GBP 8", currency: "GBP", amount: 8 } } : {},
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

test("assesses 1000 selected products in bounded judge batches after one catalog embedding pass", async () => {
  const primaryProducts = Array.from({ length: 1_000 }, (_, index) => product(`deep-p${index}`, "shop.test", `Catalog Item ${index}`));
  const rival = product("deep-r1", "rival.test", "Catalog Item");
  const embeddingProductIds = [];
  const judgePairCounts = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) {
      embeddingProductIds.push(...body.input.map((text) => text.match(/^name: (.+)$/m)?.[1] || ""));
      return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    }
    const request = JSON.parse(body.input[1].content);
    judgePairCounts.push(request.groups.reduce((sum, group) => sum + group.candidates.length, 0));
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: "no_match",
      confidence: 0.99,
      reason: "Different products.",
      contradiction: "",
    }))) }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaryProducts },
    { domain: "rival.test", products: [rival] },
  ], {}, {
    apiKey: "test",
    fetch,
    maxPrimaryProducts: 1_000,
    primaryProductsPerJudgeCall: 50,
    maxPairsPerJudgeCall: 50,
    totalBudgetMs: 120_000,
  });

  assert.equal(new Set(embeddingProductIds).size, 1_001);
  assert.equal(embeddingProductIds.length, 1_001);
  assert.equal(comparison.matching?.primaryProductsAssessed, 1_000);
  assert.equal(comparison.matching?.totalJudgeBatches, 40);
  assert.equal(comparison.matching?.judgeCalls, 40);
  assert.ok(judgePairCounts.every((count) => count <= 25));
});

test("checkpoint identity ignores nondeterministic retrieval-score drift", () => {
  const primary = product("checkpoint-primary", "shop.test", "Sidr Honey 500g");
  const rival = product("checkpoint-rival", "rival.test", "Sidr Honey 500g");
  const group = (retrievalScore) => [{
    primary,
    candidates: [{ product: rival, lexicalScore: 0.9, lexicalEligible: true, semanticScore: retrievalScore, identitySignal: true, retrievalScore }],
  }];

  const first = judgeBatchKey("test-model", group(0.81231), 0, 1);
  const retry = judgeBatchKey("test-model", group(0.81239), 0, 1);

  assert.equal(retry.batchHash, first.batchHash);
});

test("a persisted candidate plan makes retries independent of embedding drift", async () => {
  const primary = product("plan-p", "shop.test", "Organic Sidr Honey 500g");
  const rivals = [
    product("plan-r1", "rival.test", "Organic Sidr Honey 500g"),
    product("plan-r2", "rival.test", "Raw Honey 500g"),
    product("plan-r3", "rival.test", "Olive Oil 500ml"),
  ];
  let savedPlan;
  let savedPlanKey;
  const judged = [];
  const run = async (retry) => buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [{ ...primary, observedAt: retry ? "2026-08-02T00:00:00.000Z" : primary.observedAt, imageUrl: retry ? "https://shop.test/new-image.jpg" : "", priceSignals: retry ? [{ raw: "GBP 12", currency: "GBP", amount: 12 }] : [] }] },
    { domain: "rival.test", products: rivals.map((rival, index) => ({ ...rival, observedAt: retry ? "2026-08-02T00:00:00.000Z" : rival.observedAt, imageUrl: retry ? `https://rival.test/new-${index}.jpg` : "", priceSignals: retry ? [{ raw: `GBP ${8 + index}`, currency: "GBP", amount: 8 + index }] : [] })) },
  ], {}, {
    apiKey: "test",
    maxCandidatesPerPrimary: 2,
    referenceTimeMs: Date.parse("2026-08-01T00:00:00.000Z"),
    loadCandidatePlan: async (key) => {
      if (retry) assert.deepEqual(key, savedPlanKey);
      return retry ? savedPlan : null;
    },
    saveCandidatePlan: async (key, plan) => { savedPlanKey = key; savedPlan = plan; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/embeddings")) {
        if (retry) throw new Error("retry must reuse the persisted candidate plan");
        return response({ data: body.input.map((_, index) => ({ index, embedding: index === 0 ? [1, 0] : [1, index / 10] })) });
      }
      const request = JSON.parse(body.input[1].content);
      judged.push(request.groups.flatMap((group) => group.candidates.map((candidate) => candidate.id)));
      return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({ primaryId: group.primary.id, candidateId: candidate.id, verdict: "no_match", confidence: 0.99, reason: "Different product.", contradiction: "" }))) }) });
    },
  });

  const first = await run(false);
  const second = await run(true);
  assert.ok(savedPlan);
  assert.deepEqual(judged[1], judged[0]);
  assert.ok(first.matching.embeddingCalls > 0);
  assert.equal(second.matching.embeddingCalls, 0);

  const completePlan = savedPlan;
  savedPlan = { ...savedPlan, candidatePairPoolTruncated: true };
  savedPlan.contentHash = createHash("sha256").update(JSON.stringify({ groups: savedPlan.groups, candidatePairPoolTruncated: true })).digest("hex");
  const poolTruncated = await run(true);
  assert.match(poolTruncated.matching.gaps.join(" "), /omitted additional ordinary backup candidates/i);

  savedPlan = completePlan;
  savedPlan = { ...savedPlan, groups: savedPlan.groups.map((group) => ({ ...group, candidateKeys: group.candidateKeys.slice(1) })), candidatePairCount: savedPlan.groups.reduce((sum, group) => sum + Math.max(0, group.candidateKeys.length - 1), 0) };
  const truncated = await run(true);
  assert.equal(truncated.matching.available, false);
  assert.match(truncated.matching.gaps.join(" "), /incomplete or invalid|truncated matching pool/i);
  assert.equal(judged.length, 3);
});

test("replays complete deterministic judge checkpoints without another judge call", async () => {
  const primaries = Array.from({ length: 4 }, (_, index) => product(`checkpoint-p${index}`, "shop.test", `Checkpoint Item ${index}`));
  const rivals = primaries.map((_, index) => product(`checkpoint-r${index}`, "rival.test", `Checkpoint Item ${index}`));
  const checkpoints = new Map();
  const loadedKeys = [];
  const savedKeys = [];
  let judgeCalls = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index % 2] })) });
    judgeCalls += 1;
    const request = JSON.parse(body.input[1].content);
    assert.ok(request.groups.every((group) => group.candidates.every((candidate) => !("retrievalScore" in candidate))));
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: "no_match",
      confidence: 0.99,
      reason: "Different products.",
      contradiction: "",
    }))) }) });
  };
  const options = {
    apiKey: "test",
    fetch,
    maxPrimaryProducts: 4,
    maxCandidatesPerPrimary: 1,
    primaryProductsPerJudgeCall: 2,
    maxPairsPerJudgeCall: 2,
    loadJudgeBatchCheckpoint: async (key) => {
      loadedKeys.push(structuredClone(key));
      return checkpoints.get(key.batchHash) ?? null;
    },
    saveJudgeBatchCheckpoint: async (key, checkpoint) => {
      assert.doesNotThrow(() => JSON.stringify({ key, checkpoint }));
      savedKeys.push(structuredClone(key));
      checkpoints.set(key.batchHash, checkpoint);
    },
  };

  const first = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaries },
    { domain: "rival.test", products: rivals },
  ], {}, options);
  const callsAfterFirstRun = judgeCalls;
  for (const [hash, checkpoint] of checkpoints) {
    const legacy = structuredClone(checkpoint);
    delete legacy.evidenceGroups;
    checkpoints.set(hash, { ...legacy, version: 1 });
  }
  const second = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: primaries.map((item) => ({ ...item, imageUrl: `https://shop.test/images/${item.id}-new.jpg`, priceSignals: [{ raw: "GBP 12", currency: "GBP", amount: 12 }], observedAt: "2026-08-02T00:00:00.000Z" })) },
    { domain: "rival.test", products: rivals.map((item) => ({ ...item, imageUrl: `https://rival.test/images/${item.id}-new.jpg`, priceSignals: [{ raw: "GBP 10", currency: "GBP", amount: 10 }], observedAt: "2026-08-02T00:00:00.000Z" })) },
  ], {}, options);

  assert.equal(first.matching?.totalJudgeBatches, 2);
  assert.equal(first.matching?.savedJudgeCheckpoints, 2);
  assert.equal(first.matching?.reusedJudgeCheckpoints, 0);
  assert.equal(callsAfterFirstRun, 2);
  assert.equal(judgeCalls, callsAfterFirstRun);
  assert.equal(second.matching?.judgeCalls, 0);
  assert.equal(second.matching?.reusedJudgeCheckpoints, 2);
  assert.equal(second.matching?.savedJudgeCheckpoints, 0);
  assert.deepEqual(savedKeys.map((key) => [key.batchIndex, key.batchCount]).sort((left, right) => left[0] - right[0]), [[0, 2], [1, 2]]);
  const firstLoadByIndex = new Map(loadedKeys.slice(0, 2).map((key) => [key.batchIndex, key.batchHash]));
  const replayLoadByIndex = new Map(loadedKeys.slice(2).map((key) => [key.batchIndex, key.batchHash]));
  assert.deepEqual(replayLoadByIndex, firstLoadByIndex);
});

test("durable judge evidence preserves accepted backup pairs within the checkpoint size bound", async () => {
  const primary = product("evidence-p1", "shop.test", "Beef Cubes Halal 500g", {
    price: { raw: "GBP 9", currency: "GBP", amount: 9 },
    imageUrl: "https://shop.test/images/beef-cubes.jpg",
  });
  const rivals = Array.from({ length: 5 }, (_, index) => product(`evidence-r${index + 1}`, "rival.test", "Beef Cubes Halal 500g", {
    price: { raw: `GBP ${8 - index / 10}`, currency: "GBP", amount: 8 - index / 10 },
    imageUrl: `https://rival.test/images/beef-cubes-${index + 1}.jpg`,
  }));
  let savedCheckpoint = null;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, index % 2] })) });
    const request = JSON.parse(body.input[1].content);
    return response({ output_text: JSON.stringify({ assessments: request.groups.flatMap((group) => group.candidates.map((candidate) => ({
      primaryId: group.primary.id,
      candidateId: candidate.id,
      verdict: "same_product",
      confidence: 0.98,
      reason: "Same observed product and pack size.",
      contradiction: "",
    }))) }) });
  };

  await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: rivals },
  ], {}, {
    apiKey: "test",
    fetch,
    maxPrimaryProducts: 1,
    maxCandidatesPerPrimary: 5,
    saveJudgeBatchCheckpoint: async (_key, checkpoint) => { savedCheckpoint = checkpoint; },
  });

  assert.ok(savedCheckpoint);
  assert.ok(Buffer.byteLength(JSON.stringify(savedCheckpoint), "utf8") < 512 * 1024);
  const screened = screenedComparisonFromJudgeCheckpoints("shop.test", [savedCheckpoint], "GB");
  assert.equal(screened?.rows.length, 1);
  assert.equal(screened?.rows[0].matches.length, 5);
  assert.deepEqual(screened?.rows[0].matches.map((match) => match.excludedProduct?.id).sort(), rivals.map((item) => item.id).sort());
  assert.ok(screened?.rows[0].matches.every((match) => match.publication?.reason === "outside-result-target"));
});

test("rejects malformed judge checkpoints and replaces them only with a complete live result", async () => {
  const primary = product("malformed-p1", "shop.test", "Sidr Honey 500g");
  const rival = product("malformed-r1", "rival.test", "Sidr Honey 500g", { price: { raw: "GBP 8", currency: "GBP", amount: 8 } });
  let judgeCalls = 0;
  let savedCheckpoint = null;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/embeddings")) return response({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    judgeCalls += 1;
    return response({ output_text: JSON.stringify({ assessments: [{
      primaryId: primary.id,
      candidateId: rival.id,
      verdict: "same_product",
      confidence: 0.98,
      reason: "Same observed offer.",
      contradiction: "",
    }] }) });
  };

  const comparison = await buildAIProductComparison("shop.test", [
    { domain: "shop.test", products: [primary] },
    { domain: "rival.test", products: [rival] },
  ], {}, {
    apiKey: "test",
    fetch,
    loadJudgeBatchCheckpoint: async (key) => ({
      version: 1,
      batchHash: key.batchHash,
      batchIndex: key.batchIndex,
      batchCount: key.batchCount + 1,
      model: key.model,
      promptVersion: key.promptVersion,
      assessments: [{ primaryId: primary.id, candidateId: rival.id, verdict: "same_product", confidence: 0.98, reason: "Same observed offer.", contradiction: "" }],
    }),
    saveJudgeBatchCheckpoint: async (_key, checkpoint) => { savedCheckpoint = checkpoint; },
  });

  assert.equal(judgeCalls, 1);
  assert.equal(comparison.matching?.reusedJudgeCheckpoints, 0);
  assert.equal(comparison.matching?.savedJudgeCheckpoints, 1);
  assert.equal(savedCheckpoint?.assessments[0].candidateId, rival.id);
  assert.equal(comparison.rows[0].matches[0].product?.id, rival.id);
});
