import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const loading = await readFile(new URL("../app/reports/[publicId]/loading/page.tsx", import.meta.url), "utf8");
const report = await readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("submission exposes a dedicated loading URL and navigates only after document persistence", () => {
  assert.match(home, /history\.pushState\(\{\}, "", `\/reports\/\$\{publicReportId\}\/loading`\)/);
  const save = home.indexOf('action: "document"');
  const navigate = home.indexOf('window.location.pathname === `/reports/${publicReportId}/loading`');
  assert.ok(save >= 0 && navigate > save);
  assert.match(home, /setLoadingMessage\(translatedProgress\(idempotencyKey, message\)\)/);
  assert.match(home, /analysisRunRef\.current \+= 1/);
  assert.match(home, /loading-cancel/);
  assert.doesNotMatch(home, /loadingPercent|progressPercent/);
});

test("reopened loading routes poll persisted events and redirect only with a document", () => {
  assert.match(loading, /fetch\(`\/api\/reports\/\$\{publicId\}`/);
  assert.match(loading, /\["complete", "limited"\]\.includes\(body\.report\.run\.status\) && body\.report\.document/);
  assert.match(loading, /eventMessage\(events\.at\(-1\), ar\)/);
  assert.match(loading, /\["failed", "interrupted"\]/);
});

test("completed report route reconstructs the evidence renderer from D1", () => {
  assert.match(report, /fetch\(`\/api\/reports\/\$\{publicId\}`/);
  assert.match(report, /<ReportSnapshot/);
  assert.match(report, /documentSchemaVersion !== 1/);
  assert.match(report, /window\.location\.replace\(`\/reports\/\$\{publicId\}\/loading`\)/);
  assert.doesNotMatch(report, /from "\.\.\/\.\.\/page"/);
});

test("dark routes fill the viewport and keep responsive width bounded", () => {
  assert.match(css, /\.analysis-loading-page, \.stored-report-state \{ min-height: 100vh/);
  assert.match(css, /\.report-section\.shell \{ width: 100%/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /overflow-y: auto/);
});

test("new routes preserve Arabic direction and controls", () => {
  assert.match(loading, /dir=\{ar \? "rtl" : "ltr"\}/);
  assert.match(loading, /ابدأ تقريراً جديداً/);
  assert.match(report, /dir=\{dir\}/);
  assert.match(report, /تقرير جديد/);
});
