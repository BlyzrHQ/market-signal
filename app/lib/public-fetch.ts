import { canonicalDomain, normalizeDomain } from "./domain.ts";

type FetchLike = typeof fetch;

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
  return /\berror\s+1016\b/i.test(text) && /\b(?:cloudflare|origin\s+dns\s+error)\b/i.test(text);
}

export async function fetchPublicText(url: string, accept: string, options: PublicFetchOptions) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImpl = options.fetchImpl || fetch;
  try {
    let currentUrl = url;
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const checked = normalizeDomain(currentUrl);
      if (options.expectedDomain && canonicalDomain(checked.hostname) !== canonicalDomain(options.expectedDomain)) throw new Error("redirected off the submitted domain");
      try {
        response = await fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal, headers: { Accept: accept, "User-Agent": options.userAgent } });
      } catch (error) {
        throw new PublicFetchTransportError(error instanceof Error && error.name === "AbortError" ? "timeout" : "network");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("redirect limit reached");
      const nextUrl = new URL(location, currentUrl);
      if (options.expectedDomain && canonicalDomain(nextUrl.hostname) !== canonicalDomain(options.expectedDomain)) {
        return { ok: false, status: response.status, contentType: response.headers.get("content-type") ?? "", url: currentUrl, text: "", truncated: false, error: `redirected off the submitted domain to ${canonicalDomain(nextUrl.hostname)}.`, redirectDomain: canonicalDomain(nextUrl.hostname), failureKind: "" as const };
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
      ...(cloudflareOriginDnsFailure ? { error: "Cloudflare could not resolve the submitted origin hostname.", failureKind: "network" as const } : { failureKind: "" as const }),
    };
  } catch (error) {
    const failureKind = error instanceof PublicFetchTransportError ? error.failureKind : error instanceof Error && error.name === "AbortError" ? "timeout" as const : "" as const;
    return { ok: false, status: 0, contentType: "", url, text: "", truncated: false, error: failureKind === "timeout" ? "timeout" : "request failed", failureKind };
  } finally {
    clearTimeout(timeout);
  }
}
