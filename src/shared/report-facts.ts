import { isSupportedCurrency, type ProductComparison, type ProductRecord } from "../../app/lib/product-intelligence.ts";
import type { ReportFactChunkInput, ReportFactKind, ReportFactManifestInput } from "../../app/lib/report-store.ts";
import { canonicalDomain } from "../../app/lib/domain.ts";
import { publicHttpUrl } from "../../app/lib/public-url.ts";

type JsonRecord = Record<string, unknown>;
type CrawlFactResult = {
  domain: string;
  role?: string;
  homepage?: unknown;
  products: ProductRecord[];
  fetchedAt?: string;
  discovery?: Record<string, unknown>;
};

export type ReportFactBundle = {
  chunks: ReportFactChunkInput[];
  manifest: ReportFactManifestInput;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, limit = 2_000) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function safeUrl(value: unknown, allowEmpty = true) {
  return publicHttpUrl(value, allowEmpty);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}

export async function reportFactHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function observedAt(value: unknown, fallback: string) {
  const candidate = text(value, 40);
  const resolved = candidate && Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : fallback;
  if (!resolved || !Number.isFinite(Date.parse(resolved))) throw new Error("Invalid report fact observation time.");
  return new Date(resolved).toISOString();
}

function bounded(value: unknown, maxBytes = 16_000) {
  const normalized = stable(value && typeof value === "object" ? value : {});
  const json = JSON.stringify(normalized);
  if (new TextEncoder().encode(json).byteLength > maxBytes) throw new Error("Report fact metadata is too large.");
  return JSON.parse(json) as unknown;
}

function strings(value: unknown, limit: number, itemLimit: number) {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => text(item, itemLimit)).filter(Boolean) : [];
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function companyEvidence(value: unknown) {
  const source = record(value);
  return bounded({
    verificationScore: finite(source.verificationScore),
    category: text(source.category, 240),
    region: text(source.region, 120),
    sourceIds: strings(source.sourceIds, 20, 160),
    reason: text(source.reason, 1_000),
    source: text(source.source, 80),
  });
}

function productPrices(value: unknown) {
  return bounded((Array.isArray(value) ? value : []).slice(0, 20).map((item) => {
    const source = record(item);
    return { raw: text(source.raw, 500), currency: text(source.currency, 12), amount: finite(source.amount), period: text(source.period, 80) };
  }), 8_000);
}

function productAliases(value: unknown, productDomain: string) {
  return (Array.isArray(value) ? value : []).slice(0, 8).flatMap((item) => {
    const source = record(item);
    const name = text(source.name, 160);
    const normalizedName = text(source.normalizedName, 160);
    const sourceUrl = safeUrl(source.sourceUrl);
    const extraction = source.extraction === "json-ld" || source.extraction === "sitemap" ? source.extraction : "";
    let sourceDomain = "";
    try { sourceDomain = canonicalDomain(new URL(sourceUrl).hostname); } catch { sourceDomain = ""; }
    if (!name || !normalizedName || !sourceUrl || !extraction || sourceDomain !== productDomain) return [];
    return [{ name, normalizedName, locale: text(source.locale, 20) || "und", sourceUrl, extraction }];
  });
}

function productMetadata(value: unknown, productDomain: string) {
  const source = record(value);
  const identifiers = record(source.identifiers);
  const quantity = record(source.quantity);
  return bounded({
    description: text(source.description, 8_000),
    category: text(source.category, 240),
    jsonLdType: text(source.jsonLdType, 80),
    attributes: strings(source.attributes, 80, 240),
    ownership: text(source.ownership, 80),
    extraction: text(source.extraction, 80),
    confidence: text(source.confidence, 40),
    claimIds: strings(source.claimIds, 100, 160),
    aliases: productAliases(source.aliases, productDomain),
    identifiers: { gtins: strings(identifiers.gtins, 20, 32), sku: text(identifiers.sku, 120), mpn: text(identifiers.mpn, 120), brand: text(identifiers.brand, 240) },
    quantity: { kind: text(quantity.kind, 20), amount: finite(quantity.amount), unit: text(quantity.unit, 20) },
  });
}

