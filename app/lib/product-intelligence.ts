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
  extraction: "json-ld" | "page-signal" | "sitemap";
  confidence: "High" | "Medium";
  sourceUrl: string;
  imageUrl: string;
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
  decision: {
    priceVerdict: string;
    whyTheyMayWin: string;
    recommendedMove: string;
  } | null;
};

export type ProductComparison = {
  primaryDomain: string;
  comparisonDomains: string[];
  rows: Array<{ primary: ProductRecord; matches: ProductMatch[] }>;
  unmatched: Array<{ domain: string; products: ProductRecord[] }>;
};

export type ProductEnrichmentTarget = {
  domain: string;
  sourceUrl: string;
  productId: string;
  pairScore: number;
  role: "primary" | "rival";
};

type JsonRecord = Record<string, unknown>;

const PRODUCT_TYPES = new Set(["Product", "SoftwareApplication", "Service"]);
const PRODUCT_PATH = /\/(?:billing|checkout|invoices?|payments?|subscriptions?|products?|shop|store|collections?|catalog|pricing|plans?|solutions?|services?|platform|features?)(?:\/|$)/i;
const EXCLUDED_PATH = /\/(?:about|articles?|blog|careers?|case-studies|company|contact|customers?|docs?|events?|guides?|help|jobs?|legal|news|partners?|press|privacy|resources?|security|stories|support|terms)(?:\/|$)/i;
const PRODUCT_HEADING = /\b(?:billing|checkout|invoices?|payments?|plan|pricing|subscriptions?|tier|package|product|service|solution|feature|includes?|built for)\b/i;
const PRICING_PATH = /\/(?:pricing|plans?)(?:\/|$)/i;
const OFFERING_PATH = /\/(?:boxes?|bundles?|subscriptions?|products?|features?|solutions?|services?|capabilities|expertise|platform|pricing|plans?)(?:\/|$)/i;
const SAAS_OFFERING_WORDS = /\b(?:analy(?:s(?:e|is)|tics?)|automat(?:e|ion)|campaigns?|collaborat(?:e|ion)|content creation|engag(?:e|ement)|landing page|mobile app|performance|plan(?:ning)?|posts?|publish(?:ing)?|schedul(?:e|ing)|social media|workflow)\b/i;
const AGENCY_OFFERING_WORDS = /\b(?:brand|design|development|engineering|innovation|mobile|product strategy|prototyping|research|strategy|user experience|ux|web)\b/i;
const ECOMMERCE_OFFERING_WORDS = /\b(?:box(?:es)?|bundles?|delivery|membership|subscriptions?)\b/i;
const GENERIC_OFFERING_HEADING = /^(?:all features|benefits|built for .+|customer stories|everything you need|get started|how it works|learn more|our (?:features|products|services|work)|pricing|services|solutions|what we do|why .+)$/i;
const GENERIC_PAGE_NAME = /^(?:features?|platform|pricing|products?|services?|solutions?|plans?)$/i;
const EDITORIAL_HEADING = /^(?:a guide to|case study|how (?:do|to)|news|our story|the faces behind|what is|why )\b|\b(?:case study|customer stor(?:y|ies)|in the age of)\b/i;
const SLOGAN_LIKE_OFFERING = /[.!?]\s+[\p{L}\p{N}]|^(?:the|your)\s+.+\s+workspace$/iu;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "our", "the", "their", "this", "to", "with", "your",
]);
const GENERIC_TOKENS = new Set([
  "app", "basic", "business", "catalog", "collection", "collections", "edition", "enterprise", "essential", "feature", "features", "free", "plan", "plans", "platform", "plus", "premium", "pricing", "pro", "product", "products", "saas", "service", "services", "shop", "software", "solution", "starter", "store", "suite",
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
  return clean(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
  const explicitCurrency = text(currencyValue).toUpperCase();
  const inferredCurrency = /£/.test(rawText) ? "GBP" : /€/.test(rawText) ? "EUR" : /\$/.test(rawText) ? "USD" : undefined;
  const currency = explicitCurrency || inferredCurrency;
  const amountMatch = rawText.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const amount = amountMatch ? Number(amountMatch[0]) : undefined;
  const raw = explicitCurrency && !rawText.toUpperCase().includes(explicitCurrency) ? `${explicitCurrency} ${rawText}` : rawText;
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
  if (PRODUCT_PATH.test(path) && !EXCLUDED_PATH.test(path)) return "path-inferred";
  if (entities.length) return "third-party-referenced";
  return "third-party-referenced";
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
  const imageRecord = records(record.image)[0];
  const imageUrl = text(typeof record.image === "string" ? record.image : imageRecord?.url || imageRecord?.contentUrl);
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
    imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : "",
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
    if (name && !GENERIC_PAGE_NAME.test(name)) {
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
        imageUrl: clean(input.document.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)/i)?.[1] || ""),
        observedAt: input.observedAt,
        claimIds: [`${id}-observed`],
      });
    }
  }
  const dedupe = (items: ProductRecord[]) => [...new Map(items.map((item) => [`${item.domain}|${item.normalizedName}|${item.sourceUrl}`, item])).values()];
  return { products: dedupe(products), thirdPartyReferenced: dedupe(thirdPartyReferenced), gaps: [...new Set(gaps)] };
}

