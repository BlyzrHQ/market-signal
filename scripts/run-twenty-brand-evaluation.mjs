import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const baseUrl = (process.env.MARKET_SIGNAL_BASE_URL || "https://signal.blyzr.com").replace(/\/$/, "");
const outputPath = process.env.MARKET_SIGNAL_EVAL_OUTPUT || "docs/tasks/134-twenty-brand-production-results.json";
const csvPath = outputPath.replace(/\.json$/i, ".csv");
const markdownPath = outputPath.replace(/\.json$/i, ".md");
const concurrency = Math.max(1, Math.min(3, Number(process.env.MARKET_SIGNAL_EVAL_CONCURRENCY || 3)));
const timeoutMs = Math.max(60_000, Number(process.env.MARKET_SIGNAL_EVAL_TIMEOUT_MS || 20 * 60_000));
const pollMs = Math.max(2_000, Number(process.env.MARKET_SIGNAL_EVAL_POLL_MS || 10_000));
const refresh = process.env.MARKET_SIGNAL_EVAL_REFRESH === "true";
const existingReportIds = process.env.MARKET_SIGNAL_EXISTING_REPORTS
  ? JSON.parse(process.env.MARKET_SIGNAL_EXISTING_REPORTS)
  : {};

const domains = [
  "wearform.com", "myjam.co.uk", "allbirds.com", "gymshark.com", "colourpop.com",
  "beardbrand.com", "deathwishcoffee.com", "brooklinen.com", "tentree.com", "kotn.com",
  "bombas.com", "glossier.com", "liquiddeath.com", "buckmason.com", "ruggable.com",
  "hexclad.com", "feastables.com", "mejuri.com", "warbyparker.com", "ridge.com",
];

