import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from './db/users';
import {
  clearHistory,
  dayHeading,
  dayKey,
  formatDuration,
  groupByDay,
  HISTORY_LIMIT,
  loadHistory,
  type PrintAttempt,
  plural,
  recordAttempt,
} from './printHistory';

const rafi = { id: 'u1', username: 'rafi' } as User;
const zahid = { id: 'u2', username: 'zahid' } as User;

/** A successful attempt, with everything a successful attempt knows. */
const ok = (over: Partial<PrintAttempt> = {}): PrintAttempt => ({
  at: 1_700_000_000_000,
  labelId: 'lbl_1',
  labelName: 'Product',
  printer: 'Office',
  outcome: 'ok',
  pages: 12,
  records: 3,
  transport: 'sumatra',
  error: null,
  ms: 820,
  ...over,
});

/** A failed one: it stopped before any of the job details were known. */
const failed = (over: Partial<PrintAttempt> = {}): PrintAttempt => ({
  at: 1_700_000_000_000,
  labelId: 'lbl_1',
  labelName: 'Product',
  printer: 'Office',
  outcome: 'error',
  pages: null,
  records: null,
  transport: null,
  error: 'The printer did not answer.',
  ms: 3000,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
});

describe('keeping the history', () => {
  it('reads back what was written', () => {
    recordAttempt(rafi, ok());
    expect(loadHistory(rafi)).toEqual([ok()]);
  });

  it('starts empty rather than inventing one', () => {
    expect(loadHistory(rafi)).toEqual([]);
  });

  it('puts the newest first', () => {
    recordAttempt(rafi, ok({ at: 1000, labelName: 'First' }));
    recordAttempt(rafi, ok({ at: 2000, labelName: 'Second' }));
    recordAttempt(rafi, ok({ at: 3000, labelName: 'Third' }));
    expect(loadHistory(rafi).map((e) => e.labelName)).toEqual(['Third', 'Second', 'First']);
  });

  it('keeps a failure as readily as a success', () => {
    // Decided deliberately: a printer that keeps failing is exactly what somebody opens a history to
    // find, so a failed attempt has to be as visible as a good one.
    recordAttempt(rafi, failed({ at: 1000 }));
    recordAttempt(rafi, ok({ at: 2000 }));
    const [newest, older] = loadHistory(rafi);
    expect(newest.outcome).toBe('ok');
    expect(older.outcome).toBe('error');
    expect(older.error).toBe('The printer did not answer.');
  });

  it('keeps only the last few, dropping the oldest', () => {
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      recordAttempt(rafi, ok({ at: i, labelName: `Print ${i}` }));
    }
    const kept = loadHistory(rafi);
    expect(kept).toHaveLength(HISTORY_LIMIT);
    // The newest is still at the top and the oldest are the ones that went.
    expect(kept[0].labelName).toBe(`Print ${HISTORY_LIMIT + 24}`);
    expect(kept[kept.length - 1]?.labelName).toBe(`Print 25`);
    expect(kept.some((e) => e.labelName === 'Print 0')).toBe(false);
  });

  it('keeps each account to itself', () => {
    recordAttempt(rafi, ok({ labelName: 'Rafi print' }));
    recordAttempt(zahid, ok({ labelName: 'Zahid print' }));
    expect(loadHistory(rafi).map((e) => e.labelName)).toEqual(['Rafi print']);
    expect(loadHistory(zahid).map((e) => e.labelName)).toEqual(['Zahid print']);
  });

  it('clears only the account that asked', () => {
    recordAttempt(rafi, ok());
    recordAttempt(zahid, ok());
    clearHistory(rafi);
    expect(loadHistory(rafi)).toEqual([]);
    expect(loadHistory(zahid)).toHaveLength(1);
  });
});

