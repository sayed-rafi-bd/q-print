import { describe, expect, it } from 'vitest';
import { generateRows, generateRowsFromRecords, LIMITS, sampleField, validateSpec } from './engine';
import type { FieldRule, GeneratorSpec } from './spec';

/** A small LCG, so a failing case can be reproduced exactly. */
function seededRng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Never returns exactly 1, to prove the engine clamps rather than trusting the rng. */
const greedyRng = () => 0.999999;

const NOW = new Date(2026, 0, 15, 12, 0, 0); // 2026-01-15 local

const spec = (fields: Record<string, FieldRule>, tables?: GeneratorSpec['tables']): GeneratorSpec => ({
  version: 1,
  ...(tables ? { tables } : {}),
  fields,
});

const one = (s: GeneratorSpec, opts = {}) => generateRows(s, 1, { now: NOW, rng: seededRng(), ...opts })[0];

describe('generateRows', () => {
  it('rejects a spec that does not validate', () => {
    expect(() => generateRows(spec({ a: { kind: 'pick', values: [] } }), 1)).toThrow(/nothing to pick from/);
  });

  it('rejects a page count outside the limit', () => {
    const s = spec({ a: { kind: 'fixed', value: 'x' } });
    expect(() => generateRows(s, 0)).toThrow(/at least one page/);
    expect(() => generateRows(s, LIMITS.maxRows + 1)).toThrow(/limited to 10000 pages/);
    expect(generateRows(s, LIMITS.maxRows)).toHaveLength(LIMITS.maxRows);
  });

  it('leaves fields without a rule out of the row, so the template keeps its own text', () => {
    expect(one(spec({ a: { kind: 'fixed', value: 'A' } }))).toEqual({ a: 'A' });
  });
});

describe('fixed, digits, pick', () => {
  it('returns the fixed text', () => {
    expect(one(spec({ a: { kind: 'fixed', value: 'FMHテスト用' } })).a).toBe('FMHテスト用');
  });

  it('returns the requested number of digits', () => {
    for (const length of [1, 4, 10, 13]) {
      expect(one(spec({ a: { kind: 'digits', length } })).a).toMatch(new RegExp(`^\\d{${length}}$`));
    }
  });

  it('picks one of the listed values', () => {
    const s = spec({ a: { kind: 'pick', values: ['x', 'y', 'z'] } });
    const rows = generateRows(s, 50, { rng: seededRng(7) }).map((r) => r.a);
    expect(new Set(rows)).toEqual(new Set(['x', 'y', 'z']));
  });
});

describe('int', () => {
  it('stays inside the range', () => {
    const rows = generateRows(spec({ a: { kind: 'int', min: 3, max: 9 } }), 200, { rng: seededRng(3) });
    for (const r of rows) {
      const n = Number(r.a);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(9);
    }
  });

  it('reaches both ends of the range', () => {
    const rows = new Set(
      generateRows(spec({ a: { kind: 'int', min: 1, max: 3 } }), 200, { rng: seededRng(5) }).map((r) => r.a),
    );
    expect(rows).toEqual(new Set(['1', '2', '3']));
  });

  it('honours the step', () => {
    const rows = new Set(
      generateRows(spec({ a: { kind: 'int', min: 100, max: 3900, step: 100 } }), 300, { rng: seededRng(9) }).map(
        (r) => r.a,
      ),
    );
    for (const v of rows) expect(Number(v) % 100).toBe(0);
    expect(rows.has('3900')).toBe(true);
    expect(rows.has('100')).toBe(true);
  });

  it('rejects a range that is the wrong way round, rather than guessing', () => {
    // Swapping min and max would silently print a different range than the one on screen.
    expect(() => generateRows(spec({ a: { kind: 'int', min: 9, max: 3 } }), 1)).toThrow(
      /lowest value above its highest/,
    );
  });

  it('formats thousands and yen', () => {
    expect(one(spec({ a: { kind: 'int', min: 1234, max: 1234, format: 'thousands' } })).a).toBe('1,234');
    expect(one(spec({ a: { kind: 'int', min: 400, max: 400, format: 'yen' } })).a).toBe('¥400');
    expect(one(spec({ a: { kind: 'int', min: 1234, max: 1234, format: 'yen' } })).a).toBe('¥1,234');
    expect(one(spec({ a: { kind: 'int', min: 1234567, max: 1234567, format: 'yen' } })).a).toBe('¥1,234,567');
    expect(one(spec({ a: { kind: 'int', min: -1234, max: -1234, format: 'thousands' } })).a).toBe('-1,234');
  });

  it('never exceeds max even when the rng returns its highest possible value', () => {
    const s = spec({ a: { kind: 'int', min: 100, max: 3900, step: 100 } });
    expect(one(s, { rng: greedyRng }).a).toBe('3900');
  });
});

