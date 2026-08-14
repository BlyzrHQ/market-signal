import { canonicalDomain, normalizeDomain } from "./domain.ts";
import { bilingualNormalize, bilingualTokens, parseCanonicalQuantity, quantitiesConflict } from "./product-normalization.ts";
import { CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX, catalogReplacementAuditAttribute, extractProductsFromHtml, isSupportedCurrency, validateProductPageIdentity, type ProductEnrichmentTarget, type ProductRecord } from "./product-intelligence.ts";
import { confirmedProductCurrency, hasConflictingDirectProductCurrency, parseShopifyProduct, parseWooCommerceProduct, storefrontAdapterRequest } from "./product-page-adapters.ts";
import { sharedRobotsPolicyResolver } from "./robots-policy.ts";
import { stripInactiveHtmlMarkup } from "./active-html-markup.ts";

const MAX_DOCUMENT_BYTES = 1_500_000;
export const MAX_ENRICHMENT_TARGETS = 64;
const MAX_PER_DOMAIN_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";

export type EnrichmentGap = {
  url: string;
  productId: string;
  role: ProductEnrichmentTarget["role"];
  reason: string;
  code?: "robots_unreachable" | "robots_disallowed" | "fetch_failed" | "identity_mismatch" | "adapter_limited";
  httpStatus?: number;
  failureKind?: "robots" | "network" | "http" | "content" | "identity" | "adapter" | "redirect";
};

export type ProductEnrichmentCoverage = {
  pagesRequested: number;
  pagesFetched: number;
  maxPages: number;
  gaps: EnrichmentGap[];
  edgeRecovery?: { recovered: number; requested: number; provider: string; observedAt: string };
};

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

class ProductFetchFailure extends Error {
  readonly failureKind: NonNullable<EnrichmentGap["failureKind"]>;

  constructor(message: string, failureKind: NonNullable<EnrichmentGap["failureKind"]>) {
    super(message);
    this.name = "ProductFetchFailure";
    this.failureKind = failureKind;
  }
}

async function fetchSameDomain(url: string, domain: string, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let current = url;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const checked = new URL(current);
      normalizeDomain(checked.hostname);
      if (canonicalDomain(checked.hostname) !== canonicalDomain(domain)) throw new ProductFetchFailure("redirected off the product domain", "redirect");
      let response: Response;
      try {
        response = await fetch(current, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": USER_AGENT } });
      } catch (error) {
        throw new ProductFetchFailure(error instanceof Error ? error.message : "network request failed", "network");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new ProductFetchFailure("redirect limit reached", "redirect");
        current = new URL(location, current).toString();
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) return { ok: false, status: response.status, contentType, url: current, text: "" };
      let bytes: ArrayBuffer;
      try { bytes = await response.arrayBuffer(); } catch { throw new ProductFetchFailure("response body could not be read", "content"); }
      return {
        ok: true,
        status: response.status,
        contentType,
        url: current,
        text: new TextDecoder().decode(bytes.slice(0, MAX_DOCUMENT_BYTES)),
      };
    }
    throw new ProductFetchFailure("redirect limit reached", "redirect");
  } finally {
    clearTimeout(timeout);
  }
}

function decode(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&pound;|&#163;/gi, "£").replace(/&euro;|&#8364;/gi, "€").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function clean(value: string) {
  return decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodedCodePoint(value: string, radix: number) {
  const code = Number.parseInt(value, radix);
  return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : " ";
}

function decodeEvidence(value: string) {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&pound;|&#163;/gi, "\u00A3")
    .replace(/&euro;|&#8364;/gi, "\u20AC")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&minus;/gi, "\u2212")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&(?:hyphen|dash);/gi, "-")
    .replace(/&ominus;/gi, "-")
    .replace(/&nbsp;/gi, " ")
    .replace(/&dollar;/gi, "$")
    .replace(/&colon;/gi, ":")
    .replace(/&equals;/gi, "=")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+)(?:;|(?=\s|\p{Sc}))/gu, (_, code: string) => decodedCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+)(?:;|(?=\s|\p{Sc}))/giu, (_, code: string) => decodedCodePoint(code, 16));
}

function normalizeLocalizedNumbers(value: string) {
  return value
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\u066b/g, ".")
    .replace(/\u066c/g, ",");
}

const CURRENCY_TOKENS: Record<string, string> = {
  GBP: "(?:\\u00A3|\\bGBP\\b)",
  EUR: "(?:\\u20AC|\\bEUR\\b)",
  USD: "(?:\\$|\\bUSD\\b)",
  KWD: "(?:\\bKWD\\b|(?<![\\u0600-\\u06FF])(?:ك\\s*\\.?\\s*د|د\\s*\\.?\\s*ك)(?![\\u0600-\\u06FF]))",
  BHD: "(?:\\bBHD\\b|(?<![\\u0600-\\u06FF])(?:ب\\s*\\.?\\s*د|د\\s*\\.?\\s*ب)(?![\\u0600-\\u06FF]))",
  OMR: "(?:\\bOMR\\b|(?<![\\u0600-\\u06FF])(?:ر\\s*\\.?\\s*ع|ع\\s*\\.?\\s*ر)(?![\\u0600-\\u06FF]))",
  AED: "(?:\\bAED\\b|(?<![\\u0600-\\u06FF])(?:إ\\s*\\.?\\s*د|د\\s*\\.?\\s*إ)(?![\\u0600-\\u06FF]))",
  SAR: "(?:\\bSAR\\b|\\bSR\\b|(?<![\\u0600-\\u06FF])(?:س\\s*\\.?\\s*ر|ر\\s*\\.?\\s*س)(?![\\u0600-\\u06FF]))",
  QAR: "\\bQAR\\b",
  CAD: "\\bCAD\\b",
  AUD: "\\bAUD\\b",
};

function localizedAmountPattern(currency: string, requireDecimals = false) {
  const decimals = /^(?:KWD|BHD|OMR)$/.test(currency) ? 3 : 2;
  const whole = "(?:[0-9]{1,3}(?:[.,'\\u00A0\\u202F ][0-9]{3})+|[0-9]{1,6})";
  return `${whole}${requireDecimals ? `[.,][0-9]{1,${decimals}}` : `(?:[.,][0-9]{1,${decimals}})?`}`;
}

function currencyAmountExpression(currency: string) {
  const amount = `(?<![\\d.,])${localizedAmountPattern(currency)}(?![\\d.,])`;
  const token = CURRENCY_TOKENS[currency] || currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:${token})\\s*(${amount})|(${amount})\\s*(?:${token})`, "giu");
}

function currencyTokenExpression(currency: string) {
  const token = CURRENCY_TOKENS[currency] || currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:${token})`, "giu");
}

