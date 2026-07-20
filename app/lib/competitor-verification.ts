import { profileTerms } from "./business-profile.ts";
import type { DiscoveryCandidate } from "./competitor-discovery.ts";
import { buildProductPairCandidateIndex, retrieveProductPairCandidates, scoreProductPair, type ProductRecord } from "./product-intelligence.ts";
import { regionCode, strictRegionCode } from "./region-inference.ts";

export type FirstPartyRegionSource = "first-party-observed" | "first-party-inferred";
export type VerificationRegionSource = "discovery-inferred" | "primary-first-party-observed" | "primary-first-party-inferred";

export type VerificationMarket = {
  region: string;
  regionCode: string;
  source: VerificationRegionSource;
};

export type VerificationSite = {
  domain: string;
  title: string;
  description: string;
  region: string;
  regionEvidenceSource?: FirstPartyRegionSource;
  headings?: string[];
  products: ProductRecord[];
};

export type CompetitorVerification = {
  accepted: boolean;
  verificationScore: number;
  confidence: "High" | "Medium" | "Low";
  categoryAlignment: boolean;
  regionCompatibility: boolean;
  primaryRegionKnown: boolean;
  candidateRegionKnown: boolean;
  targetRegion: string;
  targetRegionCode: string;
  targetRegionSource: VerificationRegionSource;
  candidateRegion: string;
  candidateRegionCode: string;
  candidateRegionSource: FirstPartyRegionSource;
  regionDecisionReason: string;
  overlapTerms: string[];
  hasProductOverlap: boolean;
  provenPrimaryProduct?: ProductRecord;
  provenRivalProduct?: ProductRecord;
};

export function resolveVerificationMarket(
  discoveryRegion: string,
  primaryRegion: string,
  primaryRegionSource: FirstPartyRegionSource = "first-party-inferred",
): VerificationMarket {
  const discoveryCode = strictRegionCode(discoveryRegion);
  if (discoveryCode && discoveryCode !== "GLOBAL") {
    return { region: discoveryRegion, regionCode: discoveryCode, source: "discovery-inferred" };
  }
  return {
    region: primaryRegion,
    regionCode: regionCode(primaryRegion),
    source: primaryRegionSource === "first-party-observed" ? "primary-first-party-observed" : "primary-first-party-inferred",
  };
}

const GENERIC = new Set([
  "business", "company", "delivery", "digital", "market", "marketplace", "online", "platform", "service", "services", "shop", "software", "store", "solutions",
]);
const ACCESSORY = /\b(?:accessories|accessory|bags?|cases?|chargers?|covers?|holders?|mounts?|parts?|straps?)\b/i;

function siteTerms(site: VerificationSite) {
  return new Set(profileTerms([
    site.title,
    site.description,
    ...(site.headings || []).slice(0, 12),
    ...site.products.slice(0, 30).flatMap((product) => [product.name, product.category, product.description]),
  ].join(" ")).filter((term) => !GENERIC.has(term)));
}

function strongestProductPair(primary: ProductRecord[], candidate: ProductRecord[]) {
  const index = buildProductPairCandidateIndex(candidate);
  return primary.flatMap((left) => retrieveProductPairCandidates(left, index).map((right) => ({ left, right, ...scoreProductPair(left, right) })))
    .filter((pair) => pair.eligible)
    .sort((left, right) => right.score - left.score || left.left.name.localeCompare(right.left.name))[0];
}

