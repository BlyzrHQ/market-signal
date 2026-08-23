import assert from "node:assert/strict";
import test from "node:test";

import { createAcceptanceReportHandler } from "../app/api/internal/acceptance-reports/route.ts";

const PUBLIC_ID = "b".repeat(32);
const created = {
  id: "acceptance-run",
  publicId: PUBLIC_ID,
  primaryDomain: "myjam.co.uk",
  locale: "en",
  status: "queued",
  currentPhase: "queued",
  attemptCount: 1,
  createdAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-11-23T00:00:00.000Z",
  productPlan: "starter",
  productLimit: 20,
  productTargetKind: "pairs",
};

function request(body, authorization = "Bearer acceptance-token") {
  return new Request("https://signal.example/api/internal/acceptance-reports", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function services(calls) {
  return {
    authorize: async (value) => value === "Bearer acceptance-token",
    create: async (input) => { calls.push(["create", input]); return { ok: true, report: { ...created, productPlan: input.entitlement.plan, productLimit: input.entitlement.productLimit } }; },
    append: async (_id, input) => calls.push(["append", input]),
    dispatch: async (report) => { calls.push(["dispatch", report]); return { runId: "run_acceptance1", idempotencyKey: "key" }; },
    markDispatched: async (...args) => calls.push(["mark-dispatched", ...args]),
    markDispatchFailed: async (...args) => calls.push(["mark-failed", ...args]),
  };
}

test("acceptance report creation is authenticated and uses exact pair quotas", async () => {
  const unauthorizedCalls = [];
  const unauthorized = await createAcceptanceReportHandler(services(unauthorizedCalls))(request({ primaryDomain: "myjam.co.uk", plan: "starter" }, "Bearer wrong"));
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(unauthorizedCalls, []);

  for (const [plan, comparisonTarget] of [["starter", 20], ["solo", 50], ["growth", 500], ["agency", 1_000]]) {
    const calls = [];
    const response = await createAcceptanceReportHandler(services(calls))(request({ primaryDomain: "myjam.co.uk", plan }));
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.report.plan, plan);
    assert.equal(payload.report.comparisonTarget, comparisonTarget);
    assert.equal(payload.report.productTargetKind, "pairs");
    assert.deepEqual(calls[0], ["create", { primaryDomain: "myjam.co.uk", locale: "en", entitlement: { plan, productLimit: comparisonTarget } }]);
    assert.equal(calls[1][1].metadata.productTargetKind, "pairs");
    assert.equal(calls[2][0], "dispatch");
    assert.deepEqual(calls[3], ["mark-dispatched", PUBLIC_ID, "run_acceptance1"]);
  }
});

test("acceptance report creation rejects malformed plans and sanitizes dispatch failures", async () => {
  for (const plan of ["enterprise", "toString", "constructor", "valueOf", "hasOwnProperty"]) {
    const invalid = await createAcceptanceReportHandler(services([]))(request({ primaryDomain: "myjam.co.uk", plan }));
    assert.equal(invalid.status, 400);
  }

  const calls = [];
  const failing = services(calls);
  failing.dispatch = async () => { throw new Error("secret upstream response"); };
  const response = await createAcceptanceReportHandler(failing)(request({ primaryDomain: "myjam.co.uk", plan: "starter" }));
  assert.equal(response.status, 503);
  assert.deepEqual(calls.at(-1), ["mark-failed", PUBLIC_ID]);
  assert.doesNotMatch(JSON.stringify(await response.json()), /secret|upstream/i);
});

test("a dispatched acceptance report stays accepted when dispatch telemetry races", async () => {
  const calls = [];
  const racing = services(calls);
  racing.markDispatched = async () => { throw new Error("temporary telemetry failure"); };
  const response = await createAcceptanceReportHandler(racing)(request({ primaryDomain: "myjam.co.uk", plan: "starter" }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).job.runId, "run_acceptance1");
  assert.equal(calls.some(([name]) => name === "mark-failed"), false);
});
