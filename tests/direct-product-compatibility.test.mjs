import test from "node:test";
import assert from "node:assert/strict";
import { directProductContradictions } from "../app/lib/direct-product-compatibility.ts";
const p = (name, category = "") => ({ name, category, attributes: [] });
test("known observed-function contradictions are rejected, not ranked by price", () => {
  assert.ok(directProductContradictions(p("Body Sunscreen Last Chance"), p("Glow Restore Shower Oil")).includes("different-product-functions"));
  assert.ok(directProductContradictions(p("Body Sunscreen"), p("Skin Replenishing Body Wash")).includes("different-product-functions"));
  assert.ok(directProductContradictions(p("Body Sunscreen"), p("Face Essentials (Cleanser + Moisturizer)")).includes("different-product-functions"));
  assert.ok(directProductContradictions(p("واقي شمس"), p("غسول الجسم")).includes("different-product-functions"));
});
test("bundles, explicit counts and observed quantities cannot inflate usable pairs", () => {
  assert.ok(directProductContradictions(p("Clean Essentials Kit"), p("Bathroom Cleaner Refill")).includes("bundle-versus-single-product"));
  assert.ok(directProductContradictions(p("Clean Hair Trio"), p("Hair Care Duo")).includes("different-bundle-counts"));
  assert.ok(directProductContradictions(p("IceFlow Bottle 36 oz"), p("Wide Mouth Bottle 32 oz")).includes("different-observed-quantities"));
});
test("same-function alternatives stay eligible and unknown function is not claimed as certified", () => {
  assert.deepEqual(directProductContradictions(p("Body Wash"), p("Body Wash")), []);
  assert.deepEqual(directProductContradictions(p("Food Jar 18 oz"), p("Stainless Food Jar 18 oz")), []);
  assert.deepEqual(directProductContradictions(p("Blue Moon"), p("Morning Dew")), []);
});
