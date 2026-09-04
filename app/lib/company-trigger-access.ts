import { createHash, timingSafeEqual } from "node:crypto";

export const COMPANY_WORKSPACE_ID = "market-signal-company-internal-v1";
export const COMPANY_USER_ID = "market-signal-internal-agent-v1";
const TRIGGER_ORIGIN = "https://api.trigger.dev";
const KEY = /^tr_prod_sk_[A-Za-z0-9_-]{20,200}$/;

/** Only operator-registered keys may reach the remote verification endpoint. */
export async function verifyCompanyTriggerKey(
  token: string,
  environment: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const projectRef = environment.MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_REF?.trim() || "";
  const projectId = environment.MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_ID?.trim() || "";
  const fingerprints = (environment.MARKET_SIGNAL_INTERNAL_TRIGGER_KEY_SHA256 || "").split(",").map((value) => value.trim());
  if (!KEY.test(token) || !/^proj_[A-Za-z0-9]+$/.test(projectRef) || !/^[A-Za-z0-9_-]{5,100}$/.test(projectId)
    || fingerprints.length > 32 || !fingerprints.every((value) => /^[a-f0-9]{64}$/.test(value))) return false;
  const digest = createHash("sha256").update(token).digest();
  if (!fingerprints.some((value) => timingSafeEqual(digest, Buffer.from(value, "hex")))) return false;
  try {
    const response = await fetchImpl(`${TRIGGER_ORIGIN}/api/v1/projects/${projectRef}/prod`, {
      method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); return false; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); return false; }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // Bootstrap echoes the presented key. Never persist or return this body.
    return body?.projectId === projectId && body?.apiUrl === TRIGGER_ORIGIN && body?.apiKey === token;
  } catch {
    // Upstream errors can contain secrets: expose only a boolean.
    return false;
  }
}
