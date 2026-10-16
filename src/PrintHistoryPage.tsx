import { useEffect, useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import {
  clearHistory,
  dayHeading,
  formatDuration,
  groupByDay,
  HISTORY_LIMIT,
  loadHistory,
  type PrintAttempt,
  plural,
} from './printHistory';

/**
 * The History tab: what has been printed from this device, and what failed.
 *
 * Read-only on purpose. Reprinting would be the obvious thing to want here, but a label's API
 * address is never stored — deliberately, so a print can only ever go to a host the person typed
 * this session — so a "Print again" button would sit there promising something it could not deliver
 * for exactly the labels where it would be most wanted. The entries instead say plainly what went
 * where, which is what a history is usually opened for: confirming a run went out, or working out
 * which printer keeps failing.
 *
 * A failure is kept as readily as a success. Somebody whose labels stopped printing needs to see
 * that, and the entries are marked rather than hidden.
 */

const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** One row: what was printed, where, how much, and how it went. */
function Attempt({ entry }: { entry: PrintAttempt }) {
  const failed = entry.outcome === 'error';
  const duration = formatDuration(entry.ms);

  return (
    <li className="card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">{entry.labelName}</span>
        {failed ? (
          <span className="badge badge-danger">Failed</span>
        ) : (
          // The count of pages is the number somebody checking a box of labels actually wants.
          <span className="badge badge-accent">{plural(entry.pages ?? 0, 'page')}</span>
        )}
        {entry.records !== null && <span className="badge badge-neutral">{plural(entry.records, 'record')}</span>}
        {/* An API print is worth marking: it came from somewhere the person did not click. */}
        {entry.source === 'api' && (
          <span className="badge badge-warn" title="Started by a caller of the local print API">
            API
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums text-slate-500">
          {timeOf(entry.at)}
          {duration ? ` · ${duration}` : ''}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-600">
        {/* Empty when the printer is chosen in the system dialog, which is the common case there. */}
        {entry.printer || 'the system print dialog'}
        {entry.transport ? ` · via ${entry.transport}` : ''}
      </p>

      {failed && entry.error && (
        <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">{entry.error}</p>
      )}
    </li>
  );
}

export default function PrintHistoryPage({ active = true }: { active?: boolean }) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<PrintAttempt[]>([]);
  const [confirming, setConfirming] = useState(false);

  // Re-read whenever the tab is shown rather than only on mount. The tabs all stay mounted so
  // unsaved Designer edits survive switching, so a page that read once would show a history from
  // before the print that was just made. `active` is a dependency for that reason.
  useEffect(() => {
    if (!active || !user) return;
    setEntries(loadHistory(user));
    setConfirming(false);
  }, [active, user]);

  if (!user) return null;

  const groups = groupByDay(entries);
  // Re-read after clearing rather than filtering the list in place, so what is left is exactly what
  // is stored, and a store that could not be cleared does not look as though it had.
  const onClear = () => {
    clearHistory(user);
    setEntries(loadHistory(user));
    setConfirming(false);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-10 md:p-8">
      {/* The title and the clear control share a row: on a tall page the button would otherwise sit
          alone a third of the way down, far from anything it affects. */}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-bold text-slate-900">Print history</h1>
          <p className="max-w-lg text-sm text-slate-600">
            The last {HISTORY_LIMIT} prints from this device. Kept here only — nothing is sent anywhere, and accounts do
            not see each other's.
          </p>
        </div>

        {entries.length > 0 &&
          (confirming ? (
            // Two steps, because this cannot be undone. Not the Designer's confirm pattern: that one
            // guards a draft that can be recreated, and this cannot.
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className="text-xs text-slate-600">Delete all {entries.length}?</span>
              <button type="button" className="btn btn-danger" onClick={onClear}>
                Delete
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </div>
          ) : (
            // `ml-auto` so it sits at the right whether or not it fits beside the title.
            <button type="button" className="btn btn-secondary ml-auto shrink-0" onClick={() => setConfirming(true)}>
              Clear history
            </button>
          ))}
      </header>

      {entries.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-slate-500">
          Nothing printed yet. Anything you print on the Print tab is listed here.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.day} aria-label={dayHeading(group.day, Date.now())} className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {dayHeading(group.day, Date.now())}
              </h2>
              <ul className="space-y-2">
                {group.entries.map((entry) => (
                  <Attempt key={`${entry.at}-${entry.labelId}`} entry={entry} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
