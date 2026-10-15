/**
 * Applies the migrations in `db/migrations` to a database.
 *
 * Drizzle generates those files from `src/db/schema.ts`, but its own migrator reads them from the
 * filesystem, which a WebView cannot do. This runs them the same way everywhere instead: the SQL is
 * bundled, and what has already been applied is recorded in `__migrations`. The tests use this too,
 * so there is exactly one apply path rather than one for Node and another for the app.
 *
 * A migration that fails part-way is not recorded, so the next start tries it again. They are not
 * individually re-runnable — Drizzle generates plain CREATE TABLE — which is fine, because the
 * record is what stops a second run, not the SQL.
 */

import type { Db } from './types';

// Bundled at build time. Sorting by file name gives the order they were generated in, because
// drizzle numbers them 0000, 0001, ... .
const files = import.meta.glob<string>('../../db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const MIGRATIONS: { name: string; sql: string }[] = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

const TRACKING = `
  CREATE TABLE IF NOT EXISTS __migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`;

/** Applies anything outstanding. Returns the names it applied, in order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.execute({ sql: TRACKING });

  const { rows } = await db.execute({ sql: 'SELECT name FROM __migrations' });
  const done = new Set(rows.map((r) => String(r.name)));

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue;
    for (const statement of splitStatements(migration.sql)) {
      await db.execute({ sql: statement });
    }
    await db.execute({
      sql: 'INSERT INTO __migrations (name, applied_at) VALUES (?, ?)',
      args: [migration.name, new Date().toISOString()],
    });
    applied.push(migration.name);
  }
  return applied;
}

/** What is still outstanding, for a message rather than for running. */
export async function pendingMigrations(db: Db): Promise<string[]> {
  await db.execute({ sql: TRACKING });
  const { rows } = await db.execute({ sql: 'SELECT name FROM __migrations' });
  const done = new Set(rows.map((r) => String(r.name)));
  return MIGRATIONS.filter((m) => !done.has(m.name)).map((m) => m.name);
}

/**
 * Drizzle separates statements with a marker rather than semicolons, so that a statement may
 * contain one. Blank lines and comments go, so a file of only those is not run.
 */
export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}
