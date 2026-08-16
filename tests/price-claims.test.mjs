import assert from "node:assert/strict";
import test from "node:test";

import { formatPriceClaim, formatPriceDifference, resolvePriceClaim } from "../app/lib/price-claims.ts";

const mass = (amount) => ({ kind: "mass", amount, unit: "g" });

test("keeps direct percentage claims behind the approved comparison", () => {
  const claim = resolvePriceClaim({
    comparisonValue: { primaryRaw: "GBP 10.00", rivalRaw: "GBP 8.00" },
    primaryRaw: "GBP 10.00",
    rivalRaw: "GBP 8.00",
  });

  assert.equal(claim.kind, "direct");
  assert.equal(claim.direction, "rival");
  assert.equal(claim.percent, 20);
  assert.equal(formatPriceClaim(claim, "en").headline, "Rival is 20% cheaper");
});

test("turns two unaligned same-currency observations into a listed-price gap", () => {
  const claim = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 1.89",
    rivalRaw: "GBP 1.14",
  });
  const copy = formatPriceClaim(claim, "en");

  assert.equal(claim.kind, "listed-gap");
  assert.equal(claim.direction, "rival");
  assert.equal(claim.gap, 0.75);
  assert.equal(copy.headline, "Rival listed price is GBP 0.75 lower");
  assert.match(copy.detail, /no percentage is shown/i);
  assert.doesNotMatch(copy.headline, /cheaper|%/i);
  assert.deepEqual(formatPriceDifference(claim, "en"), {
    label: "Listed-price gap",
    value: "GBP 0.75",
    direction: "Rival listed price is lower",
    note: "Not like-for-like; pack and variant unverified",
  });
});

test("leads the table difference with money and keeps the comparison basis visible", () => {
  const direct = resolvePriceClaim({
    comparisonValue: { primaryRaw: "USD 80.00", rivalRaw: "USD 60.00" },
    primaryRaw: "USD 80.00",
    rivalRaw: "USD 60.00",
  });
  const unit = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 4.00",
    rivalRaw: "GBP 3.00",
    primaryQuantity: mass(500),
    rivalQuantity: mass(250),
  });

  assert.deepEqual(formatPriceDifference(direct, "en"), {
    label: "Verified price gap",
    value: "USD 20.00",
    direction: "Rival is 25% lower",
    note: "Verified direct comparison",
  });
  assert.deepEqual(formatPriceDifference(unit, "en"), {
    label: "Gap per 100g",
    value: "GBP 0.40",
    direction: "Your unit price is 33% lower",
    note: "Computed from listed price and quantity",
  });
});

test("normalizes compatible different quantities and labels the result computed", () => {
  const claim = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 4.00",
    rivalRaw: "GBP 3.00",
    primaryQuantity: mass(500),
    rivalQuantity: mass(250),
  });
  const copy = formatPriceClaim(claim, "en");

  assert.equal(claim.kind, "unit-normalized");
  assert.equal(claim.direction, "primary");
  assert.equal(claim.percent, 33);
  assert.equal(claim.primaryUnitAmount, 0.8);
  assert.equal(claim.rivalUnitAmount, 1.2);
  assert.equal(copy.headline, "Your computed unit price is 33% lower");
  assert.match(copy.supporting, /GBP 0\.80\/100g vs GBP 1\.20\/100g/i);
  assert.match(copy.supporting, /computed from listed prices/i);
});

test("does not normalize incompatible quantity units", () => {
  const claim = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 4.00",
    rivalRaw: "GBP 3.00",
    primaryQuantity: mass(500),
    rivalQuantity: { kind: "volume", amount: 500, unit: "ml" },
  });

  assert.equal(claim.kind, "listed-gap");
});

test("rejects incoherent canonical quantity objects", () => {
  const claim = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 4.00",
    rivalRaw: "GBP 3.00",
    primaryQuantity: { kind: "count", amount: 500, unit: "g" },
    rivalQuantity: { kind: "count", amount: 250, unit: "g" },
  });

  assert.equal(claim.kind, "listed-gap");
});

test("does not invent gaps for ranges or different currencies", () => {
  const range = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 20.25",
    rivalRaw: "GBP 31.96–35.16",
  });
  const currency = resolvePriceClaim({
    comparisonValue: null,
    primaryRaw: "GBP 4.00",
    rivalRaw: "USD 5.00",
  });

  assert.equal(range.kind, "both-observed");
  assert.equal(currency.kind, "both-observed");
  assert.match(formatPriceClaim(range, "en").detail, /range or unsupported price format/i);
  assert.match(formatPriceClaim(currency, "en").detail, /currencies differ/i);
});

test("renders sub-one-percent direct differences as near parity", () => {
  const claim = resolvePriceClaim({
    comparisonValue: { primaryRaw: "GBP 100.00", rivalRaw: "GBP 99.60" },
    primaryRaw: "GBP 100.00",
    rivalRaw: "GBP 99.60",
  });

  assert.equal(claim.kind, "direct");
  assert.equal(claim.direction, "rival");
  assert.equal(claim.percent, 0);
  assert.equal(formatPriceClaim(claim, "en").headline, "Price difference is under 1%");
  assert.equal(formatPriceDifference(claim, "en").direction, "Difference is under 1%");
  assert.notEqual(formatPriceClaim(claim, "en").lane, "advantage");
});

test("keeps one-price and no-price states distinct in both languages", () => {
  const one = resolvePriceClaim({ comparisonValue: null, primaryRaw: "GBP 4.00", rivalRaw: "" });
  const none = resolvePriceClaim({ comparisonValue: null, primaryRaw: "", rivalRaw: "" });

  assert.equal(one.kind, "one-observed");
  assert.equal(none.kind, "none-observed");
  assert.match(formatPriceClaim(one, "ar").headline, /سعر/);
  assert.match(formatPriceClaim(none, "ar").headline, /أسعار/);
  assert.deepEqual(formatPriceDifference(one, "en"), {
    label: "Gap unavailable",
    value: "—",
    direction: "Only one price is available",
    note: "Two public prices are required",
  });
});
