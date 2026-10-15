/**
 * The database schema, as the single source of truth.
 *
 * `db/migrations/` is generated from this file by `pnpm db:generate`, and applied by
 * `pnpm db:migrate` or automatically at start-up (see src/db/client.ts). Nothing hand-writes a
 * migration, so an existing database cannot silently miss a new column.
 */

import { sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  /** The name as typed (trimmed), shown back to the person who owns it. */
  username: text('username').notNull(),
  /**
   * The same name lower-cased, and the one that is unique.
   *
   * A column-level `COLLATE NOCASE` would do this in SQLite, but it is not expressible through
   * Drizzle's SQLite schema and would quietly depend on the driver. A stored key is explicit and
   * behaves the same everywhere.
   */
  usernameKey: text('username_key').notNull().unique(),
  /** SHA-256(salt + password) hex. Never the password itself. */
  passwordHash: text('password_hash').notNull(),
  salt: text('salt').notNull(),
  createdAt: text('created_at').notNull(),
});

export const labels = sqliteTable(
  'labels',
  {
    id: text('id').primaryKey(),
    /** Every read and write is filtered by this, so one account cannot reach another's labels. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Shown in the label picker. */
    name: text('name').notNull(),
    /** File-name-shaped id, unique per account, and what the rest of the app calls a label id. */
    slug: text('slug').notNull(),
    /** The two halves of a LabelBundle, as JSON text. */
    template: text('template').notNull(),
    generator: text('generator').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    // Mirrors the UNIQUE (user_id, slug) the hand-written schema had.
    uniqueIndex('labels_user_slug').on(table.userId, table.slug),
    // Every read is "this user's labels, newest first", which is exactly this index.
    index('labels_by_user').on(table.userId, table.updatedAt),
  ],
);

export const schema = { users, labels };

/** A database typed against this schema. */
export type Database = LibSQLDatabase<typeof schema>;

/** A unique index was violated, however the driver chose to word it. */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(errorChain(e));
}

/**
 * Every message in an error's cause chain, joined.
 *
 * Drizzle wraps a driver error in its own, and puts the SQL and parameters in that message — so
 * the real reason is further down. Matching on the outer message alone silently finds nothing,
 * which is how a duplicate name ends up as an unhandled crash instead of a message.
 */
export function errorChain(e: unknown, limit = 6): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let i = 0; current && i < limit; i++) {
    const asError = current as { message?: unknown; cause?: unknown };
    if (typeof asError.message === 'string') parts.push(asError.message);
    current = asError.cause;
  }
  return parts.join(' | ');
}

/** Turns any driver error into a message worth showing. */
export function friendlyError(e: unknown): string {
  const raw = errorChain(e);
  if (/fetch failed|network|Failed to fetch|load failed/i.test(raw)) {
    return 'Could not reach the database. Check the connection and try again.';
  }
  if (/Unauthorized|unauthorized|401|403/i.test(raw)) {
    return 'The database refused the request. The token may be wrong or has been revoked.';
  }
  if (/UNIQUE constraint failed: users\.username_key/i.test(raw)) {
    return 'That username is already taken.';
  }
  return e instanceof Error ? e.message : String(e);
}

/** Re-exported so callers do not need drizzle-orm directly for the odd raw statement. */
export { sql };
