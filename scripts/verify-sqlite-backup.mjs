import fs from "node:fs";
import Database from "better-sqlite3";
import { assertHealthyBackup, requireAbsolutePath } from "./sqlite-backup-utils.mjs";

const backupPath = requireAbsolutePath(
  process.argv[2] || process.env.MARKET_SIGNAL_BACKUP_PATH,
  "backup path",
);

if (!fs.existsSync(backupPath)) {
  throw new Error(`SQLite backup does not exist: ${backupPath}`);
}

const database = new Database(backupPath, { readonly: true, fileMustExist: true });
try {
  assertHealthyBackup(database, backupPath);
} finally {
  database.close();
}

process.stdout.write(`${JSON.stringify({ backup: backupPath, integrity: "ok" })}\n`);
