import { buildAIProductComparison, type JudgeBatchCheckpoint, type JudgeBatchCheckpointKey, type PinnedProductPair } from "../../lib/ai-product-matching.ts";
import { canonicalDomain, normalizeDomain } from "../../lib/domain.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../lib/internal-auth.ts";
import type { ProductRecord } from "../../lib/product-intelligence.ts";
import { canonicalGtin, parseCanonicalQuantity, type ProductIdentifiers } from "../../lib/product-normalization.ts";
import { publicHttpUrl } from "../../lib/public-url.ts";
import { loadReportMatchBatchCheckpoints, loadReportProductEntitlement, saveReportMatchBatchCheckpoint } from "../../lib/report-store.ts";

const MAX_CATALOGS = 7;
const MAX_PRIMARY_PRODUCTS = 1_000;
const MAX_RIVAL_PRODUCTS = 600;
const MAX_SUBMITTED_PRODUCTS_PER_CATALOG = 5_000;
export const MAX_MATCH_BODY_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_PRODUCT_ANALYSIS_LIMIT = 20;
const PLAN_PRODUCT_LIMITS = new Set([20, 50, 500, 1_000]);

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function strings(value: unknown, limit: number, itemLimit: number) {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => text(item, itemLimit)).filter(Boolean) : [];
}

function publicUrl(value: unknown, domain: string) {
  try {
    const url = new URL(publicHttpUrl(text(value, 1_000), false, 1_000));
    return canonicalDomain(url.hostname) === canonicalDomain(domain) ? url.toString() : "";
  } catch {
    return "";
  }
}

function publicImageUrl(value: unknown) {
  try {
    const url = new URL(text(value, 1_000));
    normalizeDomain(url.hostname);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function identifiers(value: unknown): ProductIdentifiers | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const gtins = [...new Set((Array.isArray(item.gtins) ? item.gtins.slice(0, 8) : []).map(canonicalGtin).filter((gtin): gtin is string => Boolean(gtin)))];
  const sku = text(item.sku, 120) || undefined;
  const mpn = text(item.mpn, 120) || undefined;
  const brand = text(item.brand, 120) || undefined;
  return gtins.length || sku || mpn || brand ? { gtins, sku, mpn, brand } : undefined;
}

function product(value: unknown, catalogDomain: string): ProductRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const name = text(item.name, 160);
  const sourceUrl = publicUrl(item.sourceUrl, catalogDomain);
  if (!name || !sourceUrl) return null;
  const allowedTypes = new Set<ProductRecord["jsonLdType"]>(["Product", "SoftwareApplication", "Service", "PageSignal"]);
  const allowedOwnership = new Set<ProductRecord["ownership"]>(["self-declared-brand", "path-inferred", "third-party-referenced"]);
  const allowedExtraction = new Set<ProductRecord["extraction"]>(["json-ld", "storefront-api", "page-signal", "sitemap"]);
  const priceSignals = Array.isArray(item.priceSignals) ? item.priceSignals.slice(0, 8).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const signal = value as Record<string, unknown>;
    const amount = typeof signal.amount === "number" && Number.isFinite(signal.amount) ? signal.amount : undefined;
    return [{ raw: text(signal.raw, 100), currency: text(signal.currency, 12) || undefined, amount, period: text(signal.period, 40) || undefined }];
  }) : [];
  const attributes = strings(item.attributes, 12, 120);
  const quantityAttributes = attributes.filter((value) => !/^(?:barcode|ean|gtin|isbn|mpn|sku|upc)\s*:/i.test(value));
  return {
    id: text(item.id, 300) || `${canonicalDomain(catalogDomain)}-${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`,
    domain: canonicalDomain(catalogDomain),
    name,
    normalizedName: text(item.normalizedName, 200) || name.toLowerCase().normalize("NFKC"),
    description: text(item.description, 400),
    category: text(item.category, 120),
    jsonLdType: allowedTypes.has(item.jsonLdType as ProductRecord["jsonLdType"]) ? item.jsonLdType as ProductRecord["jsonLdType"] : "PageSignal",
    priceSignals,
    attributes,
    ownership: allowedOwnership.has(item.ownership as ProductRecord["ownership"]) ? item.ownership as ProductRecord["ownership"] : "path-inferred",
    extraction: allowedExtraction.has(item.extraction as ProductRecord["extraction"]) ? item.extraction as ProductRecord["extraction"] : "page-signal",
    confidence: item.confidence === "High" ? "High" : "Medium",
    sourceUrl,
    imageUrl: publicImageUrl(item.imageUrl),
    observedAt: text(item.observedAt, 40) || new Date().toISOString(),
    claimIds: strings(item.claimIds, 20, 300),
    identifiers: identifiers(item.identifiers),
    quantity: parseCanonicalQuantity(`${name} ${quantityAttributes.join(" ")}`) || undefined,
  };
}

