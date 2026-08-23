import { canonicalDomain } from "../../app/lib/domain.ts";
import { publicHttpUrl } from "../../app/lib/public-url.ts";

export const DISCOVERY_SEARCH_LEDGER_MAX_BYTES = 1 * 1_024 * 1_024;
export const DISCOVERY_SEARCH_LEDGER_MAX_ENTRIES = 200;
export const DISCOVERY_SEARCH_LEDGER_MAX_ATTEMPTS = 2;
export const DISCOVERY_SEARCH_LEDGER_MAX_CANDIDATES = 6;

const FAILURE_CATEGORIES = [
  "none",
  "http-4xx",
  "http-5xx",
  "timeout",
  "unreadable",
  "incomplete-search",
  "network",
  "not-configured",
  "internal",
] as const;

export type DiscoverySearchLedgerFailureCategory = (typeof FAILURE_CATEGORIES)[number];

export type DiscoverySearchLedgerEntry<Candidate = unknown> = {
  anchorIndex: number;
  attempts: number;
  completed: boolean;
  failureCategory: DiscoverySearchLedgerFailureCategory;
  queries: string[];
  candidates: Candidate[];
  gap?: string;
};

export type DiscoverySearchLedger<Candidate = unknown> = {
  version: 1;
  anchorSetHash: string;
  startIndex: number;
  endIndex: number;
  entries: Array<DiscoverySearchLedgerEntry<Candidate>>;
};

function encodedBytes(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validLedgerCandidate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  try {
    if (typeof candidate.domain !== "string" || canonicalDomain(candidate.domain) !== candidate.domain) return false;
    if (typeof candidate.companyName !== "string" || typeof candidate.reason !== "string" || typeof candidate.searchQuery !== "string") return false;
    if (publicHttpUrl(candidate.sourceUrl, false) !== candidate.sourceUrl || publicHttpUrl(candidate.websiteUrl, false) !== candidate.websiteUrl) return false;
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length > 20 || !Array.isArray(candidate.sharedOfferings) || candidate.sharedOfferings.length > 10) return false;
    if (candidate.matchedProductUrl !== undefined && candidate.matchedProductUrl !== "" && publicHttpUrl(candidate.matchedProductUrl, false) !== candidate.matchedProductUrl) return false;
    if (candidate.matchedProductUrls !== undefined && (!Array.isArray(candidate.matchedProductUrls) || candidate.matchedProductUrls.length > DISCOVERY_SEARCH_LEDGER_MAX_CANDIDATES || candidate.matchedProductUrls.some((url) => publicHttpUrl(url, false) !== url))) return false;
    if (candidate.inferredProductLeads !== undefined && (!Array.isArray(candidate.inferredProductLeads) || candidate.inferredProductLeads.length > DISCOVERY_SEARCH_LEDGER_MAX_CANDIDATES || candidate.inferredProductLeads.some((lead) => {
      if (!lead || typeof lead !== "object" || Array.isArray(lead)) return true;
      const item = lead as Record<string, unknown>;
      return typeof item.candidateDomain !== "string"
        || canonicalDomain(item.candidateDomain) !== item.candidateDomain
        || publicHttpUrl(item.candidateSourceUrl, false) !== item.candidateSourceUrl
        || publicHttpUrl(item.primarySourceUrl, false) !== item.primarySourceUrl;
    }))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates only the ledger's durable structure and contents. A structurally
 * valid ledger may belong to an older discovery window; callers decide whether
 * its entries overlap their current window instead of treating normal cursor
 * advancement as corruption.
 */
export function validateDiscoverySearchLedger(value: unknown): DiscoverySearchLedger | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || encodedBytes(value) > DISCOVERY_SEARCH_LEDGER_MAX_BYTES) return null;
  const ledger = value as Partial<DiscoverySearchLedger>;
  if (ledger.version !== 1
    || !/^[a-f0-9]{64}$/.test(String(ledger.anchorSetHash || ""))
    || !Number.isInteger(ledger.startIndex)
    || !Number.isInteger(ledger.endIndex)
    || Number(ledger.startIndex) < 0
    || Number(ledger.endIndex) < Number(ledger.startIndex)
    || !Array.isArray(ledger.entries)
    || ledger.entries.length > DISCOVERY_SEARCH_LEDGER_MAX_ENTRIES
    || ledger.entries.length !== Number(ledger.endIndex) - Number(ledger.startIndex)) return null;

  const categories = new Set<DiscoverySearchLedgerFailureCategory>(FAILURE_CATEGORIES);
  const indices = new Set<number>();
  for (const entry of ledger.entries) {
    if (!entry || !Number.isInteger(entry.anchorIndex) || entry.anchorIndex < Number(ledger.startIndex) || entry.anchorIndex >= Number(ledger.endIndex) || indices.has(entry.anchorIndex)) return null;
    indices.add(entry.anchorIndex);
    if (!Number.isInteger(entry.attempts) || entry.attempts < 1 || entry.attempts > DISCOVERY_SEARCH_LEDGER_MAX_ATTEMPTS || typeof entry.completed !== "boolean" || !categories.has(entry.failureCategory)) return null;
    if (entry.completed !== (entry.failureCategory === "none") || !Array.isArray(entry.queries) || entry.queries.length > 8 || entry.queries.some((query) => typeof query !== "string" || query.length > 300)) return null;
    if (!Array.isArray(entry.candidates) || entry.candidates.length > DISCOVERY_SEARCH_LEDGER_MAX_CANDIDATES || entry.candidates.some((candidate) => !validLedgerCandidate(candidate))) return null;
    if (entry.gap !== undefined && (typeof entry.gap !== "string" || entry.gap.length > 500)) return null;
  }
  return ledger as DiscoverySearchLedger;
}
