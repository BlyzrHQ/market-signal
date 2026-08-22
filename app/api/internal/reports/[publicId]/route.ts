import {
  appendReportEvent,
  compactReportDocument,
  getStoredReport,
  markReportDispatched,
  markReportDispatchFailed,
  recoverInterruptedReport,
  loadReportMatchBatchCheckpoints,
  saveReportMatchBatchCheckpoint,
  saveReportFactChunk,
  finalizeReportFactManifest,
  saveReportDocument,
  beginReportEvaluationDispatch,
  markReportEvaluationDispatchFailed,
  beginReportSearchChallengeDispatch,
  createReportSearchChallenge,
  markReportSearchChallengeDispatchFailed,
  type ReportPhase,
  type ReportRunStatus,
  type StoredReportEvent,
} from "../../../../lib/report-store.ts";
import { hasValidInternalAuthorization, unauthorizedInternalResponse } from "../../../../lib/internal-auth.ts";
import { dispatchReportJob } from "../../../../lib/report-dispatch.ts";
import { dispatchReportEvaluation, reportEvaluationPilotEnabled } from "../../../../lib/report-evaluation-dispatch.ts";
import { dispatchReportSearchChallenge, reportSearchChallengeEnabled } from "../../../../lib/report-search-challenge-dispatch.ts";
import { settleTerminalReportReservation } from "../../../../lib/report-terminal-billing.ts";

type RouteContext = { params: Promise<{ publicId: string }> | { publicId: string } };
const MAX_INTERNAL_CALLBACK_BODY_BYTES = 1_500_000;
type StoredReport = NonNullable<Awaited<ReturnType<typeof getStoredReport>>>;
type InternalReportStore = {
  get(publicId: string): Promise<StoredReport | null>;
  append(publicId: string, input: Parameters<typeof appendReportEvent>[1]): Promise<unknown>;
  save(publicId: string, document: unknown, options: Parameters<typeof saveReportDocument>[2]): ReturnType<typeof saveReportDocument>;
  saveFactChunk(publicId: string, input: Parameters<typeof saveReportFactChunk>[1]): Promise<unknown>;
  finalizeFacts(publicId: string, input: Parameters<typeof finalizeReportFactManifest>[1]): Promise<unknown>;
  loadMatchBatchCheckpoints(publicId: string, input: Parameters<typeof loadReportMatchBatchCheckpoints>[1]): Promise<unknown>;
  saveMatchBatchCheckpoint(publicId: string, input: Parameters<typeof saveReportMatchBatchCheckpoint>[1]): Promise<unknown>;
};
type InternalRecoveryServices = {
  recover: typeof recoverInterruptedReport;
  dispatch: typeof dispatchReportJob;
  markDispatched: typeof markReportDispatched;
  markDispatchFailed: typeof markReportDispatchFailed;
};
type InternalTerminalServices = {
  settle(run: StoredReport["run"], status?: ReportRunStatus): Promise<unknown>;
};

const liveStore: InternalReportStore = {
  get: (id) => getStoredReport(id),
  append: (id, input) => appendReportEvent(id, input),
  save: (id, document, options) => saveReportDocument(id, document, options),
  saveFactChunk: (id, input) => saveReportFactChunk(id, input),
  finalizeFacts: (id, input) => finalizeReportFactManifest(id, input),
  loadMatchBatchCheckpoints: (id, input) => loadReportMatchBatchCheckpoints(id, input),
  saveMatchBatchCheckpoint: (id, input) => saveReportMatchBatchCheckpoint(id, input),
};
const liveRecovery: InternalRecoveryServices = {
  recover: recoverInterruptedReport,
  dispatch: dispatchReportJob,
  markDispatched: markReportDispatched,
  markDispatchFailed: markReportDispatchFailed,
};
const liveTerminal: InternalTerminalServices = { settle: (run, status) => settleTerminalReportReservation(run, status) };

async function publicId(context: RouteContext) {
  return (await context.params).publicId;
}

async function boundedRequestJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_INTERNAL_CALLBACK_BODY_BYTES) throw new Error("The internal callback body is too large.");
  if (!request.body) throw new Error("Invalid internal callback body.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let json = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INTERNAL_CALLBACK_BODY_BYTES) {
      await reader.cancel();
      throw new Error("The internal callback body is too large.");
    }
    json += decoder.decode(value, { stream: true });
  }
  try {
    const value = JSON.parse(json + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Invalid internal callback body.");
  }
}

function clean(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function eventReplayMatches(existing: StoredReportEvent, body: Record<string, unknown>) {
  return existing.phase === body.phase
    && existing.status === body.status
    && existing.message === clean(body.message, 280)
    && sameJson(existing.metadata, body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {});
}

function reportDocumentDomain(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).primaryDomain === "string"
    ? String((value as Record<string, unknown>).primaryDomain)
    : "";
}