function requestedPinIds(value: unknown) {
  const ids = new Map<string, Set<string>>();
  if (!Array.isArray(value)) return ids;
  for (const entry of value.slice(0, 12)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const primaryId = text(item.primaryId, 300);
    const rivalDomain = canonicalDomain(text(item.rivalDomain, 300));
    const rivalId = text(item.rivalId, 300);
    if (primaryId) ids.set("$primary", new Set([...(ids.get("$primary") || []), primaryId]));
    if (rivalDomain && rivalId) ids.set(rivalDomain, new Set([...(ids.get(rivalDomain) || []), rivalId]));
  }
  return ids;
}

async function boundedJsonBody(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_MATCH_BODY_BYTES)) throw new Error("The product-matching request body is too large.");
  if (!request.body) throw new Error("A JSON request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_MATCH_BODY_BYTES) {
      await reader.cancel();
      throw new Error("The product-matching request body is too large.");
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return JSON.parse(raw) as Record<string, unknown>;
}

export function parseCatalogs(value: unknown, primaryDomain = "", requestedPins?: unknown) {
  if (!Array.isArray(value)) return [];
  const pinIds = requestedPinIds(requestedPins);
  const rawProductDomains = new Map<string, string>();
  const catalogDomains = new Set<string>();
  let invalidIdentity = false;
  const catalogs = value.slice(0, MAX_CATALOGS).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const domain = canonicalDomain(text(item.domain, 300));
    if (!domain || !Array.isArray(item.products) || item.products.length > MAX_SUBMITTED_PRODUCTS_PER_CATALOG) return [];
    if (catalogDomains.has(domain)) invalidIdentity = true;
    catalogDomains.add(domain);
    const deduplicatedValues: unknown[] = [];
    const indexById = new Map<string, number>();
    const conflictedIds = new Set<string>();
    for (const value of item.products) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const id = text((value as Record<string, unknown>).id, 300);
      if (!id) {
        deduplicatedValues.push(value);
        continue;
      }
      const previousDomain = rawProductDomains.get(id);
      if (previousDomain && previousDomain !== domain) invalidIdentity = true;
      else rawProductDomains.set(id, domain);
      if (conflictedIds.has(id)) continue;
      const existingIndex = indexById.get(id);
      if (existingIndex === undefined) {
        indexById.set(id, deduplicatedValues.length);
        deduplicatedValues.push(value);
        continue;
      }
      const existing = deduplicatedValues[existingIndex] as Record<string, unknown> | null;
      const existingSource = existing ? publicUrl(existing.sourceUrl, domain).split("#")[0].replace(/\/$/, "") : "";
      const duplicateSource = publicUrl((value as Record<string, unknown>).sourceUrl, domain).split("#")[0].replace(/\/$/, "");
      if (existingSource && existingSource === duplicateSource) continue;
      deduplicatedValues[existingIndex] = null;
      conflictedIds.add(id);
    }
    const catalogLimit = domain === canonicalDomain(primaryDomain) ? MAX_PRIMARY_PRODUCTS : MAX_RIVAL_PRODUCTS;
    const wanted = pinIds.get(domain === canonicalDomain(primaryDomain) ? "$primary" : domain) || new Set<string>();
    const pinned: unknown[] = [];
    const ordinary: unknown[] = [];
    const retainedPinnedIds = new Set<string>();
    for (const value of deduplicatedValues) {
      if (!value) continue;
      const id = value && typeof value === "object" && !Array.isArray(value) ? text((value as Record<string, unknown>).id, 300) : "";
      if (id && wanted.has(id)) {
        if (!retainedPinnedIds.has(id)) {
          retainedPinnedIds.add(id);
          pinned.push(value);
        }
      } else if (ordinary.length < catalogLimit) ordinary.push(value);
    }
    const selected = [...pinned, ...ordinary].slice(0, catalogLimit);
    const products = selected.flatMap((value) => {
      const parsed = product(value, domain);
      return parsed ? [parsed] : [];
    });
    return [{ domain, products }];
  });
  if (invalidIdentity) return [];
  const productIds = new Set<string>();
  for (const catalog of catalogs) for (const item of catalog.products) {
    if (productIds.has(item.id)) return [];
    productIds.add(item.id);
  }
  return catalogs;
}

