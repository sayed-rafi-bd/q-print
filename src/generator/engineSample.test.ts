import { describe, expect, it } from 'vitest';
import { generateRows, sampleField } from './engine';
import type { GeneratorSpec } from './spec';

const spec: GeneratorSpec = {
  version: 1,
  fields: { who: { kind: 'api', path: 'user.name', suffix: '様' }, id: { kind: 'digits', length: 4 } },
};

describe('a fetched sample record in the editor', () => {
  it('sampleField reads the real value, with prefix/suffix applied', () => {
    expect(sampleField(spec, 'who', { record: { user: { name: 'Ann' } } })).toBe('Ann様');
  });

  it('sampleField still shows ‹path› (with the suffix) when there is no sample', () => {
    expect(sampleField(spec, 'who', { placeholders: true })).toBe('‹user.name›様');
  });

  it('other rules keep working next to api fields', () => {
    expect(sampleField(spec, 'id', { placeholders: true, record: { user: { name: 'A' } } })).toMatch(/^\d{4}$/);
  });

  it('generateRows with a record fills api fields; without one it still refuses', () => {
    const rows = generateRows(spec, 2, { record: { user: { name: 'Ann' } } });
    expect(rows.map((r) => r.who)).toEqual(['Ann様', 'Ann様']);
    expect(() => generateRows(spec, 1)).toThrow('needs data from an API');
  });
});
