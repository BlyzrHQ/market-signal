import { canonicalDomain, normalizeDomain } from "./domain.ts";
import { isPublicHostname } from "./public-url.ts";

type FetchLike = typeof fetch;
const platformFetch = globalThis.fetch;

export type PublicFetchOptions = {
  expectedDomain?: string;
  timeoutMs: number;
  maxDocumentBytes: number;
  userAgent: string;
  fetchImpl?: FetchLike;
};

class PublicFetchTransportError extends Error {
  readonly failureKind: "network" | "timeout";

  constructor(failureKind: "network" | "timeout") {
    super(failureKind === "timeout" ? "timeout" : "request failed");
    this.name = "PublicFetchTransportError";
    this.failureKind = failureKind;
  }
}

function isCloudflareOriginDnsFailure(response: Response, text: string) {
  if (response.status !== 530) return false;
  const contentType = response.headers.get("content-type") || "";
  if (!/text|html/i.test(contentType)) return false;
  return /\berror\s+code\s*[:#-]?\s*1016\b/i.test(text)
    || (/\berror\s+1016\b/i.test(text) && /\b(?:cloudflare|origin\s+dns\s+error)\b/i.test(text));
}

const resolutionCache = new Map<string, { public: boolean; expiresAt: number }>();

export async function resolvesToPublicAddress(hostname: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal) {
  if (!isPublicHostname(hostname)) return false;
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return true;
  const cached = resolutionCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.public;
  try {
    const answers = await Promise.all([1, 28].map(async (type) => {
      const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { signal, headers: { Accept: "application/dns-json" } });
      if (!response.ok) throw new Error("DNS resolution failed");
      const payload = await response.json() as { Answer?: Array<{ type?: unknown; data?: unknown }> };
      return (payload.Answer || []).filter((answer) => answer.type === type && typeof answer.data === "string").map((answer) => answer.data as string);
    }));
    const addresses = answers.flat();
    const isPublic = addresses.length > 0 && addresses.every(isPublicHostname);
    resolutionCache.set(hostname, { public: isPublic, expiresAt: Date.now() + 300_000 });
    return isPublic;
  } catch {
    return false;
  }
}

export async function fetchPublicText(url: string, accept: string, options: PublicFetchOptions) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImpl = options.fetchImpl || fetch;
  try {
    let currentUrl = url;
    let response: Response | null = null;
    let redirectCount = 0;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const checked = normalizeDomain(currentUrl);
      if (options.expectedDomain && canonicalDomain(checked.hostname) !== canonicalDomain(options.expectedDomain)) throw new Error("redirected off the submitted domain");
      if (!options.fetchImpl && globalThis.fetch === platformFetch && !await resolvesToPublicAddress(checked.hostname, platformFetch, controller.signal)) throw new Error("hostname did not resolve exclusively to public addresses");
      try {
        response = await fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": options.userAgent } });
      } catch (error) {
        throw new PublicFetchTransportError(error instanceof Error && error.name === "AbortError" ? "timeout" : "network");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      redirectCount += 1;
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("redirect limit reached");
      const nextUrl = new URL(location, currentUrl);
      if (options.expectedDomain && canonicalDomain(nextUrl.hostname) !== canonicalDomain(options.expectedDomain)) {
        return { ok: false, status: response.status, contentType: response.headers.get("content-type") ?? "", url: currentUrl, text: "", truncated: false, responseTimeMs: Date.now() - startedAt, responseBytes: 0, redirectCount, error: `redirected off the submitted domain to ${canonicalDomain(nextUrl.hostname)}.`, redirectDomain: canonicalDomain(nextUrl.hostname), failureKind: "" as const };
      }
      currentUrl = nextUrl.toString();
    }
    if (!response) throw new Error("request failed");
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > options.maxDocumentBytes;
    const text = new TextDecoder().decode(buffer.slice(0, options.maxDocumentBytes));
    const cloudflareOriginDnsFailure = isCloudflareOriginDnsFailure(response, text);
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      url: response.url || url,
      text,
      truncated,
      responseTimeMs: Date.now() - startedAt,
      responseBytes: buffer.byteLength,
      redirectCount,
      ...(cloudflareOriginDnsFailure ? { error: "Cloudflare could not resolve the submitted origin hostname.", failureKind: "network" as const } : { failureKind: "" as const }),
    };
  } catch (error) {
    const failureKind = error instanceof PublicFetchTransportError ? error.failureKind : error instanceof Error && error.name === "AbortError" ? "timeout" as const : "" as const;
    return { ok: false, status: 0, contentType: "", url, text: "", truncated: false, responseTimeMs: Date.now() - startedAt, responseBytes: 0, redirectCount: 0, error: failureKind === "timeout" ? "timeout" : "request failed", failureKind };
  } finally {
    clearTimeout(timeout);
  }
}