function currencyRangeExpression(currency: string, requireCompleteSuffix = true) {
  const token = CURRENCY_TOKENS[currency] || currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const amount = `[+-]?${localizedAmountPattern(currency)}(?![\\d.,])`;
  const decimalAmount = `[+-]?${localizedAmountPattern(currency, true)}(?![\\d.,])`;
  const completePriceSuffix = "(?=\\s*(?:$|[.,;)]\\s*$|\\/(?:month|mo|year|yr)\\b|per\\s+(?:month|year)\\b|(?:(?:incl|excl)(?:uding)?\\.?\\s+(?:tax|vat)|(?:tax|vat)\\s+(?:included|excluded)|each|per\\s+item)\\b\\s*[.,;)]?\\s*$))";
  const ordinary = `(?:(?:${token})\\s*(${amount})\\s*(?:-|\\bto\\b)\\s*(${amount})|(${amount})\\s*(?:-|\\bto\\b)\\s*(${amount})\\s*(?:${token}))`;
  const slash = `(?:(?:${token})\\s*(${decimalAmount})\\s*\\/\\s*(${decimalAmount})|(${decimalAmount})\\s*\\/\\s*(${decimalAmount})\\s*(?:${token}))`;
  const suffix = requireCompleteSuffix ? completePriceSuffix : "(?=\\s*(?:$|[^\\p{L}%]))";
  return new RegExp(`(?:${ordinary}|${slash})${suffix}`, "giu");
}

function localizedAmount(raw: string, currency: string) {
  const decimals = /^(?:KWD|BHD|OMR)$/.test(currency) ? 3 : 2;
  const compact = raw.replace(/[\s\u00A0\u202F']/gu, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    return Number(comma > dot ? compact.replace(/\./g, "").replace(",", ".") : compact.replace(/,/g, ""));
  }
  if (comma >= 0) {
    const fractionLength = compact.length - comma - 1;
    return Number(fractionLength > 0 && fractionLength <= decimals ? compact.replace(/,/g, ".") : compact.replace(/,/g, ""));
  }
  if (dot >= 0 && compact.length - dot - 1 === 3 && decimals < 3) return Number(compact.replace(/\./g, ""));
  return Number(compact);
}

function isCompletePriceRangeSuffix(value: string) {
  return /^\s*(?:|[.,;)]|\/(?:month|mo|year|yr)\b|per\s+(?:month|year)\b|(?:(?:incl|excl)(?:uding)?\.?\s+(?:tax|vat)|(?:tax|vat)\s+(?:included|excluded)|each|per\s+item)\b\s*[.,;)]?)\s*$/iu.test(value);
}

function currenciesFromMarkup(value: string) {
  const decoded = normalizeLocalizedNumbers(decodeEvidence(value).replace(/<[^>]*>/g, " "));
  return Object.keys(CURRENCY_TOKENS).filter((currency) => currencyAmountExpression(currency).test(decoded));
}

