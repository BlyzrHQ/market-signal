export type ProductPriceSignal = {
  raw: string;
  currency?: string;
  amount?: number;
  period?: string;
};

export type ProductRecord = {
  id: string;
  domain: string;
  name: string;
  normalizedName: string;
  description: string;
  category: string;
  jsonLdType: "Product" | "SoftwareApplication" | "Service" | "PageSignal";
  priceSignals: ProductPriceSignal[];
  attributes: string[];
  ownership: "self-declared-brand" | "path-inferred" | "third-party-referenced";
  extraction: "json-ld" | "page-signal";
  confidence: "High" | "Medium";
  sourceUrl: string;
  observedAt: string;
  claimIds: string[];
};

export type ProductExtractionResult = {
  products: ProductRecord[];
  thirdPartyReferenced: ProductRecord[];
  gaps: string[];
};

export type ProductMatch = {
  domain: string;
  product: ProductRecord | null;
  score: number;
  confidence: "Medium" | "Low" | null;
  sharedTerms: string[];
  claimIds: string[];
};

export type ProductComparison = {
  primaryDomain: string;
  comparisonDomains: string[];
  rows: Array<{ primary: ProductRecord; matches: ProductMatch[] }>;
  unmatched: Array<{ domain: string; products: ProductRecord[] }>;
};

type JsonRecord = Record<string, unknown>;

const PRODUCT_TYPES = new Set(["Product", "SoftwareApplication", "Service"]);
const PRODUCT_PATH = /\/(?:billing|checkout|invoices?|payments?|subscriptions?|products?|shop|store|collections?|catalog|pricing|plans?|solutions?|services?|platform|features?)(?:\/|$)/i;
const EXCLUDED_PATH = /\/(?:about|articles?|blog|careers?|case-studies|company|contact|customers?|docs?|events?|guides?|help|jobs?|legal|news|partners?|press|privacy|resources?|security|stories|support|terms)(?:\/|$)/i;
const PRODUCT_HEADING = /\b(?:billing|checkout|invoices?|payments?|plan|pricing|subscriptions?|tier|package|product|service|solution|feature|includes?|built for)\b/i;
const PRICING_PATH = /\/(?:pricing|plans?)(?:\/|$)/i;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "our", "the", "their", "this", "to", "with", "your",
]);
const GENERIC_TOKENS = new Set([
  "app", "basic", "business", "edition", "enterprise", "essential", "free", "plus", "plan", "platform", "premium", "pro", "product", "saas", "service", "software", "solution", "starter", "suite",
]);

function clean(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, " ").trim();
}

function text(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return clean(String(value));
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  return "";
}

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(records);
  return value && typeof value === "object" ? [value as JsonRecord] : [];
}

function canonicalHost(value: string) {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  }
}

