import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { StoredReport, ReportOrchestrationPort } from "../trigger/report-orchestration-core.ts";
import type { ReportFactChunkInput, ReportMatchBatchCheckpoint, ReportMatchBatchCheckpointInput, ReportMatchBatchCheckpointReplaceInput } from "../../app/lib/report-store.ts";
import { reportFactContentHash, reportFactHash } from "../shared/report-facts.ts";
import type { DirectRequest } from "./core.ts";

export const MAX_STATE_BYTES = 64 * 1024 * 1024;
export const MAX_PACKET_BYTES = 8 * 1024 * 1024;
export function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
}
export function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(stable(plain(value)))).digest("hex"); }
export type WorkflowState = {
  version: 1; ownerRunId: string; request: DirectRequest; revision: number;
  report: StoredReport; checkpoints: ReportMatchBatchCheckpoint[];
  chunks: ReportFactChunkInput[]; document: unknown;
  operations: Record<string, { status: "started" | "complete"; result?: unknown; kind?: string; startedAt?: string; completedAt?: string; durationMs?: number }>;
};
export type StatePacket = { version: 1; ownerRunId: string; revision: number; hash: string; gzip: string };
export type StatePointer = { runId: string; ownerRunId: string; revision: number; hash: string; inline?: StatePacket };
// Trigger Cloud permits 256 KiB for the complete metadata object. Leave 32 KiB
// of headroom and use the existing artifact snapshot path for larger states.
export function inlineStatePointer(packet: StatePacket, metadata: Record<string, unknown>): StatePointer | null {
  const pointer = { runId: packet.ownerRunId, ownerRunId: packet.ownerRunId, revision: packet.revision, hash: packet.hash, inline: packet };
  return Buffer.byteLength(JSON.stringify({ ...metadata, marketSignalWorkflowStateV1: pointer })) <= 224 * 1024 ? pointer : null;
}
export async function commitStatePointer(pointer: StatePointer, transport: {
  set: (pointer: StatePointer) => void; flush: () => Promise<void>; read: () => Promise<unknown>;
}) {
  transport.set(pointer);
  await transport.flush();
  const confirmed = await transport.read() as StatePointer | undefined;
  if (!confirmed || confirmed.runId !== pointer.runId || confirmed.ownerRunId !== pointer.ownerRunId
    || confirmed.revision !== pointer.revision || confirmed.hash !== pointer.hash
    || JSON.stringify(confirmed.inline || null) !== JSON.stringify(pointer.inline || null)) throw new Error("STATE_POINTER_NOT_CONFIRMED");
}
export function encodeState(state: WorkflowState): StatePacket {
  const raw = Buffer.from(JSON.stringify(state));
  if (raw.length > MAX_STATE_BYTES) throw new Error("STATE_TOO_LARGE: automatic continuation stopped");
  const packet: StatePacket = { version: 1, ownerRunId: state.ownerRunId, revision: state.revision, hash: hash(state), gzip: gzipSync(raw).toString("base64") };
  if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET_BYTES) throw new Error("STATE_PACKET_TOO_LARGE");
  return packet;
}
export function decodeState(packet: StatePacket, ownerRunId: string, request: DirectRequest): WorkflowState {
  if (packet?.version !== 1 || packet.ownerRunId !== ownerRunId || !Number.isSafeInteger(packet.revision) || packet.revision < 0
    || typeof packet.gzip !== "string" || packet.gzip.length > MAX_PACKET_BYTES || !/^[a-f0-9]{64}$/.test(packet.hash)) throw new Error("INVALID_STATE_PACKET");
  const state = JSON.parse(gunzipSync(Buffer.from(packet.gzip, "base64"), { maxOutputLength: MAX_STATE_BYTES }).toString("utf8")) as WorkflowState;
  if (state.version !== 1 || state.ownerRunId !== ownerRunId || state.revision !== packet.revision || hash(state) !== packet.hash
    || hash(state.request) !== hash(request) || !state.report?.run || !Array.isArray(state.checkpoints) || !Array.isArray(state.chunks)
    || !state.operations || typeof state.operations !== "object") throw new Error("STATE_INTEGRITY_CONFLICT");
  return state;
}
export function initialState(ownerRunId: string, request: DirectRequest, observedAt = new Date().toISOString()): WorkflowState {
  const publicId = hash({ ownerRunId, request }).slice(0, 32);
  return { version: 1, ownerRunId, request, revision: 0, report: {
    run: { publicId, primaryDomain: request.domain, locale: "en", status: "queued", attemptCount: 1, productPlan: "starter", productLimit: request.comparisons, createdAt: observedAt, updatedAt: observedAt }, events: [], factManifest: null,
  }, checkpoints: [], chunks: [], document: null, operations: {} };
}

