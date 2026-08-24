export type RegionSignal = {
  countryCode: string;
  kind: "tld" | "language" | "structured-address" | "currency" | "phone" | "explicit-market" | "fulfillment-location" | "global-market";
  value: string;
  weight: number;
  sourceUrl: string;
  claimType: "Observed" | "Inferred";
};

export type RegionInference = {
  countryCode: string;
  country: string;
  confidence: "High" | "Medium" | "Low";
  signals: RegionSignal[];
  scores: Record<string, number>;
};

type RegionInput = {
  domain: string;
  language: string;
  document?: string;
  text?: string;
  priceSignals?: string[];
  sourceUrl: string;
};

const COUNTRY_NAMES: Record<string, string> = {
  AE: "United Arab Emirates",
  DE: "Germany",
  EG: "Egypt",
  FR: "France",
  GB: "United Kingdom",
  IN: "India",
  KW: "Kuwait",
  SA: "Saudi Arabia",
  US: "United States",
  GLOBAL: "Global market",
};

const TLD_COUNTRIES: Array<[RegExp, string]> = [
  [/\.(?:co\.)?uk$/i, "GB"],
  [/\.us$/i, "US"],
  [/\.eg$/i, "EG"],
  [/\.in$/i, "IN"],
  [/\.kw$/i, "KW"],
  [/\.sa$/i, "SA"],
  [/\.ae$/i, "AE"],
  [/\.de$/i, "DE"],
  [/\.fr$/i, "FR"],
];

const LANGUAGE_COUNTRIES: Record<string, string> = {
  "en-gb": "GB",
  "en-us": "US",
  "en-in": "IN",
  "hi-in": "IN",
  "ar-kw": "KW",
  "en-kw": "KW",
  "de-de": "DE",
  "fr-fr": "FR",
  "ar-eg": "EG",
  "ar-sa": "SA",
  "ar-ae": "AE",
};

const EXPLICIT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:united kingdom|great britain|england|scotland|wales)\b/i, "GB"],
  [/\b(?:united states|usa|u\.s\.a\.)\b/i, "US"],
  [/\begypt\b/i, "EG"],
  [/\bindia\b/i, "IN"],
  [/(?:\b(?:state of kuwait|kuwait)\b|الكويت)/iu, "KW"],
  [/\bsaudi arabia\b/i, "SA"],
  [/\b(?:united arab emirates|uae)\b/i, "AE"],
  [/\bgermany\b/i, "DE"],
  [/\bfrance\b/i, "FR"],
];

const FULFILLMENT_LOCATIONS: Array<[string, string]> = [
  ["abu dhabi", "AE"],
  ["dubai", "AE"],
  ["sharjah", "AE"],
  ["berlin", "DE"],
  ["hamburg", "DE"],
  ["munich", "DE"],
  ["cairo", "EG"],
  ["giza", "EG"],
  ["lyon", "FR"],
  ["marseille", "FR"],
  ["paris", "FR"],
  ["london", "GB"],
  ["manchester", "GB"],
  ["bengaluru", "IN"],
  ["chennai", "IN"],
  ["delhi", "IN"],
  ["hyderabad", "IN"],
  ["kolkata", "IN"],
  ["mumbai", "IN"],
  ["kuwait city", "KW"],
  ["dammam", "SA"],
  ["jeddah", "SA"],
  ["riyadh", "SA"],
  ["california", "US"],
  ["chicago", "US"],
  ["dallas", "US"],
  ["florida", "US"],
  ["houston", "US"],
  ["los angeles", "US"],
  ["miami", "US"],
  ["new york", "US"],
  ["texas", "US"],
];

