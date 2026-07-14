import { writeFile } from "node:fs/promises";
import { reduceCompetitorForPanel, usefulnessBreakdown } from "./live-panel-utils.mjs";

const siteUrl = (process.env.MARKET_SIGNAL_SITE_URL || "https://market-signal.abdulla617931.chatgpt.site").replace(/\/$/, "");
const authorization = process.env.MARKET_SIGNAL_SITES_AUTH;
const sitesVersion = Number(process.env.MARKET_SIGNAL_SITES_VERSION || 38);
const deployedCommit = process.env.MARKET_SIGNAL_DEPLOYED_COMMIT || "82c4f782af299661f8d3eb3059e8da3346f74af9";
const outputPath = process.env.MARKET_SIGNAL_PANEL_OUTPUT || `docs/tasks/024-live-panel-v${sitesVersion}.json`;

if (!authorization) throw new Error("MARKET_SIGNAL_SITES_AUTH is required.");

const domains = [
  "myjam.co.uk",
  "birdandblendtea.com",
  "pipandnut.com",
  "oddbox.co.uk",
  "beardbrand.com",
  "allbirds.com",
  "linear.app",
  "buffer.com",
  "thoughtbot.com",
  "ustwo.com",
];

const expectedRegions = new Map([
  ["myjam.co.uk", "United Kingdom"],
  ["birdandblendtea.com", "United Kingdom"],
  ["pipandnut.com", "United Kingdom"],
  ["oddbox.co.uk", "United Kingdom"],
  ["beardbrand.com", "United States"],
  ["allbirds.com", "United States"],
  ["linear.app", "United States"],
  ["buffer.com", "United States"],
  ["thoughtbot.com", "Global market"],
  ["ustwo.com", "Global market"],
]);

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function cleanRegion(value) {
  return String(value || "").replace(/\s*\(inferred\)\s*$/i, "").trim();
}

function safePriceSignals(product) {
  return Array.isArray(product?.priceSignals)
    ? product.priceSignals.slice(0, 4).map((price) => String(price?.raw || "")).filter(Boolean)
    : [];
}

