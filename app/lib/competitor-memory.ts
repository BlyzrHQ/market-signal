import { canonicalDomain } from "./domain.ts";
import type { DiscoveryCandidate, DiscoveryProvenance } from "./competitor-discovery.ts";
import type { ApplicationDatabase, DatabasePreparedStatement } from "./database-contract.ts";
import { runtimeDatabase } from "./runtime-database.ts";

export type MemoryCandidate = DiscoveryCandidate & {
  provenance: DiscoveryProvenance;
  rememberedVerifiedAt?: string;
};

export type VerifiedCompetitorMemory = {
  primaryDomain: string;
  competitorDomain: string;
  candidateJson: string;
  firstVerifiedAt: string;
  lastVerifiedAt: string;
  lastVerificationScore: number;
  category: string;
  evidenceUrl: string;
};

export type D1PreparedStatementLike = DatabasePreparedStatement;
export type D1DatabaseLike = ApplicationDatabase;

const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_INVESTIGATIONS = 1_712;
const MAX_REMEMBERED_CANDIDATES = 500;
const schemaReady = new WeakMap<object, Promise<void>>();

function clean(value: unknown, limit = 1_000) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function strings(value: unknown, limit = 12) {
  return Array.isArray(value) ? value.map((item) => clean(item, 300)).filter(Boolean).slice(0, limit) : [];
}

function safeUrl(value: unknown) {
  const text = clean(value, 1_000);
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function candidateFromRecord(record: VerifiedCompetitorMemory): MemoryCandidate | null {
  let value: unknown;
  try { value = JSON.parse(record.candidateJson); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const domain = canonicalDomain(clean(item.domain, 300));
  if (!domain || domain !== canonicalDomain(record.competitorDomain)) return null;
  const sourceUrl = safeUrl(item.sourceUrl) || safeUrl(record.evidenceUrl);
  const websiteUrl = safeUrl(item.websiteUrl) || `https://${domain}/`;
  if (!sourceUrl || !websiteUrl) return null;
  const evidence = Array.isArray(item.evidence) ? item.evidence.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const evidenceItem = entry as Record<string, unknown>;
    const url = safeUrl(evidenceItem.url);
    const method = evidenceItem.method;
    if (!url || !["entity-search", "category-search", "product-search", "search-source"].includes(String(method))) return [];
    return [{ url, title: clean(evidenceItem.title, 300), method: method as "entity-search" | "category-search" | "product-search" | "search-source" }];
  }).slice(0, 200) : [];
  return {
    domain,
    companyName: clean(item.companyName, 200) || domain,
    reason: clean(item.reason, 500) || "Previously verified competitor queued for current live re-verification.",
    searchQuery: clean(item.searchQuery, 300) || "remembered verified competitor",
    sourceUrl,
    websiteUrl,
    marketCategory: clean(item.marketCategory, 200) || clean(record.category, 200),
    relationship: item.relationship === "adjacent" ? "adjacent" : "direct",
    sharedOfferings: strings(item.sharedOfferings),
    evidence,
    mentionCount: Math.max(1, Math.min(200, Number(item.mentionCount) || evidence.length || 1)),
    matchedPrimaryProductName: clean(item.matchedPrimaryProductName, 200) || undefined,
    matchedProductUrl: safeUrl(item.matchedProductUrl) || undefined,
    matchedPrimaryProductNames: strings(item.matchedPrimaryProductNames, 200) || undefined,
    matchedProductUrls: Array.isArray(item.matchedProductUrls) ? item.matchedProductUrls.map(safeUrl).filter(Boolean).slice(0, 200) : undefined,
    evidenceMethod: item.evidenceMethod === "search-source" ? "search-source" : "model-summarized",
    provenance: "remembered-reverified",
    rememberedVerifiedAt: record.lastVerifiedAt,
  };
}

async function getDatabase(): Promise<D1DatabaseLike | null> {
  try {
    return await runtimeDatabase();
  } catch {
    return null;
  }
}

async function ensureSchema(database: D1DatabaseLike) {
  const existing = schemaReady.get(database);
  if (existing) return existing;
  const pending = database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS verified_competitors (
      primary_domain TEXT NOT NULL,
      competitor_domain TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      first_verified_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      last_verification_score INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      evidence_url TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (primary_domain, competitor_domain)
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS verified_competitors_primary_recent_idx ON verified_competitors (primary_domain, last_verified_at)"),
  ]).then(() => undefined).catch((error) => {
    schemaReady.delete(database);
    throw error;
  });
  schemaReady.set(database, pending);
  return pending;
}

