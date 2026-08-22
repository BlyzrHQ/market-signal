import {
  compactPublishedProductComparisonCheckpoint,
  composeProductMatchAttempts,
  hasProductMatchCoverageDefect,
  limitPublishedProductComparison,
  mergePublishedProductComparisonState,
  mergePublishedProductComparisons,
  publishPricedProductComparison,
  shouldRetryProductMatch,
  upsertProductComparisonBlock,
} from "../../app/lib/product-match-lifecycle.ts";
import {
  applyFinalProductEnrichment,
  planFinalProductEnrichmentTargets,
  publicSourceMarketContext,
  type ProductComparison,
  type ProductEnrichmentTarget,
  type ProductRecord,
} from "../../app/lib/product-intelligence.ts";
import { canonicalDomain } from "../../app/lib/domain.ts";
import {
  applyProductActionPlans,
  collectProductActionInputs,
  deterministicProductActionResult,
  type ProductActionInput,
  type ProductActionPlanningResult,
} from "../../app/lib/ai-action-planner.ts";
import {
  PermanentOrchestrationError,
  REPORT_ORCHESTRATION_CONTRACT_VERSION,
  parseReportOrchestrationPayload,
  type ReportOrchestrationPayload,
  type ReportOrchestrationSummary,
} from "../shared/report-orchestration-contract.ts";
import { buildReportFactBundle } from "../shared/report-facts.ts";
import { compactTerminalReportDocument, encodedJsonBytes, REPORT_MATCH_CHECKPOINT_RESULT_BYTES } from "../shared/report-document-compaction.ts";
import type { ReportFactChunkInput, ReportFactManifestInput } from "../../app/lib/report-store.ts";
import type { PinnedProductPair } from "../../app/lib/ai-product-matching.ts";
import { screenedComparisonFromJudgeCheckpoints } from "../../app/lib/ai-product-matching.ts";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

class CompletedFactManifestConflict extends Error {}
class RecoverableProcessingIncompleteError extends Error {}
class EnrichmentCheckpointConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EnrichmentCheckpointConflictError";
  }
}

export const MAX_OPERATION_TIMEOUT_MS = 41 * 60 * 1000;
export const FINAL_ENRICHMENT_BATCH_SIZE = 64;
export const FINAL_ENRICHMENT_BATCH_CONCURRENCY = 3;
export const MAX_FINAL_ENRICHMENT_TARGETS = 7_000;
export const MAX_FINAL_ENRICHMENT_BATCHES = Math.ceil(MAX_FINAL_ENRICHMENT_TARGETS / FINAL_ENRICHMENT_BATCH_SIZE);
export const MAX_FINAL_ENRICHMENT_BATCH_WAVES = Math.ceil(MAX_FINAL_ENRICHMENT_TARGETS / FINAL_ENRICHMENT_BATCH_SIZE / FINAL_ENRICHMENT_BATCH_CONCURRENCY);
export const ENRICHMENT_PLAN_CHECKPOINT_BATCH_INDEX = 299;
export const ENRICHMENT_CHECKPOINT_BATCH_INDEX_BASE = 300;
export const PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX = 279;
export const CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE = 260;
export const CRAWL_RESULT_CHECKPOINT_BATCH_INDEX = 269;
export const TERMINAL_PRESENTATION_CHECKPOINT_BATCH_INDEX_BASE = 280;
export const MAX_ORCHESTRATION_TASK_ATTEMPTS = 10;
export const MATCH_JUDGE_CHECKPOINT_BATCH_INDEX_BASE = 1_400;
export const MAX_MATCH_JUDGE_CHECKPOINTS_PER_TASK_ATTEMPT = 250;

export function productEvidenceReferenceTimeMs(catalogs: Array<{ products: ProductRecord[] }>, reportCreatedAt: string, wallClockMs = Date.now()) {
  const fallback = Date.parse(reportCreatedAt);
  // The publication gate already permits an observation up to 24 hours after
  // its reference time. Never advance that reference beyond the production
  // wall clock or the two allowances would compose into a 48-hour window.
  let reference = Number.isFinite(fallback) ? Math.min(fallback, wallClockMs) : wallClockMs;
  for (const product of catalogs.flatMap((catalog) => catalog.products)) {
    const observedAt = Date.parse(product.observedAt);
    if (Number.isFinite(observedAt) && observedAt <= wallClockMs) reference = Math.max(reference, observedAt);
  }
  return reference;
}

function enrichmentPlanCheckpointIndex(taskAttemptNumber: number) {
  const index = ENRICHMENT_PLAN_CHECKPOINT_BATCH_INDEX - (taskAttemptNumber - 1);
  if (!Number.isInteger(taskAttemptNumber) || taskAttemptNumber < 1 || index < 290) throw new PermanentOrchestrationError("Unsupported enrichment task attempt.");
  return index;
}

function publishedResultCheckpointIndex(taskAttemptNumber: number) {
  const index = PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX - (taskAttemptNumber - 1);
  if (!Number.isInteger(taskAttemptNumber) || taskAttemptNumber < 1 || index < 270) throw new PermanentOrchestrationError("Unsupported published-result task attempt.");
  return index;
}

function terminalPresentationCheckpointIndex(taskAttemptNumber: number) {
  const index = TERMINAL_PRESENTATION_CHECKPOINT_BATCH_INDEX_BASE + (taskAttemptNumber - 1);
  if (!Number.isInteger(taskAttemptNumber) || taskAttemptNumber < 1 || index > 289) throw new PermanentOrchestrationError("Unsupported terminal-presentation task attempt.");
  return index;
}

function validTerminalPresentationCheckpoint(value: unknown, manifestHash: string, expectedTaskAttemptNumber?: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as { version?: unknown; taskAttemptNumber?: unknown; manifestHash?: unknown; status?: unknown; observedAt?: unknown; document?: unknown };
  if ((item.version !== 1 && item.version !== 2) || item.manifestHash !== manifestHash || (item.status !== "complete" && item.status !== "limited") || typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt)) || !item.document || typeof item.document !== "object" || Array.isArray(item.document)) return null;
  const nestedDocument = (item.document as { document?: unknown }).document;
  if (!nestedDocument || typeof nestedDocument !== "object" || Array.isArray(nestedDocument) || !Array.isArray((nestedDocument as { blocks?: unknown }).blocks)) return null;
  if (!(nestedDocument as { blocks: unknown[] }).blocks.every((block) => block && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string" && typeof (block as { id?: unknown }).id === "string")) return null;
  if (item.version === 2 && (!Number.isInteger(item.taskAttemptNumber) || item.taskAttemptNumber !== expectedTaskAttemptNumber)) return null;
  return { status: item.status, observedAt: new Date(item.observedAt).toISOString(), document: item.document } as const;
}

function primaryCatalogIdentity(products: ProductRecord[]) {
  return products.map(primaryRecoveryIdentity).sort((left, right) => left.id.localeCompare(right.id) || left.sourceUrl.localeCompare(right.sourceUrl));
}

function recoveryText(value: unknown, maxLength: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function primaryRecoveryIdentity(product: ProductRecord) {
  return {
    id: product.id,
    domain: canonicalDomain(product.domain),
    name: recoveryText(product.name, 220),
    normalizedName: product.normalizedName,
    category: recoveryText(product.category, 160),
    type: product.jsonLdType,
    description: recoveryText(product.description, 500),
    attributes: product.attributes.map((item) => recoveryText(item, 100)).filter(Boolean).slice(0, 8),
    sourceUrl: product.sourceUrl,
    observedIdentifiers: product.identifiers ? {
      gtins: product.identifiers.gtins,
      sku: product.identifiers.sku || "",
      mpn: product.identifiers.mpn || "",
      brand: product.identifiers.brand || "",
    } : null,
    canonicalQuantity: product.quantity || null,
  };
}

function primaryCatalogProductKeys(products: ProductRecord[]) {
  return new Set(products.map((product) => `${product.id}\n${canonicalDomain(product.domain)}`));
}

function primaryCatalogRecoveryIdentities(products: ProductRecord[]) {
  return new Map(products.map((product) => [
    `${product.id}\n${canonicalDomain(product.domain)}`,
    createHash("sha256").update(JSON.stringify(primaryRecoveryIdentity(product))).digest("hex"),
  ]));
}

function bindComparisonPrimaryRecoveryIdentities(comparison: ProductComparison | null, primaryProducts: ProductRecord[]) {
  if (!comparison) return null;
  const identities = primaryCatalogRecoveryIdentities(primaryProducts);
  return {
    ...comparison,
    rows: comparison.rows.map((row) => {
      const key = `${row.primary.id}\n${canonicalDomain(row.primary.domain)}`;
      const recoveryIdentityHash = identities.get(key);
      return recoveryIdentityHash ? { ...row, primary: { ...row.primary, recoveryIdentityHash } } : row;
    }),
  } satisfies ProductComparison;
}

function stableCheckpointValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCheckpointValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableCheckpointValue(item)]));
}

function checkpointEdgeIdentities(comparison: ProductComparison) {
  return comparison.rows.flatMap((row) => row.matches.flatMap((match) => match.product ? [JSON.stringify({
    primaryId: row.primary.id,
    primaryDomain: canonicalDomain(row.primary.domain),
    rivalDomain: canonicalDomain(match.product.domain),
    rivalId: match.product.id,
    sourceUrl: match.product.sourceUrl,
    assignmentComponentHash: match.product.assignmentComponentHash || "",
    gtins: [...(match.product.identifiers?.gtins || [])].sort(),
  })] : [])).sort();
}

export function validPublishedResultCheckpoint(value: unknown, resultTarget: number, referenceTimeMs: number, allowedPrimaryProductKeys: Set<string>, allowedPrimaryIdentities: Map<string, string>) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const checkpoint = value as { version?: unknown; comparison?: ProductComparison; evidence?: ProductComparison };
    if ((checkpoint.version !== 1 && checkpoint.version !== 2 && checkpoint.version !== 3) || !checkpoint.comparison || !Array.isArray(checkpoint.comparison.rows) || checkpoint.comparison.rows.length > resultTarget) return null;
    const evidence = checkpoint.version === 2 || checkpoint.version === 3 ? checkpoint.evidence : null;
    if ((checkpoint.version === 2 || checkpoint.version === 3) && (!evidence || !Array.isArray(evidence.rows) || evidence.rows.length > resultTarget)) return null;
    if (new Set(checkpoint.comparison.rows.map((row) => row?.primary?.id)).size !== checkpoint.comparison.rows.length) return null;
    if (evidence && new Set(evidence.rows.map((row) => row?.primary?.id)).size !== evidence.rows.length) return null;
    if (![...checkpoint.comparison.rows, ...(evidence?.rows || [])].every((row) => allowedPrimaryProductKeys.has(`${row.primary.id}\n${canonicalDomain(row.primary.domain)}`))) return null;
    if (![...checkpoint.comparison.rows, ...(evidence?.rows || [])].every((row) => {
      const key = `${row.primary.id}\n${canonicalDomain(row.primary.domain)}`;
      return allowedPrimaryIdentities.get(key) === row.primary.recoveryIdentityHash;
    })) return null;
    if (evidence && !evidence.rows.every((row) => row.matches.length > 0 && row.matches.every((match) => match.product && match.publication?.priceEligible === true))) return null;
    if (checkpoint.comparison.matching?.resultShortfallReason === "processing-incomplete") return null;
    if (checkpoint.comparison.enrichment?.pagesTruncated === true || (checkpoint.comparison.enrichment?.failedBatchCount || 0) > 0) return null;
    const comparisonForValidation = checkpoint.comparison.matching ? {
      ...checkpoint.comparison,
      matching: {
        ...checkpoint.comparison.matching,
        gaps: checkpoint.comparison.matching.gaps.filter((gap) => !/^Published \d+ of \d+ requested priced product comparisons/i.test(gap)),
      },
    } : checkpoint.comparison;
    const validated = limitPublishedProductComparison(publishPricedProductComparison(comparisonForValidation, referenceTimeMs), resultTarget);
    if (validated.matching?.resultShortfallReason === "processing-incomplete") return null;
    const revalidatedEvidence = evidence
      ? publishPricedProductComparison(evidence, referenceTimeMs)
      : mergePublishedProductComparisonState(validated, null, resultTarget, referenceTimeMs).evidence;
    if (JSON.stringify(checkpointEdgeIdentities(validated)) !== JSON.stringify(checkpointEdgeIdentities(checkpoint.comparison))) return null;
    if (evidence && JSON.stringify(checkpointEdgeIdentities(revalidatedEvidence)) !== JSON.stringify(checkpointEdgeIdentities(evidence))) return null;
    if (revalidatedEvidence.rows.some((row) => row.matches.some((match) => match.product && match.publication?.priceEligible !== true))) return null;
    return validated.rows.length === checkpoint.comparison.rows.length ? { comparison: validated, evidence: revalidatedEvidence } : null;
  } catch { return null; }
}

