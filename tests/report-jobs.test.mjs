import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createPersistentReport, POST as createReportRoute } from "../app/api/reports/route.ts";
import { createInternalReportHandlers } from "../app/api/internal/reports/[publicId]/route.ts";
import { hasValidInternalAuthorization } from "../app/lib/internal-auth.ts";
import { dispatchReportJob, reportDispatchIdempotencyKey, ReportDispatchError } from "../app/lib/report-dispatch.ts";
import { compactTerminalReportDocument } from "../src/shared/report-document-compaction.ts";
import { babanujScaleDocument } from "./fixtures/babanuj-report-document.mjs";

const TOKEN = "callback-test-token-with-sufficient-entropy";
const PUBLIC_ID = "a".repeat(32);

function request(body, authorization = `Bearer ${TOKEN}`) {
  const payload = body.action === "recover" || Object.prototype.hasOwnProperty.call(body, "attemptNumber") ? body : { ...body, attemptNumber: 1 };
  return new Request("https://market-signal.example/api/internal/reports/" + PUBLIC_ID, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(payload),
  });
}

function report(overrides = {}) {
  return {
    run: { id: "internal", publicId: PUBLIC_ID, primaryDomain: "myjam.co.uk", locale: "en", status: "running", currentPhase: "crawl", attemptCount: 1, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:01:00.000Z", heartbeatAt: "2026-07-20T00:01:00.000Z", expiresAt: "2026-10-20T00:00:00.000Z", errorCode: "", errorMessage: "", ...overrides },
    events: [],
    document: null,
    documentSchemaVersion: 0,
    documentObservedAt: "",
  };
}

test("internal callback authorization fails closed for missing, malformed, and incorrect bearer values", async () => {
  assert.equal(await hasValidInternalAuthorization(null, TOKEN), false);
  assert.equal(await hasValidInternalAuthorization(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(await hasValidInternalAuthorization("Bearer wrong", TOKEN), false);
  assert.equal(await hasValidInternalAuthorization(`Bearer ${TOKEN} extra`, TOKEN), false);
  assert.equal(await hasValidInternalAuthorization(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(await hasValidInternalAuthorization(`Bearer ${TOKEN}`, ""), false);
});

test("report dispatch deduplicates one attempt and creates a distinct recovery run", async () => {
  const runs = new Map();
  const payloads = [];
  const trigger = async (payload, options) => {
    payloads.push(payload);
    if (!runs.has(options.idempotencyKey)) runs.set(options.idempotencyKey, { id: `run_${runs.size + 1}` });
    return runs.get(options.idempotencyKey);
  };
  const initial = { publicId: PUBLIC_ID, primaryDomain: "myjam.co.uk", locale: "en", attemptCount: 1 };
  const first = await dispatchReportJob(initial, { trigger });
  const duplicate = await dispatchReportJob(initial, { trigger });
  const recovery = await dispatchReportJob({ ...initial, attemptCount: 2 }, { trigger });
  assert.equal(first.runId, duplicate.runId);
  assert.notEqual(first.runId, recovery.runId);
  assert.deepEqual(payloads.map((payload) => payload.reportAttempt), [1, 1, 2]);
  assert.equal(reportDispatchIdempotencyKey(initial), `${PUBLIC_ID}:3:1`);
  assert.equal(reportDispatchIdempotencyKey({ ...initial, attemptCount: 2 }), `${PUBLIC_ID}:3:2`);
});

test("report dispatch diagnostics distinguish missing credentials without exposing their value", async () => {
  await assert.rejects(
    dispatchReportJob({ publicId: PUBLIC_ID, primaryDomain: "myjam.co.uk", locale: "en", attemptCount: 1 }, { secret: "" }),
    (error) => error instanceof ReportDispatchError && error.code === "trigger-secret-unavailable" && !/tr_(?:prod|dev)_/i.test(error.message),
  );
});

test("report creation returns 202 only after dispatch and records a sanitized failure otherwise", async () => {
  const created = { id: "internal", publicId: PUBLIC_ID, primaryDomain: "myjam.co.uk", locale: "en", status: "queued", currentPhase: "queued", attemptCount: 1, createdAt: "now", expiresAt: "later" };
  const calls = [];
  const success = await createPersistentReport(new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk", locale: "en" }) }), {
    create: async () => ({ ok: true, report: created }),
    dispatch: async () => ({ runId: "run_started1", idempotencyKey: `${PUBLIC_ID}:1:1` }),
    markDispatched: async (id, runId) => calls.push(["dispatched", id, runId]),
    markDispatchFailed: async () => calls.push(["failed"]),
  });
  assert.equal(success.status, 202);
  assert.deepEqual(calls, [["dispatched", PUBLIC_ID, "run_started1"]]);

  const telemetryFailureCalls = [];
  const acceptedWithoutTelemetry = await createPersistentReport(new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk" }) }), {
    create: async () => ({ ok: true, report: created }),
    dispatch: async () => ({ runId: "run_started2", idempotencyKey: `${PUBLIC_ID}:1:1` }),
    markDispatched: async () => { throw new Error("temporary D1 write failure"); },
    markDispatchFailed: async () => telemetryFailureCalls.push("failed"),
  });
  assert.equal(acceptedWithoutTelemetry.status, 202);
  assert.deepEqual(telemetryFailureCalls, []);

  const failedCalls = [];
  const failure = await createPersistentReport(new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk" }) }), {
    create: async () => ({ ok: true, report: created }),
    dispatch: async () => { throw new Error("upstream body containing a secret"); },
    markDispatched: async () => {},
    markDispatchFailed: async (id) => failedCalls.push(id),
  });
  assert.equal(failure.status, 503);
  assert.deepEqual(failedCalls, [PUBLIC_ID]);
  const body = await failure.json();
  assert.equal(body.publicId, PUBLIC_ID);
  assert.equal(body.errorCode, "dispatch-failed");
  assert.doesNotMatch(JSON.stringify(body), /upstream|secret/i);

  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    for (const diagnosticCode of ["storage-unavailable", "run-create-batch-schema-mismatch", "run-create-unclassified"]) {
      const storageFailure = await createPersistentReport(new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk" }) }), {
        create: async () => ({ ok: false, diagnosticCode }),
        dispatch: async () => { throw new Error("must not dispatch"); },
        markDispatched: async () => {},
        markDispatchFailed: async () => {},
      });
      assert.equal(storageFailure.status, 503);
      const storageBody = await storageFailure.json();
      assert.deepEqual(storageBody, { ok: false, error: "The persistent report could not be created.", errorCode: "storage-create-failed" });
      assert.doesNotMatch(JSON.stringify(storageBody), /diagnostic|schema|unclassified|unavailable/i);
    }
    const invalidDomain = await createPersistentReport(new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "invalid" }) }), {
      create: async () => ({ ok: false, diagnosticCode: "invalid-domain" }),
      dispatch: async () => { throw new Error("must not dispatch"); },
      markDispatched: async () => {},
      markDispatchFailed: async () => {},
    });
    assert.equal(invalidDomain.status, 400);
    assert.deepEqual(await invalidDomain.json(), { ok: false, error: "A valid public domain is required.", errorCode: "invalid-domain" });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged, [
    ["report creation failed", { stage: "storage-create", diagnosticCode: "storage-unavailable" }],
    ["report creation failed", { stage: "storage-create", diagnosticCode: "run-create-batch-schema-mismatch" }],
    ["report creation failed", { stage: "storage-create", diagnosticCode: "run-create-unclassified" }],
  ]);
});

