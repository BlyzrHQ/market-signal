import { formatPriceClaim, formatPriceDifference, resolvePriceClaim, type PriceClaim } from "./price-claims.ts";
import { parseComparablePrice } from "./report-presentation.ts";
import type { StoredReportMatchPage, StoredReportSnapshot } from "./report-store.ts";

type JsonRecord = Record<string, unknown>;

export type AgentPrice = {
  display: string;
  amount: number;
  currency: string;
};

export type AgentProduct = {
  id: string;
  domain: string;
  title: string;
  sourceUrl: string;
  imageUrl: string | null;
  observedAt: string;
  price: AgentPrice;
  quantity: { kind: string; amount: number; unit: string } | null;
};

export type AgentComparison = {
  id: string;
  primaryProduct: AgentProduct;
  rivalProduct: AgentProduct;
  match: {
    verdict: "same_product" | "close_substitute" | "search_result";
    confidence: number;
    score: number;
    method: "ai-hybrid" | "direct-web-search";
    claimType: string;
    reasons: string[];
    contradictions: string[];
    sharedTerms: string[];
    category: string | null;
    variant: string | null;
    size: string | null;
    model: string | null;
    promptVersion: string | null;
  };
  priceComparison: {
    kind: PriceClaim["kind"];
    position: "primary_lower" | "rival_lower" | "equal" | "not_calculable";
    currency: string | null;
    primaryAmount: number | null;
    rivalAmount: number | null;
    gapAmount: number | null;
    gapPercent: number | null;
    unitBasis: number | null;
    unit: string | null;
    primaryUnitAmount: number | null;
    rivalUnitAmount: number | null;
    unavailableReason: "currency" | "format" | "unparsed" | "missing_price" | null;
    summary: string;
    detail: string;
    note: string;
  };
  recommendation: {
    action: string | null;
    rationale: string | null;
    source: "ai" | "deterministic" | "unknown";
    leverType: string | null;
    model: string | null;
    promptVersion: string | null;
    evidenceKeys: string[];
  };
};

const MATCH_ID_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;

export class ReportLoopFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportLoopFactsError";
  }
}

export function encodeAgentComparisonCursor(publicReportId: string, rawCursor: string | null) {
  if (!rawCursor) return null;
  const separator = rawCursor.indexOf("~");
  const domain = rawCursor.slice(0, separator);
  const id = rawCursor.slice(separator + 1);
  if (!PUBLIC_ID_PATTERN.test(publicReportId) || separator < 1 || !canonicalDomain(domain) || !MATCH_ID_PATTERN.test(id)) {
    throw new ReportLoopFactsError("Authoritative comparison continuation cursor is inconsistent.");
  }
  return `${publicReportId}~${canonicalDomain(domain)}~${id}`;
}

export function decodeAgentComparisonCursor(publicReportId: string, cursor: string) {
  if (!cursor) return "";
  const [boundReportId, domain, id, ...extra] = cursor.split("~");
  if (extra.length || boundReportId !== publicReportId || !PUBLIC_ID_PATTERN.test(boundReportId) || !canonicalDomain(domain) || !MATCH_ID_PATTERN.test(id)) return null;
  return `${canonicalDomain(domain)}~${id}`;
}

