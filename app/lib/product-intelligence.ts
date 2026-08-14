import {
  bilingualNormalize,
  bilingualTokens,
  conflictingValidGtins,
  extractProductIdentifiers,
  parseCanonicalQuantity,
  quantitiesConflict,
  quantitiesEqual,
  sharedValidGtin,
  type CanonicalProductQuantity,
  type ProductIdentifiers,
} from "./product-normalization.ts";

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
  extraction: "json-ld" | "storefront-api" | "page-signal" | "sitemap";
  confidence: "High" | "Medium";
  sourceUrl: string;
  imageUrl: string;
  observedAt: string;
  claimIds: string[];
  identifiers?: ProductIdentifiers;
  quantity?: CanonicalProductQuantity;
};

const ISO_CURRENCIES = new Set<string>((() => {
  try {
    return (Intl as typeof Intl & { supportedValuesOf(key: "currency"): string[] }).supportedValuesOf("currency");
  } catch {
    return ["AED", "AUD", "CAD", "CHF", "CNY", "EGP", "EUR", "GBP", "INR", "JOD", "KWD", "OMR", "QAR", "SAR", "USD"];
  }
})());

export function isSupportedCurrency(value: unknown) {
  return ISO_CURRENCIES.has(String(value || "").trim().toUpperCase());
}

export function hasValidObservedRivalPrice(product: ProductRecord) {
  return product.priceSignals.some((signal) => {
    const currency = String(signal.currency || "").trim().toUpperCase();
    return typeof signal.amount === "number"
      && Number.isFinite(signal.amount)
      && signal.amount > 0
      && Boolean(String(signal.raw || "").trim())
      && isSupportedCurrency(currency);
  });
}

export type ProductExtractionResult = {
  products: ProductRecord[];
  thirdPartyReferenced: ProductRecord[];
  gaps: string[];
};

export type ProductActionLever = "price_response" | "merchandising" | "positioning" | "price_transparency" | "evidence_gap" | "packaging";

export type ProductActionPlan = {
  source: "ai" | "deterministic";
  claimType: "Recommendation";
  actionEn: string;
  actionAr: string;
  rationaleEn: string;
  rationaleAr: string;
  leverType: ProductActionLever;
  evidenceKeys: string[];
  model: string;
  promptVersion: string;
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
    priceComparison: { primaryRaw: string; rivalRaw: string } | null;
    actionPlan?: ProductActionPlan;
  } | null;
  assessment?: {
    method: "ai-hybrid";
    claimType: "Inferred";
    verdict: "same_product" | "close_substitute";
    confidence: number;
    model: string;
    promptVersion: string;
    reasons: string[];
    contradictions: string[];
    normalizedCategory: string;
    normalizedVariant: string;
    normalizedSize: string;
    primarySourceUrl: string;
    rivalSourceUrl: string;
  };
};

export type ProductComparison = {
  primaryDomain: string;
  comparisonDomains: string[];
  rows: Array<{ primary: ProductRecord; matches: ProductMatch[] }>;
  unmatched: Array<{ domain: string; products: ProductRecord[] }>;
  coverage: {
    primaryProductsAvailable: number;
    primaryProductsScanned: number;
    primaryProductFamiliesCompared: number;
    competitorProductsAvailable: number;
    competitorProductsScanned: number;
    assignedPairCount: number;
    verifiedPairCount: number;
    rowsReturned: number;
    rowLimit: number;
    truncated: boolean;
  };
  matching?: {
    method: "ai-hybrid" | "lexical-fallback";
    available: boolean;
    model: string;
    embeddingModel: string;
    promptVersion: string;
    primaryProductsAssessed: number;
    candidatePairsAssessed: number;
    retrievalPairsScored: number;
    judgeCalls: number;
    embeddingCalls: number;
    totalJudgeBatches?: number;
    reusedJudgeCheckpoints?: number;
    savedJudgeCheckpoints?: number;
    durationMs: number;
    gaps: string[];
    selectedPrimaryIds?: string[];
    assessedPrimaryIds?: string[];
    attempts?: number;
    primaryProductsSynchronized?: number;
    competitorProductsSynchronized?: number;
    candidateSlotsByDomain?: Record<string, number>;
    publication?: {
      suppressedAcceptedPairs: number;
      reasons: Record<"missing-valid-rival-price", number>;
    };
  };
  enrichment?: {
    pagesRequested: number;
    pagesFetched: number;
    maxPages: number;
    pagesEligible?: number;
    pagesTruncated?: boolean;
    batchCount?: number;
    failedBatchCount?: number;
    gaps: Array<{ url: string; reason: string; productId?: string; role?: "primary" | "rival"; code?: string }>;
    edgeRecovery?: { recovered: number; requested: number; provider: string; observedAt: string };
  };
  actionPlanning?: {
    method: "ai-grounded" | "deterministic-fallback";
    available: boolean;
    model: string;
    promptVersion: string;
    actionsRequested: number;
    aiActionsAccepted: number;
    fallbackActions: number;
    calls: number;
    durationMs: number;
    gaps: string[];
    rejectionReasons?: Record<string, number>;
  };
};

export type ProductEnrichmentTarget = {
  domain: string;
  sourceUrl: string;
  productId: string;
  expectedName: string;
  expectedType: ProductRecord["jsonLdType"];
  pairScore: number;
  role: "primary" | "rival";
  allowCatalogReplacement?: true;
};

export const CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX = "Previous sitemap identity:";

export function catalogReplacementAuditAttribute(previousName: string, sourceUrl: string) {
  return `${CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX} ${previousName.replace(/\s+/g, " ").trim().slice(0, 180)} (${sourceUrl.slice(0, 260)})`;
}