describe('table', () => {
  const tables = {
    place: {
      columns: ['zip', 'city'],
      rows: [
        ['150-0021', 'Tokyo'],
        ['100-0005', 'Tokyo'],
        ['530-0001', 'Osaka'],
      ],
    },
  };

  it('reads one cell', () => {
    const s = spec({ a: { kind: 'table', table: 'place', column: 'city' } }, tables);
    expect(['Tokyo', 'Osaka']).toContain(one(s, { rng: seededRng(11) }).a);
  });

  it('gives every field reading the same table the same row for the whole page', () => {
    const s = spec(
      {
        zip: { kind: 'table', table: 'place', column: 'zip' },
        city: { kind: 'table', table: 'place', column: 'city' },
      },
      tables,
    );
    const expected = new Map<string, string>([
      ['150-0021', 'Tokyo'],
      ['100-0005', 'Tokyo'],
      ['530-0001', 'Osaka'],
    ]);
    for (const row of generateRows(s, 100, { rng: seededRng(13) })) {
      // The postcode and the city must always be the same place.
      expect(expected.get(row.zip)).toBe(row.city);
    }
  });

  it('reuses one row per page but a different row across pages', () => {
    const s = spec({ city: { kind: 'table', table: 'place', column: 'city' } }, tables);
    const rows = generateRows(s, 100, { rng: seededRng(17) }).map((r) => r.city);
    expect(new Set(rows).size).toBeGreaterThan(1);
  });
});

describe('date', () => {
  it('is relative to today, not to a frozen year', () => {
    const s = spec({ a: { kind: 'date', offsetDays: [0, 0], format: 'YYYY/MM/DD' } });
    expect(one(s, { now: new Date(2026, 0, 15) }).a).toBe('2026/01/15');
    expect(one(s, { now: new Date(2031, 6, 4) }).a).toBe('2031/07/04');
  });

  it('adds the offset in whole calendar days', () => {
    const s = spec({ a: { kind: 'date', offsetDays: [2, 2], format: 'YYYY/MM/DD' } });
    expect(one(s, { now: new Date(2026, 0, 15) }).a).toBe('2026/01/17');
  });

  it('crosses month and year boundaries', () => {
    const s = spec({ a: { kind: 'date', offsetDays: [1, 1], format: 'YYYY/MM/DD' } });
    expect(one(s, { now: new Date(2026, 11, 31) }).a).toBe('2027/01/01');
  });

  it('picks within the offset range', () => {
    const s = spec({ a: { kind: 'date', offsetDays: [-10, 10], format: 'YYYY-MM-DD' } });
    const rows = generateRows(s, 60, { now: new Date(2026, 5, 15), rng: seededRng(23) }).map((r) => r.a);
    const days = new Set(
      rows.map((v) => Math.round((Date.parse(`${v}T00:00:00`) - Date.parse('2026-06-15T00:00:00')) / 86400000)),
    );
    expect(Math.min(...days)).toBeGreaterThanOrEqual(-10);
    expect(Math.max(...days)).toBeLessThanOrEqual(10);
  });

  it('supports the other tokens', () => {
    const s = spec({ a: { kind: 'date', offsetDays: [0, 0], format: 'YY/M/D HH:mm:ss' } });
    expect(one(s, { now: new Date(2026, 0, 15, 9, 5, 3) }).a).toBe('26/1/15 09:05:03');
  });
});

describe('pattern', () => {
  it('mixes literals with runs', () => {
    expect(one(spec({ a: { kind: 'pattern', pattern: 'A{d12}A' } })).a).toMatch(/^A\d{12}A$/);
    expect(one(spec({ a: { kind: 'pattern', pattern: '{D3}-{d4}' } })).a).toMatch(/^[A-Z]{3}-\d{4}$/);
    expect(one(spec({ a: { kind: 'pattern', pattern: '035{d10}' } })).a).toMatch(/^035\d{10}$/);
    expect(one(spec({ a: { kind: 'pattern', pattern: '{L4}' } })).a).toMatch(/^[a-z]{4}$/);
  });

  it('leaves a pattern with no tokens as plain text', () => {
    expect(one(spec({ a: { kind: 'pattern', pattern: 'TEL' } })).a).toBe('TEL');
  });
});