function documentReplayMatches(report: StoredReport, body: Record<string, unknown>) {
  const requestedStatus = body.status === "limited" ? "limited" : "complete";
  if (!report.document || report.run.status !== requestedStatus) return false;
  if (reportDocumentDomain(report.document) !== report.run.primaryDomain || reportDocumentDomain(body.document) !== report.run.primaryDomain) return false;
  return sameJson(compactReportDocument(report.document), compactReportDocument(body.document));
}

function routeError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message) ? 404 : /conflict|different report fact manifest|immutable|already in progress|stale/i.test(message) ? 409 : /invalid|too large|terminal report|saved report document|only an?|incomplete|does not match|was not persisted|missing|required|references a product|belongs to another report|attribution|source|official platform/i.test(message) ? 400 : 503;
  return Response.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function createInternalReportHandlers(store: InternalReportStore, expectedToken?: string, recovery: InternalRecoveryServices = liveRecovery, terminal: InternalTerminalServices = liveTerminal) {
  return {
    async get(request: Request, context: RouteContext) {
      if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
      try {
        const report = await store.get(await publicId(context));
        if (!report) return Response.json({ ok: false, error: "Report not found." }, { status: 404 });
        await terminal.settle(report.run);
        return Response.json({ ok: true, report }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return routeError(error, "The persistent report could not be read.");
      }
    },
    async post(request: Request, context: RouteContext) {
      if (!await hasValidInternalAuthorization(request.headers.get("authorization"), expectedToken)) return unauthorizedInternalResponse();
      try {
        const body = await boundedRequestJson(request);
        const id = await publicId(context);
        const report = await store.get(id);
        if (!report) return Response.json({ ok: false, error: "Report not found." }, { status: 404 });
        if (body.action === "recover") {
          const replayableRecovery = report.run.status === "queued"
            && report.events.some((item) => item.idempotencyKey === `recovery-attempt-${report.run.attemptCount}`);
          if (report.run.status !== "interrupted" && !replayableRecovery) {
            return Response.json({ ok: false, error: "Only an interrupted report can be recovered." }, { status: 409 });
          }
          const recovered = replayableRecovery ? report.run : await recovery.recover(id);
          let job: Awaited<ReturnType<typeof dispatchReportJob>>;
          try {
            job = await recovery.dispatch(recovered);
          } catch {
            try { await recovery.markDispatchFailed(id); } catch { /* the recovery response still fails closed */ }
            return Response.json({ ok: false, error: "The recovered background report job could not be started." }, { status: 503 });
          }
          try { await recovery.markDispatched(id, job.runId); } catch { /* the accepted worker may already have moved the report to running */ }
          return Response.json({ ok: true, report: recovered, job: { dispatched: true, runId: job.runId }, replayed: replayableRecovery }, { status: 202 });
        }
        const attemptNumber = Number(body.attemptNumber);
        if (!Number.isInteger(attemptNumber) || attemptNumber < 1) return Response.json({ ok: false, error: "Invalid report callback attempt." }, { status: 400 });
        if (attemptNumber !== report.run.attemptCount) return Response.json({ ok: false, error: "The report callback attempt is stale." }, { status: 409 });
        if (body.action === "match-batch-checkpoints-load") {
          if (["complete", "limited", "failed", "interrupted"].includes(report.run.status)) return Response.json({ ok: false, error: "A terminal report cannot load report match batch checkpoints." }, { status: 409 });
          const batchIndex = body.batchIndex === undefined ? undefined : Number(body.batchIndex);
          const checkpoints = await store.loadMatchBatchCheckpoints(id, { attemptNumber, batchIndex });
          return Response.json({ ok: true, checkpoints }, { headers: { "Cache-Control": "no-store" } });
        }
        if (body.action === "match-batch-checkpoint-save") {
          if (["complete", "limited", "failed", "interrupted"].includes(report.run.status)) return Response.json({ ok: false, error: "A terminal report cannot accept report match batch checkpoints." }, { status: 409 });
          const saved = await store.saveMatchBatchCheckpoint(id, {
            attemptNumber,
            batchIndex: Number(body.batchIndex),
            inputHash: clean(body.inputHash, 64),
            result: body.result,
            resultHash: body.resultHash === undefined ? undefined : clean(body.resultHash, 64),
          });
          return Response.json({ ok: true, ...saved as Record<string, unknown> });
        }
        if (body.action === "event") {
          const key = clean(body.idempotencyKey, 120);
          const existing = report.events.find((item) => item.idempotencyKey === key);
          if (existing) {
            if (!eventReplayMatches(existing, body)) return Response.json({ ok: false, error: "The callback idempotency key conflicts with a different event." }, { status: 409 });
            await terminal.settle(report.run, report.run.status);
            return Response.json({ ok: true, event: existing, replayed: true });
          }
          if (["complete", "limited", "failed", "interrupted"].includes(report.run.status)) {
            return Response.json({ ok: false, error: "A terminal report cannot accept a new event." }, { status: 409 });
          }
          const event = await store.append(id, {
            attemptNumber,
            idempotencyKey: key,
            phase: body.phase as ReportPhase,
            status: body.status as ReportRunStatus,
            message: clean(body.message, 280),
            metadata: body.metadata,
            errorCode: clean(body.errorCode, 80),
          });
          const persisted = await store.get(id);
          if (!persisted) throw new Error("The updated report was not persisted.");
          await terminal.settle(persisted.run, persisted.run.status);
          return Response.json({ ok: true, event, replayed: false });
        }
        if (body.action === "fact-chunk") {
          const saved = await store.saveFactChunk(id, {
            attemptNumber,
            manifestId: clean(body.manifestId, 64),
            kind: body.kind as Parameters<typeof saveReportFactChunk>[1]["kind"],
            chunkIndex: Number(body.chunkIndex),
            chunkCount: Number(body.chunkCount),
            contentHash: clean(body.contentHash, 64),
            items: Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [],
          });
          return Response.json({ ok: true, saved });
        }
        if (body.action === "fact-manifest") {
          const saved = await store.finalizeFacts(id, {
            attemptNumber,
            manifestId: clean(body.manifestId, 64),
            manifestHash: clean(body.manifestHash, 64),
            counts: body.counts as Parameters<typeof finalizeReportFactManifest>[1]["counts"],
          });
          return Response.json({ ok: true, saved });
        }
        if (body.action === "document") {
          if (typeof body.expectedFactManifestHash !== "string") return Response.json({ ok: false, error: "The expected report fact manifest hash is required." }, { status: 400 });
          if (["complete", "limited"].includes(report.run.status)) {
            if (!documentReplayMatches(report, body)) return Response.json({ ok: false, error: "The completed report callback conflicts with the saved document." }, { status: 409 });
            await terminal.settle(report.run);
            return Response.json({ ok: true, saved: { publicId: id, status: report.run.status }, replayed: true });
          }
          if (["failed", "interrupted"].includes(report.run.status)) {
            return Response.json({ ok: false, error: "A failed or interrupted report cannot accept a document." }, { status: 409 });
          }
          const saved = await store.save(id, compactReportDocument(body.document), {
            attemptNumber,
            status: body.status === "limited" ? "limited" : "complete",
            observedAt: typeof body.observedAt === "string" ? body.observedAt : undefined,
            expectedFactManifestHash: body.expectedFactManifestHash,
          });
          const persisted = await store.get(id);
          if (!persisted) throw new Error("The completed report was not persisted.");
          await terminal.settle(persisted.run, persisted.run.status);
          if (saved.evaluation?.status === "deterministic" && await reportEvaluationPilotEnabled({ primaryDomain: report.run.primaryDomain, publicReportId: id })) {
            let payload: Awaited<ReturnType<typeof beginReportEvaluationDispatch>> | null = null;
            try {
              payload = await beginReportEvaluationDispatch(saved.evaluation.id);
              await dispatchReportEvaluation(payload);
            } catch {
              if (payload) await markReportEvaluationDispatchFailed(payload.evaluationId, payload.dispatchAttempt).catch(() => undefined);
              console.error("report evaluation dispatch failed", { stage: "evaluation-dispatch", diagnosticCode: "evaluation-dispatch-failed" });
            }
          }
          if (await reportSearchChallengeEnabled()) {
            let challengePayload: Awaited<ReturnType<typeof beginReportSearchChallengeDispatch>> | null = null;
            try {
              const challenge = await createReportSearchChallenge(id);
              if (challenge.status === "deterministic") {
                challengePayload = await beginReportSearchChallengeDispatch(challenge.id);
                await dispatchReportSearchChallenge(challengePayload);
              }
            } catch {
              if (challengePayload) await markReportSearchChallengeDispatchFailed(challengePayload.challengeId, challengePayload.dispatchAttempt).catch(() => undefined);
              console.error("report search challenge dispatch failed", { stage: "search-challenge-dispatch", diagnosticCode: "search-challenge-dispatch-failed" });
            }
          }
          return Response.json({ ok: true, saved, replayed: false });
        }
        return Response.json({ ok: false, error: "Unknown report persistence action." }, { status: 400 });
      } catch (error) {
        return routeError(error, "The persistent report could not be updated.");
      }
    },
  };
}

const handlers = createInternalReportHandlers(liveStore);
export const GET = handlers.get;
export const POST = handlers.post;
