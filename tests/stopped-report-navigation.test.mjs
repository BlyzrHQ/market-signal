import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stoppedReportPresentation } from "../app/lib/stopped-report-presentation.ts";

const reportPage = fs.readFileSync(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("HTTP 403 failures are explained without claiming the website is unavailable", () => {
  const presentation = stoppedReportPresentation("The primary domain could not be crawled: homepage returned HTTP 403.", "primary-page-unavailable", false);
  assert.equal(presentation.title, "The website blocked the report check");
  assert.match(presentation.summary, /access restriction/);
  assert.match(presentation.summary, /not proof that the website or business is unavailable/);
});

test("unknown stopped-report failures preserve the stored explanation", () => {
  const message = "The background worker stopped reporting progress before this phase completed.";
  assert.equal(stoppedReportPresentation(message, "worker-heartbeat-expired", false).summary, message);
});

test("failed and interrupted reports render a navigable shell without result tabs", () => {
  assert.match(reportPage, /function StoppedReportWorkspace/);
  assert.match(reportPage, /<PaidReportHistory currentPublicId=\{run\.publicId\}/);
  assert.match(reportPage, /className="dashboard-report-identity stopped"/);
  assert.match(reportPage, /className="workspace-panel stopped-report-panel"/);
  assert.match(reportPage, /<details><summary>/);
  assert.match(reportPage, /<Link href="\/">\{ar \? "ابدأ تقريراً جديداً" : "Start a new report"\}<\/Link>/);
  assert.doesNotMatch(reportPage.match(/function StoppedReportWorkspace[\s\S]*?\n}\n\nfunction AdCreativeCard/)?.[0] || "", /workspace-tabs|role="tablist"|ProductDesignLab|ExperienceBenchmark/);
});

test("stopped report navigation normalizes irrelevant view state", () => {
  assert.match(reportPage, /url\.searchParams\.delete\("view"\)/);
  assert.match(reportPage, /url\.searchParams\.delete\("layout"\)/);
  assert.match(reportPage, /url\.hash = ""/);
});

test("mobile stopped reports retain visible recovery actions", () => {
  assert.match(css, /@media \(max-width: 1023px\)[\s\S]*\.stopped-report-panel \{ min-height: calc\(100vh - 64px\)/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.stopped-report-actions \{ flex-direction: column/);
  assert.match(reportPage, /className="report-route-actions"[\s\S]*New report/);
});