describe('sequence', () => {
  it('counts up across pages and restarts on every run', () => {
    const s = spec({ a: { kind: 'sequence', start: 1 } });
    const first = generateRows(s, 4, { rng: seededRng() }).map((r) => r.a);
    const second = generateRows(s, 4, { rng: seededRng(99) }).map((r) => r.a);
    expect(first).toEqual(['1', '2', '3', '4']);
    // Restarts, and does not depend on the rng at all.
    expect(second).toEqual(first);
  });

  it('honours start, step and padding', () => {
    const s = spec({ a: { kind: 'sequence', start: 100, step: 5, pad: 6 } });
    expect(generateRows(s, 3).map((r) => r.a)).toEqual(['000100', '000105', '000110']);
  });

  it('does not truncate once it outgrows the padding', () => {
    expect(generateRows(spec({ a: { kind: 'sequence', start: 8, pad: 2 } }), 3).map((r) => r.a)).toEqual([
      '08',
      '09',
      '10',
    ]);
  });
});

describe('copy', () => {
  it('copies another field on the same page', () => {
    const s = spec({
      trackingBarcode: { kind: 'digits', length: 13 },
      trackingText: { kind: 'copy', from: 'trackingBarcode' },
    });
    for (const row of generateRows(s, 50, { rng: seededRng(31) })) {
      expect(row.trackingText).toBe(row.trackingBarcode);
    }
  });

  it('evaluates in dependency order even when the copy is declared first', () => {
    const s = spec({
      b: { kind: 'copy', from: 'a' },
      a: { kind: 'copy', from: 'root' },
      root: { kind: 'fixed', value: 'deep' },
    });
    expect(one(s)).toEqual({ root: 'deep', a: 'deep', b: 'deep' });
  });

  it('can rebuild the copied value with a pattern', () => {
    const s = spec({
      locZone: { kind: 'int', min: 10, max: 59, suffix: '-' },
      locCode: { kind: 'copy', from: 'locZone', pattern: '{from}{d1}-{d2}' },
    });
    for (const row of generateRows(s, 100, { rng: seededRng(37) })) {
      // The zone the code starts with is the zone the other field shows.
      expect(row.locCode.startsWith(row.locZone)).toBe(true);
      expect(row.locCode).toMatch(/^\d{2}-\d-\d{2}$/);
    }
  });

  it('applies transforms to the finished value, so they also strip pattern separators', () => {
    // "{D3}-{d4}" is 3 letters, a dash and 4 digits; digits-only keeps only the digits.
    const s = spec({ a: { kind: 'pattern', pattern: '{D3}-{d4}', transforms: ['digits-only'] } });
    expect(one(s, { rng: seededRng(39) }).a).toMatch(/^\d{4}$/);
  });
});

describe('prefix, suffix and transforms', () => {
  it('wraps the value', () => {
    expect(one(spec({ a: { kind: 'fixed', value: '01', prefix: 'TEL:0', suffix: ' 様' } })).a).toBe('TEL:001 様');
  });

  it('applies transforms before the prefix, so digits-only keeps a 〒 prefix', () => {
    const s = spec({ a: { kind: 'fixed', value: '150-0021', prefix: '〒', transforms: ['digits-only'] } });
    expect(one(s).a).toBe('〒1500021');
  });

  it('applies transforms in order', () => {
    expect(one(spec({ a: { kind: 'fixed', value: 'ABC-123', transforms: ['lower', 'digits-only'] } })).a).toBe('123');
    expect(one(spec({ a: { kind: 'fixed', value: 'abc', transforms: ['upper'] } })).a).toBe('ABC');
  });
});

describe('determinism', () => {
  it('produces the same rows for the same seed', () => {
    const s = spec({ a: { kind: 'digits', length: 8 }, b: { kind: 'pick', values: ['p', 'q'] } });
    expect(generateRows(s, 20, { rng: seededRng(41) })).toEqual(generateRows(s, 20, { rng: seededRng(41) }));
  });

  it('produces different rows for different seeds', () => {
    const s = spec({ a: { kind: 'digits', length: 12 } });
    expect(generateRows(s, 20, { rng: seededRng(41) })).not.toEqual(generateRows(s, 20, { rng: seededRng(42) }));
  });
});

