import { describe, expect, it } from 'vitest';
import { checkRowKeys } from './ApiBridge';

/**
 * The one piece of the bridge that is worth testing on its own: what the local API tells an
 * integration when it sends data for fields the label does not have.
 *
 * A misspelled key does not fail the print. It prints a blank field and everything else looks
 * fine, so the caller finds out days later from a shelf of blank labels. This is the check that
 * turns that into an immediate, readable error.
 */

const FIELDS = ['name', 'barcode', 'price'];

describe('checkRowKeys', () => {
  it('accepts data whose keys are all real fields', () => {
    expect(checkRowKeys([{ name: 'Tea', barcode: '4901234567894' }], FIELDS)).toBeNull();
    expect(checkRowKeys([{ name: 'Tea' }, { name: 'Coffee' }], FIELDS)).toBeNull();
  });

  it('accepts a label with no fields at all, as long as nothing was sent for it', () => {
    expect(checkRowKeys([], [])).toBeNull();
  });

  it('names the field that does not exist, and the ones that do', () => {
    // Both halves matter: without the real names the caller has to go and look them up.
    const problem = checkRowKeys([{ titel: 'Tea' }], FIELDS) ?? '';
    expect(problem).toContain('“titel”');
    expect(problem).toContain('name, barcode, price');
  });

  it('reports every unknown key once, however many rows use it', () => {
    const problem = checkRowKeys([{ titel: 'a', typ: 'b' }, { titel: 'c' }], FIELDS) ?? '';
    expect(problem).toContain('“titel”');
    expect(problem).toContain('“typ”');
    // One occurrence of each, or the message reads like a list of mistakes rather than the keys.
    expect(problem.match(/“titel”/g)).toHaveLength(1);
  });

  it('reads as one field versus several', () => {
    expect(checkRowKeys([{ a: '1' }], FIELDS)).toContain('no field called “a”.');
    expect(checkRowKeys([{ a: '1', b: '2' }], FIELDS)).toContain('“a” or “b”');
  });

  it('says so when a label has no fields but data was sent for it', () => {
    const problem = checkRowKeys([{ name: 'Tea' }], []) ?? '';
    expect(problem).toContain('“name”');
    // With nothing to offer instead, the list is empty rather than missing.
    expect(problem).toContain('Its fields are: ');
  });
});
