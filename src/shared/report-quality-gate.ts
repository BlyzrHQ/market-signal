import { createHash } from "node:crypto";

import { canonicalDomain } from "../../app/lib/domain.ts";
import {
  hasComparablePublicPrice,
  type ProductComparison,
  type ProductMatch,
  type ProductRecord,
} from "../../app/lib/product-intelligence.ts";

export const REPORT_QUALITY_GATE_VERSION = "report-quality-gate-v1" as const;
export const MAX_REPORT_QUALITY_REPAIR_ROUNDS = 3 as const;
export const MAX_REPORT_QUALITY_REPAIR_PRODUCTS = 25 as const;
export const MAX_REPORT_QUALITY_DEFICIENCIES = 50 as const;
export const MAX_REPORT_QUALITY_EXCLUDED_SOURCES = 1_000 as const;

export const REPORT_QUALITY_DEFICIENCY_CODES = [
  "comparison_target_shortfall",
  "coverage_count_mismatch",
  "duplicate_rival_source",
  "empty_primary_price",
  "empty_rival_price",
  "incompatible_price_currency",
  "invalid_primary_source",
  "invalid_rival_source",
  "missing_rival_product",
  "self_comparison",
  "unpublishable_comparison",
] as const;

export type ReportQualityDeficiencyCode = typeof REPORT_QUALITY_DEFICIENCY_CODES[number];

export type ReportQualityDeficiency = {
  code: ReportQualityDeficiencyCode;
  primaryProductId: string;
  rivalSourceUrl: string;
  detail: string;
};

export type ReportQualityRepairFeedback = {
  version: 1;
  round: number;
  feedbackHash: string;
  reasonCodes: ReportQualityDeficiencyCode[];
  primaryProductIds: string[];
  excludedRivalSourceUrls: string[];
};

