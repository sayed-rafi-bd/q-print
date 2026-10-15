/**
 * The app's connection to the database.
 *
 * Everything goes through this so the URL and token are read in one place, and so a missing or
 * unreachable database produces a message a person can act on rather than a stack trace.
 */

import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from './migrations';
import { type Database, schema } from './schema';
import type { Db } from './types';

const URL = import.meta.env.VITE_TURSO_URL as string | undefined;
const TOKEN = import.meta.env.VITE_TURSO_TOKEN as string | undefined;

/** False when the build has no credentials, which is the usual reason nothing loads. */
export const isDbConfigured = (): boolean => Boolean(URL && TOKEN);

let raw: Client | null = null;
let connected: Database | null = null;

function newClient(): Client {
  if (!isDbConfigured()) {
    throw new Error(
      'The database is not set up. Copy .env.example to .env, fill in VITE_TURSO_URL and ' +
        'VITE_TURSO_TOKEN, and restart the dev server.',
    );
  }
  // The WebView talks to Turso over HTTP, so the `libsql://` form has to be rewritten. A URL that
  // was pasted straight from the console works either way this way round.
  return createClient({
    url: (URL as string).replace(/^libsql:\/\//, 'https://'),
    authToken: TOKEN as string,
  });
}

/** The raw connection, for the migration runner and the tests. */
export function getClient(): Client {
  if (!raw) raw = newClient();
  return raw;
}

/** The typed database the app queries. */
export function getDb(): Database {
  if (!connected) connected = drizzle(getClient(), { schema });
  return connected;
}

/**
 * Brings the database up to date, applying any migration generated since it was last run.
 *
 * Called once at start-up so an existing database cannot be left without a new column. The
 * migration is idempotent, so this is a cheap no-op once everything is applied.
 */
export async function migrateDb(): Promise<string[]> {
  return migrate({ execute: async (stmt) => getClient().execute(stmt) as never });
}

/** Forgets the connection, so a later call picks up a changed URL. */
export function resetDb(): void {
  raw = null;
  connected = null;
}

/**
 * Points the app at a specific connection.
 *
 * The app itself never calls this: it exists so the code above `src/db/client.ts` — which reaches
 * for the connection itself rather than taking one — can be tested against a local file without
 * a Turso URL in the environment.
 */
export function setDb(next: Database | null): void {
  connected = next;
}

export type { Database, Db };