function publicImageFromScope(scope: string, sourceUrl: string) {
  const tags = htmlTagSpans(scope).filter((tag) => !tag.closing && tag.name === "img");
  const acceptedClasses = new Set(["wp-post-image", "woocommerce-product-gallery", "product-image", "product-media"]);
  for (const tag of tags) {
    const classes = htmlAttributeValue(tag.raw, "class")
      .split(/\s+/)
      .map((value) => value.toLowerCase().replace(/[_-]+/g, "-"));
    if (classes.some((value) => /(?:^|-)(?:placeholder|skeleton|loading)(?:-|$)/u.test(value))) continue;
    if (!classes.some((value) => [...acceptedClasses].some((token) => value === token || value.startsWith(`${token}-`)))) continue;
    const raw = ["data-large_image", "data-lazy-src", "data-src", "src"]
      .map((attribute) => htmlAttributeValue(tag.raw, attribute))
      .find(Boolean) || "";
    try {
      const url = new URL(decodeEvidence(raw).replace(/^\/\//, "https://"), sourceUrl);
      if (/^https:$/.test(url.protocol)) return url.toString();
    } catch { /* Ignore malformed public markup. */ }
  }
  return "";
}

function productScope(document: string) {
  const activeDocument = stripInactiveHtmlMarkup(document);
  const title = activeDocument.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i);
  const summaryIndex = activeDocument.search(/class\s*=\s*["'][^"']*(?:summary|product-summary)[^"']*["']/i);
  const start = Math.max(0, title?.index ?? summaryIndex);
  const bounded = activeDocument.slice(start, Math.min(activeDocument.length, start + 160_000));
  const marker = /(?:^|[\s_-])(?:related(?:[\s_-]+products?)?|upsells?|cross[\s_-]*sells?|recommend(?:ed|ations?)|product[\s_-]*recommendations?|you[\s_-]*may[\s_-]*also[\s_-]*like|similar[\s_-]*products?)(?:$|[\s_-])/i;
  let relatedAt = -1;
  for (const tag of bounded.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const markup = tag[0];
    const tagName = tag[1].replace(/:/g, "-");
    const quoted = [...markup.matchAll(/(?:class|id)\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
    const unquoted = [...markup.matchAll(/(?:class|id)\s*=\s*([^\s>"']+)/gi)].map((match) => match[1]);
    if (marker.test(tagName) || [...quoted, ...unquoted].some((value) => marker.test(value))) {
      relatedAt = tag.index ?? -1;
      break;
    }
  }
  return relatedAt >= 0 ? bounded.slice(0, relatedAt) : bounded;
}

function htmlTagSpans(value: string) {
  const tags: Array<{ raw: string; index: number; end: number; name: string; closing: boolean; selfClosing: boolean }> = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "<") continue;
    let quote = "";
    let end = index + 1;
    for (; end < value.length; end += 1) {
      const char = value[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= value.length) break;
    const raw = value.slice(index, end + 1);
    const identity = raw.match(/^<\s*(\/?)\s*([a-z][\w:-]*)/i);
    if (identity) tags.push({ raw, index, end: end + 1, name: identity[2].toLowerCase(), closing: Boolean(identity[1]), selfClosing: /\/\s*>$/.test(raw) });
    index = end;
  }
  return tags;
}

function htmlAttributeValue(tag: string, attributeName: string) {
  const identity = tag.match(/^<\s*\/?\s*[a-z][\w:-]*/i);
  let index = identity?.[0].length ?? tag.length;
  while (index < tag.length) {
    while (/\s/u.test(tag[index] || "")) index += 1;
    if (tag[index] === ">" || tag[index] === "/") break;
    const nameStart = index;
    while (index < tag.length && !/[\s=>/]/u.test(tag[index])) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/u.test(tag[index] || "")) index += 1;
    if (tag[index] !== "=") continue;
    index += 1;
    while (/\s/u.test(tag[index] || "")) index += 1;
    const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : "";
    const valueStart = index;
    if (quote) {
      while (index < tag.length && tag[index] !== quote) index += 1;
    } else {
      while (index < tag.length && !/[\s>]/u.test(tag[index])) index += 1;
    }
    const value = tag.slice(valueStart, index);
    if (quote && tag[index] === quote) index += 1;
    if (name === attributeName.toLowerCase()) return value;
  }
  return "";
}

const unitPriceClassTokens = new Set(["unit-price", "unitprice", "price-per-unit", "price-unit", "price-per-measure"]);
const secondaryPriceClassTokens = new Set(["compare-at", "old-price", "list-price", "regular-price", "price-regular", "member-price", "loyalty-price", "deposit-price", "saving", "savings", "discount"]);

function isUnitPriceClassToken(value: string) {
  return unitPriceClassTokens.has(value)
    || (/(?:^|-)price(?:-|$)/u.test(value) && /(?:^|-)(?:unit|measure)(?:-|$)/u.test(value));
}

function hasIncentiveLabel(value: string) {
  const normalized = value
    .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_-]+/g, " ");
  return /\b(?:(?:e\s*)?gift\s*(?:card|certificate)|voucher|promo(?:tional)?\s+code|promotional\s+credit|store\s*credit)\b/iu.test(normalized);
}

function hasRecurringPriceLead(value: string) {
  const recurringAt = value.search(/\b(?:pay\s+)?(?:daily|weekly|biweekly|monthly|quarterly|yearly|annually)\b/iu);
  const amountAt = value.search(/(?:[$€£¥₹]\s*[+-]?\d|\b[A-Z]{3}\s*[+-]?\d|[+-]?\d[\d\s.,']*\s+[A-Z]{3}\b)/u);
  return recurringAt >= 0 && (amountAt < 0 || recurringAt < amountAt);
}

function elementMarkupByClassTokens(
  scope: string,
  allowedTags: ReadonlySet<string>,
  accepted: ReadonlySet<string>,
  rejected = new Set<string>(),
  rejectMarkup: (markup: string) => boolean = () => false,
) {
  const tags = htmlTagSpans(scope);
  for (let index = 0; index < tags.length; index += 1) {
    const opening = tags[index];
    if (opening.closing || !allowedTags.has(opening.name)) continue;
    const classes = htmlAttributeValue(opening.raw, "class")
      .split(/\s+/)
      .map((value) => value.toLowerCase().replace(/[_-]+/g, "-"));
    const hasRejectedClass = classes.some((value) => [...rejected].some((token) => value === token || value.startsWith(`${token}-`))
      || (rejected === unitPriceClassTokens && isUnitPriceClassToken(value)));
    if (!classes.some((value) => accepted.has(value)) || hasRejectedClass) continue;
    const start = opening.index;
    let depth = 0;
    for (const elementTag of tags.slice(index)) {
      if (elementTag.name !== opening.name) continue;
      depth += elementTag.closing ? -1 : elementTag.selfClosing ? 0 : 1;
      if (depth !== 0) continue;
      const markup = scope.slice(start, elementTag.end);
      if (rejectMarkup(markup)) break;
      return markup;
    }
  }
  return "";
}

function isSecondaryPriceMarkup(markup: string) {
  const hasNestedSecondaryElement = htmlTagSpans(markup).slice(1).some((tag) => {
    if (tag.closing) return false;
    const classes = htmlAttributeValue(tag.raw, "class")
      .split(/\s+/)
      .map((value) => value.toLowerCase().replace(/[_-]+/g, "-"));
    return classes.some((value) => secondaryPriceClassTokens.has(value));
  });
  if (hasNestedSecondaryElement) return false;
  const text = decodeEvidence(markup).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (hasIncentiveLabel(text)) return true;
  if (hasRecurringPriceLead(text)) return true;
  if (/\b(?:now|sale|current)\b/iu.test(text)) return false;
  return /^(?:compare\s+at|was|regular(?:\s+price)?|list\s+price|msrp|rrp|original(?:\s+price)?|retail(?:\s+price)?|deposit|down\s+payment|due\s+today|as\s+low\s+as|financ(?:e|ing)|lease|payment\s+plan|save\b|discount|instant\s+savings?|saving|savings|rebate|cash\s*back|cashback|store\s+credit|coupon|rewards?)/iu.test(text);
}

function preferredCurrentPriceMarkup(scope: string) {
  return elementMarkupByClassTokens(
    scope,
    new Set(["div", "span"]),
    new Set(["product-price-sale", "sale-price", "current-price", "price-current"]),
    unitPriceClassTokens,
    isSecondaryPriceMarkup,
  );
}

function removeSecondaryPriceElements(markup: string) {
  const tags = htmlTagSpans(markup);
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < tags.length; index += 1) {
    const opening = tags[index];
    if (opening.closing) continue;
    const classes = htmlAttributeValue(opening.raw, "class")
      .split(/\s+/)
      .map((value) => value.toLowerCase().replace(/[_-]+/g, "-"));
    if (!classes.some((value) => secondaryPriceClassTokens.has(value))) continue;
    let depth = 0;
    for (const closing of tags.slice(index)) {
      if (closing.name !== opening.name) continue;
      depth += closing.closing ? -1 : closing.selfClosing ? 0 : 1;
      if (depth !== 0) continue;
      ranges.push([opening.index, closing.end]);
      break;
    }
  }
  const merged = ranges.sort((left, right) => left[0] - right[0]).reduce<Array<[number, number]>>((result, range) => {
    const previous = result.at(-1);
    if (!previous || range[0] > previous[1]) result.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
    return result;
  }, []);
  return merged.reverse().reduce((value, [start, end]) => `${value.slice(0, start)} ${value.slice(end)}`, markup);
}

function scopedPriceSignals(currency: string, values: number[]) {
  if (!currency) return [];
  return [...new Set(values.filter((amount) => Number.isFinite(amount) && amount > 0))]
    .sort((left, right) => left - right)
    .map((amount) => ({ raw: `${currency} ${amount}`, currency, amount }));
}

function isRecurringPriceSuffix(value: string) {
  return /^(?:(?:\/\s*|per\s+|a\s+)?(?:day|daily|week|weekly|wk|month|monthly|mo|quarter|quarterly|qtr|year|yearly|annual|annually|yr)s?)\b/iu.test(value.trim());
}

function markedAmounts(markup: string, currency: string) {
  const withoutSecondaryPrices = removeSecondaryPriceElements(markup)
    .replace(/<(s|del)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<(span|div|small|em|strong)\b[^>]*\sstyle\s*=\s*["'][^"']*text-decoration(?:-line)?\s*:\s*line-through[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<(span|div|small|em|strong)\b[^>]*>[\s\S]*?\b(?:save|saving|savings|discount|compare\s+at|was|off)\b[\s\S]*?<\/\1\s*>/giu, " ");
  const decoded = normalizeLocalizedNumbers(decodeEvidence(withoutSecondaryPrices.replace(/<[^>]*>/g, " ")))
    .replace(/\b(?:save|saving|savings|discount|was|compare\s+at)\b[\s\S]*?\b(now|current(?:\s+price)?)\b/giu, "$1")
    .replace(/\b(?:regular|list|original|was)\b[\s\S]*?\b(sale|now|current(?:\s+price)?)\b/giu, "$1")
    .replace(/[\p{Pd}\u207B\u208B\u2212\u2213\u2238\u2296\u229D\u229F\u2796\u2A29-\u2A2C\u2A3A\u2A41\u2A6C]/gu, "-");
  if (/&#(?:x[0-9a-f]+|\d+)/i.test(decoded)) return [];
  const expression = currencyAmountExpression(currency);
  const installmentAt = decoded.search(/\b(?:payments?|instal+ments?|pay\s+in|payment\s+plan|instal+ment\s+plan)\b/iu);
  const observedAmounts = [...decoded.matchAll(expression)];
  const firstObservedAmount = observedAmounts[0];
  if (installmentAt >= 0 && (!firstObservedAmount || installmentAt < (firstObservedAmount.index ?? 0))) return [];
  if (installmentAt >= 0 && firstObservedAmount) {
    const firstEnd = (firstObservedAmount.index ?? 0) + firstObservedAmount[0].length;
    const beforeInstallment = decoded.slice(firstEnd, installmentAt);
    if (/^\s*(?:down|initial|first|monthly|weekly|biweekly)\s*$/iu.test(beforeInstallment)
      || isRecurringPriceSuffix(beforeInstallment)) return [];
  }
  let priceText = decoded;
  if (installmentAt >= 0 && firstObservedAmount) {
    const firstEnd = (firstObservedAmount.index ?? 0) + firstObservedAmount[0].length;
    const beforeInstallment = decoded.slice(0, installmentAt);
    const financingLead = beforeInstallment.match(/(?:\b(?:or|with)\b[\s\S]*|(?:[-,;]|\s)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:(?:interest[- ]free|easy|monthly|weekly|biweekly)\s*)*)$/iu);
    const financingStart = financingLead ? beforeInstallment.length - financingLead[0].length : installmentAt;
    const productPrefix = decoded.slice(0, financingStart).trimEnd();
    const prefixAmounts = [...productPrefix.matchAll(expression)];
    const secondObservedAmount = prefixAmounts[1];
    const between = secondObservedAmount
      ? decoded.slice((firstObservedAmount.index ?? 0) + firstObservedAmount[0].length, secondObservedAmount.index ?? 0)
      : "";
    const secondEnd = secondObservedAmount ? (secondObservedAmount.index ?? 0) + secondObservedAmount[0].length : 0;
    const hasExplicitTokenRange = Boolean(secondObservedAmount
      && /^\s*(?:-|\/|to)\s*$/iu.test(between)
      && isCompletePriceRangeSuffix(productPrefix.slice(secondEnd)));
    const sharedCurrencyRange = [...productPrefix.matchAll(currencyRangeExpression(currency))][0];
    if (hasExplicitTokenRange) {
      priceText = productPrefix.slice(0, (secondObservedAmount!.index ?? 0) + secondObservedAmount![0].length);
    } else if (sharedCurrencyRange) {
      priceText = productPrefix.slice(0, (sharedCurrencyRange.index ?? 0) + sharedCurrencyRange[0].length);
    } else {
      priceText = decoded.slice(0, firstEnd);
    }
  }
  const matches = [...priceText.matchAll(expression)];
  const tokenCount = [...priceText.matchAll(currencyTokenExpression(currency))].length;
  if (matches.length === 0 || matches.length !== tokenCount) return [];
  if (matches.length === 1) {
    const before = priceText.slice(0, matches[0].index ?? 0).trim();
    const after = priceText.slice((matches[0].index ?? 0) + matches[0][0].length).trim();
    if (/\bsave\b[\s\S]*$/iu.test(before)
      || hasIncentiveLabel(before)
      || hasRecurringPriceLead(before)
      || /\b(?:compare\s+at|regular\s+price|list\s+price|msrp|rrp|original\s+price|retail\s+price|deposit|down\s+payment|due\s+today|as\s+low\s+as|financ(?:e|ing)|lease|payment\s+plan|discount|instant\s+savings?|saving|savings|rebate|cash\s*back|cashback|store\s+credit|coupon|rewards?)\b[\s\S]*$/iu.test(before)
      || /^(?:(?:[\p{L}-]+\s+){0,3})?(?:off|deposit|down\s+payment|due\s+today|discount|instant\s+savings?|saving|savings|rebate|cash\s*back|cashback|back|store\s+credit|gift\s+card|credit|coupon|rewards?\s+points?|points?)\b/iu.test(after)
      || (after.length <= 80 && hasIncentiveLabel(after))
      || isRecurringPriceSuffix(after)) return [];
  }
  const validContexts = matches.every((match) => {
      const start = match.index ?? 0;
      const before = priceText.slice(0, start);
      const after = priceText.slice(start + match[0].length);
      const trimmedBefore = before.trimEnd();
      const signPrefix = trimmedBefore.endsWith("-") ? trimmedBefore.slice(0, -1).trimEnd() : null;
      const negativePrefix = signPrefix !== null && (!signPrefix || /[:=]\s*$/u.test(signPrefix));
      return !negativePrefix
        && !/\(\s*$/u.test(before)
        && !/^\s*\)/u.test(after)
        && !/^\s*-\s*$/u.test(after);
    });
  if (!validContexts) return [];
  const amounts = matches.map((match) => localizedAmount(match[1] || match[2], currency));
  const rangeAmounts: number[] = [];
  for (const range of priceText.matchAll(currencyRangeExpression(currency))) {
    const rangeStart = range.index ?? -1;
    const rangeEnd = rangeStart + range[0].length;
    const firstMatchStart = matches[0].index ?? -2;
    const firstMatchEnd = firstMatchStart + matches[0][0].length;
    if (rangeStart !== firstMatchStart && !(rangeStart < firstMatchStart && rangeEnd >= firstMatchEnd)) continue;
    const endpoints = [localizedAmount(range[1] || range[3] || range[5] || range[7], currency), localizedAmount(range[2] || range[4] || range[6] || range[8], currency)];
    rangeAmounts.push(...endpoints);
  }
  if (rangeAmounts.length) return rangeAmounts.every((amount) => Number.isFinite(amount) && amount > 0) ? rangeAmounts : [];
  if (matches.length > 1) {
    const firstEnd = (matches[0].index ?? 0) + matches[0][0].length;
    const secondStart = matches[1].index ?? 0;
    const secondEnd = secondStart + matches[1][0].length;
    const explicitRange = /^\s*(?:-|\/|to)\s*$/iu.test(priceText.slice(firstEnd, secondStart))
      && isCompletePriceRangeSuffix(priceText.slice(secondEnd));
    return explicitRange && amounts.slice(0, 2).every((amount) => Number.isFinite(amount) && amount > 0)
      ? amounts.slice(0, 2)
      : [];
  }
  return amounts.every((amount) => Number.isFinite(amount) && amount > 0) ? amounts : [];
}

export function extractScopedProductPageEvidence(document: string, sourceUrl = "https://product.invalid/") {
  const scope = productScope(document);
  const priceMarkup = preferredCurrentPriceMarkup(scope)
    || elementMarkupByClassTokens(
      scope,
      new Set(["p"]),
      new Set(["price"]),
      unitPriceClassTokens,
      isSecondaryPriceMarkup,
    )
    || elementMarkupByClassTokens(scope, new Set(["div", "span"]), new Set(["product-price", "single-product-price"]), unitPriceClassTokens, isSecondaryPriceMarkup)
    || "";
  const currentMarkup = priceMarkup.match(/<ins\b[^>]*>([\s\S]*?)<\/ins>/i)?.[1]
    || priceMarkup.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, " ");
  const decodedPriceMarkup = normalizeLocalizedNumbers(decodeEvidence(currentMarkup).replace(/<[^>]*>/g, " "));
  const markedCurrencies = currenciesFromMarkup(currentMarkup);
  const directCurrency = confirmedProductCurrency(document, { allowStructured: false });
  const hasDollarSymbol = /\$/.test(decodedPriceMarkup);
  const hasAmbiguousCordobaMarker = /(?:C\$|\bC\s+\$)\s*[+-]?\d/iu.test(decodedPriceMarkup)
    && !/\b(?:vitamin|grade|type|model|size|option|plan)\s+C\s+\$\s*[+-]?\d/iu.test(decodedPriceMarkup);
  const dollarCurrencies = new Set([
    "ARS", "AUD", "BMD", "BND", "BRL", "BSD", "BZD", "CAD", "CLP", "COP", "DOP", "FJD", "GYD", "HKD", "JMD",
    "KYD", "LRD", "MXN", "NAD", "NIO", "NZD", "SBD", "SGD", "SRD", "TTD", "TWD", "USD", "XCD", "ZWL",
  ]);
  const qualifiedDollarMarkers: ReadonlyArray<[currency: string, marker: RegExp]> = [
    ["USD", /(?:^|[^\p{L}\p{N}])US\s*\$\s*[+-]?\d/iu],
    ["CAD", /(?:^|[^\p{L}\p{N}])CA\s*\$\s*[+-]?\d/iu],
    ["AUD", /(?:^|[^\p{L}\p{N}])(?:AU\s*\$|A\$)\s*[+-]?\d/iu],
    ["BRL", /(?:^|[^\p{L}\p{N}])R\$\s*[+-]?\d/iu],
    ["DOP", /(?:^|[^\p{L}\p{N}])RD\s*\$\s*[+-]?\d/iu],
    ["HKD", /(?:^|[^\p{L}\p{N}])HK\s*\$\s*[+-]?\d/iu],
    ["MXN", /(?:^|[^\p{L}\p{N}])MX\s*\$\s*[+-]?\d/iu],
    ["NZD", /(?:^|[^\p{L}\p{N}])NZ\s*\$\s*[+-]?\d/iu],
    ["SGD", /(?:^|[^\p{L}\p{N}])S\$\s*[+-]?\d/iu],
    ["TWD", /(?:^|[^\p{L}\p{N}])NT\s*\$\s*[+-]?\d/iu],
  ];
  const qualifiedDollarCurrencies = qualifiedDollarMarkers
    .filter(([, marker]) => marker.test(decodedPriceMarkup))
    .map(([currency]) => currency);
  const explicitPriceCurrencies = [...decodedPriceMarkup.matchAll(/\b[A-Za-z]{3}\b/g)]
    .filter((match) => {
      const index = match.index ?? 0;
      return /^\s*(?:\p{Sc}\s*)?[+-]?\d/u.test(decodedPriceMarkup.slice(index + match[0].length))
        || /\d(?:[.,]\d+)?\s*$/.test(decodedPriceMarkup.slice(0, index));
    })
    .map((match) => match[0].toUpperCase())
    .filter(isSupportedCurrency);
  const nonDollarMarkedCurrencies = markedCurrencies.filter((currency) => currency !== "USD" || !hasDollarSymbol || /\bUSD\b/i.test(decodedPriceMarkup));
  const observedPriceCurrencies = [...new Set([...explicitPriceCurrencies, ...nonDollarMarkedCurrencies, ...qualifiedDollarCurrencies])];
  const directConflict = Boolean(directCurrency && (
    observedPriceCurrencies.some((currency) => currency !== directCurrency)
    || (hasAmbiguousCordobaMarker && !new Set(["CAD", "NIO"]).has(directCurrency))
  ));
  const observedCurrency = directConflict
    ? ""
    : directCurrency && hasDollarSymbol && dollarCurrencies.has(directCurrency)
    ? directCurrency
    : directCurrency && observedPriceCurrencies.length > 0 && !observedPriceCurrencies.includes(directCurrency)
      ? ""
      : observedPriceCurrencies.length === 1 && !(hasDollarSymbol && !/\bUSD\b/i.test(decodedPriceMarkup) && !directCurrency)
        ? observedPriceCurrencies[0]
        : observedPriceCurrencies.length > 1
          ? ""
          : directCurrency;
  const currency = isSupportedCurrency(observedCurrency) ? observedCurrency.trim().toUpperCase() : "";
  const variationAttributeMatch = scope.match(/\bdata-product_variations(?:\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s>]+)))?/i);
  const variationAttribute = variationAttributeMatch ? (variationAttributeMatch[1] ?? variationAttributeMatch[2] ?? variationAttributeMatch[3] ?? "") : "";
  if (variationAttributeMatch && currency) {
    if (!variationAttribute) return { priceSignals: [], basis: "unavailable" as const, imageUrl: publicImageFromScope(scope, sourceUrl) };
    try {
      const variations = JSON.parse(decodeEvidence(variationAttribute));
      if (!Array.isArray(variations) || !variations.length) {
        return { priceSignals: [], basis: "unavailable" as const, imageUrl: publicImageFromScope(scope, sourceUrl) };
      }
      const rawAmounts = variations.map((variation) => variation?.display_price);
      if (rawAmounts.some((amount) => typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)) return { priceSignals: [], basis: "unavailable" as const, imageUrl: publicImageFromScope(scope, sourceUrl) };
      const amounts = rawAmounts;
      const signals = scopedPriceSignals(currency, amounts);
      if (signals.length) return { priceSignals: signals, basis: signals.length > 1 ? "range" as const : "point" as const, imageUrl: publicImageFromScope(scope, sourceUrl) };
    } catch { return { priceSignals: [], basis: "unavailable" as const, imageUrl: publicImageFromScope(scope, sourceUrl) }; }
  }

  const comparableMarkup = directCurrency && hasDollarSymbol && dollarCurrencies.has(directCurrency)
    ? currentMarkup
      .replace(/\b(?:US|CA|C|AU|A|RD|R|HK|MX|NZ|S|NT)\s*\$/gi, `${directCurrency} `)
      .replace(/\$/g, `${directCurrency} `)
    : currentMarkup;
  const signals = scopedPriceSignals(currency, markedAmounts(comparableMarkup, currency));
  return {
    priceSignals: signals,
    basis: signals.length > 1 ? "range" as const : signals.length === 1 ? (/<ins\b/i.test(priceMarkup) ? "sale" as const : "point" as const) : "unavailable" as const,
    imageUrl: publicImageFromScope(scope, sourceUrl),
  };
}

function addScopedProductPageEvidence(document: string, sourceUrl: string, expected: ProductRecord, products: ProductRecord[], pageTitle: string) {
  const evidence = extractScopedProductPageEvidence(document, sourceUrl);
  if (!evidence.priceSignals.length && !evidence.imageUrl) return;
  const identity = validateProductPageIdentity([expected], products, pageTitle, { allowScopedPageSignal: true });
  if (!identity.accepted) return;
  const selected = identity.products[0];
  const selectedPositive = withPositivePrices(selected);
  products.push({
    ...selected,
    priceSignals: selectedPositive.priceSignals.length ? selectedPositive.priceSignals : evidence.priceSignals,
    imageUrl: selected.imageUrl || evidence.imageUrl,
    attributes: [...new Set([...selected.attributes, ...(evidence.priceSignals.length ? [`Price evidence: ${evidence.basis}`] : [])])],
    extraction: selected.extraction === "json-ld" ? selected.extraction : "page-signal",
  });
}

function pageExtraction(document: string, sourceUrl: string, domain: string) {
  const pageTitle = clean(document.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || domain);
  const pageDescription = decode(document.match(/<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i)?.[1] || "");
  const headings = [...document.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((match) => clean(match[1] || "")).filter(Boolean).slice(0, 16);
  const readable = clean(document.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " "));
  const pagePriceSignals = [...new Set(readable.match(/(?:[$€£]\s?\d{1,5}(?:[,.]\d{1,2})?|\d{1,5}(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP))/gi) || [])].slice(0, 12);
  return { pageTitle, result: extractProductsFromHtml({ document, sourceUrl, domain, observedAt: new Date().toISOString(), pageTitle, pageDescription, headings, pagePriceSignals }) };
}

function expectedProduct(item: ProductEnrichmentTarget): ProductRecord {
  return {
    id: item.productId,
    domain: item.domain,
    name: item.expectedName,
    normalizedName: bilingualNormalize(item.expectedName),
    description: "",
    category: "product",
    jsonLdType: "Product",
    priceSignals: [],
    attributes: [],
    ownership: "path-inferred",
    extraction: "sitemap",
    confidence: "Medium",
    sourceUrl: item.sourceUrl,
    imageUrl: "",
    observedAt: new Date().toISOString(),
    claimIds: [],
    quantity: parseCanonicalQuantity(item.expectedName) || undefined,
  };
}

function canonicalSelectedPage(value: string) {
  try {
    const url = new URL(value);
    return `${canonicalDomain(url.hostname)}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch { return ""; }
}

function liveTitleIdentity(pageTitle: string) {
  return pageTitle.split(/\s+[|–—]\s+/u)[0]?.trim() || pageTitle.trim();
}

function titleAlignedProduct(product: ProductRecord, pageTitle: string) {
  const titleIdentity = liveTitleIdentity(pageTitle);
  const normalizedTitle = bilingualNormalize(titleIdentity.replace(/(?:\.{3}|…)+$/u, ""));
  const truncatedPrefix = /(?:\.{3}|…)$/u.test(titleIdentity) && normalizedTitle.length >= 12 && product.normalizedName.startsWith(normalizedTitle);
  const titleTokens = new Set(bilingualTokens(titleIdentity).filter((token) => token.length >= 2));
  const productTokens = bilingualTokens(product.name).filter((token) => token.length >= 2);
  const coverage = productTokens.filter((token) => titleTokens.has(token)).length / Math.max(1, productTokens.length);
  const titleQuantity = parseCanonicalQuantity(titleIdentity) || undefined;
  return productTokens.length >= 2 && (coverage >= 0.8 || truncatedPrefix) && !quantitiesConflict(titleQuantity, product.quantity);
}

function observedCatalogReplacement(item: ProductEnrichmentTarget, products: ProductRecord[], pageTitle: string, fetchedUrl: string) {
  if (item.allowCatalogReplacement !== true || canonicalSelectedPage(item.sourceUrl) !== canonicalSelectedPage(fetchedUrl)) return null;
  const candidates = products.filter((product) => product.jsonLdType === "Product"
    && (product.extraction === "json-ld" || product.extraction === "storefront-api")
    && canonicalSelectedPage(product.sourceUrl) === canonicalSelectedPage(item.sourceUrl)
    && titleAlignedProduct(product, pageTitle));
  const groups: ProductRecord[][] = [];
  for (const candidate of candidates) {
    const group = groups.find((entries) => validateProductPageIdentity([entries[0]], [candidate], pageTitle).accepted
      && validateProductPageIdentity([candidate], [entries[0]], pageTitle).accepted);
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  if (groups.length !== 1) return null;
  const product = [...groups[0]].sort((left, right) =>
    Number(right.extraction === "storefront-api") - Number(left.extraction === "storefront-api")
      || Number(right.priceSignals.length > 0) - Number(left.priceSignals.length > 0)
      || Number(/^https:\/\//i.test(right.imageUrl)) - Number(/^https:\/\//i.test(left.imageUrl))
      || left.name.localeCompare(right.name))[0];
  if (!product) return null;
  const observedAt = product.observedAt || new Date().toISOString();
  const audit = catalogReplacementAuditAttribute(item.expectedName, item.sourceUrl);
  return {
    ...product,
    id: item.productId,
    domain: canonicalDomain(item.domain),
    normalizedName: bilingualNormalize(product.name),
    attributes: [...new Set([...product.attributes.filter((attribute) => !attribute.startsWith(CATALOG_REPLACEMENT_ATTRIBUTE_PREFIX)), audit])],
    sourceUrl: item.sourceUrl,
    observedAt,
    claimIds: [...new Set([...product.claimIds, `${item.productId}-catalog-replacement-${Date.parse(observedAt) || 0}`])],
    quantity: parseCanonicalQuantity(product.name) || product.quantity || undefined,
  } satisfies ProductRecord;
}

function isPositivePriceSignal(signal: ProductRecord["priceSignals"][number]) {
  return typeof signal.amount === "number" && Number.isFinite(signal.amount) && signal.amount > 0 && isSupportedCurrency(signal.currency);
}

function withPositivePrices(product: ProductRecord) {
  const positive = product.priceSignals.filter(isPositivePriceSignal);
  const removedObservedAmount = product.priceSignals.some((signal) => typeof signal.amount === "number" && Number.isFinite(signal.amount) && !isPositivePriceSignal(signal));
  return { ...product, priceSignals: removedObservedAmount && product.priceSignals.length > 1 ? [] : positive };
}

function hasConfirmedPrice(products: ProductRecord[]) {
  return products.some((product) => product.priceSignals.some(isPositivePriceSignal));
}

function confirmedAdapterCurrency(document: string, matchedProduct?: ProductRecord) {
  if (hasConflictingDirectProductCurrency(document)) return "";
  const storefrontCurrency = confirmedProductCurrency(document, { allowStructured: false });
  const matchedCurrencies = [...new Set((matchedProduct?.priceSignals || [])
    .map((signal) => {
      const currency = signal.currency?.trim().toUpperCase() || "";
      return currency && new RegExp(`(?:^|[^A-Z])${currency}(?:[^A-Z]|$)`, "i").test(signal.raw) ? currency : "";
    })
    .filter(isSupportedCurrency))];
  if (matchedCurrencies.length > 1) return "";
  if (storefrontCurrency && matchedCurrencies.length === 1 && storefrontCurrency !== matchedCurrencies[0]) return "";
  return storefrontCurrency || matchedCurrencies[0] || "";
}

function hasSecureImage(products: ProductRecord[]) {
  return products.some((product) => /^https:\/\//i.test(product.imageUrl));
}

function productsCanShareEvidence(left: ProductRecord | null, right: ProductRecord | null, pageTitle: string) {
  return Boolean(left && right
    && validateProductPageIdentity([left], [right], pageTitle, { allowScopedPageSignal: true }).accepted
    && validateProductPageIdentity([right], [left], pageTitle, { allowScopedPageSignal: true }).accepted);
}

function comparablePrice(product: ProductRecord) {
  const prices = product.priceSignals.filter(isPositivePriceSignal);
  return prices.length > 0 && new Set(prices.map((signal) => signal.currency)).size === 1 && new Set(prices.map((signal) => signal.amount)).size === 1;
}

function safeProductUrl(product: ProductRecord, domain: string) {
  try {
    const url = new URL(product.sourceUrl);
    return /^https?:$/.test(url.protocol)
      && canonicalDomain(url.hostname) === canonicalDomain(domain)
      && Boolean(storefrontAdapterRequest(url.toString()))
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

export function selectPrimaryProductPriceTargets(products: ProductRecord[], domain: string, maxPages = 6): ProductEnrichmentTarget[] {
  const limit = Math.max(0, Math.min(MAX_ENRICHMENT_TARGETS, Math.floor(maxPages)));
  const seen = new Set<string>();
  return products
    .filter((product) => product.jsonLdType === "Product" && !comparablePrice(product))
    .map((product) => ({ product, sourceUrl: safeProductUrl(product, domain) }))
    .filter((entry) => Boolean(entry.sourceUrl) && !seen.has(entry.sourceUrl) && Boolean(seen.add(entry.sourceUrl)))
    .sort((left, right) => Number(Boolean(right.product.quantity || parseCanonicalQuantity(right.product.name))) - Number(Boolean(left.product.quantity || parseCanonicalQuantity(left.product.name))) || left.product.name.localeCompare(right.product.name))
    .slice(0, limit)
    .map(({ product, sourceUrl }) => ({
      domain: canonicalDomain(domain),
      sourceUrl,
      productId: product.id,
      expectedName: product.name,
      expectedType: "Product" as const,
      pairScore: 0,
      role: "primary" as const,
      allowCatalogReplacement: true as const,
    }));
}

function priceAmount(value: string) {
  const matched = value.match(/\d{1,5}(?:[,.]\d{1,2})?/i)?.[0];
  if (!matched) return null;
  const normalized = matched.includes(",") && !matched.includes(".") ? matched.replace(",", ".") : matched.replace(/,/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function claimablePagePricePatterns(values: string[]) {
  return values.filter((value) => priceAmount(value) !== 0);
}

export async function enrichProductTargets(targets: ProductEnrichmentTarget[], maxPages = 24) {
  const boundedMax = Math.max(0, Math.min(MAX_ENRICHMENT_TARGETS, Math.floor(maxPages)));
  const selected = targets.slice(0, boundedMax);
  const robotsByDomain = new Map<string, Awaited<ReturnType<typeof sharedRobotsPolicyResolver.resolve>>>();
  await Promise.all([...new Set(selected.map((item) => item.domain))].map(async (domain) => {
    const preferred = selected.find((item) => item.domain === domain)?.sourceUrl || domain;
    robotsByDomain.set(domain, await sharedRobotsPolicyResolver.resolve(domain, preferred));
  }));

  const enrichOne = async (item: ProductEnrichmentTarget) => {
    const gap = (reason: string, code?: EnrichmentGap["code"], httpStatus?: number, failureKind?: EnrichmentGap["failureKind"]): EnrichmentGap => ({ url: item.sourceUrl, productId: item.productId, role: item.role, reason, ...(code ? { code } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}), ...(failureKind ? { failureKind } : {}) });
    try {
      const robotsResult = robotsByDomain.get(item.domain);
      const availability = robotsResult?.availability || "unreachable";
      if (availability === "unreachable") return { product: null, gap: gap("robots.txt was unreachable, so selected-product enrichment was skipped.", "robots_unreachable", undefined, "robots") };
      const robots = robotsResult?.policy;
      if (!robots) return { product: null, gap: gap("robots.txt was unreachable, so selected-product enrichment was skipped.", "robots_unreachable", undefined, "robots") };
      if (!robots.allows(new URL(item.sourceUrl).pathname)) return { product: null, gap: gap("robots.txt disallows this selected product page.", "robots_disallowed", undefined, "robots") };
      const fetched = await fetchSameDomain(item.sourceUrl, item.domain, "text/html,application/xhtml+xml");
      if (!fetched.ok) return { product: null, gap: gap(`Selected product page returned HTTP ${fetched.status} or non-HTML content.`, "fetch_failed", fetched.status, "http") };
      if (!/text\/html|application\/xhtml\+xml/i.test(fetched.contentType)) return { product: null, gap: gap(`Selected product page returned HTTP ${fetched.status} or non-HTML content.`, "fetch_failed", fetched.status, "content") };
      const extracted = pageExtraction(fetched.text, fetched.url, item.domain);
      const expected = expectedProduct(item);
      addScopedProductPageEvidence(fetched.text, fetched.url, expected, extracted.result.products, extracted.pageTitle);
      const rawInitialIdentity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle, { allowScopedPageSignal: true });
      const rawMatchedProduct = rawInitialIdentity.products[0];
      extracted.result.products = extracted.result.products.map(withPositivePrices);
      const initialIdentity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle);
      const replacementCandidates = [...extracted.result.products];
      let adapterGap = "";
      let adapterEvidenceProduct: ProductRecord | null = null;
      const adapter = storefrontAdapterRequest(item.sourceUrl);
      const strongestInitialProduct = initialIdentity.products[0];
      if (adapter && (!initialIdentity.accepted || !strongestInitialProduct || !hasConfirmedPrice([strongestInitialProduct]) || !hasSecureImage([strongestInitialProduct]))) {
        const adapterLabel = adapter.kind === "shopify" ? "Shopify product" : "WooCommerce Store API";
        try {
          const adapterUrl = new URL(adapter.endpointUrl);
          if (!robots.allows(`${adapterUrl.pathname}${adapterUrl.search}`)) {
            adapterGap = `robots.txt disallows the ${adapterLabel} endpoint.`;
          } else {
            const adapterResponse = await fetchSameDomain(adapter.endpointUrl, item.domain, "application/json");
            if (!adapterResponse.ok || !/json|javascript/i.test(adapterResponse.contentType)) {
              adapterGap = `${adapterLabel} endpoint returned HTTP ${adapterResponse.status} or non-JSON content.`;
            } else {
              const payload = JSON.parse(adapterResponse.text);
              const observedAt = new Date().toISOString();
              const adapterResult = adapter.kind === "shopify"
                ? parseShopifyProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt, currency: confirmedAdapterCurrency(fetched.text, rawMatchedProduct), expectedQuantity: expected.quantity })
                : parseWooCommerceProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt: new Date().toISOString() });
              if (adapterResult.product) {
                adapterEvidenceProduct = withPositivePrices(adapterResult.product);
                extracted.result.products.push(adapterEvidenceProduct);
              }
              if (item.allowCatalogReplacement === true && !initialIdentity.accepted) {
                const replacementAdapterResult = adapter.kind === "shopify"
                  ? parseShopifyProduct({ payload, requestedKey: adapter.requestedKey, sourceUrl: fetched.url, domain: item.domain, observedAt, currency: confirmedAdapterCurrency(fetched.text, rawMatchedProduct) })
                  : adapterResult;
                if (replacementAdapterResult.product) replacementCandidates.push(withPositivePrices(replacementAdapterResult.product));
              }
              adapterGap = adapterResult.gap;
            }
          }
        } catch (error) {
          adapterGap = error instanceof SyntaxError ? `${adapterLabel} endpoint returned invalid JSON.` : `${adapterLabel} endpoint could not be fetched.`;
        }
      }
      const identity = validateProductPageIdentity([expected], extracted.result.products, extracted.pageTitle, { allowScopedPageSignal: true });
      if (!identity.accepted) {
        const replacement = observedCatalogReplacement(item, replacementCandidates, extracted.pageTitle, fetched.url);
        return replacement ? { product: replacement, gap: null } : { product: null, gap: gap(identity.reason, "identity_mismatch", undefined, "identity") };
      }
      const originalIdentityProduct = strongestInitialProduct
        && identity.products.includes(strongestInitialProduct)
        ? strongestInitialProduct
        : null;
      const adapterIdentityProduct = adapterEvidenceProduct
        && identity.products.includes(adapterEvidenceProduct)
        ? adapterEvidenceProduct
        : null;
      const originalAccepted = originalIdentityProduct && hasConfirmedPrice([originalIdentityProduct])
        ? originalIdentityProduct
        : null;
      const adapterCompatible = !originalIdentityProduct || productsCanShareEvidence(adapterIdentityProduct, originalIdentityProduct, extracted.pageTitle);
      const accepted = originalAccepted
        ? (!hasSecureImage([originalAccepted]) && adapterIdentityProduct?.imageUrl && productsCanShareEvidence(originalAccepted, adapterIdentityProduct, extracted.pageTitle)
            ? { ...originalAccepted, imageUrl: adapterIdentityProduct.imageUrl }
            : originalAccepted)
        : adapterIdentityProduct
          && hasConfirmedPrice([adapterIdentityProduct])
          && adapterCompatible
          ? { ...adapterIdentityProduct, imageUrl: adapterIdentityProduct.imageUrl || (productsCanShareEvidence(adapterIdentityProduct, originalIdentityProduct, extracted.pageTitle) ? originalIdentityProduct?.imageUrl : "") || "" }
          : originalIdentityProduct || identity.products[0];
      const unresolvedAdapterGap = adapterGap && accepted && !hasConfirmedPrice([accepted]) ? adapterGap : "";
      return { product: accepted ? { ...accepted, id: item.productId } : null, gap: unresolvedAdapterGap ? gap(unresolvedAdapterGap, "adapter_limited", undefined, "adapter") : null };
    } catch (error) {
      const failureKind = error instanceof ProductFetchFailure ? error.failureKind : "content";
      return { product: null, gap: gap(error instanceof Error ? `Selected product page could not be fetched: ${error.message}` : "Selected product page could not be fetched.", "fetch_failed", failureKind === "network" ? 0 : undefined, failureKind) };
    }
  };

  const entries = new Array<Awaited<ReturnType<typeof enrichOne>>>(selected.length);
  const targetIndexesByDomain = new Map<string, number[]>();
  selected.forEach((item, index) => targetIndexesByDomain.set(item.domain, [...(targetIndexesByDomain.get(item.domain) || []), index]));
  await Promise.all([...targetIndexesByDomain.values()].map(async (indexes) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_PER_DOMAIN_CONCURRENCY, indexes.length) }, async () => {
      while (cursor < indexes.length) {
        const index = indexes[cursor];
        cursor += 1;
        entries[index] = await enrichOne(selected[index]);
      }
    }));
  }));

  const products = entries.flatMap((entry) => entry.product ? [entry.product] : []);
  const missingRobotsGaps = [...robotsByDomain.entries()].flatMap(([domain, result]) => {
    if (result.availability !== "missing") return [];
    const first = selected.find((item) => item.domain === domain);
    return first ? [{ url: result.sourceUrl, productId: first.productId, role: first.role, reason: `No robots.txt was published (HTTP ${result.status}); bounded selected-product enrichment proceeded.` }] : [];
  });
  const gaps = [...entries.flatMap((entry) => entry.gap ? [entry.gap] : []), ...missingRobotsGaps];
  return { products, coverage: { pagesRequested: selected.length, pagesFetched: products.length, maxPages: boundedMax, gaps } satisfies ProductEnrichmentCoverage };
}

export function publicProductTarget(value: unknown): ProductEnrichmentTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const domain = canonicalDomain(text(item.domain, 300));
  const productId = text(item.productId, 300);
  const expectedName = text(item.expectedName, 160);
  let sourceUrl = "";
  try {
    const url = new URL(text(item.sourceUrl, 1_000));
    sourceUrl = /^https?:$/.test(url.protocol)
      && canonicalDomain(url.hostname) === domain
      && /\/(?:products?|shop|store)\//i.test(url.pathname)
      ? url.toString()
      : "";
  } catch {
    sourceUrl = "";
  }
  if (!domain || !sourceUrl || !productId || !expectedName || item.expectedType !== "Product") return null;
  return { domain, sourceUrl, productId, expectedName, expectedType: "Product", pairScore: typeof item.pairScore === "number" && Number.isFinite(item.pairScore) ? item.pairScore : 0, role: item.role === "rival" ? "rival" : "primary", ...(item.allowCatalogReplacement === true ? { allowCatalogReplacement: true as const } : {}) };
}
