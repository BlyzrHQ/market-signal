import assert from "node:assert/strict";
import test from "node:test";

import { comparablePriceDelta, isDefensibleProductMatch, parseComparablePrice, resolvedPriceDelta } from "../app/lib/report-presentation.ts";

test("parses one explicit public price and rejects ambiguous price text", () => {
  assert.deepEqual(parseComparablePrice("GBP 26.99"), { amount: 26.99, currency: "GBP" });
  assert.deepEqual(parseComparablePrice("£13.94"), { amount: 13.94, currency: "GBP" });
  assert.deepEqual(parseComparablePrice("£1,299"), { amount: 1299, currency: "GBP" });
  assert.equal(parseComparablePrice("£10–£15"), null);
  assert.equal(parseComparablePrice("from 10"), null);
  assert.equal(parseComparablePrice("Not observed"), null);
});

test("draws a price delta only for comparable currencies", () => {
  assert.deepEqual(comparablePriceDelta("GBP 20", "£15"), {
    primary: { amount: 20, currency: "GBP" },
    rival: { amount: 15, currency: "GBP" },
    percent: -25,
    equal: false,
  });
  assert.deepEqual(comparablePriceDelta("GBP 15", "£20"), {
    primary: { amount: 15, currency: "GBP" },
    rival: { amount: 20, currency: "GBP" },
    percent: 25,
    equal: false,
  });
  assert.equal(comparablePriceDelta("GBP 20", "USD 15"), null);
  assert.equal(comparablePriceDelta("GBP 20–30", "GBP 15"), null);
});

test("draws a battle delta only from the server-resolved comparison", () => {
  assert.equal(resolvedPriceDelta(null), null);
  assert.equal(resolvedPriceDelta({ primaryRaw: "", rivalRaw: "GBP 8.49" }), null);
  assert.deepEqual(resolvedPriceDelta({ primaryRaw: "GBP 8", rivalRaw: "GBP 6" }), {
    primaryRaw: "GBP 8",
    rivalRaw: "GBP 6",
    primary: { amount: 8, currency: "GBP" },
    rival: { amount: 6, currency: "GBP" },
    percent: -25,
    equal: false,
  });
});

test("shows only medium-confidence product matches as defensible battles", () => {
  assert.equal(isDefensibleProductMatch(0.55, "Medium"), true);
  assert.equal(isDefensibleProductMatch(0.5499, "Medium"), false);
  assert.equal(isDefensibleProductMatch(0.9, "Low"), false);
  assert.equal(isDefensibleProductMatch(Number.NaN, "Medium"), false);
});
