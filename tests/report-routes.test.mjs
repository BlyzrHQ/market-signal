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

test("an interrupted crawl is persisted and remains addressable by its report URL", () => {
  assert.match(home, /interruptedReportRecovery\(publicReportId, message\)/);
  assert.match(home, /postJson\(`\/api\/reports\/\$\{publicReportId\}`,[\s\S]*recovery\.event/);
  assert.match(home, /window\.location\.assign\(recovery\.path\)/);
});

test("reopened loading routes poll persisted events and redirect only with a document", () => {
  assert.match(loading, /fetch\(`\/api\/reports\/\$\{publicId\}`/);
  assert.match(loading, /\["complete", "limited"\]\.includes\(body\.report\.run\.status\) && body\.report\.document/);
  assert.match(loading, /eventMessage\(events\.at\(-1\), ar\)/);
  assert.match(loading, /\["failed", "interrupted"\]/);
});

test("completed report route reconstructs the evidence renderer from D1", () => {
  assert.match(report, /fetch\(`\/api\/reports\/\$\{publicId\}`/);
  assert.match(report, /<ReportWorkspace/);
  assert.match(report, /documentSchemaVersion !== 1/);
  assert.match(report, /window\.location\.replace\(`\/reports\/\$\{publicId\}\/loading`\)/);
  assert.doesNotMatch(report, /from "\.\.\/\.\.\/page"/);
});

test("saved reports expose deep-linkable accessible intelligence tabs", () => {
  assert.match(report, /type View = "overview" \| "competitors" \| "products" \| "ads" \| "evidence" \| "methodology"/);
  assert.match(report, /new URLSearchParams\(window\.location\.search\)\.get\("view"\)/);
  assert.match(report, /window\.addEventListener\("popstate", sync\)/);
  assert.match(report, /role="tablist"/);
  assert.match(report, /aria-orientation=\{compactNav \? "horizontal" : "vertical"\}/);
  assert.match(report, /role="tab"/);
  assert.match(report, /aria-controls=\{`panel-\$\{item\}`\}/);
  assert.match(report, /role="tabpanel"/);
  assert.match(report, /const forwardKey = compactNav \? \(ar \? "ArrowLeft" : "ArrowRight"\) : "ArrowDown"/);
  assert.match(report, /const backwardKey = compactNav \? \(ar \? "ArrowRight" : "ArrowLeft"\) : "ArrowUp"/);
  assert.match(report, /scrollToReportHash/);
  assert.match(report, /scrollIntoView\(\{ block: "start" \}\)/);
  assert.match(report, /onClick=\{onWorkspaceClick\}/);
  assert.match(report, /viewHref\("products", productAnchor\(domain\)\)/);
  assert.match(report, /viewHref\("ads", adAnchor\(domain\)\)/);
  assert.match(report, /viewHref\("evidence", evidenceAnchor\(domain\)\)/);
});

test("saved reports use a persistent dashboard shell without the old report hero", () => {
  assert.match(report, /className="report-dashboard-sidebar"/);
  assert.match(report, /className="dashboard-brand"/);
  assert.match(report, /className="dashboard-report-identity"/);
  assert.match(report, /className="report-dashboard-main"/);
  assert.match(report, /item === "evidence" && <b>\{evidence\.length\}<\/b>/);
  assert.doesNotMatch(report, /stored-report-hero/);
  assert.doesNotMatch(css, /\.stored-report-hero/);
  assert.match(css, /\.dashboard-view-title span,\.report-route-meta span \{ display: none; \}[\s\S]*\.report-route-meta time \{ font-size: 7px; \}/);
});

test("saved product and ad views preserve truth boundaries and source links", () => {
  assert.match(report, /className="product-comparison-table" role="table"/);
  assert.match(report, /<thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">/);
  assert.match(report, /<tbody role="rowgroup">{battles\.map/);
  assert.match(report, /return <tr id={anchor} key={battle\.key} role="row"/);
  assert.match(report, /<td role="cell" className="comparison-product-cell your-comparison-cell">/);
  assert.match(report, /resolvedPriceDelta\(decision\.priceComparison\)/);
  assert.match(report, /Your product source ↗/);
  assert.match(report, /Rival product source ↗/);
  assert.match(report, /not proof of zero ads/);
  assert.match(report, /This does not mean the companies do not advertise/);
  assert.match(report, /truth-pill/);
  assert.match(report, /repairEncoding/);
  assert.match(report, /productEnrichmentGaps/);
  assert.match(report, /PRODUCT DATA GAP/);
  assert.match(report, /Open source ↗/);
});

test("dark routes fill the viewport and keep responsive width bounded", () => {
  assert.match(css, /\.analysis-loading-page, \.stored-report-state \{ min-height: 100vh/);
  assert.match(css, /\.report-section\.shell \{ width: 100%/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /\.stored-report-page \{ min-width: 0; min-height: 100vh; overflow-x: clip/);
  assert.match(css, /\.report-dashboard-shell \{ display: grid; grid-template-columns: 248px minmax\(0,1fr\)/);
  assert.match(css, /\.report-dashboard-sidebar \{ position: relative;[^}]*min-height: 100vh;[^}]*overflow: visible/);
  assert.doesNotMatch(css, /\.report-dashboard-sidebar \{[^}]*height: 100vh[^}]*overflow-y: auto/);
  assert.match(css, /\.workspace-panel \{ width: min\(100%,1140px\)/);
  assert.match(css, /\.product-comparison-table th \{ position: sticky;[^}]*top: 64px/);
  assert.match(css, /\.product-comparison-table tbody tr \{ scroll-margin-top: 76px/);
  assert.match(css, /@media \(min-width: 1181px\) \{[\s\S]*\.product-comparison-table tbody tr \{ scroll-margin-top: 118px/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*\.product-comparison-table thead \{ position: absolute;[^}]*clip-path: inset\(50%\)/);
  assert.match(css, /@media \(max-width: 1023px\) \{[\s\S]*\.workspace-tabs \{ position: sticky;[\s\S]*overflow-x: auto/);
  assert.match(css, /\.report-dashboard-sidebar,\.report-dashboard-main \{ display: contents; \}/);
});

test("new routes preserve Arabic direction and controls", () => {
  assert.match(loading, /dir=\{ar \? "rtl" : "ltr"\}/);
  assert.match(loading, /ابدأ تقريراً جديداً/);
  assert.match(report, /dir=\{dir\}/);
  assert.match(report, /تقرير جديد/);
  assert.match(report, /setLocaleOverride\(ar \? "en" : "ar"\)/);
});
