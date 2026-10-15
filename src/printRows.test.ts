import { describe, expect, it, vi } from 'vitest';
import type { GeneratorSpec } from './generator/spec';
import { buildRows, missingInput, startingValues } from './printRows';

const apiSpec: GeneratorSpec = {
  version: 1,
  source: { url: 'api.example.com/day/{day}/logs', bearerAuth: true, variables: { day: { default: 'today' } } },
  fields: { name: { kind: 'api', path: 'name' }, no: { kind: 'sequence', start: 1 } },
};

describe('buildRows', () => {
  it('prints an array of 3 records x 2 copies as 6 pages, grouped by record', async () => {
    const fetcher = vi.fn(async () => [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    const out = await buildRows(apiSpec, 2, { values: { day: '5' }, token: 'secret' }, fetcher);
    expect(out.rows.map((r) => r.name)).toEqual(['A', 'A', 'B', 'B', 'C', 'C']);
    expect(out.rows.map((r) => r.no)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(out.records).toBe(3);
    expect(fetcher).toHaveBeenCalledWith(apiSpec.source, { day: '5' }, 'secret');
  });

  it('prints an object response (one record) n times', async () => {
    const out = await buildRows(apiSpec, 4, { values: { day: '5' }, token: 't' }, async () => [{ name: 'Only' }]);
    expect(out.rows).toHaveLength(4);
    expect(out.records).toBe(1);
  });

  it('refuses without values, before any request', async () => {
    const fetcher = vi.fn();
    await expect(buildRows(apiSpec, 1, undefined, fetcher)).rejects.toThrow('needs values for its URL');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails before building pages when a record lacks a value, naming field and record', async () => {
    await expect(buildRows(apiSpec, 1, { values: { day: '1' } }, async () => [{ name: 'A' }, {}])).rejects.toThrow(
      /record 2.*name/is,
    );
  });

  it('keeps a label without a source working as before, with no fetch', async () => {
    const fetcher = vi.fn();
    const out = await buildRows({ version: 1, fields: { a: { kind: 'fixed', value: 'x' } } }, 3, undefined, fetcher);
    expect(out.rows).toEqual([{ a: 'x' }, { a: 'x' }, { a: 'x' }]);
    expect(out.records).toBeNull();
    expect(out.fetchMs).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a job over the page limit with the record x copies message', async () => {
    const many = Array.from({ length: 1200 }, () => ({ name: 'n' }));
    await expect(buildRows(apiSpec, 10, { values: { day: '1' } }, async () => many)).rejects.toThrow(
      /12,000 pages.*1,200 records x 10 copies/,
    );
  });
});

describe('missingInput', () => {
  const src = { url: 'a.com/{x}/{y}', bearerAuth: true };
  it('names the first blank variable', () => {
    expect(missingInput(src, { x: '1', y: ' ' }, 't')).toContain('“y”');
  });
  it('asks for the token when the label needs one', () => {
    expect(missingInput(src, { x: '1', y: '2' }, '  ')).toContain('access token');
  });
  it('is satisfied when everything is filled in', () => {
    expect(missingInput(src, { x: '1', y: '2' }, 't')).toBeNull();
    expect(missingInput({ url: 'a.com/{x}' }, { x: '1' }, '')).toBeNull();
  });
});

describe('startingValues', () => {
  it('prefers remembered values, then defaults, then empty', () => {
    const src = { url: 'a.com/{a}/{b}/{c}', variables: { b: { default: 'dflt' }, a: { default: 'ignored' } } };
    expect(startingValues(src, { a: 'mine' })).toEqual({ a: 'mine', b: 'dflt', c: '' });
  });
});
