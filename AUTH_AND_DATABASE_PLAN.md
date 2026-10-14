# Plan: sign-in + labels in a database (Turso)

Status: proposal · Repo: `q-print` (Tauri 2 + React + pdfme) · Builds on the label registry work

## 1. What changes

Today the app has no backend and no login. Custom labels are one JSON file each in
`app_data_dir()/labels/<id>.json`, read and written by Rust (`src-tauri/src/labels.rs`).

After this work:

- There is a **sign-in screen**. Sign up with a username and password, or sign in with an existing
  one. Taking a username that is already registered stops and says so.
- **Labels live in a Turso database**, one row per label, scoped to the signed-in user.
- Labels move from JSON files to database rows. Each user sees only their own labels.
- **Nothing changes in Rust.** All of it is TypeScript in the webview.

Testing only, deliberately low security — see §7.

## 2. Why Turso fits this

Turso is hosted SQLite with an HTTP interface and an official JavaScript client. That means:

- **No server to write.** No Express app, no deploy pipeline, no instance that can be down in a way
  you have to care about.
- **No Rust.** `@libsql/client/web` is a fetch-based client that runs in the WebView, so
  `src-tauri/src/labels.rs` and its four commands are simply deleted rather than rewritten.
- **Real SQL**, so the schema is inspectable with the Turso CLI or web console while testing.
- A free tier is enough for this.

## 3. Setup you will need to do

