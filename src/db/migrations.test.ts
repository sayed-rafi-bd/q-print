import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDb, createTestDb, type TestDb } from './testDb';
import { MIGRATIONS, migrate, pendingMigrations, splitStatements } from './migrations';

let test: TestDb;

/** A migrated database, for the "already applied" cases. */
beforeEach(async () => { test = await createTestDb('migrations'); });
afterEach(() => test.close());

/** Replaces `test` with a database that has nothing applied at all. */
function useEmptyDb(): void {
  test.close();
  test = createEmptyDb('migrations-empty');
}

/** The raw connection, for counting what is in the database. */
const raw = () => ({ execute: async (stmt: { sql: string; args?: (string | number | null)[] }) => {
  const rs = await test.client.execute(stmt.sql, stmt.args ?? []);
  return { rows: rs.rows as Record<string, string | number | null>[] };
} });

describe('splitStatements', () => {
  it('splits on the marker rather than on semicolons', () => {
    expect(splitStatements('CREATE TABLE a (x text);--> statement-breakpoint\nCREATE INDEX i ON a (x);'))
      .toEqual(['CREATE TABLE a (x text);', 'CREATE INDEX i ON a (x);']);
  });

  it('keeps a semicolon inside a statement', () => {
    expect(splitStatements('CREATE TRIGGER t BEGIN SELECT 1; END;')).toHaveLength(1);
  });

  it('drops blank input and comment-only chunks', () => {
    expect(splitStatements('-- just a note\n\n--> statement-breakpoint\n   ')).toEqual([]);
  });
});

describe('migrate', () => {
  it('has migrations bundled, or nothing below means anything', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS.every(m => m.name.endsWith('.sql'))).toBe(true);
  });

  it('applies every migration to a database that has none', async () => {
    useEmptyDb();
    const applied = await migrate(raw());
    expect(applied).toEqual(MIGRATIONS.map(m => m.name));
  });

  it('builds a working schema from an empty database', async () => {
    useEmptyDb();
    await migrate(raw());
    expect(await listTables()).toEqual(expect.arrayContaining(['users', 'labels', '__migrations']));
    const columns = await test.client.execute('PRAGMA table_info(users)');
    expect(columns.rows.map(r => String(r.name))).toContain('username_key');
  });

  it('is a no-op the second time, which is what makes it safe at start-up', async () => {
    useEmptyDb();
    await migrate(raw());
    expect(await migrate(raw())).toEqual([]);
  });

  it('records what it applied, so the next run can tell', async () => {
    await migrate(raw());
    const { rows } = await test.client.execute('SELECT name FROM __migrations ORDER BY name');
    expect(rows.map(r => String(r.name))).toEqual(MIGRATIONS.map(m => m.name).sort());
  });

  it('leaves the schema in place when run repeatedly', async () => {
    await migrate(raw());
    await migrate(raw());
    await migrate(raw());
    const rows = await listTables();
    expect(rows).toEqual(expect.arrayContaining(['users', 'labels', '__migrations']));
  });

  it('reports nothing pending once it has run', async () => {
    expect(await pendingMigrations(raw())).toEqual([]);
  });

  it('reports what is pending before anything has run', async () => {
    useEmptyDb();
    expect(await pendingMigrations(raw())).toEqual(MIGRATIONS.map(m => m.name));
  });

  it('gives the tests a schema with a case-insensitive name key', async () => {
    const columns = await test.client.execute('PRAGMA table_info(users)');
    // A lower-cased key column is what makes a name case-insensitively unique.
    expect(columns.rows.map(r => String(r.name))).toContain('username_key');
  });
});

async function listTables(): Promise<string[]> {
  const rs = await test.client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  return rs.rows.map(r => String(r.name));
}