describe('sampleField', () => {
  it('shows a value for one field without generating the rest', () => {
    expect(sampleField(spec({ a: { kind: 'digits', length: 4 } }), 'a', { rng: seededRng() })).toMatch(/^\d{4}$/);
  });

  it('still shows a sample when another field is broken', () => {
    // The editor updates one rule at a time, so the rest of the spec is often mid-edit.
    const s = spec({
      good: { kind: 'digits', length: 5 },
      broken: { kind: 'copy', from: 'nowhere' },
    });
    expect(sampleField(s, 'good', { rng: seededRng() })).toMatch(/^\d{5}$/);
  });

  it('returns nothing for a field with no rule', () => {
    expect(sampleField(spec({ a: { kind: 'fixed', value: 'x' } }), 'missing')).toBe('');
  });

  it('keeps a table-based sample consistent with its sibling fields', () => {
    const s = spec(
      {
        zip: { kind: 'table', table: 't', column: 'zip' },
        city: { kind: 'table', table: 't', column: 'city' },
      },
      { t: { columns: ['zip', 'city'], rows: [['150-0021', 'Tokyo']] } },
    );
    expect(sampleField(s, 'zip', { rng: seededRng() })).toBe('150-0021');
    expect(sampleField(s, 'city', { rng: seededRng() })).toBe('Tokyo');
  });
});

describe('validateSpec', () => {
  const ok = (s: GeneratorSpec) => expect(validateSpec(s)).toEqual([]);

  it('accepts the built-in shapes', () => {
    ok(
      spec({
        a: { kind: 'fixed', value: '' },
        b: { kind: 'digits', length: 1 },
        c: { kind: 'pattern', pattern: '{d2}' },
      }),
    );
  });

  it('names the field in every message', () => {
    const errors = validateSpec(
      spec({
        good: { kind: 'fixed', value: 'x' },
        pick: { kind: 'pick', values: [] },
        digits: { kind: 'digits', length: 0 },
        range: { kind: 'int', min: 9, max: 1 },
        table: { kind: 'table', table: 'nope', column: 'c' },
        pattern: { kind: 'pattern', pattern: '{q5}' },
        copy: { kind: 'copy', from: 'missing' },
      }),
    );
    expect(errors.join('\n')).toMatch(/“pick”/);
    expect(errors.join('\n')).toMatch(/“digits”/);
    expect(errors.join('\n')).toMatch(/“range”/);
    expect(errors.join('\n')).toMatch(/“table”/);
    expect(errors.join('\n')).toMatch(/“pattern”/);
    expect(errors.join('\n')).toMatch(/“copy”/);
  });

  it('rejects a copy cycle instead of looping forever', () => {
    const errors = validateSpec(
      spec({
        a: { kind: 'copy', from: 'b' },
        b: { kind: 'copy', from: 'a' },
      }),
    );
    expect(errors.join('\n')).toMatch(/circle/);
  });

  it('rejects a field that copies itself', () => {
    expect(validateSpec(spec({ a: { kind: 'copy', from: 'a' } })).join('\n')).toMatch(/itself/);
  });

  it('rejects a copy that throws the copied value away', () => {
    expect(
      validateSpec(
        spec({
          a: { kind: 'fixed', value: 'x' },
          b: { kind: 'copy', from: 'a', pattern: '{d2}' },
        }),
      ).join('\n'),
    ).toMatch(/without \{from\}/);
  });

  it('rejects an unknown rule kind', () => {
    expect(validateSpec(spec({ a: { kind: 'eval' } as never })).join('\n')).toMatch(/unknown rule/);
  });

  it('rejects a table with rows that do not line up with its columns', () => {
    const errors = validateSpec(
      spec(
        { a: { kind: 'table', table: 't', column: 'c' } },
        {
          t: { columns: ['c', 'd'], rows: [['1'], ['1', '2']] },
        },
      ),
    );
    expect(errors.join('\n')).toMatch(/row 1 has 1 values but there are 2 columns/);
  });

  it('rejects a table that is over the row limit', () => {
    const rows = Array.from({ length: LIMITS.maxTableRows + 1 }, (_, i) => [`${i}`]);
    const errors = validateSpec(
      spec(
        { a: { kind: 'table', table: 't', column: 'c' } },
        {
          t: { columns: ['c'], rows },
        },
      ),
    );
    expect(errors.join('\n')).toMatch(/over the limit of 5000/);
  });

  it('rejects an unsupported version and a non-spec', () => {
    expect(validateSpec({ version: 2, fields: {} } as never).join('\n')).toMatch(/version/);
    expect(validateSpec(null).join('\n')).toMatch(/not a data generator/);
    expect(validateSpec({ version: 1 } as never).join('\n')).toMatch(/no fields/);
  });
});

