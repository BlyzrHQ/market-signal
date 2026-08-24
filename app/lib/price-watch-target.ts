import { createHash } from "node:crypto";
import { canonicalDomain } from "./domain.ts";
import { isSupportedCurrency, type ProductPriceSignal } from "./product-intelligence.ts";

export const PRICE_WATCH_CANONICALIZATION_VERSION = 1;
const MAX_TARGET_URL_LENGTH = 2_048;
const MARKETING_QUERY_KEYS = new Set(["gclid", "fbclid", "msclkid", "mc_cid", "mc_eid"]);

function normalizedIdentityText(value: unknown, limit: number) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("und")
    .slice(0, limit);
}

function canonicalQuantity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const kind = normalizedIdentityText(source.kind, 40);
  const unit = normalizedIdentityText(source.unit, 24);
  const amount = typeof source.amount === "number" && Number.isFinite(source.amount) && source.amount > 0
    ? String(source.amount)
    : normalizedIdentityText(source.amount, 40);
  return kind && amount && unit ? { kind, amount, unit } : null;
}

export function canonicalPriceWatchUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_TARGET_URL_LENGTH) throw new Error("Invalid price-watch source URL.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid price-watch source URL."); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid price-watch source URL.");
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  url.hash = "";
  if (!url.pathname) url.pathname = "/";
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => {
      const normalized = key.toLowerCase();
      return !normalized.startsWith("utm_") && !MARKETING_QUERY_KEYS.has(normalized);
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, entryValue] of entries) url.searchParams.append(key, entryValue);
  const canonicalUrl = url.toString();
  const domain = canonicalDomain(url.hostname);
  if (canonicalUrl.length > MAX_TARGET_URL_LENGTH || !domain) throw new Error("Invalid price-watch source URL.");
  return { canonicalUrl, domain, version: PRICE_WATCH_CANONICALIZATION_VERSION };
}

export function canonicalPriceWatchVariant(input: {
  quantity?: unknown;
  normalizedVariant?: unknown;
  normalizedSize?: unknown;
}) {
  const identity = {
    quantity: canonicalQuantity(input.quantity),
    normalizedVariant: normalizedIdentityText(input.normalizedVariant, 160),
    normalizedSize: normalizedIdentityText(input.normalizedSize, 120),
  };
  const variantJson = JSON.stringify(identity);
  const hasIdentity = Boolean(identity.quantity || identity.normalizedVariant || identity.normalizedSize);
  const variantKey = hasIdentity
    ? createHash("sha256").update(`price-watch-variant-v${PRICE_WATCH_CANONICALIZATION_VERSION}\n${variantJson}`).digest("hex")
    : "default";
  return { variantKey, variantJson };
}

export function amountToMicros(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const micros = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

export type PriceWatchPriceSnapshot = {
  currency: string;
  amountMicros: number;
  raw: string;
  listAmountMicros: number | null;
  listRaw: string;
};

export function currentPriceSnapshot(signals: unknown): PriceWatchPriceSnapshot | null {
  if (!Array.isArray(signals)) return null;
  const snapshots: PriceWatchPriceSnapshot[] = [];
  for (const candidate of signals) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const signal = candidate as ProductPriceSignal & Record<string, unknown>;
    const currency = String(signal.currency || "").trim().toUpperCase();
    const amountMicros = amountToMicros(signal.amount);
    const raw = String(signal.raw || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!currency || !isSupportedCurrency(currency) || !amountMicros || !raw) continue;
    const listAmount = amountToMicros(signal.listAmount ?? signal.compareAtAmount ?? signal.regularAmount);
    const listRaw = String(signal.listRaw ?? signal.compareAtRaw ?? signal.regularRaw ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    snapshots.push({ currency, amountMicros, raw, listAmountMicros: listAmount && listRaw ? listAmount : null, listRaw: listAmount && listRaw ? listRaw : "" });
  }
  const unique = [...new Map(snapshots.map((snapshot) => [
    `${snapshot.currency}|${snapshot.amountMicros}|${snapshot.listAmountMicros || ""}`,
    snapshot,
  ])).values()];
  return unique.length === 1 ? unique[0] : null;
}
