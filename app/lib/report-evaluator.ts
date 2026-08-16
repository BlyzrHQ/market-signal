import { publicHttpUrl } from "./public-url.ts";

export const DETERMINISTIC_EVALUATOR_VERSION = "ecommerce-deterministic-v1";
export const DETERMINISTIC_RUBRIC_VERSION = "report-quality-rubric-2026-07-v1";
export const EVIDENCE_FRESHNESS_DAYS = 30;

type JsonRecord = Record<string, unknown>;

export type DeterministicEvaluationInput = {
  primaryDomain: string;
  terminalStatus: "complete" | "limited";
  evaluatedAt: string;
  document: unknown;
  manifest: { companyCount: number; productCount: number; matchCount: number; adCount: number };
  companies: JsonRecord[];
  products: JsonRecord[];
  matches: JsonRecord[];
  ads: JsonRecord[];
  events: JsonRecord[];
};

export type DeterministicFormula = {
  points: number;
  numerator: number;
  denominator: number;
  ratio: number;
  score: number;
  zeroDenominatorRule: string;
  source: string;
};

export type DeterministicEvaluationResult = {
  status: "deterministic" | "rubric_unavailable" | "failed";
  deterministicScore: number | null;
  deterministic: JsonRecord;
  findings: JsonRecord[];
  signals: Array<{ stage: string; issueKey: string; severity: "info" | "warning" | "critical"; evidence: JsonRecord }>;
  errorCode: string;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function json(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round4(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function roundHalfUp(value: number) {
  return Math.floor(value + 0.5);
}

function formula(points: number, numerator: number, denominator: number, source: string, zeroDenominatorRule = "zero denominator earns zero points", zeroScore = 0): DeterministicFormula {
  const safeNumerator = Math.max(0, finite(numerator));
  const safeDenominator = Math.max(0, finite(denominator));
  const ratio = safeDenominator === 0 ? (zeroScore > 0 ? 1 : 0) : Math.min(safeNumerator / safeDenominator, 1);
  return {
    points,
    numerator: safeNumerator,
    denominator: safeDenominator,
    ratio: round4(ratio),
    score: round4(safeDenominator === 0 ? zeroScore : ratio * points),
    zeroDenominatorRule,
    source,
  };
}

function floorFormula(points: number, actual: number, target: number, source: string) {
  return formula(points, actual, target, source, `floor(actual, ${target}); zero actual earns zero points`);
}

function safeUrl(value: unknown) {
  try { return publicHttpUrl(value, false); } catch { return ""; }
}

function urlHost(value: unknown) {
  const url = safeUrl(value);
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function belongsTo(value: unknown, domain: string) {
  const host = urlHost(value);
  return Boolean(host && (host === domain || host.endsWith(`.${domain}`)));
}

function rootDocument(value: unknown) {
  const root = record(value);
  const nested = record(root.document);
  return Object.keys(nested).length ? nested : root;
}

function validPrice(value: unknown) {
  const item = record(value);
  return (typeof item.amount === "number" && Number.isFinite(item.amount)) || Boolean(text(item.raw));
}

function productPrices(product: JsonRecord) {
  return array(json(product.price_json ?? product.priceJson ?? product.prices, [])).filter(validPrice);
}

function productHasSecureImage(product: JsonRecord) {
  const url = safeUrl(product.image_url ?? product.imageUrl);
  return url.startsWith("https://");
}

function companyEvidence(company: JsonRecord) {
  return record(json(company.evidence_json ?? company.evidenceJson ?? company.evidence, {}));
}

function matchEvidence(match: JsonRecord) {
  return record(json(match.evidence_json ?? match.evidenceJson ?? match.evidence, {}));
}

function materialClaims(blocks: unknown[]) {
  return blocks.map(record).filter((block) => block.type === "evidence" && Boolean(text(block.text)));
}

function gapReasons(blocks: unknown[]) {
  const reasons: string[] = [];
  for (const raw of blocks) {
    const block = record(raw);
    if (block.type === "gap" && text(block.reason)) reasons.push(text(block.reason));
    if (block.type === "coverage") for (const gap of array(block.gaps)) if (text(gap)) reasons.push(text(gap));
    if (block.type === "market-profile") {
      if (text(block.gap)) reasons.push(text(block.gap));
      for (const gap of array(block.gaps)) if (text(gap)) reasons.push(text(gap));
    }
    if (block.type === "ad-intelligence" && block.available === false && text(block.limitation)) reasons.push(text(block.limitation));
  }
  return [...new Set(reasons)];
}

function unavailablePhases(events: JsonRecord[]) {
  const failure = /unavailable|failed|could not|not configured|skipped|limited|incomplete|timed out/i;
  return [...new Set(events.filter((event) => ["limited", "failed", "interrupted"].includes(text(event.status).toLowerCase()) || failure.test(text(event.message))).map((event) => text(event.phase)).filter(Boolean))];
}

function explainedPhases(phases: string[], reasons: string[]) {
  const terms: Record<string, RegExp> = {
    crawl: /crawl|website|domain|page|fetch|robots|redirect/i,
    competitors: /competitor|discovery|market|rival|opponent/i,
    brief: /brief|summary|profile|position/i,
    products: /product|catalog|price|image|inventory/i,
    matching: /match|comparison|pair|substitute|same product/i,
    enrichment: /enrichment|price|image|product page|variant/i,
    actions: /action|recommendation|next move|advice/i,
    ads: /\bad\b|advert|campaign|meta|facebook|google|tiktok/i,
    persistence: /persist|storage|database|fact|save/i,
  };
  return phases.filter((phase) => {
    const matcher = terms[phase] || new RegExp(phase.replace(/[^a-z0-9]/gi, ""), "i");
    return reasons.some((reason) => matcher.test(reason));
  });
}

function recommendationFacts(matches: JsonRecord[], evidenceIds: Set<string>) {
  let count = 0;
  let linked = 0;
  for (const match of matches) {
    const evidence = matchEvidence(match);
    const decision = record(evidence.decision);
    const actionPlan = record(decision.actionPlan);
    if (!text(decision.recommendedMove) && !text(actionPlan.actionEn)) continue;
    count += 1;
    const claimIds = array(evidence.claimIds).map(text).filter(Boolean);
    if (claimIds.some((id) => evidenceIds.has(id))) linked += 1;
  }
  return { count, linked };
}

function scores(components: Record<string, DeterministicFormula>) {
  return Object.values(components).reduce((total, component) => total + component.score, 0);
}

function possible(components: Record<string, DeterministicFormula>) {
  return Object.values(components).reduce((total, component) => total + component.points, 0);
}

export function profileDeterministicEvaluation(input: DeterministicEvaluationInput): DeterministicEvaluationResult {
  const document = rootDocument(input.document);
  const blocks = array(document.blocks);
  if (!Array.isArray(document.blocks)) {
    return {
      status: "failed",
      deterministicScore: null,
      deterministic: { evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION, rubricVersion: DETERMINISTIC_RUBRIC_VERSION, schemaValid: false },
      findings: [{ issueKey: "invalid-report-schema", message: "The persisted report does not contain a blocks array." }],
      signals: [{ stage: "evaluation", issueKey: "invalid-report-schema", severity: "critical", evidence: { blocksArray: false } }],
      errorCode: "invalid-report-schema",
    };
  }

  const primaryDomain = input.primaryDomain;
  const companies = input.companies;
  const products = input.products;
  const matches = input.matches;
  const countSnapshot = { companies: companies.length, products: products.length, matches: matches.length, ads: input.ads.length };
  if (input.manifest.companyCount !== companies.length || input.manifest.productCount !== products.length || input.manifest.matchCount !== matches.length || input.manifest.adCount !== input.ads.length) {
    return {
      status: "failed",
      deterministicScore: null,
      deterministic: { evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION, rubricVersion: DETERMINISTIC_RUBRIC_VERSION, schemaValid: true, manifestConsistent: false, declared: input.manifest, persisted: countSnapshot },
      findings: [{ issueKey: "fact-manifest-count-mismatch", message: "Relational fact counts do not match the completed manifest." }],
      signals: [{ stage: "persistence", issueKey: "fact-manifest-count-mismatch", severity: "critical", evidence: { declared: input.manifest, persisted: countSnapshot } }],
      errorCode: "fact-manifest-count-mismatch",
    };
  }
  const companyDomains = new Set(companies.map((company) => text(company.domain)).filter(Boolean));
  const primaryProducts = products.filter((product) => text(product.domain) === primaryDomain);
  const rivalProducts = products.filter((product) => text(product.domain) !== primaryDomain);
  const competitors = companies.filter((company) => text(company.domain) !== primaryDomain && text(company.role) !== "primary");
  const productKeys = new Set(products.map((product) => `${text(product.domain)}\n${text(product.product_id ?? product.productId)}`));
  const productMap = new Map(products.map((product) => [`${text(product.domain)}\n${text(product.product_id ?? product.productId)}`, product]));
  const sourceLinkedMatches = matches.filter((match) => {
    const evidence = matchEvidence(match);
    const publication = record(evidence.publication);
    const rivalDomain = text(match.rival_domain ?? match.rivalDomain);
    return publication.priceEligible === true
      && productKeys.has(`${primaryDomain}\n${text(match.primary_product_id ?? match.primaryProductId)}`)
      && productKeys.has(`${rivalDomain}\n${text(match.rival_product_id ?? match.rivalProductId)}`)
      && belongsTo(evidence.primarySourceUrl, primaryDomain)
      && belongsTo(evidence.rivalSourceUrl, rivalDomain);
  });
  const pricedPairs = sourceLinkedMatches.filter((match) => {
    const rivalDomain = text(match.rival_domain ?? match.rivalDomain);
    const primary = productMap.get(`${primaryDomain}\n${text(match.primary_product_id ?? match.primaryProductId)}`);
    const rival = productMap.get(`${rivalDomain}\n${text(match.rival_product_id ?? match.rivalProductId)}`);
    return Boolean(primary && rival && productPrices(primary).length && productPrices(rival).length);
  });
  const claims = materialClaims(blocks);
  const evidenceIds = new Set(claims.map((claim) => text(claim.claimId ?? claim.id)).filter(Boolean));
  const sourceLinkedClaims = claims.filter((claim) => {
    const host = urlHost(claim.sourceUrl);
    return Boolean(host && [...companyDomains].some((domain) => host === domain || host.endsWith(`.${domain}`)));
  });
  const typedClaims = claims.filter((claim) => ["observed", "inferred", "estimated", "recommended", "recommendation"].includes(text(claim.claimType).toLowerCase()));
  const observedClaims = claims.filter((claim) => text(claim.claimType).toLowerCase() === "observed");
  const relationalSources = new Set<string>();
  for (const company of companies) if (safeUrl(company.evidence_url ?? company.evidenceUrl)) relationalSources.add(safeUrl(company.evidence_url ?? company.evidenceUrl));
  for (const product of products) {
    if (safeUrl(product.source_url ?? product.sourceUrl)) relationalSources.add(safeUrl(product.source_url ?? product.sourceUrl));
    if (safeUrl(product.image_url ?? product.imageUrl)) relationalSources.add(safeUrl(product.image_url ?? product.imageUrl));
  }
  const observedClaimsBacked = observedClaims.filter((claim) => relationalSources.has(safeUrl(claim.sourceUrl)));
  const datedClaims = claims.filter((claim) => Number.isFinite(Date.parse(text(claim.observedAt))));
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const freshnessMs = EVIDENCE_FRESHNESS_DAYS * 86_400_000;
  const freshClaims = datedClaims.filter((claim) => {
    const observedAt = Date.parse(text(claim.observedAt));
    return observedAt <= evaluatedAt && evaluatedAt - observedAt <= freshnessMs;
  });
  const regionBackedCompetitors = competitors.filter((company) => Boolean(text(companyEvidence(company).region)));
  const gaps = gapReasons(blocks);
  const unavailable = unavailablePhases(input.events);
  const recommendations = recommendationFacts(matches, evidenceIds);
  const linkedRecommendationCount = recommendations.linked;
  const explained = explainedPhases(unavailable, gaps);

  const evidenceIntegrity = {
    sourceLinkCoverage: formula(25, sourceLinkedClaims.length, claims.length, "persisted evidence blocks with a valid first-party company URL"),
    claimTypeCoverage: formula(15, typedClaims.length, claims.length, "persisted evidence blocks with an approved claim type"),
    relationalClaimCoverage: formula(15, observedClaimsBacked.length, observedClaims.length, "observed evidence whose exact cited URL exists in relational company or product facts"),
    freshnessCoverage: formula(10, freshClaims.length, datedClaims.length, `dated material evidence observed within ${EVIDENCE_FRESHNESS_DAYS} days`),
    regionalCompetitorCoverage: formula(10, regionBackedCompetitors.length, competitors.length, "accepted competitor company facts carrying first-party region evidence"),
    unavailablePhaseExplanation: formula(5, explained.length, unavailable.length, "unavailable event phases with a phase-specific rendered gap explanation", "no unavailable phase earns all five points", 5),
  };

  const ecommerce = primaryProducts.length > 0 || rivalProducts.length > 0;
  const unknowns = [
    ...(input.manifest.adCount === 0 ? [{ field: "adActivity", handling: "No attributable ad record was observed; this is not scored as zero market activity." }] : []),
    ...(rivalProducts.length === 0 ? [{ field: "rivalProductCoverage", handling: "No rival products were persisted; ratio components use their explicit zero-denominator rule." }] : []),
    ...(matches.length === 0 ? [{ field: "acceptedPairs", handling: "No accepted pair was persisted; pair-dependent ratios earn zero." }] : []),
  ];

  if (!ecommerce) {
    const earnedPoints = round4(scores(evidenceIntegrity));
    const applicablePoints = possible(evidenceIntegrity);
    return {
      status: "rubric_unavailable",
      deterministicScore: roundHalfUp((earnedPoints / applicablePoints) * 100),
      deterministic: {
        evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
        rubricVersion: DETERMINISTIC_RUBRIC_VERSION,
        businessType: "non-ecommerce",
        schemaValid: true,
        manifest: input.manifest,
        raw: { companies: companies.length, competitors: competitors.length, claims: claims.length, unavailablePhases: unavailable, renderedGapReasons: gaps.length },
        components: { evidenceIntegrity },
        earnedPoints,
        applicablePoints,
        unknowns,
      },
      findings: [{ issueKey: "ecommerce-rubric-unavailable", message: "No relational product facts were present, so only evidence-integrity diagnostics were computed." }],
      signals: [{ stage: "evaluation", issueKey: "ecommerce-rubric-unavailable", severity: "info", evidence: { primaryProducts: 0, rivalProducts: 0 } }],
      errorCode: "",
    };
  }

  const userValue = {
    verifiedCompetitors: floorFormula(15, competitors.length, 3, "relational competitor company facts"),
    acceptedSourceLinkedPairs: floorFormula(15, sourceLinkedMatches.length, 10, "relational accepted matches with both first-party product sources"),
    pairDomainBreadth: floorFormula(10, new Set(sourceLinkedMatches.map((match) => text(match.rival_domain ?? match.rivalDomain))).size, 3, "distinct rival domains in source-linked accepted matches"),
    observedPairPriceCoverage: formula(10, pricedPairs.length, sourceLinkedMatches.length, "accepted source-linked pairs whose two relational products carry observed public prices"),
    recommendationEvidenceCoverage: formula(10, linkedRecommendationCount, recommendations.count, "product-match recommendations linked to persisted evidence claim IDs"),
  };
  const evidenceYield = {
    primaryProducts: floorFormula(25, primaryProducts.length, 50, "relational primary-domain product facts"),
    verifiedCompetitors: floorFormula(20, competitors.length, 3, "relational competitor company facts"),
    rivalProducts: floorFormula(20, rivalProducts.length, 100, "relational rival-domain product facts"),
    rivalPriceCoverage: formula(10, rivalProducts.filter((product) => productPrices(product).length > 0).length, rivalProducts.length, "relational rival products with at least one public price signal"),
    rivalImageCoverage: formula(10, rivalProducts.filter(productHasSecureImage).length, rivalProducts.length, "relational rival products with a secure public image URL"),
    acceptedSourceLinkedPairs: floorFormula(15, sourceLinkedMatches.length, 10, "relational accepted matches with both first-party product sources"),
  };
  const presentation = {
    prioritizedEvidenceLinkedActions: formula(15, recommendations.count >= 1 && recommendations.count <= 3 && recommendations.linked === recommendations.count ? 1 : 0, 1, "one to three report actions, all linked to persisted evidence IDs"),
    renderedGapCoverage: formula(15, explained.length, unavailable.length, "every unavailable event phase has a phase-specific rendered gap explanation", "no unavailable phase earns all fifteen points", 15),
  };
  const componentGroups = { userValue, evidenceIntegrity, evidenceYield, presentation };
  const applicablePoints = Object.values(componentGroups).reduce((total, group) => total + possible(group), 0);
  const earnedPoints = round4(Object.values(componentGroups).reduce((total, group) => total + scores(group), 0));
  const deterministicScore = roundHalfUp((earnedPoints / applicablePoints) * 100);
  const caps: JsonRecord[] = [];
  if (claims.length > sourceLinkedClaims.length) caps.push({ issueKey: "unsupported-material-claims", maximumOverallScore: 30, numerator: claims.length - sourceLinkedClaims.length, denominator: claims.length });
  if (competitors.length === 0) caps.push({ issueKey: "no-accepted-competitor", maximumOverallScore: 45, competitorCount: 0 });
  if (competitors.length > 0 && sourceLinkedMatches.length === 0) caps.push({ issueKey: "no-defensible-product-pair", maximumOverallScore: 55, competitorCount: competitors.length, acceptedSourceLinkedPairs: 0 });
  if (primaryProducts.length === 0 && gaps.length === 0 && unavailable.length === 0) caps.push({ issueKey: "no-primary-products-without-access-explanation", maximumOverallScore: 35, primaryProductCount: 0 });
  const signals: DeterministicEvaluationResult["signals"] = caps.map((cap) => ({ stage: "evaluation", issueKey: text(cap.issueKey), severity: cap.issueKey === "unsupported-material-claims" ? "critical" : "warning", evidence: cap }));
  if (input.manifest.adCount === 0) signals.push({ stage: "ads", issueKey: "ad-coverage-unknown", severity: "info", evidence: { attributableAdCount: 0, interpretation: "no attributable record observed; activity unknown" } });
  const findings = caps.map((cap) => ({ issueKey: cap.issueKey, message: `Future hybrid overall score is capped at ${cap.maximumOverallScore}.`, evidence: cap }));

  return {
    status: "deterministic",
    deterministicScore,
    deterministic: {
      evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
      rubricVersion: DETERMINISTIC_RUBRIC_VERSION,
      businessType: "ecommerce",
      schemaValid: true,
      terminalStatus: input.terminalStatus,
      manifest: input.manifest,
      raw: {
        companies: companies.length,
        verifiedCompetitors: competitors.length,
        primaryProducts: primaryProducts.length,
        rivalProducts: rivalProducts.length,
        acceptedMatches: matches.length,
        acceptedSourceLinkedPairs: sourceLinkedMatches.length,
        pricedPairs: pricedPairs.length,
        claims: claims.length,
        sourceLinkedClaims: sourceLinkedClaims.length,
        observedClaims: observedClaims.length,
        observedClaimsBacked: observedClaimsBacked.length,
        datedClaims: datedClaims.length,
        freshClaims: freshClaims.length,
        recommendations: recommendations.count,
        evidenceLinkedRecommendations: recommendations.linked,
        unavailablePhases: unavailable,
        explainedUnavailablePhases: explained,
        renderedGapReasons: gaps.length,
      },
      components: componentGroups,
      earnedPoints,
      applicablePoints,
      deterministicScore,
      hardCaps: caps,
      hardCapsApplyTo: "future hybrid overall_score only",
      unknowns,
    },
    findings,
    signals,
    errorCode: "",
  };
}
