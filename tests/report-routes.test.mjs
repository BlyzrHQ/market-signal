import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const loading = await readFile(new URL("../app/reports/[publicId]/loading/page.tsx", import.meta.url), "utf8");
const report = await readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
const productLab = await readFile(new URL("../app/components/product-design-lab.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("submission hands the durable job to its dedicated loading route", () => {
  assert.match(home, /postJson<CreateReportResponse>\("\/api\/reports"/);
  assert.match(home, /window\.location\.assign\(`\/reports\/\$\{created\.report\.publicId\}\/loading`\)/);
  assert.doesNotMatch(home, /action: "document"|action: "event"/);
  assert.doesNotMatch(home, /["'`]\/api\/(?:crawl|report|ads|match|enrich-products)["'`]/);
  assert.doesNotMatch(home, /loadingPercent|progressPercent/);
});

test("the browser no longer owns interruption recovery or report mutation", () => {
  assert.doesNotMatch(home, /interruptedReportRecovery|\/api\/reports\/\$\{publicReportId\}/);
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
  assert.match(report, /type View = "overview" \| "competitors" \| "products" \| "ads" \| "evidence"/);
  assert.match(report, /const VIEWS: View\[\] = \["overview", "competitors", "products", "ads", "evidence"\]/);
  assert.match(report, /value === "methodology" && views\.includes\("evidence"\)/);
  assert.match(report, /if \(legacyMethod\) url\.hash = "method"/);
  assert.match(report, /evidence: \{ en: "Evidence & Method", ar: "الأدلة والمنهجية" \}/);
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
  assert.match(report, /if \(!hash\) window\.requestAnimationFrame\(\(\) => window\.scrollTo\(\{ top: 0, behavior: "auto" \}\)\)/);
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
  assert.match(report, /item === "evidence" && <b>\{evidence\.length \+ gaps\.length\}<\/b>/);
  assert.doesNotMatch(report, /stored-report-hero/);
  assert.doesNotMatch(css, /\.stored-report-hero/);
  assert.match(css, /\.dashboard-view-title span,\.report-route-meta span \{ display: none; \}[\s\S]*\.report-route-meta time \{ font-size: 7px; \}/);
});

test("saved product and ad views preserve truth boundaries and source links", () => {
  assert.match(report, /<ProductDesignLab comparison=\{comparison\} battles=\{battles\}/);
  assert.match(productLab, /className="product-compact-table"/);
  assert.match(productLab, /<table className="product-compact-table" role="table">/);
  assert.match(productLab, /<thead role="rowgroup"><tr role="row">/);
  assert.match(productLab, /<th role="columnheader">/);
  assert.match(productLab, /<tbody role="rowgroup">\{rows\.map\(\(row, index\) => \{/);
  assert.match(productLab, /return <tr role="row" className="product-table-row"/);
  assert.match(productLab, /<td role="cell" className="product-table-product-cell/);
  assert.match(productLab, /<th role="columnheader">\{ar \? "سعرك" : "Your price"\}<\/th>/);
  assert.match(productLab, /<th role="columnheader">\{ar \? "سعر المنافس" : "Rival price"\}<\/th>/);
  assert.match(productLab, /<th role="columnheader">\{ar \? "الفرق" : "Difference"\}<\/th>/);
  assert.doesNotMatch(productLab, /<tbody key=|product-table-detail|colSpan=\{4\}/);
  assert.match(productLab, /resolvedPriceDelta\(decision\.priceComparison\)/);
  assert.match(productLab, /productPriceGap\(row, ar\)/);
  assert.match(productLab, /const priceGap = productPriceGap\(row, ar\)/);
  assert.doesNotMatch(productLab, /productPriceGap\(row, ar\) &&/);
  assert.match(productLab, /className="product-row-details"/);
  assert.match(productLab, /rows\.map\(\(row, index\) => <li/);
  assert.match(productLab, /filter\(\(\{ row \}\) => row\.lane === lane\.id\)/);
  assert.match(productLab, /resolvedPriceDelta\(decision\.priceComparison\)/);
  assert.match(productLab, /Open product ↗/);
  assert.match(productLab, /showDetail=\{false\}/);
  assert.match(productLab, /showValues=\{false\}/);
  assert.match(productLab, /className="product-match-details"/);
  assert.match(productLab, /const claimType = display\(assessment\.claimType, "inferred"\)/);
  assert.match(productLab, /const confidence = display\(battle\.match\.confidence/);
  assert.match(report, /window\.addEventListener\("beforeprint", expandPrintEvidence\)/);
  assert.match(report, /window\.addEventListener\("afterprint", restorePrintEvidence\)/);
  assert.match(report, /\.product-match-details:not\(\[open\]\)/);
  assert.match(productLab, /firstSentence\.length >= 15 \? firstSentence : full/);
  assert.match(productLab, /row\.primarySource && <a href=\{row\.primarySource\}/);
  assert.match(productLab, /row\.rivalSource && <a href=\{row\.rivalSource\}/);
  assert.match(productLab, /enrichmentGaps/);
  assert.match(productLab, /PRODUCT DATA GAP/);
  assert.match(productLab, /Open source ↗/);
  assert.match(report, /not proof of zero ads/);
  assert.match(report, /This does not mean the companies do not advertise/);
  assert.match(report, /Who is verifiably advertising, and what are their ads saying\?/);
  assert.match(report, /className="verified-creative-section"/);
  assert.match(report, /<AdCreativeCard concept=\{concept\} ar=\{ar\}/);
  assert.match(report, /Media unavailable — verified ad copy is shown below/);
  assert.match(report, /active records grouped into/);
  assert.match(report, /cross-Page records discarded/);
  assert.match(report, /className="ad-verification-queue"/);
  assert.match(report, /This is a coverage result, not proof that these companies are not advertising/);
  assert.match(report, /Open \$\{display\(platform\.platform\)\} search ↗/);
  assert.match(report, /list\(platform\.evidenceUrls\).*Ad record \$\{index \+ 1\} ↗/);
  assert.match(report, /url\.protocol === "https:" && \["fbcdn\.net", "fbsbx\.com", "facebook\.com"\]/);
  assert.match(report, /alt=\{headline\}/);
  assert.match(report, /item === "ads" && activeAds > 0/);
  assert.match(report, /truth-pill/);
  assert.match(report, /repairEncoding/);
});

test("evidence and methodology become one customer-readable verification view", () => {
  assert.match(report, /What supports this report's decisions—and what does it not prove\?/);
  assert.match(report, /className="evidence-source-group"/);
  assert.match(report, /target\?\.closest\("details"\)/);
  assert.match(report, /\.evidence-source-group:not\(\[open\]\)/);
  assert.match(report, /className="plain-method" id="method"/);
  assert.match(report, /Anything not observed here is a coverage limit, never evidence of absence/);
  assert.match(report, /Technical record/);
  assert.doesNotMatch(report, /view === "methodology"/);
  assert.doesNotMatch(report, /<h3>\{display\(adBlock\?\.provider/);
  assert.match(css, /\.ad-verification-queue/);
  assert.match(css, /\.verified-creative-section/);
  assert.match(css, /\.evidence-source-group/);
  assert.match(css, /\.plain-method/);
});

test("dark routes fill the viewport and keep responsive width bounded", () => {
  assert.match(css, /\.analysis-loading-page, \.stored-report-state \{ min-height: 100vh/);
  assert.match(css, /\.report-section\.shell \{ width: 100%/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /body \{[^}]*overflow-x: clip/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /\.stored-report-page \{ min-width: 0; min-height: 100vh; overflow-x: clip/);
  assert.match(css, /\.report-dashboard-shell \{ display: grid; grid-template-columns: 248px minmax\(0,1fr\)/);
  assert.match(css, /\.report-dashboard-sidebar \{ position: relative;[^}]*min-height: 100vh;[^}]*overflow: visible/);
  assert.doesNotMatch(css, /\.report-dashboard-sidebar \{[^}]*height: 100vh[^}]*overflow-y: auto/);
  assert.match(css, /@media \(min-width: 1024px\) \{ \.workspace-tabs \{ position: sticky;[^}]*top: 24px;[^}]*align-self: stretch/);
  assert.match(css, /\.workspace-panel \{ width: min\(100%,1140px\)/);
  assert.match(css, /\.product-comparison-table th \{ position: sticky;[^}]*top: 64px/);
  assert.match(css, /\.comparison-main-row \{ scroll-margin-top: 76px/);
  assert.match(css, /@media \(min-width: 1181px\) \{[\s\S]*\.comparison-main-row \{ scroll-margin-top: 118px/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*\.product-comparison-table thead \{ position: absolute;[^}]*clip-path: inset\(50%\)/);
  assert.match(css, /@media \(max-width: 1023px\) \{[\s\S]*\.workspace-tabs \{ position: sticky;[\s\S]*overflow-x: auto/);
  assert.match(css, /\.report-dashboard-sidebar,\.report-dashboard-main \{ display: contents; \}/);
  assert.match(css, /\.comparison-detail-disclosure > summary::after \{/);
  assert.match(css, /\.comparison-detail-disclosure\[open\] > summary::after \{/);
  assert.match(css, /\.comparison-group:last-of-type \.comparison-detail-row > td \{/);
});

test("new routes preserve Arabic direction and controls", () => {
  assert.match(loading, /dir=\{ar \? "rtl" : "ltr"\}/);
  assert.match(loading, /ابدأ تقريراً جديداً/);
  assert.match(report, /dir=\{dir\}/);
  assert.match(report, /تقرير جديد/);
  assert.match(report, /setLocaleOverride\(ar \? "en" : "ar"\)/);
});
