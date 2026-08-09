import assert from "node:assert/strict";
import test from "node:test";

import { reportEvaluationPilotEnabled } from "../app/lib/report-evaluation-dispatch.ts";

test("evaluation pilot remains globally disabled by default", async () => {
  assert.equal(await reportEvaluationPilotEnabled("myjam.co.uk", { enabled: "false", domains: "myjam.co.uk" }), false);
});

test("evaluation pilot domain allowlist gates terminal report dispatch", async () => {
  const overrides = { enabled: "true", domains: " MYJAM.CO.UK, noororganic.com, invalid value " };
  assert.equal(await reportEvaluationPilotEnabled("myjam.co.uk", overrides), true);
  assert.equal(await reportEvaluationPilotEnabled("MYJAM.CO.UK", overrides), true);
  assert.equal(await reportEvaluationPilotEnabled("noororganic.com", overrides), true);
  assert.equal(await reportEvaluationPilotEnabled("example.com", overrides), false);
  assert.equal(await reportEvaluationPilotEnabled(undefined, overrides), false);
  assert.equal(await reportEvaluationPilotEnabled("myjam.co.uk", { enabled: "true", domains: "invalid value,," }), false);
});

test("an enabled pilot without an allowlist preserves the explicit global mode", async () => {
  assert.equal(await reportEvaluationPilotEnabled("example.com", { enabled: "true", domains: "" }), true);
  assert.equal(await reportEvaluationPilotEnabled(undefined, { enabled: "true", domains: "" }), true);
});