// Exactly one writer exists per Trigger run. Persist before exposing a mutation;
// any ambiguous write poisons this attempt so no later paid operation can run.
export class WorkflowStore {
  private pending: Array<{ change: (state: WorkflowState) => unknown | Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  private flushing = false;
  private broken = false;
  private state: WorkflowState;
  private persist: (packet: StatePacket) => Promise<void>;
  constructor(state: WorkflowState, persist: (packet: StatePacket) => Promise<void>) { this.state = state; this.persist = persist; }
  assertHealthy() { if (this.broken) throw new Error("DURABLE_STATE_UNAVAILABLE: stop before more research"); }
  read() { this.assertHealthy(); return plain(this.state); }
  async update<T>(change: (state: WorkflowState) => T | Promise<T>): Promise<T> {
    this.assertHealthy();
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ change, resolve: (value) => resolve(value as T), reject });
      if (!this.flushing) {
        this.flushing = true;
        queueMicrotask(() => { void this.flushUpdates(); });
      }
    });
  }
  private async flushUpdates() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      const committed: Array<{ entry: typeof batch[number]; result: unknown }> = [];
      let next = plain(this.state);
      for (const entry of batch) {
        try {
          this.assertHealthy();
          // A failed mutation must not leak part of itself into another write.
          const candidate = plain(next);
          const result = plain((await entry.change(candidate)) ?? null);
          candidate.revision += 1;
          next = candidate;
          committed.push({ entry, result });
        } catch (error) { entry.reject(error); }
      }
      if (!committed.length) continue;
      try {
        await this.persist(encodeState(next));
        this.state = next;
        for (const { entry, result } of committed) entry.resolve(result);
      } catch {
        this.broken = true;
        const error = new Error("DURABLE_STATE_UNAVAILABLE: checkpoint commit was not confirmed");
        for (const { entry } of committed) entry.reject(error);
      }
    }
    this.flushing = false;
  }
  identity(publicId: string, attemptNumber = 1) {
    this.assertHealthy();
    if (publicId !== this.state.report.run.publicId || attemptNumber !== 1) throw new Error("WORKFLOW_IDENTITY_CONFLICT");
  }
  async operation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const id = hash(key);
    const prior = this.read().operations[id];
    if (prior?.status === "complete") return plain(prior.result) as T;
    if (prior) { this.broken = true; throw new Error("AMBIGUOUS_PROVIDER_OPERATION: automatic paid replay stopped"); }
    const kind = key.split(":")[0];
    const startedAt = new Date().toISOString();
    await this.update((state) => { if (state.operations[id]) throw new Error("DUPLICATE_PROVIDER_OPERATION"); state.operations[id] = { status: "started", kind, startedAt }; });
    this.assertHealthy();
    const workStarted = Date.now();
    let result: T;
    try { result = plain(await run()); } catch (error) { this.broken = true; throw error; }
    const durationMs = Date.now() - workStarted;
    await this.update((state) => { state.operations[id] = { status: "complete", kind, startedAt, completedAt: new Date().toISOString(), durationMs, result }; });
    return result;
  }
  loadCheckpoints: ReportOrchestrationPort["loadCheckpoint"] = async (publicId, input) => {
    this.identity(publicId, input.attemptNumber);
    return this.read().checkpoints.filter((row) => row.attemptNumber === input.attemptNumber
      && (input.batchIndex === undefined || row.batchIndex === input.batchIndex)
      && (input.batchIndexStart === undefined || row.batchIndex >= input.batchIndexStart)
      && (input.batchIndexEnd === undefined || row.batchIndex <= input.batchIndexEnd))
      .sort((a, b) => a.batchIndex - b.batchIndex).slice(0, input.limit ?? 5000);
  };
  async saveCheckpoint(publicId: string, input: ReportMatchBatchCheckpointInput | ReportMatchBatchCheckpointReplaceInput) {
    this.identity(publicId, input.attemptNumber);
    if (!Number.isInteger(input.batchIndex) || input.batchIndex < 0 || input.batchIndex >= 5000 || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error("INVALID_CHECKPOINT_IDENTITY");
    const result = stable(plain(input.result));
    const resultHash = hash(result);
    if (input.resultHash && input.resultHash !== resultHash) throw new Error("CHECKPOINT_HASH_CONFLICT");
    return this.update((state) => {
      const existing = state.checkpoints.find((row) => row.batchIndex === input.batchIndex);
      const replacing = "expectedResultHash" in input;
      if (existing && (existing.inputHash !== input.inputHash || (replacing ? existing.resultHash !== input.expectedResultHash : existing.resultHash !== resultHash))) throw new Error("CHECKPOINT_REVISION_CONFLICT");
      if (!existing && replacing) throw new Error("CHECKPOINT_REVISION_MISSING");
      const timestamp = new Date().toISOString();
      const checkpoint = { attemptNumber: 1, batchIndex: input.batchIndex, inputHash: input.inputHash, result, resultHash, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp };
      if (existing) Object.assign(existing, checkpoint); else state.checkpoints.push(checkpoint);
      return { checkpoint, replayed: Boolean(existing && existing.resultHash === resultHash) };
    });
  }
  appendEvent: ReportOrchestrationPort["appendEvent"] = async (publicId, event) => {
    this.identity(publicId, event.attemptNumber);
    await this.update((state) => {
      if (state.report.events.some((prior) => prior.idempotencyKey === event.idempotencyKey)) return;
      state.report.events.push({ ...event, metadata: { ...event.metadata, recordedAt: new Date().toISOString() } });
      state.report.run.updatedAt = new Date().toISOString();
      // Phase-level limited events do not terminate the entire report.
      if (event.phase === "failed" || event.status === "failed") state.report.run.status = "failed";
      else if (state.report.run.status === "queued") state.report.run.status = "running";
    });
  };
  persistFactChunk: ReportOrchestrationPort["persistFactChunk"] = async (publicId, input) => {
    this.identity(publicId, input.attemptNumber);
    if (await reportFactContentHash(input.kind, input.items) !== input.contentHash) throw new Error("FACT_CONTENT_HASH_CONFLICT");
    await this.update((state) => {
      const prior = state.chunks.find((chunk) => chunk.manifestId === input.manifestId && chunk.kind === input.kind && chunk.chunkIndex === input.chunkIndex);
      if (prior && hash(prior) !== hash(input)) throw new Error("FACT_CHUNK_CONFLICT");
      if (!prior) state.chunks.push(input);
    });
  };
  finalizeFactManifest: ReportOrchestrationPort["finalizeFactManifest"] = async (publicId, input) => {
    this.identity(publicId, input.attemptNumber);
    await this.update(async (state) => {
      const chunks = state.chunks.filter((chunk) => chunk.manifestId === input.manifestId).sort((a, b) => a.kind.localeCompare(b.kind) || a.chunkIndex - b.chunkIndex);
      for (const kind of ["companies", "products", "matches", "ads"] as const) {
        const group = chunks.filter((chunk) => chunk.kind === kind);
        if (group.reduce((count, chunk) => count + chunk.items.length, 0) !== input.counts[kind]
          || group.some((chunk, index) => chunk.chunkIndex !== index || chunk.chunkCount !== group.length)) throw new Error("INCOMPLETE_FACT_MANIFEST");
      }
      if (await reportFactHash(chunks.map(({ kind, chunkIndex, contentHash }) => ({ kind, chunkIndex, contentHash }))) !== input.manifestHash) throw new Error("FACT_MANIFEST_HASH_CONFLICT");
      const prior = state.report.factManifest;
      if (prior && (prior.manifestHash !== input.manifestHash || prior.manifestId !== input.manifestId)) throw new Error("COMPLETED_MANIFEST_CONFLICT");
      state.report.factManifest = { ...input, attemptNumber: 1, status: "complete", completedAt: new Date().toISOString() };
    });
  };
  saveDocument: ReportOrchestrationPort["saveDocument"] = async (publicId, input) => {
    this.identity(publicId, input.attemptNumber);
    await this.update((state) => {
      if (input.expectedFactManifestHash === "") {
        const envelope = input.document as { primaryDomain?: string; document?: { blocks?: Array<Record<string, unknown>> } };
        const blocks = envelope?.document?.blocks;
        const domainStatus = blocks?.find((block) => block.type === "domain-status" && block.domain === state.request.domain && ["parked", "unavailable"].includes(String(block.status)));
        if (input.status !== "limited" || state.chunks.length || state.report.factManifest || envelope.primaryDomain !== state.request.domain
          || !domainStatus || !state.report.events.some((event) => event.idempotencyKey === "crawl-limited")) throw new Error("DOCUMENT_MANIFEST_CONFLICT");
      } else if (state.report.factManifest?.status !== "complete" || state.report.factManifest.manifestHash !== input.expectedFactManifestHash) throw new Error("DOCUMENT_MANIFEST_CONFLICT");
      state.document = input.document;
      state.report.run.status = input.status;
      state.report.run.updatedAt = input.observedAt;
    });
  };
}
