import { canonicalDomain, normalizeDomain } from "../../lib/domain";
import { MARKET_SIGNAL_USER_AGENT } from "../../lib/crawler-identity";

const MAX_DOCUMENT_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;

type Confidence = "High" | "Medium" | "Low";

type Evidence = {
  claimType: "Observed" | "Inferred";
  sourceUrl: string;
  observedAt: string;
  confidence: Confidence;
};

export type DomainAnalysis = {
  ok: true;
  live: true;
  domain: string;
  fetchedAt: string;
  sourceUrl: string;
  status: number;
  title: string;
  description: string;
  language: string;
  region: string;
  headings: string[];
  prices: string[];
  socialLinks: string[];
  internalLinks: string[];
  wordCount: number;
  truncated: boolean;
  evidence: Evidence[];
};

export type DomainAnalysisError = {
  ok: false;
  live: false;
  domain: string;
  fetchedAt: string;
  error: string;
};

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").replace(/&nbsp;/gi, " ").trim();
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripMarkup(value: string) {
  return cleanText(decodeEntities(value.replace(/<[^>]*>/g, " ")));
}

function firstMatch(document: string, expression: RegExp) {
  return document.match(expression)?.[1] ?? "";
}

function allMatches(document: string, expression: RegExp) {
  return [...document.matchAll(expression)].map((match) => cleanText(decodeEntities(match[1] ?? ""))).filter(Boolean);
}

function unique(values: string[], limit = 12) {
  return [...new Set(values)].slice(0, limit);
}

function safeDomain(input: string) {
  try {
    return normalizeDomain(input).hostname;
  } catch {
    return input.trim() || "unknown domain";
  }
}

function extractPriceSignals(text: string) {
  const matches = text.match(/(?:[$€£]\s?\d{1,5}(?:[,.]\d{1,2})?|\d{1,5}(?:[,.]\d{1,2})?\s?(?:USD|EUR|GBP))(?:\s*\/\s*(?:mo|month|year|yr|user))?/gi) ?? [];
  return unique(matches.map(cleanText), 8);
}

function extractSocialLinks(document: string, baseUrl: URL) {
  const hrefs = allMatches(document, /href\s*=\s*["']([^"']+)["']/gi);
  const socialDomains = ["facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com", "x.com", "twitter.com"];
  return unique(hrefs.flatMap((href) => {
    try {
      const url = new URL(href, baseUrl);
      return socialDomains.some((domain) => url.hostname.includes(domain)) ? [url.toString()] : [];
    } catch {
      return [];
    }
  }), 12);
}

function inferLanguage(document: string) {
  const lang = firstMatch(document, /<html[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  return lang ? lang.toLowerCase() : "unknown";
}

function inferRegion(text: string, language: string) {
  if (/\b(United States|USA|California|New York|USD)\b/i.test(text)) return "United States (inferred)";
  if (/\b(United Kingdom|UK|London|GBP)\b/i.test(text)) return "United Kingdom (inferred)";
  if (/\b(Europe|EUR|€)\b/i.test(text)) return "Europe (inferred)";
  if (language.startsWith("ar")) return "Arabic-speaking market (inferred)";
  return "Not enough public signal";
}

export async function analyzeDomain(input: string): Promise<DomainAnalysis | DomainAnalysisError> {
  const startedAt = new Date().toISOString();
  const domain = safeDomain(input);
  try {
    const target = normalizeDomain(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(target, {
        redirect: "follow",
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": MARKET_SIGNAL_USER_AGENT },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`The public site returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("The submitted domain did not return a public HTML page.");
    }

    const buffer = await response.arrayBuffer();
    const document = new TextDecoder().decode(buffer.slice(0, MAX_DOCUMENT_BYTES));
    const readable = stripMarkup(document.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " "));
    const title = stripMarkup(firstMatch(document, /<title[^>]*>([\s\S]*?)<\/title>/i)) || target.hostname;
    const description = decodeEntities(firstMatch(document, /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i) || firstMatch(document, /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["']/i));
    const headings = unique(allMatches(document, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi).map(stripMarkup), 12);
    const internalLinks = unique(allMatches(document, /href\s*=\s*["']([^"']+)["']/gi).flatMap((href) => {
      try {
        const url = new URL(href, target);
        return url.hostname === target.hostname ? [url.pathname] : [];
      } catch {
        return [];
      }
    }), 16);
    const prices = extractPriceSignals(readable);
    const socialLinks = extractSocialLinks(document, target);
    const language = inferLanguage(document);
    const observedAt = new Date().toISOString();
    const sourceUrl = response.url || target.toString();
    const evidence: Evidence[] = [
      { claimType: "Observed", sourceUrl, observedAt, confidence: "High" },
      { claimType: "Inferred", sourceUrl, observedAt, confidence: language === "unknown" ? "Low" : "Medium" },
    ];

    return {
      ok: true,
      live: true,
      domain: target.hostname,
      fetchedAt: startedAt,
      sourceUrl,
      status: response.status,
      title,
      description: description || "No meta description was exposed on the public page.",
      language,
      region: inferRegion(`${title} ${description} ${readable}`, language),
      headings,
      prices,
      socialLinks,
      internalLinks,
      wordCount: readable ? readable.split(/\s+/).length : 0,
      truncated: buffer.byteLength > MAX_DOCUMENT_BYTES,
      evidence,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "The public site took too long to respond." : error instanceof Error ? error.message : "Unable to analyze this public domain.";
    return { ok: false, live: false, domain, fetchedAt: startedAt, error: message };
  }
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const rawDomains = [
    ...requestUrl.searchParams.getAll("domain"),
    ...(requestUrl.searchParams.get("domains")?.split(",") ?? []),
  ].map((domain) => domain.trim()).filter(Boolean);
  const domains = [...new Set(rawDomains.map(canonicalDomain))].slice(0, 4);

  if (!domains.length) return Response.json({ ok: false, live: false, error: "Enter a domain to analyze." }, { status: 400 });
  const results = await Promise.all(domains.map(analyzeDomain));
  if (results.length === 1) return Response.json(results[0], { status: results[0].ok ? 200 : 400 });
  return Response.json({ ok: true, live: true, results });
}
