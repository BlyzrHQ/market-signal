import { scanOfficialAdLibraries, type CompanyAdInput } from "../../lib/ad-intelligence.ts";
import { canonicalDomain, normalizeDomain } from "../../lib/domain.ts";

const MAX_COMPANIES = 7;

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function safeFacebookUrl(value: unknown) {
  const text = cleanText(value, 500);
  if (!text) return "";
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, "");
    return url.protocol === "https:" && host === "facebook.com" ? url.toString() : "";
  } catch {
    return "";
  }
}

function company(value: unknown): CompanyAdInput | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const rawDomain = cleanText(item.domain, 253);
  if (!rawDomain) return null;
  try {
    const domain = canonicalDomain(normalizeDomain(rawDomain).hostname);
    const brand = cleanText(item.brand, 120) || domain;
    const facebookUrl = safeFacebookUrl(item.facebookUrl);
    return { domain, brand, ...(facebookUrl ? { facebookUrl } : {}) };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { companies?: unknown; region?: unknown };
    const companies = Array.isArray(payload.companies)
      ? [...new Map(payload.companies.map(company).filter((item): item is CompanyAdInput => Boolean(item)).map((item) => [item.domain, item])).values()].slice(0, MAX_COMPANIES)
      : [];
    if (!companies.length) return Response.json({ ok: false, error: "Verified companies are required before scanning ad libraries." }, { status: 400 });
    const region = cleanText(payload.region, 120) || "Global market";
    const ads = await scanOfficialAdLibraries(companies, region);
    return Response.json({ ok: true, block: { type: "ad-intelligence", id: "ad-intelligence", primaryDomain: companies[0].domain, ...ads } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Unable to scan public ad libraries." }, { status: 400 });
  }
}