export type FirstPartyOfferingInput = {
  domain: string;
  observedAt: string;
  businessType: "ecommerce" | "saas" | "agency" | "unknown";
  pages: Array<{ sourceUrl: string; title: string; description: string; headings: string[] }>;
};

function usefulOfferingName(value: string) {
  let name = clean(value);
  const words = name.split(/\s+/);
  if (words.length % 2 === 0) {
    const midpoint = words.length / 2;
    if (words.slice(0, midpoint).join(" ").toLowerCase() === words.slice(midpoint).join(" ").toLowerCase()) name = words.slice(0, midpoint).join(" ");
  }
  const terms = normalized(name).split(/\s+/).filter(Boolean);
  if (!name || name.length > 120 || terms.length < 2 || terms.length > 14 || GENERIC_OFFERING_HEADING.test(name) || EDITORIAL_HEADING.test(name) || SLOGAN_LIKE_OFFERING.test(name)) return "";
  return name;
}

function matchesOfferingType(name: string, businessType: FirstPartyOfferingInput["businessType"]) {
  if (businessType === "ecommerce") return ECOMMERCE_OFFERING_WORDS.test(name);
  if (businessType === "saas") return SAAS_OFFERING_WORDS.test(name);
  if (businessType === "agency") return AGENCY_OFFERING_WORDS.test(name);
  return false;
}

export function extractFirstPartyOfferings(input: FirstPartyOfferingInput) {
  if (input.businessType === "unknown") return [];
  const candidates: Array<{ name: string; page: FirstPartyOfferingInput["pages"][number]; category: string }> = [];
  for (const page of input.pages) {
    let path = "/";
    try { path = new URL(page.sourceUrl).pathname; } catch { continue; }
    if (EXCLUDED_PATH.test(path)) continue;
    const offeringPage = OFFERING_PATH.test(path);
    const category = path.split("/").filter(Boolean)[0] || input.businessType;
    const headings = page.headings.map(usefulOfferingName).filter(Boolean).filter((heading) => matchesOfferingType(heading, input.businessType));
    for (const name of headings) candidates.push({ name, page, category });

    const pathParts = path.split("/").filter(Boolean);
    if (offeringPage && headings.length === 0 && pathParts.length >= 2) {
      const title = usefulOfferingName(page.title.split(/\s+(?:\||—|–|-)\s+/)[0] || page.title);
      if (title) candidates.push({ name: title, page, category });
    }
  }

  const selected = new Map<string, ProductRecord>();
  for (const candidate of candidates) {
    const key = normalized(candidate.name);
    if (!key || selected.has(key)) continue;
    const id = makeId(input.domain, candidate.name, candidate.page.sourceUrl);
    selected.set(key, {
      id,
      domain: canonicalHost(input.domain),
      name: candidate.name,
      normalizedName: key,
      description: clean(candidate.page.description || `${candidate.name} is presented as a first-party offering.`).slice(0, 400),
      category: candidate.category,
      jsonLdType: "Service",
      priceSignals: [],
      attributes: [],
      ownership: "path-inferred",
      extraction: "page-signal",
      confidence: "Medium",
      sourceUrl: candidate.page.sourceUrl,
      imageUrl: "",
      observedAt: input.observedAt,
      claimIds: [`${id}-observed`],
    });
    if (selected.size >= 12) break;
  }
  return [...selected.values()];
}