export function verifyCompetitorEntity(
  primary: VerificationSite,
  candidate: VerificationSite,
  discovery: DiscoveryCandidate,
  targetMarket: VerificationMarket = resolveVerificationMarket("", primary.region, primary.regionEvidenceSource),
): CompetitorVerification {
  const primaryTerms = siteTerms(primary);
  const candidateTerms = siteTerms(candidate);
  const overlapTerms = [...primaryTerms].filter((term) => candidateTerms.has(term)).sort().slice(0, 16);
  const discoveryTerms = profileTerms(`${discovery.marketCategory} ${discovery.sharedOfferings.join(" ")}`).filter((term) => !GENERIC.has(term));
  const ownSiteDiscoveryOverlap = discoveryTerms.filter((term) => candidateTerms.has(term));
  const pair = strongestProductPair(primary.products, candidate.products);
  const hasProductOverlap = Boolean(pair);

  const primaryCore = profileTerms(`${primary.title} ${primary.description} ${(primary.headings || []).slice(0, 8).join(" ")}`).filter((term) => !GENERIC.has(term));
  const candidateCore = profileTerms(`${candidate.title} ${candidate.description} ${(candidate.headings || []).slice(0, 8).join(" ")}`).filter((term) => !GENERIC.has(term));
  const coreOverlap = primaryCore.filter((term) => candidateCore.includes(term));
  const accessoryOnly = ACCESSORY.test(`${candidate.title} ${candidate.description}`) && coreOverlap.length < 2;
  const categoryAlignment = !accessoryOnly && coreOverlap.length >= 2;

  const primaryRegion = targetMarket.regionCode;
  const candidateRegion = regionCode(candidate.region);
  const regionCompatibility = !primaryRegion || !candidateRegion || primaryRegion === candidateRegion || primaryRegion === "GLOBAL" || candidateRegion === "GLOBAL";
  const candidateRegionSource = candidate.regionEvidenceSource || "first-party-inferred";
  const regionDecisionReason = !primaryRegion
    ? `Target market is unknown (${targetMarket.source}); candidate region ${candidateRegion || "unknown"} remains neutral (${candidateRegionSource}).`
    : !candidateRegion
      ? `Target market ${primaryRegion} (${targetMarket.source}); candidate region is unknown and remains neutral (${candidateRegionSource}).`
      : regionCompatibility
        ? `Target market ${primaryRegion} (${targetMarket.source}) is compatible with candidate region ${candidateRegion} (${candidateRegionSource}).`
        : `Target market ${primaryRegion} (${targetMarket.source}) conflicts with candidate region ${candidateRegion} (${candidateRegionSource}).`;

  const categoryScore = categoryAlignment ? Math.min(45, 30 + (coreOverlap.length * 4)) : 0;
  const productScore = pair ? Math.min(25, 14 + Math.round(pair.score * 20)) : Math.min(10, ownSiteDiscoveryOverlap.length * 3);
  const evidenceScore = Math.min(12, Math.max(discovery.mentionCount, discovery.evidence.length) * 4);
  const relationshipScore = discovery.relationship === "direct" ? 8 : 3;
  const regionScore = primaryRegion && candidateRegion ? (regionCompatibility ? 10 : 0) : 5;
  const verificationScore = Math.min(100, categoryScore + productScore + evidenceScore + relationshipScore + regionScore);
  const accepted = categoryAlignment && regionCompatibility && verificationScore >= 50;
  const confidence = verificationScore >= 78 && hasProductOverlap ? "High" : verificationScore >= 55 ? "Medium" : "Low";

  return {
    accepted,
    verificationScore,
    confidence,
    categoryAlignment,
    regionCompatibility,
    primaryRegionKnown: Boolean(primaryRegion),
    candidateRegionKnown: Boolean(candidateRegion),
    targetRegion: targetMarket.region,
    targetRegionCode: primaryRegion,
    targetRegionSource: targetMarket.source,
    candidateRegion: candidate.region,
    candidateRegionCode: candidateRegion,
    candidateRegionSource,
    regionDecisionReason,
    overlapTerms,
    hasProductOverlap,
    provenPrimaryProduct: pair?.left,
    provenRivalProduct: pair?.right,
  };
}

export function compareVerifiedCompetitors(left: CompetitorVerification, right: CompetitorVerification) {
  return Number(right.accepted) - Number(left.accepted)
    || Number(right.accepted && right.hasProductOverlap) - Number(left.accepted && left.hasProductOverlap)
    || right.verificationScore - left.verificationScore;
}
