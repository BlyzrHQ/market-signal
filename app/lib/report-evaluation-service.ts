import type { ApplicationDatabase } from "./database-contract.ts";
import {
  REPORT_AGENT_DEFAULT_MODEL,
  REPORT_AGENT_JUDGE_VERSION,
  REPORT_AGENT_LIMITS,
  REPORT_AGENT_PRICING_VERSION,
  REPORT_AGENT_PROMPT_VERSION,
  REPORT_AGENT_RUBRIC_VERSION,
  buildReportAgentPacket,
  calculateReportAgentCost,
  canonicalReportAgentJSON,
  computeHybridReportScore,
  reserveReportAgentCost,
  validateReportAgentOutput,
  type AgentEvidenceInput,
  type AgentJudgeOutput,
  type JudgeUsage,
  type ReportAgentPacket,
} from "./report-agent-judge.ts";
import { profileDeterministicEvaluation } from "./report-evaluator.ts";
import { ensureReportStorageSchema, getReportDatabase } from "./report-store.ts";
import { parseReportEvaluationPayload, type ReportEvaluationPayload } from "../../src/shared/report-evaluation-contract.ts";

const WORKER_LEASE_MS = 5 * 60 * 1000;
const DISPATCH_LEASE_MS = 2 * 60 * 1000;
const RECOVERY_AGE_MS = 5 * 60 * 1000;
const MAX_DISPATCHES = 25;
const MAX_DISPATCH_GENERATIONS = 3;
const MAX_TRANSPORT_ATTEMPTS = 3;
const HASH = /^[a-f0-9]{64}$/;
const LEASE_TOKEN = /^\S{32,256}$/;
const TERMINAL = new Set(["complete", "agent_rejected", "insufficient_facts", "rubric_unavailable", "failed"]);

type Row = Record<string, unknown>;
export type ReportEvaluationLease = ReportEvaluationPayload & { leaseToken: string; leaseGeneration: number };

export type CompleteInput = {
  lease: ReportEvaluationLease;
  packetHash: string;
  model: string;
  judge: unknown;
  hybrid: unknown;
  usage: JudgeUsage;
};

export type RejectInput = {
  lease: ReportEvaluationLease;
  packetHash: string;
  phase: "ready_for_judge" | "judging";
  errorCode: string;
  usage?: JudgeUsage;
};

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function json(value: unknown, fallback: unknown) {
  try { return JSON.parse(text(value)) as unknown; } catch { return fallback; }
}
function isoAfter(now: Date, milliseconds: number) { return new Date(now.getTime() + milliseconds).toISOString(); }
function opaqueToken() { return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""); }
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function database(override?: ApplicationDatabase | null) {
  const result = override === undefined ? await getReportDatabase() : override;
  if (!result) throw new Error("Persistent report storage is unavailable.");
  await ensureReportStorageSchema(result);
  return result;
}
async function evaluation(db: ApplicationDatabase, id: string) {
  const rows = await db.prepare("SELECT * FROM report_evaluations WHERE id = ? AND evaluation_type = 'report' LIMIT 1").bind(id).all<Row>();
  return rows.results?.[0] || null;
}
function assertPayload(value: ReportEvaluationPayload) { return parseReportEvaluationPayload(value); }
function assertLease(value: ReportEvaluationLease) {
  const payload = assertPayload({
    contractVersion: value.contractVersion,
    evaluationId: value.evaluationId,
    evaluatorVersion: value.evaluatorVersion,
    inputHash: value.inputHash,
    factManifestHash: value.factManifestHash,
    dispatchGeneration: value.dispatchGeneration,
    dispatchToken: value.dispatchToken,
  });
  if (!LEASE_TOKEN.test(value.leaseToken) || !Number.isInteger(value.leaseGeneration) || value.leaseGeneration < 1) throw new Error("Invalid evaluation lease.");
  return { ...payload, leaseToken: value.leaseToken, leaseGeneration: value.leaseGeneration };
}
function assertBinding(row: Row, value: ReportEvaluationPayload, includeDispatchToken = true) {
  if (text(row.id) !== value.evaluationId || text(row.input_hash) !== value.inputHash || text(row.fact_manifest_hash) !== value.factManifestHash
    || text(row.evaluator_version) !== value.evaluatorVersion || Number(row.dispatch_generation) !== value.dispatchGeneration
    || (includeDispatchToken && text(row.lease_token) !== value.dispatchToken)) {
    throw new Error("Report evaluation binding conflicts with the frozen evidence snapshot.");
  }
}
function assertWorkerBinding(row: Row, value: ReportEvaluationLease) {
  assertBinding(row, value);
  if (text(row.lease_token) !== value.leaseToken || Number(row.lease_generation) !== value.leaseGeneration) throw new Error("Report evaluation lease conflicts with the active worker.");
}
function active(row: Row, now: Date) { return Boolean(text(row.lease_expires_at) && text(row.lease_expires_at) > now.toISOString()); }
function stateResult(row: Row) { return { accepted: false as const, state: text(row.status) || "unavailable" }; }

