import assert from "node:assert/strict";
import test from "node:test";
import { reportCoverage } from "../app/lib/report-coverage.ts";

const limited = (idempotencyKey, phase, metadata = {}) => ({ idempotencyKey, phase, status: "limited", message: "Limited.", metadata });

test("complete reports use a ready state", () => {
  const result = reportCoverage("complete", [], false);
  assert.equal(result.label, "Ready");
  assert.match(result.detail, /checks completed/);
});

test("bounded matching defects explain that accepted comparisons remain usable", () => {
  const result = reportCoverage("limited", [limited("matching-complete", "matching", { limited: true })], false);
  assert.match(result.detail, /not fully assessed/);
  assert.match(result.detail, /evidence-backed and usable/);
});

test("a terminal crawl takes priority over downstream skipped phases", () => {
  const result = reportCoverage("limited", [
    limited("crawl-limited", "crawl"),
    limited("matching-limited", "matching", { upstream: "crawl" }),
  ], false);
  assert.match(result.detail, /website was not available/);
  assert.match(result.detail, /did not run/);
  assert.doesNotMatch(result.detail, /comparisons are evidence-backed/);
});

test("missing attributable products are not described as accepted comparisons", () => {
  const result = reportCoverage("limited", [limited("matching-limited", "matching")], false);
  assert.match(result.detail, /matching could not run/);
  assert.match(result.detail, /not evidence.*no products/);
});

test("enrichment gaps identify potentially missing prices and images", () => {
  const result = reportCoverage("limited", [limited("enrichment-limited", "enrichment")], false);
  assert.match(result.detail, /prices or images/);
});

test("fact persistence gaps are not presented as public-source gaps", () => {
  const result = reportCoverage("limited", [limited("facts-limited", "persistence")], false);
  assert.match(result.detail, /structured fact set/);
  assert.match(result.detail, /future evaluation and tracking/);
  assert.doesNotMatch(result.detail, /planned source/);
});

test("legacy limited reports disclose that the affected check is unknown", () => {
  const result = reportCoverage("limited", [], false);
  assert.match(result.detail, /older record/);
  assert.match(result.detail, /does not identify/);
});
