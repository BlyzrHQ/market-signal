import assert from "node:assert/strict";
import test from "node:test";
import { validateContract } from "../scripts/contract-validation.mjs";

const validReport = {
  ok: true,
  live: true,
  primaryDomain: "example.com",
  results: [{
    domain: "example.com",
    role: "primary",
    pages: [],
    products: [],
    gaps: [],
    coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 5, robotsChecked: true },
    fetchedAt: "2026-07-15T10:00:00Z",
  }],
  document: {
    version: "1",
    generatedAt: "2026-07-15T10:00:00Z",
    blocks: [{ type: "summary", id: "scan-summary" }],
  },
  crawl: { maxPagesPerDomain: 5, robotsAware: true, generatedAt: "2026-07-15T10:00:00Z" },
};

test("report v1 accepts the service boundary", () => {
  assert.deepEqual(validateContract("report", validReport), { valid: true, errors: [] });
});

test("report v1 catches drift before rendering", () => {
  const result = validateContract("report", { ok: true, live: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("primaryDomain")));
});

test("ads v1 preserves access-limited as a data state", () => {
  const result = validateContract("ads", {
    ok: true,
    block: {
      type: "ad-intelligence",
      id: "ad-intelligence",
      primaryDomain: "example.com",
      available: false,
      provider: "official-links-only",
      observedAt: "2026-07-15T10:00:00Z",
      companies: [{
        domain: "example.com",
        brand: "Example",
        summary: "Access is limited.",
        recommendedAction: "Open the official library.",
        platforms: [{
          platform: "Meta",
          status: "access-limited",
          activeCreativeCount: 0,
          message: "Approval pending.",
          evidenceUrls: [],
          searchUrl: "https://www.facebook.com/ads/library/",
        }],
      }],
      limitation: "Missing coverage is not evidence of zero advertising.",
    },
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});
