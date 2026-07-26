import path from "node:path";

export function requireAbsolutePath(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

export function assertHealthyBackup(database, backupPath) {
  const check = database.prepare("PRAGMA quick_check").pluck().get();
  if (check !== "ok") {
    throw new Error(`SQLite integrity check failed for ${backupPath}: ${String(check)}`);
  }
}
