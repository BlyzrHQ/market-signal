import { finishReportReservation, openBillingDatabase } from "./billing-store.ts";
import { hostedBillingEnabled } from "./billing-plans.ts";
import type { ReportRunStatus, StoredReportRun } from "./report-store.ts";

export async function settleTerminalReportReservation(
  run: Pick<StoredReportRun, "id" | "billingReservationId">,
  status: ReportRunStatus = (run as StoredReportRun).status,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!run.billingReservationId || !["complete", "limited", "failed", "interrupted"].includes(status) || !hostedBillingEnabled(environment)) return false;
  const database = await openBillingDatabase();
  try {
    finishReportReservation(database, run.billingReservationId, status === "complete" || status === "limited" ? "committed" : "released", run.id);
    return true;
  } finally {
    database.close();
  }
}
