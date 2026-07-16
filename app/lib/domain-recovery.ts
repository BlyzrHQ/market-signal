import { canonicalDomain, normalizeDomain } from "./domain.ts";

export type DomainAlternative = {
  domain: string;
  title: string;
  reason: string;
  sourceUrl: string;
};

const PARKING_PROVIDERS: Array<{ hosts: string[]; name: string }> = [
  { hosts: ["forsale.godaddy.com", "afternic.com"], name: "GoDaddy/Afternic" },
  { hosts: ["sedo.com", "sedoparking.com"], name: "Sedo" },
  { hosts: ["dan.com"], name: "Dan" },
  { hosts: ["bodis.com"], name: "Bodis" },
];

const EXCLUDED_ALTERNATIVE_HOSTS = [
  "facebook.com", "instagram.com", "linkedin.com", "pinterest.com", "reddit.com", "tiktok.com", "x.com", "youtube.com",
  "amazon.com", "ebay.com", "etsy.com", "wikipedia.org",
];
const COUNTRY_SECOND_LEVEL_DOMAINS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

function registrableLabel(domain: string) {
  const labels = canonicalDomain(domain).split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const countrySecondLevel = labels.at(-1)?.length === 2 && COUNTRY_SECOND_LEVEL_DOMAINS.has(labels.at(-2) || "");
  return labels.at(countrySecondLevel ? -3 : -2)?.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase() || "";
}

function cleanSourceUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    normalizeDomain(url.toString());
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function searchSources(payload: Record<string, unknown>) {
  const sources: Array<{ title: string; url: string }> = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "web_search_call" && record.action && typeof record.action === "object") {
      const action = record.action as Record<string, unknown>;
      for (const source of Array.isArray(action.sources) ? action.sources : []) {
        if (!source || typeof source !== "object") continue;
        const value = source as Record<string, unknown>;
        sources.push({ title: String(value.title || ""), url: String(value.url || "") });
      }
    }
  }
  return sources;
}

export function parkingProvider(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return PARKING_PROVIDERS.find((provider) => provider.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)))?.name || "";
}

export function extractStaticClientRedirect(document: string, sourceUrl: string) {
  const patterns = [
    /(?:window\.)?location\.href\s*=\s*["']([^"']+)["']/i,
    /(?:window\.)?location\s*=\s*["']([^"']+)["']/i,
    /(?:window\.)?location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"';\s>]+)[^"']*["']/i,
  ];
  const value = patterns.map((pattern) => document.match(pattern)?.[1] || "").find(Boolean);
  if (!value) return "";
  try {
    const source = new URL(sourceUrl);
    const target = new URL(value, source);
    if (!/^https?:$/.test(target.protocol) || canonicalDomain(target.hostname) !== canonicalDomain(source.hostname)) return "";
    target.hash = "";
    return target.toString();
  } catch {
    return "";
  }
}

export async function discoverDomainAlternatives(submittedDomain: string, maxSuggestions = 3): Promise<DomainAlternative[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const limit = Math.max(0, Math.min(3, Math.floor(maxSuggestions)));
  if (!apiKey || !limit) return [];
  const submitted = canonicalDomain(submittedDomain);
  const identity = registrableLabel(submitted);
  if (identity.length < 5) return [];
  const endpoint = `${(process.env.OPENAI_RESPONSES_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.MARKET_SIGNAL_DISCOVERY_MODEL || "gpt-5.4-mini",
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        reasoning: { effort: "low" },
        input: [
          { role: "system", content: "Search for possible active official business domains whose domain wording closely extends the submitted parked domain. Return search evidence only. Do not decide identity, invent domains, or treat social profiles and marketplaces as official sites." },
          { role: "user", content: `Find possible active official websites related by name to the parked domain ${submitted}. Search the exact compact brand wording and close domain extensions.` },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json() as Record<string, unknown>;
    const seen = new Set<string>();
    return searchSources(payload).flatMap((source) => {
      const sourceUrl = cleanSourceUrl(source.url);
      if (!sourceUrl) return [];
      const domain = canonicalDomain(sourceUrl);
      const candidateIdentity = registrableLabel(domain);
      const excluded = !domain || domain === submitted || EXCLUDED_ALTERNATIVE_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`)) || Boolean(parkingProvider(domain));
      if (excluded || seen.has(domain) || !candidateIdentity.includes(identity) || candidateIdentity === identity) return [];
      seen.add(domain);
      return [{
        domain,
        title: source.title.slice(0, 140) || domain,
        reason: "Possible active business with closely related domain wording. Select it only if this is your company.",
        sourceUrl,
      }];
    }).slice(0, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
