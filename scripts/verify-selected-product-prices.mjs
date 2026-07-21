import { applyFinalProductEnrichment, selectFinalProductEnrichmentTargets } from "../app/lib/product-intelligence.ts";
import { enrichProductTargets, MAX_ENRICHMENT_TARGETS } from "../app/lib/storefront-product-enrichment.ts";

const reportApi = process.argv[2];
if (!/^https:\/\//i.test(reportApi || "")) {
  throw new Error("Usage: node scripts/verify-selected-product-prices.mjs https://<site>/api/reports/<publicId>");
}

const response = await fetch(reportApi, { headers: { Accept: "application/json" } });
if (!response.ok) throw new Error(`Report API returned HTTP ${response.status}.`);
const payload = await response.json();
const blocks = payload?.report?.document?.document?.blocks;
const comparison = Array.isArray(blocks) ? blocks.find((block) => block?.type === "product-comparison") : null;
if (!comparison) throw new Error("The saved report does not contain a product-comparison block.");

const displayPrice = (product) => {
  const prices = (product?.priceSignals || []).filter((signal) => Number.isFinite(signal?.amount) && signal?.currency);
  if (!prices.length) return "";
  const currencies = [...new Set(prices.map((signal) => signal.currency))];
  const amounts = [...new Set(prices.map((signal) => signal.amount))].sort((left, right) => left - right);
  if (currencies.length !== 1) return prices[0].raw || "";
  return amounts.length === 1 ? `${currencies[0]} ${amounts[0]}` : `${currencies[0]} ${amounts[0]}-${amounts.at(-1)}`;
};

const targets = selectFinalProductEnrichmentTargets(comparison, MAX_ENRICHMENT_TARGETS);
const result = await enrichProductTargets(targets, MAX_ENRICHMENT_TARGETS);
const enriched = applyFinalProductEnrichment(comparison, result.products, result.coverage);
const rows = enriched.rows.flatMap((row) => row.matches
  .filter((match) => match.confidence === "Medium" && match.product)
  .map((match) => ({
    primary: row.primary.name,
    primaryPrice: displayPrice(row.primary),
    rivalDomain: match.domain,
    rival: match.product.name,
    rivalPrice: displayPrice(match.product),
    primaryUrl: row.primary.sourceUrl,
    rivalUrl: match.product.sourceUrl,
  })));
const missing = rows.flatMap((row, index) => [
  ...(!row.primaryPrice ? [{ row: index + 1, side: "primary", url: row.primaryUrl }] : []),
  ...(!row.rivalPrice ? [{ row: index + 1, side: "rival", url: row.rivalUrl }] : []),
]);

console.log(JSON.stringify({
  reportApi,
  selectedRows: rows.length,
  targetsRequested: targets.length,
  pagesAccepted: result.coverage.pagesFetched,
  visiblePriceCells: (rows.length * 2) - missing.length,
  requiredPriceCells: rows.length * 2,
  missing,
  gaps: result.coverage.gaps,
  rows,
}, null, 2));
if (missing.length) process.exitCode = 1;
