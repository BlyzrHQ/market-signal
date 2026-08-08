import { completeReportAgentEvaluation, reserveReportAgentEvaluation } from "../../../../lib/report-store.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";
import { parseReportEvaluationReservationRequest, parseReportEvaluationTerminalCallback } from "../../../../../src/shared/report-evaluation-contract.ts";

type RouteContext = { params: Promise<{ evaluationId: string }> | { evaluationId: string } };
const MAX_BODY_BYTES = 128_000;

async function body(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("The evaluation callback body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("The evaluation callback body is too large.");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid evaluation callback.");
  return value as Record<string, unknown>;
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "The report evaluation callback failed.";
  const status = /not found/i.test(message) ? 404 : /immutable|binding conflicts|claimed by another|conflicted|stale/i.test(message) ? 409 : /invalid|too large|not eligible|not reserved/i.test(message) ? 400 : 503;
  return Response.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: RouteContext) {
  if (!await hasValidInternalAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
  try {
    const evaluationId = (await context.params).evaluationId;
    const input = await body(request);
    if (input.action === "reserve") {
      const reservationInput = parseReportEvaluationReservationRequest(input);
      const reservation = await reserveReportAgentEvaluation(evaluationId, {
        evaluatorVersion: reservationInput.evaluatorVersion,
        dispatchAttempt: reservationInput.dispatchAttempt,
        reservationOwner: reservationInput.reservationOwner,
        clientRequestId: reservationInput.clientRequestId,
      });
      return Response.json(reservation, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.action === "terminal") {
      const evaluation = await completeReportAgentEvaluation(evaluationId, parseReportEvaluationTerminalCallback(input));
      return Response.json({ ok: true, evaluation: { id: evaluation.id, status: evaluation.status } }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "Unknown evaluation callback action." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
