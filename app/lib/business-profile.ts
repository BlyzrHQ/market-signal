import type { ProductRecord } from "./product-intelligence.ts";
import { regionCode } from "./region-inference.ts";

export type BusinessType = "ecommerce" | "saas" | "agency" | "unknown";

export type BusinessProfile = {
  domain: string;
  brandName: string;
  businessType: BusinessType;
  category: string;
  categoryTerms: string[];
  offerings: ProductRecord[];
  region: string;
  countryCode: string;
  language: string;
  evidenceUrls: string[];
};

export type BusinessProfileInput = {
  domain: string;
  title: string;
  description: string;
  region: string;
  language: string;
  products: ProductRecord[];
  pages?: Array<{ title: string; description: string; path: string; sourceUrl: string; headings?: string[] }>;
};

const STOPWORDS = new Set(["about", "all", "and", "app", "best", "build", "building", "buy", "company", "for", "from", "get", "home", "more", "our", "product", "products", "shop", "store", "that", "the", "their", "this", "with", "your"]);
const GENERIC_TITLES = /^(?:features?|home|plans?|pricing|products?|services?|solutions?)$/i;
const PROMOTIONAL_TITLE = /\b(?:buy now|discount|free shipping|limited[- ]time|no (?:set[- ]?up|setup) (?:charge|fee)|sale|save \d+%|shop online)\b/i;

export function profileTerms(value: string) {
  return [...new Set(value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((term) => term.length > 2 && !STOPWORDS.has(term) && !/^\d+$/.test(term)))];
}

function brandName(input: BusinessProfileInput) {
  const domainBrand = input.domain.replace(/^www\./, "").split(".")[0].replace(/[-_]+/g, " ");
  const domainTerms = profileTerms(domainBrand);
  const segments = input.title.split(/\s+(?:\||—|–)\s+/).map((part) => part.trim()).filter(Boolean);
  const branded = segments.find((segment) => {
    const terms = profileTerms(segment);
    return terms.length <= 4 && terms.some((term) => domainTerms.some((domainTerm) => term.includes(domainTerm) || domainTerm.includes(term)));
  });
  const value = branded || domainBrand;
  return value.replace(/\b(?:home|official site)\b/gi, "").trim().slice(0, 100) || domainBrand;
}

function businessType(input: BusinessProfileInput): BusinessType {
  const pageText = (input.pages || []).flatMap((page) => [page.title, page.description, page.path, ...(page.headings || [])]).join(" ");
  const text = `${input.title} ${input.description} ${pageText}`;
  const coreText = `${input.title} ${input.description}`;
  const productPages = (input.pages || []).filter((page) => /\/(?:products?|shop|store|collections?)(?:\/|$)/i.test(page.path)).length;
  if (input.products.filter((product) => product.jsonLdType === "Product").length >= 2 || productPages >= 2) return "ecommerce";
  if (/\b(?:boxes?|bundles?|groceries|grocery|food|shoes?|apparel|grooming|nut butter|tea)\b/i.test(text) && /\b(?:buy|cart|checkout|delivered|delivery|shop|subscribe|subscription)\b/i.test(text)) return "ecommerce";
  if (/\b(?:agency|consultancy|consulting|digital product studio|design studio|client services|fractional leadership)\b/i.test(coreText)) return "agency";
  if (/\b(?:saas|software|platform|social media management|project management|product development system|cloud-based|workflow)\b/i.test(coreText)) return "saas";
  if (/\b(?:agency|consultancy|consulting|digital product studio|design studio|client services|fractional leadership)\b/i.test(text)) return "agency";
  if (/\b(?:saas|software|platform|social media management|project management|product development system|cloud-based|workflow)\b/i.test(text) || (input.pages || []).some((page) => /\/(?:pricing|features?|integrations?|platform)(?:\/|$)/i.test(page.path))) return "saas";
  if ((input.pages || []).some((page) => /\/(?:services?|work|case-studies|capabilities)(?:\/|$)/i.test(page.path))) return "agency";
  return input.products.length >= 3 ? "ecommerce" : "unknown";
}

function category(input: BusinessProfileInput, type: BusinessType) {
  const segments = input.title.split(/\s+(?:\||—|–)\s+/).map((part) => part.trim()).filter(Boolean);
  const domainTokens = new Set(profileTerms(input.domain.split(".")[0]));
  const descriptive = segments.map((segment) => ({ segment, terms: profileTerms(segment) })).filter(({ segment, terms }) => terms.length >= 2 && !GENERIC_TITLES.test(segment) && !PROMOTIONAL_TITLE.test(segment) && terms.some((term) => !domainTokens.has(term))).sort((left, right) => right.terms.length - left.terms.length)[0]?.segment;
  const productCategories = input.products.map((product) => product.category).filter((value) => value && !/^(?:agency|ecommerce|features?|plans?|product|products|saas|services?|shop|store|uncategorized)$/i.test(value));
  const frequentCategory = [...new Map(productCategories.map((value) => [value, productCategories.filter((candidate) => candidate === value).length])).entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const fallback = type === "agency" ? "digital product design and development agency" : type === "saas" ? "business software platform" : type === "ecommerce" ? "online retail" : "business";
  return (descriptive || frequentCategory || input.description || fallback).replace(/\s+/g, " ").trim().slice(0, 180);
}

export function inferBusinessProfile(input: BusinessProfileInput): BusinessProfile {
  const type = businessType(input);
  const inferredCategory = category(input, type);
  const homepageUrl = input.pages?.[0]?.sourceUrl || `https://${input.domain}/`;
  return {
    domain: input.domain,
    brandName: brandName(input),
    businessType: type,
    category: inferredCategory,
    categoryTerms: profileTerms(`${inferredCategory} ${input.title} ${input.description}`).slice(0, 30),
    offerings: input.products,
    region: input.region,
    countryCode: regionCode(input.region),
    language: input.language,
    evidenceUrls: [...new Set([homepageUrl, ...(input.pages || []).map((page) => page.sourceUrl)])].slice(0, 8),
  };
}
