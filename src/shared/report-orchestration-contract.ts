export const REPORT_ORCHESTRATION_CONTRACT_VERSION = "1" as const;

export type ReportOrchestrationPayload = {
  contractVersion: typeof REPORT_ORCHESTRATION_CONTRACT_VERSION;
  publicId: string;
  primaryDomain: string;
  locale: "en" | "ar";
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
const KEYS = ["contractVersion", "locale", "primaryDomain", "publicId"].sort();

export class PermanentOrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentOrchestrationError";
  }
}

export function parseReportOrchestrationPayload(value: unknown): ReportOrchestrationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PermanentOrchestrationError("Invalid report orchestration payload.");
  const input = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(KEYS)) throw new PermanentOrchestrationError("Report orchestration payload contains unsupported fields.");
  if (input.contractVersion !== REPORT_ORCHESTRATION_CONTRACT_VERSION) throw new PermanentOrchestrationError("Unsupported report orchestration contract version.");
  if (typeof input.publicId !== "string" || !PUBLIC_ID_PATTERN.test(input.publicId)) throw new PermanentOrchestrationError("Invalid report id.");
  if (typeof input.primaryDomain !== "string" || input.primaryDomain !== input.primaryDomain.trim().toLowerCase() || !DOMAIN_PATTERN.test(input.primaryDomain)) {
    throw new PermanentOrchestrationError("primaryDomain must be a canonical public hostname.");
  }
  if (input.locale !== "en" && input.locale !== "ar") throw new PermanentOrchestrationError("Unsupported report locale.");
  return input as ReportOrchestrationPayload;
}
