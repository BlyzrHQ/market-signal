import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProductActionPlans,
  buildAIProductActions,
  collectProductActionInputs,
  deterministicProductActionResult,
} from "../app/lib/ai-action-planner.ts";

function product(domain, id, name, price) {
  return {
    id,
    domain,
    name,
    normalizedName: name.toLowerCase(),
    description: "Raw honey in a 500g jar",
    category: "honey",
    jsonLdType: "Product",
    priceSignals: [{ raw: `GBP ${price}`, currency: "GBP", amount: price }],
    attributes: ["500g jar", "raw honey"],
    ownership: "path-inferred",
    extraction: "json-ld",
    confidence: "High",
    sourceUrl: `https://${domain}/products/${id}`,
    imageUrl: "",
    observedAt: "2026-07-22T10:00:00.000Z",
    claimIds: [`claim-${id}`],
    quantity: { amount: 500, unit: "g", dimension: "mass" },
  };
}

function comparison() {
  const primary = product("myjam.co.uk", "my-honey", "MyJam Raw Honey 500g", 8);
  const rival = product("baklali.app", "rival-honey", "Baklali Raw Honey 500g", 6);
  return {
    primaryDomain: primary.domain,
    comparisonDomains: [rival.domain],
    rows: [{
      primary,
      matches: [{
        domain: rival.domain,
        product: rival,
        score: 0.94,
        confidence: "Medium",
        sharedTerms: ["raw", "honey", "500g"],
        claimIds: rival.claimIds,
        assessment: { verdict: "same_product", reasons: ["Both are observed 500g raw honey jars."], contradictions: [], claimType: "Inferred" },
        decision: {
          priceVerdict: "baklali.app is GBP 2.00 cheaper for the observed pair.",
          whyTheyMayWin: "Baklali exposes a lower public price for the observed 500g jar.",
          recommendedMove: "Either justify your premium with a concrete product advantage or test a matched-price offer.",
          priceComparison: { primary: { raw: "GBP 8", currency: "GBP", amount: 8 }, rival: { raw: "GBP 6", currency: "GBP", amount: 6 }, delta: -2, percent: -25, equal: false },
        },
      }],
    }],
    unmatched: [],
    coverage: {},
  };
}

function responseFor(actions) {
  return async () => Response.json({ output_text: JSON.stringify({ actions }) });
}

function validAction(pairKey) {
  return {
    pairKey,
    actionEn: "Highlight the matched 500g raw honey jar.",
    actionAr: "أبرز عبوة العسل الخام المطابقة بحجم 500 غرام.",
    rationaleEn: "Both observed products are 500g raw honey jars.",
    rationaleAr: "كلا المنتجين المرصودين عبوة عسل خام بحجم 500 غرام.",
    leverType: "positioning",
    evidenceKeys: ["primary.quantity", "rival.name", "rival.price.0", "match.reason.0"],
  };
}

test("missing AI configuration preserves deterministic English and Arabic actions", async () => {
  const inputs = collectProductActionInputs(comparison());
  const result = await buildAIProductActions(inputs, { apiKey: "" });
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].plan.source, "deterministic");
  assert.ok(result.plans[0].plan.actionEn);
  assert.match(result.plans[0].plan.actionAr, /[\u0600-\u06ff]/);
  assert.equal(result.metadata.fallbackActions, 1);
});

test("a grounded structured action is accepted and attached by pair key without changing price truth", async () => {
  const original = comparison();
  const inputs = collectProductActionInputs(original);
  const result = await buildAIProductActions(inputs, { apiKey: "test", fetch: responseFor([validAction(inputs[0].pairKey)]) });
  assert.equal(result.plans[0].plan.source, "ai");
  const applied = applyProductActionPlans(original, result);
  const decision = applied.rows[0].matches[0].decision;
  assert.equal(decision.actionPlan.source, "ai");
  assert.equal(decision.recommendedMove, validAction(inputs[0].pairKey).actionEn);
  assert.deepEqual(decision.priceComparison, original.rows[0].matches[0].decision.priceComparison);
});

test("invented numbers, unknown evidence keys, and unsupported entities are rejected per pair", async () => {
  for (const mutate of [
    (action) => ({ ...action, actionEn: "Cut the price by 17% for this jar." }),
    (action) => ({ ...action, evidenceKeys: ["primary.name", "invented.fact"] }),
    (action) => ({ ...action, actionEn: "Feature the 500g jar beside Acme's offer." }),
    (action) => ({ ...action, actionEn: "Amazon should lead the matched 500g raw honey jar." }),
    (action) => ({ ...action, actionAr: "أبرز Amazon لعبوة العسل الخام المطابقة بحجم 500 غرام." }),
    (action) => ({ ...action, actionAr: "Highlight the matched 500g raw honey jar." }),
    (action) => ({ ...action, actionAr: "اتخذ خطوة تسويقية مناسبة لهذا المنتج.", rationaleAr: "راجع العرض العام قبل اتخاذ القرار." }),
  ]) {
    const inputs = collectProductActionInputs(comparison());
    const result = await buildAIProductActions(inputs, { apiKey: "test", fetch: responseFor([mutate(validAction(inputs[0].pairKey))]) });
    assert.equal(result.plans[0].plan.source, "deterministic");
    assert.equal(result.metadata.aiActionsAccepted, 0);
  }
});

test("price-direction language is rejected when the saved pair has no comparable price basis", async () => {
  const input = { ...collectProductActionInputs(comparison())[0], hasComparablePrice: false };
  for (const draft of [
    { ...validAction(input.pairKey), actionEn: "Lead with your lower price on the 500g raw honey jar." },
    { ...validAction(input.pairKey), actionAr: "أبرز سعرك الأرخص لعبوة العسل الخام بحجم 500 غرام." },
  ]) {
    const result = await buildAIProductActions([input], { apiKey: "test", fetch: responseFor([draft]) });
    assert.equal(result.plans[0].plan.source, "deterministic");
  }
});

test("missing or duplicate model output falls back without dropping product pairs", async () => {
  const first = collectProductActionInputs(comparison())[0];
  const second = { ...first, pairKey: `${first.pairKey}-second` };
  const inputs = [first, second];
  const duplicate = validAction(first.pairKey);
  const result = await buildAIProductActions(inputs, { apiKey: "test", fetch: responseFor([duplicate, duplicate]) });
  assert.equal(result.plans.length, 2);
  assert.equal(result.plans.every((entry) => entry.plan.source === "deterministic"), true);
  assert.equal(result.metadata.fallbackActions, 2);
});

test("deterministic result entries retain stable pair identifiers", () => {
  const inputs = collectProductActionInputs(comparison());
  const result = deterministicProductActionResult(inputs);
  assert.equal(result.plans[0].pairKey, inputs[0].pairKey);
  assert.equal(result.plans[0].plan.model, "");
});

test("pairs beyond the AI drafting cap retain deterministic plans and a visible coverage gap", async () => {
  const base = collectProductActionInputs(comparison())[0];
  const inputs = Array.from({ length: 81 }, (_, index) => ({ ...base, pairKey: `${base.pairKey}-${index}` }));
  const result = await buildAIProductActions(inputs, {
    apiKey: "test",
    maxPairsPerCall: 1,
    maxCalls: 1,
    fetch: responseFor([validAction(inputs[0].pairKey)]),
  });
  assert.equal(result.plans.length, 81);
  assert.equal(result.plans[80].plan.source, "deterministic");
  assert.equal(result.plans[80].plan.model, "");
  assert.match(result.metadata.gaps.join(" "), /beyond the AI drafting cap/i);
});
