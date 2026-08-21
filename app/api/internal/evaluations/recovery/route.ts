import { beginReportEvaluationDispatch, beginReportSearchChallengeDispatch, markReportEvaluationDispatchFailed, markReportSearchChallengeDispatchFailed, reconcileReportEvaluationStates, reconcileRequestedReportEvaluations, reconcileRequestedReportSearchChallenges } from "../../../../lib/report-store.ts";
import { dispatchReportEvaluation } from "../../../../lib/report-evaluation-dispatch.ts";
import { dispatchReportSearchChallenge, reportSearchChallengeEnabled } from "../../../../lib/report-search-challenge-dispatch.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";

type RecoveryServices = {
  watchdog: () => Promise<{ reconciled: true }>;
  reconcile: (publicReportIds: string[]) => Promise<{ candidates: string[] }>;
  begin: typeof beginReportEvaluationDispatch;
  dispatch: typeof dispatchReportEvaluation;
  markFailed: typeof markReportEvaluationDispatchFailed;
  reconcileSearch: typeof reconcileRequestedReportSearchChallenges;
  beginSearch: typeof beginReportSearchChallengeDispatch;
  dispatchSearch: typeof dispatchReportSearchChallenge;
  markSearchFailed: typeof markReportSearchChallengeDispatchFailed;
  searchEnabled: typeof reportSearchChallengeEnabled;
};
const liveServices: RecoveryServices = { watchdog: reconcileReportEvaluationStates, reconcile: reconcileRequestedReportEvaluations, begin: beginReportEvaluationDispatch, dispatch: dispatchReportEvaluation, markFailed: markReportEvaluationDispatchFailed, reconcileSearch: reconcileRequestedReportSearchChallenges, beginSearch: beginReportSearchChallengeDispatch, dispatchSearch: dispatchReportSearchChallenge, markSearchFailed: markReportSearchChallengeDispatchFailed, searchEnabled: reportSearchChallengeEnabled };

const PUBLIC_REPORT_ID = /^[a-f0-9]{32}$/;
const MAX_RECOVERY_BODY_BYTES = 512;

async function boundedRequestText(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RECOVERY_BODY_BYTES) {
        await reader.cancel();
        throw new Error("invalid-scope");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function recoveryScope(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_RECOVERY_BODY_BYTES) throw new Error("invalid-scope");
  const text = await boundedRequestText(request);
  if (!text.trim()) return null;
  const body = JSON.parse(text) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "publicReportIds")) throw new Error("invalid-scope");
  const publicReportIds = (body as { publicReportIds?: unknown }).publicReportIds;
  if (!Array.isArray(publicReportIds) || publicReportIds.length < 1 || publicReportIds.length > 3 || publicReportIds.some((id) => typeof id !== "string" || !PUBLIC_REPORT_ID.test(id))) throw new Error("invalid-scope");
  const unique = [...new Set(publicReportIds)];
  if (unique.length !== publicReportIds.length) throw new Error("invalid-scope");
  return unique;
}

export function createReportEvaluationRecoveryHandler(services: RecoveryServices = liveServices, expectedToken?: string) {
  return async function post(request: Request) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    try {
      const publicReportIds = await recoveryScope(request);
      if (!publicReportIds) {
        await services.watchdog();
        return Response.json({ ok: true, mode: "watchdog", dispatched: 0, failed: 0 }, { headers: { "Cache-Control": "no-store" } });
      }
      const recovery = await services.reconcile(publicReportIds);
      let dispatched = 0;
      let failed = 0;
      for (const evaluationId of recovery.candidates) {
        let payload: Awaited<ReturnType<typeof beginReportEvaluationDispatch>> | null = null;
        try {
          payload = await services.begin(evaluationId);
          await services.dispatch(payload);
          dispatched += 1;
        } catch {
          failed += 1;
          if (payload) await services.markFailed(payload.evaluationId, payload.dispatchAttempt).catch(() => undefined);
        }
      }
      let searchRecovery: { candidates: string[]; deferred?: string[]; skipped?: string[] } = { candidates: [] };
      let searchRecoveryFailed = false;
      if (await services.searchEnabled()) {
        try {
          searchRecovery = await services.reconcileSearch(publicReportIds);
        } catch {
          searchRecoveryFailed = true;
        }
      }
      let searchDispatched = 0;
      let searchFailed = 0;
      for (const challengeId of searchRecovery.candidates) {
        let payload: Awaited<ReturnType<typeof beginReportSearchChallengeDispatch>> | null = null;
        try {
          payload = await services.beginSearch(challengeId);
          await services.dispatchSearch(payload);
          searchDispatched += 1;
        } catch {
          searchFailed += 1;
          if (payload) await services.markSearchFailed(payload.challengeId, payload.dispatchAttempt).catch(() => undefined);
        }
      }
      return Response.json({ ok: true, requested: publicReportIds.length, candidates: recovery.candidates.length, dispatched, failed, searchCandidates: searchRecovery.candidates.length, searchDispatched, searchFailed, searchDeferred: searchRecovery.deferred?.length || 0, searchSkipped: searchRecovery.skipped?.length || 0, searchRecoveryFailed }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "invalid-scope")) return Response.json({ ok: false, error: "A bounded list of public report IDs is required." }, { status: 400, headers: { "Cache-Control": "no-store" } });
      return Response.json({ ok: false, error: "Report evaluation recovery failed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const POST = createReportEvaluationRecoveryHandler();