function documentRoot(value: unknown) {
  const root = record(value);
  const nested = record(root.document);
  return Object.keys(nested).length ? nested : root;
}
function host(value: unknown) {
  try { return new URL(text(value)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
function evidenceInputs(document: unknown, primaryDomain: string, companies: Row[], products: Row[], matches: Row[], ads: Row[]) {
  const root = documentRoot(document);
  const blocks = array(root.blocks).map(record);
  const evidence: AgentEvidenceInput[] = blocks.filter((block) => block.type === "evidence").map((block, index) => ({
    id: block.claimId || block.id || `document-evidence-${index + 1}`,
    claimType: block.claimType || "observed",
    excerpt: block.text || block.excerpt || "",
    sourceRole: host(block.sourceUrl) === primaryDomain ? "primary" : "competitor",
    sourceDomain: host(block.sourceUrl),
    observedAt: block.observedAt,
    relevance: { kind: "document", rank: index + 1 },
  }));
  for (const company of companies) evidence.push({ id: `company:${text(company.domain)}`, claimType: "observed", excerpt: `${text(company.company_name)} ${text(company.role)}`, sourceRole: text(company.role), sourceDomain: text(company.domain), observedAt: company.observed_at, relevance: { kind: "company" } });
  for (const product of products) evidence.push({ id: `product:${text(product.domain)}:${text(product.product_id)}`, claimType: "observed", excerpt: `${text(product.name)} ${text(product.price_json)}`, sourceRole: text(product.domain) === primaryDomain ? "primary" : "competitor", sourceDomain: text(product.domain), observedAt: product.observed_at, relevance: { kind: "product" } });
  for (const match of matches) {
    const detail = record(json(match.evidence_json, {}));
    evidence.push({ id: `match:${text(match.id)}`, claimType: match.claim_type || "inferred", excerpt: `${text(match.verdict)} ${JSON.stringify(detail)}`, sourceRole: "comparison", sourceDomain: text(match.rival_domain), observedAt: match.observed_at, relevance: { kind: "match" } });
  }
  for (const ad of ads) evidence.push({ id: `ad:${text(ad.id)}`, claimType: "observed", excerpt: `${text(ad.platform)} ${text(ad.status)} ${text(ad.evidence_json)}`, sourceRole: "competitor", sourceDomain: text(ad.domain), observedAt: ad.observed_at, relevance: { kind: "ad" } });
  return evidence;
}
function packetInput(document: unknown, profile: unknown, terminalStatus: string, primaryDomain: string, companies: Row[], products: Row[], matches: Row[], ads: Row[], events: Row[]) {
  const root = documentRoot(document);
  const blocks = array(root.blocks).map(record);
  const comparisons: Array<Record<string, unknown>> = [];
  const actions: Array<Record<string, unknown>> = [];
  for (const match of matches) {
    const detail = record(json(match.evidence_json, {}));
    const decision = record(detail.decision);
    const actionPlan = record(decision.actionPlan);
    const ids = [...array(detail.claimIds), `match:${text(match.id)}`];
    comparisons.push({ id: `comparison:${text(match.id)}`, kind: "comparison", title: text(match.verdict), excerpt: JSON.stringify(detail), evidenceIds: ids });
    if (decision.recommendedMove || actionPlan.actionEn) actions.push({ id: `action:${text(match.id)}`, kind: "action", title: decision.recommendedMove, excerpt: actionPlan.actionEn || decision.recommendedMove, evidenceIds: ids });
  }
  const gaps = blocks.filter((block) => block.type === "gap").map((block, index) => ({ id: block.id || `document-gap-${index + 1}`, phase: block.phase || "report", reason: block.reason, evidenceIds: block.evidenceIds }));
  for (const event of events) if (["limited", "failed", "interrupted"].includes(text(event.status))) gaps.push({ id: `event-gap-${text(event.sequence)}`, phase: event.phase, reason: event.message, evidenceIds: [] });
  const summaryBlock = blocks.find((block) => block.type === "summary" || block.type === "market-profile") || {};
  return {
    report: { businessType: record(profile).businessType, terminalStatus, title: root.title || summaryBlock.title, summary: root.summary || summaryBlock.summary || summaryBlock.text },
    deterministicProfile: profile,
    evidence: evidenceInputs(document, primaryDomain, companies, products, matches, ads),
    comparisons,
    actions,
    gaps,
  };
}

async function loadPrepared(db: ApplicationDatabase, row: Row) {
  const runId = text(row.run_id);
  const [runs, documents, manifests, companies, products, matches, ads, events] = await Promise.all([
    db.prepare("SELECT * FROM report_runs WHERE id = ? LIMIT 1").bind(runId).all<Row>(),
    db.prepare("SELECT document_json FROM report_documents WHERE run_id = ? LIMIT 1").bind(runId).all<Row>(),
    db.prepare("SELECT * FROM report_fact_manifests WHERE run_id = ? LIMIT 1").bind(runId).all<Row>(),
    db.prepare("SELECT * FROM report_companies WHERE run_id = ? ORDER BY domain").bind(runId).all<Row>(),
    db.prepare("SELECT * FROM report_products WHERE run_id = ? ORDER BY domain, product_id").bind(runId).all<Row>(),
    db.prepare("SELECT * FROM report_matches WHERE run_id = ? ORDER BY rival_domain, id").bind(runId).all<Row>(),
    db.prepare("SELECT * FROM report_ads WHERE run_id = ? ORDER BY domain, platform, id").bind(runId).all<Row>(),
    db.prepare("SELECT * FROM report_events WHERE run_id = ? ORDER BY sequence").bind(runId).all<Row>(),
  ]);
  const run = runs.results?.[0];
  const manifest = manifests.results?.[0];
  const documentJson = text(documents.results?.[0]?.document_json);
  if (!run || !documentJson || !manifest || manifest.status !== "complete" || !["complete", "limited"].includes(text(run.status))) throw new Error("Report evaluation facts are incomplete.");
  if (await sha256(documentJson) !== text(row.input_hash) || text(manifest.manifest_hash) !== text(row.fact_manifest_hash)) throw new Error("Report evaluation binding conflicts with the frozen evidence snapshot.");
  const document = JSON.parse(documentJson) as unknown;
  const profile = text(row.deterministic_json) !== "{}" ? json(row.deterministic_json, {}) : profileDeterministicEvaluation({
    primaryDomain: text(run.primary_domain), terminalStatus: text(run.status) as "complete" | "limited", evaluatedAt: text(row.evaluated_at), document,
    manifest: { companyCount: Number(manifest.company_count), productCount: Number(manifest.product_count), matchCount: Number(manifest.match_count), adCount: Number(manifest.ad_count) },
    companies: companies.results || [], products: products.results || [], matches: matches.results || [], ads: ads.results || [], events: events.results || [],
  });
  const deterministic = record(profile).deterministic || profile;
  const built = buildReportAgentPacket(packetInput(document, deterministic, text(run.status), text(run.primary_domain), companies.results || [], products.results || [], matches.results || [], ads.results || [], events.results || []));
  return { run, manifest, document, profile, deterministic, built };
}

function validateFrozen(row: Row) {
  const reservation = reserveReportAgentCost(text(row.model));
  if (text(row.evaluator_version) !== REPORT_AGENT_JUDGE_VERSION || text(row.rubric_version) !== REPORT_AGENT_RUBRIC_VERSION
    || text(row.prompt_version) !== REPORT_AGENT_PROMPT_VERSION
    || Number(row.max_input_tokens) !== REPORT_AGENT_LIMITS.reservedInputTokens || Number(row.max_output_tokens) !== REPORT_AGENT_LIMITS.reservedOutputTokens
    || (reservation.accepted && (text(row.pricing_version) !== REPORT_AGENT_PRICING_VERSION || Number(row.reserved_cost_microusd) !== reservation.costWithRegionalUpliftMicrousd))
    || (!reservation.accepted && (text(row.pricing_version) !== "" || Number(row.reserved_cost_microusd) !== 0))) throw new Error("Report evaluation frozen configuration is invalid.");
  return reservation;
}

export async function lease(payloadInput: ReportEvaluationPayload, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  const payload = assertPayload(payloadInput);
  const db = await database(databaseOverride);
  const current = await evaluation(db, payload.evaluationId);
  if (!current) return { accepted: false as const, state: "unavailable" };
  assertBinding(current, payload);
  if (current.status !== "dispatching") return stateResult(current);
  if (!active(current, now)) return stateResult(current);
  validateFrozen(current);
  const nextGeneration = Number(current.lease_generation) + 1;
  const rows = await db.prepare(`UPDATE report_evaluations SET status = 'profiling', dispatch_outcome = 'accepted', lease_generation = ?, lease_expires_at = ?, started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END WHERE id = ? AND status = 'dispatching' AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? AND lease_token = ? AND lease_generation = ? AND lease_expires_at > ? RETURNING lease_token, lease_generation`).bind(nextGeneration, isoAfter(now, WORKER_LEASE_MS), now.toISOString(), payload.evaluationId, payload.inputHash, payload.factManifestHash, payload.evaluatorVersion, payload.dispatchGeneration, payload.dispatchToken, Number(current.lease_generation), now.toISOString()).all<Row>();
  if (!rows.results?.length) return stateResult((await evaluation(db, payload.evaluationId)) || current);
  await db.prepare("UPDATE report_runs SET heartbeat_at = ? WHERE id = ?").bind(now.toISOString(), current.run_id).run();
  return { accepted: true as const, leaseToken: text(rows.results[0].lease_token), leaseGeneration: Number(rows.results[0].lease_generation) };
}

export async function prepare(leaseInput: ReportEvaluationLease, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  const worker = assertLease(leaseInput);
  const db = await database(databaseOverride);
  let row = await evaluation(db, worker.evaluationId);
  if (!row) return { accepted: false as const, state: "unavailable" };
  assertWorkerBinding(row, worker);
  if (!["profiling", "ready_for_judge"].includes(text(row.status)) || !active(row, now)) return stateResult(row);
  validateFrozen(row);
  const loaded = await loadPrepared(db, row);
  if (row.status === "ready_for_judge") {
    const packetHash = await sha256(loaded.built.canonicalJson);
    if (packetHash !== text(row.packet_hash)) throw new Error("Report evaluation packet hash conflicts with persisted preparation.");
    return { accepted: true as const, prepared: { model: text(row.model), packetHash, packet: loaded.built.packet, deterministicProfile: loaded.deterministic }, replayed: true as const };
  }
  const result = record(loaded.profile);
  const status = text(result.status);
  if (status !== "deterministic") {
    const terminal = status === "rubric_unavailable" ? "rubric_unavailable" : "failed";
    const deterministicScore = typeof result.deterministicScore === "number" ? result.deterministicScore : null;
    await db.prepare(`UPDATE report_evaluations SET status = ?, rating_basis = ?, deterministic_score = ?, overall_score = NULL, grade = NULL, deterministic_json = ?, findings_json = ?, error_code = ?, completed_at = ? WHERE id = ? AND status = 'profiling' AND lease_token = ? AND lease_generation = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ?`).bind(terminal, terminal === "rubric_unavailable" ? "deterministic_only" : "none", deterministicScore, JSON.stringify(loaded.deterministic), JSON.stringify(result.findings || []), text(result.errorCode), now.toISOString(), worker.evaluationId, worker.leaseToken, worker.leaseGeneration, worker.inputHash, worker.factManifestHash, worker.evaluatorVersion, worker.dispatchGeneration).run();
    return { accepted: false as const, state: terminal };
  }
  const reservation = validateFrozen(row);
  if (!reservation.accepted) {
    const updated = await db.prepare(`UPDATE report_evaluations SET status = 'agent_rejected', rating_basis = 'deterministic_only', deterministic_score = ?, deterministic_json = ?, findings_json = ?, overall_score = NULL, grade = NULL, error_code = ?, completed_at = ? WHERE id = ? AND status = 'profiling' AND lease_token = ? AND lease_generation = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? RETURNING id`).bind(Number(result.deterministicScore), JSON.stringify(loaded.deterministic), JSON.stringify(result.findings || []), reservation.errorCode, now.toISOString(), worker.evaluationId, worker.leaseToken, worker.leaseGeneration, worker.inputHash, worker.factManifestHash, worker.evaluatorVersion, worker.dispatchGeneration).all<Row>();
    return { accepted: false as const, state: updated.results?.length ? "agent_rejected" : text((await evaluation(db, worker.evaluationId))?.status || "unavailable") };
  }
  const packetHash = await sha256(loaded.built.canonicalJson);
  const updated = await db.prepare(`UPDATE report_evaluations SET status = 'ready_for_judge', deterministic_score = ?, deterministic_json = ?, findings_json = ?, packet_hash = ?, lease_expires_at = ? WHERE id = ? AND status = 'profiling' AND lease_token = ? AND lease_generation = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? RETURNING id`).bind(Number(result.deterministicScore), JSON.stringify(loaded.deterministic), JSON.stringify(result.findings || []), packetHash, isoAfter(now, WORKER_LEASE_MS), worker.evaluationId, worker.leaseToken, worker.leaseGeneration, worker.inputHash, worker.factManifestHash, worker.evaluatorVersion, worker.dispatchGeneration).all<Row>();
  if (!updated.results?.length) {
    row = await evaluation(db, worker.evaluationId);
    if (!row) return { accepted: false as const, state: "unavailable" };
    return stateResult(row);
  }
  return { accepted: true as const, prepared: { model: text(row.model), packetHash, packet: loaded.built.packet, deterministicProfile: loaded.deterministic }, replayed: false as const };
}

export async function beginJudging(leaseInput: ReportEvaluationLease, packetHash: string, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  const worker = assertLease(leaseInput);
  if (!HASH.test(packetHash)) throw new Error("Invalid report evaluation packet hash.");
  const db = await database(databaseOverride);
  const row = await evaluation(db, worker.evaluationId);
  if (!row) return { accepted: false as const, state: "unavailable" };
  assertWorkerBinding(row, worker);
  if (row.status !== "ready_for_judge" || !active(row, now) || text(row.packet_hash) !== packetHash) return stateResult(row);
  const updated = await db.prepare(`UPDATE report_evaluations SET status = 'judging', lease_expires_at = ? WHERE id = ? AND status = 'ready_for_judge' AND lease_token = ? AND lease_generation = ? AND packet_hash = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? AND lease_expires_at > ? RETURNING id`).bind(isoAfter(now, WORKER_LEASE_MS), worker.evaluationId, worker.leaseToken, worker.leaseGeneration, packetHash, worker.inputHash, worker.factManifestHash, worker.evaluatorVersion, worker.dispatchGeneration, now.toISOString()).all<Row>();
  if (!updated.results?.length) return stateResult((await evaluation(db, worker.evaluationId)) || row);
  return { accepted: true as const, state: "judging" as const };
}

function validUsage(value: unknown): value is JudgeUsage {
  const usage = record(value);
  const keys = ["cachedInputTokens", "costMicrousd", "costWithRegionalUpliftMicrousd", "inputTokens", "outputTokens", "totalTokens", "uncachedInputTokens"].sort();
  if (Object.keys(usage).sort().join("|") !== keys.join("|")) return false;
  if (keys.some((key) => !Number.isInteger(usage[key]) || Number(usage[key]) < 0)) return false;
  const input = Number(usage.inputTokens), cached = Number(usage.cachedInputTokens), output = Number(usage.outputTokens);
  if (input > REPORT_AGENT_LIMITS.reservedInputTokens || output > REPORT_AGENT_LIMITS.reservedOutputTokens || cached > input || Number(usage.uncachedInputTokens) !== input - cached || Number(usage.totalTokens) !== input + output) return false;
  const cost = calculateReportAgentCost(input, output, cached);
  return Number(usage.costMicrousd) === cost.costMicrousd && Number(usage.costWithRegionalUpliftMicrousd) === cost.costWithRegionalUpliftMicrousd && cost.costWithRegionalUpliftMicrousd <= REPORT_AGENT_LIMITS.maximumCostMicrousd;
}
function sameJson(left: unknown, right: unknown) { return canonicalReportAgentJSON(left) === canonicalReportAgentJSON(right); }

export async function complete(input: CompleteInput, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  const worker = assertLease(input.lease);
  if (!HASH.test(input.packetHash) || !validUsage(input.usage)) throw new Error("Invalid report evaluation completion.");
  const db = await database(databaseOverride);
  const row = await evaluation(db, worker.evaluationId);
  if (!row) return { accepted: false as const, state: "unavailable" };
  assertWorkerBinding(row, worker);
  if (TERMINAL.has(text(row.status))) return stateResult(row);
  if (row.status !== "judging" || text(row.packet_hash) !== input.packetHash || text(row.model) !== input.model || !active(row, now)) return stateResult(row);
  validateFrozen(row);
  const loaded = await loadPrepared(db, row);
  if (await sha256(loaded.built.canonicalJson) !== input.packetHash) throw new Error("Report evaluation packet hash conflicts with persisted preparation.");
  const judge = validateReportAgentOutput(input.judge, loaded.built.packet.evidence);
  if ("errorCode" in judge) throw new Error(judge.errorCode);
  const hybrid = computeHybridReportScore({ deterministicProfile: loaded.deterministic, judge: judge.result });
  if (!hybrid.accepted || !sameJson(hybrid, input.hybrid)) throw new Error("Report evaluation hybrid score is invalid.");
  const updated = await db.prepare(`UPDATE report_evaluations SET status = 'complete', rating_basis = 'hybrid', overall_score = ?, user_value_score = ?, evidence_integrity_score = ?, evidence_yield_score = ?, presentation_score = ?, grade = ?, agent_json = ?, findings_json = ?, proposals_json = ?, cost_microusd = ?, input_tokens = ?, output_tokens = ?, error_code = '', completed_at = ? WHERE id = ? AND status = 'judging' AND lease_token = ? AND lease_generation = ? AND lease_expires_at > ? AND packet_hash = ? AND model = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? RETURNING id`).bind(hybrid.overallScore, hybrid.dimensions.userValue, hybrid.dimensions.evidenceIntegrity, hybrid.dimensions.evidenceYield, hybrid.dimensions.presentationUtility, hybrid.grade, JSON.stringify({ judge: judge.result, hybrid, usage: input.usage }), JSON.stringify(judge.result.findings), JSON.stringify(judge.result.proposals), input.usage.costWithRegionalUpliftMicrousd, input.usage.inputTokens, input.usage.outputTokens, now.toISOString(), worker.evaluationId, worker.leaseToken, worker.leaseGeneration, now.toISOString(), input.packetHash, input.model, worker.inputHash, worker.factManifestHash, worker.evaluatorVersion, worker.dispatchGeneration).all<Row>();
  if (!updated.results?.length) return stateResult((await evaluation(db, worker.evaluationId)) || row);
  return { accepted: true as const, state: "complete" as const, overallScore: hybrid.overallScore, grade: hybrid.grade };
}

export async function reject(input: RejectInput, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  const worker = assertLease(input.lease);
  if (!HASH.test(input.packetHash) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.errorCode) || (input.usage !== undefined && !validUsage(input.usage))) throw new Error("Invalid report evaluation rejection.");
  const db = await database(databaseOverride);
  const row = await evaluation(db, worker.evaluationId);
  if (!row) return { accepted: false as const, state: "unavailable" };
  assertWorkerBinding(row, worker);
  if (TERMINAL.has(text(row.status))) return stateResult(row);
  if (row.status !== input.phase || text(row.packet_hash) !== input.packetHash || !active(row, now)) return stateResult(row);
  const usage = input.usage;
  const updated = await db.prepare(`UPDATE report_evaluations SET status = 'agent_rejected', rating_basis = 'deterministic_only', overall_score = NULL, grade = NULL, agent_json = ?, cost_microusd = ?, input_tokens = ?, output_tokens = ?, error_code = ?, completed_at = ? WHERE id = ? AND status = ? AND lease_token = ? AND lease_generation = ? AND lease_expires_at > ? AND packet_hash = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? RETURNING id`).bind(JSON.stringify({ outcome: "rejected", errorCode: input.errorCode, ...(usage ? { usage } : {}) }), usage?.costWithRegionalUpliftMicrousd || 0, usage?.inputTokens || 0, usage?.outputTokens || 0, input.errorCode, now.toISOString(), worker.evaluationId, input.phase, worker.leaseToken, worker.leaseGeneration, now.toISOString(), input.packetHash, worker.inputHash, worker.factManifestHash, worker.evaluatorVersion, worker.dispatchGeneration).all<Row>();
  if (!updated.results?.length) return stateResult((await evaluation(db, worker.evaluationId)) || row);
  return { accepted: true as const, state: "agent_rejected" as const, errorCode: input.errorCode };
}

async function reconcileExpired(db: ApplicationDatabase, now: Date) {
  const observedAt = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE report_evaluations SET status = 'agent_rejected', rating_basis = 'deterministic_only', overall_score = NULL, grade = NULL, error_code = 'agent-call-outcome-unknown', completed_at = ? WHERE evaluation_type = 'report' AND status = 'judging' AND lease_expires_at != '' AND lease_expires_at <= ?`).bind(observedAt, observedAt),
    db.prepare(`UPDATE report_evaluations SET status = 'pending', dispatch_outcome = 'accepted', lease_expires_at = '' WHERE evaluation_type = 'report' AND status IN ('profiling', 'ready_for_judge') AND lease_expires_at != '' AND lease_expires_at <= ?`).bind(observedAt),
    db.prepare(`UPDATE report_evaluations SET status = 'failed', rating_basis = 'none', overall_score = NULL, grade = NULL, error_code = 'evaluation-dispatch-exhausted', completed_at = ? WHERE evaluation_type = 'report' AND status IN ('pending', 'dispatch_failed') AND dispatch_generation >= ? AND dispatch_outcome = 'accepted'`).bind(observedAt, MAX_DISPATCH_GENERATIONS),
  ]);
}

async function backlogRows(db: ApplicationDatabase, limit?: number) {
  const suffix = limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.min(MAX_DISPATCHES, limit))}`;
  return db.prepare(`SELECT r.id AS run_id, r.status AS run_status, d.document_json, m.manifest_hash, m.status AS manifest_status FROM report_runs r JOIN report_documents d ON d.run_id = r.id LEFT JOIN report_fact_manifests m ON m.run_id = r.id WHERE r.status IN ('complete', 'limited') AND NOT EXISTS (SELECT 1 FROM report_evaluations e WHERE e.run_id = r.id AND e.evaluation_type = 'report' AND e.evaluator_version = ?) ORDER BY r.created_at, r.id${suffix}`).bind(REPORT_AGENT_JUDGE_VERSION).all<Row>();
}

export async function dryRunBacklog(now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  void now;
  const db = await database(databaseOverride);
  const rows = await db.prepare(`SELECT COUNT(*) AS count FROM report_runs r JOIN report_documents d ON d.run_id = r.id LEFT JOIN report_fact_manifests m ON m.run_id = r.id WHERE r.status IN ('complete', 'limited') AND NOT EXISTS (SELECT 1 FROM report_evaluations e WHERE e.run_id = r.id AND e.evaluation_type = 'report' AND e.evaluator_version = ?)`).bind(REPORT_AGENT_JUDGE_VERSION).all<Row>();
  const count = Number(rows.results?.[0]?.count || 0);
  return { count, nextBatch: Math.min(count, MAX_DISPATCHES) };
}

async function materializeBacklog(db: ApplicationDatabase, now: Date) {
  const rows = (await backlogRows(db, MAX_DISPATCHES)).results || [];
  if (!rows.length) return 0;
  const model = process.env.MARKET_SIGNAL_EVALUATOR_MODEL || REPORT_AGENT_DEFAULT_MODEL;
  const reservation = reserveReportAgentCost(model);
  const statements = [];
  for (const row of rows) {
    const inputHash = await sha256(text(row.document_json));
    const complete = row.manifest_status === "complete" && HASH.test(text(row.manifest_hash));
    const status = complete ? "pending" : "insufficient_facts";
    statements.push(db.prepare(`INSERT INTO report_evaluations (id, run_id, evaluation_type, input_hash, fact_manifest_hash, evaluator_version, rubric_version, status, rating_basis, model, prompt_version, pricing_version, evaluated_at, max_input_tokens, max_output_tokens, reserved_cost_microusd, error_code, created_at, completed_at) VALUES (?, ?, 'report', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, input_hash, evaluator_version, evaluation_type) DO NOTHING`).bind(
      crypto.randomUUID(), row.run_id, inputHash, complete ? text(row.manifest_hash) : "", REPORT_AGENT_JUDGE_VERSION, REPORT_AGENT_RUBRIC_VERSION, status,
      model, REPORT_AGENT_PROMPT_VERSION, reservation.accepted ? REPORT_AGENT_PRICING_VERSION : "", now.toISOString(), REPORT_AGENT_LIMITS.reservedInputTokens,
      REPORT_AGENT_LIMITS.reservedOutputTokens, reservation.accepted ? reservation.costWithRegionalUpliftMicrousd : 0,
      complete ? (reservation.accepted ? "" : reservation.errorCode) : "incomplete-fact-manifest", now.toISOString(), complete ? "" : now.toISOString(),
    ));
  }
  await db.batch(statements);
  return rows.length;
}

function validEvaluationId(value: string) { return /^[A-Za-z0-9_-]{16,128}$/.test(value); }

export async function claimDispatches(limit: number, evaluationId?: string, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DISPATCHES) throw new Error("Invalid evaluation dispatch claim limit.");
  if (evaluationId !== undefined && !validEvaluationId(evaluationId)) throw new Error("Invalid evaluation id.");
  const db = await database(databaseOverride);
  await reconcileExpired(db, now);
  if (evaluationId === undefined) await materializeBacklog(db, now);
  const cutoff = new Date(now.getTime() - RECOVERY_AGE_MS).toISOString();
  const target = evaluationId === undefined ? "" : "AND id = ?";
  const selected = await db.prepare(`SELECT * FROM report_evaluations WHERE evaluation_type = 'report' AND ((status IN ('pending', 'dispatch_failed') AND (created_at <= ? OR id = ${evaluationId === undefined ? "''" : "?"})) OR (status = 'dispatching' AND lease_expires_at != '' AND lease_expires_at <= ? AND dispatch_transport_attempts < ${MAX_TRANSPORT_ATTEMPTS})) ${target} ORDER BY created_at, id LIMIT ${limit}`).bind(...(evaluationId === undefined ? [cutoff, now.toISOString()] : [cutoff, evaluationId, now.toISOString(), evaluationId])).all<Row>();
  const claims: ReportEvaluationPayload[] = [];
  for (const row of selected.results || []) {
    const oldGeneration = Number(row.dispatch_generation || 0);
    const sameGeneration = ["dispatching", "dispatch_failed"].includes(text(row.status)) && ["", "unknown"].includes(text(row.dispatch_outcome)) && oldGeneration > 0;
    const nextGeneration = sameGeneration ? oldGeneration : oldGeneration + 1;
    if (nextGeneration > MAX_DISPATCH_GENERATIONS) {
      await db.prepare(`UPDATE report_evaluations SET status = 'failed', rating_basis = 'none', error_code = 'evaluation-dispatch-exhausted', completed_at = ? WHERE id = ? AND status = ? AND lease_token = ? AND lease_generation = ? AND dispatch_generation = ? AND dispatch_outcome = ? AND dispatch_transport_attempts = ?`).bind(now.toISOString(), row.id, row.status, row.lease_token, row.lease_generation, oldGeneration, row.dispatch_outcome, row.dispatch_transport_attempts).run();
      continue;
    }
    const token = sameGeneration ? text(row.lease_token) : opaqueToken();
    const leaseGeneration = Number(row.lease_generation || 0) + 1;
    const updated = await db.prepare(`UPDATE report_evaluations SET status = 'dispatching', lease_token = ?, lease_generation = ?, lease_expires_at = ?, dispatch_generation = ?, dispatch_attempts = dispatch_attempts + ?, dispatch_transport_attempts = CASE WHEN ? THEN dispatch_transport_attempts ELSE 0 END, dispatch_outcome = '', trigger_run_id = CASE WHEN ? THEN trigger_run_id ELSE '' END WHERE id = ? AND status = ? AND lease_token = ? AND lease_generation = ? AND dispatch_generation = ? AND dispatch_outcome = ? AND dispatch_transport_attempts = ? RETURNING id, input_hash, fact_manifest_hash, evaluator_version, dispatch_generation, lease_token`).bind(token, leaseGeneration, isoAfter(now, DISPATCH_LEASE_MS), nextGeneration, sameGeneration ? 0 : 1, sameGeneration ? 1 : 0, sameGeneration ? 1 : 0, row.id, row.status, row.lease_token, row.lease_generation, oldGeneration, row.dispatch_outcome, row.dispatch_transport_attempts).all<Row>();
    const claimed = updated.results?.[0];
    if (!claimed) continue;
    claims.push({ contractVersion: "1", evaluationId: text(claimed.id), evaluatorVersion: text(claimed.evaluator_version), inputHash: text(claimed.input_hash), factManifestHash: text(claimed.fact_manifest_hash), dispatchGeneration: Number(claimed.dispatch_generation), dispatchToken: text(claimed.lease_token) });
  }
  return claims;
}

export async function acknowledgeDispatch(payloadInput: ReportEvaluationPayload, runId: string, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  void now;
  const payload = assertPayload(payloadInput);
  if (!runId || runId.length > 256 || /[\u0000-\u001f\u007f]/.test(runId)) throw new Error("Invalid Trigger run id.");
  const db = await database(databaseOverride);
  const row = await evaluation(db, payload.evaluationId);
  if (!row) return { accepted: false as const, state: "unavailable" };
  assertBinding(row, payload);
  if (!["dispatching", "profiling", "ready_for_judge", "judging", "complete", "agent_rejected", "insufficient_facts", "rubric_unavailable", "failed"].includes(text(row.status))) return stateResult(row);
  if (text(row.trigger_run_id) && text(row.trigger_run_id) !== runId) throw new Error("Trigger run acknowledgement conflicts with the persisted dispatch.");
  const updated = await db.prepare(`UPDATE report_evaluations SET trigger_run_id = ?, dispatch_outcome = 'accepted' WHERE id = ? AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? AND lease_token = ? AND (trigger_run_id = '' OR trigger_run_id = ?) RETURNING status`).bind(runId, payload.evaluationId, payload.inputHash, payload.factManifestHash, payload.evaluatorVersion, payload.dispatchGeneration, payload.dispatchToken, runId).all<Row>();
  if (!updated.results?.length) return stateResult((await evaluation(db, payload.evaluationId)) || row);
  return { accepted: true as const, state: text(updated.results[0].status) };
}

export async function markAmbiguousDispatch(payloadInput: ReportEvaluationPayload, now = new Date(), databaseOverride?: ApplicationDatabase | null) {
  const payload = assertPayload(payloadInput);
  const db = await database(databaseOverride);
  const row = await evaluation(db, payload.evaluationId);
  if (!row) return { accepted: false as const, state: "unavailable" };
  assertBinding(row, payload);
  if (row.status !== "dispatching") return stateResult(row);
  const nextAttempts = Number(row.dispatch_transport_attempts || 0) + 1;
  const exhausted = nextAttempts >= MAX_TRANSPORT_ATTEMPTS;
  const updated = await db.prepare(`UPDATE report_evaluations SET dispatch_transport_attempts = ?, dispatch_outcome = 'unknown', status = ?, error_code = ?, completed_at = ? WHERE id = ? AND status = 'dispatching' AND input_hash = ? AND fact_manifest_hash = ? AND evaluator_version = ? AND dispatch_generation = ? AND lease_token = ? AND dispatch_transport_attempts = ? RETURNING status`).bind(nextAttempts, exhausted ? "failed" : "dispatching", exhausted ? "evaluation-dispatch-transport-exhausted" : "", exhausted ? now.toISOString() : "", payload.evaluationId, payload.inputHash, payload.factManifestHash, payload.evaluatorVersion, payload.dispatchGeneration, payload.dispatchToken, row.dispatch_transport_attempts).all<Row>();
  if (!updated.results?.length) return stateResult((await evaluation(db, payload.evaluationId)) || row);
  return { accepted: true as const, state: text(updated.results[0].status), transportAttempts: nextAttempts };
}

export type { ReportAgentPacket, AgentJudgeOutput };
