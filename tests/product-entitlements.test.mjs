import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT_PLAN_LIMITS, resolveProductEntitlement } from "../app/lib/product-entitlements.ts";

test("every hosted plan assesses the same bounded number of products per report", () => {
  assert.deepEqual(PRODUCT_PLAN_LIMITS, { starter: 20, solo: 20, growth: 20, agency: 20 });
});

test("server registry resolves MyJam to Agency while other domains use the safe default", () => {
  const registryJson = JSON.stringify({ "MYJAM.CO.UK": "agency", "solo.example": "solo" });
  assert.deepEqual(resolveProductEntitlement("https://myjam.co.uk/", { defaultPlan: "growth", registryJson }), { plan: "agency", productLimit: 20 });
  assert.deepEqual(resolveProductEntitlement("solo.example", { defaultPlan: "growth", registryJson }), { plan: "solo", productLimit: 20 });
  assert.deepEqual(resolveProductEntitlement("unknown.example", { defaultPlan: "growth", registryJson }), { plan: "growth", productLimit: 20 });
});

test("invalid or missing server configuration fails safely to Starter", () => {
  assert.deepEqual(resolveProductEntitlement("shop.example"), { plan: "starter", productLimit: 20 });
  assert.deepEqual(resolveProductEntitlement("shop.example", { defaultPlan: "unlimited", registryJson: "not-json" }), { plan: "starter", productLimit: 20 });
});