describe('a history that has been damaged', () => {
  const write = (value: string) => localStorage.setItem('q-print.history.u1', value);

  it('shows nothing rather than failing to open the page', () => {
    write('{not json');
    expect(loadHistory(rafi)).toEqual([]);
  });

  it('shows nothing when what is stored is not a list', () => {
    write('{"label":"Product"}');
    expect(loadHistory(rafi)).toEqual([]);
  });

  it('drops one broken entry and keeps the rest', () => {
    // The alternative — losing the whole history to a single bad entry — is worse than the gap.
    write(JSON.stringify([ok({ at: 2000, labelName: 'Good' }), { nonsense: true }, ok({ at: 1000 })]));
    expect(loadHistory(rafi).map((e) => e.labelName)).toEqual(['Good', 'Product']);
  });

  it('rejects an entry with no time, which has nowhere to sit in the list', () => {
    write(JSON.stringify([{ ...ok(), at: undefined }, ok()]));
    expect(loadHistory(rafi)).toHaveLength(1);
  });

  it('rejects an entry with no label name or printer, which says nothing useful', () => {
    write(JSON.stringify([{ ...ok(), labelName: undefined }, { ...ok(), printer: undefined }, ok()]));
    expect(loadHistory(rafi)).toHaveLength(1);
  });

  it('fills in what an older entry did not record', () => {
    // Written by an earlier version that knew less; it is still worth showing.
    write(JSON.stringify([{ at: 1000, labelName: 'Product', printer: 'Office', outcome: 'ok' }]));
    expect(loadHistory(rafi)).toEqual([
      ok({ at: 1000, labelId: '', pages: null, records: null, transport: null, ms: null }),
    ]);
  });

  it('treats an unrecognised outcome as a print that happened', () => {
    write(JSON.stringify([{ ...ok(), outcome: 'something-new' }]));
    expect(loadHistory(rafi)[0].outcome).toBe('ok');
  });
});

describe('when there is nowhere to keep it', () => {
  it('does not fail the print that already succeeded', () => {
    const full = {
      getItem: () => {
        throw new Error('QuotaExceededError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: full, configurable: true });
    try {
      expect(() => recordAttempt(rafi, ok())).not.toThrow();
      expect(loadHistory(rafi)).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true });
    }
  });
});

describe('grouping by day', () => {
  // Midday local, so nothing here lands near midnight and the day key cannot be ambiguous.
  const noon = (day: number, month = 0) => new Date(2026, month, day, 12).getTime();
  const now = noon(16);

  it('names a day by its own calendar date', () => {
    expect(dayKey(noon(16))).toBe('2026-01-16');
    // Zero-padded, so string ordering matches date ordering.
    expect(dayKey(noon(1, 8))).toBe('2026-09-01');
  });

  it('calls the days being lived through Today and Yesterday', () => {
    expect(dayHeading(dayKey(now), now)).toBe('Today');
    expect(dayHeading(dayKey(noon(15)), now)).toBe('Yesterday');
  });

  it('calls anything older a plain date, without the year while it is still this one', () => {
    expect(dayHeading(dayKey(noon(14)), now)).toBe('Jan 14');
    expect(dayHeading(dayKey(noon(16, 0) - 86_400_000 * 40), now)).not.toBe('Yesterday');
  });

  it('puts the year back for a day in another year', () => {
    const lastYear = new Date(2025, 11, 25, 12).getTime();
    expect(dayHeading(dayKey(lastYear), now)).toContain('2025');
  });

  it('keeps each day together and the order it was given', () => {
    const groups = groupByDay([
      ok({ at: noon(16, 0), labelName: 'Newest' }),
      ok({ at: noon(16, 0) - 3600_000, labelName: 'Same day, earlier' }),
      ok({ at: noon(15), labelName: 'Yesterday' }),
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.labelName))).toEqual([
      ['Newest', 'Same day, earlier'],
      ['Yesterday'],
    ]);
  });

  it('has no groups for an empty history', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('a count with its noun', () => {
  it('agrees in number', () => {
    // Caught by eye on the page: a history showing "1 pages" is the sort of small wrong that makes
    // the whole screen feel unfinished.
    expect(plural(0, 'page')).toBe('0 pages');
    expect(plural(1, 'page')).toBe('1 page');
    expect(plural(2, 'page')).toBe('2 pages');
    expect(plural(120, 'page')).toBe('120 pages');
    expect(plural(1, 'record')).toBe('1 record');
  });
});

describe('a duration', () => {
  it('is null when nothing was timed', () => {
    expect(formatDuration(null)).toBeNull();
  });

  it('reads in milliseconds below a second, seconds below a minute, then minutes', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(820)).toBe('820 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(59_000)).toBe('59.0 s');
    expect(formatDuration(60_000)).toBe('1 min 0 s');
    expect(formatDuration(95_400)).toBe('1 min 35 s');
  });
});