1. Create a database at [turso.app](https://turso.app) and note the **database URL**.
2. Create an auth token with write access.
3. Put both in `.env` as `VITE_TURSO_URL` and `VITE_TURSO_TOKEN`.

```bash
# .env
VITE_TURSO_URL=https://your-db-yourname.turso.io
VITE_TURSO_TOKEN=...
```

Both are compiled into the frontend bundle. That is fine for a test build and is called out in §7.
`.env` must be added to `.gitignore` so the token is not committed.

Then apply the schema once, by running `db/schema.sql` (Phase 0 tells you how).

## 4. Schema

```sql
-- db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- case-insensitive, so "Ann" is taken
  password_hash TEXT NOT NULL,                         -- SHA-256(salt + password); never the password
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY,        -- uuid
  user_id    TEXT NOT NULL,           -- every read and write is filtered by this
  name       TEXT NOT NULL,           -- shown in the picker
  slug       TEXT NOT NULL,           -- file-name-shaped id, unique per user
  template   TEXT NOT NULL,           -- pdfme template, as JSON text
  generator  TEXT NOT NULL,           -- generator spec, as JSON text
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS labels_by_user ON labels (user_id, updated_at DESC);
```

A label row is exactly today's `LabelBundle` in three columns, so **the file format does not change**
and export/import keeps working.

## 5. Client structure

| File | Change |
|---|---|
| `db/schema.sql` | **New.** The schema above. |
| `src/db.ts` | **New.** Creates the libSQL client; `query`, `queryOne`, `execute` helpers that take SQL and named args. Every SQL string in the app lives here. |
| `src/db/users.ts` | **New.** `findByUsername`, `createUser`, `verifyPassword`. Owns the duplicate-username check. |
| `src/db/labels.ts` | **New.** `list`, `get`, `create`, `update`, `remove`, each scoped to a user id. |
| `src/AuthProvider.tsx` | **New.** Holds the signed-in user in React state; `signIn`, `signUp`, `signOut`. |
| `src/LoginPage.tsx` | **New.** Username + password, with a sign-up / sign-in toggle. |
| `src/App.tsx` | Renders `LoginPage` until someone is signed in. |
| `src/labels.ts` | `listLabels`/`createLabel`/`renameLabel`/`deleteLabel` call `src/db/labels.ts` instead of `invoke`. `broken` disappears from the result. |
| `src/templateStore.ts` | Load and save labels through the database instead of `load_custom_label`/`save_custom_label`. |
| `src/designer/LabelToolbar.tsx` | The "files that could not be read" panel goes away. |
| `src-tauri/src/labels.rs` | **Deleted.** |
| `src-tauri/src/lib.rs` | Drops `mod labels` and the four command registrations. Keeps the printers, printing and the built-in template override untouched. |

`loadLastLabel` moves from `localStorage` to "most recently updated label for this user", so two
users on one device do not fight over it.

## 6. How sign-in works

No server means no session tokens, and that is fine here.

- **Sign up:** look up the username. If it exists, stop with *"That username is already taken."*
  Otherwise insert. The `UNIQUE` constraint is the real guarantee; if two sign-ups race, the
  constraint violation is caught and reported as the same message rather than crashing.
- **Sign in:** look up the username, hash the entered password with that user's salt and compare.
  Wrong username or wrong password give the same *"Wrong username or password."* so the form does
  not confirm which usernames exist.
- **Staying signed in:** store the user id in `localStorage` and re-read the user from the database
  on launch. If the row is gone, show the login screen again.
- **Passwords are still hashed** (SHA-256 over a per-user random salt, via `crypto.subtle`, no
  dependency). Storing plaintext in a hosted database would be free to avoid and awkward to undo
  later. This is deliberately the whole of it — no key stretching, no rotation, no expiry.

## 7. Security, stated plainly

You said this is for testing and does not need much security. So, explicitly, and so nobody is
surprised later:

- The Turso token is **in the frontend bundle**. Anyone who opens the app can read it and query the
  entire database directly. There is no server to hide it behind.
- **The sign-in screen is a gate, not a security boundary.** It decides whose labels the app shows;
  it does not stop anyone who wants the data.
- Every query filters by `user_id`, so the *app* shows one user their own labels. That correctness
  is enforced and tested. It is not enforced against someone using the token directly.

If this ever leaves a test context, it needs a server in front. Flagged here so the decision is
recorded, not so it blocks the work.

## 8. Migrating the labels you already have

On the first sign-in on a device, if the account has no labels yet **and** `labels/*.json` files
still exist on disk, offer to import them:

> "Found 3 labels saved on this device. Copy them to this account?"

Each becomes a label owned by that account. A local flag records that the import ran, so it cannot
re-run and resurrect deleted labels. The files are **not** deleted — they stay as a backup.

Built-in template overrides (`label-template-product.json`) stay on disk and stay device-local, as
today.

## 9. Phases

**Phase 0 — The database layer (1 day).**
Create the Turso database, write `db/schema.sql`, add `@libsql/client`, write `src/db.ts` and the
first `users.ts` / `labels.ts` queries. Verify with a scratch test that reads and writes a row.
*Done when:* `pnpm test` proves `createUser` refuses a duplicate username.

**Phase 1 — Sign-in (1.5 days).**
`AuthProvider`, `LoginPage`, the gate in `App.tsx`, session restore on launch. Labels still come
from the local JSON files at this point, so this is shippable on its own and easy to eyeball.
*Done when:* you can sign up, be signed out, sign back in, and land on the Print tab.

**Phase 2 — Labels in the database (2 days).**
`labels.ts` CRUD against Turso, per-user scoping, port `src/labels.ts` and `src/templateStore.ts`,
delete `src-tauri/src/labels.rs`.
*Done when:* two accounts on one device see different labels, and labels survive a full reinstall.

**Phase 3 — Migration, tests, docs (1 day).**
The one-time JSON import, the test matrix, `README.md` and `RELEASE.md`.

Rough total **5–6 days**.

## 10. Testing

- **Unit:** duplicate username is refused (both by the check and by the constraint); right password
  accepted, wrong password refused; the stored hash is not the password; `listLabels` returns only
  the given user's labels; two users cannot see each other's labels.
- **Manual:** sign up → sign out → sign in → labels present; sign up twice with the same name →
  clear message; two accounts on one device; delete a label and confirm it stays deleted after a
  reinstall; import existing files once and confirm it does not run again.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The token is in the bundle | Accepted for testing; recorded in §7 |
| Turso unreachable | The app shows a clear error instead of an empty label list |
| `.env` committed with a live token | Add `.env` to `.gitignore` before the first push |
| CORS in the WebView | Use `@libsql/client/web` (fetch-based), not the native client |
| The `UNIQUE` error surfaces as a crash | Caught in `createUser` and shown as the same "already taken" message |

## 12. Decisions taken

1. **One shared database** for everyone testing, not one per person. Simpler to set up; each
   account still sees only its own labels, so people do not read each other's by accident. They can
   still try each other's login on purpose, which is fine for a test build.

## 13. Open questions

- **Delete accounts?** Not in this plan, and not needed unless a test run needs resetting.
- **Should the built-in product label be copyable into a database row per user?** It is code
   today, and *Duplicate* already puts a copy in the database. Current answer: leave it.
