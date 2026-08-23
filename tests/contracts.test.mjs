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
