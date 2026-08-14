import assert from "node:assert/strict";
import test from "node:test";

import { inferBusinessProfile } from "../app/lib/business-profile.ts";

function profile(overrides = {}) {
  return inferBusinessProfile({
    domain: "example.com",
    title: "Example",
    description: "",
    region: "Not enough public signal",
    language: "en",
    products: [],
    pages: [],
    ...overrides,
  });
}

test("classifies a social media software product from core copy despite an agency blog headline", () => {
  const result = profile({
    domain: "buffer.com",
    title: "Buffer: Social media management for everyone",
    description: "Plan, publish, and analyze your social media from one platform.",
    pages: [{ title: "Buffer", description: "Social media management software", path: "/", sourceUrl: "https://buffer.com/", headings: ["How to Run a Successful PR Agency in the Age of Social Media"] }],
  });
  assert.equal(result.businessType, "saas");
});

test("classifies delivered produce boxes as ecommerce", () => {
  const result = profile({
    domain: "oddbox.co.uk",
    title: "Good Food Doing Good, Delivered to Your Door",
    description: "Choose a fruit and veg box subscription.",
    pages: [{ title: "Fruit and veg boxes", description: "Food delivered weekly", path: "/boxes", sourceUrl: "https://oddbox.co.uk/boxes", headings: ["Fruit & Veg Box"] }],
  });
  assert.equal(result.businessType, "ecommerce");
});

test("prefers a descriptive title segment over the brand-only segment", () => {
  const result = profile({
    domain: "pipandnut.com",
    title: "Pip & Nut | Natural Nut Butters, Cups & Bars | Shop Online",
    description: "Natural nut butter and snacks.",
  });
  assert.match(result.category, /Natural Nut Butters/i);
  assert.notEqual(result.category, "Pip & Nut");
});

test("keeps promotional shipping and setup copy out of an ecommerce category", () => {
  const result = profile({
    domain: "wearform.com",
    title: "Custom Work Uniforms with Logo | Free Shipping & No Set-up Charge &ndash; WearForm.com",
    description: "Custom branded workwear, uniforms, shirts, safety apparel, and company clothing.",
  });
  assert.equal(result.category, "Custom Work Uniforms with Logo");
});
