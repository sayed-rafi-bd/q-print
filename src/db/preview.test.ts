import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLabel, deleteLabel } from './labels';
import { copyPreviewValues, deletePreviewValues, loadPreviewValues, savePreviewValues } from './preview';
import { createTestDb, type TestDb } from './testDb';
import { createUser, type User } from './users';

let test: TestDb;
const db = () => test.db;

beforeAll(async () => {
  test = await createTestDb('preview');
});

afterAll(() => test.close());

/** Each test starts from a clean database, so the accounts are made fresh for each one. */
let who: User;
beforeEach(async () => {
  who = await createUser(db(), 'ann', 'hunter2');
});

afterEach(async () => {
  await test.client.execute('DELETE FROM label_preview');
  await test.client.execute('DELETE FROM labels');
  await test.client.execute('DELETE FROM users');
});

const user = async (name: string): Promise<User> => createUser(db(), name, 'hunter2');

describe('preview values', () => {
  it('are empty for a label nobody has touched', async () => {
    expect(await loadPreviewValues(db(), who.id, 'product')).toBeNull();
  });

  it('round-trip, keyed by account and label', async () => {
    await savePreviewValues(db(), who.id, 'product', { itemBarcode: '4901234567894' });
    expect(await loadPreviewValues(db(), who.id, 'product')).toEqual({ itemBarcode: '4901234567894' });
  });

  it('work for a built-in id, which has no row in labels at all', async () => {
    const count = await test.client.execute('SELECT COUNT(*) n FROM labels WHERE slug = ?', ['product']);
    expect(Number(count.rows[0].n)).toBe(0);
    await savePreviewValues(db(), who.id, 'product', { itemBarcode: '4901234567894' });
    expect(await loadPreviewValues(db(), who.id, 'product')).toEqual({ itemBarcode: '4901234567894' });
  });

  it('replace rather than merge, so removing a value actually removes it', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1', two: '2' });
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    expect(await loadPreviewValues(db(), who.id, 'a')).toEqual({ one: '1' });
  });

  it('drop the row entirely when every value is cleared', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    await savePreviewValues(db(), who.id, 'a', {});
    expect(await loadPreviewValues(db(), who.id, 'a')).toBeNull();
    const count = await test.client.execute('SELECT COUNT(*) n FROM label_preview');
    expect(Number(count.rows[0].n)).toBe(0);
  });

  it('are kept apart between accounts', async () => {
    const bob = await user('bob');
    await savePreviewValues(db(), who.id, 'a', { one: 'ann' });
    await savePreviewValues(db(), bob.id, 'a', { one: 'bob' });
    expect(await loadPreviewValues(db(), who.id, 'a')).toEqual({ one: 'ann' });
    expect(await loadPreviewValues(db(), bob.id, 'a')).toEqual({ one: 'bob' });
  });

  it('are kept apart between two labels of the same account', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: 'A' });
    await savePreviewValues(db(), who.id, 'b', { one: 'B' });
    expect(await loadPreviewValues(db(), who.id, 'a')).toEqual({ one: 'A' });
    expect(await loadPreviewValues(db(), who.id, 'b')).toEqual({ one: 'B' });
  });

  it('go away with the account', async () => {
    const bob = await user('bob');
    await savePreviewValues(db(), bob.id, 'a', { one: 'bob' });
    await test.client.execute('DELETE FROM users WHERE id = ?', [bob.id]);
    expect(await loadPreviewValues(db(), bob.id, 'a')).toBeNull();
  });

  it('ignore anything in the row that is not a string', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    await test.client.execute('UPDATE label_preview SET values_json = ? WHERE user_id = ?', [
      '{"one":"1","two":7,"three":null,"four":{"a":1}}',
      who.id,
    ]);
    expect(await loadPreviewValues(db(), who.id, 'a')).toEqual({ one: '1' });
  });

  it('read as empty when the row is unreadable rather than throwing', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    await test.client.execute('UPDATE label_preview SET values_json = ? WHERE user_id = ?', ['not json', who.id]);
    expect(await loadPreviewValues(db(), who.id, 'a')).toEqual({});
  });

  it('can be deleted on their own', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    await deletePreviewValues(db(), who.id, 'a');
    expect(await loadPreviewValues(db(), who.id, 'a')).toBeNull();
  });
});

describe('copying preview values', () => {
  it('gives the copy what the original had', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    await copyPreviewValues(db(), who.id, 'a', 'a-copy');
    expect(await loadPreviewValues(db(), who.id, 'a-copy')).toEqual({ one: '1' });
  });

  it('does nothing when the original had none', async () => {
    await copyPreviewValues(db(), who.id, 'a', 'a-copy');
    expect(await loadPreviewValues(db(), who.id, 'a-copy')).toBeNull();
  });

  it('does not disturb the original', async () => {
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    await copyPreviewValues(db(), who.id, 'a', 'a-copy');
    await savePreviewValues(db(), who.id, 'a-copy', { one: '2' });
    expect(await loadPreviewValues(db(), who.id, 'a')).toEqual({ one: '1' });
  });
});

describe('deleting a label', () => {
  it('takes its preview values with it', async () => {
    await createLabel(db(), who.id, 'a', {
      name: 'A',
      template: JSON.stringify({ basePdf: { width: 100, height: 50 }, schemas: [[]] }),
      generator: '{}',
    });
    await savePreviewValues(db(), who.id, 'a', { one: '1' });
    expect(await deleteLabel(db(), who.id, 'a')).toBe(true);
    // No foreign key reaches label_preview from labels, so deleteLabel clears it explicitly.
    expect(await loadPreviewValues(db(), who.id, 'a')).toBeNull();
  });
});
