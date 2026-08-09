import { hasValidMonitorAuthorization, type MonitorAuthorizationOverrides, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";
import { claimEvaluationFeedback } from "../../../../lib/report-store.ts";
import { parseFeedbackClaim, ReportFeedbackContractError } from "../../../../../src/shared/report-feedback-contract.ts";

type Services = { claim: typeof claimEvaluationFeedback };
const liveServices: Services = { claim: claimEvaluationFeedback };
const MAX_BODY_BYTES = 512;

async function body(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_BODY_BYTES)) throw new ReportFeedbackContractError("The feedback claim body is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new ReportFeedbackContractError("The feedback claim body is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return parseFeedbackClaim(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); }
  catch (error) { if (error instanceof ReportFeedbackContractError) throw error; throw new ReportFeedbackContractError("Invalid feedback claim JSON."); }
}

export function createEvaluationFeedbackClaimHandler(services: Services = liveServices, tokens?: MonitorAuthorizationOverrides) {
  return async function post(request: Request) {
    if (!await hasValidMonitorAuthorization(request.headers.get("authorization"), "read", tokens)) return unauthorizedInternalResponse();
    try {
      await body(request);
      const result = await services.claim();
      return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const contract = error instanceof ReportFeedbackContractError;
      return Response.json({ ok: false, code: contract ? "evaluation-feedback-contract-invalid" : "evaluation-feedback-unavailable", error: contract ? error.message : "Evaluation feedback is unavailable." }, { status: contract ? 400 : 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const POST = createEvaluationFeedbackClaimHandler();
