import { beginReportEvaluationDispatch, markReportEvaluationDispatchFailed, reconcileReportEvaluations } from "../../../../lib/report-store.ts";
import { dispatchReportEvaluation, reportEvaluationPilotEnabled } from "../../../../lib/report-evaluation-dispatch.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";

type RecoveryServices = {
  reconcile: typeof reconcileReportEvaluations;
  enabled: typeof reportEvaluationPilotEnabled;
  begin: typeof beginReportEvaluationDispatch;
  dispatch: typeof dispatchReportEvaluation;
  markFailed: typeof markReportEvaluationDispatchFailed;
};
const liveServices: RecoveryServices = { reconcile: reconcileReportEvaluations, enabled: reportEvaluationPilotEnabled, begin: beginReportEvaluationDispatch, dispatch: dispatchReportEvaluation, markFailed: markReportEvaluationDispatchFailed };

export function createReportEvaluationRecoveryHandler(services: RecoveryServices = liveServices, expectedToken?: string) {
  return async function post(request: Request) {
    if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
    try {
      const recovery = await services.reconcile();
      const enabled = await services.enabled();
      if (!enabled) return Response.json({ ok: true, enabled: false, candidates: recovery.candidates.length, dispatched: 0, failed: 0 }, { headers: { "Cache-Control": "no-store" } });
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
      return Response.json({ ok: true, enabled, candidates: recovery.candidates.length, dispatched, failed }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ ok: false, error: "Report evaluation recovery failed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export const POST = createReportEvaluationRecoveryHandler();
