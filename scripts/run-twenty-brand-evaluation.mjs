import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const baseUrl = (process.env.MARKET_SIGNAL_BASE_URL || "https://signal.blyzr.com").replace(/\/$/, "");
const outputPath = process.env.MARKET_SIGNAL_EVAL_OUTPUT || "docs/tasks/134-twenty-brand-production-results.json";
const csvPath = outputPath.replace(/\.json$/i, ".csv");
const markdownPath = outputPath.replace(/\.json$/i, ".md");
const concurrency = Math.max(1, Math.min(3, Number(process.env.MARKET_SIGNAL_EVAL_CONCURRENCY || 3)));
const timeoutMs = Math.max(60_000, Number(process.env.MARKET_SIGNAL_EVAL_TIMEOUT_MS || 20 * 60_000));
const pollMs = Math.max(2_000, Number(process.env.MARKET_SIGNAL_EVAL_POLL_MS || 10_000));
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

function validPrice(signal) {
  return Number.isFinite(Number(signal?.amount)) && Number(signal.amount) > 0 && supportedCurrencies.has(String(signal?.currency || "").toUpperCase());
}

function validHttpUrl(value) {
  try { return /^https?:$/.test(new URL(String(value || "")).protocol); }
  catch { return false; }
}

function summarize(payload, startedAt, finishedAt) {
  const report = payload?.report || {};
  const run = report.run || {};
  const blocks = blocksOf(payload);
  const comparison = blocks.find((block) => block?.type === "product-comparison") || {};
  const competitors = blocks.filter((block) => block?.type === "competitor");
  const rows = Array.isArray(comparison.rows) ? comparison.rows : [];
  const matches = rows.flatMap((row) => (Array.isArray(row?.matches) ? row.matches : [])
    .filter((match) => match?.product)
    .map((match) => ({ primary: row.primary, match })));
  const pricedMatches = matches.filter(({ match }) => (match.product?.priceSignals || []).some(validPrice));
  const directPriceDeltas = matches.filter(({ match }) => Boolean(match?.decision?.priceComparison)).length;
  const bothImages = matches.filter(({ primary, match }) => validHttpUrl(primary?.imageUrl) && validHttpUrl(match.product?.imageUrl)).length;
  const missingRivalPriceViolations = matches.filter(({ match }) => !(match.product?.priceSignals || []).some(validPrice)).length;
  const sourceViolations = matches.filter(({ primary, match }) => !validHttpUrl(primary?.sourceUrl) || !validHttpUrl(match.product?.sourceUrl)).length;
  const primaryProducts = Number(report?.primaryProducts?.totalCount || comparison?.coverage?.primaryProductsAvailable || 0);
  const competitorProducts = Number(comparison?.coverage?.competitorProductsAvailable || 0);
  const assessed = Number(comparison?.matching?.primaryProductsAssessed || 0);
  const suppressed = Number(comparison?.matching?.publication?.suppressedAcceptedPairs || 0);
  const terminalHealthy = ["complete", "completed", "limited"].includes(String(run.status || "").toLowerCase());
  const integrityViolations = missingRivalPriceViolations + sourceViolations;
  let verdict = "PASS";
  const reasons = [];
  if (!terminalHealthy) { verdict = "FAIL"; reasons.push(`terminal status ${run.status || "unknown"}`); }
  if (primaryProducts === 0) { verdict = "FAIL"; reasons.push("no primary products discovered"); }
  if (integrityViolations > 0) { verdict = "FAIL"; reasons.push(`${integrityViolations} publication integrity violation(s)`); }
  if (verdict !== "FAIL" && competitors.length === 0) { verdict = "LIMITED"; reasons.push("no verified competitor"); }
  if (verdict !== "FAIL" && pricedMatches.length === 0) { verdict = "LIMITED"; reasons.push("no accepted priced match"); }
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
    primaryProducts,
    verifiedCompetitors: competitors.length,
    competitorDomains: competitors.map((item) => item.domain),
    competitorProducts,
    assessedProducts: assessed,
    acceptedMatches: matches.length,
    acceptedPricedMatches: pricedMatches.length,
    directPriceDeltas,
    acceptedPairsWithBothImages: bothImages,
    imageCoveragePercent: matches.length ? Math.round((bothImages / matches.length) * 100) : null,
    suppressedAcceptedPairs: suppressed,
    missingRivalPriceViolations,
    sourceViolations,
    totalGaps,
    verdict,
    verdictReasons: reasons,
  };
}

async function loadArtifact() {
  try { return JSON.parse(await readFile(outputPath, "utf8")); }
  catch { return { schemaVersion: 1, baseUrl, startedAt: now(), completedAt: null, concurrency, domains, reports: [] }; }
}

let persistQueue = Promise.resolve();
function persist(artifact) {
  const snapshot = `${JSON.stringify(artifact, null, 2)}\n`;
  persistQueue = persistQueue.then(async () => {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, snapshot, "utf8");
  });
  return persistQueue;
}

