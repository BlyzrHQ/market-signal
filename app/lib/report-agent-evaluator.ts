import {
  REPORT_EVALUATION_DEVELOPER_PROMPT,
  REPORT_EVALUATION_EVIDENCE_VERSION,
  REPORT_EVALUATION_MAX_OUTPUT_TOKENS,
  REPORT_EVALUATION_MAX_REQUEST_BYTES,
  REPORT_EVALUATION_MODEL,
  REPORT_EVALUATION_OUTPUT_SCHEMA,
  REPORT_EVALUATION_PRICING_VERSION,
  REPORT_EVALUATION_PROMPT_VERSION,
  REPORT_EVALUATION_SCHEMA_VERSION,
  REPORT_EVALUATOR_VERSION,
} from "../../src/shared/report-evaluation-contract.ts";

export const AGENT_EVALUATOR_VERSION = REPORT_EVALUATOR_VERSION;
export const AGENT_MODEL = REPORT_EVALUATION_MODEL;
export const AGENT_PROMPT_VERSION = REPORT_EVALUATION_PROMPT_VERSION;
export const AGENT_SCHEMA_VERSION = REPORT_EVALUATION_SCHEMA_VERSION;
export const AGENT_EVIDENCE_VERSION = REPORT_EVALUATION_EVIDENCE_VERSION;
export const AGENT_PRICING_VERSION = REPORT_EVALUATION_PRICING_VERSION;
export const AGENT_MAX_OUTPUT_TOKENS = REPORT_EVALUATION_MAX_OUTPUT_TOKENS;
export const AGENT_MAX_INPUT_BYTES = REPORT_EVALUATION_MAX_REQUEST_BYTES;
export const AGENT_MAX_EVIDENCE_RECORDS = 48;
export const AGENT_MAX_RESERVED_COST_MICROUSD = 20_000;

export const AGENT_PRICING_USD_PER_MILLION = Object.freeze({
  uncachedInput: 0.75,
  cachedInput: 0.075,
  output: 4.5,
});

export const AGENT_DEVELOPER_INSTRUCTIONS = REPORT_EVALUATION_DEVELOPER_PROMPT;

const ID_REGEX = /^[a-z][a-z0-9:_-]{0,119}$/;

export const SCORE_DEFINITIONS = Object.freeze({
  competitorUsefulness: { maximum: 10, evidenceTypes: ["company", "gap"] },
  productComparisonUsefulness: { maximum: 15, evidenceTypes: ["match", "product"] },
  recommendationSpecificity: { maximum: 15, evidenceTypes: ["recommendation", "match", "product", "company"] },
  uncertaintyHonesty: { maximum: 10, evidenceTypes: ["gap", "company", "product", "match"] },
  recommendationGrounding: { maximum: 10, evidenceTypes: ["recommendation", "match", "product", "company"] },
  prioritizationHierarchy: { maximum: 25, evidenceTypes: ["presentation", "recommendation", "gap"] },
  decisionClarity: { maximum: 25, evidenceTypes: ["presentation", "recommendation", "gap"] },
  topActionsIdentifiable: { maximum: 20, evidenceTypes: ["presentation", "recommendation", "gap"] },
} as const);

export type AgentScoreName = keyof typeof SCORE_DEFINITIONS;
export type EvidenceType = "company" | "product" | "match" | "recommendation" | "gap" | "presentation";
export type SubjectKind = "report" | "company" | "product" | "match" | "recommendation";
export type EvidencePriority = "hard_cap_gap" | "accepted_match" | "deterministic_loss" | "other";

export const STRENGTH_CODES = [
  "useful_competitors", "useful_product_pairs", "actionable_recommendations",
  "honest_uncertainty", "clear_priorities", "presentation_clarity",
] as const;
export const WEAKNESS_CODES = [
  "weak_competitor_fit", "weak_product_pairs", "generic_recommendations",
  "unsupported_certainty", "data_dumping", "evidence_gap",
] as const;
export const PROPOSAL_CODES = [
  "improve_competitor_verification", "improve_product_matching", "improve_price_coverage",
  "improve_image_coverage", "improve_recommendation_specificity", "improve_evidence_linking",
  "improve_gap_explanation", "improve_information_hierarchy",
] as const;
export const UNCERTAINTY_CODES = [
  "conflicting_evidence", "subjective_usefulness", "insufficient_context", "suspected_factual_error",
] as const;