test("public report creation never forwards client-supplied plan controls", async () => {
  let creationInput;
  const created = { id: "internal", publicId: PUBLIC_ID, primaryDomain: "myjam.co.uk", locale: "en", status: "queued", currentPhase: "queued", attemptCount: 1, createdAt: "now", expiresAt: "later", productPlan: "starter", productLimit: 20 };
  const response = await createPersistentReport(new Request("https://example.test/api/reports?plan=agency", {
    method: "POST",
    headers: { "content-type": "application/json", "x-market-signal-plan": "agency" },
    body: JSON.stringify({ primaryDomain: "myjam.co.uk", plan: "agency", productLimit: 1_000 }),
  }), {
    create: async (input) => { creationInput = input; return { ok: true, report: created }; },
    dispatch: async () => ({ runId: "run_plancontrol", idempotencyKey: `${PUBLIC_ID}:3:1` }),
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });

  assert.equal(response.status, 202);
  assert.deepEqual(creationInput, { primaryDomain: "myjam.co.uk", locale: "en" });
});

test("report creation consumes cross-module results through a closed route boundary", async () => {
  const created = { id: "internal", publicId: PUBLIC_ID, primaryDomain: "myjam.co.uk", locale: "en", status: "queued", currentPhase: "queued", attemptCount: 1, createdAt: "now", expiresAt: "later" };
  const originalConsoleError = console.error;
  const logged = [];
  let dispatches = 0;
  console.error = (...args) => logged.push(args);
  const services = (create) => ({
    create,
    dispatch: async () => { dispatches += 1; return { runId: "run_boundary", idempotencyKey: `${PUBLIC_ID}:1:1` }; },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });
  const run = (create) => createPersistentReport(new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk" }) }), services(create));

  try {
    for (const [create, diagnosticCode] of [
      [undefined, "create-not-callable"],
      [async () => { throw new Proxy({}, { get() { throw new Error("private trap detail"); }, getPrototypeOf() { throw new Error("private prototype detail"); } }); }, "create-rejected"],
      [async () => undefined, "create-malformed"],
      [async () => "wrong", "create-malformed"],
      [async () => ({ ok: "yes" }), "create-malformed"],
      [async () => ({ ok: true, report: new Proxy({}, { get() { throw new Error("private report trap"); } }) }), "create-access-failed"],
      [async () => ({ ok: true, report: { ...created, publicId: "short" } }), "create-access-failed"],
    ]) {
      const response = await run(create);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, error: "The persistent report could not be created.", errorCode: "storage-create-failed" });
      assert.deepEqual(logged.at(-1), ["report creation failed", { stage: "storage-create", diagnosticCode }]);
    }

    const hostileExtra = { ...created };
    Object.defineProperty(hostileExtra, "privateValue", { get() { throw new Error("must not be read"); } });
    const accepted = await run(async () => ({ ok: true, report: hostileExtra, ignored: new Proxy({}, { get() { throw new Error("must not be read"); } }) }));
    assert.equal(accepted.status, 202);
    assert.deepEqual((await accepted.json()).report, { ...created, productPlan: "starter", productLimit: 20 });

    const known = await run(async () => ({ ok: false, diagnosticCode: "run-create-batch-schema-mismatch" }));
    assert.equal(known.status, 503);
    assert.deepEqual(logged.at(-1), ["report creation failed", { stage: "storage-create", diagnosticCode: "run-create-batch-schema-mismatch" }]);
    const unknown = await run(async () => ({ ok: false, diagnosticCode: "private-database-detail" }));
    assert.equal(unknown.status, 503);
    assert.deepEqual(logged.at(-1), ["report creation failed", { stage: "storage-create", diagnosticCode: "run-create-unclassified" }]);
    assert.doesNotMatch(JSON.stringify(logged), /private trap|private prototype|private report|private-database-detail|must not be read/i);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(dispatches, 1);
});

