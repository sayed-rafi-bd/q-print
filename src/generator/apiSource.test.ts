import { describe, expect, it } from 'vitest';
import {
  buildUrl,
  checkSourceUrl,
  extractRecords,
  leafPaths,
  normalizeUrl,
  parsePath,
  readPath,
  toText,
  urlVariables,
} from './apiSource';

describe('urlVariables', () => {
  it('lists each variable once, in order of appearance', () => {
    expect(urlVariables('api.github.com/day/{day}/count/{count}/logs')).toEqual(['day', 'count']);
    expect(urlVariables('x/{a}/{b}/{a}')).toEqual(['a', 'b']);
  });

  it('finds none in a plain address, and skips names that are not valid', () => {
    expect(urlVariables('https://example.com/x')).toEqual([]);
    expect(urlVariables('x/{1bad}/{ok_1}/{has space}')).toEqual(['ok_1']);
  });
});

describe('normalizeUrl', () => {
  it('adds https when there is no scheme', () => {
    expect(normalizeUrl('api.example.com/x')).toBe('https://api.example.com/x');
    expect(normalizeUrl('  api.example.com/x ')).toBe('https://api.example.com/x');
    expect(normalizeUrl('//api.example.com/x')).toBe('https://api.example.com/x');
  });

  it('keeps an explicit scheme, and treats host:port as a host', () => {
    expect(normalizeUrl('http://192.168.1.5:8080/x')).toBe('http://192.168.1.5:8080/x');
    expect(normalizeUrl('localhost:8080/x')).toBe('https://localhost:8080/x');
    expect(normalizeUrl('api.example.com:443/x')).toBe('https://api.example.com:443/x');
  });
});

describe('buildUrl', () => {
  it('substitutes every variable and adds the scheme', () => {
    expect(buildUrl('api.github.com/day/{day}/count/{count}/logs', { day: '15', count: '3' })).toBe(
      'https://api.github.com/day/15/count/3/logs',
    );
  });

  it('URL-encodes values, so they cannot change the path', () => {
    expect(buildUrl('x.com/{d}', { d: '2026/10/15' })).toBe('https://x.com/2026%2F10%2F15');
    expect(buildUrl('x.com/{d}', { d: 'a b/c' })).toBe('https://x.com/a%20b%2Fc');
    expect(buildUrl('x.com/{d}', { d: 'x/../../admin' })).toBe('https://x.com/x%2F..%2F..%2Fadmin');
    expect(buildUrl('x.com/{d}', { d: 'ラベル' })).toBe(`https://x.com/${encodeURIComponent('ラベル')}`);
  });

  it('does not substitute braces inside a value a second time', () => {
    expect(buildUrl('x.com/{a}/{b}', { a: '{b}', b: 'two' })).toBe('https://x.com/%7Bb%7D/two');
  });

  it('fills a repeated variable everywhere and trims the values', () => {
    expect(buildUrl('x.com/{a}/{a}', { a: ' 7 ' })).toBe('https://x.com/7/7');
  });

  it('names the first missing or blank value', () => {
    expect(() => buildUrl('x.com/{day}/{count}', { count: '3' })).toThrow('Enter a value for “day”.');
    expect(() => buildUrl('x.com/{day}', { day: '  ' })).toThrow('“day”');
  });
});

describe('checkSourceUrl', () => {
  it('accepts normal addresses, with or without a scheme', () => {
    expect(checkSourceUrl('api.github.com/day/{day}/count/{count}/logs')).toEqual([]);
    expect(checkSourceUrl('https://example.com/x?y={y}')).toEqual([]);
    expect(checkSourceUrl('http://192.168.1.5:8080/labels')).toEqual([]);
    expect(checkSourceUrl('{host}.example.com/x')).toEqual([]);
  });

  it('rejects an empty address', () => {
    expect(checkSourceUrl('   ')[0]).toMatch(/Enter the URL/);
  });

  it('rejects schemes other than http and https', () => {
    expect(checkSourceUrl('file:///etc/passwd')[0]).toMatch(/Only http and https.*file:/);
    expect(checkSourceUrl('javascript:alert(1)')[0]).toMatch(/Only http and https.*javascript:/);
    expect(checkSourceUrl('ftp://example.com/x')[0]).toMatch(/ftp:/);
  });

  it('rejects a user name or password in the address', () => {
    expect(checkSourceUrl('https://user:pw@example.com/x')[0]).toMatch(/access token/);
    expect(checkSourceUrl('https://user@example.com/x')[0]).toMatch(/access token/);
    expect(checkSourceUrl('https://{u}:{p}@example.com/x')[0]).toMatch(/access token/);
  });

  it('rejects an empty host', () => {
    expect(checkSourceUrl('https:///x')[0]).toMatch(/no host/);
    expect(checkSourceUrl('https://')[0]).toMatch(/no host/);
  });

  it('reports bad variable names and unpaired braces', () => {
    expect(checkSourceUrl('x.com/{1day}')[0]).toMatch(/“\{1day\}”.*not a valid variable name/);
    expect(checkSourceUrl('x.com/{has space}')[0]).toMatch(/not a valid variable name/);
    expect(checkSourceUrl('x.com/{day')[0]).toMatch(/without its pair/);
    expect(checkSourceUrl('x.com/day}')[0]).toMatch(/without its pair/);
  });
});