type IssueCode = typeof STRENGTH_CODES[number] | typeof WEAKNESS_CODES[number] | typeof PROPOSAL_CODES[number];

const ISSUE_EVIDENCE_TYPES: Record<IssueCode, readonly EvidenceType[]> = {
  useful_competitors: ["company", "gap"],
  weak_competitor_fit: ["company", "gap"],
  improve_competitor_verification: ["company", "gap"],
  useful_product_pairs: ["product", "match"],
  weak_product_pairs: ["product", "match"],
  improve_product_matching: ["product", "match"],
  improve_price_coverage: ["product", "match"],
  improve_image_coverage: ["product", "match"],
  actionable_recommendations: ["recommendation", "match", "product", "company"],
  generic_recommendations: ["recommendation", "match", "product", "company"],
  improve_recommendation_specificity: ["recommendation", "match", "product", "company"],
  improve_evidence_linking: ["recommendation", "match", "product", "company"],
  honest_uncertainty: ["gap", "company", "product", "match"],
  unsupported_certainty: ["gap", "company", "product", "match"],
  evidence_gap: ["gap", "company", "product", "match"],
  improve_gap_explanation: ["gap", "company", "product", "match"],
  clear_priorities: ["presentation", "recommendation", "gap"],
  data_dumping: ["presentation", "recommendation", "gap"],
  presentation_clarity: ["presentation", "recommendation", "gap"],
  improve_information_hierarchy: ["presentation", "recommendation", "gap"],
};

export type AgentEvidenceRecord = {
  id: string;
  type: EvidenceType;
  companyId: string | null;
  productId: string | null;
  matchId: string | null;
  recommendationId: string | null;
  domain: string;
  sourceUrl: string;
  text: string;
};

export type AgentEvidenceCandidate = AgentEvidenceRecord & {
  priority?: EvidencePriority;
  sourceOrder?: number;
};

export type AgentFinding = {
  issueCode: IssueCode;
  subjectKind: SubjectKind;
  subjectId: string;
  explanation: string;
  evidenceIds: string[];
};

export type AgentScore = { score: number; reason: string; evidenceIds: string[] };
export type AgentEvaluationResult = {
  scores: Record<AgentScoreName, AgentScore>;
  strengths: AgentFinding[];
  weaknesses: AgentFinding[];
  proposals: AgentFinding[];
  humanReview: null | { uncertaintyCode: typeof UNCERTAINTY_CODES[number]; question: string; evidenceIds: string[] };
};

export const AGENT_OUTPUT_JSON_SCHEMA = REPORT_EVALUATION_OUTPUT_SCHEMA;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown, maximum: number) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_REGEX.test(value);
}

