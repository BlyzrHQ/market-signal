export const HEALTHCHECK_CONTRACT_VERSION = "1" as const;
export const TRIGGER_SDK_VERSION = "4.5.4" as const;

export type HealthcheckPayload = {
  nonce: string;
};

export type HealthcheckOutput = {
  ok: true;
  contractVersion: typeof HEALTHCHECK_CONTRACT_VERSION;
  nonce: string;
  sdkVersion: typeof TRIGGER_SDK_VERSION;
  observedAt: string;
};

function validNonce(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export function createHealthcheckOutput(
  payload: HealthcheckPayload,
  now: () => Date = () => new Date(),
): HealthcheckOutput {
  if (!validNonce(payload?.nonce)) {
    throw new Error("Healthcheck nonce must be 8-128 URL-safe characters.");
  }

  const observedAt = now().toISOString();
  return {
    ok: true,
    contractVersion: HEALTHCHECK_CONTRACT_VERSION,
    nonce: payload.nonce,
    sdkVersion: TRIGGER_SDK_VERSION,
    observedAt,
  };
}
