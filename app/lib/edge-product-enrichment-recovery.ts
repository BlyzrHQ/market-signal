import { canonicalDomain } from "./domain.ts";
import { isCatalogReplacementProduct, type ProductEnrichmentTarget, type ProductRecord } from "./product-intelligence.ts";
import { bilingualNormalize, canonicalGtin, parseCanonicalQuantity, type ProductIdentifiers } from "./product-normalization.ts";
import type { ProductEnrichmentCoverage } from "./storefront-product-enrichment.ts";

export const EDGE_PRODUCT_ENRICHMENT_MARKER = "x-market-signal-edge-product-fallback";
const ALLOWED_EDGE_ENRICH_URL = "https://market-signal.abdulla617931.chatgpt.site/api/enrich-products";
const EDGE_TIMEOUT_MS = 45_000;
const EDGE_MAX_RESPONSE_BYTES = 2_000_000;
const EDGE_RECOVERABLE_HTTP_STATUSES = new Set([401, 403, 407, 429, 451]);

type EdgeResult = { ok?: unknown; products?: unknown; coverage?: unknown };

function canonicalProductUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return `${canonicalDomain(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch { return ""; }
}

export function validatedEdgeEnrichmentUrl(value: string | undefined, requestUrl: string) {
  if (!value?.trim()) return null;
  try {
    const candidate = new URL(value);
    if (candidate.toString() !== ALLOWED_EDGE_ENRICH_URL || candidate.origin === new URL(requestUrl).origin) return null;
    if (candidate.protocol !== "https:" || candidate.port || candidate.pathname !== "/api/enrich-products") return null;
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;
    return candidate;
  } catch { return null; }
}

export function edgeRecoverableProductTargets(
  local: { products: ProductRecord[]; coverage: ProductEnrichmentCoverage },
  targets: ProductEnrichmentTarget[],
) {
  const locallyResolved = new Set(local.products.map((product) => product.id));
  const eligibleIds = new Set(local.coverage.gaps.flatMap((gap) => {
    if (locallyResolved.has(gap.productId)) return [];
    if (gap.code === "robots_unreachable") return [gap.productId];
    if (gap.code !== "fetch_failed") return [];
    if (gap.failureKind === "network" && gap.httpStatus === 0) return [gap.productId];
    return gap.failureKind === "http" && EDGE_RECOVERABLE_HTTP_STATUSES.has(Number(gap.httpStatus)) ? [gap.productId] : [];
  }));
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (!eligibleIds.has(target.productId) || seen.has(target.productId)) return false;
    seen.add(target.productId);
    return true;
  });
}

function boundedString(value: unknown, limit: number) {
  return typeof value === "string" && value.length <= limit ? value : null;
}

function sanitizeIdentifiers(value: unknown): ProductIdentifiers | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.gtins) || record.gtins.length > 20) return null;
  const gtins = record.gtins.map(canonicalGtin);
  if (gtins.some((entry) => !entry)) return null;
  const read = (key: "sku" | "mpn" | "brand") => record[key] === undefined ? undefined : boundedString(record[key], 120);
  const sku = read("sku");
  const mpn = read("mpn");
  const brand = read("brand");
  if (sku === null || mpn === null || brand === null) return null;
  return { gtins: gtins as string[], ...(sku ? { sku } : {}), ...(mpn ? { mpn } : {}), ...(brand ? { brand } : {}) };
}

function sanitizeProduct(value: unknown, target: ProductEnrichmentTarget): ProductRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = boundedString(item.id, 300);
  const domain = boundedString(item.domain, 300);
  const name = boundedString(item.name, 500);
  const normalizedName = boundedString(item.normalizedName, 500);
  const description = boundedString(item.description, 5_000);
  const category = boundedString(item.category, 300);
  const sourceUrl = boundedString(item.sourceUrl, 1_000);
  const imageUrl = boundedString(item.imageUrl, 2_000);
  const observedAt = boundedString(item.observedAt, 100);
  if (!id || id !== target.productId || !domain || canonicalDomain(domain) !== canonicalDomain(target.domain)) return null;
  if (!name || normalizedName === null || description === null || category === null || !sourceUrl || imageUrl === null || !observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
  if (canonicalProductUrl(sourceUrl) !== canonicalProductUrl(target.sourceUrl)) return null;
  if (imageUrl === "") {
    // Empty images are valid gaps; non-empty images must be HTTPS.
  } else {
    try { if (new URL(imageUrl).protocol !== "https:") return null; } catch { return null; }
  }
  if (!Array.isArray(item.priceSignals) || item.priceSignals.length > 24) return null;
  const priceSignals = item.priceSignals.flatMap((signal) => {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) return [];
    const entry = signal as Record<string, unknown>;
    const raw = boundedString(entry.raw, 100);
    const currency = boundedString(entry.currency, 12);
    const amount = entry.amount;
    if (!raw || !currency || !/^[A-Z]{3}$/.test(currency) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return [];
    const period = entry.period === undefined ? undefined : boundedString(entry.period, 40);
    if (entry.period !== undefined && period === null) return [];
    return [{ raw, currency, amount, ...(period ? { period } : {}) }];
  });
  if (priceSignals.length !== item.priceSignals.length) return null;
  if (!Array.isArray(item.attributes) || item.attributes.length > 100 || item.attributes.some((entry) => boundedString(entry, 500) === null)) return null;
  if (!Array.isArray(item.claimIds) || item.claimIds.length > 100 || item.claimIds.some((entry) => boundedString(entry, 500) === null)) return null;
  if (!['Product', 'PageSignal'].includes(String(item.jsonLdType)) || !['self-declared-brand', 'path-inferred', 'third-party-referenced'].includes(String(item.ownership))) return null;
  if (!['json-ld', 'storefront-api', 'page-signal', 'sitemap'].includes(String(item.extraction)) || !['High', 'Medium'].includes(String(item.confidence))) return null;
  const identifiers = sanitizeIdentifiers(item.identifiers);
  if (identifiers === null) return null;
  const product = {
    id,
    domain: canonicalDomain(domain),
    name,
    normalizedName: normalizedName || "",
    description: description || "",
    category: category || "",
    jsonLdType: item.jsonLdType as ProductRecord["jsonLdType"],
    priceSignals,
    attributes: item.attributes as string[],
    ownership: item.ownership as ProductRecord["ownership"],
    extraction: item.extraction as ProductRecord["extraction"],
    confidence: item.confidence as ProductRecord["confidence"],
    sourceUrl,
    imageUrl: imageUrl || "",
    observedAt,
    claimIds: item.claimIds as string[],
    ...(identifiers ? { identifiers } : {}),
  };
  if (isCatalogReplacementProduct(product as ProductRecord) && target.allowCatalogReplacement !== true) return null;
  return isCatalogReplacementProduct(product as ProductRecord)
    ? { ...product, normalizedName: bilingualNormalize(name), quantity: parseCanonicalQuantity(name) || undefined } as ProductRecord
    : product as ProductRecord;
}

function validateResult(parsed: EdgeResult, targets: ProductEnrichmentTarget[]) {
  if (parsed.ok !== true || !Array.isArray(parsed.products) || parsed.products.length > targets.length) return null;
  if (!parsed.coverage || typeof parsed.coverage !== "object" || Array.isArray(parsed.coverage)) return null;
  const coverage = parsed.coverage as Record<string, unknown>;
  for (const key of ["pagesRequested", "pagesFetched"]) {
    if (!Number.isInteger(coverage[key]) || Number(coverage[key]) < 0 || Number(coverage[key]) > targets.length) return null;
  }
  if (Number(coverage.pagesRequested) !== targets.length || Number(coverage.pagesFetched) !== parsed.products.length || Number(coverage.pagesFetched) > Number(coverage.pagesRequested)) return null;
  if (!Number.isInteger(coverage.maxPages) || Number(coverage.maxPages) < Number(coverage.pagesRequested) || Number(coverage.maxPages) > 64) return null;
  const byId = new Map(targets.map((target) => [target.productId, target]));
  const products: ProductRecord[] = [];
  const seen = new Set<string>();
  for (const value of parsed.products) {
    const id = value && typeof value === "object" && !Array.isArray(value) ? String((value as Record<string, unknown>).id || "") : "";
    const target = byId.get(id);
    if (!target || seen.has(id)) return null;
    const product = sanitizeProduct(value, target);
    if (!product) return null;
    seen.add(id);
    products.push(product);
  }
  if (Number(coverage.pagesFetched) !== products.length) return null;
  return products;
}

export async function recoverProductEnrichmentThroughEdge(
  targets: ProductEnrichmentTarget[],
  options: { configuredUrl?: string; requestUrl: string; callbackToken: string; deployTarget?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number },
) {
  const edgeUrl = validatedEdgeEnrichmentUrl(options.configuredUrl, options.requestUrl);
  if (!targets.length || targets.length > 64 || !edgeUrl || options.deployTarget !== "node" || options.callbackToken.length < 32 || /\s/.test(options.callbackToken)) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? EDGE_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(edgeUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${options.callbackToken}`,
        [EDGE_PRODUCT_ENRICHMENT_MARKER]: "1",
      },
      body: JSON.stringify({ targets }),
    });
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get("content-type") || "")) return null;
    const maxBytes = options.maxResponseBytes ?? EDGE_MAX_RESPONSE_BYTES;
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > maxBytes) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return validateResult(JSON.parse(new TextDecoder().decode(buffer)) as EdgeResult, targets);
  } catch { return null; } finally { clearTimeout(timeout); }
}

