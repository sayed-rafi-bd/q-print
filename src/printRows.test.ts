import { describe, expect, it, vi } from 'vitest';
import type { GeneratorSpec } from './generator/spec';
import { buildRows, missingInput, startingValues, usesApi } from './printRows';

const apiSpec: GeneratorSpec = {
  version: 1,
  fields: { name: { kind: 'api', path: 'name' }, no: { kind: 'sequence', start: 1 } },
};

const plainSpec: GeneratorSpec = { version: 1, fields: { a: { kind: 'fixed', value: 'x' } } };

/** What the print screen passes once the person has typed an address. */
const api = (over: Partial<Parameters<typeof buildRows>[2]> = {}) => ({
  url: 'api.example.com/day/{day}/logs',
  bearerAuth: true,
  values: { day: '5' },
  token: 'secret',
  ...over,
});

describe('usesApi', () => {
  it('is the only thing that says a label needs records', () => {
    expect(usesApi(apiSpec)).toBe(true);
    expect(usesApi(plainSpec)).toBe(false);
    expect(usesApi({ version: 1, fields: {} })).toBe(false);
  });
});

describe('buildRows', () => {
  it('prints an array of 3 records x 2 copies as 6 pages, grouped by record', async () => {
    const fetcher = vi.fn(async () => [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    const input = api();
    const out = await buildRows(apiSpec, 2, input, fetcher);
    expect(out.rows.map((r) => r.name)).toEqual(['A', 'A', 'B', 'B', 'C', 'C']);
    expect(out.rows.map((r) => r.no)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(out.records).toBe(3);
    expect(fetcher).toHaveBeenCalledWith(input, { day: '5' }, 'secret');
  });

  it('prints an object response (one record) n times', async () => {
    const out = await buildRows(apiSpec, 4, api({ token: 't' }), async () => [{ name: 'Only' }]);
    expect(out.rows).toHaveLength(4);
    expect(out.records).toBe(1);
  });

  it('refuses a label that needs records when no address was given, before any request', async () => {
    const fetcher = vi.fn();
    await expect(buildRows(apiSpec, 1, undefined, fetcher)).rejects.toThrow('Enter an address');
    await expect(buildRows(apiSpec, 1, api({ url: '   ' }), fetcher)).rejects.toThrow('Enter an address');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails before building pages when a record lacks a value, naming field and record', async () => {
    await expect(buildRows(apiSpec, 1, api({ token: undefined }), async () => [{ name: 'A' }, {}])).rejects.toThrow(
      /record 2.*name/is,
    );
  });

  it('leaves a label with no api rules alone, with no fetch, whatever it is given', async () => {
    const fetcher = vi.fn();
    const out = await buildRows(plainSpec, 3, undefined, fetcher);
    expect(out.rows).toEqual([{ a: 'x' }, { a: 'x' }, { a: 'x' }]);
    expect(out.records).toBeNull();
    expect(out.fetchMs).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a job over the page limit with the record x copies message', async () => {
    const many = Array.from({ length: 1200 }, () => ({ name: 'n' }));
    await expect(buildRows(apiSpec, 10, api({ token: undefined }), async () => many)).rejects.toThrow(
      /12,000 pages.*1,200 records x 10 copies/,
    );
  });
});

describe('missingInput', () => {
  it('asks for the address first', () => {
    expect(missingInput(api({ url: '' }))).toContain('Enter the address');
  });

  it('names the first blank variable', () => {
    expect(missingInput(api({ url: 'a.com/{x}/{y}', values: { x: '1', y: ' ' }, token: 't' }))).toContain('“y”');
  });

  it('reports an address it cannot use', () => {
    expect(missingInput(api({ url: 'ftp://x.com' }))).toContain('Only http and https');
  });

  it('asks for the token when one is asked for', () => {
    expect(missingInput(api({ url: 'a.com/{x}/{y}', values: { x: '1', y: '2' }, token: '  ' }))).toContain(
      'access token',
    );
  });

  it('is satisfied when everything is filled in', () => {
    expect(missingInput(api({ url: 'a.com/{x}/{y}', values: { x: '1', y: '2' }, token: 't' }))).toBeNull();
    expect(missingInput(api({ url: 'a.com/{x}', values: { x: '1' }, bearerAuth: false, token: '' }))).toBeNull();
  });
});

describe('startingValues', () => {
  it('offers what was remembered for the variables the address names, and nothing else', () => {
    // The address is never remembered, so its variables are only known once it has been typed.
    expect(startingValues('a.com/{a}/{b}/{c}', { a: 'mine', z: 'unused' })).toEqual({ a: 'mine', b: '', c: '' });
  });

  it('gives nothing for an address with no variables', () => {
    expect(startingValues('a.com/all', { a: 'mine' })).toEqual({});
  });
});