function normalized(value: string) {
  return clean(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string, includeGeneric = false) {
  return [...new Set(normalized(value).split(/\s+/).filter((token) => token.length > 1 && !STOPWORDS.has(token) && (includeGeneric || !GENERIC_TOKENS.has(token))))];
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function slug(value: string) {
  return normalized(value).replace(/\s+/g, "-").slice(0, 48) || "unnamed";
}

function jsonLdNodes(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  if (!value || typeof value !== "object") return [];
  const record = value as JsonRecord;
  return [record, ...jsonLdNodes(record["@graph"]), ...jsonLdNodes(record.mainEntity), ...jsonLdNodes(record.itemListElement)];
}

function nodeType(record: JsonRecord): ProductRecord["jsonLdType"] | null {
  const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
  const match = types.find((value) => typeof value === "string" && PRODUCT_TYPES.has(value));
  return typeof match === "string" ? match as ProductRecord["jsonLdType"] : null;
}

function periodFrom(value: string) {
  const match = value.match(/\/(?:\s*)?(month|mo|year|yr|week|day|user)/i);
  return match?.[1]?.toLowerCase();
}

function priceSignal(rawValue: unknown, currencyValue?: unknown): ProductPriceSignal | null {
  const rawText = text(rawValue);
  if (!rawText) return null;
  const currency = text(currencyValue).toUpperCase() || undefined;
  const amountMatch = rawText.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const amount = amountMatch ? Number(amountMatch[0]) : undefined;
  const raw = currency && !rawText.toUpperCase().includes(currency) ? `${currency} ${rawText}` : rawText;
  return { raw: raw.slice(0, 120), currency, amount: Number.isFinite(amount) ? amount : undefined, period: periodFrom(raw) };
}

function offerSignals(value: unknown): ProductPriceSignal[] {
  const found: ProductPriceSignal[] = [];
  for (const offer of records(value)) {
    const currency = offer.priceCurrency;
    for (const key of ["price", "lowPrice", "highPrice"] as const) {
      const signal = priceSignal(offer[key], currency);
      if (signal) found.push(signal);
    }
    found.push(...offerSignals(offer.offers));
    found.push(...offerSignals(offer.priceSpecification));
  }
  return [...new Map(found.map((signal) => [signal.raw, signal])).values()].slice(0, 12);
}

function attributes(record: JsonRecord) {
  const values: string[] = [];
  for (const property of records(record.additionalProperty)) {
    const name = text(property.name || property.propertyID);
    const value = text(property.value);
    if (name && value) values.push(`${name}: ${value}`);
  }
  values.push(...(Array.isArray(record.featureList) ? record.featureList.map(text) : text(record.featureList).split(/[,;\n]/)).filter(Boolean));
  for (const key of ["applicationCategory", "operatingSystem", "sku", "mpn"] as const) {
    const value = text(record[key]);
    if (value) values.push(`${key}: ${value}`);
  }
  return [...new Set(values.map((value) => value.slice(0, 160)))].slice(0, 10);
}

function ownership(record: JsonRecord, domain: string, path: string): ProductRecord["ownership"] {
  const entities = [record.brand, record.manufacturer, record.provider].flatMap(records);
  const identity = canonicalHost(domain).split(".")[0].replace(/[^a-z0-9]/g, "");
  const owns = entities.some((entity) => {
    const entityUrl = text(entity.url || entity["@id"]);
    if (entityUrl && canonicalHost(entityUrl) === canonicalHost(domain)) return true;
    const entityName = normalized(text(entity.name)).replace(/[^a-z0-9]/g, "");
    return Boolean(entityName && identity && (entityName.includes(identity) || identity.includes(entityName)));
  });
  if (owns) return "self-declared-brand";
  if (entities.length) return "third-party-referenced";
  return PRODUCT_PATH.test(path) && !EXCLUDED_PATH.test(path) ? "path-inferred" : "third-party-referenced";
}

function makeId(domain: string, name: string, sourceUrl: string) {
  return `${canonicalHost(domain)}-product-${slug(name)}-${stableHash(`${canonicalHost(domain)}|${normalized(name)}|${sourceUrl}`)}`;
}

function productFromNode(record: JsonRecord, input: ProductExtractionInput): ProductRecord | null {
  const type = nodeType(record);
  const name = text(record.name || record.headline);
  if (!type || !name) return null;
  const relation = ownership(record, input.domain, new URL(input.sourceUrl).pathname);
  const id = makeId(input.domain, name, input.sourceUrl);
  return {
    id,
    domain: canonicalHost(input.domain),
    name: name.slice(0, 160),
    normalizedName: normalized(name),
    description: text(record.description).slice(0, 400),
    category: text(record.category || record.applicationCategory || record.serviceType).slice(0, 120),
    jsonLdType: type,
    priceSignals: offerSignals(record.offers),
    attributes: attributes(record),
    ownership: relation,
    extraction: "json-ld",
    confidence: relation === "self-declared-brand" ? "High" : "Medium",
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    claimIds: [`${id}-observed`],
  };
}

export type ProductExtractionInput = {
  document: string;
  sourceUrl: string;
  domain: string;
  observedAt: string;
  pageTitle: string;
  pageDescription: string;
  headings: string[];
  pagePriceSignals: string[];
};

export function isProductLikePage(input: Pick<ProductExtractionInput, "sourceUrl" | "domain" | "pageTitle" | "headings" | "pagePriceSignals">) {
  const path = new URL(input.sourceUrl).pathname;
  if (EXCLUDED_PATH.test(path)) return false;
  const structuredHeadings = input.headings.filter((heading) => PRODUCT_HEADING.test(heading));
  if (PRICING_PATH.test(path)) return input.pagePriceSignals.length > 0 && input.headings.some((heading) => /\b(?:plan|tier|package)\b/i.test(heading));
  if (PRODUCT_PATH.test(path)) return input.pagePriceSignals.length > 0 || structuredHeadings.length >= 2;
  return false;
}

export function extractProductsFromHtml(input: ProductExtractionInput): ProductExtractionResult {
  const products: ProductRecord[] = [];
  const thirdPartyReferenced: ProductRecord[] = [];
  const gaps: string[] = [];
  const scripts = [...input.document.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const parsed = JSON.parse((script[1] || "").trim());
      for (const node of jsonLdNodes(parsed)) {
        const record = productFromNode(node, input);
        if (!record) continue;
        if (record.ownership === "third-party-referenced") thirdPartyReferenced.push(record);
        else products.push(record);
      }
    } catch {
      gaps.push(`Malformed JSON-LD on ${input.sourceUrl} was skipped.`);
    }
  }
  if (!products.length && isProductLikePage(input)) {
    const titleName = clean(input.pageTitle.split(/\s+(?:\||—|–|-)\s+/)[0] || input.pageTitle);
    const observedHeading = input.headings.find((heading) => !/\b(?:logo|menu|skip navigation|home)\b/i.test(heading));
    const name = titleName && !/\b(?:logo|home)\b/i.test(titleName) ? titleName : clean(observedHeading || input.pageTitle);
    if (name) {
      const id = makeId(input.domain, name, input.sourceUrl);
      products.push({
        id,
        domain: canonicalHost(input.domain),
        name: name.slice(0, 160),
        normalizedName: normalized(name),
        description: clean(input.pageDescription).slice(0, 400),
        category: new URL(input.sourceUrl).pathname.split("/").filter(Boolean)[0] || "product page",
        jsonLdType: "PageSignal",
        priceSignals: input.pagePriceSignals.map((value) => priceSignal(value)).filter((value): value is ProductPriceSignal => Boolean(value)).slice(0, 12),
        attributes: input.headings.filter((heading) => normalized(heading) !== normalized(name)).slice(0, 8),
        ownership: "path-inferred",
        extraction: "page-signal",
        confidence: "Medium",
        sourceUrl: input.sourceUrl,
        observedAt: input.observedAt,
        claimIds: [`${id}-observed`],
      });
    }
  }
  const dedupe = (items: ProductRecord[]) => [...new Map(items.map((item) => [`${item.domain}|${item.normalizedName}|${item.sourceUrl}`, item])).values()];
  return { products: dedupe(products), thirdPartyReferenced: dedupe(thirdPartyReferenced), gaps: [...new Set(gaps)] };
}

export function selectPreferredProducts(items: ProductRecord[]) {
  const selected = new Map<string, ProductRecord>();
  for (const item of items) {
    const key = `${item.domain}|${item.normalizedName}`;
    const current = selected.get(key);
    if (!current || (item.confidence === "High" && current.confidence !== "High")) selected.set(key, item);
  }
  return [...selected.values()];
}

function fieldTokens(product: ProductRecord, value: string) {
  const identityTokens = new Set(tokens(canonicalHost(product.domain).split(".")[0], true));
  return tokens(value).filter((token) => !identityTokens.has(token));
}

function jaccard(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (!union.size) return 0;
  return [...leftSet].filter((token) => rightSet.has(token)).length / union.size;
}

export function scoreProductPair(primary: ProductRecord, candidate: ProductRecord) {
  const primaryName = fieldTokens(primary, primary.name);
  const candidateName = fieldTokens(candidate, candidate.name);
  const primaryCategory = fieldTokens(primary, primary.category);
  const candidateCategory = fieldTokens(candidate, candidate.category);
  const primaryDescription = fieldTokens(primary, primary.description);
  const candidateDescription = fieldTokens(candidate, candidate.description);
  const sharedNameTerms = primaryName.filter((token) => candidateName.includes(token));
  const sharedTerms = [...new Set([...sharedNameTerms, ...primaryCategory.filter((token) => candidateCategory.includes(token)), ...primaryDescription.filter((token) => candidateDescription.includes(token))])].sort();
  const score = (jaccard(primaryName, candidateName) * 0.5) + (jaccard(primaryCategory, candidateCategory) * 0.33) + (jaccard(primaryDescription, candidateDescription) * 0.17);
  const categoryOverlap = primaryCategory.some((token) => candidateCategory.includes(token));
  const incompatiblePhysicalService = new Set([primary.jsonLdType, candidate.jsonLdType]).has("Product") && new Set([primary.jsonLdType, candidate.jsonLdType]).has("Service") && !categoryOverlap;
  return { score: Number(score.toFixed(4)), sharedTerms, eligible: score >= 0.35 && sharedNameTerms.length > 0 && !incompatiblePhysicalService };
}

export function buildProductComparison(primaryDomain: string, catalogs: Array<{ domain: string; products: ProductRecord[] }>): ProductComparison {
  const canonicalPrimary = canonicalHost(primaryDomain);
  const primaryProducts = [...(catalogs.find((catalog) => canonicalHost(catalog.domain) === canonicalPrimary)?.products || [])].sort((left, right) => left.id.localeCompare(right.id));
  const competitors = catalogs.filter((catalog) => canonicalHost(catalog.domain) !== canonicalPrimary).map((catalog) => ({ ...catalog, domain: canonicalHost(catalog.domain), products: [...catalog.products].sort((left, right) => left.id.localeCompare(right.id)) }));
  const rows = primaryProducts.map((primary) => ({ primary, matches: [] as ProductMatch[] }));
  const unmatched: ProductComparison["unmatched"] = [];
  for (const competitor of competitors) {
    const pairs = primaryProducts.flatMap((primary) => competitor.products.map((product) => ({ primary, product, ...scoreProductPair(primary, product) }))).filter((pair) => pair.eligible).sort((left, right) => right.score - left.score || Number(right.primary.jsonLdType === right.product.jsonLdType) - Number(left.primary.jsonLdType === left.product.jsonLdType) || left.primary.id.localeCompare(right.primary.id) || left.product.id.localeCompare(right.product.id));
    const usedPrimary = new Set<string>();
    const usedProducts = new Set<string>();
    const assignments = new Map<string, typeof pairs[number]>();
    for (const pair of pairs) {
      if (usedPrimary.has(pair.primary.id) || usedProducts.has(pair.product.id)) continue;
      usedPrimary.add(pair.primary.id);
      usedProducts.add(pair.product.id);
      assignments.set(pair.primary.id, pair);
    }
    for (const row of rows) {
      const pair = assignments.get(row.primary.id);
      row.matches.push(pair ? { domain: competitor.domain, product: pair.product, score: pair.score, confidence: pair.score >= 0.55 ? "Medium" : "Low", sharedTerms: pair.sharedTerms.slice(0, 8), claimIds: [...row.primary.claimIds, ...pair.product.claimIds] } : { domain: competitor.domain, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds });
    }
    unmatched.push({ domain: competitor.domain, products: competitor.products.filter((product) => !usedProducts.has(product.id)) });
  }
  return { primaryDomain: canonicalPrimary, comparisonDomains: competitors.map((competitor) => competitor.domain), rows, unmatched };
}
