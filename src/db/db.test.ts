import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countLabels, createLabel, deleteLabel, getLabel, listLabels, listSlugs, updateLabel } from './labels';
import { isUniqueViolation } from './schema';
import { createTestDb, type TestDb } from './testDb';
import {
  createUser,
  findById,
  findByUsername,
  InvalidCredentialsError,
  UsernameTakenError,
  verifyPassword,
} from './users';

let test: TestDb;

/** The real driver against a real SQLite file, built with the app's own migrations. */
const db = () => test.db;

beforeAll(async () => {
  test = await createTestDb('db');
});

afterAll(() => test.close());

/** Each test starts from a clean pair of tables. */
afterEach(async () => {
  await test.client.execute('DELETE FROM labels');
  await test.client.execute('DELETE FROM users');
});

const signUp = async (name = 'ann', password = 'hunter2') => createUser(db(), name, password);
const labelJson = (width: number) => JSON.stringify({ basePdf: { width, height: 50 }, schemas: [[]] });

describe('createUser', () => {
  it('registers an account and returns it without the hash or the salt', async () => {
    const user = await signUp();
    expect(user.username).toBe('ann');
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(user).sort()).toEqual(['createdAt', 'id', 'username']);
  });

  it('trims the name, so " ann " is the same account as "ann"', async () => {
    await signUp('ann');
    await expect(signUp('  ann  ')).rejects.toThrow(UsernameTakenError);
  });

  it('is case-insensitive, so "Ann" cannot be registered after "ann"', async () => {
    await signUp('ann');
    await expect(signUp('ANN')).rejects.toThrow(/already taken/);
  });

  it('refuses a name that is taken, which is what the sign-up screen shows', async () => {
    await signUp();
    await expect(signUp()).rejects.toThrow(UsernameTakenError);
  });

  it('names the account in the error, so the screen can point at it', async () => {
    await signUp('ann');
    const error = await signUp('ann').catch((e) => e as UsernameTakenError);
    expect(error).toBeInstanceOf(UsernameTakenError);
    expect((error as UsernameTakenError).username).toBe('ann');
    expect((error as UsernameTakenError).message).toContain('already taken');
  });

  it('never stores the password, only a hash and a salt', async () => {
    await signUp('ann', 'hunter2');
    const { rows } = await test.client.execute('SELECT password_hash, salt FROM users WHERE username = ?', ['ann']);
    const stored = rows[0] as Record<string, string>;
    expect(stored.password_hash).not.toContain('hunter2');
    expect(stored.password_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives every account a different salt, so identical passwords differ', async () => {
    await signUp('ann', 'same');
    await signUp('bob', 'same');
    const { rows } = await test.client.execute('SELECT password_hash FROM users ORDER BY username');
    const [a, b] = rows.map((r) => (r as Record<string, string>).password_hash);
    expect(a).not.toBe(b);
  });

  it('reports a name taken by a concurrent sign-up as taken, not as a crash', async () => {
    // Two sign-ups that race: the friendly lookup passes for both, and only the unique index
    // stops the second. This is the path that has to work when the lookup cannot help.
    await test.client.execute({
      sql: `INSERT INTO users (id, username, username_key, password_hash, salt, created_at)
            VALUES ('race', 'taken', 'taken', 'h', 's', '2026-01-01')`,
    });
    await expect(signUp('taken')).rejects.toThrow(UsernameTakenError);
  });

  it('refuses a name or password it will not store', async () => {
    await expect(signUp('')).rejects.toThrow(InvalidCredentialsError);
    await expect(signUp('   ')).rejects.toThrow(/username/i);
    await expect(signUp('x'.repeat(33))).rejects.toThrow(/at most 32/);
    await expect(signUp('ann', 'abc')).rejects.toThrow(/at least 4/);
    await expect(signUp('badname')).rejects.toThrow(InvalidCredentialsError);
  });
});

describe('verifyPassword', () => {
  it('returns the account for the right password', async () => {
    const created = await signUp('ann', 'hunter2');
    const found = await verifyPassword(db(), 'ann', 'hunter2');
    expect(found?.id).toBe(created.id);
  });

  it('refuses a wrong password', async () => {
    await signUp('ann', 'hunter2');
    expect(await verifyPassword(db(), 'ann', 'hunter3')).toBeNull();
  });

  it('refuses a name that does not exist', async () => {
    await expect(verifyPassword(db(), 'nobody', 'hunter2')).resolves.toBeNull();
  });

  it('gives the same answer for a wrong name and a wrong password', async () => {
    await signUp('ann', 'hunter2');
    expect(await verifyPassword(db(), 'nobody', 'hunter2')).toBeNull();
    expect(await verifyPassword(db(), 'ann', 'wrong')).toBeNull();
  });

  it('ignores surrounding whitespace in the name', async () => {
    await signUp('ann', 'hunter2');
    expect(await verifyPassword(db(), ' ann ', 'hunter2')).not.toBeNull();
  });
});