export type AgentCompetitor = {
  domain: string;
  name: string;
  comparisonCount: number;
  comparisonSharePercent: number;
  relationship: string;
  confidence: string;
  reason: string;
  verificationScore: number | null;
  websiteUrl: string | null;
};

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function list(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown, maxLength = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function canonicalDomain(value: unknown) {
  const raw = cleanText(value, 300).toLowerCase();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function publicUrl(value: unknown) {
  const raw = cleanText(value, 2_000);
  try {
    const parsed = new URL(raw);
    const normalized = parsed.toString();
    return parsed.protocol === "https:" && normalized.length <= 2_000 ? normalized : "";
  } catch {
    return "";
  }
}

function urlDomain(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function canonicalTimestamp(value: unknown) {
  const raw = cleanText(value, 80);
  if (!raw || Number.isNaN(Date.parse(raw))) return "";
  const canonical = new Date(raw).toISOString();
  return canonical === raw ? canonical : "";
}

function finiteNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveNumber(value: unknown) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function stringList(value: unknown, maximum = 12, length = 320) {
  return list(value).map((item) => cleanText(item, length)).filter(Boolean).slice(0, maximum);
}

function productPrice(product: JsonRecord, approvedRaw: unknown): AgentPrice {
  const approvedDisplay = cleanText(approvedRaw, 120);
  const signals = list(product.priceSignals).map(object);
  const signal = signals.find((item) => positiveNumber(item.amount) !== null && /^[A-Z]{3}$/.test(cleanText(item.currency, 3).toUpperCase()))
    || signals.find((item) => cleanText(item.raw, 120));
  const signalCurrency = cleanText(signal?.currency, 3).toUpperCase();
  const signalAmount = positiveNumber(signal?.amount);
  const signalDisplay = cleanText(signal?.raw, 120)
    || (signalAmount !== null && /^[A-Z]{3}$/.test(signalCurrency) ? `${signalCurrency} ${signalAmount}` : "");
  const display = approvedDisplay || signalDisplay;
  const parsed = parseComparablePrice(display);
  return {
    display,
    amount: parsed?.amount ?? 0,
    currency: parsed?.currency ?? "",
  };
}

function productQuantity(value: unknown): AgentProduct["quantity"] {
  const candidate = object(value);
  const kind = cleanText(candidate.kind, 40);
  const unit = cleanText(candidate.unit, 20);
  const amount = positiveNumber(candidate.amount);
  return kind && unit && amount !== null ? { kind, amount, unit } : null;
}

function normalizedProduct(productValue: unknown, approvedRaw: unknown, role: "primary" | "rival", comparisonId: string): AgentProduct {
  const product = object(productValue);
  const id = cleanText(product.id, 240);
  const domain = canonicalDomain(product.domain);
  const title = cleanText(product.name, 300);
  const sourceUrl = publicUrl(product.sourceUrl);
  const price = productPrice(product, approvedRaw);
  const observedAt = canonicalTimestamp(product.observedAt);
  if (!id || !domain || !title || !sourceUrl || !sourceUrl.startsWith("https://") || urlDomain(sourceUrl) !== domain || !observedAt || !price.display || price.amount <= 0 || !/^[A-Z]{3}$/.test(price.currency)) {
    throw new ReportLoopFactsError(`Authoritative comparison ${comparisonId} has incomplete ${role} product facts.`);
  }
  return {
    id,
    domain,
    title,
    sourceUrl,
    imageUrl: publicUrl(product.imageUrl) || null,
    observedAt,
    price,
    quantity: productQuantity(product.quantity),
  };
}

function position(claim: PriceClaim): AgentComparison["priceComparison"]["position"] {
  if (claim.kind === "listed-equal") return "equal";
  if (!("direction" in claim)) return "not_calculable";
  if (claim.direction === "equal") return "equal";
  return claim.direction === "primary" ? "primary_lower" : "rival_lower";
}

function normalizedPriceComparison(claim: PriceClaim): AgentComparison["priceComparison"] {
  const copy = formatPriceClaim(claim, "en");
  const difference = formatPriceDifference(claim, "en");
  return {
    kind: claim.kind,
    position: position(claim),
    currency: "currency" in claim ? claim.currency : claim.primary?.currency || claim.rival?.currency || null,
    primaryAmount: claim.primary?.amount ?? null,
    rivalAmount: claim.rival?.amount ?? null,
    gapAmount: "gap" in claim ? claim.gap : null,
    gapPercent: "percent" in claim ? claim.percent : null,
    unitBasis: claim.kind === "unit-normalized" ? claim.unitBasis : null,
    unit: claim.kind === "unit-normalized" ? claim.unit : null,
    primaryUnitAmount: claim.kind === "unit-normalized" ? claim.primaryUnitAmount : null,
    rivalUnitAmount: claim.kind === "unit-normalized" ? claim.rivalUnitAmount : null,
    unavailableReason: claim.kind === "both-observed"
      ? claim.reason
      : claim.kind === "approved-unparsed"
        ? "unparsed"
        : claim.kind === "one-observed" || claim.kind === "none-observed"
          ? "missing_price"
          : null,
    summary: copy.headline,
    detail: copy.detail,
    note: difference.note,
  };
}

function normalizedRecommendation(decision: JsonRecord): AgentComparison["recommendation"] {
  const actionPlan = object(decision.actionPlan);
  const action = cleanText(actionPlan.actionEn || decision.recommendedMove || actionPlan.actionAr, 500) || null;
  const rationale = cleanText(actionPlan.rationaleEn || decision.whyTheyMayWin || actionPlan.rationaleAr, 500) || null;
  return {
    action,
    rationale,
    source: actionPlan.source === "ai" ? "ai" : action || rationale ? "deterministic" : "unknown",
    leverType: cleanText(actionPlan.leverType, 80) || null,
    model: cleanText(actionPlan.model, 120) || null,
    promptVersion: cleanText(actionPlan.promptVersion, 120) || null,
    evidenceKeys: stringList(actionPlan.evidenceKeys, 20, 160),
  };
}

function normalizedComparison(value: StoredReportMatchPage["items"][number]): AgentComparison {
  const primary = object(value.primary);
  const rival = object(value.rival);
  const match = object(value.match);
  const assessment = object(match.assessment);
  const decision = object(match.decision);
  const approvedPrice = object(decision.priceComparison);
  const id = cleanText(value.key, 500);
  if (!MATCH_ID_PATTERN.test(id)) throw new ReportLoopFactsError("Authoritative comparison is missing its stable fact id.");
  const primaryProduct = normalizedProduct(primary, approvedPrice.primaryRaw, "primary", id);
  const rivalProduct = normalizedProduct(rival, approvedPrice.rivalRaw, "rival", id);
  const claim = resolvePriceClaim({
    comparisonValue: decision.priceComparison,
    primaryRaw: primaryProduct.price.display,
    rivalRaw: rivalProduct.price.display,
    primaryQuantity: primary.quantity,
    rivalQuantity: rival.quantity,
  });
  const verdict = cleanText(assessment.verdict, 80);
  const method = cleanText(assessment.method, 80);
  const confidence = finiteNumber(assessment.confidence);
  const score = finiteNumber(match.score);
  if (!(["same_product", "close_substitute", "search_result"] as string[]).includes(verdict)
    || !(["ai-hybrid", "direct-web-search"] as string[]).includes(method)
    || confidence === null || confidence < 0 || confidence > 1
    || score === null || score < 0 || score > 1
    || (verdict === "search_result") !== (method === "direct-web-search")) {
    throw new ReportLoopFactsError(`Authoritative comparison ${id} has inconsistent match facts.`);
  }
  return {
    id,
    primaryProduct,
    rivalProduct,
    match: {
      verdict: verdict as AgentComparison["match"]["verdict"],
      confidence,
      score,
      method: method as AgentComparison["match"]["method"],
      claimType: cleanText(assessment.claimType, 80) || "inferred",
      reasons: stringList(assessment.reasons),
      contradictions: stringList(assessment.contradictions),
      sharedTerms: stringList(match.sharedTerms, 20, 120),
      category: cleanText(assessment.normalizedCategory, 160) || null,
      variant: cleanText(assessment.normalizedVariant, 160) || null,
      size: cleanText(assessment.normalizedSize, 120) || null,
      model: cleanText(assessment.model, 120) || null,
      promptVersion: cleanText(assessment.promptVersion, 120) || null,
    },
    priceComparison: normalizedPriceComparison(claim),
    recommendation: normalizedRecommendation(decision),
  };
}

function validateMatchPage(matches: StoredReportMatchPage) {
  if (matches.authoritative !== true
    || !MATCH_ID_PATTERN.test(matches.manifestHash)
    || !Number.isInteger(matches.totalCount)
    || matches.totalCount < 0
    || !Number.isInteger(matches.directPriceCount)
    || matches.directPriceCount < 0
    || matches.directPriceCount > matches.totalCount
    || matches.items.length > 50) {
    throw new ReportLoopFactsError("Authoritative comparison manifest is inconsistent.");
  }
  let counted = 0;
  for (const [rawDomain, rawCount] of Object.entries(matches.domainCounts)) {
    const domain = canonicalDomain(rawDomain);
    const count = Number(rawCount);
    if (!domain || domain !== rawDomain || !Number.isInteger(count) || count < 1) {
      throw new ReportLoopFactsError("Authoritative competitor counts are inconsistent.");
    }
    counted += count;
  }
  if (counted !== matches.totalCount) throw new ReportLoopFactsError("Authoritative competitor counts do not cover every comparison.");
  if (matches.nextCursor) encodeAgentComparisonCursor("0".repeat(32), matches.nextCursor);
}

function validateComparisonBinding(item: AgentComparison, report: StoredReportSnapshot, competitorDomains: Set<string>) {
  const primaryDomain = canonicalDomain(report.run.primaryDomain);
  if (item.primaryProduct.domain !== primaryDomain
    || item.rivalProduct.domain === primaryDomain
    || !competitorDomains.has(item.rivalProduct.domain)
    || item.primaryProduct.price.currency !== item.rivalProduct.price.currency) {
    throw new ReportLoopFactsError(`Authoritative comparison ${item.id} is not bound to the report market and competitor roll-up.`);
  }
  const finishedAt = Date.parse(report.run.updatedAt);
  for (const product of [item.primaryProduct, item.rivalProduct]) {
    const observedAt = Date.parse(product.observedAt);
    if (!Number.isFinite(finishedAt)
      || observedAt < finishedAt - (366 * 24 * 60 * 60 * 1_000)
      || observedAt > finishedAt + (24 * 60 * 60 * 1_000)) {
      throw new ReportLoopFactsError(`Authoritative comparison ${item.id} has an invalid observation timestamp.`);
    }
  }
}

function reportBlocks(report: StoredReportSnapshot) {
  const stored = object(report.document);
  const document = object(stored.document);
  return list(document.blocks).map(object);
}

export function agentCompetitors(report: StoredReportSnapshot, matches: StoredReportMatchPage): AgentCompetitor[] {
  validateMatchPage(matches);
  const blocks = reportBlocks(report);
  const metadata = new Map(blocks.filter((block) => block.type === "competitor").map((block) => [canonicalDomain(block.domain), block]));
  return Object.entries(matches.domainCounts)
    .map(([domainValue, countValue]) => {
      const domain = canonicalDomain(domainValue);
      const comparisonCount = Math.max(0, Math.floor(Number(countValue) || 0));
      const details = metadata.get(domain) || {};
      const score = finiteNumber(details.verificationScore);
      return {
        domain,
        name: cleanText(details.companyName, 200) || domain,
        comparisonCount,
        comparisonSharePercent: matches.totalCount > 0 ? Math.round((comparisonCount / matches.totalCount) * 10_000) / 100 : 0,
        relationship: cleanText(details.relationship, 240) || "priced product comparison",
        confidence: cleanText(details.confidence, 80) || "Verified pair",
        reason: cleanText(details.reason || details.description, 500) || "Included because this seller supplies at least one accepted priced product comparison.",
        verificationScore: score === null ? null : Math.max(0, Math.min(100, score)),
        websiteUrl: publicUrl(details.websiteSourceUrl || details.discoverySourceUrl) || null,
      };
    })
    .filter((item) => item.domain && item.comparisonCount > 0)
    .sort((left, right) => right.comparisonCount - left.comparisonCount || left.domain.localeCompare(right.domain));
}

export function agentComparisons(matches: StoredReportMatchPage, report: StoredReportSnapshot): AgentComparison[] {
  validateMatchPage(matches);
  const items = matches.items.map(normalizedComparison);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ReportLoopFactsError("Authoritative comparisons contain duplicate ids.");
  const competitorDomains = new Set(Object.keys(matches.domainCounts));
  for (const item of items) validateComparisonBinding(item, report, competitorDomains);
  return items;
}