test("the framework route context cannot replace report creation dependencies", async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const response = await createReportRoute(
      new Request("https://example.test/api/reports", { method: "POST", body: JSON.stringify({ primaryDomain: "myjam.co.uk" }) }),
      { params: Promise.resolve({}) },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "The persistent report could not be created.", errorCode: "storage-create-failed" });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged.at(-1), ["report creation failed", { stage: "storage-create", diagnosticCode: "storage-unavailable" }]);
  assert.doesNotMatch(JSON.stringify(logged), /create-not-callable/);
});

test("authenticated recovery increments the attempt, dispatches it, and safely replays", async () => {
  let stored = report({ status: "interrupted", currentPhase: "interrupted", errorCode: "stale-worker", attemptCount: 1 });
  const calls = [];
  const recovery = {
    recover: async () => {
      calls.push(["recover", 2]);
      stored = { ...stored, run: { ...stored.run, status: "queued", currentPhase: "queued", attemptCount: 2 }, events: [...stored.events, { sequence: 3, idempotencyKey: "recovery-attempt-2", phase: "queued", status: "queued", message: "Recovery authorized.", metadata: { attempt: 2 }, observedAt: "now" }] };
      return stored.run;
    },
    dispatch: async (run) => {
      calls.push(["dispatch", reportDispatchIdempotencyKey(run)]);
      return { runId: "run_recovered2", idempotencyKey: reportDispatchIdempotencyKey(run) };
    },
    markDispatched: async (_id, runId) => calls.push(["record", runId]),
    markDispatchFailed: async () => calls.push(["failed"]),
  };
  const handlers = createInternalReportHandlers({ get: async () => stored, append: async () => {}, save: async () => {} }, TOKEN, recovery);
  const accepted = await handlers.post(request({ action: "recover" }), { params: { publicId: PUBLIC_ID } });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).replayed, false);
  const replay = await handlers.post(request({ action: "recover" }), { params: { publicId: PUBLIC_ID } });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).replayed, true);
  assert.deepEqual(calls, [
    ["recover", 2],
    ["dispatch", `${PUBLIC_ID}:3:2`],
    ["record", "run_recovered2"],
    ["dispatch", `${PUBLIC_ID}:3:2`],
    ["record", "run_recovered2"],
  ]);
});

