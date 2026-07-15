export type ParsedPrice = { amount: number; currency: "GBP" | "USD" | "EUR" };

export const DEFENSIBLE_PRODUCT_MATCH_SCORE = 0.55;

export function isDefensibleProductMatch(score: unknown, confidence: unknown) {
  return typeof score === "number" && Number.isFinite(score) && score >= DEFENSIBLE_PRODUCT_MATCH_SCORE && confidence !== "Low";
}

export function parseComparablePrice(raw: string): ParsedPrice | null {
  if (!raw) return null;
  const numbers = raw.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?/g) || [];
  if (numbers.length !== 1) return null;
  const currency = /(?:GBP|£)/i.test(raw) ? "GBP" : /(?:USD|\$)/i.test(raw) ? "USD" : /(?:EUR|€)/i.test(raw) ? "EUR" : "";
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
