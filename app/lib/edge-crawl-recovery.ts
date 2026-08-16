import { canonicalDomain, normalizeDomain } from "./domain.ts";

export const EDGE_CRAWL_MARKER = "x-market-signal-edge-fallback";
const EDGE_TIMEOUT_MS = 90_000;
const EDGE_MAX_RESPONSE_BYTES = 8_000_000;
const ALLOWED_EDGE_CRAWL_URL = "https://market-signal.abdulla617931.chatgpt.site/api/crawl";
const TRUSTED_EVIDENCE_HOST_SUFFIXES = ["facebook.com", "instagram.com", "tiktok.com", "google.com", "youtube.com", "linkedin.com", "x.com", "twitter.com"];

type EdgePayload = { primary: string; domains: string[] };
type EdgeResult = Record<string, unknown> & {
  ok: boolean;
  live: boolean;
  primaryDomain: string;
  results: Array<Record<string, unknown> & { domain?: string; homepage?: unknown; products?: unknown[]; gaps?: unknown[] }>;
  document?: Record<string, unknown> & { blocks?: unknown[] };
};

export type EdgeRecoveryFailureCode =
  | "edge-request-failed"
  | "edge-http-rejected"
  | "edge-content-type-invalid"
  | "edge-response-too-large"
  | "edge-response-invalid";

export type EdgeRecoveryAttempt =
  | { status: "not-configured" }
  | { status: "failed"; code: EdgeRecoveryFailureCode; message: string }
  | { status: "recovered"; result: EdgeResult };

export function validatedEdgeCrawlUrl(value: string | undefined, requestUrl: string) {
  if (!value?.trim()) return null;
  try {
    const candidate = new URL(value);
    const requestOrigin = new URL(requestUrl).origin;
    if (candidate.toString() !== ALLOWED_EDGE_CRAWL_URL || candidate.origin === requestOrigin) return null;
    if (candidate.protocol !== "https:" || candidate.port || candidate.pathname !== "/api/crawl") return null;
    if (candidate.username || candidate.password || candidate.search || candidate.hash) return null;
    return candidate;
  } catch {
    return null;
  }
}

function validHttpsUrl(value: string, allowedDomains: Set<string>, imageOnly: boolean) {
  try {
    const url = normalizeDomain(value);
    if (url.protocol !== "https:") return false;
    if (imageOnly) return true;
    const host = canonicalDomain(url.hostname);
    return allowedDomains.has(host) || TRUSTED_EVIDENCE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function validateNestedEvidence(value: unknown, allowedDomains: Set<string>, depth = 0, parentKey = ""): boolean {
  if (depth > 20) return false;
  if (typeof value === "string") {
    if (value.length > 50_000) return false;
    if (!value && /url$/i.test(parentKey)) return true;
    if (/imageurl$/i.test(parentKey)) return validHttpsUrl(value, allowedDomains, true);
    if (/^(?:url|sourceurl|evidenceurl|attemptedurl|openurl|targeturl)$/i.test(parentKey)) return validHttpsUrl(value, allowedDomains, false);
    return true;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 5_000 && value.every((item) => validateNestedEvidence(item, allowedDomains, depth + 1, parentKey));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).length <= 250
    && Object.entries(value as Record<string, unknown>).every(([key, item]) => validateNestedEvidence(item, allowedDomains, depth + 1, key));
}

function declaredDiscoveryEvidenceDomains(parsed: EdgeResult) {
  const discovery = parsed.discovery && typeof parsed.discovery === "object" && !Array.isArray(parsed.discovery)
    ? parsed.discovery as Record<string, unknown>
    : null;
  const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates.slice(0, 100) : [];
  const domains = new Set<string>();
  const accept = (value: unknown) => {
    if (typeof value !== "string" || !value || value.length > 2_000) return false;
    try {
      const url = normalizeDomain(value);
      if (url.protocol !== "https:" || url.username || url.password) return false;
      domains.add(canonicalDomain(url.hostname));
      return true;
    } catch { return false; }
  };
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    if (row.sourceUrl !== undefined && !accept(row.sourceUrl)) return null;
    const evidence = Array.isArray(row.evidence) ? row.evidence.slice(0, 20) : [];
    for (const item of evidence) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const url = (item as Record<string, unknown>).url;
      if (url !== undefined && !accept(url)) return null;
    }
  }
  return domains;
}

