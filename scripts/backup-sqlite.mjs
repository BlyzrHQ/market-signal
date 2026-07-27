import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { assertHealthyBackup, requireAbsolutePath } from "./sqlite-backup-utils.mjs";

const sourcePath = requireAbsolutePath(
  process.env.MARKET_SIGNAL_SQLITE_PATH,
  "MARKET_SIGNAL_SQLITE_PATH",
);
const backupDir = requireAbsolutePath(
  process.env.MARKET_SIGNAL_BACKUP_DIR,
  "MARKET_SIGNAL_BACKUP_DIR",
);

if (!fs.existsSync(sourcePath)) {
  throw new Error(`SQLite database does not exist: ${sourcePath}`);
}

fs.mkdirSync(backupDir, { recursive: true, mode: 0o750 });
const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
const destination = path.join(
  backupDir,
  `market-signal-${timestamp}-${randomUUID().slice(0, 8)}.sqlite`,
);
const temporaryDestination = `${destination}.tmp`;

const source = new Database(sourcePath, { fileMustExist: true });
try {
  await source.backup(temporaryDestination);
} finally {
  source.close();
}

const backup = new Database(temporaryDestination, { readonly: true, fileMustExist: true });
try {
  assertHealthyBackup(backup, temporaryDestination);
  backup.close();
  fs.renameSync(temporaryDestination, destination);
} catch (error) {
  try {
    backup.close();
  } catch {
    // Preserve the original backup or integrity error.
  }
  fs.rmSync(temporaryDestination, { force: true });
  throw error;
} finally {
  if (backup.open) backup.close();
}

const size = fs.statSync(destination).size;
process.stdout.write(`${JSON.stringify({ backup: destination, bytes: size, integrity: "ok" })}\n`);
