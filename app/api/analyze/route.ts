const MAX_DOCUMENT_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;

type Confidence = "High" | "Medium" | "Low";

type Evidence = {
  claimType: "Observed" | "Inferred";
  sourceUrl: string;
  observedAt: string;
  confidence: Confidence;
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

function normalizeDomain(input: string) {
  const candidate = input.trim();
  if (!candidate) throw new Error("Enter a domain to analyze.");
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only public HTTP domains can be analyzed.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "169.254.169.254" || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^(fc|fd|fe80):/i.test(hostname)) {
    throw new Error("Private or local addresses cannot be analyzed.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url;
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

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  try {
    const requestUrl = new URL(request.url);
    const target = normalizeDomain(requestUrl.searchParams.get("domain") ?? "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(target, {
        redirect: "follow",
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "MarketSignalPublicScanner/0.1" },
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
    const evidence: Evidence[] = [
      { claimType: "Observed", sourceUrl: response.url || target.toString(), observedAt, confidence: "High" },
      { claimType: "Inferred", sourceUrl: response.url || target.toString(), observedAt, confidence: language === "unknown" ? "Low" : "Medium" },
    ];

    return Response.json({
      ok: true,
      live: true,
      fetchedAt: startedAt,
      sourceUrl: response.url || target.toString(),
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
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "The public site took too long to respond." : error instanceof Error ? error.message : "Unable to analyze this public domain.";
    return Response.json({ ok: false, live: false, error: message, fetchedAt: startedAt }, { status: 400 });
  }
}
