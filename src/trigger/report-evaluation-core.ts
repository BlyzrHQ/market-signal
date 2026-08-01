import {
  buildReportAgentJudgeRequest,
  buildReportAgentPacket,
  canonicalReportAgentJSON,
  computeHybridReportScore,
  parseReportAgentJudgeResponse,
  type JudgeUsage,
  type ReportAgentPacket,
} from "../../app/lib/report-agent-judge.ts";
import {
  REPORT_EVALUATION_IDEMPOTENCY_TTL,
  parseReportEvaluationId,
  parseReportEvaluationPayload,
  reportEvaluationIdempotencyKey,
  type ReportEvaluationPayload,
} from "../shared/report-evaluation-contract.ts";

export const MAX_RECOVERY_DISPATCHES = 25;

export type EvaluationLease = ReportEvaluationPayload & {
  leaseToken: string;
  leaseGeneration: number;
};

export type PreparedEvaluation = {
  model: string;
  packetHash: string;
  packet: ReportAgentPacket;
  deterministicProfile: unknown;
};

export type EvaluationWorkerPort = {
  preflight(): Promise<void>;
  lease(payload: ReportEvaluationPayload): Promise<{ accepted: true; leaseToken: string; leaseGeneration: number } | { accepted: false; state: string }>;
  prepare(lease: EvaluationLease): Promise<{ accepted: true; prepared: PreparedEvaluation } | { accepted: false; state: string }>;
  beginJudging(lease: EvaluationLease, packetHash: string): Promise<{ accepted: boolean; state: string }>;
  requestJudge(input: { body: unknown; timeoutMs: number; responseByteLimit: number }): Promise<unknown>;
  commitAccepted(input: {
    lease: EvaluationLease;
    packetHash: string;
    model: string;
    judge: unknown;
    hybrid: unknown;
    usage: JudgeUsage;
  }): Promise<void>;
  commitRejected(input: {
    lease: EvaluationLease;
    packetHash: string;
    phase: "ready_for_judge" | "judging";
    errorCode: string;
    usage?: JudgeUsage;
  }): Promise<void>;
};

export type EvaluationDispatchPort = {
  preflight(): Promise<void>;
  claim(limit: number, evaluationId?: string): Promise<unknown[]>;
  acknowledge(payload: ReportEvaluationPayload, runId: string): Promise<void>;
  ambiguous(payload: ReportEvaluationPayload): Promise<void>;
};

export type EvaluationTriggerPort = {
  trigger(payload: ReportEvaluationPayload, options: { idempotencyKey: string; idempotencyKeyTTL: "90d" }): Promise<{ id: string }>;
};

function validLeaseToken(value: string) {
  return value.length >= 32 && value.length <= 256 && !/\s/.test(value);
}