function safeUrl(value: unknown) {
  const candidate = cleanText(value, 500);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function relation(value: unknown) {
  return value === null || value === undefined || value === "" ? null : validId(value) ? value : null;
}

function evidenceKey(record: AgentEvidenceRecord) {
  return JSON.stringify([record.type, record.companyId, record.productId, record.matchId, record.recommendationId, record.domain, record.sourceUrl, record.text]);
}

function rank(priority: EvidencePriority | undefined) {
  return priority === "hard_cap_gap" ? 0 : priority === "accepted_match" ? 1 : priority === "deterministic_loss" ? 2 : 3;
}

/** Produces a deterministic, deduplicated, allowlisted evidence catalog. */
export function buildAgentEvidenceCatalog(candidates: readonly AgentEvidenceCandidate[]): AgentEvidenceRecord[] {
  const normalized = candidates.map((candidate, index) => {
    if (!validId(candidate.id)) throw new Error(`invalid-evidence-id:${String(candidate.id)}`);
    if (!["company", "product", "match", "recommendation", "gap", "presentation"].includes(candidate.type)) {
      throw new Error(`invalid-evidence-type:${String(candidate.type)}`);
    }
    const record: AgentEvidenceRecord = {
      id: candidate.id,
      type: candidate.type,
      companyId: relation(candidate.companyId),
      productId: relation(candidate.productId),
      matchId: relation(candidate.matchId),
      recommendationId: relation(candidate.recommendationId),
      domain: cleanText(candidate.domain, 253).toLowerCase(),
      sourceUrl: safeUrl(candidate.sourceUrl),
      text: cleanText(candidate.text, 320),
    };
    if (!record.text) throw new Error(`empty-evidence-text:${record.id}`);
    return { record, priority: candidate.priority, sourceOrder: Number.isInteger(candidate.sourceOrder) ? candidate.sourceOrder! : index };
  });

  const ids = new Set<string>();
  const facts = new Set<string>();
  const deduplicated = normalized.filter(({ record }) => {
    if (ids.has(record.id)) throw new Error(`duplicate-evidence-id:${record.id}`);
    ids.add(record.id);
    const key = evidenceKey(record);
    if (facts.has(key)) return false;
    facts.add(key);
    return true;
  });

  deduplicated.sort((a, b) => rank(a.priority) - rank(b.priority) || a.sourceOrder - b.sourceOrder || a.record.id.localeCompare(b.record.id));
  const accepted = deduplicated.filter((item) => item.priority === "accepted_match");
  const firstDomain = new Set<string>();
  const diverseAccepted = accepted.filter((item) => {
    const key = item.record.domain || item.record.companyId || item.record.id;
    if (firstDomain.has(key)) return false;
    firstDomain.add(key);
    return true;
  });
  const diverseIds = new Set(diverseAccepted.map((item) => item.record.id));
  const acceptedRemainder = accepted.filter((item) => !diverseIds.has(item.record.id));
  const ordered = [
    ...deduplicated.filter((item) => rank(item.priority) === 0),
    ...diverseAccepted,
    ...acceptedRemainder,
    ...deduplicated.filter((item) => rank(item.priority) >= 2),
  ];
  return ordered.slice(0, AGENT_MAX_EVIDENCE_RECORDS).map((item) => item.record);
}

function numericRecord(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  const source = object(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort().slice(0, 80)) {
    const item = source[key];
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (item && typeof item === "object" && !Array.isArray(item)) result[key] = numericRecord(item, depth + 1);
  }
  return result;
}

function projectHardCaps(value: unknown) {
  return (Array.isArray(value) ? value : []).slice(0, 8).map((entry) => {
    const source = object(entry);
    return {
      issueKey: cleanText(source.issueKey, 120),
      maximumOverallScore: Number.isFinite(Number(source.maximumOverallScore)) ? Number(source.maximumOverallScore) : null,
      numerator: Number.isFinite(Number(source.numerator)) ? Number(source.numerator) : null,
      denominator: Number.isFinite(Number(source.denominator)) ? Number(source.denominator) : null,
    };
  });
}

export type AgentEnvelopeInput = {
  report: { id: string; domain: string; status: string };
  deterministic: { raw: unknown; components: unknown; hardCaps: unknown };
  evidence: readonly AgentEvidenceRecord[];
  compactReport: {
    headline?: unknown;
    summary?: unknown;
    actions?: unknown;
    gaps?: unknown;
    sections?: unknown;
    navigationLabels?: unknown;
  };
};

export type CanonicalAgentEnvelope = {
  evaluatorVersion: string;
  report: { id: string; domain: string; status: string };
  deterministic: { raw: Record<string, unknown>; components: Record<string, unknown>; hardCaps: unknown[] };
  evidence: AgentEvidenceRecord[];
  presentation: {
    headline: string;
    summary: string;
    actions: string[];
    gaps: string[];
    sections: Array<{ label: string; summary: string }>;
    navigationLabels: string[];
  };
};

function stringList(value: unknown, count: number, length: number) {
  return (Array.isArray(value) ? value : []).slice(0, count).map((item) => cleanText(item, length)).filter(Boolean);
}

function requestBytes(serializedEnvelope: string) {
  return new TextEncoder().encode(AGENT_DEVELOPER_INSTRUCTIONS).byteLength
    + new TextEncoder().encode(JSON.stringify(AGENT_OUTPUT_JSON_SCHEMA)).byteLength
    + new TextEncoder().encode(serializedEnvelope).byteLength;
}

/** Builds the exact isolated user-data JSON and removes lowest-priority evidence until it fits. */
export function buildCanonicalAgentInput(input: AgentEnvelopeInput) {
  if (!validId(input.report.id)) throw new Error("invalid-report-id");
  const sections = (Array.isArray(input.compactReport.sections) ? input.compactReport.sections : []).slice(0, 8).map((item) => {
    const section = object(item);
    return { label: cleanText(section.label, 60), summary: cleanText(section.summary, 240) };
  }).filter((item) => item.label || item.summary);
  const envelope: CanonicalAgentEnvelope = {
    evaluatorVersion: AGENT_EVALUATOR_VERSION,
    report: {
      id: input.report.id,
      domain: cleanText(input.report.domain, 253).toLowerCase(),
      status: cleanText(input.report.status, 40),
    },
    deterministic: {
      raw: numericRecord(input.deterministic.raw),
      components: numericRecord(input.deterministic.components),
      hardCaps: projectHardCaps(input.deterministic.hardCaps),
    },
    evidence: input.evidence.slice(0, AGENT_MAX_EVIDENCE_RECORDS).map((item) => ({ ...item })),
    presentation: {
      headline: cleanText(input.compactReport.headline, 160),
      summary: cleanText(input.compactReport.summary, 600),
      actions: stringList(input.compactReport.actions, 3, 240),
      gaps: stringList(input.compactReport.gaps, 8, 240),
      sections,
      navigationLabels: stringList(input.compactReport.navigationLabels, 12, 60),
    },
  };
  let serialized = JSON.stringify(envelope);
  let bytes = requestBytes(serialized);
  while (bytes > AGENT_MAX_INPUT_BYTES && envelope.evidence.length) {
    envelope.evidence.pop();
    serialized = JSON.stringify(envelope);
    bytes = requestBytes(serialized);
  }
  if (bytes > AGENT_MAX_INPUT_BYTES) throw new Error("agent-input-too-large");
  return { envelope, serialized, inputBytes: bytes, droppedEvidenceCount: Math.max(0, input.evidence.length - envelope.evidence.length) };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, errors: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) errors.push(`${path}:unknown-or-missing-fields`);
}

