import { beginReportEvaluationDispatch, markReportEvaluationDispatchFailed, reconcileReportEvaluations } from "../../../../lib/report-store.ts";
import { dispatchReportEvaluation, reportEvaluationPilotEnabled } from "../../../../lib/report-evaluation-dispatch.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";

export async function POST(request: Request) {
  if (!await hasValidInternalAuthorization(request.headers.get("authorization"))) return unauthorizedInternalResponse();
  if (!await reportEvaluationPilotEnabled()) return Response.json({ ok: true, enabled: false, dispatched: 0 }, { headers: { "Cache-Control": "no-store" } });
  try {
    const recovery = await reconcileReportEvaluations();
    let dispatched = 0;
    let failed = 0;
    for (const evaluationId of recovery.candidates) {
      let payload: Awaited<ReturnType<typeof beginReportEvaluationDispatch>> | null = null;
      try {
        payload = await beginReportEvaluationDispatch(evaluationId);
        await dispatchReportEvaluation(payload);
        dispatched += 1;
      } catch {
        failed += 1;
        if (payload) await markReportEvaluationDispatchFailed(payload.evaluationId, payload.dispatchAttempt).catch(() => undefined);
      }
    }
    return Response.json({ ok: true, enabled: true, candidates: recovery.candidates.length, dispatched, failed }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "Report evaluation recovery failed." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
