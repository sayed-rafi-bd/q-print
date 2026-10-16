/**
 * What has been printed, and what went wrong trying.
 *
 * Device-local and account-local, and deliberately not in the database. A print history is an aid
 * for the person standing at the printer — "did it go out, to what, and how long did it take" — not
 * a record anybody else needs, so it lives in `localStorage` under one key per account alongside the
 * other device-local things (who is signed in, which label was last used).
 *
 * Nothing here is ever sent anywhere. It is written once per print attempt and read by the History
 * tab.
 *
 * The store is read leniently and written defensively. `localStorage` holds whatever is in it, which
 * includes hand-edited and truncated JSON, and a history page that refuses to open because one entry
 * is malformed is worse than one missing an entry. Writing never throws: a print that already
 * succeeded must not be reported as a failure because there was no room left to record it.
 */

import type { User } from './db/users';

/**
 * One print attempt, successful or not.
 *
 * Fields that could only be known once the job went out are nullable, because a failed print stops
 * before it has any of them.
 */
export type PrintAttempt = {
  /** Epoch milliseconds. Also the sort key: newest first. */
  at: number;
  /** The label's id. */
  labelId: string;
  /** The name as it was when printed, so renaming a label does not rewrite the past. */
  labelName: string;
  /** The printer as chosen. Empty means the system dialog, where no printer was chosen yet. */
  printer: string;
  outcome: 'ok' | 'error';
  /** Pages actually sent, or null when it never got that far. */
  pages: number | null;
  /** Records read from an API, or null for a label that has no API source. */
  records: number | null;
  /** How the job left: 'sumatra', 'cups', 'android-dialog', 'ipp', 'raw', 'vendor'. */
  transport: string | null;
  /** The message, when it failed. */
  error: string | null;
  /** End to end, in whole milliseconds. Null when it failed before there was anything to time. */
  ms: number | null;
  /**
   * Who started it. `ui` is the Print tab; `api` is a caller of the local HTTP API.
   *
   * Optional because history written before this field existed is still worth showing: an entry
   * with no `source` was a print from the UI, which is what everything was before.
   */
  source?: 'ui' | 'api';
};

/**
 * How many attempts are kept. The oldest fall off the end.
 *
 * 200 is about a month of daily printing and stays well inside the `localStorage` budget, so a long
 * history can never be the reason something else stops working.
 */
export const HISTORY_LIMIT = 200;

// Keyed by account, because the app can have more than one and a shared history would be confusing:
// the person signing in has to see their own prints, not whoever used the device last.
const key = (user: User) => `q-print.history.${user.id}`;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One stored value as an entry, or null when it is not one. */
function toAttempt(value: unknown): PrintAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  // `at` orders the list and identifies the row, so an entry without a usable one has nowhere to sit.
  if (num(r.at) === null) return null;
  // The name and printer are what the row is read for. An entry missing either says nothing useful.
  if (typeof r.labelName !== 'string' || typeof r.printer !== 'string') return null;
  return {
    at: r.at as number,
    labelId: str(r.labelId) ?? '',
    labelName: r.labelName,
    printer: r.printer,
    // Anything that is not explicitly a failure counts as a success: an unknown outcome is not a
    // reason to hide a print that did happen.
    outcome: r.outcome === 'error' ? 'error' : 'ok',
    pages: num(r.pages),
    records: num(r.records),
    transport: str(r.transport),
    error: str(r.error),
    ms: num(r.ms),
  };
}

/** Every attempt on this device, newest first. */
export function loadHistory(user: User): PrintAttempt[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(user)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    // One unreadable entry is dropped on its own. Losing the whole history to a single bad entry
    // would be a worse outcome than losing that entry.
    return parsed.map(toAttempt).filter((a): a is PrintAttempt => a !== null);
  } catch {
    // Unparseable JSON, or storage unavailable (private browsing, a locked profile).
    return [];
  }
}

/** Adds one attempt to the front, trimming anything past the limit. */
export function recordAttempt(user: User, attempt: PrintAttempt): void {
  try {
    const next = [attempt, ...loadHistory(user)].slice(0, HISTORY_LIMIT);
    localStorage.setItem(key(user), JSON.stringify(next));
  } catch {
    /* Out of room, or no storage. The print itself already succeeded; nothing to report. */
  }
}

/** Forgets everything. Used by the Clear button on the History tab. */
export function clearHistory(user: User): void {
  try {
    localStorage.removeItem(key(user));
  } catch {
    /* nothing to do */
  }
}

// ---------------------------------------------------------------------------------------------
// Grouping for display. Dates are the device's own calendar days, not UTC ones: somebody reading
// this wants to know what they printed this morning, and 00:30 local is not "yesterday".
// ---------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day an instant falls on, as `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * What to call that day. `Today` and `Yesterday` for the two that are being lived through, a plain
 * date for the rest — with the year left off while it is still the current one.
 *
 * `now` is passed in rather than read, so the wording can be tested without depending on the clock.
 */
export function dayHeading(day: string, now: number): string {
  if (day === dayKey(now)) return 'Today';
  // Stepping back a calendar day rather than subtracting 24 hours, which lands on the wrong day
  // across a daylight-saving change.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayKey(yesterday.getTime())) return 'Yesterday';

  const when = new Date(`${day}T00:00:00`);
  if (Number.isNaN(when.getTime())) return day;
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return when.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Splits a history into day groups, keeping the order it was given. */
export function groupByDay(entries: PrintAttempt[]): { day: string; entries: PrintAttempt[] }[] {
  const groups: { day: string; entries: PrintAttempt[] }[] = [];
  for (const entry of entries) {
    const day = dayKey(entry.at);
    const last = groups[groups.length - 1];
    // The list is already newest first, so an entry joins the last group whenever the day matches.
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

/** A count with its noun, agreeing in number. "1 page", "24 pages". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A duration as something short enough to sit beside a timestamp. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}
