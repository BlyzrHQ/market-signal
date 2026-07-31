import path from "node:path";

import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRun, purgeExpiredReports } from "../app/lib/report-store.ts";

const backupPath = path.resolve(process.argv[2] || "");
if (!path.isAbsolute(backupPath) || !backupPath) throw new Error("A restored SQLite backup path is required.");

const database = await NodeSqliteDatabase.open(backupPath);
const tables = ["report_quality_signals", "report_evaluations", "report_ads", "report_matches", "report_products", "report_companies", "report_fact_chunks", "report_fact_manifests", "report_documents", "report_events", "report_runs"];
const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => {
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).all();
  return [table, Number(result.results?.[0]?.count || 0)];
})));

try {
  const baseline = await counts();
  const now = new Date();
  await createReportRun({ primaryDomain: "retention-validation.invalid" }, new Date("2020-01-01T00:00:00.000Z"), database);
  const result = await purgeExpiredReports(now, database);
  const restored = await counts();
  if (result.deleted.runs !== 1 || result.deleted.events !== 1 || result.remaining !== 0) throw new Error("The restored backup did not purge exactly the injected expired report.");
  for (const table of tables) if (restored[table] !== baseline[table]) throw new Error(`Retention changed pre-existing ${table} rows.`);
  process.stdout.write(`${JSON.stringify({ integrity: "ok", injectedExpiredRunsPurged: 1, preExistingRowsPreserved: true, deleted: result.deleted })}\n`);
} finally {
  database.close();
}