export function extractProductsFromSitemap(document: string, domain: string, observedAt: string) {
  const products: ProductRecord[] = [];
  for (const match of document.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const entry = match[1] || "";
    const sourceUrl = clean(entry.match(/<loc>\s*([^<]+)\s*<\/loc>/i)?.[1] || "").replace(/&amp;/gi, "&");
    if (!sourceUrl) continue;
    let url: URL;
    try { url = new URL(sourceUrl); } catch { continue; }
    const catalogPath = /\/(?:products?|shop|store)\//i.test(url.pathname);
    if (canonicalHost(url.hostname) !== canonicalHost(domain) || !catalogPath) continue;
    const sitemapTitle = clean(entry.match(/<(?:image:)?title>\s*([\s\S]*?)\s*<\/(?:image:)?title>/i)?.[1] || "");
    const name = sitemapTitle || clean(url.pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ") || "");
    if (!name) continue;
    const description = clean(entry.match(/<(?:image:)?caption>\s*([\s\S]*?)\s*<\/(?:image:)?caption>/i)?.[1] || "");
    const imageUrl = clean(entry.match(/<image:loc>\s*(https?:\/\/[^<]+)\s*<\/image:loc>/i)?.[1] || "").replace(/&amp;/gi, "&");
    const id = makeId(domain, name, sourceUrl);
    products.push({
      id,
      domain: canonicalHost(domain),
      name: name.slice(0, 160),
      normalizedName: normalized(name),
      description: description.slice(0, 400),
      category: url.pathname.split("/").filter(Boolean)[0] || "product",
      jsonLdType: "Product",
      priceSignals: [],
      attributes: [],
      ownership: "path-inferred",
      extraction: "sitemap",
      confidence: "Medium",
      sourceUrl,
      imageUrl,
      observedAt,
      claimIds: [`${id}-sitemap-observed`],
    });
    if (products.length >= 400) break;
  }
  return selectPreferredProducts(products);
}

export function selectPreferredProducts(items: ProductRecord[]) {
  const quality = (item: ProductRecord) =>
    (item.extraction === "json-ld" ? 40 : item.extraction === "page-signal" ? 20 : 10)
    + (item.confidence === "High" ? 20 : 0)
    + (item.priceSignals.length ? 15 : 0)
    + (item.description ? 5 : 0)
    + (item.imageUrl ? 3 : 0);
  const selected = new Map<string, ProductRecord>();
  for (const item of items) {
    const key = `${item.domain}|${item.normalizedName}`;
    const current = selected.get(key);
    if (!current || quality(item) > quality(current)) selected.set(key, item);
  }
  return [...selected.values()];
}

function fieldTokens(product: ProductRecord, value: string) {
  const identityTokens = new Set(tokens(canonicalHost(product.domain).split(".")[0], true));
  return tokens(value).filter((token) => !identityTokens.has(token) && !/^\d+(?:\.\d+)?(?:g|kg|ml|l|oz|lb|pk|pack|pcs?)?$/i.test(token));
}

function editDistanceAtMostOne(left: string, right: string) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 5) return false;
  let changes = 0;
  for (let leftIndex = 0, rightIndex = 0; leftIndex < left.length || rightIndex < right.length;) {
    if (left[leftIndex] === right[rightIndex]) { leftIndex += 1; rightIndex += 1; continue; }
    changes += 1;
    if (changes > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else { leftIndex += 1; rightIndex += 1; }
  }
  return true;
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
  const sharedNameTerms = primaryName.filter((token) => candidateName.some((candidateToken) => editDistanceAtMostOne(token, candidateToken)));
  const sharedTerms = [...new Set([...sharedNameTerms, ...primaryCategory.filter((token) => candidateCategory.includes(token)), ...primaryDescription.filter((token) => candidateDescription.includes(token))])].sort();
  const imageTokens = (url: string) => { try { return tokens(decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "").replace(/\.[a-z0-9]{2,5}$/i, ""), true).filter((token) => !/^(?:asset|default|hero|image|img|logo|og|placeholder|product|products|thumb|thumbnail|\d+)$/i.test(token)); } catch { return []; } };
  const imageScore = primary.imageUrl && candidate.imageUrl ? jaccard(imageTokens(primary.imageUrl), imageTokens(candidate.imageUrl)) : 0;
  const score = (jaccard(primaryName, candidateName) * 0.58) + (jaccard(primaryCategory, candidateCategory) * 0.18) + (jaccard(primaryDescription, candidateDescription) * 0.14) + (imageScore * 0.1);
  const categoryOverlap = primaryCategory.some((token) => candidateCategory.includes(token));
  const incompatiblePhysicalService = new Set([primary.jsonLdType, candidate.jsonLdType]).has("Product") && new Set([primary.jsonLdType, candidate.jsonLdType]).has("Service") && !categoryOverlap;
  return { score: Number(score.toFixed(4)), sharedTerms, imageScore: Number(imageScore.toFixed(4)), eligible: score >= 0.32 && sharedNameTerms.length >= 2 && !incompatiblePhysicalService };
}

