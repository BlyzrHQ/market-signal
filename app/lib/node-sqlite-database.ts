import type Database from "better-sqlite3";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { ApplicationDatabase, DatabasePreparedStatement } from "./database-contract.ts";

const BUSY_TIMEOUT_MS = 10_000;
const SQLITE_DRIVER_PACKAGE = "better-sqlite3";

async function loadDatabaseConstructor() {
  const driverModule = await import(/* @vite-ignore */ SQLITE_DRIVER_PACKAGE);
  return driverModule.default;
}

export async function canonicalNodeSqlitePath(databasePath: string) {
  if (!databasePath || !isAbsolute(databasePath) || databasePath.includes("\0")) {
    throw new Error("MARKET_SIGNAL_SQLITE_PATH must be an absolute filesystem path.");
  }
  const resolvedPath = normalize(resolve(databasePath));
  const parent = dirname(resolvedPath);
  const parentStatus = await stat(parent).catch(() => null);
  if (!parentStatus?.isDirectory()) {
    throw new Error("The parent directory for MARKET_SIGNAL_SQLITE_PATH does not exist.");
  }
  return join(await realpath(parent), basename(resolvedPath));
}

class NodeSqliteStatement implements DatabasePreparedStatement {
  private values: unknown[] = [];
  private readonly database: Database.Database;
  private readonly query: string;

  constructor(database: Database.Database, query: string) {
    this.database = database;
    this.query = query;
  }

  bind(...values: unknown[]) {
    // Current application callers prepare once and bind once. This intentionally
    // exposes only the D1 subset they use; it does not emulate reusable D1
    // statement clones or boolean coercion.
    this.values = values;
    return this;
  }

  async all<T = Record<string, unknown>>() {
    const statement = this.database.prepare(this.query);
    if (!statement.reader) throw new Error("Only a query that returns rows can use all().");
    return { results: statement.all(...this.values) as T[] };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const statement = this.database.prepare(this.query);
    return statement.reader
      ? { results: statement.all(...this.values) }
      : statement.run(...this.values);
  }

  belongsTo(database: Database.Database) {
    return this.database === database;
  }
}

export class NodeSqliteDatabase implements ApplicationDatabase {
  private readonly database: Database.Database;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static async open(databasePath: string) {
    const resolvedPath = await canonicalNodeSqlitePath(databasePath);
    const DatabaseConstructor = await loadDatabaseConstructor();
    const database = new DatabaseConstructor(resolvedPath);
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    return new NodeSqliteDatabase(database);
  }

  prepare(query: string) {
    return new NodeSqliteStatement(this.database, query);
  }

  async batch(statements: DatabasePreparedStatement[]) {
    if (!statements.every((statement) => statement instanceof NodeSqliteStatement && statement.belongsTo(this.database))) {
      throw new Error("SQLite batches can contain only statements prepared by the same Node adapter.");
    }
    const transaction = this.database.transaction((items: NodeSqliteStatement[]) => items.map((statement) => statement.execute()));
    return transaction.immediate(statements as NodeSqliteStatement[]);
  }

  close() {
    this.database.close();
  }
}
