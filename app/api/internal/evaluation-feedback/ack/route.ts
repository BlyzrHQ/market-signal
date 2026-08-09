import { hasValidMonitorAuthorization, type MonitorAuthorizationOverrides, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";
import { acknowledgeEvaluationFeedback, ReportEvaluationStateError } from "../../../../lib/report-store.ts";
import { parseFeedbackAck, ReportFeedbackContractError } from "../../../../../src/shared/report-feedback-contract.ts";

type Services = { acknowledge: typeof acknowledgeEvaluationFeedback };
const liveServices: Services = { acknowledge: acknowledgeEvaluationFeedback };
const MAX_BODY_BYTES = 1_024;

async function body(request: Request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_BODY_BYTES)) throw new ReportFeedbackContractError("The feedback acknowledgement body is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new ReportFeedbackContractError("The feedback acknowledgement body is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return parseFeedbackAck(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); }
  catch (error) { if (error instanceof ReportFeedbackContractError) throw error; throw new ReportFeedbackContractError("Invalid feedback acknowledgement JSON."); }
}

export function createEvaluationFeedbackAckHandler(services: Services = liveServices, tokens?: MonitorAuthorizationOverrides) {
  return async function put(request: Request) {
    if (!await hasValidMonitorAuthorization(request.headers.get("authorization"), "acknowledge", tokens)) return unauthorizedInternalResponse();
    try {
      const input = await body(request);
      const result = await services.acknowledge(input);
      return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const contract = error instanceof ReportFeedbackContractError;
      const state = error instanceof ReportEvaluationStateError;
      const status = state ? error.httpStatus : contract ? 400 : 503;
      const code = state ? error.code : contract ? "evaluation-feedback-contract-invalid" : "evaluation-feedback-unavailable";
      const message = state || contract ? (error as Error).message : "Evaluation feedback is unavailable.";
      return Response.json({ ok: false, code, error: message }, { status, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const PUT = createEvaluationFeedbackAckHandler();
