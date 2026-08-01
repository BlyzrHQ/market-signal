export const REPORT_EVALUATION_CONTRACT_VERSION = "1" as const;
export const REPORT_EVALUATION_TASK_ID = "market-signal-report-evaluation" as const;
export const REPORT_EVALUATION_IDEMPOTENCY_TTL = "90d" as const;

export const REPORT_EVALUATION_CAPABILITIES = [
  "report.evaluation.lease",
  "report.evaluation.prepare",
  "report.evaluation.judging",
  "report.evaluation.result",
  "report.evaluation.dispatch",
] as const;

export type ReportEvaluationPayload = {
  contractVersion: typeof REPORT_EVALUATION_CONTRACT_VERSION;
  evaluationId: string;
  evaluatorVersion: string;
  inputHash: string;
  factManifestHash: string;
  dispatchGeneration: number;
  dispatchToken: string;
};

const PAYLOAD_KEYS = [
  "contractVersion",
  "dispatchGeneration",
  "dispatchToken",
  "evaluationId",
  "evaluatorVersion",
  "factManifestHash",
  "inputHash",
].sort();
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class ReportEvaluationContractError extends Error {
  constructor(message = "Invalid report evaluation dispatch payload.") {
    super(message);
    this.name = "ReportEvaluationContractError";
  }
}

export function parseReportEvaluationId(value: unknown) {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) throw new ReportEvaluationContractError("Invalid evaluation id.");
  return value;
}

export function parseReportEvaluationPayload(value: unknown): ReportEvaluationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportEvaluationContractError();
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key, index) => key !== PAYLOAD_KEYS[index])) {
    throw new ReportEvaluationContractError("Report evaluation dispatch payload contains unsupported fields.");
  }
  if (input.contractVersion !== REPORT_EVALUATION_CONTRACT_VERSION) throw new ReportEvaluationContractError("Unsupported report evaluation contract version.");
  parseReportEvaluationId(input.evaluationId);
  if (typeof input.evaluatorVersion !== "string" || !VERSION_PATTERN.test(input.evaluatorVersion)) throw new ReportEvaluationContractError("Invalid evaluator version.");
  if (typeof input.inputHash !== "string" || !HASH_PATTERN.test(input.inputHash)) throw new ReportEvaluationContractError("Invalid evaluation input hash.");
  if (typeof input.factManifestHash !== "string" || !HASH_PATTERN.test(input.factManifestHash)) throw new ReportEvaluationContractError("Invalid fact manifest hash.");
  if (!Number.isInteger(input.dispatchGeneration) || Number(input.dispatchGeneration) < 1 || Number(input.dispatchGeneration) > 3) {
    throw new ReportEvaluationContractError("Invalid dispatch generation.");
  }
  if (typeof input.dispatchToken !== "string" || input.dispatchToken.length < 32 || input.dispatchToken.length > 256 || /\s/.test(input.dispatchToken)) {
    throw new ReportEvaluationContractError("Invalid dispatch token.");
  }
  return input as ReportEvaluationPayload;
}

export function reportEvaluationIdempotencyKey(payload: Pick<ReportEvaluationPayload, "evaluationId" | "evaluatorVersion" | "dispatchGeneration">) {
  return `evaluation:${payload.evaluationId}:${payload.evaluatorVersion}:${payload.dispatchGeneration}`;
}