export function productAnalysisLimit(value?: string) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && PLAN_PRODUCT_LIMITS.has(parsed) ? parsed : DEFAULT_PRODUCT_ANALYSIS_LIMIT;
}

export function productAnalysisBudgetMs(limit: number) {
  return limit <= 60 ? 90_000 : limit <= 500 ? 360_000 : 720_000;
}

export function productBackfillPoolSize(resultTarget: number) {
  const boundedTarget = Math.max(1, Math.min(MAX_PRIMARY_PRODUCTS, Math.floor(resultTarget)));
  return Math.min(MAX_PRIMARY_PRODUCTS, Math.max(boundedTarget, boundedTarget * 4));
}

export function parsePinnedPairs(value: unknown, catalogs: Array<{ domain: string; products: ProductRecord[] }>, primaryDomain: string): PinnedProductPair[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 12) return [];
  const primaryIds = new Set(catalogs.find((catalog) => canonicalDomain(catalog.domain) === canonicalDomain(primaryDomain))?.products.map((product) => product.id) || []);
  const rivalIds = new Map(catalogs.filter((catalog) => canonicalDomain(catalog.domain) !== canonicalDomain(primaryDomain)).map((catalog) => [canonicalDomain(catalog.domain), new Set(catalog.products.map((product) => product.id))]));
  const pairs: PinnedProductPair[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const primaryId = text(item.primaryId, 300);
    const rivalDomain = canonicalDomain(text(item.rivalDomain, 300));
    const rivalId = text(item.rivalId, 300);
    if (!primaryIds.has(primaryId) || !rivalDomain || !rivalIds.get(rivalDomain)?.has(rivalId)) return [];
    if (!pairs.some((other) => other.primaryId === primaryId && other.rivalDomain === rivalDomain && other.rivalId === rivalId)) pairs.push({ primaryId, rivalDomain, rivalId });
  }
  const primaryAssignments = new Set<string>();
  const rivalAssignments = new Set<string>();
  for (const pair of pairs) {
    const primaryKey = `${pair.primaryId}|${pair.rivalDomain}`;
    const rivalKey = `${pair.rivalDomain}|${pair.rivalId}`;
    if (primaryAssignments.has(primaryKey) || rivalAssignments.has(rivalKey)) return [];
    primaryAssignments.add(primaryKey);
    rivalAssignments.add(rivalKey);
  }
  return pairs;
}

type MatchServices = {
  build: typeof buildAIProductComparison;
  loadCheckpoints: typeof loadReportMatchBatchCheckpoints;
  saveCheckpoint: typeof saveReportMatchBatchCheckpoint;
  loadEntitlement: typeof loadReportProductEntitlement;
};

const liveServices: MatchServices = {
  build: buildAIProductComparison,
  loadCheckpoints: loadReportMatchBatchCheckpoints,
  saveCheckpoint: saveReportMatchBatchCheckpoint,
  loadEntitlement: loadReportProductEntitlement,
};