test("authenticated callbacks are replay-safe and conflicting idempotency keys fail", async () => {
  let stored = report();
  const appended = [];
  const handlers = createInternalReportHandlers({
    get: async () => stored,
    append: async (_id, input) => { appended.push(input); return input; },
    save: async () => ({ status: "complete" }),
  }, TOKEN);
  const event = { action: "event", idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages.", metadata: { attempt: 1 } };
  const accepted = await handlers.post(request(event), { params: { publicId: PUBLIC_ID } });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).replayed, false);
  assert.equal(appended.length, 1);

  stored = { ...stored, events: [{ sequence: 2, idempotencyKey: "crawl-started", phase: "crawl", status: "running", message: "Collecting public pages.", metadata: { attempt: 1 }, observedAt: "now" }] };
  const replay = await handlers.post(request(event), { params: { publicId: PUBLIC_ID } });
  assert.equal((await replay.json()).replayed, true);
  assert.equal(appended.length, 1);
  const conflict = await handlers.post(request({ ...event, message: "Different event." }), { params: { publicId: PUBLIC_ID } });
  assert.equal(conflict.status, 409);
  const denied = await handlers.post(request(event, "Bearer wrong"), { params: { publicId: PUBLIC_ID } });
  assert.equal(denied.status, 401);
});

test("authenticated fact callbacks preserve chunk and manifest contracts", async () => {
  const stored = report();
  const writes = [];
  const handlers = createInternalReportHandlers({
    get: async () => stored,
    append: async () => {},
    save: async () => {},
    saveFactChunk: async (_id, input) => { writes.push(["chunk", input]); return { replayed: false }; },
    finalizeFacts: async (_id, input) => { writes.push(["manifest", input]); return { replayed: false }; },
  }, TOKEN);
  const missingAttempt = await handlers.post(request({ action: "fact-chunk", attemptNumber: null, manifestId: "a".repeat(64), kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: "b".repeat(64), items: [] }), { params: { publicId: PUBLIC_ID } });
  const chunk = await handlers.post(request({ action: "fact-chunk", attemptNumber: 1, manifestId: "a".repeat(64), kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: "b".repeat(64), items: [] }), { params: { publicId: PUBLIC_ID } });
  const manifest = await handlers.post(request({ action: "fact-manifest", attemptNumber: 1, manifestId: "a".repeat(64), manifestHash: "c".repeat(64), counts: { companies: 1, products: 0, matches: 0, ads: 0 } }), { params: { publicId: PUBLIC_ID } });
  const stale = await handlers.post(request({ action: "fact-chunk", attemptNumber: 2, manifestId: "a".repeat(64), kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: "b".repeat(64), items: [] }), { params: { publicId: PUBLIC_ID } });
  assert.equal(missingAttempt.status, 400);
  assert.equal(stale.status, 409);
  assert.equal(chunk.status, 200);
  assert.equal(manifest.status, 200);
  assert.equal(writes[0][0], "chunk");
  assert.equal(writes[1][0], "manifest");
});

