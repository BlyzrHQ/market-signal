import { buildAIProductComparison } from "../../lib/ai-product-matching.ts";
import { canonicalDomain, normalizeDomain } from "../../lib/domain.ts";
import type { ProductRecord } from "../../lib/product-intelligence.ts";
import { canonicalGtin, parseCanonicalQuantity, type ProductIdentifiers } from "../../lib/product-normalization.ts";

const MAX_CATALOGS = 7;
const MAX_PRODUCTS_PER_CATALOG = 600;

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function strings(value: unknown, limit: number, itemLimit: number) {
  return Array.isArray(value) ? value.map((item) => text(item, itemLimit)).filter(Boolean).slice(0, limit) : [];
}

function publicUrl(value: unknown, domain: string) {
  try {
    const url = new URL(text(value, 1_000));
    return /^https?:$/.test(url.protocol) && canonicalDomain(url.hostname) === canonicalDomain(domain) ? url.toString() : "";
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
  const gtins = [...new Set((Array.isArray(item.gtins) ? item.gtins : []).map(canonicalGtin).filter((gtin): gtin is string => Boolean(gtin)))].slice(0, 8);
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
  const allowedExtraction = new Set<ProductRecord["extraction"]>(["json-ld", "page-signal", "sitemap"]);
  const priceSignals = Array.isArray(item.priceSignals) ? item.priceSignals.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const signal = value as Record<string, unknown>;
    const amount = typeof signal.amount === "number" && Number.isFinite(signal.amount) ? signal.amount : undefined;
    return [{ raw: text(signal.raw, 100), currency: text(signal.currency, 12) || undefined, amount, period: text(signal.period, 40) || undefined }];
  }).slice(0, 8) : [];
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

export function parseCatalogs(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CATALOGS).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const domain = canonicalDomain(text(item.domain, 300));
    if (!domain || !Array.isArray(item.products)) return [];
    const products = item.products.slice(0, MAX_PRODUCTS_PER_CATALOG).flatMap((value) => {
      const parsed = product(value, domain);
      return parsed ? [parsed] : [];
    });
    return [{ domain, products }];
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { primaryDomain?: unknown; catalogs?: unknown };
    const primaryDomain = canonicalDomain(text(body.primaryDomain, 300));
    const catalogs = parseCatalogs(body.catalogs);
    if (!primaryDomain || !catalogs.some((catalog) => catalog.domain === primaryDomain && catalog.products.length)) return Response.json({ ok: false, error: "A crawled primary product catalog is required." }, { status: 400 });
    const comparison = await buildAIProductComparison(primaryDomain, catalogs);
    return Response.json({ ok: true, comparison });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "AI product matching was unavailable." }, { status: 400 });
  }
}