function boundedText(value: unknown, min: number, max: number) {
  return typeof value === "string" && value.length >= min && value.length <= max && value.trim() === value;
}

function idList(value: unknown) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 5
    && new Set(value).size === value.length && value.every(validId);
}

function numericTokens(value: string) {
  return value.match(/(?<![a-z])(?:\d+(?:[.,]\d+)?%?)(?![a-z])/gi) ?? [];
}

function validateNumericProse(prose: string, cited: AgentEvidenceRecord[], path: string, errors: string[]) {
  const projections = cited.map((item) => item.text).join(" ");
  for (const token of numericTokens(prose)) {
    if (!projections.includes(token)) errors.push(`${path}:unsupported-numeric-claim:${token}`);
  }
}

function subjectMatches(record: AgentEvidenceRecord, kind: SubjectKind, id: string) {
  if (kind === "report") return true;
  return kind === "company" ? record.companyId === id
    : kind === "product" ? record.productId === id
      : kind === "match" ? record.matchId === id
        : record.recommendationId === id;
}

function citedRecords(ids: unknown, catalog: Map<string, AgentEvidenceRecord>, allowed: readonly EvidenceType[], path: string, errors: string[]) {
  if (!idList(ids)) {
    errors.push(`${path}:invalid-evidence-ids`);
    return [];
  }
  const records: AgentEvidenceRecord[] = [];
  for (const id of ids as string[]) {
    const record = catalog.get(id);
    if (!record) errors.push(`${path}:unknown-evidence:${id}`);
    else if (!allowed.includes(record.type)) errors.push(`${path}:inapplicable-evidence-type:${id}`);
    else records.push(record);
  }
  return records;
}