describe('lookups', () => {
  it('finds an account by name and by id', async () => {
    const user = await signUp();
    expect((await findByUsername(db(), 'ann'))?.id).toBe(user.id);
    expect((await findById(db(), user.id))?.username).toBe('ann');
  });

  it('returns null rather than throwing for someone who is not there', async () => {
    expect(await findByUsername(db(), 'nobody')).toBeNull();
    expect(await findById(db(), 'no-such-id')).toBeNull();
  });
});

describe('labels', () => {
  it('stores a label and reads it back whole', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'my-parcel', {
      name: 'My parcel',
      template: labelJson(100),
      generator: '{"version":1,"fields":{}}',
    });
    const fetched = await getLabel(db(), user.id, 'my-parcel');
    expect(fetched?.name).toBe('My parcel');
    expect(fetched?.slug).toBe('my-parcel');
    expect(fetched?.generator).toBe('{"version":1,"fields":{}}');
  });

  it('reports the page size from the template, so it cannot go stale', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(110), generator: '{}' });
    const [summary] = await listLabels(db(), user.id);
    expect(summary.widthMm).toBe(110);
    expect(summary.heightMm).toBe(50);
  });

  it('still lists a label whose template cannot be read', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'broken', { name: 'Broken', template: 'not json', generator: '{}' });
    const [summary] = await listLabels(db(), user.id);
    expect(summary.name).toBe('Broken');
    expect(summary.widthMm).toBe(100);
  });

  it('refuses two labels with the same slug for one account', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    await expect(
      createLabel(db(), user.id, 'a', { name: 'B', template: labelJson(100), generator: '{}' }),
    ).rejects.toThrow();
  });

  it('reports a duplicate slug as a unique violation, not some wrapped driver error', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    const error = await createLabel(db(), user.id, 'a', { name: 'B', template: labelJson(100), generator: '{}' }).catch(
      (e) => e as unknown,
    );
    // Drizzle puts the real reason in `cause`, two levels down, so a shallow match finds nothing.
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('lets two accounts have a label with the same slug', async () => {
    const ann = await signUp('ann');
    const bob = await signUp('bob', 'hunter3');
    await createLabel(db(), ann.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    await createLabel(db(), bob.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    expect(await listLabels(db(), ann.id)).toHaveLength(1);
    expect(await listLabels(db(), bob.id)).toHaveLength(1);
  });

  it('updates a label in place', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    expect(await updateLabel(db(), user.id, 'a', { name: 'Renamed' })).toBe(true);
    expect((await getLabel(db(), user.id, 'a'))?.name).toBe('Renamed');
  });

  it('deletes a label', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    expect(await deleteLabel(db(), user.id, 'a')).toBe(true);
    expect(await getLabel(db(), user.id, 'a')).toBeNull();
  });

  it('counts and lists slugs, which the one-time import needs', async () => {
    const user = await signUp();
    expect(await countLabels(db(), user.id)).toBe(0);
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    await createLabel(db(), user.id, 'b', { name: 'B', template: labelJson(100), generator: '{}' });
    expect(await countLabels(db(), user.id)).toBe(2);
    expect((await listSlugs(db(), user.id)).sort()).toEqual(['a', 'b']);
  });

  it('moves updated_at forward when it saves, so the newest label can be offered', async () => {
    const user = await signUp();
    await createLabel(db(), user.id, 'a', { name: 'A', template: labelJson(100), generator: '{}' });
    const before = (await getLabel(db(), user.id, 'a'))?.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateLabel(db(), user.id, 'a', { name: 'A again' });
    expect((await getLabel(db(), user.id, 'a'))?.updatedAt > before).toBe(true);
  });
});

describe('one account cannot reach another', () => {
  it('does not list another account’s labels', async () => {
    const ann = await signUp('ann');
    const bob = await signUp('bob', 'hunter3');
    await createLabel(db(), ann.id, 'anns', { name: 'Ann private', template: labelJson(100), generator: '{}' });
    expect(await listLabels(db(), bob.id)).toEqual([]);
  });

  it('does not read another account’s label by id', async () => {
    const ann = await signUp('ann');
    const bob = await signUp('bob', 'hunter3');
    await createLabel(db(), ann.id, 'anns', { name: 'Ann private', template: labelJson(100), generator: '{}' });
    expect(await getLabel(db(), bob.id, 'anns')).toBeNull();
  });

  it('does not change another account’s label', async () => {
    const ann = await signUp('ann');
    const bob = await signUp('bob', 'hunter3');
    await createLabel(db(), ann.id, 'anns', { name: 'Ann private', template: labelJson(100), generator: '{}' });
    expect(await updateLabel(db(), bob.id, 'anns', { name: 'Hijacked' })).toBe(false);
    expect((await getLabel(db(), ann.id, 'anns'))?.name).toBe('Ann private');
  });

  it('does not delete another account’s label', async () => {
    const ann = await signUp('ann');
    const bob = await signUp('bob', 'hunter3');
    await createLabel(db(), ann.id, 'anns', { name: 'Ann private', template: labelJson(100), generator: '{}' });
    expect(await deleteLabel(db(), bob.id, 'anns')).toBe(false);
    expect(await getLabel(db(), ann.id, 'anns')).not.toBeNull();
  });
});