describe('parsePath', () => {
  it('splits keys and list positions', () => {
    expect(parsePath('total')).toEqual(['total']);
    expect(parsePath('user.name')).toEqual(['user', 'name']);
    expect(parsePath('items[0].id')).toEqual(['items', 0, 'id']);
    expect(parsePath('a[1][2].b')).toEqual(['a', 1, 2, 'b']);
    expect(parsePath('[0].id')).toEqual([0, 'id']);
    expect(parsePath('first name')).toEqual(['first name']);
  });

  it('rejects malformed paths', () => {
    for (const bad of ['', '  ', '.a', 'a.', 'a..b', 'a[', 'a[]', 'a[x]', 'a[-1]', 'a]', 'a[0]b', '[0', 'a[0].']) {
      expect(parsePath(bad), bad).toBeNull();
    }
  });
});

describe('readPath', () => {
  const record = { user: { name: 'Aiko' }, items: [{ id: 'a' }, { id: 'b' }], total: 0, note: null };

  it('walks nested keys and list positions', () => {
    expect(readPath(record, 'user.name')).toBe('Aiko');
    expect(readPath(record, 'items[1].id')).toBe('b');
    expect(readPath(record, 'total')).toBe(0);
    expect(readPath(record, 'note')).toBeNull();
    expect(readPath([{ id: 'z' }], '[0].id')).toBe('z');
  });

  it('throws a readable error when a step is missing', () => {
    expect(() => readPath(record, 'user.age')).toThrow('“user.age” was not found (“age” is missing in user).');
    expect(() => readPath(record, 'nope')).toThrow('“nope” was not found (“nope” is missing).');
    expect(() => readPath(record, 'items[5].id')).toThrow(/has 2 items, no \[5\]/);
    expect(() => readPath(record, 'total.x')).toThrow(/total is a number, not an object/);
    expect(() => readPath(record, 'user[0]')).toThrow(/user is an object, not a list/);
    expect(() => readPath(record, 'note.x')).toThrow(/note is nothing \(null\)/);
    expect(() => readPath(null, 'a')).toThrow(/the record is nothing/);
    expect(() => readPath(record, 'a..b')).toThrow('not a valid path');
  });

  it('only reads the record’s own keys, never inherited ones', () => {
    expect(() => readPath({}, 'constructor')).toThrow(/missing/);
    expect(() => readPath({}, '__proto__')).toThrow(/missing/);
    expect(() => readPath({}, 'toString')).toThrow(/missing/);
  });
});

describe('extractRecords', () => {
  it('turns a list into records and an object into one record', () => {
    expect(extractRecords([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
    expect(extractRecords({ a: 1 })).toEqual([{ a: 1 }]);
  });

  it('follows the list path first', () => {
    expect(extractRecords({ data: { items: [{ a: 1 }, { a: 2 }] } }, 'data.items')).toHaveLength(2);
    expect(extractRecords({ data: { a: 1 } }, 'data')).toEqual([{ a: 1 }]);
    expect(extractRecords([{ a: 1 }], '')).toEqual([{ a: 1 }]);
    expect(extractRecords([{ a: 1 }], '  ')).toEqual([{ a: 1 }]);
  });

  it('says so when the list path is not in the response', () => {
    expect(() => extractRecords({ data: [] }, 'items')).toThrow(/^The list path “items” was not found/);
  });

  it('refuses an empty list and anything that is not an object or list', () => {
    expect(() => extractRecords([])).toThrow(/empty list/);
    expect(() => extractRecords({ data: [] }, 'data')).toThrow(/empty list/);
    expect(() => extractRecords('hello')).toThrow(/returned text/);
    expect(() => extractRecords(42)).toThrow(/returned a number/);
    expect(() => extractRecords(null)).toThrow(/returned nothing/);
    expect(() => extractRecords(true)).toThrow(/returned true\/false/);
  });
});

describe('toText', () => {
  it('prints strings, numbers and booleans', () => {
    expect(toText('abc', 'p')).toBe('abc');
    expect(toText('', 'p')).toBe('');
    expect(toText(12.5, 'p')).toBe('12.5');
    expect(toText(0, 'p')).toBe('0');
    expect(toText(true, 'p')).toBe('true');
    expect(toText(false, 'p')).toBe('false');
  });

  it('prints null as empty text', () => {
    expect(toText(null, 'p')).toBe('');
  });

  it('refuses objects and lists, naming the path', () => {
    expect(() => toText({ a: 1 }, 'user')).toThrow('“user” points at an object; pick a field inside it.');
    expect(() => toText([1], 'tags')).toThrow('“tags” points at a list; pick a field inside it.');
  });
});

describe('leafPaths', () => {
  it('lists printable values with paths readPath can read back', () => {
    const record = { id: 7, user: { name: 'Ann', tags: ['a', 'b'] }, note: null, ok: true, empty: {} };
    const paths = leafPaths(record);
    expect(paths).toEqual(['id', 'user.name', 'user.tags[0]', 'user.tags[1]', 'note', 'ok']);
    for (const p of paths) expect(() => readPath(record, p)).not.toThrow();
  });

  it('shows only the first three list items, skips unreadable keys and caps the count', () => {
    expect(leafPaths({ l: [1, 2, 3, 4, 5] })).toEqual(['l[0]', 'l[1]', 'l[2]']);
    expect(leafPaths({ 'a.b': 1, ok: 2 })).toEqual(['ok']);
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(leafPaths(wide, 10)).toHaveLength(10);
  });

  it('gives nothing for a bare value', () => {
    expect(leafPaths('x')).toEqual([]);
  });
});
