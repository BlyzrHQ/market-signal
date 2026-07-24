import assert from "node:assert/strict";
import test from "node:test";

import { POST, parseActionInputs } from "../app/api/actions/route.ts";

const token = "callback_secret_with_enough_entropy_123456";

function input(pairKey = "primary|rival") {
  return {
    pairKey,
    fallbackActionEn: "Compare the observed product evidence.",
    fallbackActionAr: "قارن أدلة المنتج المرصودة.",
    fallbackRationaleEn: "Both public pages name a honey product.",
    fallbackRationaleAr: "تسمي الصفحتان العامتان منتج عسل.",
    fallbackLeverType: "evidence_gap",
    hasComparablePrice: false,
    facts: [
      { key: "primary.name", kind: "identity", text: "Honey 500g" },
      { key: "rival.name", kind: "identity", text: "Raw Honey 500g" },
    ],
  };
}

test("action input parser accepts bounded attributable facts", () => {
  assert.deepEqual(parseActionInputs([input()]), [input()]);
});

test("action input parser rejects duplicate pairs, duplicate facts, invalid fact keys, and oversized requests", () => {
  assert.throws(() => parseActionInputs([input(), input()]), /unique/i);
  assert.throws(() => parseActionInputs([{ ...input(), facts: [input().facts[0], input().facts[0]] }]), /bounded fallback/i);
  assert.throws(() => parseActionInputs([{ ...input(), facts: [{ key: "bad key", kind: "identity", text: "Honey" }] }]), /bounded fallback/i);
  assert.throws(() => parseActionInputs(Array.from({ length: 481 }, (_, index) => input(String(index)))), /480/);
});

test("action route is internal-only and returns deterministic fallbacks when AI is not configured", async () => {
  const previousToken = process.env.MARKET_SIGNAL_CALLBACK_TOKEN;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.MARKET_SIGNAL_CALLBACK_TOKEN = token;
  delete process.env.OPENAI_API_KEY;
  try {
    const unauthorized = await POST(new Request("http://localhost/api/actions", { method: "POST", body: JSON.stringify({ inputs: [input()] }) }));
    assert.equal(unauthorized.status, 401);

    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputs: [input()] }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.plans[0].plan.source, "deterministic");
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (previousToken === undefined) delete process.env.MARKET_SIGNAL_CALLBACK_TOKEN; else process.env.MARKET_SIGNAL_CALLBACK_TOKEN = previousToken;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});
