import type { ProductRecord } from "./product-intelligence.ts";
import { parseCanonicalQuantity, quantitiesConflict } from "./product-normalization.ts";

// A cheap contradiction screen, not an exact-match judge. Unknown categories
// remain uncertain; matching prices alone never establishes equivalence.
const FUNCTIONS: Array<[string, RegExp]> = [
  ["sunscreen", /\b(?:sunscreen|sunblock|spf\s*\d+)\b|واقي\s*شمس/i],
  ["shower-oil", /\b(?:shower|bath)\s+oil\b/i],
  ["body-wash", /\b(?:body\s*wash|shower\s*gel)\b|غسول\s*الجسم/i],
  ["body-lotion", /\b(?:body|hand)\s*(?:and\s*(?:body|hand)\s*)?(?:lotion|cream|moisturi[sz]er)\b|لوشن\s*الجسم/i],
  ["body-scrub", /\b(?:body\s*scrub|body\s*polish)\b|مقشر\s*الجسم/i],
  ["face-care", /\b(?:face|facial)\s*(?:essentials?|cleanser|moisturi[sz]er|wash|cream)\b|غسول\s*الوجه/i],
  ["shampoo", /\bshampoo\b|شامبو/i],
  ["conditioner", /\bconditioner\b|بلسم/i],
  ["food-jar", /\b(?:food\s*jar|food\s*container)\b/i],
  ["drink-bottle", /\b(?:water\s*bottle|bottle|flask)\b|زجاجة|قارورة/i],
  ["hand-soap", /\bhand\s*soap\b|صابون\s*اليد/i],
  ["laundry-detergent", /\b(?:laundry\s*detergent|detergent\s*sheets?|laundry\s*tablets?)\b/i],
  ["surface-cleaner", /\b(?:bathroom|surface|all[ -]purpose|multi[ -]surface)\s*cleaner\b/i],
];

function title(product: ProductRecord) {
  return product.name.normalize("NFKC").replace(/&(?:amp;)?/g, " and ").replace(/\s+/g, " ").trim();
}
function functions(product: ProductRecord) {
  const name = title(product);
  const named = FUNCTIONS.filter(([, re]) => re.test(name)).map(([kind]) => kind);
  return named.length ? named : FUNCTIONS.filter(([, re]) => re.test(product.category)).map(([kind]) => kind);
}
function bundleSize(name: string) {
  if (/\btrio\b/i.test(name)) return 3;
  if (/\bduo\b/i.test(name)) return 2;
  const explicit = name.match(/\b(\d{1,2})\s*[- ]?(?:piece|pack)\b|\b(?:set|pack)\s*of\s*(\d{1,2})\b/i);
  return explicit ? Number(explicit[1] || explicit[2]) : null;
}
export function directProductContradictions(primary: ProductRecord, rival: ProductRecord): string[] {
  const reasons: string[] = [];
  const leftName = title(primary), rightName = title(rival);
  const bundle = /\b(?:kit|set|bundle|trio|duo|multipack)\b|\b\d+\s*[- ]?pack\b|\bpack\s*of\s*\d+\b|مجموعة|طقم/i;
  const leftBundle = bundle.test(leftName), rightBundle = bundle.test(rightName);
  if (leftBundle !== rightBundle) reasons.push("bundle-versus-single-product");
  const leftCount = bundleSize(leftName), rightCount = bundleSize(rightName);
  if (leftCount !== null && rightCount !== null && leftCount !== rightCount) reasons.push("different-bundle-counts");
  const leftTypes = functions(primary), rightTypes = functions(rival);
  if (leftTypes.length && rightTypes.length && !leftTypes.some((kind) => rightTypes.includes(kind))) reasons.push("different-product-functions");
  const quantity = (product: ProductRecord) => parseCanonicalQuantity(`${title(product)} ${(product.attributes || []).filter((v) => !/^(?:barcode|ean|gtin|isbn|mpn|sku|upc)\s*:/i.test(v)).join(" ")}`) || undefined;
  if (quantitiesConflict(quantity(primary), quantity(rival))) reasons.push("different-observed-quantities");
  return reasons;
}