async function runDomain(domain, artifact) {
  const existing = artifact.reports.find((item) => item.domain === domain && terminalStatuses.has(String(item.status || "").toLowerCase()));
  if (existing) return existing;
  const startedAt = now();
  let publicId = String(existingReportIds[domain] || "");
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
  const deadline = Date.now() + timeoutMs;
  let payload;
  while (Date.now() < deadline) {
    payload = await jsonRequest(`/api/reports/${publicId}`);
    const run = payload?.report?.run || {};
    console.log(`[${now()}] ${domain}: ${run.status || "unknown"}/${run.currentPhase || "unknown"}`);
    if (terminalStatuses.has(String(run.status || "").toLowerCase())) break;
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
  artifact.summary = {
    total: artifact.reports.length,
    pass: artifact.reports.filter((item) => item.verdict === "PASS").length,
    limited: artifact.reports.filter((item) => item.verdict === "LIMITED").length,
    fail: artifact.reports.filter((item) => item.verdict === "FAIL").length,
    noPrimaryCatalog: artifact.reports.filter((item) => item.primaryProducts === 0).length,
    noVerifiedCompetitor: artifact.reports.filter((item) => item.verifiedCompetitors === 0).length,
    noAcceptedPricedMatch: artifact.reports.filter((item) => item.acceptedPricedMatches === 0).length,
    publicationIntegrityViolations: artifact.reports.reduce((sum, item) => sum + item.missingRivalPriceViolations + item.sourceViolations, 0),
    planCounts: Object.fromEntries([...new Set(artifact.reports.map((item) => item.plan || "unknown"))]
      .map((plan) => [plan, artifact.reports.filter((item) => (item.plan || "unknown") === plan).length])),
  };
  await persist(artifact);
  const columns = ["domain", "verdict", "status", "runtimeSeconds", "primaryProducts", "verifiedCompetitors", "competitorProducts", "assessedProducts", "acceptedMatches", "acceptedPricedMatches", "directPriceDeltas", "imageCoveragePercent", "suppressedAcceptedPairs", "totalGaps", "verdictReasons", "reportUrl"];
  await writeFile(csvPath, `${columns.join(",")}\n${artifact.reports.map((item) => columns.map((column) => csvCell(item[column])).join(",")).join("\n")}\n`, "utf8");
  const table = artifact.reports.map((item) => `| ${item.domain} | ${item.verdict} | ${item.status} | ${item.primaryProducts} | ${item.verifiedCompetitors} | ${item.assessedProducts} | ${item.acceptedPricedMatches} | ${item.directPriceDeltas} | [report](${item.reportUrl}) |`).join("\n");
  const planSummary = Object.entries(artifact.summary.planCounts).map(([plan, count]) => `${count} ${plan}`).join(", ");
  const markdown = `# Twenty-brand production evaluation\n\nCaptured ${artifact.completedAt} against ${baseUrl}. Persisted plans: ${planSummary}. MyJam inherited its server-owned Agency entitlement; the other domains used Starter.\n\n- PASS: ${artifact.summary.pass}\n- LIMITED: ${artifact.summary.limited}\n- FAIL: ${artifact.summary.fail}\n- No primary catalog: ${artifact.summary.noPrimaryCatalog}\n- No verified competitor: ${artifact.summary.noVerifiedCompetitor}\n- No accepted priced match: ${artifact.summary.noAcceptedPricedMatch}\n- Publication integrity violations: ${artifact.summary.publicationIntegrityViolations}\n\n| Domain | Verdict | Status | Primary products | Rivals | Assessed | Priced matches | Direct deltas | Link |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n${table}\n`;
  await writeFile(markdownPath, markdown, "utf8");
}

const artifact = await loadArtifact();
let cursor = 0;
async function worker() {
  while (cursor < domains.length) {
    const domain = domains[cursor++];
    try { await runDomain(domain, artifact); }
    catch (error) {
      const result = { domain, reportId: "", reportUrl: "", plan: "starter", productLimit: 20, status: "failed", currentPhase: "matrix", errorCode: "matrix_request_failure", errorMessage: String(error?.message || error), createdAt: "", completedAt: now(), runtimeSeconds: null, primaryProducts: 0, verifiedCompetitors: 0, competitorDomains: [], competitorProducts: 0, assessedProducts: 0, acceptedMatches: 0, acceptedPricedMatches: 0, directPriceDeltas: 0, acceptedPairsWithBothImages: 0, imageCoveragePercent: null, suppressedAcceptedPairs: 0, missingRivalPriceViolations: 0, sourceViolations: 0, totalGaps: 0, verdict: "FAIL", verdictReasons: [String(error?.message || error)] };
      artifact.reports = [...artifact.reports.filter((item) => item.domain !== domain), result];
      await persist(artifact);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
await writeSummaries(artifact);
console.log(JSON.stringify({ outputPath, csvPath, markdownPath, summary: artifact.summary }, null, 2));
