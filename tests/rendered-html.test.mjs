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
  const [route, crawl, enrichment, storefrontEnrichment, ads, report, page, savedReport, productLab, pricePosition, layout, styles, packageJson, domainUtils, adIntelligence] = await Promise.all([
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/enrich-products/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/storefront-product-enrichment.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/report/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/product-design-lab.tsx", import.meta.url), "utf8"),
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
  assert.match(crawl, /MAX_PRIMARY_PRODUCT_PRICE_PAGES = 6/);
  assert.match(crawl, /selectPrimaryProductPriceTargets/);
  assert.match(crawl, /primaryPriceEnrichmentPagesFetched/);
  assert.match(crawl, /selectProductEnrichmentTargets/);
  assert.match(crawl, /enrichMatchedProductPages/);
  assert.match(crawl, /priceEnrichmentPagesFetched/);
  assert.match(enrichment, /MAX_TARGETS = 64/);
  assert.match(enrichment, /enrichProductTargets/);
  assert.match(storefrontEnrichment, /validateProductPageIdentity/);
  assert.match(storefrontEnrichment, /robots\.txt/);
  assert.match(storefrontEnrichment, /claimablePagePricePatterns/);
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
  assert.match(page, /postJson<CreateReportResponse>\("\/api\/reports"/);
  assert.match(page, /window\.location\.assign\(`\/reports\/\$\{created\.report\.publicId\}\/loading`\)/);
  assert.doesNotMatch(page, /["'`]\/api\/(?:crawl|report|ads|match|enrich-products)["'`]/);
  assert.doesNotMatch(page, /action: "(?:event|document)"/);
  assert.match(page, /Find my competitors/);
  assert.match(page, /KEEPS WORKING IF YOU CLOSE THE TAB/);
  assert.match(page, /Three pillars, one report/);
  assert.match(page, /dir=\{ar \? "rtl" : "ltr"\}/);
  assert.match(savedReport, /<ProductDesignLab comparison=\{comparison\} battles=\{battles\}/);
  assert.match(productLab, /<PricePosition comparisonValue=\{row\.decision\.priceComparison\}/);
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
  assert.doesNotMatch(savedReport, /price-axis|price-line|price-dot|close-prices|price-picture|price-fallback/);
  assert.match(styles, /repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.ad-creative-feed \{[^}]*min-width: 0/);
  assert.match(styles, /\.ad-creative-copy strong, \.ad-creative-copy p, \.ad-creative-copy small \{[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.ad-creative-feed \{ grid-template-columns: 1fr/);
  assert.match(styles, /\.app-root\[dir="rtl"\]/);
  assert.match(styles, /\.memory-provenance \{/);
  assert.match(styles, /\.battle-product\.no-image \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.battle-product\.no-image strong \{ grid-column: 1; \}/);
  assert.match(productLab, /const LAYOUTS: ProductLayout\[\] = \["table", "matchups", "opportunities"\]/);
  assert.match(productLab, /className="product-compact-table"/);
  assert.match(productLab, /className="product-layout-panel matchup-layout"/);
  assert.match(productLab, /className="product-layout-panel opportunity-layout"/);
  assert.match(productLab, /role="tablist" aria-label=/);
  assert.match(productLab, /aria-selected=\{layout === item\}/);
  assert.match(productLab, /url\.searchParams\.set\("layout", next\)/);
  assert.match(productLab, /window\.addEventListener\("popstate", sync\)/);
  assert.match(productLab, /navigator\.share/);
  assert.match(productLab, /navigator\.clipboard\?\.writeText/);
  assert.match(productLab, /new Blob\(\[csv\], \{ type: "text\/csv;charset=utf-8" \}\)/);
  assert.match(productLab, /your_price_amount/);
  assert.match(productLab, /rival_currency/);
  assert.match(productLab, /showDetail=\{false\}/);
  assert.match(productLab, /showValues=\{false\}/);
  assert.match(pricePosition, /showValues = true/);
  assert.match(pricePosition, /showValues \? "" : " comparison-only"/);
  assert.match(pricePosition, /\{showValues && <div className="price-position-value your-position-value">/);
  assert.match(styles, /\.product-compact-table \{[^}]*min-width: 0;[^}]*table-layout: fixed/);
  assert.doesNotMatch(styles, /\.product-compact-table \{[^}]*min-width: 900px/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.product-table-row \{ display: grid/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1023px\)[\s\S]*\.product-table-row \{ scroll-margin-top: 200px/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.product-table-row \{ scroll-margin-top: 210px/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*grid-template-areas: "your-product" "your-price" "rival-product" "rival-price" "difference" "action"/);
  assert.match(styles, /@media print \{[\s\S]*\.product-row-details > summary \{ display: none; \}[\s\S]*\.product-row-details > div \{ display: grid !important; \}/);
  assert.match(styles, /\.matchup-products \{[^}]*grid-template-columns: minmax\(0,1fr\) 34px minmax\(0,1fr\)/);
  assert.match(styles, /\.opportunity-lanes \{[^}]*grid-template-columns: repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.matchup-products \{ grid-template-columns: minmax\(0,1fr\)/);
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
