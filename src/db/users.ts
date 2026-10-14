/**
 * Accounts.
 *
 * Deliberately the whole of it: a username, a salted SHA-256 of the password, and a unique
 * constraint on the lower-cased name that is the real guarantee nobody else's name can be taken.
 * There is no server here, so there is nowhere to rate-limit a login or expire a session, and this
 * is a test build; see AUTH_AND_DATABASE_PLAN.md §7 before reusing any of this.
 */

import { eq } from 'drizzle-orm';
import type { Database } from './client';
import { isUniqueViolation, users } from './schema';

/** What the app shows about an account. Deliberately not the hash or the salt. */
export type User = {
  id: string;
  username: string;
  createdAt: string;
};

/** Raised when the name is already registered. The UI shows this message and nothing else. */
export class UsernameTakenError extends Error {
  constructor(public readonly username: string) {
    super(`The username “${username}” is already taken.`);
    this.name = 'UsernameTakenError';
  }
}

/** Raised when a name or password is not something we will store. */
export class InvalidCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export const MAX_USERNAME = 32;
const MIN_PASSWORD = 4;

/**
 * The form a name is looked up by. Trimmed and lower-cased, which is what the unique constraint is
 * on, so "Ann", " ann " and "ANN" are one account.
 */
const usernameKey = (username: string): string => username.trim().toLowerCase();

/** The name as displayed: trimmed, but the capitalisation the user chose. */
const displayName = (username: string): string => username.trim();

const checkUsername = (username: string): string => {
  const name = displayName(username);
  if (!name) throw new InvalidCredentialsError('Enter a username.');
  if (name.length > MAX_USERNAME) throw new InvalidCredentialsError(`A username can be at most ${MAX_USERNAME} characters.`);
  // Control characters would end up in the UI and in any future file name.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new InvalidCredentialsError('That username has characters we cannot store.');
  return name;
};

const checkPassword = (password: string): string => {
  if (password.length < MIN_PASSWORD) {
    throw new InvalidCredentialsError(`A password needs at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 200) throw new InvalidCredentialsError('That password is too long.');
  return password;
};

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

const randomSalt = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
};

/** SHA-256 over the salt and the password, so the stored value is not the password. */
export const hashPassword = async (password: string, salt: string): Promise<string> => {
  const data = new TextEncoder().encode(salt + password);
  return toHex(await crypto.subtle.digest('SHA-256', data));
};

const toUser = (row: typeof users.$inferSelect | undefined): User | null =>
  row ? { id: row.id, username: row.username, createdAt: row.createdAt } : null;

/** Looks up an account by name, or null. */
export async function findByUsername(db: Database, username: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.usernameKey, usernameKey(username))).limit(1);
  return toUser(row);
}

/** Looks up an account by id, or null. Used to restore a sign-in on launch. */
export async function findById(db: Database, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return toUser(row);
}

/**
 * Registers an account.
 *
 * The lookup is for a friendly message; the unique index is the guarantee. If two sign-ups race,
 * the constraint violation arrives as the same error rather than a crash.
 */
export async function createUser(db: Database, username: string, password: string): Promise<User> {
  const name = checkUsername(username);
  checkPassword(password);

  if (await findByUsername(db, name)) throw new UsernameTakenError(name);

  const user = { id: crypto.randomUUID(), username: name, createdAt: new Date().toISOString() };
  const salt = randomSalt();
  try {
    await db.insert(users).values({
      id: user.id,
      username: user.username,
      usernameKey: usernameKey(name),
      passwordHash: await hashPassword(password, salt),
      salt,
      createdAt: user.createdAt,
    });
  } catch (e) {
    // Losing the race against a concurrent sign-up still means the name is taken.
    if (isUniqueViolation(e)) throw new UsernameTakenError(name);
    throw e;
  }
  return user;
}

/**
 * Checks a name and password and returns the account, or null.
 * A wrong name and a wrong password are indistinguishable to the caller on purpose.
 */
export async function verifyPassword(db: Database, username: string, password: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.usernameKey, usernameKey(username))).limit(1);
  if (!row) return null;
  const hash = await hashPassword(password, row.salt);
  const matches = timingSafeEqual(hash, row.passwordHash);
  return matches ? toUser(row) : null;
}

/** Byte-for-byte comparison, without the early exit a `===` on strings would give. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The unique index on the lower-cased name, however the driver chose to word it.
 *
 * Re-exported from the schema module, which also owns the error-chain walk Drizzle's wrapper makes
 * necessary.
 */
export { isUniqueViolation };