const FULFILLMENT_LOCATION_PATTERN = new RegExp(
  `\\b(?:ships?|shipped|shipping|dispatch(?:ed|es|ing)?|deliver(?:ed|s|ing)?)\\b(?:\\s+(?!from\\b)[\\w'-]+){0,4}\\s+from\\s+(?:our\\s+)?(${FULFILLMENT_LOCATIONS.map(([location]) => location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "gi",
);

function addSignal(signals: RegionSignal[], scores: Record<string, number>, signal: RegionSignal) {
  signals.push(signal);
  scores[signal.countryCode] = (scores[signal.countryCode] || 0) + signal.weight;
}

function signalKey(signal: RegionSignal) {
  return `${signal.countryCode}|${signal.kind}|${signal.value.toLowerCase().replaceAll("_", "-")}`;
}

export function combineRegionSignals(inputSignals: RegionSignal[]): RegionInference {
  const uniqueSignals = [...new Map(inputSignals.map((signal) => [signalKey(signal), signal])).values()];
  const scores: Record<string, number> = {};
  for (const signal of uniqueSignals) scores[signal.countryCode] = (scores[signal.countryCode] || 0) + signal.weight;

  const rankedCountries = Object.entries(scores).filter(([countryCode]) => countryCode !== "GLOBAL").sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [winnerCode = "", winnerScore = 0] = rankedCountries[0] || [];
  const runnerUp = rankedCountries[1]?.[1] || 0;
  if (winnerScore >= 4 && winnerScore - runnerUp >= 3) {
    return {
      countryCode: winnerCode,
      country: COUNTRY_NAMES[winnerCode] || winnerCode,
      confidence: winnerScore >= 7 ? "High" : "Medium",
      signals: uniqueSignals,
      scores,
    };
  }

  const globalScore = scores.GLOBAL || 0;
  if (globalScore >= 4) return { countryCode: "GLOBAL", country: COUNTRY_NAMES.GLOBAL, confidence: globalScore >= 7 ? "High" : "Medium", signals: uniqueSignals, scores };
  return { countryCode: "", country: "Unknown", confidence: "Low", signals: uniqueSignals, scores };
}

function structuredCountry(document: string) {
  const match = document.match(/["']addressCountry["']\s*:\s*(?:\{[^{}]*["'](?:name|value)["']\s*:\s*)?["']([^"']{2,40})["']/i);
  const value = match?.[1]?.trim() || "";
  if (/^(?:GB|UK|United Kingdom)$/i.test(value)) return ["GB", value] as const;
  if (/^(?:US|USA|United States)$/i.test(value)) return ["US", value] as const;
  if (/^(?:EG|Egypt)$/i.test(value)) return ["EG", value] as const;
  if (/^(?:IN|India)$/i.test(value)) return ["IN", value] as const;
  if (/^(?:KW|Kuwait|State of Kuwait|الكويت)$/iu.test(value)) return ["KW", value] as const;
  if (/^(?:SA|Saudi Arabia)$/i.test(value)) return ["SA", value] as const;
  if (/^(?:AE|UAE|United Arab Emirates)$/i.test(value)) return ["AE", value] as const;
  if (/^(?:DE|Germany)$/i.test(value)) return ["DE", value] as const;
  if (/^(?:FR|France)$/i.test(value)) return ["FR", value] as const;
  return null;
}

export function inferRegion(input: RegionInput): RegionInference {
  const signals: RegionSignal[] = [];
  const scores: Record<string, number> = {};
  const domain = input.domain.toLowerCase().replace(/^www\./, "");
  const document = input.document || "";
  const text = input.text || "";

  for (const [pattern, countryCode] of TLD_COUNTRIES) {
    if (pattern.test(domain)) addSignal(signals, scores, { countryCode, kind: "tld", value: domain, weight: 5, sourceUrl: input.sourceUrl, claimType: "Observed" });
  }

  const language = input.language.toLowerCase().replace("_", "-");
  const languageCountry = LANGUAGE_COUNTRIES[language];
  if (languageCountry) addSignal(signals, scores, { countryCode: languageCountry, kind: "language", value: input.language, weight: 4, sourceUrl: input.sourceUrl, claimType: "Observed" });
  for (const [locale, countryCode] of Object.entries(LANGUAGE_COUNTRIES)) {
    const localePattern = new RegExp(`\\b${locale.replace("-", "[-_]")}\\b`, "i");
    const observedLocale = document.match(localePattern)?.[0];
    if (observedLocale) addSignal(signals, scores, { countryCode, kind: "language", value: observedLocale, weight: 4, sourceUrl: input.sourceUrl, claimType: "Observed" });
  }

  const address = structuredCountry(document);
  if (address) addSignal(signals, scores, { countryCode: address[0], kind: "structured-address", value: address[1], weight: 6, sourceUrl: input.sourceUrl, claimType: "Observed" });

  const prices = (input.priceSignals || []).join(" ");
  if (/£|\bGBP\b/i.test(prices)) addSignal(signals, scores, { countryCode: "GB", kind: "currency", value: "GBP", weight: 3, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\bUSD\b|\bUS\$/i.test(prices)) addSignal(signals, scores, { countryCode: "US", kind: "currency", value: "USD", weight: 3, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\u20B9|\bINR\b/i.test(prices)) addSignal(signals, scores, { countryCode: "IN", kind: "currency", value: "INR", weight: 3, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\bKWD\b|د\.?\s*ك/iu.test(prices)) addSignal(signals, scores, { countryCode: "KW", kind: "currency", value: "KWD", weight: 3, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/€|\bEUR\b/i.test(prices)) {
    const localeCountry = languageCountry === "DE" || languageCountry === "FR" ? languageCountry : "";
    if (localeCountry) addSignal(signals, scores, { countryCode: localeCountry, kind: "currency", value: "EUR", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  }

  if (/\+44[\s(.-]/.test(text)) addSignal(signals, scores, { countryCode: "GB", kind: "phone", value: "+44", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\+1[\s(.-]\d{3}/.test(text)) addSignal(signals, scores, { countryCode: "US", kind: "phone", value: "+1", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\+20[\s(.-]/.test(text)) addSignal(signals, scores, { countryCode: "EG", kind: "phone", value: "+20", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\+91[\s(.-]/.test(text)) addSignal(signals, scores, { countryCode: "IN", kind: "phone", value: "+91", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\+965(?=[\s(.-]?\d)/.test(text)) addSignal(signals, scores, { countryCode: "KW", kind: "phone", value: "+965", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\+966[\s(.-]/.test(text)) addSignal(signals, scores, { countryCode: "SA", kind: "phone", value: "+966", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });
  if (/\+971[\s(.-]/.test(text)) addSignal(signals, scores, { countryCode: "AE", kind: "phone", value: "+971", weight: 2, sourceUrl: input.sourceUrl, claimType: "Observed" });

  for (const [pattern, countryCode] of EXPLICIT_PATTERNS) {
    if (pattern.test(text)) addSignal(signals, scores, { countryCode, kind: "explicit-market", value: text.match(pattern)?.[0] || COUNTRY_NAMES[countryCode], weight: 1, sourceUrl: input.sourceUrl, claimType: "Inferred" });
  }

  for (const match of text.matchAll(FULFILLMENT_LOCATION_PATTERN)) {
    const location = match[1]?.toLowerCase() || "";
    const countryCode = FULFILLMENT_LOCATIONS.find(([candidate]) => candidate === location)?.[1];
    if (countryCode) addSignal(signals, scores, { countryCode, kind: "fulfillment-location", value: match[0], weight: 4, sourceUrl: input.sourceUrl, claimType: "Inferred" });
  }

  const globalMarket = text.match(/\b(?:global(?:ly)?|worldwide|around the world|across (?:more than )?\d+ countries)\b/i)?.[0];
  if (globalMarket) addSignal(signals, scores, { countryCode: "GLOBAL", kind: "global-market", value: globalMarket, weight: 4, sourceUrl: input.sourceUrl, claimType: "Inferred" });

  return combineRegionSignals(signals);
}

export function regionCode(value: string | RegionInference) {
  if (typeof value !== "string") return value.countryCode;
  if (/united kingdom|\bgb\b|\buk\b/i.test(value)) return "GB";
  if (/united states|\busa\b|\bus\b/i.test(value)) return "US";
  if (/egypt|\beg\b/i.test(value)) return "EG";
  if (/india/i.test(value) || /^in(?:\s*\(inferred\))?$/i.test(value.trim())) return "IN";
  if (/kuwait|الكويت|\bkw\b/iu.test(value)) return "KW";
  if (/saudi|\bsa\b/i.test(value)) return "SA";
  if (/emirates|\buae\b|\bae\b/i.test(value)) return "AE";
  if (/germany|\bde\b/i.test(value)) return "DE";
  if (/france|\bfr\b/i.test(value)) return "FR";
  if (/global|worldwide/i.test(value)) return "GLOBAL";
  return "";
}

const STRICT_REGION_CODES: Record<string, string> = {
  ae: "AE",
  de: "DE",
  eg: "EG",
  fr: "FR",
  gb: "GB",
  global: "GLOBAL",
  "global market": "GLOBAL",
  in: "IN",
  india: "IN",
  kw: "KW",
  kuwait: "KW",
  "state of kuwait": "KW",
  "الكويت": "KW",
  sa: "SA",
  "saudi arabia": "SA",
  uae: "AE",
  uk: "GB",
  "united arab emirates": "AE",
  "united kingdom": "GB",
  "united states": "US",
  us: "US",
  usa: "US",
  worldwide: "GLOBAL",
  germany: "DE",
  egypt: "EG",
  france: "FR",
};

export function strictRegionCode(value: string) {
  const normalized = value.trim().replace(/\s*\(inferred\)\s*$/i, "").trim().toLowerCase();
  return STRICT_REGION_CODES[normalized] || "";
}

export function displayRegion(inference: RegionInference) {
  return inference.countryCode ? `${inference.country} (inferred)` : "Not enough public signal";
}
