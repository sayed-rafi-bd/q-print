import { useState } from 'react';
import { MAX_NAME } from '../labelId';
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
    // A full-width panel. `@container` makes the two columns depend on the width of the panel itself
    // rather than the window, so it still folds to one column when the Designer is squeezed.
    <form
      onSubmit={submit}
      className="tab-enter @container w-full rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="grid gap-x-8 gap-y-4 p-4 @2xl:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div>
            <label htmlFor="new-label-name" className="field-label">
              Name
            </label>
            <input
              id="new-label-name"
              // biome-ignore lint/a11y/noAutofocus: focus the field when this dialog opens
              autoFocus
              value={name}
              maxLength={MAX_NAME}
              onChange={(e) => setName(e.target.value)}
              placeholder="My parcel label"
              className="field"
            />
            <p className="field-hint">
              Shown in the label list, up to {MAX_NAME} characters ({Array.from(name).length}/{MAX_NAME}). The file name
              is made from it.
            </p>
          </div>

          <fieldset className="min-w-0">
            <legend className="field-label">Size</legend>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={widthMm === p.widthMm && heightMm === p.heightMm}
                  onClick={() => {
                    setWidthMm(p.widthMm);
                    setHeightMm(p.heightMm);
                  }}
                  className="btn btn-secondary btn-sm"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 text-body text-slate-700">
              <input
                aria-label="Width in mm"
                type="number"
                min={MIN_MM}
                max={MAX_MM}
                value={widthMm}
                onChange={(e) => setWidthMm(+e.target.value)}
                className="field field-num"
              />
              <span aria-hidden="true">×</span>
              <input
                aria-label="Height in mm"
                type="number"
                min={MIN_MM}
                max={MAX_MM}
                value={heightMm}
                onChange={(e) => setHeightMm(+e.target.value)}
                className="field field-num"
              />
              <span className="text-slate-500">mm</span>
            </div>
            {!sizeOk && (
              <p className="field-hint text-danger-700">
                A label must be between {MIN_MM} and {MAX_MM} mm.
              </p>
            )}
          </fieldset>
        </div>

        <fieldset className="min-w-0 space-y-2">
          <legend className="field-label">Start from</legend>
          {options.map((o) => (
            <label key={o.value || 'blank'} className="flex cursor-pointer items-start gap-2 text-body text-slate-700">
              <input
                type="radio"
                name="start-from"
                value={o.value}
                checked={from === o.value}
                onChange={() => {
                  setFrom(o.value);
                  o.onPick?.();
                }}
                className="mt-1 shrink-0"
              />
              <span className="min-w-0">
                <span className="block break-words">{o.label}</span>
                <span className="field-hint mt-0 block">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>

      {error && (
        <p role="alert" className="break-words border-t border-red-200 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 px-4 py-3">
        <button type="submit" className="btn btn-primary" disabled={busy || !sizeOk || !name.trim()}>
          {busy ? 'Creating…' : 'Create label'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
