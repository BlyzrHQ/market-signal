export const REPORT_FEEDBACK_CONSUMER = "codex-task-feedback-v1" as const;
export const REPORT_FEEDBACK_MAX_CLAIM_ITEMS = 3;
export const REPORT_FEEDBACK_LEASE_SECONDS = 300;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class ReportFeedbackContractError extends Error {
  constructor(message = "The evaluation feedback request is invalid.") {
    super(message);
    this.name = "ReportFeedbackContractError";
  }
}

function closedRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportFeedbackContractError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) throw new ReportFeedbackContractError();
  return record;
}

export function parseFeedbackClaim(value: unknown) {
  const input = closedRecord(value, ["action", "consumer"]);
  if (input.action !== "claim" || input.consumer !== REPORT_FEEDBACK_CONSUMER) throw new ReportFeedbackContractError();
  return { action: "claim" as const, consumer: REPORT_FEEDBACK_CONSUMER };
}

export function parseFeedbackAck(value: unknown) {
  const input = closedRecord(value, ["action", "consumer", "deliveryId", "leaseId", "payloadHash", "idempotencyKey"]);
  if (input.action !== "acknowledge" || input.consumer !== REPORT_FEEDBACK_CONSUMER) throw new ReportFeedbackContractError();
  for (const field of ["deliveryId", "leaseId", "idempotencyKey"] as const) {
    if (typeof input[field] !== "string" || !ID_PATTERN.test(input[field])) throw new ReportFeedbackContractError();
  }
  if (typeof input.payloadHash !== "string" || !HASH_PATTERN.test(input.payloadHash)) throw new ReportFeedbackContractError();
  return {
    action: "acknowledge" as const,
    consumer: REPORT_FEEDBACK_CONSUMER,
    deliveryId: input.deliveryId as string,
    leaseId: input.leaseId as string,
    payloadHash: input.payloadHash,
    idempotencyKey: input.idempotencyKey as string,
  };
}
