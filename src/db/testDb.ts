/**
 * A throwaway SQLite file with the real migrations applied, for tests.
 *
 * The tests run against actual SQL rather than a stub, and build their schema with the same
 * migration runner the app uses, so a migration that is wrong fails here too.
 */

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './migrations';
import { schema, type Database } from './schema';

export type TestDb = {
  db: Database;
  client: Client;
  close: () => void;
};

function openFile(name: string): { client: Client; db: Database; close: () => void } {
  const file = join(tmpdir(), `q-print-${name}-${process.pid}.db`);
  rmSync(file, { force: true });
  const client = createClient({ url: `file:${file}` });
  return {
    client,
    db: drizzle(client, { schema }),
    close: () => {
      client.close();
      rmSync(file, { force: true });
    },
  };
}

/** An empty database, with nothing applied. For testing the migrations themselves. */
export function createEmptyDb(name: string): TestDb {
  return openFile(name);
}

/** A database with the app's migrations applied, which is what the tests query. */
export async function createTestDb(name: string): Promise<TestDb> {
  const test = openFile(name);
  await migrate({ execute: async stmt => test.client.execute(stmt) as never });
  return test;
}
