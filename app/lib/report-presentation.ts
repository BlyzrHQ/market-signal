export type ParsedPrice = { amount: number; currency: string };

export const DEFENSIBLE_PRODUCT_MATCH_SCORE = 0.55;

const PRESENTATION_CURRENCIES = new Set<string>((() => {
  try {
    return (Intl as typeof Intl & { supportedValuesOf(key: "currency"): string[] }).supportedValuesOf("currency");
  } catch {
    return ["AED", "AUD", "CAD", "CHF", "CNY", "EGP", "EUR", "GBP", "INR", "JOD", "KWD", "OMR", "QAR", "SAR", "USD"];
  }
})());

export function isDefensibleProductMatch(score: unknown, confidence: unknown) {
  return typeof score === "number" && Number.isFinite(score) && score >= DEFENSIBLE_PRODUCT_MATCH_SCORE && confidence !== "Low";
}

export function parseComparablePrice(raw: string): ParsedPrice | null {
  if (!raw) return null;
  const numbers = raw.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?/g) || [];
  if (numbers.length !== 1) return null;
  const isoCurrency = raw.match(/\b[A-Z]{3}\b/i)?.[0]?.toUpperCase() || "";
  const currency = PRESENTATION_CURRENCIES.has(isoCurrency)
    ? isoCurrency
    : /£/.test(raw) ? "GBP" : /\$/.test(raw) ? "USD" : /€/.test(raw) ? "EUR" : "";
  const amount = Number(/^\d{1,3}(?:,\d{3})+/.test(numbers[0]) ? numbers[0].replace(/,/g, "") : numbers[0].replace(",", "."));
  return currency && Number.isFinite(amount) ? { amount, currency } : null;
}

export function comparablePriceDelta(primaryRaw: string, rivalRaw: string) {
  const primary = parseComparablePrice(primaryRaw);
  const rival = parseComparablePrice(rivalRaw);
  if (!primary || !rival || primary.currency !== rival.currency || primary.amount <= 0) return null;
  const equal = primary.amount === rival.amount;
  const percent = equal ? 0 : rival.amount < primary.amount
    ? -Math.round(((primary.amount - rival.amount) / primary.amount) * 100)
    : Math.round(((rival.amount - primary.amount) / rival.amount) * 100);
  return { primary, rival, percent, equal };
}

export function resolvedPriceDelta(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const primaryRaw = typeof record.primaryRaw === "string" ? record.primaryRaw : "";
  const rivalRaw = typeof record.rivalRaw === "string" ? record.rivalRaw : "";
  const comparison = comparablePriceDelta(primaryRaw, rivalRaw);
  return comparison ? { ...comparison, primaryRaw, rivalRaw } : null;
}
