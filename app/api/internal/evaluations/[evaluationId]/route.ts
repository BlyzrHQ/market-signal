import { completeReportAgentEvaluation, ReportEvaluationStateError, reserveReportAgentEvaluation } from "../../../../lib/report-store.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";
import { parseReportEvaluationReservationRequest, parseReportEvaluationTerminalCallback, ReportEvaluationContractError } from "../../../../../src/shared/report-evaluation-contract.ts";

type RouteContext = { params: Promise<{ evaluationId: string }> | { evaluationId: string } };
const MAX_BODY_BYTES = 128_000;
type EvaluationCallbackServices = {
  reserve: typeof reserveReportAgentEvaluation;
  complete: typeof completeReportAgentEvaluation;
};
const liveServices: EvaluationCallbackServices = { reserve: reserveReportAgentEvaluation, complete: completeReportAgentEvaluation };

async function body(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new ReportEvaluationContractError("The evaluation callback body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new ReportEvaluationContractError("The evaluation callback body is too large.");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new ReportEvaluationContractError("Invalid evaluation callback JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportEvaluationContractError("Invalid evaluation callback.");
  return value as Record<string, unknown>;
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "The report evaluation callback failed.";
  const status = error instanceof ReportEvaluationStateError ? error.httpStatus : error instanceof ReportEvaluationContractError ? 400 : 503;
  const code = error instanceof ReportEvaluationStateError ? error.code : error instanceof ReportEvaluationContractError ? "evaluation-contract-invalid" : "evaluation-callback-unavailable";
  return Response.json({ ok: false, error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export function createReportEvaluationCallbackHandler(services: EvaluationCallbackServices = liveServices, expectedToken?: string) {
  return async function post(request: Request, context: RouteContext) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    try {
      const evaluationId = (await context.params).evaluationId;
      const input = await body(request);
      if (input.action === "reserve") {
        const reservationInput = parseReportEvaluationReservationRequest(input);
        const reservation = await services.reserve(evaluationId, {
          evaluatorVersion: reservationInput.evaluatorVersion,
          dispatchAttempt: reservationInput.dispatchAttempt,
          reservationOwner: reservationInput.reservationOwner,
          clientRequestId: reservationInput.clientRequestId,
        });
        return Response.json(reservation, { headers: { "Cache-Control": "no-store" } });
      }
      if (input.action === "terminal") {
        const evaluation = await services.complete(evaluationId, parseReportEvaluationTerminalCallback(input));
        return Response.json({ ok: true, evaluation: { id: evaluation.id, status: evaluation.status } }, { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ ok: false, error: "Unknown evaluation callback action." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const POST = createReportEvaluationCallbackHandler();