function createLease(payload: ReportEvaluationPayload, result: { leaseToken: string; leaseGeneration: number }): EvaluationLease {
  if (!validLeaseToken(result.leaseToken) || !Number.isInteger(result.leaseGeneration) || result.leaseGeneration < 1) {
    throw new Error("The evaluation worker API returned an invalid lease.");
  }
  return { ...payload, leaseToken: result.leaseToken, leaseGeneration: result.leaseGeneration };
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rejectPrepared(port: EvaluationWorkerPort, lease: EvaluationLease, packetHash: string, errorCode: string) {
  await port.commitRejected({ lease, packetHash, phase: "ready_for_judge", errorCode });
  return { ok: true as const, state: "agent_rejected" as const, errorCode };
}

export async function evaluateReport(rawPayload: unknown, port: EvaluationWorkerPort) {
  const payload = parseReportEvaluationPayload(rawPayload);
  await port.preflight();
  const leased = await port.lease(payload);
  if ("state" in leased) return { ok: true as const, state: leased.state, replayed: true as const };
  const lease = createLease(payload, leased);
  const preparedResult = await port.prepare(lease);
  if ("state" in preparedResult) return { ok: true as const, state: preparedResult.state, replayed: true as const };
  const prepared = preparedResult.prepared;
  const packetJson = canonicalReportAgentJSON(prepared.packet);
  const calculatedPacketHash = await sha256Hex(packetJson);
  if (!/^[a-f0-9]{64}$/.test(prepared.packetHash) || calculatedPacketHash !== prepared.packetHash) {
    return rejectPrepared(port, lease, prepared.packetHash, "agent-packet-hash-conflict");
  }
  const rebuiltDeterministic = buildReportAgentPacket({ deterministicProfile: prepared.deterministicProfile }).packet.deterministic;
  if (canonicalReportAgentJSON(rebuiltDeterministic) !== canonicalReportAgentJSON(prepared.packet.deterministic)) {
    return rejectPrepared(port, lease, prepared.packetHash, "deterministic-profile-packet-conflict");
  }

  const request = buildReportAgentJudgeRequest({
    model: prepared.model,
    packet: { packet: prepared.packet, canonicalJson: packetJson, byteLength: new TextEncoder().encode(packetJson).byteLength },
  });
  if (!("request" in request)) return rejectPrepared(port, lease, prepared.packetHash, "errorCode" in request ? request.errorCode : "agent-request-rejected");

  const judging = await port.beginJudging(lease, prepared.packetHash);
  if (!judging.accepted) return { ok: true as const, state: judging.state, replayed: true as const };

  let response: unknown;
  try {
    response = await port.requestJudge({ body: request.request, timeoutMs: request.timeoutMs, responseByteLimit: request.responseByteLimit });
  } catch {
    await port.commitRejected({ lease, packetHash: prepared.packetHash, phase: "judging", errorCode: "agent-call-outcome-unknown" });
    return { ok: true as const, state: "agent_rejected" as const, errorCode: "agent-call-outcome-unknown" };
  }

  const parsed = parseReportAgentJudgeResponse(response, prepared.packet.evidence);
  if ("errorCode" in parsed) {
    await port.commitRejected({
      lease,
      packetHash: prepared.packetHash,
      phase: "judging",
      errorCode: parsed.errorCode,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    });
    return { ok: true as const, state: "agent_rejected" as const, errorCode: parsed.errorCode };
  }
  const hybrid = computeHybridReportScore({ deterministicProfile: prepared.deterministicProfile, judge: parsed.result });
  if (!hybrid.accepted) {
    await port.commitRejected({ lease, packetHash: prepared.packetHash, phase: "judging", errorCode: hybrid.errorCode, usage: parsed.usage });
    return { ok: true as const, state: "agent_rejected" as const, errorCode: hybrid.errorCode };
  }
  await port.commitAccepted({ lease, packetHash: prepared.packetHash, model: prepared.model, judge: parsed.result, hybrid, usage: parsed.usage });
  return { ok: true as const, state: "complete" as const, overallScore: hybrid.overallScore, grade: hybrid.grade };
}

export async function dispatchClaimedEvaluations(
  enabled: boolean,
  dispatchPort: EvaluationDispatchPort,
  triggerPort: EvaluationTriggerPort,
  options: { evaluationId?: string; limit?: number } = {},
) {
  if (!enabled) return { ok: true as const, enabled: false as const, claimed: 0, triggered: 0, ambiguous: 0 };
  const evaluationId = options.evaluationId === undefined ? undefined : parseReportEvaluationId(options.evaluationId);
  const limit = evaluationId === undefined ? (options.limit ?? MAX_RECOVERY_DISPATCHES) : 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECOVERY_DISPATCHES) throw new Error("Invalid evaluation dispatch claim limit.");
  await dispatchPort.preflight();
  const rawClaims = await dispatchPort.claim(limit, evaluationId);
  if (rawClaims.length > limit) throw new Error("The evaluation dispatch claim exceeded its bound.");
  let triggered = 0;
  let ambiguous = 0;
  for (const rawClaim of rawClaims) {
    const payload = parseReportEvaluationPayload(rawClaim);
    if (evaluationId !== undefined && payload.evaluationId !== evaluationId) throw new Error("The evaluation dispatch claim returned an unrelated evaluation.");
    try {
      const handle = await triggerPort.trigger(payload, {
        idempotencyKey: reportEvaluationIdempotencyKey(payload),
        idempotencyKeyTTL: REPORT_EVALUATION_IDEMPOTENCY_TTL,
      });
      if (!handle || typeof handle.id !== "string" || !handle.id || handle.id.length > 256) throw new Error("Invalid Trigger run handle.");
      await dispatchPort.acknowledge(payload, handle.id);
      triggered += 1;
    } catch {
      await dispatchPort.ambiguous(payload);
      ambiguous += 1;
    }
  }
  return { ok: true as const, enabled: true as const, claimed: rawClaims.length, triggered, ambiguous };
}

export async function recoverReportEvaluations(
  enabled: boolean,
  dispatchPort: EvaluationDispatchPort,
  triggerPort: EvaluationTriggerPort,
) {
  return dispatchClaimedEvaluations(enabled, dispatchPort, triggerPort, { limit: MAX_RECOVERY_DISPATCHES });
}