export function pricedResultEnrichmentBudget(resultTarget: number) {
  void resultTarget;
  return MAX_FINAL_ENRICHMENT_TARGETS;
}

function mergePublishedSelectionIntoScreenedComparison(screened: ProductComparison, published: ProductComparison) {
  const selected = new Map(published.rows.flatMap((row) => row.matches.flatMap((match) => match.product
    ? [[`${row.primary.id}\n${match.domain}\n${match.product.id}`, match] as const]
    : [])));
  return {
    ...screened,
    rows: screened.rows.map((row) => {
      return {
        ...row,
        matches: row.matches.map((match) => {
          const product = match.product || match.excludedProduct;
          if (!product) return match;
          const publishedMatch = selected.get(`${row.primary.id}\n${match.domain}\n${product.id}`);
          if (publishedMatch) return { ...match, publication: publishedMatch.publication };
          if (match.publication?.priceEligible !== true || !match.product) return match;
          return {
            ...match,
            excludedProduct: match.product,
            product: null,
            decision: null,
            publication: { priceEligible: false, reason: "outside-result-target" as const },
          };
        }),
      };
    }),
  } satisfies ProductComparison;
}

function mergeAccumulatedPublishedIntoScreenedComparison(screened: ProductComparison, accumulated: ProductComparison | null) {
  if (!accumulated) return screened;
  const accumulatedRows = new Map(accumulated.rows.map((row) => [row.primary.id, row]));
  const rows = screened.rows.map((row) => {
    const prior = accumulatedRows.get(row.primary.id);
    if (!prior) return row;
    accumulatedRows.delete(row.primary.id);
    const matchKey = (match: typeof row.matches[number]) => `${match.domain}\n${(match.product || match.excludedProduct)?.id || ""}`;
    const currentKeys = new Set(row.matches.map(matchKey));
    return { ...row, matches: [...row.matches, ...prior.matches.filter((match) => !currentKeys.has(matchKey(match)))] };
  });
  return { ...screened, rows: [...rows, ...accumulatedRows.values()] };
}

export function comparisonWithinPrimaryCatalog(comparison: ProductComparison | null, primaryProducts: ProductRecord[]) {
  if (!comparison) return null;
  const allowedPrimaryIdentities = primaryCatalogRecoveryIdentities(primaryProducts);
  const rows = comparison.rows.filter((row) => {
    const key = `${row.primary.id}\n${canonicalDomain(row.primary.domain)}`;
    const expected = allowedPrimaryIdentities.get(key);
    const observed = createHash("sha256").update(JSON.stringify(primaryRecoveryIdentity(row.primary))).digest("hex");
    return expected === observed;
  });
  return rows.length ? { ...comparison, rows } : null;
}

type EnrichmentResult = Awaited<ReturnType<ReportOrchestrationPort["enrich"]>>;

function isRetryableEnrichmentGap(gap: NonNullable<ProductComparison["enrichment"]>["gaps"][number]) {
  return gap.failureKind === "network"
    || gap.code === "robots_unreachable"
    || gap.httpStatus === 0
    || gap.httpStatus === 408
    || gap.httpStatus === 425
    || gap.httpStatus === 429
    || (typeof gap.httpStatus === "number" && gap.httpStatus >= 500);
}

function hasRetryableEnrichmentGap(result: EnrichmentResult) {
  return result.coverage.gaps.some(isRetryableEnrichmentGap);
}

function isTerminalEnrichmentRejection(gap: NonNullable<ProductComparison["enrichment"]>["gaps"][number]) {
  return gap.code === "identity_mismatch"
    || gap.failureKind === "identity"
    || gap.failureKind === "redirect"
    || gap.httpStatus === 404
    || gap.httpStatus === 410;
}

function isUnresolvedEnrichmentGap(gap: NonNullable<ProductComparison["enrichment"]>["gaps"][number]) {
  return !isTerminalEnrichmentRejection(gap);
}

function enrichmentOutcomeKey(value: { domain?: string; url?: string; productId?: string; id?: string }) {
  try {
    return `${canonicalDomain(value.domain || new URL(String(value.url || "")).hostname)}\n${String(value.productId || value.id || "")}`;
  } catch { return ""; }
}

function mergeEnrichmentRetry(previous: EnrichmentResult, retried: EnrichmentResult, batch: ProductEnrichmentTarget[]) {
  const retriedKeys = new Set(retried.products.map((product) => enrichmentOutcomeKey(product)));
  for (const gap of retried.coverage.gaps) retriedKeys.add(enrichmentOutcomeKey(gap));
  const products = [
    ...previous.products.filter((product) => !retriedKeys.has(enrichmentOutcomeKey(product))),
    ...retried.products,
  ];
  const gaps = [
    ...previous.coverage.gaps.filter((gap) => !retriedKeys.has(enrichmentOutcomeKey(gap))),
    ...retried.coverage.gaps,
  ];
  return {
    ok: true as const,
    products,
    coverage: {
      pagesRequested: batch.length,
      pagesFetched: products.length,
      maxPages: batch.length,
      gaps,
    },
  };
}

export function validEnrichmentCheckpoint(value: unknown, targets: ProductEnrichmentTarget[]): EnrichmentResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<EnrichmentResult>;
  if (candidate.ok !== true || !Array.isArray(candidate.products) || !candidate.coverage || typeof candidate.coverage !== "object") return null;
  if (candidate.products.length > FINAL_ENRICHMENT_BATCH_SIZE) return null;
  const targetByProduct = new Map(targets.map((target) => [`${canonicalDomain(target.domain)}\n${target.productId}`, target]));
  if (targetByProduct.size !== targets.length) return null;
  const comparablePath = (value: string) => {
    const url = new URL(value);
    return url.pathname.replace(/^\/[a-z]{2,3}-[a-z]{2}(?=\/)/i, "").replace(/\/+$/, "") || "/";
  };
  const comparableSearch = (value: string) => {
    const url = new URL(value);
    return [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  };
  const sourceMatchesTarget = (sourceUrl: string, target: ProductEnrichmentTarget) => {
    try {
      const source = new URL(sourceUrl);
      const requested = new URL(target.sourceUrl);
      if (canonicalDomain(source.hostname) !== canonicalDomain(target.domain) || canonicalDomain(requested.hostname) !== canonicalDomain(target.domain)) return false;
      const sourceMarket = publicSourceMarketContext(sourceUrl);
      const requestedMarket = publicSourceMarketContext(target.sourceUrl);
      if (sourceMarket.conflict || requestedMarket.conflict || (requestedMarket.countryCode && sourceMarket.countryCode !== requestedMarket.countryCode)) return false;
      if (JSON.stringify(comparableSearch(sourceUrl)) !== JSON.stringify(comparableSearch(target.sourceUrl))) return false;
      return target.allowCatalogReplacement === true || comparablePath(sourceUrl) === comparablePath(target.sourceUrl);
    } catch { return false; }
  };
  const validProduct = (product: unknown) => {
    if (!product || typeof product !== "object" || Array.isArray(product)) return false;
    const item = product as Partial<ProductRecord>;
    const domain = canonicalDomain(String(item.domain || ""));
    const target = targetByProduct.get(`${domain}\n${String(item.id || "")}`);
    return Boolean(target)
      && domain === canonicalDomain(target?.domain || "")
      && sourceMatchesTarget(String(item.sourceUrl || ""), target as ProductEnrichmentTarget)
      && typeof item.id === "string" && item.id.length > 0
      && typeof item.domain === "string" && item.domain.length > 0
      && typeof item.name === "string" && item.name.length > 0
      && typeof item.normalizedName === "string"
      && typeof item.sourceUrl === "string" && /^https?:\/\//i.test(item.sourceUrl)
      && typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt))
      && Array.isArray(item.priceSignals)
      && Array.isArray(item.attributes)
      && Array.isArray(item.claimIds);
  };
  if (!candidate.products.every(validProduct)) return null;
  const productKeys = new Set(candidate.products.map((product) => `${canonicalDomain(product.domain)}\n${product.id}`));
  if (productKeys.size !== candidate.products.length) return null;
  const coverage = candidate.coverage as Partial<NonNullable<ProductComparison["enrichment"]>>;
  const boundedCount = (count: unknown) => typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= FINAL_ENRICHMENT_BATCH_SIZE;
  if (coverage.pagesRequested !== targets.length
    || coverage.pagesFetched !== candidate.products.length
    || !boundedCount(coverage.pagesRequested)
    || !boundedCount(coverage.pagesFetched)
    || !boundedCount(coverage.maxPages)
    || (coverage.maxPages || 0) < targets.length
    || (coverage.pagesFetched || 0) > (coverage.pagesRequested || 0)
    || !Array.isArray(coverage.gaps)
    || coverage.gaps.length > FINAL_ENRICHMENT_BATCH_SIZE) return null;
  const gapKeys: string[] = [];
  if (!coverage.gaps.every((gap) => {
    if (!gap || typeof gap !== "object") return false;
    const record = gap as { productId?: unknown; url?: unknown };
    if (typeof record.url !== "string") return false;
    try {
      const key = `${canonicalDomain(new URL(record.url).hostname)}\n${String(record.productId || "")}`;
      const target = targetByProduct.get(key);
      if (!target || !sourceMatchesTarget(record.url, target)) return false;
      gapKeys.push(key);
      return true;
    } catch { return false; }
  })) return null;
  const uniqueGapKeys = new Set(gapKeys);
  if (uniqueGapKeys.size !== gapKeys.length || gapKeys.some((key) => productKeys.has(key))) return null;
  const represented = new Set([...productKeys, ...uniqueGapKeys]);
  if (represented.size !== targetByProduct.size || [...targetByProduct.keys()].some((key) => !represented.has(key))) return null;
  return candidate as EnrichmentResult;
}

function recoveredEnrichmentProducts(values: unknown[], comparison: ProductComparison) {
  const bases = comparison.rows.flatMap((row) => [
    { product: row.primary, role: "primary" as const },
    ...row.matches.flatMap((match) => match.product ? [{ product: match.product, role: "rival" as const }] : []),
  ]);
  const recovered = new Map<string, ProductRecord>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Partial<EnrichmentResult>).products)) continue;
    for (const product of (value as Partial<EnrichmentResult>).products || []) {
      if (!product || typeof product !== "object") continue;
      const base = bases.find((item) => canonicalDomain(item.product.domain) === canonicalDomain(product.domain) && item.product.id === product.id);
      if (!base) continue;
      const target: ProductEnrichmentTarget = { domain: base.product.domain, productId: base.product.id, sourceUrl: base.product.sourceUrl, expectedName: base.product.name, expectedType: base.product.jsonLdType, pairScore: 0, role: base.role };
      const single = validEnrichmentCheckpoint({ ok: true, products: [product], coverage: { pagesRequested: 1, pagesFetched: 1, maxPages: 1, gaps: [] } }, [target]);
      if (!single) continue;
      const key = `${canonicalDomain(product.domain)}\n${product.id}`;
      const previous = recovered.get(key);
      if (!previous || Date.parse(product.observedAt) > Date.parse(previous.observedAt)) recovered.set(key, product);
    }
  }
  return [...recovered.values()];
}