function matchEvidence(value: unknown) {
  const source = record(value);
  const decision = record(source.decision);
  const publication = record(source.publication);
  const priceComparison = record(decision.priceComparison);
  const actionPlan = record(decision.actionPlan);
  return bounded({
    score: finite(source.score),
    sharedTerms: strings(source.sharedTerms, 40, 120),
    claimIds: strings(source.claimIds, 100, 160),
    reasons: strings(source.reasons, 20, 1_000),
    contradictions: strings(source.contradictions, 20, 1_000),
    primarySourceUrl: safeUrl(source.primarySourceUrl),
    rivalSourceUrl: safeUrl(source.rivalSourceUrl),
    normalizedCategory: text(source.normalizedCategory, 240),
    normalizedVariant: text(source.normalizedVariant, 240),
    normalizedSize: text(source.normalizedSize, 120),
    publication: { priceEligible: publication.priceEligible === true, reason: text(publication.reason, 80) },
    decision: {
      priceVerdict: text(decision.priceVerdict, 1_000),
      whyTheyMayWin: text(decision.whyTheyMayWin, 1_000),
      recommendedMove: text(decision.recommendedMove, 1_000),
      priceComparison: { primaryRaw: text(priceComparison.primaryRaw, 500), rivalRaw: text(priceComparison.rivalRaw, 500) },
      actionPlan: {
        source: text(actionPlan.source, 40), claimType: text(actionPlan.claimType, 40), actionEn: text(actionPlan.actionEn, 1_000), actionAr: text(actionPlan.actionAr, 1_000),
        rationaleEn: text(actionPlan.rationaleEn, 1_000), rationaleAr: text(actionPlan.rationaleAr, 1_000), leverType: text(actionPlan.leverType, 80),
        evidenceKeys: strings(actionPlan.evidenceKeys, 40, 160), model: text(actionPlan.model, 160), promptVersion: text(actionPlan.promptVersion, 160),
      },
    },
  });
}

function adEvidence(value: unknown) {
  const source = record(value);
  return bounded({
    providerId: text(source.providerId, 240), evidenceUrl: safeUrl(source.evidenceUrl), pageId: text(source.pageId, 240), pageName: text(source.pageName, 240),
    message: text(source.message, 2_000), caption: text(source.caption, 500), headline: text(source.headline, 500), description: text(source.description, 1_000), callToAction: text(source.callToAction, 120),
    startDate: text(source.startDate, 40), stopDate: text(source.stopDate, 40), destinationUrl: safeUrl(source.destinationUrl), mediaUrl: safeUrl(source.mediaUrl), mediaType: text(source.mediaType, 40),
    placementCount: finite(source.placementCount), platforms: strings(source.platforms, 20, 80), languages: strings(source.languages, 20, 40), countries: strings(source.countries, 20, 20),
  });
}

export function canonicalReportFact(kind: ReportFactKind, item: JsonRecord) {
  if (kind === "companies") return {
    domain: canonicalDomain(text(item.domain, 253)), role: text(item.role, 40), companyName: text(item.companyName, 240),
    evidenceUrl: safeUrl(item.evidenceUrl), evidence: companyEvidence(item.evidence), observedAt: observedAt(item.observedAt, ""),
  };
  if (kind === "products") return {
    domain: canonicalDomain(text(item.domain, 253)), productId: text(item.productId, 240), name: text(item.name, 500),
    normalizedName: text(item.normalizedName, 500), sourceUrl: safeUrl(item.sourceUrl, false), imageUrl: safeUrl(item.imageUrl),
    prices: productPrices(item.prices), metadata: productMetadata(item.metadata, canonicalDomain(text(item.domain, 253))), observedAt: observedAt(item.observedAt, ""),
  };
  if (kind === "matches") return {
    id: text(item.id, 500), primaryProductId: text(item.primaryProductId, 240), rivalProductId: text(item.rivalProductId, 240),
    rivalDomain: canonicalDomain(text(item.rivalDomain, 253)), verdict: text(item.verdict, 40), confidence: text(item.confidence, 40),
    claimType: text(item.claimType, 40), model: text(item.model, 160), promptVersion: text(item.promptVersion, 160),
    evidence: matchEvidence(item.evidence), observedAt: observedAt(item.observedAt, ""),
  };
  return {
    id: text(item.id, 500), domain: canonicalDomain(text(item.domain, 253)), platform: text(item.platform, 80), status: text(item.status, 80),
    evidence: adEvidence(item.evidence), observedAt: observedAt(item.observedAt, ""),
  };
}

