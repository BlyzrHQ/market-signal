import assert from "node:assert/strict";
import test from "node:test";

import { newestAccountReportPath, safeAccountReturnPath } from "../app/lib/account-report-redirect.ts";

test("account return paths are local and cannot loop back to sign in", () => {
  assert.equal(safeAccountReturnPath("/reports/abc?view=products"), "/reports/abc?view=products");
  assert.equal(safeAccountReturnPath("https://attacker.example"), "");
  assert.equal(safeAccountReturnPath("//attacker.example"), "");
  assert.equal(safeAccountReturnPath("/\\attacker.example"), "");
  assert.equal(safeAccountReturnPath("/\t/attacker.example"), "");
  assert.equal(safeAccountReturnPath("/%5Cattacker.example"), "");
  assert.equal(safeAccountReturnPath("/%2F%2Fattacker.example"), "");
  assert.equal(safeAccountReturnPath("/%"), "");
  assert.equal(safeAccountReturnPath("/.//attacker.example"), "");
  assert.equal(safeAccountReturnPath("/..//attacker.example"), "");
  assert.equal(safeAccountReturnPath("/%2e%2e//attacker.example"), "");
  assert.equal(safeAccountReturnPath("/a/..//attacker.example"), "");
  assert.equal(safeAccountReturnPath("/account"), "");
  assert.equal(safeAccountReturnPath("/account?next=/reports/a"), "");
});

test("successful sign in opens the newest valid saved report", () => {
  const newest = "a".repeat(32);
  const older = "b".repeat(32);
  assert.equal(newestAccountReportPath({ reports: [
    { publicId: newest, primaryDomain: "new.example" },
    { publicId: older, primaryDomain: "old.example" },
  ] }), `/reports/${newest}?view=products`);
  assert.equal(newestAccountReportPath({ reports: [] }), "");
  assert.equal(newestAccountReportPath({ reports: [{ publicId: "unsafe" }] }), "");
  assert.equal(newestAccountReportPath(null), "");
});
