import assert from "node:assert/strict";
import test from "node:test";

import { reportEvaluationDispatchKey, reportEvaluationPilotEnabled } from "../app/lib/report-evaluation-dispatch.ts";

const REPORT_ID = "a".repeat(32);
const OTHER_REPORT_ID = "b".repeat(32);
const pilot = { enabled: "true", domains: "myjam.co.uk", reportIds: REPORT_ID };

test("evaluation pilot remains disabled when the kill switch is off", async () => {
  assert.equal(await reportEvaluationPilotEnabled({ primaryDomain: "myjam.co.uk", publicReportId: REPORT_ID }, { ...pilot, enabled: "false" }), false);
});

test("evaluation pilot requires both an exact domain and exact public report ID", async () => {
  assert.equal(await reportEvaluationPilotEnabled({ primaryDomain: "myjam.co.uk", publicReportId: REPORT_ID }, pilot), true);
  assert.equal(await reportEvaluationPilotEnabled({ primaryDomain: "MYJAM.CO.UK", publicReportId: REPORT_ID.toUpperCase() }, pilot), true);
  assert.equal(await reportEvaluationPilotEnabled({ primaryDomain: "example.com", publicReportId: REPORT_ID }, pilot), false);
  assert.equal(await reportEvaluationPilotEnabled({ primaryDomain: "myjam.co.uk", publicReportId: OTHER_REPORT_ID }, pilot), false);
  assert.equal(await reportEvaluationPilotEnabled({}, pilot), false);
});

test("missing or malformed pilot scope fails closed", async () => {
  const context = { primaryDomain: "myjam.co.uk", publicReportId: REPORT_ID };
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "", reportIds: REPORT_ID }), false);
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "myjam.co.uk", reportIds: "" }), false);
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "invalid value", reportIds: REPORT_ID }), false);
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "myjam.co.uk", reportIds: "invalid-id" }), false);
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "myjam.co.uk", reportIds: `${REPORT_ID},${OTHER_REPORT_ID}` }), false);
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "__all__", reportIds: REPORT_ID }), false);
  assert.equal(await reportEvaluationPilotEnabled(context, { enabled: "true", domains: "myjam.co.uk", reportIds: "__all__" }), false);
});

test("each bounded dispatch attempt has its own external idempotency identity", () => {
  const first = reportEvaluationDispatchKey({ evaluationId: "evaluation-1", evaluatorVersion: "agent-v1", dispatchAttempt: 1 });
  const retry = reportEvaluationDispatchKey({ evaluationId: "evaluation-1", evaluatorVersion: "agent-v1", dispatchAttempt: 2 });
  assert.notEqual(first, retry);
});

test("global evaluation requires matching unmistakable sentinels", async () => {
  assert.equal(await reportEvaluationPilotEnabled({}, { enabled: "true", domains: "__all__", reportIds: "__all__" }), true);
});
