import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const accountNavigation = await readFile(new URL("../app/components/account-navigation-link.tsx", import.meta.url), "utf8");
const loading = await readFile(new URL("../app/reports/[publicId]/loading/page.tsx", import.meta.url), "utf8");
const report = await readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8");
const productLab = await readFile(new URL("../app/components/product-design-lab.tsx", import.meta.url), "utf8");
const competitorWatch = await readFile(new URL("../app/components/competitor-price-watch.tsx", import.meta.url), "utf8");
const priceClaims = await readFile(new URL("../app/lib/price-claims.ts", import.meta.url), "utf8");
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

test("the landing header exposes the private reports dashboard when signed in", () => {
  assert.match(home, /<AccountNavigationLink ar=\{ar\} \/>/);
  assert.match(accountNavigation, /fetch\("\/api\/account\/reports", \{/);
  assert.match(accountNavigation, /cache: "no-store"/);
  assert.match(accountNavigation, /credentials: "same-origin"/);
  assert.match(accountNavigation, /accountNavigationDestination\(payload\)/);
  assert.match(accountNavigation, /"My reports"/);
  assert.match(accountNavigation, /"Open my reports dashboard"/);
  assert.doesNotMatch(accountNavigation, /localStorage|sessionStorage/);
  assert.match(css, /\.landing-v2 \.header-nav>a:not\(\.header-pricing-link\):not\(\.header-workspace-link\)\{display:none\}/);
  assert.match(css, /\.header-nav \.header-pricing-link,\.header-nav \.header-workspace-link,\.header-nav \.github-button \{ display: inline-flex; \}/);
});

test("reopened loading routes poll persisted events and redirect only with a document", () => {
  assert.match(loading, /fetch\(`\/api\/reports\/\$\{publicId\}`/);
  assert.match(loading, /readJsonResponse<.*>\(response, "Report progress"\)/);
  assert.doesNotMatch(loading, /response\.json\(\)/);
  assert.match(loading, /retryable = response\.status === 408 \|\| response\.status === 429 \|\| response\.status >= 500/);
  assert.match(loading, /if \(retryable\) timer = window\.setTimeout\(poll, 2500\)/);
  assert.match(loading, /if \(!body\.report\?\.run\) throw new Error\("Report progress returned incomplete report data/);
  assert.match(loading, /\["complete", "limited"\]\.includes\(body\.report\.run\.status\) && body\.report\.document/);
  assert.match(loading, /eventMessage\(events\.at\(-1\), ar\)/);
  assert.match(loading, /\["failed", "interrupted"\]/);
  assert.match(loading, /visibleEvents/);
  assert.match(loading, /!event\.idempotencyKey\.startsWith\("ads-"\)/);
  assert.doesNotMatch(loading, /ads-started|ads-complete|Checking public ad libraries|فحص مكتبات الإعلانات/);
});

test("completed report route reconstructs the evidence renderer from D1", () => {
  assert.match(report, /const endpoint = mode === "shared" \? `\/api\/shared-reports\/\$\{id\}` : `\/api\/reports\/\$\{id\}`/);
  assert.match(report, /readJsonResponse<StoredPayload>\(response, mode === "shared" \? "Shared report" : "Saved report"\)/);
  assert.match(report, /jsonResponseErrorMessage\(cause, mode === "shared" \? "Shared report" : "Saved report"\)/);
  assert.doesNotMatch(report, /response\.json\(\)/);
  assert.match(report, /<ReportWorkspace/);
  assert.match(report, /documentSchemaVersion !== 1/);
  assert.match(report, /window\.location\.replace\(`\/reports\/\$\{id\}\/loading`\)/);
  assert.doesNotMatch(report, /from "\.\.\/\.\.\/page"/);
});

test("saved reports expose deep-linkable accessible intelligence tabs", () => {
  assert.match(report, /type View = "overview" \| "competitors" \| "products" \| "evidence"/);
  assert.match(report, /const VIEWS: View\[\] = \["competitors", "products", "overview"\]/);
  assert.match(report, /return views\.includes\(value as View\) \? value as View : views\[0\] \|\| "overview"/);
  assert.doesNotMatch(report, /value === "methodology"/);
  assert.match(report, /url\.hash = ""/);
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
  assert.doesNotMatch(report, /viewHref\("ads"/);
  assert.doesNotMatch(report, /viewHref\("evidence"/);
  assert.match(report, /terminalDomain \? \["overview"\] : VIEWS/);
  assert.doesNotMatch(productLab, /viewHref\("evidence"|view=evidence|Evidence ledger|Open evidence ledger/);
});

test("saved reports use a persistent dashboard shell without the old report hero", () => {
  assert.match(report, /className="report-dashboard-sidebar"/);
  assert.match(report, /className="dashboard-brand"/);
  assert.ok(report.includes('className={`dashboard-report-identity ${reportStatus === "limited" ? "partial" : "ready"}`}'));
  assert.match(report, /reportCoverage\(reportStatus, reportEvents, ar\)/);
  assert.match(report, /className="report-coverage-notice"/);
  assert.match(report, /className="report-dashboard-main"/);
  assert.doesNotMatch(report, /item === "ads" && activeAds/);
  assert.doesNotMatch(report, /item === "evidence" && <b>/);
  assert.doesNotMatch(report, /stored-report-hero/);
  assert.doesNotMatch(css, /\.stored-report-hero/);
  assert.match(css, /\.dashboard-view-title span \{ display: none; \}[\s\S]*\.report-route-meta span \{ display: inline-flex;[^}]*\}[\s\S]*\.report-route-meta time \{ display: none; \}/);
  assert.match(css, /\.dashboard-report-identity\.partial/);
  assert.match(css, /\.report-coverage-notice/);
});

test("paid report history is privately fetched and stays out of public report payloads", () => {
  assert.match(report, /fetch\("\/api\/account\/reports", \{ cache: "no-store", credentials: "same-origin"/);
  assert.match(report, /if \(!history\?\.eligible\) return null/);
  assert.match(report, /mode === "workspace" && privatePublicId && <PaidReportHistory currentPublicId=\{privatePublicId\} ar=\{ar\} \/>/);
  assert.match(report, /aria-current=\{current \? "page" : undefined\}/);
  assert.doesNotMatch(report, /localStorage|sessionStorage/);
  assert.match(css, /\.dashboard-brand,\.dashboard-report-identity,\.dashboard-report-history \{ display: none; \}/);
});

test("report-level sharing is explicit while shared rendering omits private workspace modules", () => {
  assert.match(report, /<ReportShareControl publicId=\{privatePublicId\} ar=\{ar\} \/>/);
  assert.match(report, /mode === "workspace" && <PriceWatchWorkspaceLink ar=\{ar\} \/>/);
  assert.match(report, /Shared · read only/);
  assert.match(report, /mode === "workspace" && <CompetitorPriceWatch/);
  assert.match(competitorWatch, /fetch\("\/api\/price-watch", \{ cache: "no-store", credentials: "same-origin"/);
  assert.doesNotMatch(productLab, /\/api\/price-watch|workspaceMode/);
  assert.match(productLab, /fetch\(`\$\{matchesEndpoint\}\?\$\{query\}`/);
  assert.doesNotMatch(productLab, /Copy workspace link|copyWorkspaceReportLink/);
  assert.match(css, /\.report-route-header \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(150px,1fr\) auto auto/);
  assert.match(css, /@media \(max-width: 1180px\) \{[\s\S]*\.report-route-header \{ min-height: 108px;[^}]*grid-template-columns: minmax\(0,1fr\) auto/);
  assert.match(css, /@media \(max-width: 1023px\) \{[\s\S]*\.workspace-tabs \{ position: sticky;[^}]*top: 108px/);
});

test("saved product views preserve truth boundaries and source links", () => {
  assert.match(report, /<ProductDesignLab key=\{resourceId\} comparison=\{comparison\} battles=\{battles\}/);
  assert.match(report, /object\(candidate\.publication\)\.priceEligible === true/);
  assert.match(report, /legacyUngatedMatchCount/);
  assert.match(report, /countLegacyUngatedProductMatches\(comparison\)/);
  assert.match(report, /Saved price comparisons need revalidation/);
  assert.match(report, /This report predates the current market-and-currency validation gate/);
  assert.match(report, /item === "products" && <b>\{productMatchTotal\}<\/b>/);
  assert.match(report, /authoritativeMatchTotal=\{productMatchTotal \|\| undefined\}/);
  assert.match(report, /publishedComparisonCompetitors\(blocks, comparison\)/);
  assert.match(report, /currentMatchSummary\?\.domainCounts\?\.\[domain\] \?\? \(numeric\(competitor\.comparisonCount\) \|\| rivalBattles\.length\)/);
  assert.match(report, /broad discovery does not count as a competitor/);
  assert.match(report, /fetch\(`\$\{matchesEndpoint\}\?limit=1`/);
  assert.match(report, /authoritativeMatchSummary\?\.publicId === resourceId/);
  assert.match(report, /<ProductDesignLab key=\{resourceId\}/);
  assert.match(productLab, /activeReportId\.current !== publicId/);
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
  assert.match(productLab, /resolvePriceClaim\(\{/);
  assert.match(productLab, /<ProductTableDifference claim=\{row\.priceClaim\} lane=\{row\.lane\} ar=\{ar\} \/>/);
  assert.match(productLab, /formatPriceDifference\(claim, ar \? "ar" : "en"\)/);
  assert.match(priceClaims, /kind: "listed-gap"/);
  assert.match(priceClaims, /Rival listed price is/);
  assert.doesNotMatch(productLab, /Prices found — comparison basis unverified/);
  assert.match(productLab, /className="product-row-details"/);
  assert.match(productLab, /rows\.map\(\(row, index\) => <li/);
  assert.match(productLab, /filter\(\(\{ row \}\) => row\.lane === lane\.id\)/);
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
  assert.doesNotMatch(productLab, /enrichmentGaps/);
  assert.doesNotMatch(productLab, /PRODUCT DATA GAP/);
  assert.doesNotMatch(report, /AdCreativeCard|ad-verification-queue|verified-creative-section|adBlock|not proof of zero ads|advertising/);
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
  assert.doesNotMatch(css, /\.ad-verification-queue|\.verified-creative-section|\.ad-creative-feed/);
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
  assert.match(css, /#panel-products\.workspace-panel \{ width: 100%; \}/);
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
