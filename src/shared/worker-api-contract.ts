export const WORKER_API_SERVICE = "market-signal-worker-api" as const;
export const WORKER_API_PROTOCOL_VERSION = "1" as const;

export const REQUIRED_WORKER_API_CAPABILITIES = [
  "report.read",
  "report.event.append",
  "report.document.save",
  "crawl.execute",
  "ads.execute",
  "products.match",
  "products.enrich",
  "products.actions",
] as const;

export const REPORT_RETENTION_CAPABILITY = "report.retention.purge" as const;
export const REPORT_EVALUATION_CAPABILITY = "report.evaluation.execute" as const;

export const ADVERTISED_WORKER_API_CAPABILITIES = [
  ...REQUIRED_WORKER_API_CAPABILITIES,
  REPORT_RETENTION_CAPABILITY,
  REPORT_EVALUATION_CAPABILITY,
] as const;

export type RequiredWorkerApiCapability = typeof REQUIRED_WORKER_API_CAPABILITIES[number];

export type WorkerApiManifest = {
  ok: true;
  service: typeof WORKER_API_SERVICE;
  protocolVersion: typeof WORKER_API_PROTOCOL_VERSION;
  capabilities: string[];
  observedAt: string;
};

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

export class WorkerApiContractError extends Error {
  constructor() {
    super("The application worker API is incompatible.");
    this.name = "WorkerApiContractError";
  }
}

export function createWorkerApiManifest(now: () => Date = () => new Date()): WorkerApiManifest {
  return {
    ok: true,
    service: WORKER_API_SERVICE,
    protocolVersion: WORKER_API_PROTOCOL_VERSION,
    capabilities: [...ADVERTISED_WORKER_API_CAPABILITIES],
    observedAt: now().toISOString(),
  };
}

export function parseWorkerApiManifest(value: unknown): WorkerApiManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerApiContractError();
  const manifest = value as Record<string, unknown>;
  if (manifest.ok !== true || manifest.service !== WORKER_API_SERVICE || manifest.protocolVersion !== WORKER_API_PROTOCOL_VERSION) throw new WorkerApiContractError();
  const capabilities = manifest.capabilities;
  if (!Array.isArray(capabilities)
    || !capabilities.length
    || capabilities.some((capability) => typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability))
    || new Set(capabilities).size !== capabilities.length
    || REQUIRED_WORKER_API_CAPABILITIES.some((capability) => !capabilities.includes(capability))) throw new WorkerApiContractError();
  if (typeof manifest.observedAt !== "string" || !manifest.observedAt || !Number.isFinite(Date.parse(manifest.observedAt))) throw new WorkerApiContractError();
  try {
    if (new Date(manifest.observedAt).toISOString() !== manifest.observedAt) throw new WorkerApiContractError();
  } catch {
    throw new WorkerApiContractError();
  }
  return manifest as WorkerApiManifest;
}
