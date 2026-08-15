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

export async function resolvePublicAddresses(hostname: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal) {
  if (!isPublicHostname(hostname)) return [];
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return [hostname];
  try {
    const answers = await Promise.all([1, 28].map(async (type) => {
      const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { signal, headers: { Accept: "application/dns-json" } });
      if (!response.ok) throw new Error("DNS resolution failed");
      const payload = await response.json() as { Answer?: Array<{ type?: unknown; data?: unknown }> };
      return (payload.Answer || []).filter((answer) => answer.type === type && typeof answer.data === "string").map((answer) => answer.data as string);
    }));
    const addresses = answers.flat();
    return addresses.length > 0 && addresses.every(isPublicHostname) ? [...new Set(addresses)].sort() : [];
  } catch {
    return [];
  }
}

export async function resolvesToPublicAddress(hostname: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal) {
  return (await resolvePublicAddresses(hostname, fetchImpl, signal)).length > 0;
}

async function boundedResponseText(response: Response, maxBytes: number) {
  if (!response.body) return { text: "", truncated: false, responseBytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let storedBytes = 0;
  let observedBytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    observedBytes = Math.min(maxBytes + 1, observedBytes + value.byteLength);
    const remaining = Math.max(0, maxBytes - storedBytes);
    if (remaining) {
      const accepted = value.subarray(0, remaining);
      storedBytes += accepted.byteLength;
      text += decoder.decode(accepted, { stream: true });
    }
    if (value.byteLength > remaining || storedBytes >= maxBytes) {
      truncated = value.byteLength > remaining || observedBytes > maxBytes;
      await reader.cancel();
      break;
    }
  }
  text += decoder.decode();
  return { text, truncated, responseBytes: observedBytes };
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
      const beforeAddresses = !options.fetchImpl && globalThis.fetch === platformFetch ? await resolvePublicAddresses(checked.hostname, platformFetch, controller.signal) : null;
      if (beforeAddresses && !beforeAddresses.length) throw new Error("hostname did not resolve exclusively to public addresses");
      try {
        response = await fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": options.userAgent } });
      } catch (error) {
        throw new PublicFetchTransportError(error instanceof Error && error.name === "AbortError" ? "timeout" : "network");
      }
      if (beforeAddresses) {
        const afterAddresses = await resolvePublicAddresses(checked.hostname, platformFetch, controller.signal);
        if (!afterAddresses.length || afterAddresses.join("|") !== beforeAddresses.join("|")) {
          await response.body?.cancel();
          throw new Error("hostname resolution changed during the request");
        }
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
    const { text, truncated, responseBytes } = await boundedResponseText(response, options.maxDocumentBytes);
    const cloudflareOriginDnsFailure = isCloudflareOriginDnsFailure(response, text);
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      url: response.url || url,
      text,
      truncated,
      responseTimeMs: Date.now() - startedAt,
      responseBytes,
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