function validateFindingArray(
  value: unknown,
  path: string,
  permittedCodes: readonly string[],
  catalog: Map<string, AgentEvidenceRecord>,
  seenCodes: Set<string>,
  errors: string[],
) {
  if (!Array.isArray(value) || value.length > 3) {
    errors.push(`${path}:invalid-array`);
    return;
  }
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    const item = object(entry);
    exactKeys(item, ["issueCode", "subjectKind", "subjectId", "explanation", "evidenceIds"], at, errors);
    const code = typeof item.issueCode === "string" ? item.issueCode : "";
    if (!permittedCodes.includes(code)) errors.push(`${at}:disallowed-issue-code`);
    if (seenCodes.has(code)) errors.push(`${at}:duplicate-issue-code`);
    if (code) seenCodes.add(code);
    const kind = item.subjectKind as SubjectKind;
    if (!["report", "company", "product", "match", "recommendation"].includes(kind)) errors.push(`${at}:invalid-subject-kind`);
    if (!validId(item.subjectId)) errors.push(`${at}:invalid-subject-id`);
    if (!boundedText(item.explanation, 1, 240)) errors.push(`${at}:invalid-explanation`);
    const allowed = ISSUE_EVIDENCE_TYPES[code as IssueCode] ?? [];
    const cited = citedRecords(item.evidenceIds, catalog, allowed, at, errors);
    if (kind !== "report" && validId(item.subjectId) && !cited.some((record) => subjectMatches(record, kind, item.subjectId as string))) {
      errors.push(`${at}:evidence-subject-mismatch`);
    }
    if (typeof item.explanation === "string") validateNumericProse(item.explanation, cited, `${at}.explanation`, errors);
  });
}

export function validateAgentEvaluationResult(value: unknown, evidence: readonly AgentEvidenceRecord[]) {
  const errors: string[] = [];
  const root = object(value);
  exactKeys(root, ["scores", "strengths", "weaknesses", "proposals", "humanReview"], "$", errors);
  const catalog = new Map(evidence.map((item) => [item.id, item]));
  const scores = object(root.scores);
  exactKeys(scores, Object.keys(SCORE_DEFINITIONS), "$.scores", errors);
  for (const [name, definition] of Object.entries(SCORE_DEFINITIONS)) {
    const path = `$.scores.${name}`;
    const score = object(scores[name]);
    exactKeys(score, ["score", "reason", "evidenceIds"], path, errors);
    if (!Number.isInteger(score.score) || Number(score.score) < 0 || Number(score.score) > definition.maximum) errors.push(`${path}:score-out-of-range`);
    if (!boundedText(score.reason, 1, 200)) errors.push(`${path}:invalid-reason`);
    const cited = citedRecords(score.evidenceIds, catalog, definition.evidenceTypes, path, errors);
    if (typeof score.reason === "string") validateNumericProse(score.reason, cited, `${path}.reason`, errors);
  }
  const seenCodes = new Set<string>();
  validateFindingArray(root.strengths, "$.strengths", STRENGTH_CODES, catalog, seenCodes, errors);
  validateFindingArray(root.weaknesses, "$.weaknesses", WEAKNESS_CODES, catalog, seenCodes, errors);
  validateFindingArray(root.proposals, "$.proposals", PROPOSAL_CODES, catalog, seenCodes, errors);
  if (root.humanReview !== null) {
    const review = object(root.humanReview);
    exactKeys(review, ["uncertaintyCode", "question", "evidenceIds"], "$.humanReview", errors);
    if (!UNCERTAINTY_CODES.includes(review.uncertaintyCode as typeof UNCERTAINTY_CODES[number])) errors.push("$.humanReview:invalid-uncertainty-code");
    if (!boundedText(review.question, 1, 240)) errors.push("$.humanReview:invalid-question");
    const cited = citedRecords(review.evidenceIds, catalog, ["company", "product", "match", "recommendation", "gap", "presentation"], "$.humanReview", errors);
    if (typeof review.question === "string") validateNumericProse(review.question, cited, "$.humanReview.question", errors);
  }
  return errors.length ? { ok: false as const, errors } : { ok: true as const, value: value as AgentEvaluationResult, errors: [] as string[] };
}

export type AgentUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; costMicrousd: number };