export type ReportQualityVerdict = {
  version: typeof REPORT_QUALITY_GATE_VERSION;
  status: "pass" | "repair" | "limited" | "reject";
  repairRound: number;
  comparisonTarget: number;
  validComparisonCount: number;
  missingComparisonCount: number;
  deficiencies: ReportQualityDeficiency[];
  feedback: ReportQualityRepairFeedback | null;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFICIENCY_CODE_SET = new Set<string>(REPORT_QUALITY_DEFICIENCY_CODES);
const FEEDBACK_KEYS = ["excludedRivalSourceUrls", "feedbackHash", "primaryProductIds", "reasonCodes", "round", "version"].sort();

function compareCodepoint(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalProductUrl(value: unknown, expectedDomain?: string) {
  if (typeof value !== "string" || !value || value.length > 2_048) return "";
  try {
    const url = new URL(value);
    const domain = canonicalDomain(url.hostname);
    if (url.protocol !== "https:" || url.username || url.password || !domain || (expectedDomain && domain !== canonicalDomain(expectedDomain))) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function productCurrency(product: ProductRecord) {
  return String(product.priceSignals[0]?.currency || "").trim().toUpperCase();
}

function inspectComparisonMatch(input: {
  match: ProductMatch;
  primary: ProductRecord;
  primaryDomain: string;
  referenceTimeMs: number;
  seenRivalSources: Set<string>;
}) {
  const deficiencies: ReportQualityDeficiency[] = [];
  const rival = input.match.product;
  const rawRivalSourceUrl = rival?.sourceUrl || input.match.excludedProduct?.sourceUrl || "";
  const rivalSourceUrl = rival ? canonicalProductUrl(rival.sourceUrl, rival.domain) : "";
  const add = (code: ReportQualityDeficiencyCode, detail: string) => deficiencies.push({
    code,
    primaryProductId: input.primary.id.slice(0, 300),
    rivalSourceUrl: rawRivalSourceUrl.slice(0, 2_048),
    detail: detail.slice(0, 240),
  });
  if (!rival) add("missing_rival_product", "The draft contains a comparison without a retained rival product.");
  if (input.match.publication?.priceEligible !== true) add("unpublishable_comparison", "The draft contains a comparison that did not pass the publication boundary.");
  if (!canonicalProductUrl(input.primary.sourceUrl, input.primaryDomain)) add("invalid_primary_source", "The primary product is not bound to an attributable HTTPS source on the submitted domain.");
  if (!hasComparablePublicPrice(input.primary, input.referenceTimeMs)) add("empty_primary_price", "The primary product does not have a finite, supported, attributable observed price.");
  if (rival) {
    if (!rivalSourceUrl) add("invalid_rival_source", "The rival product is not bound to an attributable HTTPS source on its claimed domain.");
    if (!hasComparablePublicPrice(rival, input.referenceTimeMs)) add("empty_rival_price", "The rival product does not have a finite, supported, attributable observed price.");
    if (canonicalDomain(rival.domain) === input.primaryDomain) add("self_comparison", "The submitted store cannot be its own rival.");
    if (productCurrency(input.primary) && productCurrency(rival) && productCurrency(input.primary) !== productCurrency(rival)) add("incompatible_price_currency", "The primary and rival prices use different currencies.");
    if (rivalSourceUrl) {
      if (input.seenRivalSources.has(rivalSourceUrl)) add("duplicate_rival_source", "The same rival product source appears more than once in the draft.");
      input.seenRivalSources.add(rivalSourceUrl);
    }
  }
  return { valid: deficiencies.length === 0, deficiencies, rivalSourceUrl };
}

function feedbackPayload(value: Omit<ReportQualityRepairFeedback, "feedbackHash">) {
  return {
    version: value.version,
    round: value.round,
    reasonCodes: value.reasonCodes,
    primaryProductIds: value.primaryProductIds,
    excludedRivalSourceUrls: value.excludedRivalSourceUrls,
  };
}

function feedbackHash(value: Omit<ReportQualityRepairFeedback, "feedbackHash">) {
  return createHash("sha256").update(JSON.stringify(feedbackPayload(value))).digest("hex");
}

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort(compareCodepoint);
}

function createRepairFeedback(
  round: number,
  reasonCodes: ReportQualityDeficiencyCode[],
  primaryProductIds: string[],
  excludedRivalSourceUrls: string[],
): ReportQualityRepairFeedback {
  const value = {
    version: 1 as const,
    round,
    reasonCodes: sortedUnique(reasonCodes) as ReportQualityDeficiencyCode[],
    primaryProductIds: [...primaryProductIds],
    excludedRivalSourceUrls: sortedUnique(excludedRivalSourceUrls).slice(0, MAX_REPORT_QUALITY_EXCLUDED_SOURCES),
  };
  return { ...value, feedbackHash: feedbackHash(value) };
}

export function parseReportQualityRepairFeedback(value: unknown): ReportQualityRepairFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Report quality repair feedback must be an object.");
  const item = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(FEEDBACK_KEYS)) throw new Error("Report quality repair feedback contains unsupported fields.");
  if (item.version !== 1 || !Number.isInteger(item.round) || Number(item.round) < 1 || Number(item.round) > MAX_REPORT_QUALITY_REPAIR_ROUNDS) throw new Error("Report quality repair feedback has an invalid round.");
  if (typeof item.feedbackHash !== "string" || !HASH_PATTERN.test(item.feedbackHash)) throw new Error("Report quality repair feedback requires a SHA-256 identity.");
  if (!Array.isArray(item.reasonCodes) || !item.reasonCodes.length || item.reasonCodes.length > REPORT_QUALITY_DEFICIENCY_CODES.length
    || !item.reasonCodes.every((code) => typeof code === "string" && DEFICIENCY_CODE_SET.has(code))) throw new Error("Report quality repair feedback has invalid reason codes.");
  if (!Array.isArray(item.primaryProductIds) || !item.primaryProductIds.length || item.primaryProductIds.length > MAX_REPORT_QUALITY_REPAIR_PRODUCTS
    || !item.primaryProductIds.every((id) => typeof id === "string" && id === id.trim() && id.length >= 1 && id.length <= 300)) throw new Error("Report quality repair feedback has invalid primary product ids.");
  if (!Array.isArray(item.excludedRivalSourceUrls) || item.excludedRivalSourceUrls.length > MAX_REPORT_QUALITY_EXCLUDED_SOURCES
    || !item.excludedRivalSourceUrls.every((url) => typeof url === "string" && canonicalProductUrl(url) === url)) throw new Error("Report quality repair feedback has invalid excluded rival sources.");
  const reasonCodes = item.reasonCodes as ReportQualityDeficiencyCode[];
  const primaryProductIds = item.primaryProductIds as string[];
  const excludedRivalSourceUrls = item.excludedRivalSourceUrls as string[];
  if (JSON.stringify(reasonCodes) !== JSON.stringify(sortedUnique(reasonCodes))
    || new Set(primaryProductIds).size !== primaryProductIds.length
    || JSON.stringify(excludedRivalSourceUrls) !== JSON.stringify(sortedUnique(excludedRivalSourceUrls))) throw new Error("Report quality repair feedback must be deterministic and unique.");
  const parsed = { version: 1 as const, round: Number(item.round), reasonCodes, primaryProductIds, excludedRivalSourceUrls };
  if (feedbackHash(parsed) !== item.feedbackHash) throw new Error("Report quality repair feedback hash does not match its payload.");
  return { ...parsed, feedbackHash: item.feedbackHash };
}

function repairProducts(
  products: ProductRecord[],
  comparison: ProductComparison,
  primaryDomain: string,
  referenceTimeMs: number,
  repairRound: number,
) {
  const acceptedByPrimary = new Map<string, number>();
  for (const row of comparison.rows) acceptedByPrimary.set(row.primary.id, row.matches.filter((match) => match.product && match.publication?.priceEligible === true).length);
  const candidates = [...products]
    .filter((product) => canonicalDomain(product.domain) === primaryDomain
      && Boolean(canonicalProductUrl(product.sourceUrl, primaryDomain))
      && hasComparablePublicPrice(product, referenceTimeMs))
    .sort((left, right) => (acceptedByPrimary.get(left.id) || 0) - (acceptedByPrimary.get(right.id) || 0)
      || compareCodepoint(left.name.normalize("NFKC").toLowerCase(), right.name.normalize("NFKC").toLowerCase())
      || compareCodepoint(left.sourceUrl, right.sourceUrl)
      || compareCodepoint(left.id, right.id));
  if (!candidates.length) return [];
  const start = ((repairRound - 1) * MAX_REPORT_QUALITY_REPAIR_PRODUCTS) % candidates.length;
  return [...candidates.slice(start), ...candidates.slice(0, start)]
    .slice(0, Math.min(MAX_REPORT_QUALITY_REPAIR_PRODUCTS, candidates.length))
    .map((product) => product.id);
}

export function sanitizeReportDraftQuality(input: {
  comparison: ProductComparison;
  comparisonTarget: number;
  primaryDomain: string;
  referenceTimeMs?: number;
}) {
  const comparisonTarget = Math.max(1, Math.min(1_000, Math.floor(input.comparisonTarget)));
  const primaryDomain = canonicalDomain(input.primaryDomain);
  const referenceTimeMs = Number.isFinite(input.referenceTimeMs) ? Number(input.referenceTimeMs) : Date.now();
  const seenRivalSources = new Set<string>();
  const deficiencies: ReportQualityDeficiency[] = [];
  const rows = input.comparison.rows.flatMap((row) => {
    const matches = row.matches.filter((match) => {
      const inspected = inspectComparisonMatch({ match, primary: row.primary, primaryDomain, referenceTimeMs, seenRivalSources });
      deficiencies.push(...inspected.deficiencies);
      return inspected.valid;
    });
    return matches.length ? [{ ...row, matches }] : [];
  });
  const validComparisonCount = rows.reduce((sum, row) => sum + row.matches.length, 0);
  if (input.comparison.coverage.assignedPairCount !== validComparisonCount) deficiencies.push({
    code: "coverage_count_mismatch",
    primaryProductId: "",
    rivalSourceUrl: "",
    detail: `The draft claimed ${input.comparison.coverage.assignedPairCount} published comparisons but ${validComparisonCount} passed the quality boundary.`.slice(0, 240),
  });
  const reasonCodes = sortedUnique(deficiencies.map((item) => item.code)) as ReportQualityDeficiencyCode[];
  const removedComparisonCount = input.comparison.rows.reduce((sum, row) => sum + row.matches.length, 0) - validComparisonCount;
  const publishedPrimaryProducts = rows.length;
  const resultShortfall = Math.max(0, comparisonTarget - validComparisonCount);
  const qualityGap = deficiencies.length
    ? `The report quality gate removed ${Math.max(0, removedComparisonCount)} invalid comparison${removedComparisonCount === 1 ? "" : "s"} and corrected its published counts (${reasonCodes.join(", ")}).`
    : "";
  const comparison: ProductComparison = {
    ...input.comparison,
    comparisonDomains: sortedUnique(rows.flatMap((row) => row.matches.flatMap((match) => match.product ? [canonicalDomain(match.product.domain)] : [])).filter(Boolean)),
    rows,
    coverage: {
      ...input.comparison.coverage,
      primaryProductFamiliesCompared: publishedPrimaryProducts,
      assignedPairCount: validComparisonCount,
      verifiedPairCount: rows.reduce((sum, row) => sum + row.matches.filter((match) => match.confidence === "Medium").length, 0),
      rowsReturned: publishedPrimaryProducts,
      rowLimit: comparisonTarget,
    },
    matching: input.comparison.matching ? {
      ...input.comparison.matching,
      resultTarget: comparisonTarget,
      publishedPairs: validComparisonCount,
      publishedPrimaryProducts,
      resultShortfall,
      ...(resultShortfall
        ? { resultShortfallReason: input.comparison.matching.resultShortfallReason === "processing-incomplete" ? "processing-incomplete" as const : "bounded-candidate-pool-exhausted" as const }
        : { resultShortfallReason: undefined }),
      gaps: qualityGap ? [...new Set([...input.comparison.matching.gaps, qualityGap])] : input.comparison.matching.gaps,
    } : input.comparison.matching,
  };
  return { comparison, removedComparisonCount: Math.max(0, removedComparisonCount), reasonCodes, deficiencies };
}

export function evaluateReportDraftQuality(input: {
  comparison: ProductComparison;
  comparisonTarget: number;
  primaryDomain: string;
  primaryProducts: ProductRecord[];
  referenceTimeMs?: number;
  repairRound?: number;
}): ReportQualityVerdict {
  const comparisonTarget = Math.max(1, Math.min(1_000, Math.floor(input.comparisonTarget)));
  const primaryDomain = canonicalDomain(input.primaryDomain);
  const referenceTimeMs = Number.isFinite(input.referenceTimeMs) ? Number(input.referenceTimeMs) : Date.now();
  const repairRound = Math.max(0, Math.min(MAX_REPORT_QUALITY_REPAIR_ROUNDS, Math.floor(input.repairRound || 0)));
  const deficiencies: ReportQualityDeficiency[] = [];
  const excludedRivalSourceUrls: string[] = [];
  const seenRivalSources = new Set<string>();
  let validComparisonCount = 0;
  for (const row of input.comparison.rows) {
    for (const match of row.matches) {
      const inspected = inspectComparisonMatch({ match, primary: row.primary, primaryDomain, referenceTimeMs, seenRivalSources });
      deficiencies.push(...inspected.deficiencies);
      if (inspected.rivalSourceUrl) excludedRivalSourceUrls.push(inspected.rivalSourceUrl);
      if (inspected.valid) validComparisonCount += 1;
    }
  }

  if (input.comparison.coverage.assignedPairCount !== validComparisonCount) {
    deficiencies.push({ code: "coverage_count_mismatch", primaryProductId: "", rivalSourceUrl: "", detail: `The draft claims ${input.comparison.coverage.assignedPairCount} published comparisons but ${validComparisonCount} pass the quality boundary.`.slice(0, 240) });
  }
  const missingComparisonCount = Math.max(0, comparisonTarget - validComparisonCount);
  if (missingComparisonCount) deficiencies.push({ code: "comparison_target_shortfall", primaryProductId: "", rivalSourceUrl: "", detail: `The draft contains ${validComparisonCount} of ${comparisonTarget} requested priced comparisons.`.slice(0, 240) });
  deficiencies.sort((left, right) => compareCodepoint(left.code, right.code)
    || compareCodepoint(left.primaryProductId, right.primaryProductId)
    || compareCodepoint(left.rivalSourceUrl, right.rivalSourceUrl)
    || compareCodepoint(left.detail, right.detail));
  const boundedDeficiencies = deficiencies.slice(0, MAX_REPORT_QUALITY_DEFICIENCIES);
  const hardDeficiency = deficiencies.some((deficiency) => deficiency.code !== "comparison_target_shortfall");
  if (hardDeficiency) return {
    version: REPORT_QUALITY_GATE_VERSION,
    status: "reject",
    repairRound,
    comparisonTarget,
    validComparisonCount,
    missingComparisonCount,
    deficiencies: boundedDeficiencies,
    feedback: null,
  };
  if (!missingComparisonCount) return {
    version: REPORT_QUALITY_GATE_VERSION,
    status: "pass",
    repairRound,
    comparisonTarget,
    validComparisonCount,
    missingComparisonCount: 0,
    deficiencies: [],
    feedback: null,
  };
  const nextRound = repairRound + 1;
  const primaryProductIds = nextRound <= MAX_REPORT_QUALITY_REPAIR_ROUNDS
    ? repairProducts(input.primaryProducts, input.comparison, primaryDomain, referenceTimeMs, nextRound)
    : [];
  const status = nextRound <= MAX_REPORT_QUALITY_REPAIR_ROUNDS && primaryProductIds.length ? "repair" as const : "limited" as const;
  return {
    version: REPORT_QUALITY_GATE_VERSION,
    status,
    repairRound,
    comparisonTarget,
    validComparisonCount,
    missingComparisonCount,
    deficiencies: boundedDeficiencies,
    feedback: status === "repair"
      ? createRepairFeedback(nextRound, ["comparison_target_shortfall"], primaryProductIds, excludedRivalSourceUrls)
      : null,
  };
}
