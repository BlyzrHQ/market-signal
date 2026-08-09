import { hasValidOwnerAuthorization, type OwnerAuthorizationOverrides, unauthorizedInternalResponse } from "../../../../../lib/internal-auth.ts";
import { ReportEvaluationStateError, submitHumanReviewResponse } from "../../../../../lib/report-store.ts";
import { HumanReviewContractError, parseHumanReviewRequestId, parseHumanReviewResponse } from "../../../../../../src/shared/report-human-review-contract.ts";

type RouteContext = { params: Promise<{ requestId: string }> | { requestId: string } };
type ResponseServices = { respond: typeof submitHumanReviewResponse };
const liveServices: ResponseServices = { respond: submitHumanReviewResponse };
const MAX_BODY_BYTES = 4_096;

async function requestBody(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) throw new HumanReviewContractError("The human-review response body is too large.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HumanReviewContractError("The human-review response body is too large.");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseHumanReviewResponse(JSON.parse(text) as unknown);
  } catch (error) {
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
