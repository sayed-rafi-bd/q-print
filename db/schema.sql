-- Schema for the q-print database (Turso / SQLite).
--
-- Apply once with the Turso CLI or the web console:
--   turso db execute q-print-sar-dev < db/schema.sql
-- or paste it into https://turso.app. Every statement is IF NOT EXISTS, so it is safe to re-run.
--
-- There is no server, so this file is the only definition of the shape. The tests in
-- src/db/*.test.ts apply it to a throwaway local file, so the two can never drift.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  -- NOCASE so "Ann" and "ann" are the same account and a taken name is genuinely taken.
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  -- SHA-256(salt + password) hex. Never the password itself.
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id         TEXT NOT NULL PRIMARY KEY,   -- uuid, unrelated to the old per-file slug
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,               -- shown in the label picker
  slug       TEXT NOT NULL,               -- file-name-shaped id, unique per user
  -- The two halves of a LabelBundle, as JSON text, so export/import keeps working unchanged.
  template   TEXT NOT NULL,
  generator  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, slug)
);

-- Every read is "this user's labels, newest first", which is exactly this index.
CREATE INDEX IF NOT EXISTS labels_by_user ON labels (user_id, updated_at DESC);
