/**
 * The tiny slice of a database client that this app uses.
 *
 * Declaring it here rather than importing `@libsql/client`'s types keeps the query modules free of
 * the driver, so they can be pointed at Turso in the app, at a throwaway local file in tests, or at
 * a stub, without changing a line of the logic under test.
 */

export type SqlValue = string | number | null;

/** One row, as returned. Column names are as written in the SELECT. */
export type Row = Record<string, SqlValue>;

export type Statement = {
  sql: string;
  /** Values for the `?` placeholders, in order. */
  args?: SqlValue[];
};

export interface Db {
  execute(stmt: Statement): Promise<{ rows: Row[] }>;
}

/** Reads a column as text, or null. SQLite is dynamically typed, so rows are cast at the edge. */
export const str = (row: Row | undefined, key: string): string | null => {
  const v = row?.[key];
  return v === null || v === undefined ? null : String(v);
};

/** Reads a column as text, falling back to `fallback` for null/undefined. */
export const strOr = (row: Row | undefined, key: string, fallback: string): string => str(row, key) ?? fallback;

/** The single row a query that matched one thing returns, or null. */
export const one = (rows: Row[]): Row | null => rows[0] ?? null;