test("internal callbacks reject oversized bodies before JSON parsing", async () => {
  let reads = 0;
  const handlers = createInternalReportHandlers({ get: async () => { reads += 1; return report(); }, append: async () => {}, save: async () => {} }, TOKEN);
  const response = await handlers.post(new Request(`https://market.example/api/internal/reports/${PUBLIC_ID}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Content-Length": "1500001" },
    body: "{}",
  }), { params: { publicId: PUBLIC_ID } });
  assert.equal(response.status, 400);
  assert.equal(reads, 0);
});

test("fact callback conflicts map to 409 and deterministic validation maps to 400", async () => {
  const stored = report();
  const base = { get: async () => stored, append: async () => {}, save: async () => {}, finalizeFacts: async () => {} };
  const body = { action: "fact-chunk", attemptNumber: 1, manifestId: "a".repeat(64), kind: "products", chunkIndex: 0, chunkCount: 1, contentHash: "b".repeat(64), items: [] };
  const conflictHandlers = createInternalReportHandlers({ ...base, saveFactChunk: async () => { throw new Error("Report fact chunk replay conflicts with persisted content."); } }, TOKEN);
  const invalidHandlers = createInternalReportHandlers({ ...base, saveFactChunk: async () => { throw new Error("Report fact domain was not persisted as a report company."); } }, TOKEN);
  assert.equal((await conflictHandlers.post(request(body), { params: { publicId: PUBLIC_ID } })).status, 409);
  assert.equal((await invalidHandlers.post(request(body), { params: { publicId: PUBLIC_ID } })).status, 400);
});

test("a lost final callback response replays only for the exact persisted document", async () => {
  const document = { primaryDomain: "myjam.co.uk", document: { version: "1", blocks: [] }, marketBrief: null };
  const stored = { ...report({ status: "limited", currentPhase: "complete" }), document, documentSchemaVersion: 1 };
  let saves = 0;
  const handlers = createInternalReportHandlers({ get: async () => stored, append: async () => {}, save: async () => { saves += 1; } }, TOKEN);
  const replay = await handlers.post(request({ action: "document", status: "limited", observedAt: "2026-07-20T00:02:00.000Z", document }), { params: { publicId: PUBLIC_ID } });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(saves, 0);
  const conflict = await handlers.post(request({ action: "document", status: "limited", document: { ...document, marketBrief: { changed: true } } }), { params: { publicId: PUBLIC_ID } });
  assert.equal(conflict.status, 409);
});

test("a lost large callback response replays its exact compacted snapshot and rejects changed compacted content", async () => {
  const original = babanujScaleDocument();
  const document = compactTerminalReportDocument(original);
  const stored = { ...report({ primaryDomain: original.primaryDomain, status: "limited", currentPhase: "complete" }), document, documentSchemaVersion: 1 };
  let saves = 0;
  const handlers = createInternalReportHandlers({ get: async () => stored, append: async () => {}, save: async () => { saves += 1; } }, TOKEN);

  const replay = await handlers.post(request({ action: "document", status: "limited", observedAt: "2026-08-03T00:02:00.000Z", document }), { params: { publicId: PUBLIC_ID } });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(saves, 0);

  const changed = structuredClone(document);
  changed.document.blocks.find((block) => block.type === "summary").body = "Changed useful result";
  const conflict = await handlers.post(request({ action: "document", status: "limited", document: changed }), { params: { publicId: PUBLIC_ID } });
  assert.equal(conflict.status, 409);
  assert.equal(saves, 0);
});

test("terminal failures refuse new events and documents", async () => {
  const stored = report({ status: "failed", currentPhase: "failed", errorCode: "crawl-failed" });
  let writes = 0;
  const handlers = createInternalReportHandlers({
    get: async () => stored,
    append: async () => { writes += 1; },
    save: async () => { writes += 1; },
  }, TOKEN);
  const event = await handlers.post(request({ action: "event", idempotencyKey: "late-event", phase: "crawl", status: "running", message: "Late callback." }), { params: { publicId: PUBLIC_ID } });
  const document = await handlers.post(request({ action: "document", status: "complete", document: { primaryDomain: "myjam.co.uk", document: { blocks: [] } } }), { params: { publicId: PUBLIC_ID } });
  assert.equal(event.status, 409);
  assert.equal(document.status, 409);
  assert.equal(writes, 0);
});

test("the browser only creates and observes a durable job; public report URLs are read-only", async () => {
  const [home, publicRoute, internalRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/[publicId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/reports/[publicId]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(home, /postJson<CreateReportResponse>\("\/api\/reports"/);
  assert.match(home, /window\.location\.assign\(`\/reports\/\$\{created\.report\.publicId\}\/loading`\)/);
  for (const path of ["/api/crawl", "/api/report", "/api/ads", "/api/match", "/api/enrich-products", "/api/actions"]) {
    assert.doesNotMatch(home, new RegExp(`[\"'\u0060]${path}[\"'\u0060]`));
  }
  assert.doesNotMatch(home, /action:\s*"(?:event|document)"/);
  assert.doesNotMatch(publicRoute, /export const (?:POST|PATCH)|export async function (?:POST|PATCH)/);
  assert.match(internalRoute, /hasValidInternalAuthorization/);
  assert.match(internalRoute, /replayed: true/);
  const createRoute = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
  assert.match(createRoute, /resolveProductEntitlement/);
  assert.match(createRoute, /createReportRunResult\(\{ \.\.\.input, entitlement \}\)/);
});
