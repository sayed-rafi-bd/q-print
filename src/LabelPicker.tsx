import { useState } from 'react';
import type { LabelId, LabelMeta } from './labels';

const smallBtn =
  'cursor-pointer rounded-full border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 ' +
  'transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

const selectCls =
  'w-full rounded-xl border border-slate-300 bg-white text-sm shadow-sm transition ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 ' +
  'disabled:bg-slate-100';

type Props = {
  labels: LabelMeta[];
  value: LabelId;
  disabled?: boolean;
  busy?: boolean;
  onChange: (id: LabelId) => void;
  /** Reads the labels again. Returns why it failed, or null when it worked. */
  onReload: () => Promise<string | null>;
};

/**
 * The label picker, with a way to read the list again.
 *
 * The list is loaded when the app starts and again when the tab is opened, but the Print tab is
 * always visible on a phone, so nothing re-reads it after that. The button also covers the case
 * where the first attempt failed: a network problem should not need an app restart to get past.
 */
export default function LabelPicker({ labels, value, disabled, busy, onChange, onReload }: Props) {
  const [reloading, setReloading] = useState(false);
  const [note, setNote] = useState('');

  const reload = async () => {
    setReloading(true); setNote('');
    try {
      const failure = await onReload();
      if (failure) setNote(failure);
      else setNote(labels.length > 0 ? 'Labels reloaded.' : 'No labels found.');
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <select aria-label="Label" value={value}
          disabled={disabled || busy || labels.length === 0}
          onChange={e => onChange(e.target.value as LabelId)}
          className={selectCls}>
          {labels.map(l => (
            <option key={l.id} value={l.id}>{l.name} — {l.widthMm} × {l.heightMm} mm</option>
          ))}
        </select>
        <button type="button" onClick={reload} disabled={reloading || disabled}
          aria-label="Reload labels from the database" className={smallBtn}>
          {reloading ? 'Reloading…' : 'Reload labels'}
        </button>
      </div>
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}
