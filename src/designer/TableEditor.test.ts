import { describe, expect, it } from 'vitest';
import { parseCsv } from './TableEditor';

describe('parseCsv', () => {
  it('reads comma-separated rows', () => {
    expect(parseCsv('150-0021, Tokyo\n100-0005, Tokyo')).toEqual([
      ['150-0021', 'Tokyo'],
      ['100-0005', 'Tokyo'],
    ]);
  });

  it('reads tab-separated rows, which is what a spreadsheet gives', () => {
    expect(parseCsv('150-0021\tTokyo\r\n100-0005\tTokyo')).toEqual([
      ['150-0021', 'Tokyo'],
      ['100-0005', 'Tokyo'],
    ]);
  });

  it('trims the spaces people leave around cells', () => {
    expect(parseCsv('  a ,  b  ')).toEqual([['a', 'b']]);
  });

  it('pads short rows so every row lines up with the columns', () => {
    expect(parseCsv('a,b,c\nd')).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a\n\n\nb')).toEqual([['a'], ['b']]);
  });

  it('ignores a row that is entirely empty', () => {
    expect(parseCsv('a\n , \nb')).toEqual([['a'], ['b']]);
  });

  it('returns nothing for empty input, so the caller can refuse the paste', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('   \n\n')).toEqual([]);
  });
});
