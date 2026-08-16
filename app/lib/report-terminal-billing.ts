import { finishReportReservation, openBillingDatabase } from "./billing-store.ts";
import { hostedBillingEnabled } from "./billing-plans.ts";
import type { ReportRunStatus, StoredReportRun } from "./report-store.ts";

export function reservationOutcomeForReportStatus(status: ReportRunStatus) {
  if (status === "complete" || status === "limited") return "committed" as const;
  if (status === "failed") return "released" as const;
  return null;
}

export async function settleTerminalReportReservation(
  run: Pick<StoredReportRun, "id" | "billingReservationId">,
  status: ReportRunStatus = (run as StoredReportRun).status,
  environment: Record<string, string | undefined> = process.env,
) {
  const outcome = reservationOutcomeForReportStatus(status);
  if (!run.billingReservationId || !outcome || !hostedBillingEnabled(environment)) return false;
  const database = await openBillingDatabase();
  try {
    return finishReportReservation(database, run.billingReservationId, outcome, run.id);
  } finally {
    database.close();
  }
}
