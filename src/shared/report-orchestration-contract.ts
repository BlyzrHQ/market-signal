export const REPORT_ORCHESTRATION_CONTRACT_VERSION = "3" as const;

export type ReportOrchestrationPayload = {
  contractVersion: typeof REPORT_ORCHESTRATION_CONTRACT_VERSION;
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  reportAttempt: number;
  productPlan: "starter" | "solo" | "growth" | "agency";
  productLimit: number;
};

export type ReportOrchestrationSummary = {
  ok: true;
  contractVersion: typeof REPORT_ORCHESTRATION_CONTRACT_VERSION;
  publicId: string;
  reportStatus: "complete" | "limited";
  completedPhases: string[];
  limitedPhases: string[];
  startedAt: string;
  finishedAt: string;
};

const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PLAN_LIMITS = { starter: 20, solo: 50, growth: 500, agency: 1_000 } as const;
const KEYS = ["contractVersion", "locale", "primaryDomain", "productLimit", "productPlan", "publicId", "reportAttempt"].sort();
const LEGACY_KEYS = ["contractVersion", "locale", "primaryDomain", "publicId", "reportAttempt"].sort();

export class PermanentOrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentOrchestrationError";
  }
}

export function parseReportOrchestrationPayload(value: unknown): ReportOrchestrationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PermanentOrchestrationError("Invalid report orchestration payload.");
  const input = value as Record<string, unknown>;
  const legacy = input.contractVersion === "2" && JSON.stringify(Object.keys(input).sort()) === JSON.stringify(LEGACY_KEYS);
  if (!legacy && JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(KEYS)) throw new PermanentOrchestrationError("Report orchestration payload contains unsupported fields.");
  if (!legacy && input.contractVersion !== REPORT_ORCHESTRATION_CONTRACT_VERSION) throw new PermanentOrchestrationError("Unsupported report orchestration contract version.");
  if (typeof input.publicId !== "string" || !PUBLIC_ID_PATTERN.test(input.publicId)) throw new PermanentOrchestrationError("Invalid report id.");
  if (typeof input.primaryDomain !== "string" || input.primaryDomain !== input.primaryDomain.trim().toLowerCase() || !DOMAIN_PATTERN.test(input.primaryDomain)) {
    throw new PermanentOrchestrationError("primaryDomain must be a canonical public hostname.");
  }
  if (input.locale !== "en" && input.locale !== "ar") throw new PermanentOrchestrationError("Unsupported report locale.");
  if (!Number.isInteger(input.reportAttempt) || Number(input.reportAttempt) < 1) throw new PermanentOrchestrationError("Invalid report attempt.");
  if (!legacy && !(typeof input.productPlan === "string" && input.productPlan in PLAN_LIMITS)) throw new PermanentOrchestrationError("Invalid product plan.");
  if (!legacy && input.productLimit !== PLAN_LIMITS[input.productPlan as keyof typeof PLAN_LIMITS]) throw new PermanentOrchestrationError("Product limit does not match the persisted plan.");
  return legacy
    ? { ...input, contractVersion: REPORT_ORCHESTRATION_CONTRACT_VERSION, productPlan: "starter", productLimit: 20 } as ReportOrchestrationPayload
    : input as ReportOrchestrationPayload;
}