const terminalStatuses = new Set(["complete", "completed", "limited", "failed", "unavailable"]);
const supportedCurrencies = new Set(["USD", "GBP", "EUR", "CAD", "AUD", "NZD", "AED", "SAR", "KWD", "INR", "JPY"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const manualReviews = {
  "64c5c521c41a4b3cb4e60327741b5b66": {
    reviewedPairCount: 1,
    identityViolations: 1,
    recommendationViolations: 1,
    findings: [{
      severity: "P1",
      type: "model-identifier-conflict",
      primaryName: "Men's Challenger Custom Jacket",
      primarySourceUrl: "https://wearform.com/products/port-authority-mens-challenger-custom-jacket-j354wl",
      rivalName: "Port Authority ® Challenger™ Jacket. J754",
      rivalSourceUrl: "https://www.rlpuniform.com/products/port-authority-%C2%AE-challenger%E2%84%A2-jacket-j754",
      reason: "The primary URL and image identify model J354, while the rival is J754; the AI rationale incorrectly says both are J754 and recommends publishing the rival model on Wearform.",
    }],
  },
};

async function jsonRequest(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error(`HTTP ${response.status} returned non-JSON content.`); }
    if (!response.ok || payload?.ok === false) throw new Error(String(payload?.error || `HTTP ${response.status}`));
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function blocksOf(payload) {
  const outer = payload?.report?.document;
  return Array.isArray(outer?.document?.blocks) ? outer.document.blocks : Array.isArray(outer?.blocks) ? outer.blocks : [];
}

export function validPrice(signal) {
  return typeof signal?.amount === "number"
    && Number.isFinite(signal.amount)
    && signal.amount > 0
    && typeof signal?.raw === "string"
    && Boolean(signal.raw.trim())
    && supportedCurrencies.has(String(signal?.currency || "").toUpperCase());
}

export function validHttpUrl(value) {
  try { return /^https?:$/.test(new URL(String(value || "")).protocol); }
  catch { return false; }
}

export function validProductSource(product, expectedDomain = product?.domain) {
  if (!validHttpUrl(product?.sourceUrl)) return false;
  const expected = String(expectedDomain || "").toLowerCase().replace(/^www\./, "");
  if (!expected) return false;
  const hostname = new URL(product.sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

export function validDirectComparison(primary, match) {
  const comparison = match?.decision?.priceComparison;
  if (!comparison || typeof comparison !== "object") return false;
  const primaryPrices = (primary?.priceSignals || []).filter(validPrice);
  const rivalPrices = (match?.product?.priceSignals || []).filter(validPrice);
  return primaryPrices.some((primaryPrice) => rivalPrices.some((rivalPrice) => (
    primaryPrice.currency.toUpperCase() === rivalPrice.currency.toUpperCase()
    && String(comparison.primaryRaw || "").trim() === primaryPrice.raw.trim()
    && String(comparison.rivalRaw || "").trim() === rivalPrice.raw.trim()
  )));
}

export function isReusableTerminal(item) {
  return terminalStatuses.has(String(item?.status || "").toLowerCase());
}

export function localFailureResult(domain, prior, error, finishedAt = now()) {
  const reportId = String(prior?.reportId || "");
  return {
    domain,
    reportId,
    reportUrl: reportId ? `${baseUrl}/reports/${reportId}?view=products&layout=table` : "",
    plan: prior?.plan || "unknown",
    productLimit: prior?.productLimit ?? null,
    status: "evaluation_error",
    currentPhase: prior?.currentPhase || "matrix",
    errorCode: "matrix_request_failure",
    errorMessage: String(error?.message || error),
    createdAt: prior?.createdAt || "",
    completedAt: finishedAt,
    runtimeSeconds: null,
    documentAvailable: false,
    primaryProducts: null,
    verifiedCompetitors: null,
    competitorDomains: [],
    competitorProducts: null,
    assessedProducts: null,
    acceptedMatches: null,
    acceptedPricedMatches: null,
    dualPricedMatches: null,
    directPriceDeltas: null,
    comparisonUsefulness: "unknown",
    acceptedPairsWithBothImages: null,
    imageCoveragePercent: null,
    suppressedAcceptedPairs: null,
    missingRivalPriceViolations: null,
    sourceViolations: null,
    totalGaps: null,
    manualReview: { reviewedPairCount: 0, identityViolations: 0, recommendationViolations: 0, findings: [] },
    acceptedPairEvidence: [],
    verdict: "FAIL",
    verdictReasons: [String(error?.message || error)],
  };
}

export function summarize(payload, startedAt, finishedAt) {
  const report = payload?.report || {};
  const run = report.run || {};
  const blocks = blocksOf(payload);
  const comparison = blocks.find((block) => block?.type === "product-comparison") || {};
  const documentAvailable = blocks.length > 0;
  const competitors = blocks.filter((block) => block?.type === "competitor");
  const competitorDomains = new Set(competitors.map((item) => String(item?.domain || "").toLowerCase().replace(/^www\./, "")).filter(Boolean));
  const rows = Array.isArray(comparison.rows) ? comparison.rows : [];
  const matches = rows.flatMap((row) => (Array.isArray(row?.matches) ? row.matches : [])
    .filter((match) => match?.product)
    .map((match) => ({ primary: row.primary, match })));
  const pricedMatches = matches.filter(({ match }) => (match.product?.priceSignals || []).some(validPrice));
  const dualPricedMatches = pricedMatches.filter(({ primary }) => (primary?.priceSignals || []).some(validPrice));
  const directPriceDeltas = matches.filter(({ primary, match }) => validDirectComparison(primary, match)).length;
  const bothImages = matches.filter(({ primary, match }) => validHttpUrl(primary?.imageUrl) && validHttpUrl(match.product?.imageUrl)).length;
  const missingRivalPriceViolations = matches.filter(({ match }) => !(match.product?.priceSignals || []).some(validPrice)).length;
  const sourceViolations = matches.filter(({ primary, match }) => {
    const rivalDomain = String(match.product?.domain || match.domain || "").toLowerCase().replace(/^www\./, "");
    return !validProductSource(primary, run.primaryDomain)
      || !competitorDomains.has(rivalDomain)
      || !validProductSource(match.product, rivalDomain);
  }).length;
  const primaryProducts = documentAvailable ? Number(report?.primaryProducts?.totalCount || comparison?.coverage?.primaryProductsAvailable || 0) : null;
  const competitorProducts = documentAvailable ? Number(comparison?.coverage?.competitorProductsAvailable || 0) : null;
  const assessed = documentAvailable ? Number(comparison?.matching?.primaryProductsAssessed || 0) : null;
  const suppressed = documentAvailable ? Number(comparison?.matching?.publication?.suppressedAcceptedPairs || 0) : null;
  const manualReview = manualReviews[run.publicId] || { reviewedPairCount: 0, identityViolations: 0, recommendationViolations: 0, findings: [] };
  const terminalHealthy = ["complete", "completed", "limited"].includes(String(run.status || "").toLowerCase());
  const integrityViolations = missingRivalPriceViolations + sourceViolations + manualReview.identityViolations;
  let verdict = "PASS";
  const reasons = [];
  if (!terminalHealthy) { verdict = "FAIL"; reasons.push(`terminal status ${run.status || "unknown"}`); }
  if (!documentAvailable) { verdict = "FAIL"; reasons.push("report document unavailable; catalog metrics are unknown"); }
  else if (primaryProducts === 0) { verdict = "FAIL"; reasons.push("report observed an empty primary catalog"); }
  if (integrityViolations > 0) { verdict = "FAIL"; reasons.push(`${integrityViolations} publication integrity violation(s)`); }
  if (verdict !== "FAIL" && competitors.length === 0) { verdict = "LIMITED"; reasons.push("no verified competitor"); }
  if (verdict !== "FAIL" && pricedMatches.length === 0) { verdict = "LIMITED"; reasons.push("no accepted rival-priced match"); }
  if (!reasons.length) reasons.push("terminal report with a catalog, verified rival, and priced published match");
  const effectiveStartedAt = run.createdAt || startedAt;
  const effectiveFinishedAt = run.updatedAt || finishedAt;
  const runtimeSeconds = effectiveStartedAt && effectiveFinishedAt ? Math.round((Date.parse(effectiveFinishedAt) - Date.parse(effectiveStartedAt)) / 1000) : null;
  const totalGaps = blocks.filter((block) => block?.type === "gap").length
    + Number(comparison?.matching?.totalGapCount || 0)
    + Number(comparison?.enrichment?.totalGapCount || 0);
  return {
    domain: run.primaryDomain,
    reportId: run.publicId,
    reportUrl: `${baseUrl}/reports/${run.publicId}?view=products&layout=table`,
    plan: run.productPlan,
    productLimit: run.productLimit,
    status: run.status,
    currentPhase: run.currentPhase,
    errorCode: run.errorCode || "",
    errorMessage: run.errorMessage || "",
    createdAt: run.createdAt,
    completedAt: run.updatedAt || finishedAt,
    runtimeSeconds,
    documentAvailable,
    primaryProducts,
    verifiedCompetitors: documentAvailable ? competitors.length : null,
    competitorDomains: competitors.map((item) => item.domain),
    competitorProducts,
    assessedProducts: assessed,
    acceptedMatches: documentAvailable ? matches.length : null,
    acceptedPricedMatches: documentAvailable ? pricedMatches.length : null,
    dualPricedMatches: documentAvailable ? dualPricedMatches.length : null,
    directPriceDeltas: documentAvailable ? directPriceDeltas : null,
    comparisonUsefulness: !documentAvailable ? "unknown" : directPriceDeltas > 0 ? "direct-price-comparison" : dualPricedMatches.length > 0 ? "dual-price-context" : pricedMatches.length > 0 ? "rival-priced-substitute-discovery" : "none",
    acceptedPairsWithBothImages: documentAvailable ? bothImages : null,
    imageCoveragePercent: !documentAvailable || !matches.length ? null : Math.round((bothImages / matches.length) * 100),
    suppressedAcceptedPairs: suppressed,
    missingRivalPriceViolations: documentAvailable ? missingRivalPriceViolations : null,
    sourceViolations: documentAvailable ? sourceViolations : null,
    totalGaps: documentAvailable ? totalGaps : null,
    manualReview,
    acceptedPairEvidence: matches.map(({ primary, match }) => ({
      primaryId: String(primary?.id || ""),
      primaryName: String(primary?.name || ""),
      primaryClaimedDomain: String(primary?.domain || ""),
      primaryExpectedDomain: String(run.primaryDomain || ""),
      primarySourceUrl: String(primary?.sourceUrl || ""),
      primaryPrices: (primary?.priceSignals || []).filter(validPrice),
      rivalId: String(match.product?.id || ""),
      rivalName: String(match.product?.name || ""),
      rivalDomain: String(match.product?.domain || match.domain || ""),
      rivalClaimedDomain: String(match.product?.domain || ""),
      rivalExpectedDomain: String(match.product?.domain || match.domain || ""),
      rivalSourceUrl: String(match.product?.sourceUrl || ""),
      rivalPrices: (match.product?.priceSignals || []).filter(validPrice),
      verdict: String(match?.assessment?.verdict || ""),
      reasons: Array.isArray(match?.assessment?.reasons) ? match.assessment.reasons : [],
      contradictions: Array.isArray(match?.assessment?.contradictions) ? match.assessment.contradictions : [],
      directPriceComparison: validDirectComparison(primary, match),
      recommendedMove: String(match?.decision?.recommendedMove || ""),
    })),
    verdict,
    verdictReasons: reasons,
  };
}

async function loadArtifact() {
  try { return parseArtifactText(await readFile(outputPath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, baseUrl, startedAt: now(), completedAt: null, concurrency, domains, reports: [] };
    throw error;
  }
}

export function parseArtifactText(text) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Evaluation artifact is unreadable; refusing to create duplicate reports: ${error?.message || error}`); }
}

let persistQueue = Promise.resolve();
function persist(artifact) {
  const snapshot = `${JSON.stringify(artifact, null, 2)}\n`;
  persistQueue = persistQueue.then(async () => {
    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, snapshot, "utf8");
    await rename(temporaryPath, outputPath);
  });
  return persistQueue;
}

async function runDomain(domain, artifact) {
  const existing = artifact.reports.find((item) => item.domain === domain);
  if (existing && isReusableTerminal(existing) && !refresh) return existing;
  const startedAt = now();
  let publicId = String(existing?.reportId || existingReportIds[domain] || "");
  if (publicId) {
    console.log(`[${startedAt}] ${domain}: resuming ${publicId}`);
  } else {
    console.log(`[${startedAt}] ${domain}: submitting`);
    const created = await jsonRequest("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primaryDomain: domain, locale: "en" }),
    });
    publicId = String(created?.report?.publicId || "");
  }
  if (!publicId) throw new Error("Creation response omitted publicId.");
  const saveProgress = async (run = {}) => {
    const progress = {
      domain,
      reportId: publicId,
      reportUrl: `${baseUrl}/reports/${publicId}?view=products&layout=table`,
      plan: run.productPlan || existing?.plan || "unknown",
      productLimit: run.productLimit ?? existing?.productLimit ?? null,
      status: run.status || existing?.status || "queued",
      currentPhase: run.currentPhase || existing?.currentPhase || "queued",
      errorCode: run.errorCode || "",
      errorMessage: run.errorMessage || "",
      createdAt: run.createdAt || existing?.createdAt || startedAt,
      completedAt: null,
      runtimeSeconds: null,
      documentAvailable: false,
      primaryProducts: null,
      verifiedCompetitors: null,
      competitorDomains: [],
      competitorProducts: null,
      assessedProducts: null,
      acceptedMatches: null,
      acceptedPricedMatches: null,
      dualPricedMatches: null,
      directPriceDeltas: null,
      comparisonUsefulness: "unknown",
      acceptedPairsWithBothImages: null,
      imageCoveragePercent: null,
      suppressedAcceptedPairs: null,
      missingRivalPriceViolations: null,
      sourceViolations: null,
      totalGaps: null,
      manualReview: { reviewedPairCount: 0, identityViolations: 0, recommendationViolations: 0, findings: [] },
      acceptedPairEvidence: [],
      verdict: "PENDING",
      verdictReasons: ["report is still running"],
    };
    artifact.reports = [...artifact.reports.filter((item) => item.domain !== domain), progress];
    await persist(artifact);
  };
  await saveProgress();
  const deadline = Date.now() + timeoutMs;
  let payload;
  let lastPhase = "";
  while (Date.now() < deadline) {
    payload = await jsonRequest(`/api/reports/${publicId}`);
    const run = payload?.report?.run || {};
    console.log(`[${now()}] ${domain}: ${run.status || "unknown"}/${run.currentPhase || "unknown"}`);
    if (terminalStatuses.has(String(run.status || "").toLowerCase())) break;
    const phase = `${run.status || "unknown"}/${run.currentPhase || "unknown"}`;
    if (phase !== lastPhase) {
      await saveProgress(run);
      lastPhase = phase;
    }
    await sleep(pollMs);
  }
  if (!payload || !terminalStatuses.has(String(payload?.report?.run?.status || "").toLowerCase())) {
    const run = payload?.report?.run || {};
    payload = { report: { ...payload?.report, run: { ...run, primaryDomain: domain, publicId, status: "timeout", currentPhase: run.currentPhase || "unknown", errorCode: "matrix_timeout", errorMessage: "The report did not reach a terminal state within the matrix deadline." } } };
  }
  const result = summarize(payload, startedAt, now());
  artifact.reports = [...artifact.reports.filter((item) => item.domain !== domain), result];
  await persist(artifact);
  return result;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeSummaries(artifact) {
  artifact.reports.sort((a, b) => domains.indexOf(a.domain) - domains.indexOf(b.domain));
  artifact.completedAt = now();
  const summarizeCohort = (reports) => ({
    total: reports.length,
    pass: reports.filter((item) => item.verdict === "PASS").length,
    limited: reports.filter((item) => item.verdict === "LIMITED").length,
    fail: reports.filter((item) => item.verdict === "FAIL").length,
    directPriceComparisonReports: reports.filter((item) => Number(item.directPriceDeltas || 0) > 0).length,
  });
  artifact.summary = {
    total: artifact.reports.length,
    pass: artifact.reports.filter((item) => item.verdict === "PASS").length,
    limited: artifact.reports.filter((item) => item.verdict === "LIMITED").length,
    fail: artifact.reports.filter((item) => item.verdict === "FAIL").length,
    executionFailures: artifact.reports.filter((item) => !item.documentAvailable).length,
    observedEmptyPrimaryCatalogs: artifact.reports.filter((item) => item.documentAvailable && item.primaryProducts === 0).length,
    noVerifiedCompetitor: artifact.reports.filter((item) => item.documentAvailable && item.verifiedCompetitors === 0).length,
    noAcceptedPricedMatch: artifact.reports.filter((item) => item.documentAvailable && item.acceptedPricedMatches === 0).length,
    publicationIntegrityViolations: artifact.reports.reduce((sum, item) => sum + Number(item.missingRivalPriceViolations || 0) + Number(item.sourceViolations || 0) + Number(item.manualReview?.identityViolations || 0), 0),
    knownIdentityViolations: artifact.reports.reduce((sum, item) => sum + Number(item.manualReview?.identityViolations || 0), 0),
    directPriceComparisonReports: artifact.reports.filter((item) => Number(item.directPriceDeltas || 0) > 0).length,
    planCounts: Object.fromEntries([...new Set(artifact.reports.map((item) => item.plan || "unknown"))]
      .map((plan) => [plan, artifact.reports.filter((item) => (item.plan || "unknown") === plan).length])),
    byPlan: Object.fromEntries([...new Set(artifact.reports.map((item) => item.plan || "unknown"))]
      .map((plan) => [plan, summarizeCohort(artifact.reports.filter((item) => (item.plan || "unknown") === plan))])),
  };
  await persist(artifact);
  const columns = ["domain", "plan", "verdict", "status", "runtimeSeconds", "documentAvailable", "primaryProducts", "verifiedCompetitors", "competitorProducts", "assessedProducts", "acceptedMatches", "acceptedPricedMatches", "dualPricedMatches", "directPriceDeltas", "comparisonUsefulness", "imageCoveragePercent", "suppressedAcceptedPairs", "totalGaps", "verdictReasons", "reportUrl"];
  await writeFile(csvPath, `${columns.join(",")}\n${artifact.reports.map((item) => columns.map((column) => csvCell(item[column])).join(",")).join("\n")}\n`, "utf8");
  const shown = (value) => value ?? "—";
  const table = artifact.reports.map((item) => `| ${item.domain} | ${item.verdict} | ${item.status} | ${shown(item.primaryProducts)} | ${shown(item.verifiedCompetitors)} | ${shown(item.assessedProducts)} | ${shown(item.acceptedPricedMatches)} | ${shown(item.directPriceDeltas)} | [report](${item.reportUrl}) |`).join("\n");
  const planSummary = Object.entries(artifact.summary.planCounts).map(([plan, count]) => `${count} ${plan}`).join(", ");
  const byPlan = Object.entries(artifact.summary.byPlan).map(([plan, value]) => `- ${plan}: ${value.total} reports — ${value.pass} PASS, ${value.limited} LIMITED, ${value.fail} FAIL, ${value.directPriceComparisonReports} with a direct price delta`).join("\n");
  const markdown = `# Twenty-brand production evaluation\n\nCaptured ${artifact.completedAt} against ${baseUrl}. Persisted plans: ${planSummary}. MyJam inherited its server-owned Agency entitlement; the other domains used Starter.\n\n- PASS: ${artifact.summary.pass}\n- LIMITED: ${artifact.summary.limited}\n- FAIL: ${artifact.summary.fail}\n- Execution failures with unknown catalog metrics: ${artifact.summary.executionFailures}\n- Observed empty primary catalogs: ${artifact.summary.observedEmptyPrimaryCatalogs}\n- Reports with a document but no verified competitor: ${artifact.summary.noVerifiedCompetitor}\n- Reports with a document but no accepted rival-priced match: ${artifact.summary.noAcceptedPricedMatch}\n- Known publication integrity violations: ${artifact.summary.publicationIntegrityViolations}\n- Reports with a direct price comparison: ${artifact.summary.directPriceComparisonReports}\n\n## Results by persisted plan\n\n${byPlan}\n\nA PASS here means the run produced a catalog, a verified rival, and at least one rival-priced published candidate without a known integrity violation. It does not guarantee an actionable direct price comparison; that requires valid public prices on both sides and is reported separately.\n\nImage coverage means an HTTP(S) image URL was present; images were not load-tested or visually validated. Source validation checks URL shape and binding to the claimed product domain, not capture-time reachability. Pair identity was not exhaustively human-reviewed. The one sampled Wearform model-number conflict is recorded as a known integrity violation and makes that report fail this strict evaluation.\n\n| Domain | Verdict | Status | Primary products | Rivals | Assessed | Priced matches | Direct deltas | Link |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n${table}\n`;
  await writeFile(markdownPath, markdown, "utf8");
}

export async function main() {
  const artifact = await loadArtifact();
  let cursor = 0;
  async function worker() {
    while (cursor < domains.length) {
      const domain = domains[cursor++];
      try { await runDomain(domain, artifact); }
      catch (error) {
        const prior = artifact.reports.find((item) => item.domain === domain);
        const result = localFailureResult(domain, prior, error);
        artifact.reports = [...artifact.reports.filter((item) => item.domain !== domain), result];
        await persist(artifact);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await writeSummaries(artifact);
  console.log(JSON.stringify({ outputPath, csvPath, markdownPath, summary: artifact.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
