import { runtimeEnvironmentValue } from "./runtime-env.ts";

const encoder = new TextEncoder();

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function fixedLengthEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

export async function hasValidInternalAuthorization(authorization: string | null, expectedOverride?: string) {
  const expected = await runtimeEnvironmentValue("MARKET_SIGNAL_CALLBACK_TOKEN", expectedOverride);
  return hasValidBearerAuthorization(authorization, expected);
}

export type OwnerAuthorizationOverrides = { read: string; write: string; callback: string };

export async function hasValidOwnerAuthorization(authorization: string | null, purpose: "read" | "write", overrides?: OwnerAuthorizationOverrides) {
  const [read, write, callback] = overrides
    ? [overrides.read, overrides.write, overrides.callback]
    : await Promise.all([
      runtimeEnvironmentValue("MARKET_SIGNAL_OWNER_READ_TOKEN"),
      runtimeEnvironmentValue("MARKET_SIGNAL_OWNER_WRITE_TOKEN"),
      runtimeEnvironmentValue("MARKET_SIGNAL_CALLBACK_TOKEN"),
    ]);
  const credentials = [read, write, callback];
  if (credentials.some((value) => value.length < 32 || /\s/.test(value)) || new Set(credentials).size !== credentials.length) return false;
  return hasValidBearerAuthorization(authorization, purpose === "read" ? read : write, 32);
}

async function hasValidBearerAuthorization(authorization: string | null, expected: string, minimumLength = 1) {
  const match = /^Bearer ([^\s]+)$/.exec(authorization || "");
  const supplied = match?.[1] || "invalid-callback-credential";
  const comparisonTarget = expected || "missing-server-callback-credential";
  const [suppliedDigest, expectedDigest] = await Promise.all([digest(supplied), digest(comparisonTarget)]);
  return Boolean(expected.length >= minimumLength && !/\s/.test(expected) && match && fixedLengthEqual(suppliedDigest, expectedDigest));
}

export function unauthorizedInternalResponse() {
  return Response.json({ ok: false, error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
