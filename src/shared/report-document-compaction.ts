export const REPORT_PRESENTATION_TARGET_BYTES = 700_000;
export const REPORT_SNAPSHOT_HARD_BYTES = 750_000;
export const REPORT_CALLBACK_ENVELOPE_BYTES = 2_100_000;

type JsonRecord = Record<string, unknown>;

export class ReportDocumentCompactionError extends Error {
  readonly code = "presentation-compaction-failed";

  constructor(message = "The essential report presentation could not fit the public snapshot budget.") {
    super(message);
    this.name = "ReportDocumentCompactionError";
  }
}

export function encodedJsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function finiteTotal(value: unknown, floor: number) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= floor ? Math.floor(candidate) : floor;
}

function boundedText(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  return Array.from(value).slice(0, limit).join("");
}

function safePriceSignals(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((raw) => {
    const item = record(raw);
    if (!item) return [];
    const currency = boundedText(item.currency, 12);
    const label = boundedText(item.raw, 100);
    if (!label) return [];
    const amount = typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : null;
    const period = boundedText(item.period, 40);
    return [{ raw: label, ...(currency ? { currency } : {}), ...(amount !== null ? { amount } : {}), ...(period ? { period } : {}) }];
  });
}

function projectedProduct(value: unknown) {
  const item = record(value);
  if (!item) return value;
  const identifiers = record(item.identifiers);
  const quantity = record(item.quantity);
  return {
    id: boundedText(item.id, 300),
    domain: boundedText(item.domain, 300),
    name: boundedText(item.name, 500),
    category: boundedText(item.category, 300),
    sourceUrl: boundedText(item.sourceUrl, 1_000),
    imageUrl: boundedText(item.imageUrl, 2_000),
    priceSignals: safePriceSignals(item.priceSignals),
    ...(quantity ? { quantity } : {}),
    ...(identifiers ? { identifiers } : {}),
    observedAt: boundedText(item.observedAt, 100),
    extraction: boundedText(item.extraction, 40),
    confidence: boundedText(item.confidence, 20),
    jsonLdType: boundedText(item.jsonLdType, 40),
    ownership: boundedText(item.ownership, 40),
  };
}

function productRank(value: unknown) {
  const item = record(value);
  if (!item) return 0;
  return Number(Boolean(item.sourceUrl)) + Number(Boolean(item.imageUrl)) + Number(Array.isArray(item.priceSignals) && item.priceSignals.length > 0);
}

function stableProductSample(value: unknown, limit: number) {
  if (!Array.isArray(value) || limit <= 0) return [];
  return value.map(projectedProduct).sort((left, right) => {
    const score = productRank(right) - productRank(left);
    if (score) return score;
    const leftRecord = record(left);
    const rightRecord = record(right);
    const leftKey = String(leftRecord?.sourceUrl || leftRecord?.id || "");
    const rightKey = String(rightRecord?.sourceUrl || rightRecord?.id || "");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }).slice(0, limit);
}

function boundedStrings(value: unknown, limit: number, textLimit = 500) {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => boundedText(item, textLimit)).filter(Boolean) : [];
}

function comparisonRowRank(value: unknown) {
  const row = record(value);
  if (!row) return 0;
  const matches = Array.isArray(row.matches) ? row.matches.map(record).filter(Boolean) as JsonRecord[] : [];
  const accepted = matches.some((match) => {
    const product = record(match.product);
    const confidence = boundedText(match.confidence, 20).toLowerCase();
    return Boolean(product?.sourceUrl) && confidence !== "low";
  });
  return Number(accepted) * 100 + matches.filter((match) => Boolean(record(match.product)?.sourceUrl)).length * 10 + Number(Boolean(record(row.primary)?.sourceUrl));
}

function stableComparisonRows(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value.map((row, index) => ({ row, index })).sort((left, right) => comparisonRowRank(right.row) - comparisonRowRank(left.row) || left.index - right.index).slice(0, limit).map(({ row }) => row);
}