function uniqueFacts(kind: ReportFactKind, items: JsonRecord[]) {
  const keyed = new Map<string, { item: JsonRecord; quality: number; canonical: string }>();
  for (const raw of items) {
    const item = canonicalReportFact(kind, raw) as JsonRecord;
    const key = kind === "companies" ? String(item.domain)
      : kind === "products" ? `${item.domain}\n${item.productId}`
        : String(item.id);
    const canonical = JSON.stringify(stable(item));
    const quality = new TextEncoder().encode(canonical).byteLength
      + (kind === "companies" && item.role === "primary" ? 1_000_000 : 0)
      + (kind === "products" && item.imageUrl ? 20_000 : 0)
      + (kind === "products" && Array.isArray(item.prices) && item.prices.length ? 20_000 : 0);
    const prior = keyed.get(key);
    if (!prior || quality > prior.quality || (quality === prior.quality && canonical < prior.canonical)) keyed.set(key, { item, quality, canonical });
  }
  return [...keyed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value.item);
}

function companyFacts(results: CrawlFactResult[], comparison: ProductComparison | null, fallbackObservedAt: string) {
  const rows: JsonRecord[] = results.filter((result) => result.homepage || result.products.length).map((result) => {
    const homepage = record(result.homepage);
    const discovery = record(result.discovery);
    return {
      domain: result.domain,
      role: result.role || (results.indexOf(result) === 0 ? "primary" : "discovered-competitor"),
      companyName: text(homepage.title, 240) || result.domain,
      evidenceUrl: text(homepage.sourceUrl || homepage.url || result.products[0]?.sourceUrl),
      evidence: {
        verificationScore: discovery.verificationScore,
        category: discovery.category,
        region: discovery.region,
        sourceIds: discovery.sourceIds,
        reason: discovery.reason,
      },
      observedAt: observedAt(homepage.observedAt || result.fetchedAt, fallbackObservedAt),
    };
  });
  if (comparison) {
    for (const row of comparison.rows) for (const match of row.matches) if (match.product) rows.push({
      domain: match.product.domain,
      role: "discovered-competitor",
      companyName: match.product.domain,
      evidenceUrl: match.product.sourceUrl,
      evidence: { source: "accepted-product-match" },
      observedAt: observedAt(match.product.observedAt, fallbackObservedAt),
    });
  }
  return rows;
}

function productFact(product: ProductRecord, fallbackObservedAt: string) {
  const parsedObservedAt = Date.parse(product.observedAt);
  const age = Date.parse(fallbackObservedAt) - parsedObservedAt;
  const priceObservationIsFresh = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(product.observedAt)
    && Number.isFinite(parsedObservedAt)
    && new Date(parsedObservedAt).toISOString() === product.observedAt
    && age >= -(5 * 60 * 1000)
    && age <= 366 * 24 * 60 * 60 * 1000;
  const pricesAreValid = product.priceSignals.every((price) => typeof price.amount === "number"
    && Number.isFinite(price.amount)
    && price.amount > 0
    && Boolean(String(price.raw || "").trim())
    && isSupportedCurrency(price.currency));
  return {
    domain: product.domain,
    productId: product.id,
    name: product.name,
    normalizedName: product.normalizedName,
    sourceUrl: product.sourceUrl,
    imageUrl: product.imageUrl,
    prices: priceObservationIsFresh && pricesAreValid ? product.priceSignals : [],
    metadata: {
      description: product.description,
      category: product.category,
      jsonLdType: product.jsonLdType,
      attributes: product.attributes,
      ownership: product.ownership,
      extraction: product.extraction,
      confidence: product.confidence,
      claimIds: product.claimIds,
      aliases: product.aliases,
      identifiers: product.identifiers,
      quantity: product.quantity,
    },
    observedAt: observedAt(product.observedAt, fallbackObservedAt),
  };
}

