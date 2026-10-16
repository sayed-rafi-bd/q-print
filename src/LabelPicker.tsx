import { useState } from 'react';
import type { LabelId, LabelMeta } from './labels';

const smallBtn =
  'cursor-pointer rounded-full border border-slate-300 size-8 text-xs font-medium text-slate-700 ' +
  'transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

const selectCls =
  'w-full cursor-pointer rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100';

type Props = {
  labels: LabelMeta[];
  value: LabelId;
  disabled?: boolean;
  busy?: boolean;
  onChange: (id: LabelId) => void;
  /** Status line from the last reload, shown under the dropdown. */
  note?: string;
};

/**
 * Reads the label list again. Returns the state for the reload button and the status note.
 *
 * The list is loaded when the app starts and again when the tab is opened, but the Print tab is
 * always visible on a phone, so nothing re-reads it after that. The button also covers the case
 * where the first attempt failed: a network problem should not need an app restart to get past.
 *
 * `onReload` returns why it failed, or null when it worked.
 */
export function useLabelReload(labels: LabelMeta[], onReload: () => Promise<string | null>) {
  const [reloading, setReloading] = useState(false);
  const [note, setNote] = useState('');

  const reload = async () => {
    setReloading(true);
    setNote('');
    try {
      const failure = await onReload();
      if (failure) setNote(failure);
      else setNote(labels.length > 0 ? 'Labels reloaded.' : 'No labels found.');
    } finally {
      setReloading(false);
    }
  };

  return { reload, reloading, note };
}

/** Small button for the top-right corner of the Label field's title row. */
export function ReloadLabelsButton({
  onClick,
  reloading,
  disabled,
}: {
  onClick: () => void;
  reloading: boolean;
  disabled?: boolean;
}) {
  // Represent the same action with an SVG rather than an emoji. Emoji render differently (or not at
  // all) on some systems, and an arrow can actually turn while the re-read is running.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={reloading || disabled}
      aria-label="Reload labels from the database"
      className={`${smallBtn} inline-flex items-center justify-center whitespace-nowrap`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`h-3.5 w-3.5 ${reloading ? 'animate-spin' : ''}`}
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
        <polyline points="21 3 21 8 16 8" />
      </svg>
    </button>
  );
}

/** The label picker: a full-width dropdown plus the status note. */
export default function LabelPicker({ labels, value, disabled, busy, onChange, note }: Props) {
  return (
    <div className="space-y-1">
      <select
        aria-label="Label"
        value={value}
        disabled={disabled || busy || labels.length === 0}
        onChange={(e) => onChange(e.target.value as LabelId)}
        className={selectCls}
      >
        {labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} — {l.widthMm} × {l.heightMm} mm
          </option>
        ))}
      </select>
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}