export function mergeEdgeProductEnrichment(
  local: { products: ProductRecord[]; coverage: ProductEnrichmentCoverage },
  eligibleTargets: ProductEnrichmentTarget[],
  recovered: ProductRecord[] | null | undefined,
  provider: string,
) {
  if (recovered === undefined) return local;
  const recoveredIds = new Set((recovered || []).map((product) => product.id));
  const retainedGaps = local.coverage.gaps.filter((gap) => !recoveredIds.has(gap.productId));
  if (recovered === null) retainedGaps.push({
    url: eligibleTargets[0]?.sourceUrl || "https://market-signal.abdulla617931.chatgpt.site/api/enrich-products",
    productId: eligibleTargets[0]?.productId || "edge-enrichment",
    role: eligibleTargets[0]?.role || "primary",
    reason: "The configured edge could not return a validated selected-product enrichment result.",
    code: "fetch_failed",
  });
  return {
    products: [...local.products, ...(recovered || [])],
    coverage: {
      ...local.coverage,
      pagesFetched: local.coverage.pagesFetched + (recovered?.length || 0),
      gaps: retainedGaps,
      edgeRecovery: { recovered: recovered?.length || 0, requested: eligibleTargets.length, provider, observedAt: new Date().toISOString() },
    },
  };
}
