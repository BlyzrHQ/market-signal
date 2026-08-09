export const HUMAN_REVIEW_RESOLUTION_CODES = ["answered", "unable_to_determine", "invalid_question"] as const;
export type HumanReviewResolutionCode = typeof HUMAN_REVIEW_RESOLUTION_CODES[number];
export type HumanReviewResponseInput = {
  action: "respond";
  idempotencyKey: string;
  resolutionCode: HumanReviewResolutionCode;
  answerText: string;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export class HumanReviewContractError extends Error {
  constructor(message = "The human-review request is invalid.") {
    super(message);
    this.name = "HumanReviewContractError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseHumanReviewRequestId(value: unknown) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) throw new HumanReviewContractError("The human-review request identifier is invalid.");
  return value;
}

export function parseHumanReviewResponse(value: unknown): HumanReviewResponseInput {
  const input = record(value);
  const keys = ["action", "idempotencyKey", "resolutionCode", "answerText"] as const;
  if (!input || Object.keys(input).length !== keys.length || !keys.every((key) => Object.hasOwn(input, key)) || input.action !== "respond") throw new HumanReviewContractError("The human-review response is invalid.");
  if (typeof input.idempotencyKey !== "string" || !ID_PATTERN.test(input.idempotencyKey)) throw new HumanReviewContractError("The human-review idempotency key is invalid.");
  if (!HUMAN_REVIEW_RESOLUTION_CODES.includes(input.resolutionCode as HumanReviewResolutionCode)) throw new HumanReviewContractError("The human-review resolution code is invalid.");
  if (typeof input.answerText !== "string" || input.answerText.length > 1_000 || new TextEncoder().encode(input.answerText).byteLength > 4_000 || /[\uD800-\uDFFF]/u.test(input.answerText) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]|https?:\/\/|www\.|\[[^\]]*\]\(/iu.test(input.answerText)) throw new HumanReviewContractError("The human-review answer is invalid.");
  if (input.resolutionCode === "answered" ? !input.answerText.trim() : input.answerText !== "") throw new HumanReviewContractError("The human-review answer does not match its resolution code.");
  return input as HumanReviewResponseInput;
}

export function encodeHumanReviewCursor(value: { queueSeq: number }) {
  const raw = String(value.queueSeq);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function parseHumanReviewCursor(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HumanReviewContractError("The human-review cursor is invalid.");
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = atob(padded);
    if (!/^[1-9]\d{0,15}$/.test(decoded)) throw new Error("invalid");
    const queueSeq = Number(decoded);
    if (!Number.isSafeInteger(queueSeq)) throw new Error("invalid");
    return { queueSeq };
  } catch (error) {
    if (error instanceof HumanReviewContractError) throw error;
    throw new HumanReviewContractError("The human-review cursor is invalid.");
  }
}
