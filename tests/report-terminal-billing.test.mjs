import assert from "node:assert/strict";
import test from "node:test";

import { reservationOutcomeForReportStatus } from "../app/lib/report-terminal-billing.ts";

test("only irreversible terminal report states settle billing reservations", () => {
  assert.equal(reservationOutcomeForReportStatus("complete"), "committed");
  assert.equal(reservationOutcomeForReportStatus("limited"), "committed");
  assert.equal(reservationOutcomeForReportStatus("failed"), "released");
  assert.equal(reservationOutcomeForReportStatus("interrupted"), null);
  assert.equal(reservationOutcomeForReportStatus("running"), null);
});
