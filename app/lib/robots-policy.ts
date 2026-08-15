import { canonicalDomain, normalizeDomain } from "./domain.ts";
import { fetchPublicText, type PublicFetchOptions } from "./public-fetch.ts";
import { parseRobots, robotsAvailability, type RobotsAvailability, type RobotsPolicy } from "./robots.ts";

const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_ATTEMPTS_PER_HOST = 2;
const DEFAULT_MAX_HOSTS = 2;
const ROBOTS_TIMEOUT_MS = 8_000;
const ROBOTS_DOCUMENT_BYTES = 256_000;
const USER_AGENT = "MarketSignalPublicScanner/0.1";
const TERMINAL_REFUSALS = new Set([401, 403, 407, 429, 451]);

type PublicTextResult = Awaited<ReturnType<typeof fetchPublicText>>;
type RobotsFetcher = (url: string, accept: string, options: PublicFetchOptions) => Promise<PublicTextResult>;

export type ResolvedRobotsPolicy = {
  availability: RobotsAvailability;
  policy: RobotsPolicy;
  sourceUrl: string;
  status: number;
  fetchedAt: string;
  fromCache: boolean;
};

type CacheEntry = { expiresAt: number; value: Omit<ResolvedRobotsPolicy, "fromCache"> };

type ResolverOptions = {
  fetchText?: RobotsFetcher;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  ttlMs?: number;
  maxEntries?: number;
  attemptsPerHost?: number;
  maxHosts?: number;
};

function candidateHost(value: string, expectedDomain: string) {
  try {
    const normalized = normalizeDomain(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return canonicalDomain(normalized.hostname) === canonicalDomain(expectedDomain) ? normalized.hostname : "";
  } catch {
    return "";
  }
}

function transient(result: PublicTextResult) {
  return result.failureKind === "network" || result.failureKind === "timeout" || result.status >= 500;
}

export function createRobotsPolicyResolver(options: ResolverOptions = {}) {
  const fetchText = options.fetchText || fetchPublicText;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL_MS);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const attemptsPerHost = Math.max(1, Math.min(3, options.attemptsPerHost ?? DEFAULT_ATTEMPTS_PER_HOST));
  const maxHosts = Math.max(1, Math.min(3, options.maxHosts ?? DEFAULT_MAX_HOSTS));
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ResolvedRobotsPolicy>>();

  const remember = (key: string, value: Omit<ResolvedRobotsPolicy, "fromCache">) => {
    cache.delete(key);
    cache.set(key, { expiresAt: now() + ttlMs, value });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
  };

  const cached = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return { ...entry.value, fromCache: true } satisfies ResolvedRobotsPolicy;
  };

  const resolveFresh = async (domain: string, preferredHost = "") => {
    const key = canonicalDomain(domain);
    normalizeDomain(key);
    const candidates = [...new Set([
      candidateHost(preferredHost, key),
      candidateHost(key, key),
      candidateHost(`www.${key}`, key),
    ].filter(Boolean))].slice(0, maxHosts);
    let last: PublicTextResult | null = null;

    for (const host of candidates) {
      for (let attempt = 0; attempt < attemptsPerHost; attempt += 1) {
        const sourceUrl = `https://${host}/robots.txt`;
        const result = await fetchText(sourceUrl, "text/plain", {
          expectedDomain: key,
          timeoutMs: ROBOTS_TIMEOUT_MS,
          maxDocumentBytes: ROBOTS_DOCUMENT_BYTES,
          userAgent: USER_AGENT,
        });
        last = result;
        const availability = robotsAvailability(result);
        if (availability === "available" || availability === "missing") {
          const value = {
            availability,
            policy: availability === "available" ? parseRobots(result.text) : parseRobots(""),
            sourceUrl: result.url || sourceUrl,
            status: result.status,
            fetchedAt: new Date(now()).toISOString(),
          } satisfies Omit<ResolvedRobotsPolicy, "fromCache">;
          remember(key, value);
          return { ...value, fromCache: false } satisfies ResolvedRobotsPolicy;
        }
        if (TERMINAL_REFUSALS.has(result.status) || !transient(result)) {
          return { availability: "unreachable", policy: parseRobots(""), sourceUrl, status: result.status, fetchedAt: new Date(now()).toISOString(), fromCache: false } satisfies ResolvedRobotsPolicy;
        }
        if (attempt + 1 < attemptsPerHost) await sleep(100 * (attempt + 1));
      }
    }

    return {
      availability: "unreachable",
      policy: parseRobots(""),
      sourceUrl: last?.url || `https://${candidates[0] || key}/robots.txt`,
      status: last?.status || 0,
      fetchedAt: new Date(now()).toISOString(),
      fromCache: false,
    } satisfies ResolvedRobotsPolicy;
  };

  return {
    async resolve(domain: string, preferredHost = "") {
      const key = canonicalDomain(domain);
      const hit = cached(key);
      if (hit) return hit;
      const active = inFlight.get(key);
      if (active) return active;
      const request = resolveFresh(key, preferredHost).finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      return request;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}

let sharedResolverTestFetchEnabled = false;

export const sharedRobotsPolicyResolver = createRobotsPolicyResolver({
  fetchText: (url, accept, options) => fetchPublicText(url, accept, sharedResolverTestFetchEnabled
    ? { ...options, fetchImpl: globalThis.fetch }
    : options),
});

export function resetSharedRobotsPolicyResolverForTests() {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("The shared robots resolver test hook is available only under node:test.");
  sharedResolverTestFetchEnabled = true;
  sharedRobotsPolicyResolver.clear();
}