async function post(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const started = performance.now();
  try {
    const response = await fetch(`${siteUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "OAI-Sites-Authorization": `Bearer ${authorization}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { payload = { ok: false, error: `Non-JSON response (${response.status}).` }; }
    return { status: response.status, seconds: Number(((performance.now() - started) / 1000).toFixed(1)), payload };
  } catch (error) {
    return { status: 0, seconds: Number(((performance.now() - started) / 1000).toFixed(1)), payload: { ok: false, error: error?.name === "AbortError" ? "Panel request timed out." : String(error?.message || error) } };
  } finally {
    clearTimeout(timeout);
  }
}

function reduceAdCompany(company) {
  const platforms = Array.isArray(company?.platforms) ? company.platforms : [];
  const concepts = platforms.flatMap((platform) => Array.isArray(platform?.creatives) ? platform.creatives : []);
  return {
    domain: String(company?.domain || ""),
    states: platforms.map((platform) => `${String(platform?.platform || "Unknown")} ${String(platform?.status || "unknown")}`),
    verifiedCreativeConcepts: concepts.length,
    publicEvidenceCount: platforms.reduce((sum, platform) => sum + (Array.isArray(platform?.evidenceUrls) ? platform.evidenceUrls.length : 0), 0),
  };
}

async function runDomain(domain) {
  const crawl = await post("/api/crawl", { primary: domain, domains: [domain] });
  const payload = crawl.payload;
  const document = payload?.document || { blocks: [] };
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const primary = results.find((result) => result?.domain === payload?.primaryDomain) || results.find((result) => result?.role === "primary");
  const competitors = results.filter((result) => result?.role === "discovered-competitor" && result?.homepage && result?.discovery?.accepted);
  const reducedCompetitors = competitors.map(reduceCompetitorForPanel);
  const profile = blocks.find((block) => block?.type === "market-profile") || {};
  const comparison = blocks.find((block) => block?.type === "product-comparison") || {};
  const rows = Array.isArray(comparison.rows) ? comparison.rows : [];
  const matches = rows.flatMap((row) => (Array.isArray(row?.matches) ? row.matches : []).filter((match) => match?.product && match?.confidence === "Medium").map((match) => ({ primary: row.primary, match })));
  const ad = payload?.ok && payload?.adRequest ? await post("/api/ads", payload.adRequest) : { status: 0, seconds: 0, payload: { ok: false, error: "Crawl did not return verified ad targets." } };
  const adBlock = ad.payload?.block || {};
  const adCompanies = (Array.isArray(adBlock.companies) ? adBlock.companies : []).map(reduceAdCompany);
  const verifiedCreativeConcepts = adCompanies.reduce((sum, company) => sum + company.verifiedCreativeConcepts, 0);
  const exactPriceCount = matches.filter(({ match }) => Boolean(match?.decision?.priceComparison)).length;
  const actionableMatchCount = matches.filter(({ match }) => Boolean(String(match?.decision?.recommendedMove || "").trim())).length;
  const region = cleanRegion(profile.region || primary?.homepage?.region);
  const expectedRegion = expectedRegions.get(domain);
  const regionCorrect = region === expectedRegion;
  const competitorEvidenceComplete = reducedCompetitors.every((result) => Boolean(result.homepageEvidenceUrl && result.discoveryEvidenceUrl));
  const positioningComparisonCount = reducedCompetitors.filter((result) => result.positioningComparison.available).length;
  const offeringCount = Array.isArray(primary?.products) ? primary.products.length : 0;
  const score = usefulnessBreakdown({ ok: Boolean(payload?.ok), regionCorrect, competitorCount: competitors.length, offeringCount, matchCount: matches.length, positioningComparisonCount, exactPriceCount, adsOk: Boolean(ad.payload?.ok), verifiedCreativeConcepts, competitorEvidenceComplete, actionableMatchCount });
  return {
    domain,
    reportOk: Boolean(payload?.ok),
    reportStatus: crawl.status,
    crawlSeconds: crawl.seconds,
    adScanOk: Boolean(ad.payload?.ok),
    adStatus: ad.status,
    adSeconds: ad.seconds,
    error: String(payload?.error || ""),
    region,
    expectedRegion,
    regionCorrect,
    category: String(profile.category || ""),
    offeringCount,
    offeringSamples: (Array.isArray(primary?.products) ? primary.products : []).slice(0, 5).map((product) => ({ name: String(product?.name || ""), type: String(product?.jsonLdType || ""), sourceUrl: String(product?.sourceUrl || "") })),
    competitors: reducedCompetitors,
    positioningComparisonCount,
    comparisonCoverage: comparison.coverage || null,
    visibleMatches: matches.slice(0, 8).map(({ primary: primaryProduct, match }) => ({
      primary: String(primaryProduct?.name || ""),
      primarySourceUrl: String(primaryProduct?.sourceUrl || ""),
      primaryPrices: safePriceSignals(primaryProduct),
      rival: String(match?.product?.name || ""),
      rivalDomain: String(match?.domain || ""),
      rivalSourceUrl: String(match?.product?.sourceUrl || ""),
      rivalPrices: safePriceSignals(match?.product),
      score: Number(match?.score || 0),
      verdict: String(match?.decision?.priceVerdict || ""),
      recommendedMove: String(match?.decision?.recommendedMove || ""),
      exactPriceComparison: Boolean(match?.decision?.priceComparison),
    })),
    ads: {
      companies: adCompanies,
      verifiedCreativeConcepts,
      limitation: String(adBlock.limitation || ad.payload?.error || ""),
    },
    diagnosticUsefulness: {
      ...score,
      grade: score.score >= 70 ? "GOOD" : "NEEDS_WORK",
      note: "Diagnostic only; Fable 5 independently scores the merge gate.",
    },
  };
}

const capturedAt = new Date().toISOString();
const reports = await Promise.all(domains.map(runDomain));
const crawlTimes = reports.filter((report) => report.reportOk).map((report) => report.crawlSeconds);
const scores = reports.map((report) => report.diagnosticUsefulness.score).sort((a, b) => a - b);
const artifact = {
  deployment: {
    sitesVersion,
    commit: deployedCommit,
    url: siteUrl,
    capturedAt,
    fixtureData: false,
    retries: 0,
  },
  summary: {
    reportsOk: reports.filter((report) => report.reportOk).length,
    adScansOk: reports.filter((report) => report.adScanOk).length,
    correctRegions: reports.filter((report) => report.regionCorrect).length,
    confidentWrongRegions: reports.filter((report) => report.region && !report.regionCorrect).length,
    domainsWithAtLeastThreeCompetitors: reports.filter((report) => report.competitors.length >= 3).length,
    domainsWithAtLeastFiveOfferings: reports.filter((report) => report.offeringCount >= 5).length,
    domainsWithVisibleProductOrServiceMatches: reports.filter((report) => report.visibleMatches.length > 0).length,
    domainsWithProductOrCitedPositioningComparison: reports.filter((report) => report.visibleMatches.length > 0 || report.positioningComparisonCount >= 3).length,
    domainsWithExactComparablePrices: reports.filter((report) => report.visibleMatches.some((match) => match.exactPriceComparison)).length,
    verifiedCreativeConcepts: reports.reduce((sum, report) => sum + report.ads.verifiedCreativeConcepts, 0),
    diagnosticGoodCount: reports.filter((report) => report.diagnosticUsefulness.grade === "GOOD").length,
    diagnosticMedianScore: scores.length ? (scores[4] + scores[5]) / 2 : null,
    crawlLatencySeconds: { p50: percentile(crawlTimes, 0.5), p95: percentile(crawlTimes, 0.95) },
  },
  dataBoundaries: [
    "This is a no-retry production capture from the deployed application; no fixture data is included.",
    "Every competitor record retains first-party homepage and discovery evidence URLs.",
    "Visible matches include only Medium-confidence pairs returned by the production comparison engine.",
    "A cited positioning comparison is counted only when at least three verified rivals have first-party and discovery evidence plus category alignment.",
    "Exact price comparisons require a server-approved priceComparison pair.",
    "Missing or limited ad coverage is not evidence of zero advertising activity.",
    "Diagnostic usefulness scores are transparent heuristics and are not the Fable 5 merge verdict.",
  ],
  reports,
};

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, summary: artifact.summary }, null, 2));
