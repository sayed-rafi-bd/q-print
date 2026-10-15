import { useState } from 'react';
import type { LabelId, LabelMeta, NewLabel } from '../labels';
import { SAMPLE_LABEL_NAME, SAMPLE_SIZE } from '../sampleLabel';

/** Common label sizes, so most labels are one click rather than two typed numbers. */
const PRESETS: { label: string; widthMm: number; heightMm: number }[] = [
  { label: 'Shipping 110 × 86', widthMm: 110, heightMm: 86 },
  { label: 'Product 190 × 160', widthMm: 190, heightMm: 160 },
  { label: 'A6 105 × 148', widthMm: 105, heightMm: 148 },
  { label: 'A7 74 × 105', widthMm: 74, heightMm: 105 },
  { label: 'Address 100 × 50', widthMm: 100, heightMm: 50 },
  { label: 'Small 50 × 25', widthMm: 50, heightMm: 25 },
];

const MIN_MM = 10;
const MAX_MM = 1000;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const btnCls =
  'cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';
const btnPrimaryCls = `${btnCls} bg-indigo-600 text-white hover:bg-indigo-500`;
const btnPlainCls = `${btnCls} border border-slate-300 text-slate-700 hover:bg-slate-50`;
const inputCls =
  'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

type Props = {
  /** Labels that can be copied from; the new one starts with their layout and generator. */
  labels: LabelMeta[];
  /** Creates the label. Resolves once it is on disk. */
  onCreate: (label: NewLabel) => Promise<unknown>;
  onClose: () => void;
};

/** "New label" dialog: a name, a size, and what to start from. */
export default function NewLabelDialog({ labels, onCreate, onClose }: Props) {
  const [name, setName] = useState('');
  const [widthMm, setWidthMm] = useState(SAMPLE_SIZE.widthMm);
  const [heightMm, setHeightMm] = useState(SAMPLE_SIZE.heightMm);
  const [from, setFrom] = useState<LabelId | 'sample' | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sizeOk = widthMm >= MIN_MM && heightMm >= MIN_MM && widthMm <= MAX_MM && heightMm <= MAX_MM;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sizeOk || busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({
        name: name.trim(),
        widthMm,
        heightMm,
        from: from === 'sample' ? { kind: 'sample' } : from ? { kind: 'copy', id: from } : { kind: 'blank' },
      });
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const options: { value: LabelId | 'sample' | ''; label: string; hint: string; onPick?: () => void }[] = [
    {
      value: '',
      label: 'A blank label',
      hint: 'An empty page. Add fields in the Layout tab.',
      onPick: () => {
        setName('');
        setWidthMm(100);
        setHeightMm(50);
      },
    },
    {
      value: 'sample',
      label: 'The sample label',
      hint: 'A small ready-made label, so there is something to print straight away.',
      onPick: () => {
        setName(SAMPLE_LABEL_NAME);
        setWidthMm(SAMPLE_SIZE.widthMm);
        setHeightMm(SAMPLE_SIZE.heightMm);
      },
    },
    ...labels.map((l) => ({
      value: l.id,
      label: `Copy of “${l.name}”`,
      hint: 'Its layout and its data rules, which you can then change.',
      onPick: () => {
        setWidthMm(l.widthMm);
        setHeightMm(l.heightMm);
      },
    })),
  ];

  return (
    <form onSubmit={submit} className="tab-enter space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="space-y-1">
        <label htmlFor="new-label-name" className="text-sm font-medium text-slate-700">
          Name
        </label>
        <input
          id="new-label-name"
          // biome-ignore lint/a11y/noAutofocus: focus the field when this dialog opens
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My parcel label"
          className={`${inputCls} w-full`}
        />
        <p className="text-xs text-slate-500">Shown in the label list. The file name is made from it.</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">Size</legend>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setWidthMm(p.widthMm);
                setHeightMm(p.heightMm);
              }}
              className={
                btnCls +
                ' border border-slate-300 text-slate-700 hover:bg-slate-50' +
                (widthMm === p.widthMm && heightMm === p.heightMm
                  ? ' border-indigo-500 bg-indigo-50 text-indigo-700'
                  : '')
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <input
            aria-label="Width in mm"
            type="number"
            min={MIN_MM}
            max={MAX_MM}
            value={widthMm}
            onChange={(e) => setWidthMm(+e.target.value)}
            className={`${inputCls} w-24`}
          />
          <span>×</span>
          <input
            aria-label="Height in mm"
            type="number"
            min={MIN_MM}
            max={MAX_MM}
            value={heightMm}
            onChange={(e) => setHeightMm(+e.target.value)}
            className={`${inputCls} w-24`}
          />
          <span className="text-slate-500">mm</span>
        </div>
        {!sizeOk && (
          <p className="text-xs text-red-700">
            A label must be between {MIN_MM} and {MAX_MM} mm.
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-slate-700">Start from</legend>
        {options.map((o) => (
          <label key={o.value || 'blank'} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
            <input
              type="radio"
              name="start-from"
              value={o.value}
              checked={from === o.value}
              onChange={() => {
                setFrom(o.value);
                o.onPick?.();
              }}
              className="mt-1"
            />
            <span>
              <span className="block">{o.label}</span>
              <span className="block text-xs text-slate-500">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p role="alert" className="break-words text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit" className={btnPrimaryCls} disabled={busy || !sizeOk || !name.trim()}>
          {busy ? 'Creating…' : 'Create label'}
        </button>
        <button type="button" className={btnPlainCls} onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
