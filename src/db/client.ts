/**
 * The app's connection to the database.
 *
 * Everything goes through this so the URL and token are read in one place, and so a missing or
 * unreachable database produces a message a person can act on rather than a stack trace.
 */

import { createClient } from '@libsql/client/web';
import type { Db } from './types';

const URL = import.meta.env.VITE_TURSO_URL as string | undefined;
const TOKEN = import.meta.env.VITE_TURSO_TOKEN as string | undefined;

/** False when the build has no credentials, which is the usual reason nothing loads. */
export const isDbConfigured = (): boolean => Boolean(URL && TOKEN);

let client: Db | null = null;

export function getDb(): Db {
  if (client) return client;
  if (!isDbConfigured()) {
    throw new Error(
      'The database is not set up. Copy .env.example to .env, fill in VITE_TURSO_URL and ' +
      'VITE_TURSO_TOKEN, and restart the dev server.',
    );
  }
  // The WebView talks to Turso over HTTP, so the `libsql://` form has to be rewritten. A URL that
  // was pasted straight from the console works either way this way round.
  client = createClient({
    url: (URL as string).replace(/^libsql:\/\//, 'https://'),
    authToken: TOKEN as string,
  }) as unknown as Db;
  return client;
}

/** Forgets the connection, so a later call picks up a changed URL. Used by tests and nothing else. */
export function resetDb(): void {
  client = null;
}

/**
 * Points the app at a specific connection.
 *
 * The app itself never calls this: it exists so the code above `src/db/client.ts` — which reaches
 * for the connection itself rather than taking one — can be tested against a local file without
 * a Turso URL in the environment.
 */
export function setDb(next: Db | null): void {
  client = next;
}

/**
 * Turns a driver error into something worth showing. Turso surfaces a network failure as a fetch
 * rejection, which otherwise reads as "Unknown error".
 */
export function dbErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/fetch failed|network|Failed to fetch|load failed/i.test(raw)) {
    return 'Could not reach the database. Check the connection and try again.';
  }
  if (/Unauthorized|unauthorized|401|403/i.test(raw)) {
    return 'The database refused the request. The token may be wrong or has been revoked.';
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return 'That name is already taken.';
  }
  return raw;
}