export function isCatalogReplacementProduct(product: ProductRecord) {
  return product.attributes.some((attribute) => attribute.startsWith(CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX));
}

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
const GENERIC_PRODUCT_IDENTITY_TOKENS = new Set([
  "bundle", "bundles", "set", "sets", "box", "boxes", "pack", "packs", "kit", "kits",
  "collection", "collections", "product", "products", "item", "items",
  "\u0645\u062c\u0645\u0648\u0639\u0629", "\u062d\u0632\u0645\u0629", "\u0639\u0644\u0628\u0629", "\u0628\u0627\u0642\u0629", "\u0637\u0642\u0645", "\u0639\u0628\u0648\u0629",
].map((token) => bilingualNormalize(token)));
const PRODUCT_ROUTE_SEGMENTS = new Set(["product", "products"]);
const LOCALE_PATH_PREFIX = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const BUSINESS_TYPE_ONLY_OFFERING = /^(?:content creation|mobile app|social media)$/i;
const GENERIC_PAGE_NAME = /^(?:features?|platform|pricing|products?|services?|solutions?|plans?)$/i;
const SAAS_PLAN_NAME = /^(?:free|personal|basic|essentials?|starter|standard|unlimited|professional|pro|team|business|advanced|growth|premium|scale|enterprise|custom)$/i;
const EDITORIAL_HEADING = /^(?:a guide to|case study|how (?:do|to)|news|our story|the faces behind|what is|why )\b|\b(?:case study|customer stor(?:y|ies)|in the age of)\b/i;
const SLOGAN_LIKE_OFFERING = /[.!?]\s+[\p{L}\p{N}]|^(?:the|your)\s+.+\s+workspace$/iu;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "our", "the", "their", "this", "to", "with", "your",
]);
const GENERIC_TOKENS = new Set([
  "app", "basic", "business", "catalog", "collection", "collections", "edition", "enterprise", "essential", "feature", "features", "free", "plan", "plans", "platform", "plus", "premium", "pricing", "pro", "product", "products", "saas", "service", "services", "shop", "software", "solution", "starter", "store", "suite",
]);
const ACCESSORY_PRODUCT_GROUPS = new Map<string, string>([
  ...["book", "books", "cookbook", "cookbooks", "guide", "guides"].map((token) => [token, "publication"] as const),
  ...["cup", "cups", "mug", "mugs"].map((token) => [token, "drinkware"] as const),
  ...["infuser", "infusers", "scoop", "scoops", "spoon", "spoons", "whisk", "whisks"].map((token) => [token, "preparation-accessory"] as const),
  ...["voucher", "vouchers"].map((token) => [token, "voucher"] as const),
  ...["butter", "butters", "spread", "spreads"].map((token) => [token, "spread"] as const),
  ...["cereal", "cereals", "granola", "granolas", "muesli"].map((token) => [token, "granola"] as const),
  ...["bar", "bars"].map((token) => [token, "snack-bar"] as const),
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
  const match = value.match(/(?:\/\s*|\bper\s+(?:(?:user|seat|channel|brand|workspace|social\s+set)\s*[,/]?\s*(?:per\s+)?)?)(month|mo|year|yr|week|day)/i);
  return match?.[1]?.toLowerCase();
}

function decodedCodePoint(value: string, radix: number) {
  const code = Number.parseInt(value, radix);
  return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : " ";
}

function priceSignal(rawValue: unknown, currencyValue?: unknown): ProductPriceSignal | null {
  const rawText = text(rawValue);
  if (!rawText) return null;
  const explicitCurrency = text(currencyValue).toUpperCase();
  const currencyEvidence = rawText
    .replace(/&pound;/gi, "£")
    .replace(/&euro;/gi, "€")
    .replace(/&dollar;/gi, "$")
    .replace(/&#(\d+);/g, (_, code: string) => decodedCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodedCodePoint(code, 16));
  const observedCurrencies = new Set<string>();
  if (/£/.test(currencyEvidence)) observedCurrencies.add("GBP");
  if (/€/.test(currencyEvidence)) observedCurrencies.add("EUR");
  if (/\$/.test(currencyEvidence)) observedCurrencies.add("USD");
  for (const match of currencyEvidence.toUpperCase().matchAll(/\b[A-Z]{3}\b/g)) if (isSupportedCurrency(match[0])) observedCurrencies.add(match[0]);
  if (observedCurrencies.size > 1 || (explicitCurrency && [...observedCurrencies].some((currency) => currency !== explicitCurrency))) return null;
  const inferredCurrency = [...observedCurrencies][0];
  const currency = explicitCurrency || inferredCurrency;
  const normalizedAmountText = rawText
    .replace(/&[a-z0-9]*(?:minus|dash|hyphen|ominus)[a-z0-9]*;/gi, "-")
    .replace(/&nbsp;/gi, " ")
    .replace(/&pound;/gi, "£")
    .replace(/&euro;/gi, "€")
    .replace(/&dollar;/gi, "$")
    .replace(/&colon;/gi, ":")
    .replace(/&equals;/gi, "=")
    .replace(/&#(\d+)(?:;|(?=\s|\p{Sc}))/gu, (_, code: string) => decodedCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+)(?:;|(?=\s|\p{Sc}))/giu, (_, code: string) => decodedCodePoint(code, 16))
    .replace(/&#(?:8722|8211|8212);/gi, "-")
    .replace(/&#x(?:2212|2013|2014);/gi, "-")
    .replace(/[−–—]/gu, "-")
    .replace(/[\p{Pd}\u207B\u208B\u2212\u2213\u2238\u2296\u229D\u229F\u2796\u2A29-\u2A2C\u2A3A\u2A41\u2A6C]/gu, "-")
    .replace(/,/g, "");
  if (/&#(?:x[0-9a-f]+|\d+)/i.test(normalizedAmountText)) return null;
  const separatedNegative = /^\s*(?:(?:[A-Z]{3}|\p{Sc})\s*)?-\s*[^\d]{0,24}\d/u.test(normalizedAmountText);
  const labeledNegative = /[:=]\s*-\s*[^\d]{0,24}\d/u.test(normalizedAmountText);
  const accountingNegative = /\(\s*(?:[A-Z]{3}\s*|[$£€]\s*)?\d+(?:\.\d+)?(?:\s*[A-Z]{3})?\s*\)/u.test(normalizedAmountText);
  const trailingNegative = /\d+(?:\.\d+)?\s*-\s*(?:[A-Z]{3})?\s*$/u.test(normalizedAmountText);
  if (separatedNegative || labeledNegative || accountingNegative || trailingNegative) return null;
  const amountMatch = normalizedAmountText.match(/[+-]?\d+(?:\.\d+)?/);
  const amount = amountMatch ? Number(amountMatch[0]) : undefined;
  if (typeof amount === "number" && Number.isFinite(amount) && amount < 0) return null;
  const raw = explicitCurrency && !rawText.toUpperCase().includes(explicitCurrency) ? `${explicitCurrency} ${rawText}` : rawText;
  return { raw: raw.slice(0, 120), currency, amount: Number.isFinite(amount) ? amount : undefined, period: periodFrom(raw) };
}

function offerSignals(value: unknown): ProductPriceSignal[] {
  const found: ProductPriceSignal[] = [];
  for (const offer of records(value)) {
    const currency = offer.priceCurrency;
    const hasRangeEndpoint = offer.lowPrice !== undefined || offer.highPrice !== undefined;
    if (hasRangeEndpoint) {
      const low = priceSignal(offer.lowPrice, currency);
      const high = priceSignal(offer.highPrice, currency);
      const completePositiveRange = low && high
        && typeof low.amount === "number" && Number.isFinite(low.amount) && low.amount > 0
        && typeof high.amount === "number" && Number.isFinite(high.amount) && high.amount > 0
        && low.currency && low.currency === high.currency;
      if (completePositiveRange) found.push(low, high);
    } else {
      const price = priceSignal(offer.price, currency);
      if (price) found.push(price);
    }
    found.push(...offerSignals(offer.offers));
    found.push(...offerSignals(offer.priceSpecification));
  }
  return [...new Map(found.map((signal) => [signal.raw, signal])).values()].slice(0, 12);
}

function metaContents(document: string, key: string) {
  const attributeValue = (tag: string, name: string) => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return clean(match?.[1] || match?.[2] || match?.[3] || "");
  };
  const activeDocument = document.replace(/<!--[\s\S]*?-->/g, " ");
  return [...activeDocument.matchAll(/<meta\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => ["property", "name", "itemprop"].some((attribute) => attributeValue(tag, attribute) === key))
    .map((tag) => attributeValue(tag, "content"))
    .filter(Boolean);
}

function metaContent(document: string, key: string) {
  return metaContents(document, key)[0] || "";
}

function openGraphOffer(document: string) {
  const amounts = [...new Set(["product:price:amount", "og:price:amount", "price"].flatMap((key) => metaContents(document, key)))];
  const currencies = [...new Set(["product:price:currency", "og:price:currency", "priceCurrency"]
    .flatMap((key) => metaContents(document, key))
    .map((value) => value.toUpperCase())
    .filter(isSupportedCurrency))];
  return amounts.length === 1 && currencies.length === 1 ? priceSignal(amounts[0], currencies[0]) : null;
}

function publicImageUrl(value: string, sourceUrl: string) {
  try {
    const candidate = clean(value);
    if (!candidate) return "";
    const url = new URL(candidate, sourceUrl);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function openGraphImage(document: string, sourceUrl: string) {
  const candidates = [
    metaContent(document, "og:image:secure_url"),
    metaContent(document, "og:image"),
    metaContent(document, "twitter:image"),
    metaContent(document, "image"),
  ].map((value) => publicImageUrl(value, sourceUrl)).filter(Boolean);
  return candidates.find((value) => /^https:\/\//i.test(value)) || candidates[0] || "";
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
  const imageUrl = publicImageUrl(text(typeof record.image === "string" ? record.image : imageRecord?.url || imageRecord?.contentUrl), input.sourceUrl);
  const productAttributes = attributes(record);
  const identifiers = extractProductIdentifiers(record);
  const quantityAttributes = productAttributes.filter((value) => !/^(?:barcode|ean|gtin|isbn|mpn|sku|upc)\s*:/i.test(value));
  const quantity = parseCanonicalQuantity(`${name} ${quantityAttributes.join(" ")}`) || undefined;
  return {
    id,
    domain: canonicalHost(input.domain),
    name: name.slice(0, 160),
    normalizedName: normalized(name),
    description: text(record.description).slice(0, 400),
    category: text(record.category || record.applicationCategory || record.serviceType).slice(0, 120),
    jsonLdType: type,
    priceSignals: offerSignals(record.offers),
    attributes: productAttributes,
    ownership: relation,
    extraction: "json-ld",
    confidence: relation === "self-declared-brand" ? "High" : "Medium",
    sourceUrl: input.sourceUrl,
    imageUrl,
    observedAt: input.observedAt,
    claimIds: [`${id}-observed`],
    identifiers: identifiers.gtins.length || identifiers.sku || identifiers.mpn || identifiers.brand ? identifiers : undefined,
    quantity,
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

type SaasPlanTier = "free" | "entry" | "team" | "enterprise";

function readableHtml(value: string) {
  return clean(value
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " "));
}

function cleanPlanName(value: string) {
  const name = clean(value)
    .replace(/\b(?:placeholder|recommended|most popular|popular|best value)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return SAAS_PLAN_NAME.test(name) ? name : "";
}

function planTier(name: string, price?: ProductPriceSignal): SaasPlanTier | null {
  if (/\b(?:enterprise|custom)\b/i.test(name)) return "enterprise";
  if (/\bfree\b/i.test(name) || price?.amount === 0 || (/\bpersonal\b/i.test(name) && !price?.amount)) return "free";
  if (/\b(?:basic|essentials?|starter|standard|unlimited|personal)\b/i.test(name)) return "entry";
  if (/\b(?:professional|pro|team|business|advanced|growth|premium|scale)\b/i.test(name)) return "team";
  return null;
}

function planPrice(value: string) {
  const expression = /(?:[$\u00a3\u20ac]\s?\d+(?:[.,]\d{1,2})?(?:\s*(?:USD|GBP|EUR))?(?:\s*(?:\/\s*|per\s+(?:(?:user|seat|channel|brand|workspace|social\s+set)\s*[,/]?\s*(?:per\s+)?)?)(?:month|mo|year|yr))?|\d+(?:[.,]\d{1,2})?\s*(?:USD|GBP|EUR)(?:\s*\/\s*(?:month|mo|year|yr))?)/gi;
  const raws = [...value.matchAll(expression)].map((match) => clean(match[0])).filter(Boolean);
  const recurring = raws.find((raw) => periodFrom(raw));
  return priceSignal(recurring || raws[0]);
}

function planPriceBasis(value: string, price?: ProductPriceSignal) {
  if (price && /\bper\s+(?:user|seat)\b|\b(?:user|seat)\s*\/\s*(?:month|mo|year|yr)\b/i.test(price.raw)) return "user";
  if (/\bsocial\s+sets?\b/i.test(value)) return "social-set";
  if (/\bchannels?\b/i.test(value)) return "channel";
  if (/\bbrands?\b/i.test(value)) return "brand";
  if (/\bworkspaces?\b/i.test(value)) return "workspace";
  if (/\b(?:per\s+)?(?:user|seat)(?:\s*[,/]\s*per)?\s*(?:month|mo|year|yr)?\b/i.test(value)) return "user";
  return price?.period ? "flat" : "unspecified";
}

function planBillingCommitment(value: string) {
  if (/\b(?:billed|billing|paid|pay)\s+(?:yearly|annually|annual)\b|\bannual\s+(?:billing|commitment|contract)\b/i.test(value)) return "annual";
  if (/\b(?:billed|billing|paid|pay)\s+monthly\b|\bmonth[- ]to[- ]month\b|\bmonthly\s+(?:billing|commitment|contract)\b/i.test(value)) return "monthly";
  return "unspecified";
}

function extractSaasPlans(input: ProductExtractionInput) {
  let path = "";
  try { path = new URL(input.sourceUrl).pathname; } catch { return [] as ProductRecord[]; }
  if (!PRICING_PATH.test(path)) return [];
  const candidates: Array<{ name: string; context: string; billingContext: string }> = [];
  const headings = [...input.document.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  for (let index = 0; index < headings.length; index += 1) {
    const name = cleanPlanName(headings[index][2] || "");
    if (!name) continue;
    const start = headings[index].index || 0;
    const end = headings[index + 1]?.index ?? Math.min(input.document.length, start + 12_000);
    const readableSection = readableHtml(input.document.slice(start, end));
    const context = readableSection.slice(0, 1_200);
    const billingContext = readableSection;
    if (planPrice(context) || /\b(?:contact sales|get a demo|request a demo|custom pricing|free forever)\b/i.test(context)) candidates.push({ name, context, billingContext });
  }
  const selected = new Map<string, ProductRecord>();
  for (const candidate of candidates) {
    const observedPrice = planPrice(candidate.context) || undefined;
    const price = observedPrice && (observedPrice.period || observedPrice.amount === 0) ? observedPrice : undefined;
    const tier = planTier(candidate.name, price);
    if (!tier) continue;
    const basis = planPriceBasis(candidate.context, price);
    const commitment = planBillingCommitment(candidate.billingContext);
    const id = makeId(input.domain, candidate.name, input.sourceUrl);
    const attributes = [
      `Plan tier: ${tier}`,
      `Price basis: ${basis}`,
      ...(price?.period ? [`Billing period: ${price.period}`] : []),
      ...(price?.period ? [`Billing commitment: ${commitment}`] : []),
      ...(!price && /\b(?:contact sales|get a demo|request a demo|custom pricing)\b/i.test(candidate.context) ? ["Price visibility: contact sales"] : []),
    ];
    const record: ProductRecord = {
      id,
      domain: canonicalHost(input.domain),
      name: candidate.name,
      normalizedName: normalized(candidate.name),
      description: candidate.context.slice(0, 400),
      category: `saas-plan ${tier}`,
      jsonLdType: "Service",
      priceSignals: price ? [price] : [],
      attributes,
      ownership: "path-inferred",
      extraction: "page-signal",
      confidence: "Medium",
      sourceUrl: input.sourceUrl,
      imageUrl: "",
      observedAt: input.observedAt,
      claimIds: [`${id}-observed`],
    };
    const key = `${record.domain}|${record.normalizedName}`;
    const current = selected.get(key);
    if (!current || record.priceSignals.length > 0) selected.set(key, record);
  }
  return [...selected.values()].slice(0, 8);
}

export function isProductLikePage(input: Pick<ProductExtractionInput, "sourceUrl" | "domain" | "pageTitle" | "headings" | "pagePriceSignals">) {
  const path = new URL(input.sourceUrl).pathname;
  if (EXCLUDED_PATH.test(path)) return false;
  const structuredHeadings = input.headings.filter((heading) => PRODUCT_HEADING.test(heading));
  if (PRICING_PATH.test(path)) return input.pagePriceSignals.length > 0 && input.headings.some((heading) => /\b(?:plan|tier|package)\b/i.test(heading));
  if (PRODUCT_PATH.test(path)) return input.pagePriceSignals.length > 0 || structuredHeadings.length >= 2;
  return false;
}

export function extractProductsFromHtml(input: ProductExtractionInput): ProductExtractionResult {
  let products: ProductRecord[] = extractSaasPlans(input);
  const thirdPartyReferenced: ProductRecord[] = [];
  const gaps: string[] = [];
  const authoritativeOffer = openGraphOffer(input.document);
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
  const pageIdentity = clean(input.pageTitle.split(/\s+(?:\||—|–|-)\s+/)[0] || input.pageTitle);
  const metadataCandidates = products.filter((product) => {
    if (product.jsonLdType !== "Product") return false;
    return normalized(product.name) === normalized(pageIdentity);
  });
  if (metadataCandidates.length === 1) {
    const selectedId = metadataCandidates[0].id;
    const metadataOffer = authoritativeOffer;
    const metadataImage = openGraphImage(input.document, input.sourceUrl);
    products = products.map((product) => product.id === selectedId ? {
      ...product,
      priceSignals: hasComparablePublicPrice(product) || !metadataOffer ? product.priceSignals : [metadataOffer],
      imageUrl: product.imageUrl || metadataImage,
    } : product);
  }
  let productPath = false;
  let pagePath = "";
  try { pagePath = new URL(input.sourceUrl).pathname; productPath = PRODUCT_PATH.test(pagePath); } catch { productPath = false; }
  if (!products.length && (isProductLikePage(input) || (productPath && Boolean(authoritativeOffer)))) {
    const titleName = clean(input.pageTitle.split(/\s+(?:\||—|–|-)\s+/)[0] || input.pageTitle);
    const observedHeading = input.headings.find((heading) => !/\b(?:logo|menu|skip navigation|home)\b/i.test(heading));
    const headingName = clean(observedHeading || "");
    const titleSupportsHeading = headingName && tokens(headingName).length >= 2 && normalized(input.pageTitle).includes(normalized(headingName));
    const name = titleSupportsHeading ? headingName : titleName && !/\b(?:logo|home)\b/i.test(titleName) ? titleName : clean(observedHeading || input.pageTitle);
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
        priceSignals: authoritativeOffer
          ? [authoritativeOffer]
          : PRICING_PATH.test(pagePath)
            ? input.pagePriceSignals.map((value) => priceSignal(value)).filter((value): value is ProductPriceSignal => Boolean(value)).slice(0, 12)
            : [],
        attributes: input.headings.filter((heading) => normalized(heading) !== normalized(name)).slice(0, 8),
        ownership: "path-inferred",
        extraction: "page-signal",
        confidence: "Medium",
        sourceUrl: input.sourceUrl,
        imageUrl: openGraphImage(input.document, input.sourceUrl),
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
  if (!name || name.length > 120 || terms.length < 2 || terms.length > 14 || GENERIC_OFFERING_HEADING.test(name) || BUSINESS_TYPE_ONLY_OFFERING.test(name) || EDITORIAL_HEADING.test(name) || SLOGAN_LIKE_OFFERING.test(name)) return "";
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
    const rawPathName = url.pathname.split("/").filter(Boolean).at(-1) || "";
    let decodedPathName = rawPathName;
    try { decodedPathName = decodeURIComponent(rawPathName); } catch { /* Preserve malformed public path evidence verbatim. */ }
    const name = sitemapTitle || clean(decodedPathName.replace(/[-_]+/g, " "));
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
      quantity: parseCanonicalQuantity(name) || undefined,
    });
    if (products.length >= 1_000) break;
  }
  return selectPreferredProducts(products);
}

export function selectPreferredProducts(items: ProductRecord[]) {
  const mergeIdentifiers = (preferred: ProductIdentifiers | undefined, supplemental: ProductIdentifiers | undefined) => {
    if (!preferred && !supplemental) return undefined;
    return {
      gtins: [...new Set([...(preferred?.gtins || []), ...(supplemental?.gtins || [])])],
      sku: preferred?.sku || supplemental?.sku,
      mpn: preferred?.mpn || supplemental?.mpn,
      brand: preferred?.brand || supplemental?.brand,
    } satisfies ProductIdentifiers;
  };
  const quality = (item: ProductRecord) =>
    (item.extraction === "json-ld" || item.extraction === "storefront-api" ? 40 : item.extraction === "page-signal" ? 20 : 10)
    + (item.confidence === "High" ? 20 : 0)
    + (item.priceSignals.length ? 15 : 0)
    + (item.description ? 5 : 0)
    + (item.imageUrl ? 3 : 0);
  const selected = new Map<string, ProductRecord>();
  for (const item of items) {
    const key = productIdentityKey(item);
    const current = selected.get(key);
    if (!current) {
      selected.set(key, item);
      continue;
    }
    const preferred = quality(item) > quality(current) ? item : current;
    const supplemental = preferred === item ? current : item;
    const preferredSource = canonicalProductSourceKey(preferred);
    const supplementalSource = canonicalProductSourceKey(supplemental);
    const sameSource = preferred.sourceUrl.split("#")[0].replace(/\/$/, "") === supplemental.sourceUrl.split("#")[0].replace(/\/$/, "")
      || Boolean(preferredSource && preferredSource === supplementalSource)
      || Boolean(sharedValidGtin(preferred.identifiers, supplemental.identifiers));
    if (!sameSource) {
      selected.set(key, preferred);
      continue;
    }
    const secureImage = [preferred.imageUrl, supplemental.imageUrl].find((value) => /^https:\/\//i.test(value));
    selected.set(key, {
      ...preferred,
      description: preferred.description || supplemental.description,
      priceSignals: preferred.priceSignals.length ? preferred.priceSignals : supplemental.priceSignals,
      attributes: [...new Set([
        ...(preferred.attributes.length ? preferred.attributes : supplemental.attributes),
        ...supplemental.attributes.filter((attribute) => attribute.startsWith(CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX)),
      ])],
      identifiers: mergeIdentifiers(preferred.identifiers, supplemental.identifiers),
      quantity: preferred.quantity || supplemental.quantity,
      imageUrl: secureImage || preferred.imageUrl || supplemental.imageUrl,
      claimIds: [...new Set([...preferred.claimIds, ...supplemental.claimIds])],
    });
  }
  return [...selected.values()];
}

function canonicalProductSourceKey(product: ProductRecord) {
  try {
    const url = new URL(product.sourceUrl);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try { return decodeURIComponent(segment).toLowerCase(); } catch { return segment.toLowerCase(); }
    });
    if (segments.length > 2 && LOCALE_PATH_PREFIX.test(segments[0]) && PRODUCT_ROUTE_SEGMENTS.has(segments[1])) segments.shift();
    const productIndex = segments.findIndex((segment) => PRODUCT_ROUTE_SEGMENTS.has(segment));
    if (productIndex < 0 || !segments[productIndex + 1]) return "";
    return `${canonicalHost(product.domain)}|/${segments.slice(productIndex).join("/")}`;
  } catch {
    return "";
  }
}

export function isGenericProductIdentityToken(token: string) {
  return GENERIC_PRODUCT_IDENTITY_TOKENS.has(bilingualNormalize(token));
}

export function productIdentityTokens(product: ProductRecord) {
  const domainToken = bilingualNormalize(canonicalHost(product.domain).split(".")[0]);
  return bilingualTokens(product.name).filter((token) => token.length > 1
    && token !== domainToken
    && !isGenericProductIdentityToken(token)
    && !/^\d/.test(token));
}

export function productIdentityKey(product: ProductRecord) {
  const domain = canonicalHost(product.domain);
  const gtin = [...(product.identifiers?.gtins || [])].sort()[0];
  if (gtin) return `${domain}|gtin|${gtin}`;
  const source = canonicalProductSourceKey(product);
  if (source) return `${domain}|source|${source}`;
  const quantity = product.quantity ? `${product.quantity.kind}|${product.quantity.amount}|${product.quantity.unit}` : "";
  return `${domain}|name|${bilingualNormalize(product.name)}|${quantity}`;
}

function fieldTokens(product: ProductRecord, value: string) {
  const identityTokens = new Set(tokens(canonicalHost(product.domain).split(".")[0], true));
  return tokens(value).filter((token) => !identityTokens.has(token)
    && !isGenericProductIdentityToken(token)
    && !/^\d+(?:\.\d+)?(?:g|kg|ml|l|oz|lb|pk|pack|pcs?)?$/i.test(token));
}

function productFamilyName(value: string) {
  return clean(value)
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+(?:-|–|—|\|)\s+.+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
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

function oneEditSignatures(token: string) {
  if (token.length < 5) return [token];
  const signatures = new Set<string>([token]);
  for (let index = 0; index < token.length; index += 1) signatures.add(`${token.slice(0, index)}${token.slice(index + 1)}`);
  return [...signatures];
}

export function buildProductPairCandidateIndex(products: ProductRecord[]) {
  const productsByToken = new Map<string, ProductRecord[]>();
  const tokensBySignature = new Map<string, Set<string>>();
  const nearbyProductsByToken = new Map<string, ProductRecord[]>();
  const productOrder = new Map<string, number>();
  for (const [position, product] of products.entries()) {
    if (!productOrder.has(product.id)) productOrder.set(product.id, position);
    for (const token of fieldTokens(product, product.name)) {
      const entries = productsByToken.get(token) || [];
      entries.push(product);
      productsByToken.set(token, entries);
      for (const signature of oneEditSignatures(token)) {
        const tokens = tokensBySignature.get(signature) || new Set<string>();
        tokens.add(token);
        tokensBySignature.set(signature, tokens);
      }
    }
  }
  return { products, productsByToken, tokensBySignature, nearbyProductsByToken, productOrder };
}

function nearbyProductsForToken(primaryToken: string, index: ReturnType<typeof buildProductPairCandidateIndex>) {
  const cached = index.nearbyProductsByToken.get(primaryToken);
  if (cached) return cached;
  const foundTokens = new Set<string>();
  for (const signature of oneEditSignatures(primaryToken)) {
    for (const competitorToken of index.tokensBySignature.get(signature) || []) {
      if (editDistanceAtMostOne(primaryToken, competitorToken)) foundTokens.add(competitorToken);
    }
  }
  const foundProducts = new Map<string, ProductRecord>();
  for (const token of foundTokens) for (const product of index.productsByToken.get(token) || []) foundProducts.set(product.id, product);
  const result = [...foundProducts.values()].sort((left, right) => (index.productOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (index.productOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  index.nearbyProductsByToken.set(primaryToken, result);
  return result;
}

export function retrieveProductPairCandidates(primary: ProductRecord, index: ReturnType<typeof buildProductPairCandidateIndex>) {
  if (primary.category.startsWith("saas-plan")) return index.products.filter((product) => product.category.startsWith("saas-plan"));
  const hitCounts = new Map<string, { product: ProductRecord; count: number }>();
  for (const token of fieldTokens(primary, primary.name)) {
    for (const product of nearbyProductsForToken(token, index)) {
      const hit = hitCounts.get(product.id);
      hitCounts.set(product.id, { product, count: (hit?.count || 0) + 1 });
    }
  }
  return [...hitCounts.values()].filter((hit) => hit.count >= 2).map((hit) => hit.product);
}

function jaccard(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (!union.size) return 0;
  return [...leftSet].filter((token) => rightSet.has(token)).length / union.size;
}

function accessoryGroups(product: ProductRecord) {
  return new Set(fieldTokens(product, product.name).map((token) => ACCESSORY_PRODUCT_GROUPS.get(token)).filter((group): group is string => Boolean(group)));
}

export function productPairVetoes(primary: ProductRecord, candidate: ProductRecord) {
  const vetoes: string[] = [];
  if (conflictingValidGtins(primary.identifiers, candidate.identifiers)) vetoes.push("The observed products expose conflicting validated GTINs.");
  if (quantitiesConflict(primary.quantity, candidate.quantity)) vetoes.push("The observed products expose incompatible canonical quantities.");
  const types = new Set([primary.jsonLdType, candidate.jsonLdType]);
  if (types.has("Product") && types.has("Service")) {
    const service = primary.jsonLdType === "Service" ? primary : candidate;
    const serviceOnly = /\b(?:catering|consultancy|consulting|installation|maintenance|repair|training)\b/i.test(`${service.name} ${service.category}`);
    const primaryIdentity = fieldTokens(primary, `${productFamilyName(primary.name)} ${primary.category}`);
    const candidateIdentity = fieldTokens(candidate, `${productFamilyName(candidate.name)} ${candidate.category}`);
    const sharedIdentity = primaryIdentity.filter((token) => candidateIdentity.some((candidateToken) => editDistanceAtMostOne(token, candidateToken)));
    if (serviceOnly || sharedIdentity.length < 2) vetoes.push("The observed product and service identities are not substitutable.");
  }
  const primaryGroups = accessoryGroups(primary);
  const candidateGroups = accessoryGroups(candidate);
  for (const group of new Set([...primaryGroups, ...candidateGroups])) {
    if (primaryGroups.has(group) !== candidateGroups.has(group)) vetoes.push(`Accessory or product-group contradiction: ${group}.`);
  }
  return [...new Set(vetoes)];
}

export function scoreProductPair(primary: ProductRecord, candidate: ProductRecord) {
  const primaryName = fieldTokens(primary, primary.name);
  const candidateName = fieldTokens(candidate, candidate.name);
  const primaryCategory = fieldTokens(primary, primary.category);
  const candidateCategory = fieldTokens(candidate, candidate.category);
  const primaryDescription = fieldTokens(primary, primary.description);
  const candidateDescription = fieldTokens(candidate, candidate.description);
  const sharedNameTerms = primaryName.filter((token) => candidateName.some((candidateToken) => editDistanceAtMostOne(token, candidateToken)));
  const primaryFamily = fieldTokens(primary, productFamilyName(primary.name));
  const candidateFamily = fieldTokens(candidate, productFamilyName(candidate.name));
  const sharedFamilyTerms = primaryFamily.filter((token) => candidateFamily.some((candidateToken) => editDistanceAtMostOne(token, candidateToken)));
  const familySimilarity = primaryFamily.length >= 2 && candidateFamily.length >= 2 && sharedFamilyTerms.length >= 2 ? jaccard(primaryFamily, candidateFamily) : 0;
  const primaryNameContained = primaryName.length >= 2 && primaryName.every((token) => candidateName.includes(token));
  const nameSimilarity = Math.max(jaccard(primaryName, candidateName), familySimilarity, primaryNameContained ? 1 : 0);
  const sharedTerms = [...new Set([...sharedNameTerms, ...primaryCategory.filter((token) => candidateCategory.includes(token)), ...primaryDescription.filter((token) => candidateDescription.includes(token))])].sort();
  const imageTokens = (url: string) => { try { return tokens(decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "").replace(/\.[a-z0-9]{2,5}$/i, ""), true).filter((token) => !/^(?:asset|default|hero|image|img|logo|og|placeholder|product|products|thumb|thumbnail|\d+)$/i.test(token)); } catch { return []; } };
  const imageScore = primary.imageUrl && candidate.imageUrl ? jaccard(imageTokens(primary.imageUrl), imageTokens(candidate.imageUrl)) : 0;
  const baseScore = (nameSimilarity * 0.58) + (jaccard(primaryCategory, candidateCategory) * 0.18) + (jaccard(primaryDescription, candidateDescription) * 0.14) + (imageScore * 0.1);
  const primaryPlanTier = primary.category.startsWith("saas-plan") ? planTier(primary.name, primary.priceSignals[0]) : null;
  const candidatePlanTier = candidate.category.startsWith("saas-plan") ? planTier(candidate.name, candidate.priceSignals[0]) : null;
  const bothSaasPlans = Boolean(primaryPlanTier && candidatePlanTier);
  const eitherSaasPlan = Boolean(primaryPlanTier || candidatePlanTier);
  const sameSaasPlanTier = Boolean(bothSaasPlans && primaryPlanTier === candidatePlanTier);
  const score = sameSaasPlanTier ? Math.max(baseScore, 0.72) : baseScore;
  if (sameSaasPlanTier) sharedTerms.push(`plan tier: ${primaryPlanTier}`);
  const vetoes = productPairVetoes(primary, candidate);
  const ordinaryEligible = score >= 0.32 && sharedNameTerms.length >= 2;
  return { score: Number(score.toFixed(4)), sharedTerms, imageScore: Number(imageScore.toFixed(4)), eligible: (sameSaasPlanTier || (!eitherSaasPlan && ordinaryEligible)) && vetoes.length === 0 };
}

function canonicalProductPageUrl(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${canonicalHost(url.hostname)}${path}`;
  } catch {
    return "";
  }
}

function enrichmentIdentityAlignment(product: ProductRecord, candidate: ProductRecord) {
  const identityTokens = (record: ProductRecord) => productIdentityTokens(record).filter((token) => !STOPWORDS.has(token));
  const left = identityTokens(product);
  const right = identityTokens(candidate);
  const alignedLeft = new Set<number>();
  const alignedRight = new Set<number>();
  const tokensAlign = (leftToken: string, rightToken: string) => leftToken === rightToken
    || (Math.min(leftToken.length, rightToken.length) >= 4 && (`${leftToken}s` === rightToken || `${rightToken}s` === leftToken))
    || (leftToken.length >= 5 && rightToken.length >= 5 && editDistanceAtMostOne(leftToken, rightToken));
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const rightIndex = right.findIndex((token, index) => !alignedRight.has(index) && tokensAlign(left[leftIndex], token));
    if (rightIndex < 0) continue;
    alignedLeft.add(leftIndex);
    alignedRight.add(rightIndex);
  }
  return {
    aligned: alignedLeft.size,
    leftCoverage: alignedLeft.size / Math.max(1, left.length),
    rightCoverage: alignedRight.size / Math.max(1, right.length),
    leftHasConflict: left.some((_, index) => !alignedLeft.has(index)),
    rightHasConflict: right.some((_, index) => !alignedRight.has(index)),
  };
}

function slugAnchoredIdentityAlignment(product: ProductRecord, candidate: ProductRecord) {
  let slugName = "";
  try {
    const segments = new URL(product.sourceUrl).pathname.split("/").filter(Boolean);
    slugName = decodeURIComponent(segments.at(-1) || "").replace(/[-_]+/g, " ");
  } catch { return null; }
  if (!slugName) return null;
  const slugRecord = { ...product, name: slugName, normalizedName: bilingualNormalize(slugName), description: "", attributes: [] };
  const expectedToSlug = enrichmentIdentityAlignment(product, slugRecord);
  const slugToCandidate = enrichmentIdentityAlignment(slugRecord, candidate);
  const rawSlugTokens = bilingualTokens(slugName).filter((token) => token.length >= 2);
  const rawExpectedTokens = new Set(bilingualTokens(product.name));
  const rawCandidateTokens = new Set(bilingualTokens(candidate.name));
  const fullSlugContained = rawSlugTokens.length >= 2
    && rawSlugTokens.every((token) => rawExpectedTokens.has(token))
    && rawSlugTokens.every((token) => rawCandidateTokens.has(token));
  const expectedIsSlugAnchored = expectedToSlug.aligned >= 2 && expectedToSlug.leftCoverage >= 0.75 && expectedToSlug.rightCoverage >= 0.75;
  const candidateExplainsSlug = slugToCandidate.aligned >= 2
    && slugToCandidate.leftCoverage >= 0.4
    && slugToCandidate.rightCoverage >= 0.5
    && !(slugToCandidate.leftHasConflict && slugToCandidate.rightHasConflict);
  return (expectedIsSlugAnchored && candidateExplainsSlug) || fullSlugContained ? slugToCandidate : null;
}

export function validateProductPageIdentity(expected: ProductRecord[], fetched: ProductRecord[], pageTitle = "", options: { allowScopedPageSignal?: boolean } = {}) {
  if (!expected.length) return { accepted: false, products: [] as ProductRecord[], reason: "No expected product identity was available for this enrichment page." };
  const accepted = fetched.flatMap((candidate) => {
    let strength = -1;
    for (const product of expected) {
    const conflictingIdentifier = (left: string | undefined, right: string | undefined) => Boolean(left && right && bilingualNormalize(left) !== bilingualNormalize(right));
    const hardIdentityConflict = conflictingValidGtins(product.identifiers, candidate.identifiers)
      || quantitiesConflict(product.quantity, candidate.quantity)
      || conflictingIdentifier(product.identifiers?.sku, candidate.identifiers?.sku)
      || conflictingIdentifier(product.identifiers?.mpn, candidate.identifiers?.mpn);
      if (hardIdentityConflict) continue;
      if (product.normalizedName === candidate.normalizedName) {
        strength = Math.max(strength, 100_000);
        continue;
      }
      const sameFinalProductPage = canonicalProductPageUrl(product.sourceUrl) === canonicalProductPageUrl(candidate.sourceUrl);
      if (!sameFinalProductPage || product.jsonLdType !== "Product" || (candidate.jsonLdType !== "Product" && !(options.allowScopedPageSignal && candidate.jsonLdType === "PageSignal"))) continue;
      const alignment = enrichmentIdentityAlignment(product, candidate);
      const directAlignment = alignment.aligned >= 2 && alignment.leftCoverage >= 0.5 && alignment.rightCoverage >= 0.5 && !(alignment.leftHasConflict && alignment.rightHasConflict);
      const slugAlignment = directAlignment ? null : slugAnchoredIdentityAlignment(product, candidate);
      if (!directAlignment && !slugAlignment) continue;
      const acceptedAlignment = slugAlignment || alignment;
      strength = Math.max(strength, (acceptedAlignment.aligned * 1_000) + (Math.min(acceptedAlignment.leftCoverage, acceptedAlignment.rightCoverage) * 100));
    }
    return strength >= 0 ? [{ candidate, strength: strength + (candidate.priceSignals.length ? 10 : 0) + (candidate.imageUrl ? 1 : 0) }] : [];
  }).sort((left, right) => right.strength - left.strength || left.candidate.name.localeCompare(right.candidate.name));
  const products = accepted.map((entry) => entry.candidate);
  if (products.length) return { accepted: true, products, reason: "" };
  const observed = fetched.map((product) => product.name).filter(Boolean).slice(0, 3).join(", ") || pageTitle || "an unrelated product";
  return {
    accepted: false,
    products: [] as ProductRecord[],
    reason: `The fetched page identity (${observed}) contradicts the requested product identity (${expected.map((product) => product.name).slice(0, 3).join(", ")}).`,
  };
}

function comparablePrice(product: ProductRecord) {
  const prices = product.priceSignals.filter((signal) => typeof signal.amount === "number" && signal.currency);
  const currencies = new Set(prices.map((signal) => signal.currency));
  const amounts = new Set(prices.map((signal) => signal.amount));
  return currencies.size === 1 && amounts.size === 1 ? prices[0] : undefined;
}

function hasPublicPrice(product: ProductRecord) {
  return product.priceSignals.some((signal) => typeof signal.amount === "number" && signal.currency);
}

function planAttribute(product: ProductRecord, label: string) {
  return product.attributes.find((value) => value.toLowerCase().startsWith(`${label.toLowerCase()}:`))?.split(":").slice(1).join(":").trim() || "";
}

export function productDecision(primary: ProductRecord, candidate: ProductRecord, score: number, exactProduct = true): NonNullable<ProductMatch["decision"]> {
  const primaryPrice = comparablePrice(primary);
  const candidatePrice = comparablePrice(candidate);
  const primaryHasPrice = hasPublicPrice(primary);
  const candidateHasPrice = hasPublicPrice(candidate);
  const saasPlanPair = primary.category.startsWith("saas-plan") && candidate.category.startsWith("saas-plan");
  const billingAligned = !saasPlanPair || Boolean(
    primaryPrice?.period
    && candidatePrice?.period
    && primaryPrice.period === candidatePrice.period
    && planAttribute(primary, "Price basis") === planAttribute(candidate, "Price basis")
    && planAttribute(primary, "Price basis") !== "unspecified"
    && planAttribute(primary, "Billing commitment") === planAttribute(candidate, "Billing commitment")
    && planAttribute(primary, "Billing commitment") !== "unspecified"
  );
  const priceComparison = exactProduct && primaryPrice && candidatePrice && primaryPrice.currency === candidatePrice.currency && billingAligned
    ? { primaryRaw: primaryPrice.raw, rivalRaw: candidatePrice.raw }
    : null;
  let priceVerdict = "Public prices are not comparable yet.";
  let whyTheyMayWin = `The rival presents ${candidate.name} as the closest observable alternative.`;
  let recommendedMove = saasPlanPair
    ? "Compare included users, usage limits, billing cadence, and annual commitment before changing the plan."
    : "Compare pack size, ingredients, delivery promise, and final basket price before changing the offer.";
  if (!exactProduct && primaryHasPrice && candidateHasPrice) {
    priceVerdict = "This is an AI-assessed close substitute, not an identical observed variant, so its public prices are not presented as a direct delta.";
    whyTheyMayWin = "The rival gives customers a closely substitutable option, but pack size, variant, or included value may differ.";
    recommendedMove = "Compare the observed size, variant, ingredients or included features before testing a price response.";
  } else if (saasPlanPair && primaryHasPrice && candidateHasPrice && !billingAligned) {
    priceVerdict = "Both expose public plan prices, but billing period, commitment, or unit basis is unresolved.";
    whyTheyMayWin = "The plans use different or unclear billing terms, so a simple price lead would be misleading.";
    recommendedMove = "Normalize per-user, per-channel, or flat pricing, billing period, and commitment before changing packaging.";
  } else if (primaryPrice && candidatePrice && primaryPrice.currency === candidatePrice.currency && primaryPrice.amount === candidatePrice.amount) {
    priceVerdict = `The observed public price is the same at ${primaryPrice.currency} ${primaryPrice.amount!.toFixed(2)}.`;
    whyTheyMayWin = saasPlanPair ? "Price is not the visible differentiator at this comparable plan tier." : "Price is not the visible differentiator on this matched product.";
    recommendedMove = saasPlanPair ? "Lead with included usage, collaboration, automation, or support advantages instead of price." : "Lead with a concrete product, availability, delivery, or trust advantage instead of price.";
  } else if (primaryPrice && candidatePrice && primaryPrice.currency === candidatePrice.currency && primaryPrice.amount !== candidatePrice.amount) {
    const difference = Math.abs(primaryPrice.amount! - candidatePrice.amount!);
    const currency = primaryPrice.currency;
    if (candidatePrice.amount! < primaryPrice.amount!) {
      priceVerdict = `${candidate.domain} is ${currency} ${difference.toFixed(2)} cheaper on the observed price.`;
      whyTheyMayWin = saasPlanPair ? "A lower visible price at the same billing unit gives the rival a simpler conversion argument." : "A lower visible price gives the rival a simpler conversion argument.";
      recommendedMove = saasPlanPair ? "Verify included limits, then justify the premium with a named capability or test the aligned plan price." : "Either justify your premium with a concrete product advantage or test a matched-price offer.";
    } else {
      priceVerdict = `You are ${currency} ${difference.toFixed(2)} cheaper on the observed price.`;
      whyTheyMayWin = saasPlanPair ? "Price is not their visible advantage; included limits, workflow depth, or brand trust may be doing the work." : "Price is not their visible advantage; their product framing or availability may be doing the work.";
      recommendedMove = saasPlanPair ? "Show the lower aligned plan price beside the specific limits and capabilities it includes." : "Put your lower price beside an equivalent pack-size claim and make it prominent in ads and collection pages.";
    }
  } else if (!saasPlanPair && primaryHasPrice && candidateHasPrice) {
    priceVerdict = "Both expose public prices, but variant or pack-size alignment is unresolved.";
    whyTheyMayWin = "The public pages expose multiple variants or non-comparable currencies, so a simple price lead would be misleading.";
    recommendedMove = "Normalize pack size and variant before using price in a campaign or merchandising decision.";
  } else if (!primaryHasPrice && candidateHasPrice) {
    priceVerdict = `${candidate.domain} exposes a public price while yours was not observed.`;
    whyTheyMayWin = "The rival removes price uncertainty before checkout.";
    recommendedMove = "Expose the comparable price earlier on the product or collection page.";
  } else if (primaryHasPrice && !candidateHasPrice) {
    priceVerdict = "You expose a public price while the rival did not in this crawl.";
    whyTheyMayWin = "Their advantage is not visible price transparency in the pages we observed.";
    recommendedMove = "Keep price clarity and strengthen the product-specific reason to choose you.";
  } else if (score >= 0.65) {
    whyTheyMayWin = "The two offers look very similar from public product language, so small price, availability, or trust differences can decide the sale.";
  }
  return { priceVerdict, whyTheyMayWin, recommendedMove, priceComparison };
}

export function buildProductComparison(primaryDomain: string, catalogs: Array<{ domain: string; products: ProductRecord[] }>, requiredSourceUrls: Record<string, string[]> = {}): ProductComparison {
  const canonicalPrimary = canonicalHost(primaryDomain);
  const maxPrimaryProducts = 1_000;
  const maxRivalProducts = 600;
  const rowLimit = 80;
  const minimumCoverageRows = 16;
  const maxUnmatchedProductsPerDomain = 24;
  const rank = (product: ProductRecord) => Number(product.confidence === "High") * 4 + Number(product.priceSignals.length > 0) * 2 + Number(product.extraction === "json-ld" || product.extraction === "storefront-api");
  const selectForComparison = (domain: string, products: ProductRecord[]) => {
    const required = new Set((requiredSourceUrls[canonicalHost(domain)] || []).map((url) => url.split("#")[0]));
    const limit = canonicalHost(domain) === canonicalPrimary ? maxPrimaryProducts : maxRivalProducts;
    return [...products].sort((left, right) => Number(required.has(right.sourceUrl.split("#")[0])) - Number(required.has(left.sourceUrl.split("#")[0])) || rank(right) - rank(left) || left.id.localeCompare(right.id)).slice(0, limit);
  };
  const collapsePrimaryFamilies = (products: ProductRecord[]) => {
    const selected = new Map<string, ProductRecord>();
    for (const product of products) {
      const familyTokens = product.jsonLdType === "Product" ? fieldTokens(product, productFamilyName(product.name)) : [];
      const key = familyTokens.length >= 2 ? `${product.jsonLdType}|${familyTokens.join("|")}` : `${product.jsonLdType}|${product.id}`;
      if (!selected.has(key)) selected.set(key, product);
    }
    return [...selected.values()];
  };
  const primaryCatalog = catalogs.find((catalog) => canonicalHost(catalog.domain) === canonicalPrimary)?.products || [];
  const primaryProductsScanned = selectForComparison(canonicalPrimary, primaryCatalog);
  const primaryProducts = collapsePrimaryFamilies(primaryProductsScanned);
  const competitors = catalogs.filter((catalog) => canonicalHost(catalog.domain) !== canonicalPrimary).map((catalog) => ({ ...catalog, domain: canonicalHost(catalog.domain), products: selectForComparison(catalog.domain, catalog.products) }));
  const rows = primaryProducts.map((primary) => ({ primary, matches: [] as ProductMatch[] }));
  const unmatched: ProductComparison["unmatched"] = [];
  for (const competitor of competitors) {
    const competitorTokenIndex = buildProductPairCandidateIndex(competitor.products);
    const pairs = primaryProducts.flatMap((primary) => {
      const candidates = retrieveProductPairCandidates(primary, competitorTokenIndex);
      return candidates.map((product) => ({ primary, product, ...scoreProductPair(primary, product) }));
    }).filter((pair) => pair.eligible).sort((left, right) => right.score - left.score || Number(right.primary.jsonLdType === right.product.jsonLdType) - Number(left.primary.jsonLdType === left.product.jsonLdType) || left.primary.id.localeCompare(right.primary.id) || left.product.id.localeCompare(right.product.id));
    const usedPrimary = new Set<string>();
    const usedProducts = new Set<string>();
    const assignments = new Map<string, typeof pairs[number]>();
    for (const pair of pairs) {
      const rivalIdentity = productIdentityKey(pair.product);
      if (usedPrimary.has(pair.primary.id) || usedProducts.has(rivalIdentity)) continue;
      usedPrimary.add(pair.primary.id);
      usedProducts.add(rivalIdentity);
      assignments.set(pair.primary.id, pair);
    }
    for (const row of rows) {
      const pair = assignments.get(row.primary.id);
      row.matches.push(pair ? { domain: competitor.domain, product: pair.product, score: pair.score, confidence: pair.score >= 0.55 ? "Medium" : "Low", sharedTerms: pair.sharedTerms.slice(0, 8), claimIds: [...row.primary.claimIds, ...pair.product.claimIds], decision: productDecision(row.primary, pair.product, pair.score) } : { domain: competitor.domain, product: null, score: 0, confidence: null, sharedTerms: [], claimIds: row.primary.claimIds, decision: null });
    }
    unmatched.push({ domain: competitor.domain, products: competitor.products.filter((product) => !usedProducts.has(productIdentityKey(product))).slice(0, maxUnmatchedProductsPerDomain) });
  }
  const matchedRows = rows
    .filter((row) => row.matches.some((match) => match.product))
    .sort((left, right) => Math.max(...right.matches.map((match) => match.score)) - Math.max(...left.matches.map((match) => match.score)) || left.primary.id.localeCompare(right.primary.id));
  const unmatchedRows = rows.filter((row) => row.matches.every((match) => !match.product));
  const returnedRows = [...matchedRows.slice(0, rowLimit), ...unmatchedRows.slice(0, Math.max(0, minimumCoverageRows - matchedRows.length))];
  const assignedPairCount = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product).length, 0);
  const verifiedPairCount = rows.reduce((sum, row) => sum + row.matches.filter((match) => match.product && match.confidence === "Medium").length, 0);
  return {
    primaryDomain: canonicalPrimary,
    comparisonDomains: competitors.map((competitor) => competitor.domain),
    rows: returnedRows,
    unmatched,
    coverage: {
      primaryProductsAvailable: primaryCatalog.length,
      primaryProductsScanned: primaryProductsScanned.length,
      primaryProductFamiliesCompared: primaryProducts.length,
      competitorProductsAvailable: catalogs.filter((catalog) => canonicalHost(catalog.domain) !== canonicalPrimary).reduce((sum, catalog) => sum + catalog.products.length, 0),
      competitorProductsScanned: competitors.reduce((sum, competitor) => sum + competitor.products.length, 0),
      assignedPairCount,
      verifiedPairCount,
      rowsReturned: returnedRows.length,
      rowLimit,
      truncated: matchedRows.length > rowLimit,
    },
  };
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
      ...(!hasComparablePublicPrice(pair.primary) ? [{ domain: pair.primary.domain, sourceUrl: pair.primaryUrl, productId: pair.primary.id, expectedName: pair.primary.name, expectedType: pair.primary.jsonLdType, pairScore: pair.score, role: "primary" as const }] : []),
      ...(!hasComparablePublicPrice(pair.rival) ? [{ domain: pair.rival.domain, sourceUrl: pair.rivalUrl, productId: pair.rival.id, expectedName: pair.rival.name, expectedType: pair.rival.jsonLdType, pairScore: pair.score, role: "rival" as const }] : []),
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

export function planPreliminaryCatalogReconciliation(comparison: ProductComparison, primaryProducts: ProductRecord[], maxPages = 64) {
  const boundedMax = Math.max(0, Math.min(64, Math.floor(maxPages)));
  const matchedScoreById = new Map<string, number>();
  for (const row of comparison.rows) {
    const realMatches = row.matches.filter((match) => Boolean(match.product));
    if (realMatches.length) matchedScoreById.set(row.primary.id, Math.max(...realMatches.map((match) => match.score)));
  }
  const seenUrls = new Set<string>();
  const eligible = primaryProducts.flatMap((product) => {
    if (product.jsonLdType !== "Product" || hasComparablePublicPrice(product)) return [];
    const sourceUrl = safeProductSource(product);
    if (!sourceUrl || seenUrls.has(sourceUrl)) return [];
    seenUrls.add(sourceUrl);
    return [{ product, sourceUrl, pairScore: matchedScoreById.get(product.id) || 0 }];
  }).sort((left, right) => Number(right.pairScore > 0) - Number(left.pairScore > 0)
    || right.pairScore - left.pairScore
    || left.product.name.localeCompare(right.product.name)
    || left.sourceUrl.localeCompare(right.sourceUrl));
  const targets = eligible.slice(0, boundedMax).map(({ product, sourceUrl, pairScore }) => ({
    domain: product.domain,
    sourceUrl,
    productId: product.id,
    expectedName: product.name,
    expectedType: "Product" as const,
    pairScore,
    role: "primary" as const,
    allowCatalogReplacement: true as const,
  }));
  return { targets, totalEligible: eligible.length, truncated: eligible.length > targets.length };
}

export function planFinalProductEnrichmentTargets(comparison: ProductComparison, maxPages = 24) {
  const boundedMax = Math.max(0, Math.min(1_000, Math.floor(maxPages)));
  const eligible: ProductEnrichmentTarget[] = [];
  const seenUrls = new Set<string>();
  const add = (product: ProductRecord, role: ProductEnrichmentTarget["role"], pairScore: number) => {
    if (product.jsonLdType !== "Product") return;
    const sourceUrl = safeProductSource(product);
    const needsPrice = !hasComparablePublicPrice(product);
    const needsSecureImage = !/^https:\/\//i.test(product.imageUrl);
    if (!sourceUrl || (!needsPrice && !needsSecureImage) || seenUrls.has(sourceUrl)) return;
    seenUrls.add(sourceUrl);
    eligible.push({ domain: product.domain, sourceUrl, productId: product.id, expectedName: product.name, expectedType: product.jsonLdType, pairScore, role });
  };

  // A valid rival price is the publication gate. Give every primary family its
  // strongest rival lookup before spending the remaining budget on secondary
  // rivals or primary-side presentation details.
  const acceptedByRow = comparison.rows.map((row) => ({
    row,
    accepted: row.matches.filter((match) => match.product && match.confidence === "Medium").sort((left, right) => right.score - left.score
      || left.domain.localeCompare(right.domain)
      || (left.product?.id || "").localeCompare(right.product?.id || "")),
  }));
  for (const { accepted } of acceptedByRow) {
    const strongest = accepted[0];
    if (strongest?.product) add(strongest.product, "rival", strongest.score);
  }
  for (const { accepted } of acceptedByRow) {
    for (const match of accepted.slice(1)) if (match.product) add(match.product, "rival", match.score);
  }
  for (const { row, accepted } of acceptedByRow) {
    if (accepted[0]) add(row.primary, "primary", accepted[0].score);
  }

  const targets = eligible.slice(0, boundedMax);
  return { targets, totalEligible: eligible.length, truncated: eligible.length > targets.length };
}

export function selectFinalProductEnrichmentTargets(comparison: ProductComparison, maxPages = 24): ProductEnrichmentTarget[] {
  return planFinalProductEnrichmentTargets(comparison, maxPages).targets;
}

function sameLiveCatalogIdentity(left: ProductRecord, right: ProductRecord) {
  return Boolean(sharedValidGtin(left.identifiers, right.identifiers))
    || (left.normalizedName === right.normalizedName
      && (quantitiesEqual(left.quantity, right.quantity) || (!left.quantity && !right.quantity)));
}

export function applyPreMatchCatalogEnrichment(catalog: ProductRecord[], enriched: ProductRecord[]) {
  const freshById = new Map(enriched.map((product) => [product.id, product]));
  const catalogIds = new Set(catalog.map((product) => product.id));
  const auditsById = new Map<string, string[]>();
  const merged: ProductRecord[] = [];
  const mergeIdentifiers = (fresh: ProductIdentifiers | undefined, base: ProductIdentifiers | undefined) => {
    if (!fresh && !base) return undefined;
    return {
      gtins: [...new Set([...(fresh?.gtins || []), ...(base?.gtins || [])])],
      sku: fresh?.sku || base?.sku,
      mpn: fresh?.mpn || base?.mpn,
      brand: fresh?.brand || base?.brand,
    } satisfies ProductIdentifiers;
  };

  for (const base of catalog) {
    const fresh = freshById.get(base.id);
    if (!fresh) {
      merged.push(base);
      continue;
    }
    if (isCatalogReplacementProduct(fresh)) {
      const existing = catalog.find((candidate) => candidate.id !== base.id && sameLiveCatalogIdentity(candidate, fresh));
      if (existing) {
        const audit = fresh.attributes.filter((attribute) => attribute.startsWith(CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX));
        auditsById.set(existing.id, [...(auditsById.get(existing.id) || []), ...audit]);
        continue;
      }
      merged.push({ ...fresh, id: base.id });
      continue;
    }
    const secureImage = [fresh.imageUrl, base.imageUrl].find((value) => /^https:\/\//i.test(value));
    merged.push({
      ...base,
      ...fresh,
      id: base.id,
      description: fresh.description || base.description,
      category: fresh.category || base.category,
      priceSignals: fresh.priceSignals.length ? fresh.priceSignals : base.priceSignals,
      attributes: fresh.attributes.length ? fresh.attributes : base.attributes,
      identifiers: mergeIdentifiers(fresh.identifiers, base.identifiers),
      quantity: fresh.quantity || base.quantity,
      imageUrl: secureImage || fresh.imageUrl || base.imageUrl,
      claimIds: [...new Set([...base.claimIds, ...fresh.claimIds])],
    });
  }

  for (const fresh of enriched) {
    if (!catalogIds.has(fresh.id)) merged.push(fresh);
  }
  return selectPreferredProducts(merged.map((product) => {
    const audits = auditsById.get(product.id) || [];
    return audits.length ? { ...product, attributes: [...new Set([...product.attributes, ...audits])] } : product;
  }));
}

export function applyFinalProductEnrichment(
  comparison: ProductComparison,
  products: ProductRecord[],
  enrichment: NonNullable<ProductComparison["enrichment"]>,
) {
  const mergeIdentifiers = (fresh: ProductIdentifiers | undefined, base: ProductIdentifiers | undefined) => {
    if (!fresh && !base) return undefined;
    return {
      gtins: [...new Set([...(fresh?.gtins || []), ...(base?.gtins || [])])],
      sku: fresh?.sku || base?.sku,
      mpn: fresh?.mpn || base?.mpn,
      brand: fresh?.brand || base?.brand,
    } satisfies ProductIdentifiers;
  };
  const merge = (base: ProductRecord) => {
    const fresh = products.find((product) => product.id === base.id
      || (canonicalHost(product.domain) === canonicalHost(base.domain) && canonicalProductPageUrl(product.sourceUrl) === canonicalProductPageUrl(base.sourceUrl)));
    if (!fresh || isCatalogReplacementProduct(fresh)) return base;
    const secureImage = [fresh.imageUrl, base.imageUrl].find((value) => /^https:\/\//i.test(value));
    return {
      ...base,
      name: fresh.name,
      normalizedName: fresh.normalizedName,
      description: fresh.description || base.description,
      category: fresh.category || base.category,
      priceSignals: fresh.priceSignals.length ? fresh.priceSignals : base.priceSignals,
      attributes: fresh.attributes.length ? fresh.attributes : base.attributes,
      identifiers: mergeIdentifiers(fresh.identifiers, base.identifiers),
      quantity: fresh.quantity || base.quantity,
      extraction: fresh.extraction,
      confidence: fresh.confidence,
      imageUrl: secureImage || fresh.imageUrl || base.imageUrl,
      observedAt: fresh.observedAt || base.observedAt,
      claimIds: [...new Set([...base.claimIds, ...fresh.claimIds])],
    } satisfies ProductRecord;
  };
  const rows = comparison.rows.map((row) => {
    const primary = merge(row.primary);
    const matches = row.matches.map((match) => {
      if (!match.product) return match;
      const product = merge(match.product);
      const exactProduct = match.assessment ? match.assessment.verdict === "same_product" : true;
      return {
        ...match,
        product,
        claimIds: [...new Set([...match.claimIds, ...primary.claimIds, ...product.claimIds])],
        decision: match.confidence === "Medium" ? productDecision(primary, product, match.score, exactProduct) : match.decision,
      };
    });
    return { primary, matches };
  });
  return { ...comparison, rows, enrichment } satisfies ProductComparison;
}
