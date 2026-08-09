import { hasValidOwnerAuthorization, type OwnerAuthorizationOverrides, unauthorizedInternalResponse } from "../../../lib/internal-auth.ts";
import { listHumanReviewRequests } from "../../../lib/report-store.ts";
import { encodeHumanReviewCursor, HumanReviewContractError, parseHumanReviewCursor } from "../../../../src/shared/report-human-review-contract.ts";

type QueueServices = { list: typeof listHumanReviewRequests };
const liveServices: QueueServices = { list: listHumanReviewRequests };

function failure(error: unknown) {
  const contract = error instanceof HumanReviewContractError || (error instanceof Error && /^Invalid human-review queue/.test(error.message));
  return Response.json({ ok: false, error: contract ? error.message : "The human-review queue is unavailable." }, { status: contract ? 400 : 503, headers: { "Cache-Control": "no-store" } });
}

export function createHumanReviewQueueHandler(services: QueueServices = liveServices, expectedTokens?: OwnerAuthorizationOverrides) {
  return async function get(request: Request) {
    if (!await hasValidOwnerAuthorization(request.headers.get("authorization"), "read", expectedTokens)) return unauthorizedInternalResponse();
    try {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some((key) => !["limit", "cursor"].includes(key))) throw new HumanReviewContractError("The human-review query is invalid.");
      const limitText = url.searchParams.get("limit") || "20";
      if (!/^\d{1,2}$/.test(limitText)) throw new HumanReviewContractError("The human-review limit is invalid.");
      const limit = Number(limitText);
      if (limit < 1 || limit > 50) throw new HumanReviewContractError("The human-review limit is invalid.");
      const cursor = parseHumanReviewCursor(url.searchParams.get("cursor"));
      const result = await services.list({ limit, afterQueueSeq: cursor?.queueSeq });
      return Response.json({ ok: true, items: result.items, nextCursor: result.nextCursor ? encodeHumanReviewCursor(result.nextCursor) : null }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return failure(error); }
  };
}

export const GET = createHumanReviewQueueHandler();
