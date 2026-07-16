export type CanonicalProductQuantity = {
  kind: "mass" | "volume" | "count";
  amount: number;
  unit: "g" | "ml" | "pcs" | "pack";
};

export type ProductIdentifiers = {
  gtins: string[];
  sku?: string;
  mpn?: string;
  brand?: string;
};

type JsonRecord = Record<string, unknown>;

const ARABIC_DIGITS = new Map([
  ...Array.from("٠١٢٣٤٥٦٧٨٩", (digit, index) => [digit, String(index)] as const),
  ...Array.from("۰۱۲۳۴۵۶۷۸۹", (digit, index) => [digit, String(index)] as const),
]);

const UNIT_ALIASES = new Map<string, CanonicalProductQuantity>([
  ...["kg", "kgs", "kilogram", "kilograms", "كيلو", "كيلوجرام", "كيلوغرام", "كجم", "كغ"].map((unit) => [unit, { kind: "mass", amount: 1_000, unit: "g" }] as const),
  ...["g", "gram", "grams", "جرام", "جرامات", "غرام", "غرامات", "جم", "غم"].map((unit) => [unit, { kind: "mass", amount: 1, unit: "g" }] as const),
  ...["oz", "ozs", "ounce", "ounces"].map((unit) => [unit, { kind: "mass", amount: 28.349523125, unit: "g" }] as const),
  ...["lb", "lbs", "pound", "pounds"].map((unit) => [unit, { kind: "mass", amount: 453.59237, unit: "g" }] as const),
  ...["l", "liter", "liters", "litre", "litres", "لتر", "ليتر"].map((unit) => [unit, { kind: "volume", amount: 1_000, unit: "ml" }] as const),
  ...["ml", "milliliter", "milliliters", "millilitre", "millilitres", "مل", "مليلتر", "ميليلتر"].map((unit) => [unit, { kind: "volume", amount: 1, unit: "ml" }] as const),
  ...["pc", "pcs", "piece", "pieces", "قطعه", "قطع", "حبه", "حبات"].map((unit) => [unit, { kind: "count", amount: 1, unit: "pcs" }] as const),
  ...["pack", "packs", "pk", "عبوه", "عبوات", "باك"].map((unit) => [unit, { kind: "count", amount: 1, unit: "pack" }] as const),
]);

const UNIT_PATTERN = [...UNIT_ALIASES.keys()]
  .sort((left, right) => right.length - left.length)
  .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

export function bilingualNormalize(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[٠-٩۰-۹]/g, (digit) => ARABIC_DIGITS.get(digit) || digit)
    .replace(/([0-9])[,٫]([0-9])/g, "$1.$2")
    .replace(/٬/g, "")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/[ةۀ]/g, "ه")
    .replace(/ک/g, "ك")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/\.(?!\d)|(?<!\d)\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bilingualTokens(value: string) {
  return [...new Set(bilingualNormalize(value).match(/[\p{L}\p{N}]+/gu) || [])];
}

export function parseCanonicalQuantity(value: string): CanonicalProductQuantity | null {
  const normalized = bilingualNormalize(value);
  if (!normalized) return null;
  const expression = new RegExp(`(?:^|\\s)(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})(?=$|\\s)`, "giu");
  const found: CanonicalProductQuantity[] = [];
  for (const match of normalized.matchAll(expression)) {
    const numeric = Number(match[1]);
    const alias = UNIT_ALIASES.get(match[2].toLowerCase());
    if (!alias || !Number.isFinite(numeric) || numeric <= 0) continue;
    const amount = Number((numeric * alias.amount).toFixed(6));
    if (amount <= 0 || amount > 1_000_000_000) continue;
    if (alias.kind === "count" && !Number.isInteger(amount)) continue;
    found.push({ kind: alias.kind, amount, unit: alias.unit });
  }
  const unique = [...new Map(found.map((item) => [`${item.kind}|${item.amount}|${item.unit}`, item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(values) : value === undefined || value === null ? [] : [value];
}

export function canonicalGtin(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(raw) || /^(\d)\1+$/.test(raw)) return null;
  const digits = [...raw].map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return null;
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) sum += digits[index] * weight;
  if ((10 - (sum % 10)) % 10 !== checkDigit) return null;
  return raw.padStart(14, "0");
}

function compactIdentifier(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const result = String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!result || result.length > 120 || /[<>\u0000-\u001F]/.test(result)) return "";
  return result;
}

function brandName(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
  return compactIdentifier(record?.name ?? value);
}

export function extractProductIdentifiers(record: JsonRecord): ProductIdentifiers {
  const gtins = [...new Set([
    ...values(record.gtin),
    ...values(record.gtin8),
    ...values(record.gtin12),
    ...values(record.gtin13),
    ...values(record.gtin14),
    ...values(record.isbn),
  ].map(canonicalGtin).filter((value): value is string => Boolean(value)))];
  const sku = values(record.sku).map(compactIdentifier).find(Boolean) || undefined;
  const mpn = values(record.mpn).map(compactIdentifier).find(Boolean) || undefined;
  const brand = values(record.brand).map(brandName).find(Boolean) || undefined;
  return { gtins, sku, mpn, brand };
}

export function normalizedBrand(value: string | undefined) {
  return bilingualNormalize(value || "").replace(/\s+/g, "");
}

export function sharedValidGtin(left: ProductIdentifiers | undefined, right: ProductIdentifiers | undefined) {
  const rightGtins = new Set(right?.gtins || []);
  return (left?.gtins || []).find((gtin) => rightGtins.has(gtin)) || "";
}

export function conflictingValidGtins(left: ProductIdentifiers | undefined, right: ProductIdentifiers | undefined) {
  return Boolean(left?.gtins.length && right?.gtins.length && !sharedValidGtin(left, right));
}

export function quantitiesConflict(left: CanonicalProductQuantity | undefined, right: CanonicalProductQuantity | undefined) {
  return Boolean(left && right && (left.kind !== right.kind || left.unit !== right.unit || left.amount !== right.amount));
}

export function quantitiesEqual(left: CanonicalProductQuantity | undefined, right: CanonicalProductQuantity | undefined) {
  return Boolean(left && right && !quantitiesConflict(left, right));
}