function comparablePrice(product: ProductRecord) {
  return product.priceSignals.find((signal) => typeof signal.amount === "number" && signal.currency);
}

function productDecision(primary: ProductRecord, candidate: ProductRecord, score: number): NonNullable<ProductMatch["decision"]> {
  const primaryPrice = comparablePrice(primary);
  const candidatePrice = comparablePrice(candidate);
  let priceVerdict = "Public prices are not comparable yet.";
  let whyTheyMayWin = `The rival presents ${candidate.name} as the closest observable alternative.`;
  let recommendedMove = "Compare pack size, ingredients, delivery promise, and final basket price before changing the offer.";
  if (primaryPrice && candidatePrice && primaryPrice.currency === candidatePrice.currency && primaryPrice.amount !== candidatePrice.amount) {
    const difference = Math.abs(primaryPrice.amount! - candidatePrice.amount!);
    const currency = primaryPrice.currency;
    if (candidatePrice.amount! < primaryPrice.amount!) {
      priceVerdict = `${candidate.domain} is ${currency} ${difference.toFixed(2)} cheaper on the observed price.`;
      whyTheyMayWin = "A lower visible price gives the rival a simpler conversion argument.";
      recommendedMove = "Either justify your premium with a concrete product advantage or test a matched-price offer.";
    } else {
      priceVerdict = `You are ${currency} ${difference.toFixed(2)} cheaper on the observed price.`;
      whyTheyMayWin = "Price is not their visible advantage; their product framing or availability may be doing the work.";
      recommendedMove = "Put your lower price beside an equivalent pack-size claim and make it prominent in ads and collection pages.";
    }
  } else if (!primaryPrice && candidatePrice) {
    priceVerdict = `${candidate.domain} exposes a public price while yours was not observed.`;
    whyTheyMayWin = "The rival removes price uncertainty before checkout.";
    recommendedMove = "Expose the comparable price earlier on the product or collection page.";
  } else if (primaryPrice && !candidatePrice) {
    priceVerdict = "You expose a public price while the rival did not in this crawl.";
    whyTheyMayWin = "Their advantage is not visible price transparency in the pages we observed.";
    recommendedMove = "Keep price clarity and strengthen the product-specific reason to choose you.";
  } else if (score >= 0.65) {
    whyTheyMayWin = "The two offers look very similar from public product language, so small price, availability, or trust differences can decide the sale.";
  }
  return { priceVerdict, whyTheyMayWin, recommendedMove };
}