function enrichmentBatchHash(targets: unknown[]) {
  return createHash("sha256").update(JSON.stringify({ version: 2, targets })).digest("hex");
}

type EnrichmentPlanShape = { targets: ProductEnrichmentTarget[]; totalEligible: number; truncated: boolean };
type DurableEnrichmentPlanV1 = { version: 1; contentHash: string } & EnrichmentPlanShape;
type DurableEnrichmentPlanV2 = { version: 2; contentHash: string; targetHashes: string[]; totalEligible: number; truncated: boolean };
type DurableEnrichmentPlan = DurableEnrichmentPlanV1 | DurableEnrichmentPlanV2;

function enrichmentPlanContentHash(plan: EnrichmentPlanShape) {
  return createHash("sha256").update(JSON.stringify({ targets: plan.targets, totalEligible: plan.totalEligible, truncated: plan.truncated })).digest("hex");
}

function enrichmentTargetHash(target: ProductEnrichmentTarget) {
  return createHash("sha256").update(JSON.stringify(stableCheckpointValue(target))).digest("hex");
}

function compactEnrichmentPlan(plan: EnrichmentPlanShape): DurableEnrichmentPlanV2 {
  const targetHashes = plan.targets.map(enrichmentTargetHash);
  const compact = { targetHashes, totalEligible: plan.totalEligible, truncated: plan.truncated };
  return { version: 2, contentHash: createHash("sha256").update(JSON.stringify(compact)).digest("hex"), ...compact };
}

function enrichmentPlanInputHash(comparison: ProductComparison, maxPages: number) {
  const productIdentity = (product: ProductRecord) => ({
    id: product.id,
    domain: canonicalDomain(product.domain),
    name: product.normalizedName,
    type: product.jsonLdType,
    sourceUrl: product.sourceUrl,
    quantity: product.quantity || null,
  });
  const rows = comparison.rows.map((row) => ({
    primary: productIdentity(row.primary),
    matches: row.matches.flatMap((match) => match.product && match.confidence === "Medium"
      ? [{ domain: canonicalDomain(match.domain), product: productIdentity(match.product), verdict: match.assessment?.verdict || "" }]
      : []).sort((left, right) => left.domain.localeCompare(right.domain) || left.product.id.localeCompare(right.product.id)),
  })).sort((left, right) => left.primary.domain.localeCompare(right.primary.domain) || left.primary.id.localeCompare(right.primary.id));
  return createHash("sha256").update(JSON.stringify({ version: 2, maxPages, marketCountryCode: comparison.marketCountryCode || "", rows })).digest("hex");
}

function validEnrichmentPlanCheckpoint(value: unknown, expectedPlan: EnrichmentPlanShape): EnrichmentPlanShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Partial<DurableEnrichmentPlan>;
  if ((plan.version !== 1 && plan.version !== 2)
    || !/^[a-f0-9]{64}$/.test(String(plan.contentHash || ""))
    || !Number.isInteger(plan.totalEligible) || Number(plan.totalEligible) < expectedPlan.targets.length || Number(plan.totalEligible) > MAX_FINAL_ENRICHMENT_TARGETS * 2
    || typeof plan.truncated !== "boolean"
    || plan.truncated !== (Number(plan.totalEligible) > expectedPlan.targets.length)) return null;
  if (plan.version === 2) {
    const compact = plan as Partial<DurableEnrichmentPlanV2>;
    if (!Array.isArray(compact.targetHashes) || compact.targetHashes.length !== expectedPlan.targets.length || compact.targetHashes.length > MAX_FINAL_ENRICHMENT_TARGETS
      || compact.targetHashes.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash || "")))
      || JSON.stringify(compact.targetHashes) !== JSON.stringify(expectedPlan.targets.map(enrichmentTargetHash))) return null;
    const hashValue = { targetHashes: compact.targetHashes, totalEligible: Number(plan.totalEligible), truncated: plan.truncated };
    if (plan.contentHash !== createHash("sha256").update(JSON.stringify(hashValue)).digest("hex")) return null;
    return { targets: expectedPlan.targets, totalEligible: Number(plan.totalEligible), truncated: plan.truncated };
  }
  const legacy = plan as Partial<DurableEnrichmentPlanV1>;
  if (!Array.isArray(legacy.targets) || legacy.targets.length > MAX_FINAL_ENRICHMENT_TARGETS || JSON.stringify(stableCheckpointValue(legacy.targets)) !== JSON.stringify(stableCheckpointValue(expectedPlan.targets))) return null;
  const seen = new Set<string>();
  for (const target of legacy.targets) {
    if (!target || typeof target !== "object" || (target.role !== "primary" && target.role !== "rival") || typeof target.productId !== "string" || !target.productId) return null;
    try {
      const source = new URL(target.sourceUrl);
      const domain = canonicalDomain(target.domain);
      if (!domain || canonicalDomain(source.hostname) !== domain || !/^https:$/.test(source.protocol) || source.username || source.password) return null;
      const key = `${domain}\n${target.productId}\n${target.sourceUrl}`;
      if (seen.has(key)) return null;
      seen.add(key);
    } catch { return null; }
  }
  const complete = { targets: legacy.targets, totalEligible: Number(plan.totalEligible), truncated: plan.truncated };
  if (plan.contentHash !== enrichmentPlanContentHash(complete)) return null;
  return complete;
}

type RunStatus = "queued" | "running" | "complete" | "limited" | "failed" | "interrupted";
type ReportEvent = { idempotencyKey: string; phase: string; status: RunStatus; message: string; metadata?: Record<string, unknown> };
type StoredReport = {
  run: { publicId: string; primaryDomain: string; locale: "en" | "ar"; status: RunStatus; attemptCount: number; createdAt: string; updatedAt: string; productPlan?: "starter" | "solo" | "growth" | "agency"; productLimit?: number };
  events: Array<{ idempotencyKey?: string; phase: string; status: RunStatus; metadata?: Record<string, unknown> }>;
  factManifest?: { manifestId: string; attemptNumber: number; manifestHash: string; counts: Record<"companies" | "products" | "matches" | "ads", number>; status: string; completedAt: string } | null;
};
type JsonBlock = { type: string; id: string } & Record<string, unknown>;
type JsonDocument = { blocks: JsonBlock[] } & Record<string, unknown>;
type CrawlResult = { domain: string; homepage?: unknown; products: ProductRecord[]; role?: string; fetchedAt?: string; discovery?: { verificationScore?: number; category?: string; region?: string; sourceIds?: string[]; reason?: string; source?: string } };
type DiscoveryCoverage = { eligibleAnchors?: number; anchorSetHash?: string; searchedAnchors?: number; startIndex?: number; endIndex?: number; truncated?: boolean; searchesComplete?: boolean; candidateDomainsFound?: number; candidateDomainsInvestigated?: number; candidateTruncated?: boolean; verificationComplete?: boolean; batchComplete?: boolean; complete?: boolean };
type CrawlSuccess = { ok: true; primaryDomain: string; results: CrawlResult[]; discovery?: { productSearchCoverage?: DiscoveryCoverage }; adRequest: unknown; matchHints?: PinnedProductPair[]; document: JsonDocument };
type ParkedDomainOutcome = { ok: false; code: "parked-domain"; primaryDomain: string; error: string; document: JsonDocument };
type UnavailableDomainOutcome = { ok: false; code: "unavailable-domain"; primaryDomain: string; error: string; document: JsonDocument };
type CrawlOutcome = CrawlSuccess | ParkedDomainOutcome | UnavailableDomainOutcome;

const MAX_CRAWL_CHECKPOINT_UNCOMPRESSED_BYTES = 16 * 1_024 * 1_024;
const MAX_CRAWL_CHECKPOINT_RECOVERY_CANDIDATES = 2;

class CrawlCheckpointProjectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CrawlCheckpointProjectionError";
  }
}

class CrawlCheckpointConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CrawlCheckpointConflictError";
  }
}

function checkpointText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function checkpointProduct(product: ProductRecord): ProductRecord {
  return {
    id: product.id,
    domain: product.domain,
    name: product.name,
    normalizedName: product.normalizedName,
    description: product.description,
    category: product.category,
    jsonLdType: product.jsonLdType,
    priceSignals: product.priceSignals,
    attributes: product.attributes,
    ownership: product.ownership,
    extraction: product.extraction,
    confidence: product.confidence,
    sourceUrl: product.sourceUrl,
    imageUrl: product.imageUrl,
    observedAt: product.observedAt,
    claimIds: product.claimIds,
    ...(product.aliases ? { aliases: product.aliases } : {}),
    ...(product.identifiers ? { identifiers: product.identifiers } : {}),
    ...(product.quantity ? { quantity: product.quantity } : {}),
    ...(product.recoveryIdentityHash ? { recoveryIdentityHash: product.recoveryIdentityHash } : {}),
    ...(product.assignmentComponentHash ? { assignmentComponentHash: product.assignmentComponentHash } : {}),
  };
}

function checkpointDiscovery(value: CrawlResult["discovery"]): CrawlResult["discovery"] {
  if (!value) return undefined;
  return {
    ...(typeof value.verificationScore === "number" ? { verificationScore: value.verificationScore } : {}),
    ...(value.category ? { category: checkpointText(value.category, 240) } : {}),
    ...(value.region ? { region: checkpointText(value.region, 120) } : {}),
    ...(value.sourceIds ? { sourceIds: value.sourceIds.slice(0, 20).map((item) => checkpointText(item, 160)).filter(Boolean) } : {}),
    ...(value.reason ? { reason: checkpointText(value.reason, 1_000) } : {}),
    ...(value.source ? { source: checkpointText(value.source, 80) } : {}),
  };
}

function checkpointHomepage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries([
    "domain", "sourceUrl", "observedAt", "companyName", "title", "description",
    "region", "regionCountryCode", "category", "status", "verificationScore",
  ].flatMap((key) => source[key] === undefined ? [] : [[key, typeof source[key] === "string" ? checkpointText(source[key], key === "description" ? 1_000 : 500) : source[key]]]));
}

function crawlCheckpointSnapshot(crawl: CrawlSuccess): CrawlSuccess {
  const presentation = compactTerminalReportDocument({ primaryDomain: crawl.primaryDomain, document: ensureDocument(crawl.document), marketBrief: null }, 650_000, { factsAuthoritative: false, factCounts: null }) as { document: JsonDocument };
  const baseline = ensureDocument(crawl.document).blocks.find((block) => block.type === "product-comparison");
  const document = baseline
    ? { ...presentation.document, blocks: [...presentation.document.blocks.filter((block) => block.type !== "product-comparison"), baseline] }
    : presentation.document;
  return {
    ok: true,
    primaryDomain: crawl.primaryDomain,
    results: crawl.results.map((result) => ({
      domain: result.domain,
      homepage: checkpointHomepage(result.homepage),
      products: result.products.map(checkpointProduct),
      ...(result.role ? { role: result.role } : {}),
      ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
      ...(result.discovery ? { discovery: checkpointDiscovery(result.discovery) } : {}),
    })),
    ...(crawl.discovery?.productSearchCoverage ? { discovery: { productSearchCoverage: crawl.discovery.productSearchCoverage } } : {}),
    adRequest: crawl.adRequest,
    ...(crawl.matchHints ? { matchHints: crawl.matchHints } : {}),
    document,
  };
}

function crawlCheckpointBatchIndex(taskAttemptNumber: number) {
  if (!Number.isInteger(taskAttemptNumber) || taskAttemptNumber < 1 || taskAttemptNumber > MAX_ORCHESTRATION_TASK_ATTEMPTS) throw new PermanentOrchestrationError("Unsupported crawl task attempt.");
  return CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + taskAttemptNumber - 1;
}

function crawlCheckpointInputHash(payload: ReportOrchestrationPayload, taskAttemptNumber: number) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    publicId: payload.publicId,
    primaryDomain: payload.primaryDomain,
    reportAttempt: payload.reportAttempt,
    productPlan: payload.productPlan,
    productLimit: payload.productLimit,
    taskAttemptNumber,
  })).digest("hex");
}

