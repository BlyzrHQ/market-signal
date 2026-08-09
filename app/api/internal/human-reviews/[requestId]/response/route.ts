import { hasValidOwnerAuthorization, type OwnerAuthorizationOverrides, unauthorizedInternalResponse } from "../../../../../lib/internal-auth.ts";
import { ReportEvaluationStateError, submitHumanReviewResponse } from "../../../../../lib/report-store.ts";
import { HumanReviewContractError, parseHumanReviewRequestId, parseHumanReviewResponse } from "../../../../../../src/shared/report-human-review-contract.ts";

type RouteContext = { params: Promise<{ requestId: string }> | { requestId: string } };
type ResponseServices = { respond: typeof submitHumanReviewResponse };
const liveServices: ResponseServices = { respond: submitHumanReviewResponse };
const MAX_BODY_BYTES = 4_096;

async function requestBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HumanReviewContractError("The human-review response body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new HumanReviewContractError("The human-review response body is too large.");
  try { return parseHumanReviewResponse(JSON.parse(text) as unknown); } catch (error) {
    if (error instanceof HumanReviewContractError) throw error;
    throw new HumanReviewContractError("Invalid human-review response JSON.");
  }
}

function failure(error: unknown) {
  const status = error instanceof ReportEvaluationStateError ? error.httpStatus : error instanceof HumanReviewContractError ? 400 : 503;
  const code = error instanceof ReportEvaluationStateError ? error.code : error instanceof HumanReviewContractError ? "human-review-contract-invalid" : "human-review-unavailable";
  const message = error instanceof ReportEvaluationStateError || error instanceof HumanReviewContractError ? error.message : "The human-review response is unavailable.";
  return Response.json({ ok: false, error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export function createHumanReviewResponseHandler(services: ResponseServices = liveServices, expectedTokens?: OwnerAuthorizationOverrides) {
  return async function put(request: Request, context: RouteContext) {
    if (!await hasValidOwnerAuthorization(request.headers.get("authorization"), "write", expectedTokens)) return unauthorizedInternalResponse();
    try {
      const requestId = parseHumanReviewRequestId((await context.params).requestId);
      const input = await requestBody(request);
      const result = await services.respond(requestId, input);
      return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return failure(error); }
  };
}

export const PUT = createHumanReviewResponseHandler();