export function calculateAgentUsageCost(usage: unknown): AgentUsage | null {
  const source = object(usage);
  const inputTokens = Number(source.input_tokens);
  const outputTokens = Number(source.output_tokens);
  const details = object(source.input_tokens_details);
  const cachedInputTokens = source.input_tokens_details === undefined ? 0 : Number(details.cached_tokens ?? 0);
  if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0
    || !Number.isInteger(cachedInputTokens) || cachedInputTokens < 0 || cachedInputTokens > inputTokens) return null;
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const costMicrousd = Math.ceil(
    uncachedInputTokens * AGENT_PRICING_USD_PER_MILLION.uncachedInput
    + cachedInputTokens * AGENT_PRICING_USD_PER_MILLION.cachedInput
    + outputTokens * AGENT_PRICING_USD_PER_MILLION.output,
  );
  return { inputTokens, cachedInputTokens, outputTokens, costMicrousd };
}

function responseText(response: Record<string, unknown>) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const output of Array.isArray(response.output) ? response.output : []) {
    for (const content of Array.isArray(object(output).content) ? object(output).content as unknown[] : []) {
      const item = object(content);
      if (item.type === "refusal") return null;
      if (item.type === "output_text" && typeof item.text === "string") return item.text;
    }
  }
  return "";
}

export function parseAgentApiResponse(response: unknown, evidence: readonly AgentEvidenceRecord[]) {
  const root = object(response);
  const providerResponseId = typeof root.id === "string" && root.id.trim() ? root.id : "";
  if (!providerResponseId) return { ok: false as const, errorCode: "missing-provider-response-id", usage: null };
  if (root.status !== "completed") return { ok: false as const, errorCode: root.status === "incomplete" ? "incomplete-response" : "agent-response-not-complete", usage: calculateAgentUsageCost(root.usage) };
  const text = responseText(root);
  if (text === null) return { ok: false as const, errorCode: "model-refusal", usage: calculateAgentUsageCost(root.usage) };
  if (!text) return { ok: false as const, errorCode: "missing-output-text", usage: calculateAgentUsageCost(root.usage) };
  const usage = calculateAgentUsageCost(root.usage);
  if (!usage) return { ok: false as const, errorCode: "missing-or-invalid-usage", usage: null };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false as const, errorCode: "malformed-agent-json", usage }; }
  const validation = validateAgentEvaluationResult(parsed, evidence);
  if (!validation.ok) return { ok: false as const, errorCode: "invalid-agent-result", errors: validation.errors, usage };
  return { ok: true as const, providerResponseId, result: validation.value, usage };
}

function sumScores(group: unknown) {
  let total = 0;
  for (const component of Object.values(object(group))) {
    const score = Number(object(component).score);
    total += Number.isFinite(score) ? score : 0;
  }
  return total;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function halfUp(value: number) {
  return Math.floor(value + 0.5);
}

export function calculateHybridScores(deterministic: unknown, agent: AgentEvaluationResult) {
  if (agent.humanReview !== null) return null;
  const profile = object(deterministic);
  const components = object(profile.components);
  const userValue = round4(sumScores(components.userValue) + agent.scores.competitorUsefulness.score
    + agent.scores.productComparisonUsefulness.score + agent.scores.recommendationSpecificity.score);
  const evidenceIntegrity = round4(sumScores(components.evidenceIntegrity) + agent.scores.uncertaintyHonesty.score
    + agent.scores.recommendationGrounding.score);
  const evidenceYield = round4(sumScores(components.evidenceYield));
  const presentation = round4(sumScores(components.presentation) + agent.scores.prioritizationHierarchy.score
    + agent.scores.decisionClarity.score + agent.scores.topActionsIdentifiable.score);
  const weighted = round4(userValue * 0.4 + evidenceIntegrity * 0.3 + evidenceYield * 0.2 + presentation * 0.1);
  const caps = Array.isArray(profile.hardCaps) ? profile.hardCaps : [];
  const hardCap = caps.reduce((lowest, cap) => {
    const value = Number(object(cap).maximumOverallScore);
    return Number.isFinite(value) ? Math.min(lowest, value) : lowest;
  }, 100);
  const overallScore = halfUp(Math.min(weighted, hardCap));
  const grade = overallScore >= 90 ? "A" : overallScore >= 80 ? "B" : overallScore >= 70 ? "C" : overallScore >= 55 ? "D" : "F";
  return { userValue, evidenceIntegrity, evidenceYield, presentation, weightedBeforeCap: weighted, hardCap, overallScore, grade };
}