function crawlCheckpoint(crawl: CrawlSuccess) {
  try {
    const json = JSON.stringify(crawlCheckpointSnapshot(crawl));
    if (Buffer.byteLength(json, "utf8") > MAX_CRAWL_CHECKPOINT_UNCOMPRESSED_BYTES) throw new CrawlCheckpointProjectionError("The successful crawl checkpoint exceeds the durable uncompressed checkpoint budget.");
    const checkpoint = { version: 1, encoding: "gzip-base64", data: gzipSync(json, { level: 9 }).toString("base64") };
    if (encodedJsonBytes(checkpoint) <= REPORT_MATCH_CHECKPOINT_RESULT_BYTES) return checkpoint;
    throw new CrawlCheckpointProjectionError("The successful crawl checkpoint exceeds the durable checkpoint budget after lossless matching-state projection.");
  } catch (error) {
    if (error instanceof CrawlCheckpointProjectionError) throw error;
    throw new CrawlCheckpointProjectionError("The successful crawl could not be projected into a durable checkpoint.", { cause: error });
  }
}

function validCrawlSuccess(value: unknown, payload: ReportOrchestrationPayload): CrawlSuccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const crawl = value as Partial<CrawlSuccess>;
  try {
    if (crawl.ok !== true || crawl.primaryDomain !== payload.primaryDomain || !Array.isArray(crawl.results) || !crawl.results.length) return null;
    if (!crawl.document || typeof crawl.document !== "object" || Array.isArray(crawl.document) || !Array.isArray((crawl.document as JsonDocument).blocks)) return null;
    const primary = crawl.results.find((result) => result?.domain === payload.primaryDomain && result?.homepage && Array.isArray(result?.products));
    if (!primary) return null;
    for (const result of crawl.results) {
      if (!result || canonicalDomain(String(result.domain || "")) !== result.domain || !Array.isArray(result.products)) return null;
    }
    return crawl as CrawlSuccess;
  } catch {
    return null;
  }
}

function validCrawlCheckpoint(value: unknown, payload: ReportOrchestrationPayload): CrawlSuccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as { version?: unknown; encoding?: unknown; data?: unknown };
  if (checkpoint.version !== 1 || checkpoint.encoding !== "gzip-base64" || typeof checkpoint.data !== "string" || !checkpoint.data) return null;
  try {
    const json = gunzipSync(Buffer.from(checkpoint.data, "base64"), { maxOutputLength: MAX_CRAWL_CHECKPOINT_UNCOMPRESSED_BYTES }).toString("utf8");
    return validCrawlSuccess(JSON.parse(json), payload);
  } catch {
    return null;
  }
}

export type ReportAttemptContext = { attemptNumber: number; taskAttemptNumber?: number; isFinalAttempt: boolean };

export interface ReportOrchestrationPort {
  preflight(): Promise<void>;
  loadReport(publicId: string): Promise<StoredReport | null>;
  appendEvent(publicId: string, event: ReportEvent & { attemptNumber?: number }): Promise<void>;
  crawl(input: { primary: string; domains: string[]; productLimit: number; catalogProductLimit: number; discoverySearchOffset: number; discoveryPriorCoverageComplete: boolean; discoveryExpectedAnchorSetHash: string }): Promise<CrawlOutcome>;
  brief(input: { primary: string; domains: string[] }): Promise<unknown>;
  ads(input: unknown): Promise<{ ok: true; block: JsonBlock }>;
  match(input: { publicId: string; reportAttempt: number; taskAttemptNumber: number; reportObservedAt: string; primaryDomain: string; marketCountryCode?: string; productLimit: number; catalogs: Array<{ domain: string; products: ProductRecord[] }>; pinnedPairs?: PinnedProductPair[] }): Promise<{ ok: true; comparison: ProductComparison }>;
  enrich(input: { targets: unknown[] }): Promise<{ ok: true; products: ProductRecord[]; coverage: NonNullable<ProductComparison["enrichment"]> }>;
  loadCheckpoint(publicId: string, input: { attemptNumber: number; batchIndex?: number; batchIndexStart?: number; batchIndexEnd?: number; latestPerBatch?: boolean; limit?: number }): Promise<Array<{ attemptNumber: number; batchIndex: number; inputHash: string; result: unknown }>>;
  saveCheckpoint(publicId: string, input: { attemptNumber: number; batchIndex: number; inputHash: string; result: unknown }): Promise<void>;
  actions(input: { inputs: ProductActionInput[] }): Promise<{ ok: true; result: ProductActionPlanningResult }>;
  persistFactChunk(publicId: string, input: ReportFactChunkInput): Promise<void>;
  finalizeFactManifest(publicId: string, input: ReportFactManifestInput): Promise<void>;
  saveDocument(publicId: string, input: { attemptNumber?: number; status: "complete" | "limited"; observedAt: string; expectedFactManifestHash: string; document: unknown }): Promise<void>;
}

const MAX_PRIMARY_CATALOG_PRODUCTS = 1_000;

function completedDiscoveryCursor(events: StoredReport["events"], reportAttempt: number, repeatLatest = false) {
  const adoptedAttempts = new Set([reportAttempt]);
  let cursorAttempt = reportAttempt;
  for (;;) {
    const recovery = events.find((item) => item.idempotencyKey === `recovery-attempt-${cursorAttempt}`);
    const adoptedAttempt = Number(recovery?.metadata?.adoptedAttempt);
    if (!Number.isInteger(adoptedAttempt) || adoptedAttempt < 1 || adoptedAttempt >= cursorAttempt || adoptedAttempts.has(adoptedAttempt)) break;
    adoptedAttempts.add(adoptedAttempt);
    cursorAttempt = adoptedAttempt;
  }
  const batches = events.flatMap((item, eventIndex) => {
    if (![...adoptedAttempts].some((attemptNumber) => item.idempotencyKey?.startsWith(`report-${attemptNumber}-task-`))) return [];
    const metadata = item.metadata;
    const startIndex = Number(metadata?.discoveryStartIndex);
    const endIndex = Number(metadata?.discoveryEndIndex);
    const anchorSetHash = typeof metadata?.discoveryAnchorSetHash === "string" && /^[a-f0-9]{64}$/.test(metadata.discoveryAnchorSetHash) ? metadata.discoveryAnchorSetHash : "";
    return metadata?.discoveryBatchComplete === true && anchorSetHash && Number.isInteger(startIndex) && Number.isInteger(endIndex) && startIndex >= 0 && endIndex > startIndex
      ? [{ startIndex, endIndex, anchorSetHash, eventIndex }]
      : [];
  });
  let cursor = 0;
  let anchorSetHash = "";
  let latestStart = 0;
  for (;;) {
    const next = batches.filter((batch) => batch.startIndex === cursor && (!anchorSetHash || batch.anchorSetHash === anchorSetHash)).sort((left, right) => right.endIndex - left.endIndex || right.eventIndex - left.eventIndex)[0];
    if (!next) return { offset: repeatLatest && cursor > 0 ? latestStart : cursor, anchorSetHash };
    anchorSetHash = next.anchorSetHash;
    latestStart = next.startIndex;
    cursor = next.endIndex;
  }
}

function progressEventKey(attempt: ReportAttemptContext, key: string) {
  return `report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-${key}`;
}

function event(idempotencyKey: string, phase: string, message: string, metadata?: Record<string, unknown>): ReportEvent {
  return { idempotencyKey, phase, status: "running", message, ...(metadata ? { metadata } : {}) };
}

function limitedEvent(idempotencyKey: string, phase: string, message: string, metadata?: Record<string, unknown>): ReportEvent {
  return { idempotencyKey, phase, status: "limited", message, ...(metadata ? { metadata } : {}) };
}

function phasesFromStored(report: StoredReport) {
  return [...new Set(report.events.flatMap((item) => item.idempotencyKey === "report-saved" ? ["persistence"] : /-complete$/.test(item.idempotencyKey || "") ? [item.phase] : []).filter(Boolean))];
}

function limitedPhasesFromStored(report: StoredReport) {
  return [...new Set(report.events.filter((item) => /-limited$/.test(item.idempotencyKey || "")).map((item) => item.phase).filter(Boolean))];
}

function replaySummary(report: StoredReport, now: () => Date): ReportOrchestrationSummary {
  const finishedAt = report.run.updatedAt || now().toISOString();
  return {
    ok: true,
    contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION,
    publicId: report.run.publicId,
    reportStatus: report.run.status as "complete" | "limited",
    completedPhases: phasesFromStored(report),
    limitedPhases: limitedPhasesFromStored(report),
    startedAt: report.run.createdAt,
    finishedAt,
  };
}

function ensureDocument(value: unknown): JsonDocument {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as JsonDocument).blocks)) {
    throw new Error("The crawl did not return a report document.");
  }
  return value as JsonDocument;
}

function replaceBlock(document: JsonDocument, block: JsonBlock) {
  return { ...document, blocks: [...document.blocks.filter((item) => item.type !== block.type), block] };
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function boundedErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("errorCode" in error)) return "";
  return String((error as { errorCode?: unknown }).errorCode || "").replace(/[^a-z0-9-]/gi, "").slice(0, 80);
}

