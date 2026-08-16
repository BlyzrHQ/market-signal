import type { ApplicationDatabase } from "./database-contract.ts";

const nodeDatabases = new Map<string, Promise<ApplicationDatabase>>();

function sqlitePath() {
  return String(process.env.MARKET_SIGNAL_SQLITE_PATH || "").trim();
}

async function nodeDatabase(path: string) {
  const { canonicalNodeSqlitePath, NodeSqliteDatabase } = await import("./node-sqlite-database.ts");
  const canonicalPath = await canonicalNodeSqlitePath(path);
  let database = nodeDatabases.get(canonicalPath);
  if (!database) {
    database = NodeSqliteDatabase.open(canonicalPath);
    nodeDatabases.set(canonicalPath, database);
    database.catch(() => nodeDatabases.delete(canonicalPath));
  }
  return database;
}

export async function runtimeDatabaseResult(): Promise<{
  database: ApplicationDatabase | null;
  diagnosticCode: "database-path-missing" | "";
}> {
  const path = sqlitePath();
  if (path) return { database: await nodeDatabase(path), diagnosticCode: "" };
  return { database: null, diagnosticCode: "database-path-missing" };
}

export async function runtimeDatabase() {
  return (await runtimeDatabaseResult()).database;
}

export async function closeRuntimeDatabases() {
  const databases = [...nodeDatabases.values()];
  nodeDatabases.clear();
  await Promise.all(databases.map(async (pending) => {
    const database = await pending.catch(() => null);
    if (database && "close" in database && typeof database.close === "function") database.close();
  }));
}
