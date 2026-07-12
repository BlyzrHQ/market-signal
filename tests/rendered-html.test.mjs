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
  const [route, crawl, report, page, layout, packageJson, domainUtils] = await Promise.all([
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/crawl/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/report/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/domain.ts", import.meta.url), "utf8"),
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
  assert.match(crawl, /possible market candidate/);
  assert.match(crawl, /buildDocument/);
  assert.match(crawl, /buildProductComparison/);
  assert.match(crawl, /extractProductsFromHtml/);
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
  assert.match(page, /fetch\("\/api\/crawl"/);
  assert.match(page, /fetch\("\/api\/report"/);
  assert.match(page, /domains: successful\.map/);
  assert.match(page, /What changed in your market/);
  assert.match(page, /grounded claims/);
  assert.match(page, /JSON report document/);
  assert.match(page, /POSSIBLE CANDIDATE/);
  assert.match(page, /PRODUCT-BY-PRODUCT/);
  assert.match(page, /Closest observed match/i);
  assert.match(page, /No comparable public product observed/);
  assert.match(page, /Public source/);
  assert.match(page, /Optional comparison domains/);
  assert.match(page, /Public comparison/);
  assert.match(page, /Public pricing signals/);
  assert.match(page, /primaryResult/);
  assert.match(page, /failedComparisonDomains/);
  assert.match(page, /Public-source coverage/);
  assert.match(page, /No ad volume or spend estimate is shown/);
  assert.match(page, /Your company domain or URL/);
  assert.match(page, /https:\/\/yourcompany\.com/);
  assert.doesNotMatch(page, /<span>https:\/\/<\/span>/);
  assert.doesNotMatch(page, /Northstar|Brightcart|Shopline|Illustrative competitor set|Own “easy”|11 total|acmecommerce\.com/);
  assert.match(layout, /Market Signal — Know where your market is moving/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