export function mergeRememberedCandidates(fresh: DiscoveryCandidate[], remembered: MemoryCandidate[], limit = MAX_INVESTIGATIONS) {
  const selected = new Map<string, MemoryCandidate>();
  const freshCandidates = fresh.map((candidate): MemoryCandidate => ({ ...candidate, provenance: "discovered-this-run" }));
  const rememberedFirst = remembered.slice(0, Math.min(MAX_REMEMBERED_CANDIDATES, Math.max(0, limit - Math.min(MAX_REMEMBERED_CANDIDATES, freshCandidates.length))));
  for (const candidate of rememberedFirst) if (!selected.has(canonicalDomain(candidate.domain))) selected.set(canonicalDomain(candidate.domain), candidate);
  for (const candidate of freshCandidates) {
    const domain = canonicalDomain(candidate.domain);
    const current = selected.get(domain);
    if (!current) {
      if (selected.size < limit) selected.set(domain, candidate);
      continue;
    }
    const evidence = [...current.evidence, ...candidate.evidence]
      .filter((item, index, all) => all.findIndex((other) => other.url === item.url && other.method === item.method) === index);
    const matchedPrimaryProductNames = [...new Set([
      ...(current.matchedPrimaryProductNames || (current.matchedPrimaryProductName ? [current.matchedPrimaryProductName] : [])),
      ...(candidate.matchedPrimaryProductNames || (candidate.matchedPrimaryProductName ? [candidate.matchedPrimaryProductName] : [])),
    ])].slice(0, 200);
    const matchedProductUrls = [...new Set([
      ...(current.matchedProductUrls || (current.matchedProductUrl ? [current.matchedProductUrl] : [])),
      ...(candidate.matchedProductUrls || (candidate.matchedProductUrl ? [candidate.matchedProductUrl] : [])),
    ])].slice(0, 200);
    const inferredProductLeads = [...(current.inferredProductLeads || []), ...(candidate.inferredProductLeads || [])]
      .filter((lead, index, all) => all.findIndex((other) => other.primaryProductId === lead.primaryProductId
        && other.primarySourceUrl === lead.primarySourceUrl
        && other.candidateSourceUrl === lead.candidateSourceUrl
        && other.admission === lead.admission) === index)
      .slice(0, 200);
    selected.set(domain, {
      ...current,
      ...candidate,
      evidence,
      mentionCount: Math.max(current.mentionCount, candidate.mentionCount),
      matchedPrimaryProductName: candidate.matchedPrimaryProductName || current.matchedPrimaryProductName,
      matchedProductUrl: candidate.matchedProductUrl || current.matchedProductUrl,
      matchedPrimaryProductNames,
      matchedProductUrls,
      inferredProductLeads,
      provenance: "discovered-this-run",
      rememberedVerifiedAt: current.rememberedVerifiedAt,
    });
  }
  return [...selected.values()].slice(0, limit);
}

export async function loadRememberedCompetitors(primaryDomain: string, now = new Date(), databaseOverride?: D1DatabaseLike | null) {
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) return { available: false, candidates: [] as MemoryCandidate[], truncated: false, gap: "Competitor memory is not configured; fresh discovery was used." };
  try {
    await ensureSchema(database);
    const cutoff = new Date(now.getTime() - MEMORY_TTL_MS).toISOString();
    const response = await database.prepare(`SELECT
      primary_domain AS primaryDomain,
      competitor_domain AS competitorDomain,
      candidate_json AS candidateJson,
      first_verified_at AS firstVerifiedAt,
      last_verified_at AS lastVerifiedAt,
      last_verification_score AS lastVerificationScore,
      category,
      evidence_url AS evidenceUrl
      FROM verified_competitors
      WHERE primary_domain = ? AND last_verified_at >= ?
      ORDER BY last_verification_score DESC, last_verified_at DESC
      LIMIT 501`).bind(canonicalDomain(primaryDomain), cutoff).all<VerifiedCompetitorMemory>();
    const records = response.results || [];
    const truncated = records.length > MAX_REMEMBERED_CANDIDATES;
    const candidates = records.slice(0, MAX_REMEMBERED_CANDIDATES).flatMap((record) => {
      const candidate = candidateFromRecord(record);
      return candidate ? [candidate] : [];
    });
    return { available: true, candidates, truncated, gap: truncated ? "Verified competitor memory exceeded the bounded 500-domain carry-forward window; a result shortfall cannot claim full market exhaustion." : "" };
  } catch {
    return { available: false, candidates: [] as MemoryCandidate[], truncated: false, gap: "Competitor memory was temporarily unavailable; fresh discovery was used." };
  }
}