export function createMatchHandler(services: MatchServices = liveServices, expectedToken?: string) {
  return async function matchHandler(request: Request) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    try {
      const body = await boundedJsonBody(request) as { publicId?: unknown; reportAttempt?: unknown; reportObservedAt?: unknown; primaryDomain?: unknown; marketCountryCode?: unknown; productLimit?: unknown; catalogs?: unknown; pinnedPairs?: unknown };
      const publicId = text(body.publicId, 32);
      const reportAttempt = Number(body.reportAttempt);
      const primaryDomain = canonicalDomain(text(body.primaryDomain, 300));
      const reportObservedAt = text(body.reportObservedAt, 40);
      const marketCountryCode = text(body.marketCountryCode, 2).toUpperCase();
      if (body.pinnedPairs !== undefined && !Array.isArray(body.pinnedPairs)) return Response.json({ ok: false, error: "Pinned product pairs must be an array." }, { status: 400 });
      const catalogs = parseCatalogs(body.catalogs, primaryDomain, body.pinnedPairs);
      const pinnedPairs = parsePinnedPairs(body.pinnedPairs, catalogs, primaryDomain);
      if (Array.isArray(body.pinnedPairs) && body.pinnedPairs.length && !pinnedPairs.length) return Response.json({ ok: false, error: "Pinned product pairs must reference unique catalog records and form one-to-one assignments." }, { status: 400 });
      const hasReportAttempt = Boolean(publicId || body.reportAttempt !== undefined);
      if (hasReportAttempt && (!/^[a-f0-9]{32}$/.test(publicId) || !Number.isInteger(reportAttempt) || reportAttempt < 1)) return Response.json({ ok: false, error: "A complete active report attempt is required for checkpointed matching." }, { status: 400 });
      if (!primaryDomain || !catalogs.some((catalog) => catalog.domain === primaryDomain && catalog.products.length)) return Response.json({ ok: false, error: "A crawled primary product catalog is required." }, { status: 400 });
      const entitlement = hasReportAttempt ? await services.loadEntitlement(publicId, reportAttempt) : null;
      const resultTarget = entitlement?.productLimit || DEFAULT_PRODUCT_ANALYSIS_LIMIT;
      if (hasReportAttempt && Number(body.productLimit) !== resultTarget) return Response.json({ ok: false, error: "The report product limit does not match its persisted entitlement." }, { status: 409 });
      if (hasReportAttempt && reportObservedAt !== entitlement?.reportObservedAt) return Response.json({ ok: false, error: "The report observation timestamp does not match its persisted identity." }, { status: 409 });
      if (body.marketCountryCode !== undefined && !/^[A-Z]{2}$/.test(marketCountryCode)) return Response.json({ ok: false, error: "The report market country code must be a two-letter country code." }, { status: 400 });
      const maxPrimaryProducts = productBackfillPoolSize(resultTarget);
      const checkpointOptions = hasReportAttempt ? {
        loadJudgeBatchCheckpoint: async (key: JudgeBatchCheckpointKey) => {
          const checkpoints = await services.loadCheckpoints(publicId, { attemptNumber: reportAttempt, batchIndex: key.batchIndex });
          const checkpoint = checkpoints[0];
          return checkpoint?.inputHash === key.batchHash ? checkpoint.result : null;
        },
        saveJudgeBatchCheckpoint: async (key: JudgeBatchCheckpointKey, checkpoint: JudgeBatchCheckpoint) => {
          await services.saveCheckpoint(publicId, {
            attemptNumber: reportAttempt,
            batchIndex: key.batchIndex,
            inputHash: key.batchHash,
            result: checkpoint,
          });
        },
      } : {};
      const comparison = await services.build(primaryDomain, catalogs, {
        maxPrimaryProducts,
        totalBudgetMs: productAnalysisBudgetMs(maxPrimaryProducts),
        referenceTimeMs: Date.parse(reportObservedAt) || Date.now(),
        marketCountryCode,
        pinnedPairs,
        ...checkpointOptions,
      });
      return Response.json({ ok: true, comparison: comparison.matching ? { ...comparison, matching: { ...comparison.matching, resultTarget } } : comparison });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "AI product matching was unavailable." }, { status: 400 });
    }
  };
}

export const POST = createMatchHandler();