export async function orchestrateReport(
  rawPayload: unknown,
  attempt: ReportAttemptContext,
  port: ReportOrchestrationPort,
  now: () => Date = () => new Date(),
): Promise<ReportOrchestrationSummary> {
  const payload: ReportOrchestrationPayload = parseReportOrchestrationPayload(rawPayload);
  if (payload.reportAttempt !== attempt.attemptNumber) throw new PermanentOrchestrationError("Dispatch payload attempt does not match the active report attempt.");
  const stored = await port.loadReport(payload.publicId);
  if (!stored) throw new PermanentOrchestrationError("Stored report was not found.");
  if (stored.run.primaryDomain !== payload.primaryDomain || stored.run.locale !== payload.locale) {
    throw new PermanentOrchestrationError("Stored report identity does not match the orchestration payload.");
  }
  if (stored.run.attemptCount !== attempt.attemptNumber) throw new PermanentOrchestrationError("Stored report attempt does not match the active worker attempt.");
  if ((stored.run.productPlan || "starter") !== payload.productPlan || (stored.run.productLimit || 20) !== payload.productLimit) {
    throw new PermanentOrchestrationError("Stored report entitlement does not match the orchestration payload.");
  }
  if (stored.run.status === "complete" || stored.run.status === "limited") return replaySummary(stored, now);
  if (stored.run.status === "failed" || stored.run.status === "interrupted") throw new PermanentOrchestrationError(`Stored report is already ${stored.run.status}.`);
  const workerPort = port;
  port = {
    ...workerPort,
    appendEvent: (publicId, reportEvent) => workerPort.appendEvent(publicId, { ...reportEvent, attemptNumber: attempt.attemptNumber }),
    saveDocument: (publicId, input) => workerPort.saveDocument(publicId, { ...input, attemptNumber: attempt.attemptNumber }),
  };
  await port.preflight();

  let legacyCompletedManifestWithoutPresentation = false;
  if (stored.factManifest?.status === "complete") {
    const checkpoints = await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndexStart: TERMINAL_PRESENTATION_CHECKPOINT_BATCH_INDEX_BASE, batchIndexEnd: 289, latestPerBatch: true });
    const presentationCandidates = checkpoints
      .filter((checkpoint) => checkpoint.batchIndex >= TERMINAL_PRESENTATION_CHECKPOINT_BATCH_INDEX_BASE && checkpoint.batchIndex <= 289)
      .sort((left, right) => right.attemptNumber - left.attemptNumber || right.batchIndex - left.batchIndex)
      .map((checkpoint) => ({
        version: Number((checkpoint.result as { version?: unknown })?.version),
        presentation: checkpoint.inputHash === createHash("sha256").update(JSON.stringify(checkpoint.result)).digest("hex")
          ? validTerminalPresentationCheckpoint(checkpoint.result, stored.factManifest!.manifestHash, checkpoint.batchIndex - TERMINAL_PRESENTATION_CHECKPOINT_BATCH_INDEX_BASE + 1)
          : null,
      }))
      .filter((candidate) => candidate.presentation !== null);
    const presentation = (presentationCandidates.find((candidate) => candidate.version === 2) || presentationCandidates.find((candidate) => candidate.version === 1))?.presentation || null;
    if (presentation) {
      await port.saveDocument(payload.publicId, {
        status: presentation.status,
        observedAt: presentation.observedAt,
        expectedFactManifestHash: stored.factManifest.manifestHash,
        document: presentation.document,
      });
      const finishedAt = now().toISOString();
      return { ok: true, contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION, publicId: payload.publicId, reportStatus: presentation.status, completedPhases: ["persistence"], limitedPhases: presentation.status === "limited" ? ["matching"] : [], startedAt: stored.run.createdAt, finishedAt };
    }
    // Compatibility for manifests completed before terminal-presentation
    // checkpoints existed: repeat the last completed discovery wave rather than
    // advancing into different evidence.
    legacyCompletedManifestWithoutPresentation = true;
  }

  let terminalFailureRecorded = false;
  try {
  const startedAt = now().toISOString();
  const completedPhases: string[] = [];
  const limitedPhases: string[] = [];
  let crawl: CrawlOutcome;
  const taskAttemptNumber = attempt.taskAttemptNumber || 1;
  let priorDurableCrawl: { taskAttemptNumber: number; crawl: CrawlSuccess } | null = null;
  let crawlCheckpointCandidates = 0;
  for (let batchIndex = crawlCheckpointBatchIndex(taskAttemptNumber); batchIndex >= CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE && crawlCheckpointCandidates < MAX_CRAWL_CHECKPOINT_RECOVERY_CANDIDATES; batchIndex -= 1) {
    const [checkpoint] = await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndexStart: batchIndex, batchIndexEnd: batchIndex, latestPerBatch: true, limit: 1 });
    if (!checkpoint) continue;
    crawlCheckpointCandidates += 1;
    const checkpointTaskAttempt = checkpoint.batchIndex - CRAWL_RESULT_CHECKPOINT_BATCH_INDEX_BASE + 1;
    const expectedInputHash = checkpointTaskAttempt >= 1 && checkpointTaskAttempt <= taskAttemptNumber
      ? crawlCheckpointInputHash(payload, checkpointTaskAttempt)
      : "";
    if (!expectedInputHash || checkpoint.inputHash !== expectedInputHash) {
      if (checkpoint.attemptNumber === attempt.attemptNumber) throw new CrawlCheckpointConflictError("The active report attempt contains a conflicting crawl checkpoint.");
      continue;
    }
    const value = validCrawlCheckpoint(checkpoint.result, payload);
    if (!value) {
      if (checkpoint.attemptNumber === attempt.attemptNumber) throw new CrawlCheckpointConflictError("The active report attempt contains an invalid crawl checkpoint.");
      continue;
    }
    priorDurableCrawl = { taskAttemptNumber: checkpointTaskAttempt, crawl: value };
    break;
  }
  const priorCoverageComplete = priorDurableCrawl?.crawl.discovery?.productSearchCoverage?.complete === true;
  const shouldRefreshCrawl = !priorDurableCrawl || (!priorCoverageComplete && priorDurableCrawl.taskAttemptNumber < taskAttemptNumber);
  if (!shouldRefreshCrawl && priorDurableCrawl) {
    crawl = priorDurableCrawl.crawl;
    await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "crawl-resumed"), "crawl", "Resuming from the durable successful crawl; collected public facts were not fetched or replaced again.", {
      primaryProducts: priorDurableCrawl.crawl.results.find((result) => result.domain === priorDurableCrawl.crawl.primaryDomain)?.products.length || 0,
      taskAttempt: taskAttemptNumber,
    }));
  } else {
    await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "crawl-started"), "crawl", "Crawling the submitted website and collecting public product pages."));
    try {
      const discoveryCursor = completedDiscoveryCursor(stored.events, attempt.attemptNumber, legacyCompletedManifestWithoutPresentation);
      const freshCrawl = await port.crawl({ primary: payload.primaryDomain, domains: [payload.primaryDomain], productLimit: payload.productLimit, catalogProductLimit: MAX_PRIMARY_CATALOG_PRODUCTS, discoverySearchOffset: discoveryCursor.offset, discoveryPriorCoverageComplete: true, discoveryExpectedAnchorSetHash: discoveryCursor.anchorSetHash });
      if (!freshCrawl || (freshCrawl.ok !== true && freshCrawl.code !== "parked-domain" && freshCrawl.code !== "unavailable-domain")) throw new Error("The public crawl could not be completed.");
      const validatedFreshCrawl = freshCrawl.ok === true ? validCrawlSuccess(freshCrawl, payload) : null;
      if (freshCrawl.ok === true && !validatedFreshCrawl) throw new Error("The successful crawl did not contain a valid primary result.");
      crawl = validatedFreshCrawl || freshCrawl;
      if (validatedFreshCrawl) {
        const checkpoint = crawlCheckpoint(validatedFreshCrawl);
        const crawlInputHash = crawlCheckpointInputHash(payload, taskAttemptNumber);
        const checkpointBatchIndex = crawlCheckpointBatchIndex(taskAttemptNumber);
        try {
          await port.saveCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: checkpointBatchIndex, inputHash: crawlInputHash, result: checkpoint });
        } catch (saveError) {
          let committed: Awaited<ReturnType<ReportOrchestrationPort["loadCheckpoint"]>>[number] | undefined;
          try {
            committed = (await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: checkpointBatchIndex, limit: 1 }))[0];
          } catch (confirmationError) {
            throw new CrawlCheckpointConflictError(message(saveError, "The crawl checkpoint save could not be confirmed."), { cause: confirmationError });
          }
          const exactCommittedResult = committed?.attemptNumber === attempt.attemptNumber
            && committed.inputHash === crawlInputHash
            && JSON.stringify(stableCheckpointValue(committed.result)) === JSON.stringify(stableCheckpointValue(checkpoint));
          const committedCrawl = exactCommittedResult ? validCrawlCheckpoint(committed!.result, payload) : null;
          if (!committedCrawl) throw new CrawlCheckpointConflictError(message(saveError, "The crawl checkpoint save could not be confirmed."), { cause: saveError });
          crawl = validatedFreshCrawl;
        }
      } else if (priorDurableCrawl) {
        crawl = priorDurableCrawl.crawl;
        await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "crawl-resumed"), "crawl", "The next discovery wave was unavailable, so processing resumed from the last durable successful crawl.", { taskAttempt: taskAttemptNumber }));
      }
    } catch (error) {
      if (error instanceof CrawlCheckpointProjectionError || error instanceof CrawlCheckpointConflictError) throw error;
      if (priorDurableCrawl) {
        crawl = priorDurableCrawl.crawl;
        await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "crawl-resumed"), "crawl", "The next discovery wave failed, so processing resumed from the last durable successful crawl.", { taskAttempt: taskAttemptNumber, reason: message(error, "Discovery wave unavailable.") }));
      } else {
      const detail = message(error, "The public crawl could not be completed.");
      const errorCode = boundedErrorCode(error);
      await port.appendEvent(payload.publicId, attempt.isFinalAttempt
        ? { idempotencyKey: "crawl-failed", phase: "failed", status: "failed", message: detail, metadata: { attempt: attempt.attemptNumber }, ...(errorCode ? { errorCode } : {}) }
        : event(`crawl-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-failed`, "crawl", "The crawl attempt failed and is eligible for one bounded retry.", { reportAttempt: attempt.attemptNumber, taskAttempt: attempt.taskAttemptNumber || 1 }));
      terminalFailureRecorded = attempt.isFinalAttempt;
      throw error;
      }
    }
  }

  if (crawl.ok === false) {
    const document = ensureDocument(crawl.document);
    const unavailable = crawl.code === "unavailable-domain";
    const domainStatus = document.blocks.find((block) => block.type === "domain-status" && block.status === (unavailable ? "unavailable" : "parked"));
    const targetUrl = typeof domainStatus?.attemptedUrl === "string" ? domainStatus.attemptedUrl : typeof domainStatus?.evidenceUrl === "string" ? domainStatus.evidenceUrl : "";
    const reason = crawl.error || (unavailable ? `${payload.primaryDomain} did not return a public network response.` : `${payload.primaryDomain} is parked, so market analysis could not run.`);
    await port.appendEvent(payload.publicId, limitedEvent("crawl-limited", "crawl", unavailable ? "The submitted domain did not return a public network response after bounded attempts, so the company crawl ended with a visible limitation." : "The submitted domain is parked, so the company crawl ended with a source-linked limitation.", unavailable ? { reason, targetUrl, attemptedUrl: targetUrl } : { reason, targetUrl, evidenceUrl: targetUrl }));
    await port.appendEvent(payload.publicId, limitedEvent("ads-limited", "ads", "Ad-library checks did not run because the primary crawl was terminally limited.", { upstream: "crawl", reason }));
    await port.appendEvent(payload.publicId, limitedEvent("matching-limited", "matching", "Product matching did not run because the primary crawl was terminally limited.", { upstream: "crawl", reason }));
    const finishedAt = now().toISOString();
    await port.saveDocument(payload.publicId, {
      status: "limited",
      observedAt: finishedAt,
      expectedFactManifestHash: "",
      document: compactTerminalReportDocument({ primaryDomain: crawl.primaryDomain, document, marketBrief: null }, undefined, { factsAuthoritative: false, factCounts: null }),
    });
    return {
      ok: true,
      contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION,
      publicId: payload.publicId,
      reportStatus: "limited",
      completedPhases: ["persistence"],
      limitedPhases: ["crawl", "ads", "matching"],
      startedAt,
      finishedAt,
    };
  }

  const primary = crawl.results.find((result) => result.domain === crawl.primaryDomain && result.homepage);
  if (!primary) {
    const error = new Error(`Primary domain ${payload.primaryDomain} did not return a live crawl result.`);
    await port.appendEvent(payload.publicId, attempt.isFinalAttempt
      ? { idempotencyKey: "crawl-failed", phase: "failed", status: "failed", message: error.message, metadata: { attempt: attempt.attemptNumber } }
      : event(`crawl-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-failed`, "crawl", "The primary crawl result was unavailable and is eligible for one bounded retry.", { reportAttempt: attempt.attemptNumber, taskAttempt: attempt.taskAttemptNumber || 1 }));
    terminalFailureRecorded = attempt.isFinalAttempt;
    throw error;
  }
  completedPhases.push("crawl");
  await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "crawl-complete"), "competitors", "The primary catalog was collected and competitor websites were verified.", {
    primaryProducts: primary.products.length,
    verifiedCompetitors: crawl.results.filter((result) => result.role === "discovered-competitor" && result.homepage && (result.discovery?.verificationScore || 0) >= 55).length,
    discoveryStartIndex: crawl.discovery?.productSearchCoverage?.startIndex || 0,
    discoveryEndIndex: crawl.discovery?.productSearchCoverage?.endIndex || 0,
    discoveryBatchComplete: crawl.discovery?.productSearchCoverage?.batchComplete === true,
    discoveryAnchorSetHash: crawl.discovery?.productSearchCoverage?.anchorSetHash || "",
  }));

  let document = ensureDocument(crawl.document);
  let comparison: ProductComparison | null = null;
  let screenedComparison: ProductComparison | null = null;
  let adBlock: JsonBlock | null = null;

  const adsWork = (async () => {
    await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "ads-started"), "ads", "Checking attributable public advertiser records for the verified companies."));
    try {
      const result = await port.ads(crawl.adRequest);
      if (!result?.ok || !result.block) throw new Error("The public ad-library scan was unavailable.");
      adBlock = result.block;
      document = replaceBlock(document, result.block);
      completedPhases.push("ads");
      await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "ads-complete"), "ads", "The public ad-library phase finished with explicit advertiser coverage states."));
    } catch (error) {
      limitedPhases.push("ads");
      await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "ads-limited"), "ads", "Advertiser coverage is limited and no ad activity was invented.", { reason: message(error, "Ad scan unavailable.") }));
    }
  })();

  const matchWork = (async () => {
    await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "matching-started"), "matching", "Comparing the strongest product families across the synchronized catalogs."));
    if (!primary.products.length) {
      limitedPhases.push("matching");
      await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "matching-limited"), "matching", "No attributable primary product pages were found, so semantic matching could not run."));
      return;
    }
    const baselineBlock = document.blocks.find((block) => block.type === "product-comparison");
    const baseline = baselineBlock ? baselineBlock as unknown as ProductComparison : null;
    const catalogs = crawl.results.map((result) => ({ domain: result.domain, products: result.products }));
    const attempts: ProductComparison[] = [];
    const primaryHomepage = primary.homepage as { regionCountryCode?: unknown };
    const marketCountryCode = /^[A-Z]{2}$/.test(String(primaryHomepage.regionCountryCode || "").toUpperCase())
      ? String(primaryHomepage.regionCountryCode).toUpperCase()
      : "";
    const taskAttemptNumber = attempt.taskAttemptNumber || 1;
    // Candidate-plan identity remains anchored to the immutable report time,
    // but publication freshness follows the newest real observation in this
    // crawl. A report recovered days later must not reject freshly refetched
    // prices as being "future" relative to its original creation timestamp.
    const reportReferenceTimeMs = productEvidenceReferenceTimeMs(catalogs, stored.run.createdAt, Date.now());
    const judgeCheckpointRanges = Array.from({ length: MAX_ORCHESTRATION_TASK_ATTEMPTS }, (_, taskAttemptOffset) => {
      const start = MATCH_JUDGE_CHECKPOINT_BATCH_INDEX_BASE + (taskAttemptOffset * MAX_MATCH_JUDGE_CHECKPOINTS_PER_TASK_ATTEMPT);
      return { start, end: start + MAX_MATCH_JUDGE_CHECKPOINTS_PER_TASK_ATTEMPT - 1 };
    });
    const judgeCheckpointStart = MATCH_JUDGE_CHECKPOINT_BATCH_INDEX_BASE + ((taskAttemptNumber - 1) * MAX_MATCH_JUDGE_CHECKPOINTS_PER_TASK_ATTEMPT);
    const judgeCheckpointEnd = judgeCheckpointStart + MAX_MATCH_JUDGE_CHECKPOINTS_PER_TASK_ATTEMPT - 1;
    // Every task attempt owns a disjoint judge namespace. Read all ten bounded
    // namespaces concurrently so crash recovery retains accepted edges from
    // every adopted attempt without turning the critical path into a single
    // 2,500-batch sequential scan.
    const [stateCheckpoints, ...judgeCheckpointPages] = await Promise.all([
      port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndexStart: 270, batchIndexEnd: MATCH_JUDGE_CHECKPOINT_BATCH_INDEX_BASE - 1, latestPerBatch: true }),
      ...judgeCheckpointRanges.map((range) => port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndexStart: range.start, batchIndexEnd: range.end, latestPerBatch: true })),
    ]);
    const adoptedJudgeCheckpoints = judgeCheckpointPages.flat();
    const loadedCheckpoints = [...stateCheckpoints, ...adoptedJudgeCheckpoints];
    const allDurableCheckpoints = new Map(loadedCheckpoints.map((checkpoint) => [`${checkpoint.attemptNumber}:${checkpoint.batchIndex}`, checkpoint]));
    const durableCheckpoints = new Map<number, (typeof loadedCheckpoints)[number]>();
    for (const checkpoint of loadedCheckpoints) {
      if (!durableCheckpoints.has(checkpoint.batchIndex)) durableCheckpoints.set(checkpoint.batchIndex, checkpoint);
    }
    const allowedPrimaryProductKeys = primaryCatalogProductKeys(primary.products);
    const allowedPrimaryRecoveryIdentities = primaryCatalogRecoveryIdentities(primary.products);
    const publishedResultInputHash = createHash("sha256").update(JSON.stringify({
      publicId: payload.publicId,
      reportObservedAt: stored.run.createdAt,
      marketCountryCode,
      resultTarget: payload.productLimit,
      discoveryAnchorSetHash: crawl.discovery?.productSearchCoverage?.anchorSetHash || "",
      primaryCatalog: primaryCatalogIdentity(primary.products),
    })).digest("hex");
    let accumulatedPublished: ProductComparison | null = null;
    const priorPublishedCheckpoints = [...allDurableCheckpoints.values()]
      .filter((checkpoint) => checkpoint.batchIndex >= 270 && checkpoint.batchIndex <= PUBLISHED_RESULT_CHECKPOINT_BATCH_INDEX && checkpoint.inputHash === publishedResultInputHash)
      .sort((left, right) => left.attemptNumber - right.attemptNumber || right.batchIndex - left.batchIndex);
    for (const saved of priorPublishedCheckpoints) {
      const validated = validPublishedResultCheckpoint(saved.result, payload.productLimit, reportReferenceTimeMs, allowedPrimaryProductKeys, allowedPrimaryRecoveryIdentities);
      if (!validated) throw new Error("The durable published-result checkpoint is invalid.");
      accumulatedPublished = mergePublishedProductComparisonState(validated.evidence, accumulatedPublished, payload.productLimit, reportReferenceTimeMs).evidence;
    }
    const recoveredPublishedMatcherResult = accumulatedPublished !== null;
    let requestCount = 0;
    let transportFailed = false;
    try {
      requestCount += 1;
      const first = await port.match({ publicId: payload.publicId, reportAttempt: attempt.attemptNumber, taskAttemptNumber: attempt.taskAttemptNumber || 1, reportObservedAt: stored.run.createdAt, primaryDomain: crawl.primaryDomain, marketCountryCode, productLimit: payload.productLimit, catalogs, pinnedPairs: crawl.matchHints });
      attempts.push({ ...first.comparison, ...(marketCountryCode ? { marketCountryCode } : {}) });
    } catch {
      transportFailed = true;
    }
    if (shouldRetryProductMatch(attempts[0], transportFailed)) {
      try {
        await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "matching-retry-started"), "matching", "Resuming only incomplete product judge batches from durable checkpoints."));
        requestCount += 1;
        const retry = await port.match({ publicId: payload.publicId, reportAttempt: attempt.attemptNumber, taskAttemptNumber: attempt.taskAttemptNumber || 1, reportObservedAt: stored.run.createdAt, primaryDomain: crawl.primaryDomain, marketCountryCode, productLimit: payload.productLimit, catalogs, pinnedPairs: crawl.matchHints });
        attempts.push({ ...retry.comparison, ...(marketCountryCode ? { marketCountryCode } : {}) });
      } catch { /* the bounded second application attempt remains a visible gap */ }
    }
    comparison = composeProductMatchAttempts(baseline, attempts, requestCount);
    // A validated published-result checkpoint is durable proof that an earlier
    // task parsed matcher output and passed the publication boundary. If both
    // live calls in the final task fail, retain that verified graph instead of
    // discarding it solely because this task has no fresh response.
    if (!comparison && accumulatedPublished) comparison = accumulatedPublished;
    if (comparison && marketCountryCode) comparison = { ...comparison, marketCountryCode };
    if (comparison) {
      comparison = bindComparisonPrimaryRecoveryIdentities(comparison, primary.products);
      const adoptedJudgeEvidence = bindComparisonPrimaryRecoveryIdentities(comparisonWithinPrimaryCatalog(screenedComparisonFromJudgeCheckpoints(
        crawl.primaryDomain,
        [...allDurableCheckpoints.values()].filter((checkpoint) => checkpoint.batchIndex >= 1_400 && checkpoint.batchIndex < 3_900).map((checkpoint) => checkpoint.result),
        marketCountryCode,
      ), primary.products), primary.products);
      comparison = mergeAccumulatedPublishedIntoScreenedComparison(comparison, adoptedJudgeEvidence);
      const maxEnrichmentPages = pricedResultEnrichmentBudget(payload.productLimit);
      let enrichmentPlan = planFinalProductEnrichmentTargets(comparison, maxEnrichmentPages, reportReferenceTimeMs);
      const enrichmentPlanHash = enrichmentPlanInputHash(comparison, maxEnrichmentPages);
      const planCheckpointIndex = enrichmentPlanCheckpointIndex(taskAttemptNumber);
      const savedPlan = durableCheckpoints.get(planCheckpointIndex);
      if (savedPlan?.attemptNumber === attempt.attemptNumber) {
        if (savedPlan.inputHash !== enrichmentPlanHash) throw new Error("The durable enrichment plan conflicts with the current accepted product identities.");
        const checkpoint = validEnrichmentPlanCheckpoint(savedPlan.result, enrichmentPlan);
        if (!checkpoint) throw new Error("The durable enrichment plan is invalid.");
        enrichmentPlan = checkpoint;
      } else {
        let reusedPriorPlan = false;
        const priorPlans = [savedPlan, ...Array.from({ length: MAX_ORCHESTRATION_TASK_ATTEMPTS }, (_, index) => MAX_ORCHESTRATION_TASK_ATTEMPTS - index)
          .filter((priorTaskAttempt) => priorTaskAttempt !== taskAttemptNumber)
          .map((priorTaskAttempt) => durableCheckpoints.get(enrichmentPlanCheckpointIndex(priorTaskAttempt)))];
        for (const prior of priorPlans) {
          if (!prior || prior.inputHash !== enrichmentPlanHash) continue;
          const checkpoint = validEnrichmentPlanCheckpoint(prior.result, enrichmentPlan);
          if (!checkpoint) throw new Error("The durable enrichment plan is invalid.");
          enrichmentPlan = checkpoint;
          reusedPriorPlan = true;
          break;
        }
        if (!reusedPriorPlan) {
          const durablePlan = compactEnrichmentPlan(enrichmentPlan);
          try {
            await port.saveCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: planCheckpointIndex, inputHash: enrichmentPlanHash, result: durablePlan });
            const savedCheckpoint = { attemptNumber: attempt.attemptNumber, batchIndex: planCheckpointIndex, inputHash: enrichmentPlanHash, result: durablePlan };
            durableCheckpoints.set(planCheckpointIndex, savedCheckpoint);
            allDurableCheckpoints.set(`${attempt.attemptNumber}:${planCheckpointIndex}`, savedCheckpoint);
          } catch (saveError) {
            const committed = (await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: planCheckpointIndex }))[0];
            if (!committed || committed.attemptNumber !== attempt.attemptNumber || committed.inputHash !== enrichmentPlanHash) throw saveError;
            if (JSON.stringify(stableCheckpointValue(committed.result)) !== JSON.stringify(stableCheckpointValue(durablePlan))) throw saveError;
            const checkpoint = validEnrichmentPlanCheckpoint(committed.result, enrichmentPlan);
            if (!checkpoint) throw saveError;
            enrichmentPlan = checkpoint;
          }
        }
      }
      const recoveredEnrichmentResults: EnrichmentResult[] = [];
      for (const checkpoint of [...allDurableCheckpoints.values()].filter((candidate) => candidate.batchIndex >= ENRICHMENT_CHECKPOINT_BATCH_INDEX_BASE && candidate.batchIndex < MATCH_JUDGE_CHECKPOINT_BATCH_INDEX_BASE)) {
        const checkpointOffset = checkpoint.batchIndex - ENRICHMENT_CHECKPOINT_BATCH_INDEX_BASE;
        const checkpointTaskAttempt = Math.floor(checkpointOffset / MAX_FINAL_ENRICHMENT_BATCHES) + 1;
        const batchOffset = checkpointOffset % MAX_FINAL_ENRICHMENT_BATCHES;
        const batch = enrichmentPlan.targets.slice(batchOffset * FINAL_ENRICHMENT_BATCH_SIZE, (batchOffset + 1) * FINAL_ENRICHMENT_BATCH_SIZE);
        const inputMatches = batch.length > 0 && checkpoint.inputHash === enrichmentBatchHash(batch);
        const validated = inputMatches ? validEnrichmentCheckpoint(checkpoint.result, batch) : null;
        if (!validated) {
          if (checkpoint.attemptNumber === attempt.attemptNumber && checkpointTaskAttempt === taskAttemptNumber) {
            throw new EnrichmentCheckpointConflictError(inputMatches
              ? "A durable enrichment checkpoint is invalid."
              : "A durable enrichment checkpoint conflicts with the current product-page batch.");
          }
          continue;
        }
        recoveredEnrichmentResults.push(validated);
      }
      const recoveredProducts = recoveredEnrichmentProducts(recoveredEnrichmentResults, comparison);
      if (recoveredProducts.length) comparison = applyFinalProductEnrichment(comparison, recoveredProducts, {
        pagesRequested: recoveredProducts.length,
        pagesFetched: recoveredProducts.length,
        maxPages: recoveredProducts.length,
        pagesEligible: recoveredProducts.length,
        pagesTruncated: false,
        batchCount: 0,
        failedBatchCount: 0,
        gaps: [],
      });
      let targetSatisfied = mergePublishedProductComparisons(comparison, accumulatedPublished, payload.productLimit, reportReferenceTimeMs).rows.length >= payload.productLimit;
      const targets = enrichmentPlan.targets;
      if (targets.length && !targetSatisfied) {
        const batches = Array.from({ length: Math.ceil(targets.length / FINAL_ENRICHMENT_BATCH_SIZE) }, (_, index) => targets.slice(index * FINAL_ENRICHMENT_BATCH_SIZE, (index + 1) * FINAL_ENRICHMENT_BATCH_SIZE));
        await port.appendEvent(payload.publicId, event(`enrichment-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-started`, "enrichment", "Re-reading accepted product pages in bounded batches for attributable prices and images.", {
          pagesEligible: enrichmentPlan.totalEligible,
          pagesPlanned: targets.length,
          batches: batches.length,
          truncated: enrichmentPlan.truncated,
        }));
        const products: ProductRecord[] = [];
        const gaps: NonNullable<ProductComparison["enrichment"]>["gaps"] = [];
        let pagesFetched = 0;
        let pagesRequested = 0;
        let batchesProcessed = 0;
        let failedBatchCount = 0;
        for (let waveStart = 0; waveStart < batches.length; waveStart += FINAL_ENRICHMENT_BATCH_CONCURRENCY) {
          const wave = batches.slice(waveStart, waveStart + FINAL_ENRICHMENT_BATCH_CONCURRENCY);
          pagesRequested += wave.reduce((sum, batch) => sum + batch.length, 0);
          batchesProcessed += wave.length;
          const results = await Promise.allSettled(wave.map(async (batch, waveIndex) => {
            const batchIndex = waveStart + waveIndex;
            const taskAttemptNumber = attempt.taskAttemptNumber || 1;
            const checkpointIndex = ENRICHMENT_CHECKPOINT_BATCH_INDEX_BASE + batchIndex + ((taskAttemptNumber - 1) * MAX_FINAL_ENRICHMENT_BATCHES);
            const inputHash = enrichmentBatchHash(batch);
            const saved = durableCheckpoints.get(checkpointIndex);
            if (saved) {
              if (saved.inputHash !== inputHash) throw new EnrichmentCheckpointConflictError("A durable enrichment checkpoint conflicts with the current product-page batch.");
              const checkpoint = validEnrichmentCheckpoint(saved.result, batch);
              if (!checkpoint) throw new EnrichmentCheckpointConflictError("A durable enrichment checkpoint is invalid.");
              return checkpoint;
            }
            let previous: EnrichmentResult | null = null;
            for (let priorTaskAttempt = MAX_ORCHESTRATION_TASK_ATTEMPTS; priorTaskAttempt >= 1; priorTaskAttempt -= 1) {
              if (priorTaskAttempt === taskAttemptNumber) continue;
              const priorIndex = ENRICHMENT_CHECKPOINT_BATCH_INDEX_BASE + batchIndex + ((priorTaskAttempt - 1) * MAX_FINAL_ENRICHMENT_BATCHES);
              const priorSaved = durableCheckpoints.get(priorIndex);
              if (!priorSaved) continue;
              if (priorSaved.inputHash !== inputHash) continue;
              previous = validEnrichmentCheckpoint(priorSaved.result, batch);
              if (!previous) throw new EnrichmentCheckpointConflictError("A durable enrichment checkpoint is invalid.");
              break;
            }
            if (previous && !hasRetryableEnrichmentGap(previous)) return previous;
            const targetsToFetch = previous
              ? batch.filter((target) => previous?.coverage.gaps.some((gap) => isRetryableEnrichmentGap(gap) && enrichmentOutcomeKey(gap) === enrichmentOutcomeKey({ domain: target.domain, productId: target.productId })))
              : batch;
            if (!targetsToFetch.length) throw new Error("A retryable enrichment checkpoint did not identify any retryable targets.");
            let mergedResult: EnrichmentResult;
            try {
              const result = await port.enrich({ targets: targetsToFetch });
              const validatedResult = validEnrichmentCheckpoint(result, targetsToFetch);
              if (!validatedResult) throw new Error("Product-page enrichment returned an invalid batch result.");
              const merged = previous ? validEnrichmentCheckpoint(mergeEnrichmentRetry(previous, validatedResult, batch), batch) : validatedResult;
              if (!merged) throw new Error("Product-page enrichment retry could not be merged into its durable batch.");
              mergedResult = merged;
            } catch (error) {
              if (previous) return previous;
              throw error;
            }
            try {
              await port.saveCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: checkpointIndex, inputHash, result: mergedResult });
              const savedCheckpoint = { attemptNumber: attempt.attemptNumber, batchIndex: checkpointIndex, inputHash, result: mergedResult };
              durableCheckpoints.set(checkpointIndex, savedCheckpoint);
              allDurableCheckpoints.set(`${attempt.attemptNumber}:${checkpointIndex}`, savedCheckpoint);
            } catch (saveError) {
              let committed: Awaited<ReturnType<ReportOrchestrationPort["loadCheckpoint"]>>[number] | undefined;
              try {
                committed = (await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: checkpointIndex }))[0];
              } catch (confirmationError) {
                throw new EnrichmentCheckpointConflictError("The enrichment checkpoint save could not be confirmed.", { cause: confirmationError });
              }
              if (!committed || committed.attemptNumber !== attempt.attemptNumber || committed.inputHash !== inputHash) {
                throw new EnrichmentCheckpointConflictError("The enrichment checkpoint save could not be confirmed.", { cause: saveError });
              }
              if (JSON.stringify(stableCheckpointValue(committed.result)) !== JSON.stringify(stableCheckpointValue(mergedResult))) {
                throw new EnrichmentCheckpointConflictError("The enrichment checkpoint save committed conflicting content.", { cause: saveError });
              }
              const checkpoint = validEnrichmentCheckpoint(committed.result, batch);
              if (!checkpoint) throw new EnrichmentCheckpointConflictError("The committed enrichment checkpoint is invalid.", { cause: saveError });
              return checkpoint;
            }
            return mergedResult;
          }));
          const checkpointFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && result.reason instanceof EnrichmentCheckpointConflictError);
          if (checkpointFailure) throw checkpointFailure.reason;
          results.forEach((result, index) => {
            if (result.status === "fulfilled") {
              products.push(...result.value.products);
              pagesFetched += result.value.coverage.pagesFetched;
              gaps.push(...result.value.coverage.gaps);
              return;
            }
            failedBatchCount += 1;
            const batch = wave[index];
            const first = batch[0] as { sourceUrl?: string; productId?: string; role?: "primary" | "rival" } | undefined;
            gaps.push({
              url: first?.sourceUrl || "",
              ...(first?.productId ? { productId: first.productId } : {}),
              ...(first?.role ? { role: first.role } : {}),
              reason: `A ${batch.length}-page enrichment batch failed: ${message(result.reason, "Selected product enrichment was unavailable.")}`,
              code: "batch_failed",
            });
          });
          const waveNumber = Math.floor(waveStart / FINAL_ENRICHMENT_BATCH_CONCURRENCY) + 1;
          await port.appendEvent(payload.publicId, event(`enrichment-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-wave-${waveNumber}-checkpoint`, "enrichment", "A bounded selected-product enrichment wave finished.", {
            wave: waveNumber,
            waves: Math.ceil(batches.length / FINAL_ENRICHMENT_BATCH_CONCURRENCY),
            pagesRequested,
            pagesFetched,
            failedBatches: failedBatchCount,
          }));
          const provisional = applyFinalProductEnrichment(comparison, products, {
            pagesRequested,
            pagesFetched,
            maxPages: targets.length,
            pagesEligible: enrichmentPlan.totalEligible,
            pagesTruncated: true,
            batchCount: batchesProcessed,
            failedBatchCount,
            gaps,
          });
          targetSatisfied = mergePublishedProductComparisons(provisional, accumulatedPublished, payload.productLimit, reportReferenceTimeMs).rows.length >= payload.productLimit;
          if (targetSatisfied) break;
        }
        if (!targetSatisfied && enrichmentPlan.truncated) gaps.push({ url: "", reason: `${enrichmentPlan.totalEligible - targets.length} eligible product pages were outside the plan-bounded enrichment budget.`, code: "plan_limit" });
        const enrichmentIncomplete = failedBatchCount > 0
          || (!targetSatisfied && enrichmentPlan.truncated)
          || gaps.some(isUnresolvedEnrichmentGap);
        comparison = applyFinalProductEnrichment(comparison, products, {
          pagesRequested,
          pagesFetched,
          maxPages: targets.length,
          pagesEligible: enrichmentPlan.totalEligible,
          pagesTruncated: enrichmentIncomplete,
          batchCount: batchesProcessed,
          failedBatchCount,
          gaps,
        });
        if (enrichmentIncomplete) {
          limitedPhases.push("enrichment");
          await port.appendEvent(payload.publicId, event(`enrichment-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-limited`, "enrichment", "Selected product enrichment finished with explicit batch or plan coverage gaps.", {
            pagesRequested,
            pagesFetched,
            batches: batchesProcessed,
            failedBatches: failedBatchCount,
            truncated: enrichmentPlan.truncated,
          }));
        } else {
          completedPhases.push("enrichment");
          await port.appendEvent(payload.publicId, event(`enrichment-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-complete`, "enrichment", targetSatisfied ? "Selected product enrichment filled the priced result target." : "Selected product enrichment finished across all bounded batches.", {
            pagesRequested,
            pagesFetched,
            batches: batchesProcessed,
          }));
        }
      } else if (!targetSatisfied && enrichmentPlan.truncated) {
        const gaps = [{
          url: "",
          reason: `${enrichmentPlan.totalEligible} accepted price-gap records could not be represented as safe product-page enrichment targets.`,
          code: "unschedulable_targets",
        }];
        comparison = applyFinalProductEnrichment(comparison, [], {
          pagesRequested: 0,
          pagesFetched: 0,
          maxPages: 0,
          pagesEligible: enrichmentPlan.totalEligible,
          pagesTruncated: true,
          batchCount: 0,
          failedBatchCount: 0,
          gaps,
        });
        limitedPhases.push("enrichment");
        await port.appendEvent(payload.publicId, event(`enrichment-report-${attempt.attemptNumber}-task-${attempt.taskAttemptNumber || 1}-limited`, "enrichment", "Accepted price gaps could not be safely scheduled as product-page enrichment targets.", {
          pagesEligible: enrichmentPlan.totalEligible,
          pagesPlanned: 0,
          truncated: true,
        }));
      }
      comparison = publishPricedProductComparison(comparison, reportReferenceTimeMs);
      const refreshedCheckpoints = await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndexStart: judgeCheckpointStart, batchIndexEnd: judgeCheckpointEnd, latestPerBatch: true });
      for (const checkpoint of refreshedCheckpoints) {
        allDurableCheckpoints.set(`${checkpoint.attemptNumber}:${checkpoint.batchIndex}`, checkpoint);
        const effective = durableCheckpoints.get(checkpoint.batchIndex);
        if (!effective || checkpoint.attemptNumber > effective.attemptNumber) durableCheckpoints.set(checkpoint.batchIndex, checkpoint);
      }
      const judgeEvidence = bindComparisonPrimaryRecoveryIdentities(comparisonWithinPrimaryCatalog(screenedComparisonFromJudgeCheckpoints(
        crawl.primaryDomain,
        [...allDurableCheckpoints.values()].filter((checkpoint) => checkpoint.batchIndex >= 1_400 && checkpoint.batchIndex < 3_900).map((checkpoint) => checkpoint.result),
        marketCountryCode,
      ), primary.products), primary.products);
      screenedComparison = mergeAccumulatedPublishedIntoScreenedComparison(comparison, judgeEvidence);
      screenedComparison = mergeAccumulatedPublishedIntoScreenedComparison(screenedComparison, accumulatedPublished);
      const publishedState = mergePublishedProductComparisonState(comparison, accumulatedPublished, payload.productLimit, reportReferenceTimeMs);
      comparison = publishedState.comparison;
      const publishedCheckpointIndex = publishedResultCheckpointIndex(taskAttemptNumber);
      const publishedCheckpoint = {
        version: 3,
        comparison: compactPublishedProductComparisonCheckpoint(comparison),
        evidence: compactPublishedProductComparisonCheckpoint(publishedState.evidence),
      };
      if (encodedJsonBytes(publishedCheckpoint) > REPORT_MATCH_CHECKPOINT_RESULT_BYTES) {
        throw new Error("The complete published-result checkpoint exceeds its persistence budget.");
      }
      const checkpointIsComplete = comparison.matching?.resultShortfallReason !== "processing-incomplete"
        && comparison.enrichment?.pagesTruncated !== true
        && (comparison.enrichment?.failedBatchCount || 0) === 0;
      if (checkpointIsComplete) {
        if (!validPublishedResultCheckpoint(publishedCheckpoint, payload.productLimit, reportReferenceTimeMs, allowedPrimaryProductKeys, allowedPrimaryRecoveryIdentities)) {
          throw new Error("The published-result checkpoint does not belong to the current primary catalog.");
        }
        try {
          await port.saveCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: publishedCheckpointIndex, inputHash: publishedResultInputHash, result: publishedCheckpoint });
          const savedCheckpoint = { attemptNumber: attempt.attemptNumber, batchIndex: publishedCheckpointIndex, inputHash: publishedResultInputHash, result: publishedCheckpoint };
          durableCheckpoints.set(publishedCheckpointIndex, savedCheckpoint);
          allDurableCheckpoints.set(`${attempt.attemptNumber}:${publishedCheckpointIndex}`, savedCheckpoint);
        } catch (saveError) {
          const committed = (await port.loadCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: publishedCheckpointIndex }))[0];
          const exactCommittedResult = committed && JSON.stringify(stableCheckpointValue(committed.result)) === JSON.stringify(stableCheckpointValue(publishedCheckpoint));
          const validated = committed?.attemptNumber === attempt.attemptNumber && committed.inputHash === publishedResultInputHash && exactCommittedResult
            ? validPublishedResultCheckpoint(committed.result, payload.productLimit, reportReferenceTimeMs, allowedPrimaryProductKeys, allowedPrimaryRecoveryIdentities)
            : null;
          if (!validated) throw saveError;
          // The committed compact graph is proof that this exact save reached
          // durable storage. Keep the already validated rich in-memory result;
          // replacing it with the compact representation would discard
          // reproducible decision/action inputs after a lost response.
          durableCheckpoints.set(publishedCheckpointIndex, committed);
          allDurableCheckpoints.set(`${committed.attemptNumber}:${publishedCheckpointIndex}`, committed);
        }
      }
      if ((comparison.matching?.resultShortfall || 0) > 0 && crawl.discovery?.productSearchCoverage?.complete !== true) {
        const coverage = crawl.discovery?.productSearchCoverage;
        comparison = {
          ...comparison,
          matching: comparison.matching ? {
            ...comparison.matching,
            resultShortfallReason: "processing-incomplete",
            gaps: [...new Set([...comparison.matching.gaps, `Competitor product discovery searched ${coverage?.searchedAnchors || 0} of ${coverage?.eligibleAnchors || primary.products.length} eligible primary-product anchors; the bounded discovery pool was not exhausted.`])],
          } : comparison.matching,
        };
      }
      const actionInputs = collectProductActionInputs(comparison);
      if (actionInputs.length) {
        await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "actions-started"), "actions", "Drafting evidence-grounded next moves for the accepted product pairs.", { pairs: actionInputs.length }));
        try {
          const planned = await port.actions({ inputs: actionInputs });
          comparison = applyProductActionPlans(comparison, planned.result);
          completedPhases.push("actions");
          await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "actions-complete"), "actions", "Next moves were drafted and checked against saved product evidence.", {
            requested: planned.result.metadata.actionsRequested,
            aiAccepted: planned.result.metadata.aiActionsAccepted,
            deterministicFallbacks: planned.result.metadata.fallbackActions,
          }));
        } catch (error) {
          const fallback = deterministicProductActionResult(actionInputs, undefined, [message(error, "AI action planning was unavailable; deterministic recommendations were retained.")]);
          comparison = applyProductActionPlans(comparison, fallback);
          completedPhases.push("actions");
          await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "actions-complete"), "actions", "AI action drafting was unavailable, so the report retained its deterministic next moves.", {
            requested: actionInputs.length,
            aiAccepted: 0,
            deterministicFallbacks: actionInputs.length,
          }));
        }
      }
      screenedComparison = mergePublishedSelectionIntoScreenedComparison(screenedComparison, comparison);
      document = upsertProductComparisonBlock(document, comparison) as JsonDocument;
    }
    const limited = attempts.length === 0 || hasProductMatchCoverageDefect(comparison);
    const processingIncomplete = attempts.length === 0 || comparison?.matching?.resultShortfallReason === "processing-incomplete";
    // The final bounded task publishes the strongest verified facts after at
    // least one matcher response was parsed. Requiring a comparison row left
    // honest zero-row coverage results in `running`, while accepting zero
    // successful matcher responses would mislabel transport/auth/contract
    // failure as bounded exhaustion.
    const publishBestFinalResult = attempt.isFinalAttempt && (attempts.length > 0 || recoveredPublishedMatcherResult);
    if (processingIncomplete && !publishBestFinalResult) {
      await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "matching-task-retry"), "matching", attempt.isFinalAttempt
        ? "Product matching or enrichment remained incomplete after the final bounded task attempt; no terminal report was published."
        : "Product matching or enrichment remained incomplete; durable checkpoints will resume on the bounded task retry.", { attempts: requestCount }));
      throw new RecoverableProcessingIncompleteError(attempt.isFinalAttempt
        ? "Product matching or enrichment remained incomplete after the final task attempt."
        : "Product matching or enrichment remained incomplete before the final task attempt.");
    }
    if (processingIncomplete) {
      limitedPhases.push("matching");
      await port.appendEvent(payload.publicId, limitedEvent(progressEventKey(attempt, "matching-limited"), "matching", "The final bounded attempt retained the strongest verified comparisons, with the remaining coverage gap shown explicitly.", { attempts: requestCount, rows: comparison?.rows.length || 0 }));
      return;
    }
    (limited ? limitedPhases : completedPhases).push("matching");
    await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "matching-complete"), "matching", limited ? "Product matching finished with a visible coverage limitation." : "Product matching finished and accepted comparisons were source-linked.", { limited, attempts: requestCount }));
  })();

  await Promise.all([adsWork, matchWork]);
  const finishedAt = now().toISOString();
  const reportStatus = limitedPhases.length ? "limited" : "complete";
  let persistedCounts: Record<"companies" | "products" | "matches" | "ads", number> | null = null;
  let persistedFactManifestHash = "";
  let terminalDocument: unknown = null;
  try {
    let priorManifest = stored.factManifest || null;
    if (priorManifest?.status === "finalizing") {
      try {
        await port.finalizeFactManifest(payload.publicId, { attemptNumber: priorManifest.attemptNumber, manifestId: priorManifest.manifestId, manifestHash: priorManifest.manifestHash, counts: priorManifest.counts });
        priorManifest = { ...priorManifest, status: "complete" };
      } catch {
        const refreshed = await port.loadReport(payload.publicId);
        priorManifest = refreshed?.factManifest || null;
      }
    }
    const factReferenceTime = new Date(productEvidenceReferenceTimeMs(crawl.results.map((result) => ({ products: result.products })), stored.run.createdAt, Date.now())).toISOString();
    const facts = await buildReportFactBundle({ publicId: payload.publicId, crawlResults: crawl.results, comparison: screenedComparison || comparison, adBlock, observedAt: factReferenceTime, attemptNumber: attempt.attemptNumber });
    terminalDocument = compactTerminalReportDocument({ primaryDomain: crawl.primaryDomain, document, marketBrief: null }, 430_000, { factsAuthoritative: true, factCounts: facts.manifest.counts });
    const presentationCheckpoint = { version: 2, taskAttemptNumber: attempt.taskAttemptNumber || 1, manifestHash: facts.manifest.manifestHash, status: reportStatus, observedAt: finishedAt, document: terminalDocument };
    const presentationInputHash = createHash("sha256").update(JSON.stringify(presentationCheckpoint)).digest("hex");
    await port.saveCheckpoint(payload.publicId, { attemptNumber: attempt.attemptNumber, batchIndex: terminalPresentationCheckpointIndex(attempt.taskAttemptNumber || 1), inputHash: presentationInputHash, result: presentationCheckpoint });
    const reusableManifest = priorManifest?.status === "complete"
      && priorManifest.manifestId === facts.manifest.manifestId
      && priorManifest.manifestHash === facts.manifest.manifestHash;
    if (priorManifest?.status === "complete" && !reusableManifest) {
      throw new CompletedFactManifestConflict("The completed relational fact snapshot differs from this retry; orchestration stopped before replacing authoritative facts or saving a mismatched presentation.");
    }
    if (!reusableManifest) {
      for (const chunk of facts.chunks) await port.persistFactChunk(payload.publicId, chunk);
      await port.finalizeFactManifest(payload.publicId, facts.manifest);
      persistedCounts = facts.manifest.counts;
      persistedFactManifestHash = facts.manifest.manifestHash;
    } else {
      persistedCounts = priorManifest.counts;
      persistedFactManifestHash = priorManifest.manifestHash;
    }
  } catch (error) {
    if (error instanceof CompletedFactManifestConflict) throw error;
    try { await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "facts-incomplete"), "persistence", "The complete relational fact set was not available, so no terminal presentation was published.", { reason: message(error, "Relational fact persistence was unavailable.") })); } catch { /* the original persistence failure remains authoritative */ }
    throw new RecoverableProcessingIncompleteError(attempt.isFinalAttempt
      ? "Relational fact persistence remained incomplete after the final task attempt."
      : "Relational fact persistence remained incomplete before the final task attempt.");
  }
  if (persistedCounts) try { await port.appendEvent(payload.publicId, event(progressEventKey(attempt, "facts-complete"), "persistence", "The complete company, product, match, and attributable ad facts were saved for evaluation.", persistedCounts)); } catch { /* the manifest is authoritative and the terminal document still saves */ }
  await port.saveDocument(payload.publicId, {
    status: reportStatus,
    observedAt: finishedAt,
    expectedFactManifestHash: persistedFactManifestHash,
    document: terminalDocument || compactTerminalReportDocument({ primaryDomain: crawl.primaryDomain, document, marketBrief: null }, undefined, { factsAuthoritative: Boolean(persistedCounts), factCounts: persistedCounts }),
  });
  completedPhases.push("persistence");
  return { ok: true, contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION, publicId: payload.publicId, reportStatus, completedPhases: [...new Set(completedPhases)], limitedPhases: [...new Set(limitedPhases)], startedAt, finishedAt };
  } catch (error) {
    if (attempt.isFinalAttempt && !terminalFailureRecorded) {
      try {
        await port.appendEvent(payload.publicId, {
          idempotencyKey: "orchestration-failed",
          phase: "failed",
          status: "failed",
          message: "The report could not be completed after the bounded retry.",
          metadata: { attempt: attempt.attemptNumber, reason: message(error, "Orchestration failed.") },
        });
      } catch { /* callback failure is already represented by the thrown task error */ }
    }
    throw error;
  }
}