function productFacts(results: CrawlFactResult[], comparison: ProductComparison | null, fallbackObservedAt: string) {
  const key = (product: ProductRecord) => `${canonicalDomain(product.domain)}\n${product.id}`;
  const comparisonProducts = new Map<string, ProductRecord>();
  if (comparison) {
    for (const row of comparison.rows) {
      comparisonProducts.set(key(row.primary), row.primary);
      for (const match of row.matches) {
        const product = match.product || match.excludedProduct;
        if (product) comparisonProducts.set(key(product), product);
      }
    }
  }
  const crawlProducts = results.flatMap((result) => result.products
    .map((product) => ({ ...product, domain: product.domain || result.domain }))
    .filter((product) => !comparisonProducts.has(key(product))));
  return [...crawlProducts, ...comparisonProducts.values()].map((product) => productFact(product, fallbackObservedAt));
}

async function matchFacts(publicId: string, comparison: ProductComparison | null, fallbackObservedAt: string) {
  if (!comparison) return [];
  return await Promise.all(comparison.rows.flatMap((row) => row.matches.filter((match) => (match.product || match.excludedProduct) && match.assessment && ["same_product", "close_substitute"].includes(match.assessment.verdict)).map(async (match) => {
    const product = (match.product || match.excludedProduct)!;
    const assessment = match.assessment!;
    return {
      id: await reportFactHash([publicId, row.primary.id, product.domain, product.id]),
      primaryProductId: row.primary.id,
      rivalProductId: product.id,
      rivalDomain: product.domain,
      verdict: assessment.verdict,
      confidence: String(assessment.confidence),
      claimType: assessment.claimType,
      model: assessment.model,
      promptVersion: assessment.promptVersion,
      evidence: {
        score: match.score,
        sharedTerms: match.sharedTerms,
        claimIds: match.claimIds,
        reasons: assessment.reasons,
        contradictions: assessment.contradictions,
        primarySourceUrl: assessment.primarySourceUrl,
        rivalSourceUrl: assessment.rivalSourceUrl,
        normalizedCategory: assessment.normalizedCategory,
        normalizedVariant: assessment.normalizedVariant,
        normalizedSize: assessment.normalizedSize,
        decision: match.decision,
        publication: match.publication,
      },
      observedAt: observedAt(product.observedAt, fallbackObservedAt),
    };
  })));
}

async function adFacts(publicId: string, adBlock: JsonRecord | null, fallbackObservedAt: string) {
  if (!adBlock) return [];
  const blockObservedAt = observedAt(adBlock.observedAt, fallbackObservedAt);
  const rows: Array<Record<string, unknown>> = [];
  for (const companyValue of Array.isArray(adBlock.companies) ? adBlock.companies : []) {
    const company = record(companyValue);
    const domain = text(company.domain, 253);
    for (const platformValue of Array.isArray(company.platforms) ? company.platforms : []) {
      const platform = record(platformValue);
      if (platform.status !== "verified-active") continue;
      for (const conceptValue of Array.isArray(platform.creativeConcepts) ? platform.creativeConcepts : []) {
        const concept = record(conceptValue);
        const providerId = text(concept.id, 240);
        const evidenceUrl = text(concept.evidenceUrl);
        if (!domain || !providerId || !evidenceUrl) continue;
        rows.push({
          id: await reportFactHash([publicId, domain, platform.platform, providerId]),
          domain,
          platform: text(platform.platform, 80),
          status: "verified-active",
          evidence: {
            providerId,
            evidenceUrl,
            pageId: concept.pageId,
            pageName: concept.pageName,
            message: concept.message,
            caption: concept.caption,
            headline: concept.headline,
            description: concept.description,
            callToAction: concept.callToAction,
            startDate: concept.startDate,
            stopDate: concept.stopDate,
            destinationUrl: concept.destinationUrl,
            mediaUrl: concept.mediaUrl,
            mediaType: concept.mediaType,
            placementCount: concept.placementCount,
            platforms: concept.platforms,
            languages: concept.languages,
            countries: concept.countries,
          },
          observedAt: blockObservedAt,
        });
      }
    }
  }
  return rows;
}

