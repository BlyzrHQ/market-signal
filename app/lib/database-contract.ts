export type DatabasePreparedStatement = {
  bind(...values: unknown[]): DatabasePreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

export type ApplicationDatabase = {
  prepare(query: string): DatabasePreparedStatement;
  batch(statements: DatabasePreparedStatement[]): Promise<unknown[]>;
};