export function buildProductComparison(primaryDomain: string, catalogs: Array<{ domain: string; products: ProductRecord[] }>, requiredSourceUrls: Record<string, string[]> = {}): ProductComparison {
  const canonicalPrimary = canonicalHost(primaryDomain);
  const rank = (product: ProductRecord) => Number(product.confidence === "High") * 4 + Number(product.priceSignals.length > 0) * 2 + Number(product.extraction === "json-ld");
  const selectForComparison = (domain: string, products: ProductRecord[]) => {
    const required = new Set((requiredSourceUrls[canonicalHost(domain)] || []).map((url) => url.split("#")[0]));
    return [...products].sort((left, right) => Number(required.has(right.sourceUrl.split("#")[0])) - Number(required.has(left.sourceUrl.split("#")[0])) || rank(right) - rank(left) || left.id.localeCompare(right.id)).slice(0, 16);
  };
  const primaryProducts = selectForComparison(canonicalPrimary, catalogs.find((catalog) => canonicalHost(catalog.domain) === canonicalPrimary)?.products || []);
  const competitors = catalogs.filter((catalog) => canonicalHost(catalog.domain) !== canonicalPrimary).map((catalog) => ({ ...catalog, domain: canonicalHost(catalog.domain), products: selectForComparison(catalog.domain, catalog.products) }));
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
      row.matches.push(pair ? { domain: competitor.domain, product: pair.product, score: pair.score, confidence: pair.score >= 0.55 ? "Medium" : "Low", sharedTerms: pair.sharedTerms.slice(0, 8), claimIds: [...row.primary.claimIds, ...pair.product.claimIds], decision: productDecision(row.primary, pair.product, pair.score) } : { domain: competitor.domain, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null });
    }
    unmatched.push({ domain: competitor.domain, products: competitor.products.filter((product) => !usedProducts.has(product.id)) });
  }
  return { primaryDomain: canonicalPrimary, comparisonDomains: competitors.map((competitor) => competitor.domain), rows, unmatched };
}

function hasComparablePublicPrice(product: ProductRecord) {
  return product.priceSignals.some((signal) => typeof signal.amount === "number" && Boolean(signal.currency));
}

function safeProductSource(product: ProductRecord) {
  try {
    const url = new URL(product.sourceUrl);
    return /^https?:$/.test(url.protocol) && canonicalHost(url.hostname) === canonicalHost(product.domain) && /\/(?:products?|shop|store)\//i.test(url.pathname)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

export function selectProductEnrichmentTargets(comparison: ProductComparison, maxPages = 6): ProductEnrichmentTarget[] {
  const boundedMax = Math.max(0, Math.min(6, Math.floor(maxPages)));
  if (!boundedMax) return [];
  const pairs = comparison.rows.flatMap((row) => row.matches.flatMap((match) => {
    const rival = match.product;
    if (!rival || row.primary.jsonLdType !== "Product" || rival.jsonLdType !== "Product") return [];
    const primaryUrl = safeProductSource(row.primary);
    const rivalUrl = safeProductSource(rival);
    if (!primaryUrl || !rivalUrl || (hasComparablePublicPrice(row.primary) && hasComparablePublicPrice(rival))) return [];
    return [{ primary: row.primary, rival, primaryUrl, rivalUrl, score: match.score, competitorDomain: match.domain }];
  })).sort((left, right) => right.score - left.score || left.competitorDomain.localeCompare(right.competitorDomain) || left.primary.id.localeCompare(right.primary.id));
  const selected: ProductEnrichmentTarget[] = [];
  const selectedUrls = new Set<string>();
  const selectedPairs = new Set<string>();
  const addPair = (pair: typeof pairs[number]) => {
    const key = `${pair.primary.id}|${pair.rival.id}`;
    if (selectedPairs.has(key)) return;
    const missing = [
      ...(!hasComparablePublicPrice(pair.primary) ? [{ domain: pair.primary.domain, sourceUrl: pair.primaryUrl, productId: pair.primary.id, pairScore: pair.score, role: "primary" as const }] : []),
      ...(!hasComparablePublicPrice(pair.rival) ? [{ domain: pair.rival.domain, sourceUrl: pair.rivalUrl, productId: pair.rival.id, pairScore: pair.score, role: "rival" as const }] : []),
    ].filter((target) => !selectedUrls.has(target.sourceUrl));
    if (!missing.length || selected.length + missing.length > boundedMax) return;
    selectedPairs.add(key);
    for (const target of missing) {
      selectedUrls.add(target.sourceUrl);
      selected.push(target);
    }
  };
  const seenCompetitors = new Set<string>();
  for (const pair of pairs) {
    if (seenCompetitors.has(pair.competitorDomain)) continue;
    addPair(pair);
    seenCompetitors.add(pair.competitorDomain);
  }
  for (const pair of pairs) addPair(pair);
  return selected;
}
