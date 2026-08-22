import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRun, getStoredReport, importStoredReportSnapshot, saveReportDocument } from "../app/lib/report-store.ts";
import { recoverLegacyReport } from "../app/lib/legacy-report-recovery.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-legacy-"));
  return {
    directory,
    database: await NodeSqliteDatabase.open(join(directory, "market-signal.sqlite")),
  };
}

function legacyPayload(publicId, overrides = {}) {
  return {
    ok: true,
    report: {
      run: {
        id: "legacy-private-id",
        publicId,
        primaryDomain: "legacy.example",
        locale: "en",
        status: "complete",
        currentPhase: "complete",
        attemptCount: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:05:00.000Z",
        heartbeatAt: "2026-07-01T00:05:00.000Z",
        expiresAt: "2026-09-29T00:00:00.000Z",
        errorCode: "",
        errorMessage: "",
        ...overrides.run,
      },
      events: [{ sequence: 1, idempotencyKey: "run-created", phase: "queued", status: "queued", message: "Report queued.", metadata: {}, observedAt: "2026-07-01T00:00:00.000Z" }],
      document: { primaryDomain: "legacy.example", document: { version: "1", blocks: [{ type: "market-profile", id: "profile" }] } },
      documentSchemaVersion: 1,
      documentObservedAt: "2026-07-01T00:05:00.000Z",
      ...overrides.report,
    },
  };
}

const options = {
  now: new Date("2026-08-02T00:00:00.000Z"),
  requestUrl: "https://signal.blyzr.com/api/reports/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  enabled: "true",
  baseUrl: "https://legacy.example",
  sunsetAt: "2026-10-01T00:00:00.000Z",
};

test("a legacy report heals once and subsequent reads stay local", async () => {
  const { directory, database } = await fixture();
  const publicId = "a".repeat(32);
  let requests = 0;
  try {
    const recovered = await recoverLegacyReport(publicId, {
      ...options,
      database,
      fetchImpl: async () => {
        requests += 1;
        return Response.json(legacyPayload(publicId));
      },
    });
    assert.equal(recovered.run.publicId, publicId);
    assert.equal(recovered.run.createdAt, "2026-07-01T00:00:00.000Z");
    assert.equal(recovered.run.expiresAt, "2026-09-29T00:00:00.000Z");
    assert.equal(requests, 1);

    const second = await recoverLegacyReport(publicId, {
      ...options,
      database,
      fetchImpl: async () => { throw new Error("legacy origin must not be called"); },
    });
    assert.equal(second.document.document.blocks[0].id, "profile");
    assert.equal(requests, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local reports bypass legacy recovery even when it is enabled", async () => {
  const { directory, database } = await fixture();
  try {
    const created = await createReportRun({ primaryDomain: "local.example" }, options.now, database);
    await saveReportDocument(created.publicId, { document: { version: "1", blocks: [] } }, { expectedFactManifestHash: "" }, options.now, database);
    const result = await recoverLegacyReport(created.publicId, {
      ...options,
      database,
      fetchImpl: async () => { throw new Error("legacy origin must not be called"); },
    });
    assert.equal(result.run.publicId, created.publicId);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot import never overwrites a report already owned by the local database", async () => {
  const { directory, database } = await fixture();
  const publicId = "f".repeat(32);
  try {
    const original = legacyPayload(publicId).report;
    const first = await importStoredReportSnapshot(original, options.now, database);
    assert.equal(first.document.document.blocks[0].id, "profile");

    const conflicting = legacyPayload(publicId, {
      report: {
        document: { primaryDomain: "legacy.example", document: { version: "1", blocks: [{ type: "market-profile", id: "replacement" }] } },
      },
    }).report;
    const persisted = await importStoredReportSnapshot(conflicting, options.now, database);
    assert.equal(persisted.run.id, first.run.id);
    assert.equal(persisted.document.document.blocks[0].id, "profile");
    assert.equal(persisted.events.length, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent recovery calls share one legacy request and one local import", async () => {
  const { directory, database } = await fixture();
  const publicId = "9".repeat(32);
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    requests += 1;
    await gate;
    return Response.json(legacyPayload(publicId));
  };
  try {
    const first = recoverLegacyReport(publicId, { ...options, database, fetchImpl });
    const second = recoverLegacyReport(publicId, { ...options, database, fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.run.id, right.run.id);
    assert.equal((await getStoredReport(publicId, options.now, database)).run.id, left.run.id);
  } finally {
    release?.();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery stays off without a complete valid operator window", async () => {
  const { directory, database } = await fixture();
  const publicId = "b".repeat(32);
  let requests = 0;
  try {
    for (const override of [
      { enabled: "false" },
      { baseUrl: "http://legacy.example" },
      { baseUrl: "https://signal.blyzr.com" },
      { sunsetAt: "2026-08-01T00:00:00.000Z" },
    ]) {
      const result = await recoverLegacyReport(publicId, { ...options, ...override, database, fetchImpl: async () => { requests += 1; return Response.json({}); } });
      assert.equal(result, null);
    }
    assert.equal(requests, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid, expired, mismatched, and oversized legacy payloads are never stored", async () => {
  const cases = [
    legacyPayload("c".repeat(32), { run: { expiresAt: "2026-08-01T00:00:00.000Z" } }),
    legacyPayload("c".repeat(32), { run: { expiresAt: "2027-08-01T00:00:00.000Z" } }),
    legacyPayload("d".repeat(32)),
    legacyPayload("c".repeat(32), { report: { documentSchemaVersion: 2 } }),
  ];
  for (const payload of cases) {
    const { directory, database } = await fixture();
    const publicId = "c".repeat(32);
    try {
      await assert.rejects(recoverLegacyReport(publicId, { ...options, database, fetchImpl: async () => Response.json(payload) }), /validation|snapshot/);
      assert.equal(await getStoredReport(publicId, options.now, database), null);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  const { directory, database } = await fixture();
  try {
    const body = "x".repeat(1_000_001);
    await assert.rejects(recoverLegacyReport("e".repeat(32), { ...options, database, fetchImpl: async () => new Response(body) }), /too large/);
    assert.equal(await getStoredReport("e".repeat(32), options.now, database), null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy 404 and redirect failures do not create local reports", async () => {
  const { directory, database } = await fixture();
  try {
    const missingId = "7".repeat(32);
    assert.equal(await recoverLegacyReport(missingId, { ...options, database, fetchImpl: async () => new Response("missing", { status: 404 }) }), null);
    assert.equal(await getStoredReport(missingId, options.now, database), null);

    const redirectedId = "8".repeat(32);
    await assert.rejects(recoverLegacyReport(redirectedId, { ...options, database, fetchImpl: async () => { throw new TypeError("redirect mode is set to error"); } }), /redirect mode/);
    assert.equal(await getStoredReport(redirectedId, options.now, database), null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed IDs fail before any outbound request", async () => {
  let requests = 0;
  await assert.rejects(recoverLegacyReport("../report", { ...options, fetchImpl: async () => { requests += 1; return Response.json({}); } }), /Invalid report id/);
  assert.equal(requests, 0);
});