describe('api rule', () => {
  const source = { url: 'api.example.com/day/{day}' };
  const withSource = (fields: Record<string, FieldRule>, extra: Partial<GeneratorSpec> = {}): GeneratorSpec => ({
    version: 1,
    source,
    fields,
    ...extra,
  });
  const apiSpec = withSource({ name: { kind: 'api', path: 'user.name' } });
  const rec = (name: string) => ({ user: { name } });

  it('prints the record’s value, with prefix, suffix and transforms', () => {
    const s = withSource({
      name: { kind: 'api', path: 'user.name', transforms: ['upper'], suffix: '様' },
      price: { kind: 'api', path: 'price', prefix: '¥' },
    });
    expect(generateRowsFromRecords(s, [{ user: { name: 'aiko' }, price: 400 }], 1)).toEqual([
      { name: 'AIKO様', price: '¥400' },
    ]);
  });

  it('prints each record `copies` times, record by record', () => {
    const rows = generateRowsFromRecords(apiSpec, [rec('A'), rec('B'), rec('C')], 2);
    expect(rows.map((r) => r.name)).toEqual(['A', 'A', 'B', 'B', 'C', 'C']);
  });

  it('prints an object response as one record', () => {
    expect(generateRowsFromRecords(apiSpec, [rec('Solo')], 3).map((r) => r.name)).toEqual(['Solo', 'Solo', 'Solo']);
  });

  it('keeps `sequence` counting across the whole job', () => {
    const s = withSource({ n: { kind: 'sequence', start: 1 }, name: { kind: 'api', path: 'user.name' } });
    const rows = generateRowsFromRecords(s, [rec('A'), rec('B')], 2);
    expect(rows.map((r) => r.n)).toEqual(['1', '2', '3', '4']);
  });

  it('mixes api fields with random, table and copy fields', () => {
    const s = withSource(
      {
        name: { kind: 'api', path: 'user.name' },
        code: { kind: 'digits', length: 6 },
        city: { kind: 'table', table: 't', column: 'city' },
        again: { kind: 'copy', from: 'name', pattern: '{from}-{d2}' },
      },
      { tables: { t: { columns: ['city'], rows: [['Osaka']] } } },
    );
    const rows = generateRowsFromRecords(s, [rec('A'), rec('B')], 1, { rng: seededRng(5) });
    expect(rows[0].name).toBe('A');
    expect(rows[0].code).toMatch(/^\d{6}$/);
    expect(rows[0].city).toBe('Osaka');
    expect(rows[1].again).toMatch(/^B-\d{2}$/);
  });

  it('generates fresh random values for each copy, but shares the record’s api values', () => {
    const s = withSource({ name: { kind: 'api', path: 'user.name' }, code: { kind: 'digits', length: 12 } });
    const [a, b] = generateRowsFromRecords(s, [rec('A')], 2, { rng: seededRng(3) });
    expect(a.name).toBe(b.name);
    expect(a.code).not.toBe(b.code);
  });

  it('prints null as empty text and names the record when a path is missing', () => {
    expect(generateRowsFromRecords(apiSpec, [{ user: { name: null } }], 1)).toEqual([{ name: '' }]);
    expect(() => generateRowsFromRecords(apiSpec, [rec('A'), { user: {} }], 1)).toThrow(
      /^Record 2, field “name”: “user.name” was not found/,
    );
    expect(() => generateRowsFromRecords(apiSpec, [{ user: { name: { x: 1 } } }], 1)).toThrow(
      /^Record 1, field “name”: “user.name” points at an object/,
    );
  });

  it('checks the size before generating anything', () => {
    const records = Array.from({ length: 1200 }, () => rec('A'));
    expect(() => generateRowsFromRecords(apiSpec, records, 10)).toThrow(
      '12,000 pages would be printed (1,200 records x 10 copies); the limit is 10,000.',
    );
    const many = Array.from({ length: 5000 }, () => rec('A'));
    expect(generateRowsFromRecords(apiSpec, many, 2)).toHaveLength(10_000);
  });

  it('rejects no records, a bad copy count and an invalid spec', () => {
    expect(() => generateRowsFromRecords(apiSpec, [], 1)).toThrow(/no records/);
    expect(() => generateRowsFromRecords(apiSpec, [rec('A')], 0)).toThrow(/at least one copy/);
    expect(() => generateRowsFromRecords(apiSpec, [rec('A')], 1.5)).toThrow(/at least one copy/);
    const broken = spec({ a: { kind: 'pick', values: [] } });
    expect(() => generateRowsFromRecords(broken, [{}], 1)).toThrow(/nothing to pick/);
  });

  it('works for a label with no api fields too, repeating the records', () => {
    const s = withSource({ a: { kind: 'fixed', value: 'x' } });
    expect(generateRowsFromRecords(s, [{}, {}], 2)).toHaveLength(4);
  });

  it('makes generateRows refuse a spec that reads the API', () => {
    expect(() => generateRows(apiSpec, 1)).toThrow(/needs API data/);
  });

  it('prints ‹path› in placeholder mode, for the editor and the preview', () => {
    expect(generateRows(apiSpec, 2, { placeholders: true }).map((r) => r.name)).toEqual(['‹user.name›', '‹user.name›']);
    expect(sampleField(apiSpec, 'name', { placeholders: true })).toBe('‹user.name›');
    expect(sampleField(apiSpec, 'name')).toBe('');
  });

  it('leaves generateRows alone for a label that only has a source', () => {
    const s = withSource({ a: { kind: 'fixed', value: 'x' } });
    expect(generateRows(s, 2)).toEqual([{ a: 'x' }, { a: 'x' }]);
  });
});

