/**
 * Accounts.
 *
 * Deliberately the whole of it: a username, a salted SHA-256 of the password, and a unique
 * constraint that is the real guarantee nobody else's name can be taken. There is no server here,
 * so there is nowhere to rate-limit a login or expire a session, and this is a test build; see
 * AUTH_AND_DATABASE_PLAN.md §7 before reusing any of this.
 */

import { one, strOr, type Db } from './types';

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
 * Normalises a typed name the same way on both sides of every query, so a name is either always
 * matched or never. The column is also NOCASE, so this only trims.
 */
export const normaliseUsername = (username: string): string => username.trim();

const checkUsername = (username: string): string => {
  const name = normaliseUsername(username);
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

const toUser = (row: ReturnType<typeof one>): User | null => {
  if (!row) return null;
  return {
    id: strOr(row, 'id', ''),
    username: strOr(row, 'username', ''),
    createdAt: strOr(row, 'created_at', ''),
  };
};

/** Looks up an account by name, or null. */
export async function findByUsername(db: Db, username: string): Promise<User | null> {
  const { rows } = await db.execute({
    sql: 'SELECT id, username, created_at FROM users WHERE username = ?',
    args: [normaliseUsername(username)],
  });
  return toUser(one(rows));
}

/** Looks up an account by id, or null. Used to restore a session on launch. */
export async function findById(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.execute({
    sql: 'SELECT id, username, created_at FROM users WHERE id = ?',
    args: [id],
  });
  return toUser(one(rows));
}

/**
 * Registers an account.
 *
 * The lookup is for a friendly message; the `UNIQUE` constraint is the guarantee. If two sign-ups
 * race, the constraint violation arrives as the same error rather than a crash.
 */
export async function createUser(db: Db, username: string, password: string): Promise<User> {
  const name = checkUsername(username);
  checkPassword(password);

  if (await findByUsername(db, name)) throw new UsernameTakenError(name);

  const user: User = { id: crypto.randomUUID(), username: name, createdAt: new Date().toISOString() };
  const salt = randomSalt();
  try {
    await db.execute({
      sql: `INSERT INTO users (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: [user.id, user.username, await hashPassword(password, salt), salt, user.createdAt],
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
export async function verifyPassword(db: Db, username: string, password: string): Promise<User | null> {
  const name = normaliseUsername(username);
  const { rows } = await db.execute({
    sql: 'SELECT id, username, created_at, password_hash, salt FROM users WHERE username = ?',
    args: [name],
  });
  const row = one(rows);
  if (!row) return null;
  const hash = await hashPassword(password, strOr(row, 'salt', ''));
  // Compare against the stored hash whatever the outcome, so a wrong name and a wrong password
  // take about the same time and cannot be told apart by how long they took.
  const expected = strOr(row, 'password_hash', '');
  const matches = timingSafeEqual(hash, expected);
  return matches ? toUser(row) : null;
}

/** Byte-for-byte comparison, without the early exit a `===` on strings would give. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** SQLite's unique-constraint failure, however the driver chose to word it. */
export function isUniqueViolation(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed|constraint failed/i.test(message);
}