function projectedMatch(value: unknown) {
  const item = record(value);
  if (!item) return value;
  const product = projectedProduct(item.product);
  const excludedProduct = record(item.excludedProduct) ? projectedProduct(item.excludedProduct) : null;
  const publication = record(item.publication);
  const assessment = record(item.assessment);
  const decision = record(item.decision);
  const priceComparison = record(decision?.priceComparison);
  const actionPlan = record(decision?.actionPlan);
  return {
    domain: boundedText(item.domain, 300),
    score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
    confidence: boundedText(item.confidence, 40),
    sharedTerms: boundedStrings(item.sharedTerms, 20, 120),
    claimIds: boundedStrings(item.claimIds, 20, 160),
    product,
    ...(excludedProduct ? { excludedProduct } : {}),
    ...(publication ? {
      publication: {
        priceEligible: publication.priceEligible === true,
        ...(boundedText(publication.reason, 80) ? { reason: boundedText(publication.reason, 80) } : {}),
      },
    } : {}),
    ...(assessment ? {
      assessment: {
        method: boundedText(assessment.method, 80),
        claimType: boundedText(assessment.claimType, 40),
        verdict: boundedText(assessment.verdict, 40),
        confidence: typeof assessment.confidence === "number" && Number.isFinite(assessment.confidence) ? assessment.confidence : null,
        model: boundedText(assessment.model, 160),
        promptVersion: boundedText(assessment.promptVersion, 160),
        reasons: Array.isArray(assessment.reasons) ? assessment.reasons.slice(0, 6).map((entry) => boundedText(entry, 500)) : [],
        contradictions: Array.isArray(assessment.contradictions) ? assessment.contradictions.slice(0, 6).map((entry) => boundedText(entry, 500)) : [],
        normalizedCategory: boundedText(assessment.normalizedCategory, 240),
        normalizedVariant: boundedText(assessment.normalizedVariant, 240),
        normalizedSize: boundedText(assessment.normalizedSize, 120),
        primarySourceUrl: boundedText(assessment.primarySourceUrl, 1_000),
        rivalSourceUrl: boundedText(assessment.rivalSourceUrl, 1_000),
      },
    } : {}),
    ...(decision ? { decision: {
      priceVerdict: boundedText(decision.priceVerdict, 1_000),
      whyTheyMayWin: boundedText(decision.whyTheyMayWin, 1_000),
      recommendedMove: boundedText(decision.recommendedMove, 1_000),
      ...(priceComparison ? { priceComparison: { primaryRaw: boundedText(priceComparison.primaryRaw, 500), rivalRaw: boundedText(priceComparison.rivalRaw, 500) } } : {}),
      ...(actionPlan ? { actionPlan: {
        source: boundedText(actionPlan.source, 40), claimType: boundedText(actionPlan.claimType, 40), actionEn: boundedText(actionPlan.actionEn, 1_000), actionAr: boundedText(actionPlan.actionAr, 1_000),
        rationaleEn: boundedText(actionPlan.rationaleEn, 1_000), rationaleAr: boundedText(actionPlan.rationaleAr, 1_000), leverType: boundedText(actionPlan.leverType, 80),
        evidenceKeys: boundedStrings(actionPlan.evidenceKeys, 20, 160), model: boundedText(actionPlan.model, 160), promptVersion: boundedText(actionPlan.promptVersion, 160),
      } } : {}),
    } } : {}),
  };
}

type Reduction = { catalog: number; unmatched: number; evidence: number; gaps: number; pages: number; rows: number };
export type ReportCompactionAuthority = { factsAuthoritative?: boolean; factCounts?: { companies: number; products: number; matches: number; ads: number } | null };

const REDUCTIONS: Reduction[] = [
  { catalog: 12, unmatched: 6, evidence: 12, gaps: 30, pages: 12, rows: 100 },
  { catalog: 6, unmatched: 3, evidence: 6, gaps: 15, pages: 6, rows: 50 },
  { catalog: 3, unmatched: 1, evidence: 0, gaps: 8, pages: 3, rows: 25 },
  { catalog: 1, unmatched: 0, evidence: 0, gaps: 4, pages: 1, rows: 12 },
];

