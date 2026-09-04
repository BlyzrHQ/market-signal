import { AbortTaskRunError, metadata, runs, task } from "@trigger.dev/sdk";
import { orchestrateValidatedReport } from "../trigger/report-orchestration-core.ts";
import { PermanentOrchestrationError } from "../shared/report-orchestration-contract.ts";
import { requestSchema, type DirectRequest } from "./core.ts";
import { decodeState, encodeState, initialState, WorkflowStore, type StatePacket } from "./workflow-state.ts";
import { createWorkflowPort } from "./workflow-port.ts";
import { workflowOutput } from "./workflow-output.ts";

// Separate queue prevents a waiting report from blocking its own durable save.
// Payload/output are persisted by Trigger, including automatic artifact offload.
export const directWorkflowSnapshot = task({
  id: "market-signal-direct-workflow-snapshot", maxDuration: 30,
  retry: { maxAttempts: 2 }, queue: { name: "market-signal-direct-state", concurrencyLimit: 10 },
  run: async (packet: StatePacket) => {
    if (packet?.version !== 1 || typeof packet.gzip !== "string" || packet.gzip.length > 8 * 1024 * 1024
      || !/^run_[A-Za-z0-9_-]+$/.test(packet.ownerRunId) || !/^[a-f0-9]{64}$/.test(packet.hash)) throw new AbortTaskRunError("INVALID_STATE_PACKET");
    return packet;
  },
});

type Pointer = { runId: string; ownerRunId: string; revision: number; hash: string };
const STATE_KEY = "marketSignalWorkflowStateV1";
async function openStore(ownerRunId: string, request: DirectRequest, workerVersion: string, attemptNumber: number) {
  if (!workerVersion) throw new AbortTaskRunError("DEPLOYED_WORKER_VERSION_REQUIRED");
  await metadata.refresh();
  const pointer = metadata.get(STATE_KEY) as Pointer | undefined;
  let state;
  if (pointer) {
    if (pointer.ownerRunId !== ownerRunId || !/^run_[A-Za-z0-9_-]+$/.test(pointer.runId)) throw new AbortTaskRunError("INVALID_STATE_POINTER");
    const snapshot = await runs.retrieve(pointer.runId);
    if (snapshot.taskIdentifier !== "market-signal-direct-workflow-snapshot" || snapshot.status !== "COMPLETED") throw new AbortTaskRunError("STATE_SNAPSHOT_UNAVAILABLE");
    state = decodeState(snapshot.output as StatePacket, ownerRunId, request);
    if (state.revision !== pointer.revision || (snapshot.output as StatePacket).hash !== pointer.hash) throw new AbortTaskRunError("STATE_POINTER_CONFLICT");
  } else {
    // A retry with no durable root must not silently repeat the original work.
    if (attemptNumber > 1) throw new AbortTaskRunError("MISSING_RETRY_STATE: manual inspection required");
    state = initialState(ownerRunId, request);
  }
  const persist = async (packet: StatePacket) => {
    const saved = await directWorkflowSnapshot.triggerAndWait(packet, {
      // SDK triggerAndWait always pins children to their parent's worker version.
      idempotencyKey: `${ownerRunId}:state:${packet.revision}:${packet.hash}`, idempotencyKeyTTL: "7d",
    });
    if (!saved.ok || saved.output.hash !== packet.hash || saved.output.ownerRunId !== ownerRunId) throw new Error("SNAPSHOT_SAVE_FAILED");
    metadata.set(STATE_KEY, { runId: saved.id, ownerRunId, revision: packet.revision, hash: packet.hash });
    await metadata.flush();
  };
  if (!pointer) await persist(encodeState(state));
  return new WorkflowStore(state, persist);
}

export async function runWorkflow(payload: unknown, context: { runId: string; workerVersion: string; attemptNumber: number; maxAttempts: number }) {
  const request = requestSchema.parse(payload);
  const store = await openStore(context.runId, request, context.workerVersion, context.attemptNumber);
  const run = store.read().report.run;
  try {
    await orchestrateValidatedReport({ contractVersion: "6", publicId: run.publicId, primaryDomain: request.domain, locale: "en", reportAttempt: 1, productPlan: "starter", productLimit: request.comparisons },
      { attemptNumber: 1, taskAttemptNumber: context.attemptNumber, isFinalAttempt: context.attemptNumber >= context.maxAttempts }, createWorkflowPort(store));
    return workflowOutput(store);
  } catch (error) {
    try { store.assertHealthy(); } catch { throw new AbortTaskRunError("DURABLE_STATE_OR_PROVIDER_RESULT_UNCERTAIN: stopped before further paid work; inspect this run before starting a replacement"); }
    if (error instanceof PermanentOrchestrationError) throw new AbortTaskRunError(error.message);
    if (context.attemptNumber >= context.maxAttempts && store.read().report.run.status === "failed") return workflowOutput(store);
    throw error;
  }
}
