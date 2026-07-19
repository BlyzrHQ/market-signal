import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Market Signal product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Market Signal — Know where your market is moving<\/title>/i);
  assert.match(html, /Know where your market is moving/);
  assert.match(html, /One free report/);
  assert.match(html, /public signals only/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("real-data route and product metadata are present", async () => {
  const [route, crawl, enrichment, ads, report, page, savedReport, pricePosition, layout, styles, packageJson, domainUtils, adIntelligence] = await Promise.all([
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/enrich-products/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/report/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/price-position.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/ad-intelligence.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /MAX_DOCUMENT_BYTES/);
  assert.match(report, /buildClaims/);
  assert.match(report, /OPENAI_API_KEY/);
  assert.match(report, /claimIds/);
  assert.match(report, /fallbackBrief/);
  assert.match(report, /analyzeDomain/);
  assert.match(report, /requestedDomains/);
  assert.match(report, /headlineClaimIds/);
  assert.match(crawl, /MAX_HTML_PAGES/);
  assert.match(crawl, /robots.txt/);
  assert.match(crawl, /discoverCompetitors/);
  assert.match(crawl, /seededProductUrls/);
  assert.match(crawl, /matchedProductUrl/);
  assert.match(crawl, /buildDocument/);
  assert.match(crawl, /buildProductComparison/);
  assert.match(crawl, /extractProductsFromHtml/);
  assert.match(crawl, /extractProductsFromSitemap/);
  assert.doesNotMatch(crawl, /await scanOfficialAdLibraries/);
  assert.match(crawl, /adRequest/);
  assert.match(crawl, /MAX_DISCOVERED_HTML_PAGES = 3/);
  assert.match(crawl, /MAX_MATCHED_PRODUCT_ENRICHMENT_PAGES = 6/);
  assert.match(crawl, /selectProductEnrichmentTargets/);
  assert.match(crawl, /enrichMatchedProductPages/);
  assert.match(crawl, /priceEnrichmentPagesFetched/);
  assert.match(enrichment, /MAX_TARGETS = 24/);
  assert.match(enrichment, /validateProductPageIdentity/);
  assert.match(enrichment, /robots\.txt/);
  assert.match(crawl, /async function crawlPrimaryDomain/);
  assert.match(crawl, /if \(first\.homepage\)/);
  assert.match(crawl, /coverage: \{ \.\.\.retry\.coverage, attempts: 2 \}/);
  assert.match(crawl, /domain === primaryDomain \? crawlPrimaryDomain\(domain\)/);
  assert.match(ads, /scanOfficialAdLibraries/);
  assert.match(ads, /Verified companies are required/);
  assert.match(crawl, /product-catalog/);
  assert.match(crawl, /product-comparison/);
  assert.match(crawl, /claimIds/);
  assert.match(route, /REQUEST_TIMEOUT_MS/);
  assert.match(route, /sourceUrl/);
  assert.match(route, /getAll\("domain"\)/);
  assert.match(route, /canonicalDomain/);
  assert.match(route, /new Set\(rawDomains\.map\(canonicalDomain\)\)/);
  assert.match(route, /Promise\.all\(domains\.map/);
  assert.match(domainUtils, /Private or local addresses cannot be analyzed/);
  assert.match(route, /application\/xhtml\+xml/);
  assert.match(page, /postJson<CrawlPayload \| CrawlFailure>[\s\S]{0,80}"\/api\/crawl"/);
  assert.match(page, /postJson<AdScanPayload>\("\/api\/ads"/);
  assert.match(page, /postJson<ProductEnrichmentPayload>\("\/api\/enrich-products"/);
  assert.match(page, /if \(!active\(\)\) return;\r?\n\s+if \(enrichedComparison\) \{[\s\S]{0,240}setCrawlDocument/);
  assert.match(page, /postJson<\{ ok: true; report: \{ publicId: string \} \}/);
  assert.match(page, /action: "document"/);
  assert.match(page, /adLoading/);
  assert.match(page, /not scanned/);
  assert.match(page, /postJson<[\s\S]{0,100}MarketBrief \| \{ ok: false; error\?: string \}[\s\S]{0,80}"\/api\/report"/);
  assert.match(page, /domains: successful\.map/);
  assert.match(page, /THE VERDICT/);
  assert.match(page, /START WITH THE STRONGEST THREAT/);
  assert.match(page, /EVIDENCE & COVERAGE/);
  assert.doesNotMatch(page, /POSSIBLE CANDIDATE/);
  assert.doesNotMatch(page, /block\.type === "evidence"\) return <article/);
  assert.match(page, /websiteSourceUrl/);
  assert.match(page, /YOUR NEXT DECISION/);
  assert.match(page, /WHY THEY MAY WIN/);
  assert.match(page, /WHAT WE SEE/);
  assert.match(page, /<PricePosition comparisonValue=\{battle\.decision\.priceComparison\}/);
  assert.match(savedReport, /<PricePosition comparisonValue=\{decision\.priceComparison\}/);
  assert.match(pricePosition, /resolvedPriceDelta\(comparisonValue\)/);
  assert.match(pricePosition, /You are \$\{percent\}% cheaper/);
  assert.match(pricePosition, /Rival is \$\{percent\}% cheaper/);
  assert.match(pricePosition, /Same observed price/);
  assert.match(pricePosition, /Price difference is under 1%/);
  assert.match(pricePosition, /Prices found — comparison basis unverified/);
  assert.match(pricePosition, /Only one public price found/);
  assert.match(pricePosition, /No public prices found/);
  assert.match(pricePosition, /Comparable pair confirmed/);
  assert.match(pricePosition, /const approvedPair = comparisonValue !== null && comparisonValue !== undefined/);
  assert.match(pricePosition, /else if \(approvedPair\)/);
  assert.match(pricePosition, /Both prices are public observations\. We do not call either side cheaper/);
  assert.doesNotMatch(pricePosition, /priceVerdict \|\| copy\.unavailableDetail/);
  assert.match(pricePosition, /comparison && !comparison\.equal/);
  assert.doesNotMatch(page, /battle\.primary\.prices\[0\]/);
  assert.doesNotMatch(page, /sharedTerms\.map/);
  assert.match(page, /AD PULSE/);
  assert.match(page, /direct record/);
  assert.match(page, /AD ACTIVITY/);
  assert.match(page, /id="ad-activity"/);
  assert.match(page, /نشاط الإعلانات/);
  assert.match(page, /AdCreativeCard/);
  assert.match(page, /Creative media unavailable/);
  assert.match(page, /Open destination ↗/);
  assert.match(page, /View public Meta record ↗/);
  assert.match(page, /cross-Page records discarded/);
  assert.match(page, /stale records excluded/);
  assert.match(page, /identity-probe records/);
  assert.match(page, /We do not infer spend or turn limited access into zero activity/);
  assert.doesNotMatch(page, /estimated spend|ESTIMATED SPEND|impression estimate|reach estimate/i);
  assert.match(page, /العربية/);
  assert.match(page, /dir=\{ar \? "rtl" : "ltr"\}/);
  assert.doesNotMatch(page, /market-query-list/);
  assert.match(page, /Show gaps and methodology/);
  assert.doesNotMatch(page, /Optional comparison domains/);
  assert.match(page, /WHY THIS IS A REAL RIVAL/);
  assert.match(page, /Find my competitors/);
  assert.match(page, /primaryResult/);
  assert.match(page, /const primaryHost = payload\.primaryDomain/);
  assert.doesNotMatch(page, /function getDomainHost/);
  assert.match(page, /GuidedReportRenderer/);
  assert.match(page, /data-product-match-state/);
  assert.match(page, /Preliminary product matches/);
  assert.match(page, /Product matching finished with limited coverage/);
  assert.match(page, /primaryProductsSynchronized/);
  assert.match(page, /AI reviewed the strongest/);
  assert.match(page, /candidate pairs/);
  assert.match(page, /\$\{verifiedPairTotal\} verified comparison/);
  assert.match(page, /shouldRetryProductMatch/);
  assert.match(page, /analysisRunRef/);
  assert.match(page, /matchAttemptRef/);
  assert.match(page, /upsertProductComparisonBlock/);
  assert.match(page, /No attributable public product pages were found/);
  assert.match(page, /productMatchLifecycle !== "idle"/);
  assert.match(page, /THREAT MAP/);
  assert.match(page, /RIVAL DOSSIERS/);
  assert.match(page, /Remembered lead · re-verified live/);
  assert.match(page, /jsonText\(competitor, "provenance"\) === "remembered-reverified"/);
  assert.match(page, /PRODUCT COMPARISON/);
  assert.match(page, /id="product-comparison"/);
  assert.match(page, /No defensible product pair was verified yet/);
  assert.match(page, /لم يتم التحقق من زوج منتجات قابل للدفاع عنه بعد/);
  assert.match(page, /ProductBattleCard/);
  assert.match(page, /battle\.primary\.imageUrl \? "has-image" : "no-image"/);
  assert.match(page, /battle\.rival\.imageUrl \? "has-image" : "no-image"/);
  assert.match(page, /catalog-scan-summary/);
  assert.match(page, /of your products scanned/);
  assert.match(page, /rival products scanned/);
  assert.match(page, /verified comparison/);
  assert.match(page, /SAME TIER/);
  assert.match(page, /href=\{`#dossier-\$\{rivalDomain\}`\}/);
  assert.doesNotMatch(page, /price-axis|price-line|price-dot|close-prices|price-picture|price-fallback/);
  assert.doesNotMatch(savedReport, /price-axis|price-line|price-dot|close-prices|price-picture|price-fallback/);
  assert.doesNotMatch(page, /comparablePriceDelta/);
  assert.match(page, /isDefensibleProductMatch/);
  assert.match(page, /SafeExternalLink href=\{battle\.primary\.sourceUrl\}/);
  assert.doesNotMatch(page, /sourceUrl: String\(item\.sourceUrl \|\| "#"\)/);
  assert.match(page, /story-rail/);
  assert.match(page, /<b>04<\/b>[\s\S]{0,160}Ad activity/);
  assert.match(page, /<b>05<\/b>[\s\S]{0,160}Rival dossiers/);
  assert.match(page, /<b>06<\/b>[\s\S]{0,160}Evidence/);
  assert.match(styles, /repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.ad-creative-feed \{[^}]*min-width: 0/);
  assert.match(styles, /\.ad-creative-copy strong, \.ad-creative-copy p, \.ad-creative-copy small \{[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.ad-creative-feed \{ grid-template-columns: 1fr/);
  assert.match(styles, /\.app-root\[dir="rtl"\]/);
  assert.match(styles, /\.memory-provenance \{/);
  assert.match(styles, /\.battle-product\.no-image \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.battle-product\.no-image strong \{ grid-column: 1; \}/);
  assert.match(savedReport, /className="product-comparison-table" role="table"/);
  assert.match(savedReport, /role="columnheader" scope="col"/);
  assert.match(savedReport, /const comparablePrice = resolvedPriceDelta\(decision\.priceComparison\)/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*\.product-comparison-table tbody tr \{[^}]*grid-template-areas: "your rival" "price price" "match action"/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.product-comparison-table tbody tr \{[^}]*grid-template-areas: "your" "rival" "price" "match" "action"/);
  assert.match(styles, /\.price-position-grid \{[^}]*grid-template-columns: minmax\(0,1fr\) minmax\(220px,1\.15fr\) minmax\(0,1fr\)/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.price-position-grid, \.decision-path, \.dossier-ad-row \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(styles, /\.price-axis|\.price-line|\.price-dot|\.close-prices|\.price-picture|\.price-fallback/);
  assert.match(styles, /\.hero-copy, \.domain-form, \.input-row, \.domain-input \{ min-width: 0; \}/);
  assert.match(styles, /\.domain-input \{[^}]*flex: 1 1 0;[^}]*background: #0d1c18/);
  assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]*?\.hero \{ grid-template-columns: minmax\(0, 1fr\); \}[\s\S]*?\.input-row \{ flex-direction: column; \}[\s\S]*?\.primary-button \{ width: 100%; \}/);
  assert.doesNotMatch(page, /className="metric-grid"/);
  assert.doesNotMatch(page, /className="report-actions"/);
  assert.doesNotMatch(page, /This scan did not collect ad-library/);
  assert.match(page, /Your company domain or URL/);
  assert.match(page, /paste the full URL/);
  assert.doesNotMatch(page, /<span>https:\/\/<\/span>/);
  assert.doesNotMatch(page, /Northstar|Brightcart|Shopline|Illustrative competitor set|Own “easy”|11 total|acmecommerce\.com/);
  assert.match(adIntelligence, /search_page_ids/);
  assert.doesNotMatch(adIntelligence, /search_terms/);
  assert.match(adIntelligence, /discardedRecordCount/);
  assert.match(adIntelligence, /identityProbeRecordCount/);
  assert.match(adIntelligence, /safeMetaMediaUrl/);
  assert.match(layout, /Market Signal — Know where your market is moving/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