const MAX_FACT_CHUNK_BYTES = 250_000;

function chunkEnvelopeBytes(kind: ReportFactKind, manifestId: string, attemptNumber: number, items: Array<Record<string, unknown>>) {
  return new TextEncoder().encode(JSON.stringify({ manifestId, attemptNumber, kind, chunkIndex: 999, chunkCount: 1_000, contentHash: "f".repeat(64), items })).byteLength;
}

async function chunksFor(kind: ReportFactKind, manifestId: string, attemptNumber: number, items: Array<Record<string, unknown>>) {
  const groups: Array<Array<Record<string, unknown>>> = [];
  for (const item of items) {
    if (chunkEnvelopeBytes(kind, manifestId, attemptNumber, [item]) > MAX_FACT_CHUNK_BYTES) throw new Error("A report fact exceeds the callback byte budget.");
    const current = groups.at(-1);
    if (!current || current.length >= 50 || chunkEnvelopeBytes(kind, manifestId, attemptNumber, [...current, item]) > MAX_FACT_CHUNK_BYTES) groups.push([item]);
    else current.push(item);
  }
  if (!groups.length) groups.push([]);
  return await Promise.all(groups.map(async (group, chunkIndex) => ({
    manifestId,
    attemptNumber,
    kind,
    chunkIndex,
    chunkCount: groups.length,
    contentHash: await reportFactHash(group),
    items: group,
  })));
}

export async function buildReportFactBundle(input: {
  publicId: string;
  crawlResults: CrawlFactResult[];
  comparison: ProductComparison | null;
  adBlock: JsonRecord | null;
  observedAt: string;
  attemptNumber?: number;
}): Promise<ReportFactBundle> {
  const facts: Record<ReportFactKind, Array<Record<string, unknown>>> = {
    companies: uniqueFacts("companies", companyFacts(input.crawlResults, input.comparison, input.observedAt)),
    products: uniqueFacts("products", productFacts(input.crawlResults, input.comparison, input.observedAt)),
    matches: uniqueFacts("matches", await matchFacts(input.publicId, input.comparison, input.observedAt)),
    ads: uniqueFacts("ads", await adFacts(input.publicId, input.adBlock, input.observedAt)),
  };
  const manifestId = await reportFactHash({ publicId: input.publicId, facts });
  const attemptNumber = Number.isInteger(input.attemptNumber) && Number(input.attemptNumber) > 0 ? Number(input.attemptNumber) : 1;
  const chunks = (await Promise.all((Object.keys(facts) as ReportFactKind[]).map((kind) => chunksFor(kind, manifestId, attemptNumber, facts[kind])))).flat();
  const manifestHash = await reportFactHash(chunks.map((chunk) => ({ kind: chunk.kind, chunkIndex: chunk.chunkIndex, contentHash: chunk.contentHash })).sort((left, right) => left.kind.localeCompare(right.kind) || left.chunkIndex - right.chunkIndex));
  return {
    chunks,
    manifest: {
      manifestId,
      attemptNumber,
      manifestHash,
      counts: { companies: facts.companies.length, products: facts.products.length, matches: facts.matches.length, ads: facts.ads.length },
    },
  };
}