describe('validateSpec: api and source', () => {
  const ok = (extra: Partial<GeneratorSpec> = {}): GeneratorSpec => ({
    version: 1,
    source: { url: 'api.example.com/day/{day}' },
    fields: { a: { kind: 'api', path: 'x' } },
    ...extra,
  });

  it('accepts a valid source and api field', () => {
    expect(validateSpec(ok())).toEqual([]);
    expect(
      validateSpec(
        ok({
          source: {
            url: 'https://api.example.com/{day}',
            listPath: 'data.items',
            bearerAuth: true,
            variables: { day: { label: 'Day', default: '1' } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('allows a source with no api field', () => {
    expect(validateSpec(ok({ fields: { a: { kind: 'fixed', value: 'x' } } }))).toEqual([]);
  });

  it('needs a non-empty, well-formed path', () => {
    expect(validateSpec(ok({ fields: { a: { kind: 'api', path: '' } } }))).toEqual([
      '“a” needs a path into the API response.',
    ]);
    expect(validateSpec(ok({ fields: { a: { kind: 'api', path: 'a..b' } } }))[0]).toMatch(
      /“a” has an invalid path “a..b”/,
    );
  });

  it('reports an api field on a label with no source', () => {
    expect(validateSpec({ version: 1, fields: { a: { kind: 'api', path: 'x' } } })).toEqual([
      '“a” reads the API but this label has no URL.',
    ]);
  });

  it('reports a bad URL and a bad list path', () => {
    expect(validateSpec(ok({ source: { url: 'file:///x' } }))[0]).toMatch(/Only http and https/);
    expect(validateSpec(ok({ source: { url: 'https://u:p@x.com/' } }))[0]).toMatch(/access token/);
    expect(validateSpec(ok({ source: { url: 'x.com', listPath: 'a..b' } }))[0]).toMatch(/list path “a..b”/);
    expect(validateSpec(ok({ source: { url: 'x.com', bearerAuth: 'yes' as unknown as boolean } }))[0]).toMatch(
      /on or off/,
    );
    expect(validateSpec(ok({ source: { url: 'x.com', variables: { d: { label: 3 } } as never } }))[0]).toMatch(
      /variable “d”/,
    );
  });

  it('refuses a token or any other unknown setting in the source', () => {
    const problems = validateSpec(ok({ source: { url: 'x.com', token: 'secret' } as never }));
    expect(problems[0]).toMatch(/unknown setting “token”/);
    expect(problems[0]).not.toContain('secret');
  });
});