function compactAt(value: unknown, reduction: Reduction, authority: ReportCompactionAuthority): unknown {
  const root = record(value);
  if (!root) return value;
  const nested = record(root.document) || root;
  if (!Array.isArray(nested.blocks)) return value;
  const priorSummary = nested.blocks.map(record).find((block) => block?.type === "presentation-compaction");
  const sourceBlocks = nested.blocks.filter((block) => record(block)?.type !== "presentation-compaction");
  const sourceEvidence = sourceBlocks.filter((block) => record(block)?.type === "evidence");
  const sourceGaps = sourceBlocks.filter((block) => record(block)?.type === "gap");
  const totalEvidenceBlockCount = finiteTotal(priorSummary?.totalEvidenceBlockCount, sourceEvidence.length);
  const totalGapCount = finiteTotal(priorSummary?.totalGapCount, sourceGaps.length);
  let persistedEvidence = 0;
  let persistedGaps = 0;

  const blocks = sourceBlocks.flatMap((raw) => {
    const block = record(raw);
    if (!block) return [raw];
    if (block.type === "evidence") {
      if (persistedEvidence >= reduction.evidence) return [];
      persistedEvidence += 1;
      return [{ ...block, text: boundedText(block.text, 500) }];
    }
    if (block.type === "gap") {
      if (persistedGaps >= reduction.gaps) return [];
      persistedGaps += 1;
      return [{ ...block, reason: boundedText(block.reason, 1_000) }];
    }
    if (block.type === "summary") return [{ ...block, title: boundedText(block.title, 500), body: boundedText(block.body, 4_000) }];
    if (block.type === "market-profile") {
      const queries = boundedStrings(block.queries, 12, 500);
      const gaps = boundedStrings(block.gaps, reduction.gaps, 1_000);
      return [{ ...block, queries, gaps, totalQueryCount: finiteTotal(block.totalQueryCount, Array.isArray(block.queries) ? block.queries.length : queries.length), persistedQueryCount: queries.length, queriesTruncated: Boolean(block.queriesTruncated) || (Array.isArray(block.queries) && block.queries.length > queries.length), totalNestedGapCount: finiteTotal(block.totalNestedGapCount, Array.isArray(block.gaps) ? block.gaps.length : gaps.length), persistedNestedGapCount: gaps.length, nestedGapsTruncated: Boolean(block.nestedGapsTruncated) || (Array.isArray(block.gaps) && block.gaps.length > gaps.length), gap: boundedText(block.gap, 1_000) }];
    }
    if (block.type === "coverage") {
      const gaps = boundedStrings(block.gaps, reduction.gaps, 1_000);
      const totalNestedGapCount = finiteTotal(block.totalNestedGapCount, Array.isArray(block.gaps) ? block.gaps.length : gaps.length);
      return [{ ...block, gaps, totalNestedGapCount, persistedNestedGapCount: gaps.length, nestedGapsTruncated: Boolean(block.nestedGapsTruncated) || totalNestedGapCount > gaps.length }];
    }
    if (block.type === "competitor") return [{ ...block, description: boundedText(block.description, 2_000), reason: boundedText(block.reason, 2_000), sharedOfferings: boundedStrings(block.sharedOfferings, 20), overlapTerms: boundedStrings(block.overlapTerms, 20), prices: boundedStrings(block.prices, 8, 100) }];
    if (block.type === "candidate") return [{ ...block, reason: boundedText(block.reason, 1_000), claimIds: boundedStrings(block.claimIds, 20, 160) }];
    if (block.type === "experience-benchmark") {
      const domains = Array.isArray(block.domains) ? block.domains.slice(0, 12).map((rawDomain) => {
        const domain = record(rawDomain); if (!domain) return rawDomain;
        return Object.fromEntries(Object.entries(domain).map(([key, rawMetric]) => {
          const metric = record(rawMetric);
          return [key, metric ? { ...metric, formula: boundedText(metric.formula, 1_000), sourceUrls: boundedStrings(metric.sourceUrls, 12, 1_000) } : rawMetric];
        }));
      }) : [];
      return [{ ...block, limitations: boundedText(block.limitations, 2_000), domains, totalDomainCount: finiteTotal(block.totalDomainCount, Array.isArray(block.domains) ? block.domains.length : domains.length), persistedDomainCount: domains.length, domainsTruncated: Boolean(block.domainsTruncated) || (Array.isArray(block.domains) && block.domains.length > domains.length) }];
    }
    if (block.type === "company" && Array.isArray(block.pages)) {
      const totalPageCount = finiteTotal(block.totalPageCount, block.pages.length);
      const pages = block.pages.slice(0, reduction.pages).map((rawPage) => {
        const page = record(rawPage); if (!page) return rawPage;
        return { url: boundedText(page.url, 1_000), path: boundedText(page.path, 1_000), title: boundedText(page.title, 500), claimIds: boundedStrings(page.claimIds, 20, 160) };
      });
      return [{ ...block, description: boundedText(block.description, 2_000), pages, totalPageCount, persistedPageCount: pages.length, pagesTruncated: Boolean(block.pagesTruncated) || totalPageCount > pages.length }];
    }
    if ((block.type === "product-catalog" || block.type === "product-unmatched") && Array.isArray(block.products)) {
      const limit = block.type === "product-catalog" ? reduction.catalog : reduction.unmatched;
      const totalProductCount = finiteTotal(block.totalProductCount, block.products.length);
      const products = stableProductSample(block.products, limit);
      return [{ ...block, products, totalProductCount, persistedProductCount: products.length, productsTruncated: Boolean(block.productsTruncated) || totalProductCount > products.length }];
    }
    if (block.type === "product-comparison") {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const totalRowCount = finiteTotal(block.totalRowCount, rows.length);
      const projectedRows = stableComparisonRows(rows, reduction.rows).map((rawRow) => {
        const row = record(rawRow);
        return row ? { primary: projectedProduct(row.primary), matches: Array.isArray(row.matches) ? row.matches.map(projectedMatch) : [] } : rawRow;
      });
      const unmatched = Array.isArray(block.unmatched) ? block.unmatched.map((rawGroup) => {
        const group = record(rawGroup);
        if (!group || !Array.isArray(group.products)) return rawGroup;
        const totalProductCount = finiteTotal(group.totalProductCount, group.products.length);
        const products = stableProductSample(group.products, reduction.unmatched);
        return { ...group, products, totalProductCount, persistedProductCount: products.length, productsTruncated: Boolean(group.productsTruncated) || totalProductCount > products.length };
      }) : block.unmatched;
      const matching = record(block.matching);
      const enrichment = record(block.enrichment);
      const matchingGaps = boundedStrings(matching?.gaps, reduction.gaps, 1_000);
      const enrichmentGaps = Array.isArray(enrichment?.gaps) ? enrichment.gaps.slice(0, reduction.gaps).map((gap) => { const item = record(gap); return item ? { ...item, reason: boundedText(item.reason, 1_000), url: boundedText(item.url, 1_000) } : gap; }) : [];
      return [{ ...block, rows: projectedRows, unmatched, ...(matching ? { matching: { ...matching, gaps: matchingGaps, totalGapCount: finiteTotal(matching.totalGapCount, Array.isArray(matching.gaps) ? matching.gaps.length : matchingGaps.length), persistedGapCount: matchingGaps.length, gapsTruncated: Boolean(matching.gapsTruncated) || (Array.isArray(matching.gaps) && matching.gaps.length > matchingGaps.length) } } : {}), ...(enrichment ? { enrichment: { ...enrichment, gaps: enrichmentGaps, totalGapCount: finiteTotal(enrichment.totalGapCount, Array.isArray(enrichment.gaps) ? enrichment.gaps.length : enrichmentGaps.length), persistedGapCount: enrichmentGaps.length, gapsTruncated: Boolean(enrichment.gapsTruncated) || (Array.isArray(enrichment.gaps) && enrichment.gaps.length > enrichmentGaps.length) } } : {}), totalRowCount, persistedRowCount: projectedRows.length, rowsTruncated: Boolean(block.rowsTruncated) || totalRowCount > projectedRows.length }];
    }
    if (block.type === "ad-intelligence") {
      const companies = Array.isArray(block.companies) ? block.companies.slice(0, 7).map((rawCompany) => {
        const company = record(rawCompany); if (!company) return rawCompany;
        const platforms = Array.isArray(company.platforms) ? company.platforms.slice(0, 3).map((rawPlatform) => {
          const platform = record(rawPlatform); if (!platform) return rawPlatform;
          const creativeConcepts = Array.isArray(platform.creativeConcepts) ? platform.creativeConcepts.slice(0, 6).map((rawConcept) => {
            const concept = record(rawConcept); if (!concept) return rawConcept;
            return { ...concept, message: boundedText(concept.message, 2_000), caption: boundedText(concept.caption, 500), headline: boundedText(concept.headline, 500), description: boundedText(concept.description, 1_000), platforms: boundedStrings(concept.platforms, 20, 80), languages: boundedStrings(concept.languages, 20, 40), countries: boundedStrings(concept.countries, 20, 20) };
          }) : [];
          const totalCreativeConceptCount = finiteTotal(platform.totalCreativeConceptCount, Array.isArray(platform.creativeConcepts) ? platform.creativeConcepts.length : creativeConcepts.length);
          return { ...platform, message: boundedText(platform.message, 2_000), themes: boundedStrings(platform.themes, 20), evidenceUrls: boundedStrings(platform.evidenceUrls, 20, 1_000), creativeConcepts, totalCreativeConceptCount, persistedCreativeConceptCount: creativeConcepts.length, creativeConceptsTruncated: Boolean(platform.creativeConceptsTruncated) || totalCreativeConceptCount > creativeConcepts.length };
        }) : [];
        const totalPlatformCount = finiteTotal(company.totalPlatformCount, Array.isArray(company.platforms) ? company.platforms.length : platforms.length);
        return { ...company, summary: boundedText(company.summary, 2_000), recommendedAction: boundedText(company.recommendedAction, 2_000), platforms, totalPlatformCount, persistedPlatformCount: platforms.length, platformsTruncated: Boolean(company.platformsTruncated) || totalPlatformCount > platforms.length };
      }) : [];
      return [{ ...block, companies, totalCompanyCount: finiteTotal(block.totalCompanyCount, Array.isArray(block.companies) ? block.companies.length : companies.length), persistedCompanyCount: companies.length, companiesTruncated: Boolean(block.companiesTruncated) || (Array.isArray(block.companies) && block.companies.length > companies.length) }];
    }
    return [block];
  });

  blocks.push({
    type: "presentation-compaction",
    id: "presentation-compaction",
    totalEvidenceBlockCount,
    persistedEvidenceBlockCount: persistedEvidence,
    evidenceBlocksTruncated: totalEvidenceBlockCount > persistedEvidence,
    totalGapCount,
    persistedGapCount: persistedGaps,
    gapsTruncated: totalGapCount > persistedGaps,
    omittedBlockCounts: {
      evidence: Math.max(0, totalEvidenceBlockCount - persistedEvidence),
      gap: Math.max(0, totalGapCount - persistedGaps),
    },
    relationalFactsAuthoritative: authority.factsAuthoritative ?? priorSummary?.relationalFactsAuthoritative === true,
    factCounts: Object.prototype.hasOwnProperty.call(authority, "factCounts") ? authority.factCounts ?? null : record(priorSummary?.factCounts) || null,
  });
  const compactNested = { ...nested, blocks };
  return nested === root ? compactNested : { ...root, document: compactNested };
}

export function compactTerminalReportDocument(value: unknown, targetBytes = REPORT_PRESENTATION_TARGET_BYTES, authority: ReportCompactionAuthority = {}): unknown {
  if (!Number.isInteger(targetBytes) || targetBytes <= 0 || targetBytes > REPORT_SNAPSHOT_HARD_BYTES) throw new ReportDocumentCompactionError("Invalid report presentation byte budget.");
  let compacted: unknown = value;
  for (const reduction of REDUCTIONS) {
    compacted = compactAt(compacted, reduction, authority);
    if (encodedJsonBytes(compacted) <= targetBytes) return compacted;
  }
  throw new ReportDocumentCompactionError();
}
