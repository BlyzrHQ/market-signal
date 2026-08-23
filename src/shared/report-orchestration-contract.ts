export const REPORT_ORCHESTRATION_CONTRACT_VERSION = "6" as const;
export const MAX_REPORT_MATCH_CHECKPOINTS_PER_ATTEMPT = 4_000;
export const MAX_REPORT_ATTEMPTS = 20;

export type ReportOrchestrationPayload = {
  contractVersion: "3" | "4" | "5" | typeof REPORT_ORCHESTRATION_CONTRACT_VERSION;
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
  reportAttempt: number;
  productPlan: "starter" | "solo" | "growth" | "agency";
  productLimit: number;
};

export type ReportOrchestrationWirePayload = Omit<ReportOrchestrationPayload, "contractVersion"> & {
  contractVersion: ReportOrchestrationPayload["contractVersion"];
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
const VERSION_4_PLAN_LIMITS = { starter: 20, solo: 20, growth: 20, agency: 20 } as const;
const VERSION_3_PLAN_LIMITS = { starter: 20, solo: 50, growth: 500, agency: 1_000 } as const;
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
  const version2 = input.contractVersion === "2" && JSON.stringify(Object.keys(input).sort()) === JSON.stringify(LEGACY_KEYS);
  const version3 = input.contractVersion === "3" && JSON.stringify(Object.keys(input).sort()) === JSON.stringify(KEYS);
  const version4 = input.contractVersion === "4" && JSON.stringify(Object.keys(input).sort()) === JSON.stringify(KEYS);
  const version5 = input.contractVersion === "5" && JSON.stringify(Object.keys(input).sort()) === JSON.stringify(KEYS);
  if (!version2 && JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(KEYS)) throw new PermanentOrchestrationError("Report orchestration payload contains unsupported fields.");
  if (!version2 && !version3 && !version4 && !version5 && input.contractVersion !== REPORT_ORCHESTRATION_CONTRACT_VERSION) throw new PermanentOrchestrationError("Unsupported report orchestration contract version.");
  if (typeof input.publicId !== "string" || !PUBLIC_ID_PATTERN.test(input.publicId)) throw new PermanentOrchestrationError("Invalid report id.");
  if (typeof input.primaryDomain !== "string" || input.primaryDomain !== input.primaryDomain.trim().toLowerCase() || !DOMAIN_PATTERN.test(input.primaryDomain)) {
    throw new PermanentOrchestrationError("primaryDomain must be a canonical public hostname.");
  }
  if (input.locale !== "en" && input.locale !== "ar") throw new PermanentOrchestrationError("Unsupported report locale.");
  if (!Number.isInteger(input.reportAttempt) || Number(input.reportAttempt) < 1 || Number(input.reportAttempt) > MAX_REPORT_ATTEMPTS) throw new PermanentOrchestrationError("Invalid report attempt.");
  if (!version2 && !(typeof input.productPlan === "string" && input.productPlan in PLAN_LIMITS)) throw new PermanentOrchestrationError("Invalid product plan.");
  if (version3 && input.productLimit !== VERSION_3_PLAN_LIMITS[input.productPlan as keyof typeof VERSION_3_PLAN_LIMITS]) throw new PermanentOrchestrationError("Product limit does not match the persisted plan.");
  if (version4 && input.productLimit !== VERSION_4_PLAN_LIMITS[input.productPlan as keyof typeof VERSION_4_PLAN_LIMITS]) throw new PermanentOrchestrationError("Product limit does not match the persisted plan.");
  if (!version2 && !version3 && !version4 && input.productLimit !== PLAN_LIMITS[input.productPlan as keyof typeof PLAN_LIMITS]) throw new PermanentOrchestrationError("Product limit does not match the persisted plan.");
  return version2
    ? { ...input, contractVersion: "4", productPlan: "starter", productLimit: 20 } as ReportOrchestrationPayload
    : input as ReportOrchestrationPayload;
}

export type PublishedResultTargetKind = "primary-products" | "pairs";

export function reportOrchestrationWireVersion(productPlan: keyof typeof PLAN_LIMITS, productLimit: number, targetKind: PublishedResultTargetKind = "pairs") {
  if (targetKind === "pairs" && productLimit === PLAN_LIMITS[productPlan]) return REPORT_ORCHESTRATION_CONTRACT_VERSION;
  if (targetKind === "primary-products" && productLimit === VERSION_4_PLAN_LIMITS[productPlan]) return "4" as const;
  if (targetKind === "primary-products" && productLimit === VERSION_3_PLAN_LIMITS[productPlan]) return "3" as const;
  throw new PermanentOrchestrationError("Product limit does not match the persisted plan.");
}
