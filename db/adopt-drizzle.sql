-- One-time: adopt Drizzle on a database that already exists.
--
-- The live database was created by the hand-written db/schema.sql before Drizzle was added. Its
-- `users` table is the same apart from two differences:
--
--   1. no `username_key` column (case-insensitive uniqueness used to come from
--      `username ... COLLATE NOCASE`, which Drizzle cannot express);
--   2. it still carries that old `UNIQUE COLLATE NOCASE` on `username`, which the generated
--      migration does not have. That constraint is a strict superset of the new one, so it is left
--      in place rather than rebuilt: dropping it needs a table rebuild, which is not a risk worth
--      taking over a database that has somebody's work in it. Drizzle compares against its own
--   snapshot, not the live database, so the extra constraint does not affect future migrations.
--
-- Safe to run against an empty or a populated database: it only adds a column, fills it in and
-- indexes it. Nothing is dropped.
--
-- This has already been applied to the shared database. It is kept for the record and for anyone
-- running a copy of this app against a database from before 15 Oct 2026.

ALTER TABLE users ADD COLUMN username_key TEXT;

UPDATE users SET username_key = lower(trim(username));

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key_unique ON users (username_key);

-- `labels` already matches the generated migration (UNIQUE (user_id, slug) and labels_by_user), so
-- there is nothing to do for it.
