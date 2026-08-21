import { completeReportSearchChallenge, ReportEvaluationStateError, reserveReportSearchChallenge } from "../../../../lib/report-store.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";
import { parseReportSearchChallengeReservation, parseReportSearchChallengeTerminal, ReportSearchChallengeContractError } from "../../../../../src/shared/report-search-challenge-contract.ts";

type RouteContext = { params: Promise<{ challengeId: string }> | { challengeId: string } };
async function requestBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0); if (declared > 128_000) throw new ReportSearchChallengeContractError("The search challenge callback is too large.");
  const text = await request.text(); if (new TextEncoder().encode(text).byteLength > 128_000) throw new ReportSearchChallengeContractError("The search challenge callback is too large.");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new ReportSearchChallengeContractError("Invalid search challenge callback JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportSearchChallengeContractError(); return value as Record<string, unknown>;
}
export async function POST(request: Request, context: RouteContext) {
  if (!await hasValidInternalAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
  try {
    const challengeId = (await context.params).challengeId; const input = await requestBody(request);
    if (input.action === "reserve") { const parsed = parseReportSearchChallengeReservation(input); return Response.json(await reserveReportSearchChallenge(challengeId, { challengerVersion: parsed.challengerVersion, dispatchAttempt: parsed.dispatchAttempt, reservationOwner: parsed.reservationOwner, clientRequestId: parsed.clientRequestId }), { headers: { "Cache-Control": "no-store" } }); }
    if (input.action === "terminal") { const challenge = await completeReportSearchChallenge(challengeId, parseReportSearchChallengeTerminal(input)); return Response.json({ ok: true, challenge: { id: challenge.id, status: challenge.status } }, { headers: { "Cache-Control": "no-store" } }); }
    return Response.json({ ok: false, error: "Unknown search challenge callback action." }, { status: 400 });
  } catch (error) {
    const status = error instanceof ReportEvaluationStateError ? error.httpStatus : error instanceof ReportSearchChallengeContractError ? 400 : 503;
    const code = error instanceof ReportEvaluationStateError ? error.code : error instanceof ReportSearchChallengeContractError ? "search-challenge-contract-invalid" : "search-challenge-callback-failed";
    return Response.json({ ok: false, code, error: error instanceof Error ? error.message : "The search challenge callback failed." }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