export async function rememberVerifiedCompetitors(primaryDomain: string, verified: Array<{ candidate: MemoryCandidate; verificationScore: number }>, observedAt = new Date().toISOString(), databaseOverride?: D1DatabaseLike | null) {
  if (!verified.length) return { available: true, stored: 0 };
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) return { available: false, stored: 0 };
  try {
    await ensureSchema(database);
    const primary = canonicalDomain(primaryDomain);
    const statements = verified.map(({ candidate, verificationScore }) => {
      const storedCandidate: DiscoveryCandidate = {
        domain: canonicalDomain(candidate.domain),
        companyName: clean(candidate.companyName, 200),
        reason: clean(candidate.reason, 500),
        searchQuery: clean(candidate.searchQuery, 300),
        sourceUrl: safeUrl(candidate.sourceUrl),
        websiteUrl: safeUrl(candidate.websiteUrl),
        marketCategory: clean(candidate.marketCategory, 200),
        relationship: candidate.relationship === "adjacent" ? "adjacent" : "direct",
        sharedOfferings: strings(candidate.sharedOfferings),
        evidence: candidate.evidence.flatMap((entry) => {
          const url = safeUrl(entry.url);
          return url ? [{ url, title: clean(entry.title, 300), method: entry.method }] : [];
        }).slice(0, 200),
        mentionCount: Math.max(1, Math.min(200, Number(candidate.mentionCount) || 1)),
        matchedPrimaryProductName: clean(candidate.matchedPrimaryProductName, 200) || undefined,
        matchedProductUrl: safeUrl(candidate.matchedProductUrl) || undefined,
        matchedPrimaryProductNames: strings(candidate.matchedPrimaryProductNames, 200),
        matchedProductUrls: Array.isArray(candidate.matchedProductUrls) ? candidate.matchedProductUrls.map(safeUrl).filter(Boolean).slice(0, 200) : undefined,
        evidenceMethod: candidate.evidenceMethod === "search-source" ? "search-source" : "model-summarized",
      };
      return database.prepare(`INSERT INTO verified_competitors (
        primary_domain, competitor_domain, candidate_json, first_verified_at, last_verified_at,
        last_verification_score, category, evidence_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(primary_domain, competitor_domain) DO UPDATE SET
        candidate_json = excluded.candidate_json,
        last_verified_at = excluded.last_verified_at,
        last_verification_score = excluded.last_verification_score,
        category = excluded.category,
        evidence_url = excluded.evidence_url`).bind(
        primary,
        canonicalDomain(candidate.domain),
        JSON.stringify(storedCandidate),
        observedAt,
        observedAt,
        Math.max(0, Math.min(100, Math.round(verificationScore))),
        clean(candidate.marketCategory, 200),
        safeUrl(candidate.sourceUrl),
      );
    });
    await database.batch(statements);
    return { available: true, stored: statements.length };
  } catch {
    return { available: false, stored: 0 };
  }
}

export async function forgetRememberedCompetitors(primaryDomain: string, competitorDomains: string[], databaseOverride?: D1DatabaseLike | null) {
  if (!competitorDomains.length) return { available: true, removed: 0 };
  const database = databaseOverride === undefined ? await getDatabase() : databaseOverride;
  if (!database) return { available: false, removed: 0 };
  try {
    await ensureSchema(database);
    const primary = canonicalDomain(primaryDomain);
    const statements = competitorDomains.map((domain) => database.prepare("DELETE FROM verified_competitors WHERE primary_domain = ? AND competitor_domain = ?").bind(primary, canonicalDomain(domain)));
    await database.batch(statements);
    return { available: true, removed: statements.length };
  } catch {
    return { available: false, removed: 0 };
  }
}