function validateEdgeResult(parsed: EdgeResult, payload: EdgePayload) {
  const primaryDomain = canonicalDomain(payload.primary);
  if (!parsed || parsed.ok !== true || parsed.live !== true || canonicalDomain(parsed.primaryDomain) !== primaryDomain || !Array.isArray(parsed.results) || parsed.results.length > 20) return null;
  const allowedDomains = new Set<string>(payload.domains.map(canonicalDomain));
  for (const item of parsed.results) {
    if (!item || typeof item !== "object") return null;
    try {
      const domain = canonicalDomain(String(item.domain || ""));
      normalizeDomain(`https://${domain}`);
      allowedDomains.add(domain);
    } catch { return null; }
  }
  const discoveryDomains = declaredDiscoveryEvidenceDomains(parsed);
  if (!discoveryDomains) return null;
  for (const domain of discoveryDomains) allowedDomains.add(domain);
  const primary = parsed.results.find((item) => canonicalDomain(String(item.domain || "")) === primaryDomain);
  if (!primary?.homepage || !Array.isArray(primary.products)) return null;
  if (parsed.document && (!Array.isArray(parsed.document.blocks) || parsed.document.blocks.length > 5_000)) return null;
  return validateNestedEvidence(parsed, allowedDomains) ? primaryDomain : null;
}

export function isEdgeRecoveryEligible(primary: { homepage?: unknown; homepageAccessDenied?: { status: number; hosts: string[] } } | undefined) {
  return Boolean(!primary?.homepage && primary?.homepageAccessDenied?.status === 403 && primary.homepageAccessDenied.hosts.length === 2);
}

function withRecoveryProvenance(result: EdgeResult, primaryDomain: string, edgeHost: string) {
  const observedAt = new Date().toISOString();
  const gap = {
    url: `https://${primaryDomain}/`,
    reason: `The primary server was denied storefront access; the bounded public crawl recovered through the configured ${edgeHost} edge.`,
    observedAt,
  };
  const results = result.results.map((item) => canonicalDomain(String(item.domain || "")) === primaryDomain
    ? {
      ...item,
      gaps: [gap, ...(Array.isArray(item.gaps) ? item.gaps : [])],
      coverage: { ...(item.coverage && typeof item.coverage === "object" && !Array.isArray(item.coverage) ? item.coverage : {}), crawlEgress: "edge-recovered" },
    }
    : item);
  const recoveryBlock = { type: "gap", id: `edge-crawl-recovery-${primaryDomain}`, domain: primaryDomain, ...gap };
  const document = result.document
    ? { ...result.document, blocks: [...(Array.isArray(result.document.blocks) ? result.document.blocks : []), recoveryBlock] }
    : result.document;
  return {
    ...result,
    results,
    ...(document ? { document } : {}),
    edgeRecovery: { recovered: true, crawlEgress: "edge-recovered", reason: "primary_homepage_http_403", provider: edgeHost, observedAt },
  };
}

export async function recoverCrawlThroughEdge(
  payload: EdgePayload,
  options: { configuredUrl?: string; requestUrl: string; callbackToken: string; deployTarget?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number },
) {
  const attempt = await recoverCrawlThroughEdgeAttempt(payload, options);
  if (attempt.status === "not-configured") return undefined;
  return attempt.status === "recovered" ? attempt.result : null;
}

export async function recoverCrawlThroughEdgeAttempt(
  payload: EdgePayload,
  options: { configuredUrl?: string; requestUrl: string; callbackToken: string; deployTarget?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number },
): Promise<EdgeRecoveryAttempt> {
  const edgeUrl = validatedEdgeCrawlUrl(options.configuredUrl, options.requestUrl);
  if (!edgeUrl || options.deployTarget !== "node" || options.callbackToken.length < 32 || /\s/.test(options.callbackToken)) return { status: "not-configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? EDGE_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(edgeUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { status: "failed", code: "edge-http-rejected", message: `The blocked-page recovery service returned HTTP ${response.status}.` };
    if (!/^application\/json\b/i.test(response.headers.get("content-type") || "")) return { status: "failed", code: "edge-content-type-invalid", message: "The blocked-page recovery service returned an unsupported response type." };
    const maxBytes = options.maxResponseBytes ?? EDGE_MAX_RESPONSE_BYTES;
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > maxBytes) return { status: "failed", code: "edge-response-too-large", message: "The blocked-page recovery response exceeded its safety limit." };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { status: "failed", code: "edge-response-too-large", message: "The blocked-page recovery response exceeded its safety limit." };
    let parsed: EdgeResult;
    try { parsed = JSON.parse(new TextDecoder().decode(buffer)) as EdgeResult; }
    catch { return { status: "failed", code: "edge-response-invalid", message: "The blocked-page recovery service returned invalid JSON." }; }
    const primaryDomain = validateEdgeResult(parsed, payload);
    if (!primaryDomain) return { status: "failed", code: "edge-response-invalid", message: "The blocked-page recovery result failed source and identity validation." };
    return { status: "recovered", result: withRecoveryProvenance(parsed, primaryDomain, edgeUrl.hostname) };
  } catch {
    return { status: "failed", code: "edge-request-failed", message: "The blocked-page recovery service could not be reached within its bounded request." };
  } finally {
    clearTimeout(timeout);
  }
}
