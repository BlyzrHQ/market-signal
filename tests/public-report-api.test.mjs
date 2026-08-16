import assert from "node:assert/strict";
import test from "node:test";

import { publicReportPayload } from "../app/api/reports/[publicId]/route.ts";

test("public reports omit internal workspace and billing reservation identifiers", () => {
  const report = publicReportPayload({
    run: { id: "run-1", publicId: "a".repeat(32), workspaceId: "workspace-secret", billingReservationId: "reservation-secret", status: "running" },
    events: [],
  });
  assert.equal(Object.hasOwn(report.run, "workspaceId"), false);
  assert.equal(Object.hasOwn(report.run, "billingReservationId"), false);
  assert.equal(report.run.publicId, "a".repeat(32));
});
