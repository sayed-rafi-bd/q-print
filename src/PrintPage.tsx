import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import { useCapabilities } from './capabilities';
import DataSourceCard, { type CheckState } from './DataSourceCard';
import type { ApiSource } from './generator/spec';
import LabelPicker, { ReloadLabelsButton, useLabelReload } from './LabelPicker';
import {
  type LabelId,
  type LabelMeta,
  listLabels,
  loadLabel,
  loadLastLabel,
  loadSourceValues,
  rememberLabel,
  rememberSourceValues,
} from './labels';
import { Confetti, Mascot } from './Mascot';
import PrintersPanel from './PrintersPanel';
import { pickLabelAfterReload } from './pickLabel';
import {
  listPrinters,
  listSavedPrinters,
  type Margins,
  NO_MARGINS,
  type Orientation,
  type PrintReport,
  printerResolutions,
  printLabels,
  type Rotation,
  type Timings,
} from './printApi';
import { missingInput, startingValues } from './printRows';
import TemplateTransfer from './TemplateTransfer';

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Shared look of every text/number/select control. Padding and width are NOT in here, so each
// variant sets its own (two conflicting utilities on one element are resolved by stylesheet order,
// not by class order, so overriding one with the other is unreliable).
const fieldBase =
  'rounded-xl border border-slate-300 bg-white text-sm shadow-sm transition ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100';
const inputCls = `${fieldBase} w-full px-3 py-2`;
// The four margin boxes share one row, so they need tighter padding and must be allowed to shrink.
const marginInputCls = `${fieldBase} w-full min-w-0 px-2 py-1.5`;

const NAMED_PAPERS: { value: string; label: string }[] = [
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'letter',
  'legal',
  'tabloid',
  'statement',
].map((v) => ({ value: v, label: v.length <= 2 ? v : v[0].toUpperCase() + v.slice(1) }));

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

const dpiLabel = (r: string) => {
  const [x, y] = r.split('x');
  return x === y ? `${x} dpi` : `${x} × ${y} dpi`;
};

const ORIENTATIONS: { value: Orientation; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

/** Small "i" icon; the helper text appears while hovering or focusing it (tap it on a phone). */
function InfoTip({ text }: { text: React.ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="More information"
        aria-describedby={id}
        className="cursor-help rounded-full text-slate-400 transition hover:text-indigo-600 focus:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
          />
        </svg>
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute left-0 top-full z-20 mt-1.5 w-64 max-w-[calc(100vw-3rem)] rounded-lg bg-slate-900 p-2.5 text-xs/5 font-normal text-white opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        {hint && <InfoTip text={hint} />}
      </div>
      {children}
    </div>
  );
}

/** Title row of a group of controls (fieldset legend) with the same info icon as `Field`. */
function GroupTitle({ title, hint }: { title: string; hint: React.ReactNode }) {
  return (
    <legend className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
      {title}
      <InfoTip text={hint} />
    </legend>
  );
}

export default function PrintPage({ active = true }: { active?: boolean }) {
  const { user } = useAuth();
  const caps = useCapabilities();
  const [labels, setLabels] = useState<LabelMeta[]>([]);
  const [labelsError, setLabelsError] = useState('');
  const [labelsReady, setLabelsReady] = useState(false);
  const [labelId, setLabelId] = useState<LabelId>('');
  // Mirrored so `readLabels` can see the current choice without depending on it: a callback that
  // depended on `labelId` would be a new function every time the label changed, and the effect
  // below would re-read the database for a choice the user just made.
  const labelRef = useRef<LabelId>('');
  const label = labels.find((l) => l.id === labelId) ?? labels[0] ?? null;
  // The registry is read on mount, so there is no label for the first render, and none at all if
  // the folder could not be read. Every hint below derives from these rather than from `label`, so
  // a page that is still loading, or that has no labels, never dereferences nothing.
  const widthMm = label?.widthMm ?? 0;
  const heightMm = label?.heightMm ?? 0;
  const sizeText = label ? `${widthMm} × ${heightMm} mm` : '';
  const [printers, setPrinters] = useState<string[]>([]);
  const [printer, setPrinter] = useState('');
  // names of the network printers the user added; selecting one prints without a dialog
  const [directNames, setDirectNames] = useState<string[]>([]);
  const [paper, setPaper] = useState('');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [rotate, setRotate] = useState<Rotation>(0);
  const [margins, setMargins] = useState<Margins>(NO_MARGINS);
  const [dpi, setDpi] = useState('');
  const [resolutions, setResolutions] = useState<string[]>([]);
  const [dpiNote, setDpiNote] = useState('');
  const [pages, setPages] = useState(3);
  // The label's API data source, when it has one, and what the person typed for it. The token is
  // React state only: it is not remembered, not stored and is cleared when the label changes.
  const [source, setSource] = useState<ApiSource | null>(null);
  const [sourceValues, setSourceValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState('');
  const [checked, setChecked] = useState<CheckState>(null);
  // The label whose data source has been read. Printing waits for it, so a label that needs API
  // values can never be sent off before its Data source card has appeared.
  const [sourceLoadedFor, setSourceLoadedFor] = useState('');
  const [busy, setBusy] = useState(false);
  // The "Add a printer" section stays open until the user closes it, so more than one printer can be added.
  const [addOpen, setAddOpen] = useState(true);
  const [error, setError] = useState('');
  // bumped on every successful print so the confetti burst replays
  const [celebrate, setCelebrate] = useState(0);
  const [result, setResult] = useState<{
    label: string;
    pages: number;
    /** API records and the copies of each; null for a label without an API source. */
    records: number | null;
    copies: number;
    printer: string;
    t: Timings;
    report: PrintReport;
    source: string;
    silent: boolean;
  } | null>(null);

  // True when printing now goes straight to the printer: always on Windows and Linux, and on Android when a
  // saved network printer (not the "System print dialog" entry) is selected.
  const silent = caps.silent || (caps.directPrinters && directNames.includes(printer));

  // Reloads the printer list; `select` picks a printer (e.g. the one just saved), otherwise the
  // current choice is kept if it still exists.
  const directPrinters = caps.directPrinters;
  const reloadPrinters = useCallback(
    (select?: string) =>
      Promise.all([listPrinters(), directPrinters ? listSavedPrinters() : Promise.resolve([])])
        .then(([p, saved]) => {
          setPrinters(p);
          setDirectNames(saved.map((s) => s.name));
          setPrinter((cur) => (select && p.includes(select) ? select : p.includes(cur) ? cur : (p[0] ?? '')));
        })
        .catch((e) => setError(errMsg(e))),
    [directPrinters],
  );

  useEffect(() => {
    reloadPrinters();
  }, [reloadPrinters]);

  // Labels are added, renamed and deleted in the Designer, which stays mounted beside this page, so
  // the list is read again every time this tab is opened. Reading it only once left a deleted label
  // in the dropdown (and a new one missing) until the app was restarted. The Reload labels button
  // runs the same thing by hand, which is what covers a first attempt that failed.
  const readLabels = useCallback(async (): Promise<string | null> => {
    if (!user) return 'You are not signed in.';
    try {
      const registry = await listLabels(user);
      setLabels(registry);
      // Keep the label that is selected if it still exists; otherwise the one remembered last
      // time, unless that has been deleted too.
      const target = pickLabelAfterReload(registry, labelRef.current, loadLastLabel(user));
      setLabelsError('');
      setLabelsReady(true);
      if (target) {
        labelRef.current = target.id;
        setLabelId(target.id);
        rememberLabel(user, target.id);
      }
      return null;
    } catch (e) {
      const message = `Could not read your labels: ${errMsg(e)}`;
      setLabelsError(message);
      return message;
    }
  }, [user]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` is a deliberate trigger, re-read whenever this tab is shown
  useEffect(() => {
    readLabels();
  }, [readLabels, active]);
  const { reload: reloadLabels, reloading: reloadingLabels, note: labelsNote } = useLabelReload(labels, readLabels);

  // Ask the driver which resolutions it supports whenever the printer changes.
  useEffect(() => {
    setDpi('');
    setResolutions([]);
    setDpiNote('');
    if (!printer || !caps.dpiSelect) return;
    let stale = false;
    printerResolutions(printer)
      .then((r) => {
        if (!stale) {
          setResolutions(r);
          if (r.length === 0) setDpiNote('This driver reports no selectable resolutions.');
        }
      })
      .catch((e) => {
        if (!stale) setDpiNote(`Could not read resolutions: ${errMsg(e)}`);
      });
    return () => {
      stale = true;
    };
  }, [printer, caps.dpiSelect]);

  // Read the selected label's data source (built-in labels read the in-app mock API). A late answer for a
  // label that is no longer selected is ignored.
  const selectedId = label?.id ?? '';
  useEffect(() => {
    setSource(null);
    setToken('');
    setChecked(null);
    if (!user || !selectedId) return;
    let stale = false;
    loadLabel(user, selectedId)
      .then(({ generator }) => {
        if (stale) return;
        if (generator.source) {
          setSource(generator.source);
          setSourceValues(startingValues(generator.source, loadSourceValues(user, selectedId)));
        }
        setSourceLoadedFor(selectedId);
      })
      .catch(() => {
        // Printing reports a label that cannot be read, so it must not stay blocked here.
        if (!stale) setSourceLoadedFor(selectedId);
      });
    return () => {
      stale = true;
    };
  }, [user, selectedId]);

  const sourceReady = sourceLoadedFor === selectedId;

  const onPrint = async () => {
    if (!label || !user) return; // nothing selected yet; the button is disabled until there is one
    setBusy(true);
    setError('');
    setResult(null);
    if (source) {
      // Checked before any request, so a blank field or a missing token costs nothing.
      const missing = missingInput(source, sourceValues, token);
      if (missing) {
        setError(missing);
        setBusy(false);
        return;
      }
      rememberSourceValues(user, label.id, sourceValues);
    }
    try {
      const { timings, report, templateSource, pageCount, records } = await printLabels({
        user,
        label: label.id,
        printer,
        paper,
        orientation,
        rotate,
        margins,
        dpi,
        pages,
        api: source ? { values: sourceValues, token: token.trim() || undefined } : undefined,
      });
      setResult({
        label: label.name,
        pages: pageCount,
        records,
        copies: pages,
        printer,
        t: timings,
        report,
        source: templateSource,
        silent,
      });
      setCelebrate((n) => n + 1);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-full p-6">
      <div className="card-in stagger mx-auto grid max-w-md grid-cols-1 gap-x-8 gap-y-5 rounded-[2rem] bg-white/85 p-6 shadow-xl shadow-pink-200/60 ring-2 ring-white backdrop-blur-sm md:max-w-4xl md:grid-cols-2">
        <header className="md:col-span-2">
          <div className="flex items-center gap-3">
            <Mascot busy={busy} />
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Silent print test</h1>
              <p className="text-sm text-slate-500">
                {silent
                  ? `Generate random ${sizeText || 'label'}s and print without a dialog.`
                  : `Generate random ${sizeText || 'label'}s and print them through the system print dialog.`}
              </p>
            </div>
            <div className="ml-auto self-start">
              <ReloadLabelsButton onClick={reloadLabels} reloading={reloadingLabels} disabled={!user} />
            </div>
          </div>
          {!silent && caps.platform === 'android' && (
            <p className="mt-3 rounded-2xl bg-amber-50 p-2.5 text-xs text-amber-900 ring-1 ring-amber-200">
              The system print service always opens its preview, where you pick the printer and tap Print. To print with
              no dialog, add your printer under "Add a printer" below and select it.
            </p>
          )}
        </header>

        {/* No label to print: say so plainly rather than rendering a form that cannot work. */}
        {labelsReady && !label && (
          <p
            role="alert"
            className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200 md:col-span-2"
          >
            {labelsError || 'No labels were found.'} Open the Designer tab and press **New** to make one.
          </p>
        )}
        {labelsError && label && (
          <p className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200 md:col-span-2">
            {labelsError}
          </p>
        )}

        <Field label="Label" htmlFor="label" hint={`Page size ${sizeText}. Each label keeps its own saved template.`}>
          <LabelPicker
            labels={labels}
            value={labelId}
            busy={busy}
            disabled={!user}
            onChange={(id) => {
              setLabelId(id);
              if (user) rememberLabel(user, id);
              setResult(null);
              setToken('');
              setChecked(null);
            }}
            note={labelsNote}
          />
        </Field>

        <Field
          label="Printer"
          htmlFor="printer"
          hint={printers.length === 0 ? 'No printers found.' : `${printers.length} printer(s) detected`}
        >
          <select
            id="printer"
            className={`${inputCls} cursor-pointer disabled:cursor-not-allowed`}
            value={printer}
            disabled={busy}
            onChange={(e) => setPrinter(e.target.value)}
          >
            {printers.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>

        {source && (
          <DataSourceCard
            source={source}
            values={sourceValues}
            onValues={setSourceValues}
            token={token}
            onToken={setToken}
            copies={pages}
            checked={checked}
            onChecked={setChecked}
            disabled={busy}
          />
        )}

        {caps.directPrinters && (
          <details className="text-sm md:col-span-2" open={addOpen} onToggle={(e) => setAddOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer font-medium text-slate-700">Add a printer (no dialog)</summary>
            <PrintersPanel disabled={busy} onChanged={reloadPrinters} />
          </details>
        )}

        {caps.paperSelect && (
          <Field
            label="Paper size"
            htmlFor="paper"
            hint={
              caps.platform === 'linux'
                ? `CUPS only applies sizes the printer lists; an unlisted size is skipped and the printer's default paper is used. A custom size such as ${sizeText} must be the printer's default paper.`
                : `SumatraPDF can only set named sizes. A custom size such as ${sizeText} must be the printer driver's default paper.`
            }
          >
            <select
              id="paper"
              className={`${inputCls} cursor-pointer disabled:cursor-not-allowed`}
              value={paper}
              disabled={busy}
              onChange={(e) => setPaper(e.target.value)}
            >
              <option value="">{`Printer driver default (set this to ${sizeText})`}</option>
              {NAMED_PAPERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {caps.orientationSelect && (
          <fieldset className="space-y-1" disabled={busy}>
            <GroupTitle
              title="Orientation"
              hint={
                <>
                  The label itself is {label ? (widthMm >= heightMm ? 'landscape' : 'portrait') : 'of an unknown size'}{' '}
                  ({sizeText}). Auto leaves the choice to the printer driver.
                </>
              }
            />
            <div className="grid grid-cols-3 gap-2">
              {ORIENTATIONS.map((o) => {
                const selected = orientation === o.value;
                return (
                  <label
                    key={o.value}
                    className={
                      'pill rounded-lg border px-3 py-2 text-center text-sm transition ' +
                      (busy ? 'cursor-not-allowed opacity-60 ' : 'cursor-pointer ') +
                      (selected
                        ? 'border-indigo-600 bg-indigo-50 font-medium text-indigo-700 ring-1 ring-indigo-600'
                        : 'border-slate-300 text-slate-700 hover:bg-slate-50')
                    }
                  >
                    <input
                      type="radio"
                      name="orientation"
                      value={o.value}
                      checked={selected}
                      onChange={() => setOrientation(o.value)}
                      className="sr-only"
                    />
                    {o.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        <fieldset className="space-y-1" disabled={busy}>
          <GroupTitle
            title="Rotate label content"
            hint={
              <>
                Rotates the label inside the PDF, so it works with any driver.
                {label && (
                  <>
                    {' '}
                    On stock turned the other way (e.g. {heightMm} × {widthMm} mm) use 90° or 270° so the {sizeText}{' '}
                    label fills the paper at full size.
                  </>
                )}{' '}
                If it prints upside-down, use the other one.
              </>
            }
          />
          <div className="grid grid-cols-4 gap-2">
            {ROTATIONS.map((r) => {
              const selected = rotate === r;
              return (
                <label
                  key={r}
                  className={
                    'pill rounded-lg border px-3 py-2 text-center text-sm transition ' +
                    (busy ? 'cursor-not-allowed opacity-60 ' : 'cursor-pointer ') +
                    (selected
                      ? 'border-indigo-600 bg-indigo-50 font-medium text-indigo-700 ring-1 ring-indigo-600'
                      : 'border-slate-300 text-slate-700 hover:bg-slate-50')
                  }
                >
                  <input
                    type="radio"
                    name="rotate"
                    value={r}
                    checked={selected}
                    onChange={() => setRotate(r)}
                    className="sr-only"
                  />
                  {r}°
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-1" disabled={busy}>
          <GroupTitle
            title="Margins (mm)"
            hint="Positive adds white space (label prints smaller). Negative trims the label's edge so it fills more of the paper. Sides refer to the label before rotation. The printer's own non-printable area cannot be removed."
          />
          <div className="grid grid-cols-4 gap-2">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <label key={side} className="flex flex-col gap-0.5 text-xs text-slate-500">
                <span className="capitalize">{side}</span>
                <input
                  type="number"
                  step={0.1}
                  className={marginInputCls}
                  value={margins[side]}
                  onChange={(e) =>
                    setMargins({ ...margins, [side]: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
                  }
                />
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setMargins(NO_MARGINS)}
              className="cursor-pointer text-xs text-indigo-600 hover:underline"
            >
              Reset
            </button>
          </div>
        </fieldset>

        {caps.dpiSelect && (
          <Field
            label="Print resolution"
            htmlFor="dpi"
            hint={
              dpiNote || 'Options are what the printer driver reports. The previous setting is restored after printing.'
            }
          >
            <select
              id="dpi"
              className={`${inputCls} cursor-pointer disabled:cursor-not-allowed`}
              value={dpi}
              disabled={busy}
              onChange={(e) => setDpi(e.target.value)}
            >
              <option value="">Printer default</option>
              {resolutions.map((r) => (
                <option key={r} value={r}>
                  {dpiLabel(r)}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label={source ? 'Copies of each record' : 'Number of pages'}
          htmlFor="pages"
          hint={
            source
              ? 'Every record is printed this many times, copies together. An object response counts as one record.'
              : 'One label per page, each with different data.'
          }
        >
          <input
            id="pages"
            type="number"
            min={1}
            className={inputCls}
            value={pages}
            disabled={busy}
            onChange={(e) => setPages(Math.max(1, Math.floor(+e.target.value) || 1))}
          />
        </Field>

        <button
          type="button"
          onClick={onPrint}
          disabled={!printer || busy || !label || !sourceReady}
          className="btn-cute flex w-full md:col-span-2 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-3 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {busy && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <title>Printing</title>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </svg>
          )}
          {busy ? (silent ? 'Printing…' : 'Opening…') : silent ? 'Print ✨' : 'Print… ✨'}
        </button>

        {error && (
          // keyed on the message so a new error shakes again
          <div
            key={error}
            role="alert"
            className="alert-shake md:col-span-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 break-words"
          >
            {error}
          </div>
        )}

        {result && (
          <section className="result-in md:col-span-2 space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <Confetti key={celebrate} />
            <p className="text-sm text-emerald-800">
              <span className="mr-1" aria-hidden="true">
                🎉
              </span>
              {result.silent ? 'Sent' : 'Opened the print dialog for'} {result.pages} page(s)
              {result.records !== null &&
                ` (${result.records} ${result.records === 1 ? 'record' : 'records'} × ${result.copies} ${result.copies === 1 ? 'copy' : 'copies'})`}{' '}
              {result.silent ? 'to' : 'via'} <span className="font-medium">{result.printer}</span> using the{' '}
              <span className="font-medium">{result.label}</span> ({result.source} template)
            </p>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-600">Total time</span>
              <span className="text-2xl font-semibold text-slate-900">{fmt(result.t.total)}</span>
            </div>
            <dl className={`grid gap-2 text-center text-xs ${result.records !== null ? 'grid-cols-4' : 'grid-cols-3'}`}>
              {(
                [
                  ...(result.records !== null ? ([['Fetch', result.t.fetch]] as const) : []),
                  ['Data', result.t.data],
                  ['PDF build', result.t.pdf],
                  [result.silent ? 'Send to printer' : 'Open dialog', result.t.print],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-md bg-white p-2 ring-1 ring-slate-200">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="mt-0.5 text-sm font-medium text-slate-900">{fmt(v)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-slate-500">
              {result.silent
                ? '"Send to printer" ends when the job has been handed to the printer or the OS spooler, not when paper comes out.'
                : '"Open dialog" ends when the system print preview is requested, not when you tap Print or paper comes out.'}
            </p>

            <div className="space-y-1.5 border-t border-emerald-200 pt-3">
              <p className="text-xs text-slate-600">
                Transport:{' '}
                <span className="rounded-full bg-emerald-200 px-2 py-0.5 font-medium text-emerald-900">
                  {result.report.transport}
                </span>{' '}
                <span className="text-slate-500">({result.report.tool})</span>
              </p>
              {caps.paperSelect ? (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">
                      Paper size{' '}
                      <span className="font-medium text-slate-900">
                        {result.report.paperRequested || '(driver default)'}
                      </span>
                    </span>
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-xs font-medium ' +
                        (result.report.paperApplied ? 'bg-emerald-200 text-emerald-900' : 'bg-slate-200 text-slate-800')
                      }
                    >
                      {result.report.paperApplied ? `sent to ${result.report.tool}` : 'driver default'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 break-words">{result.report.paperNote}</p>
                </>
              ) : (
                <p className="text-xs text-slate-600 break-words">{result.report.paperNote}</p>
              )}
              {caps.orientationSelect && (
                <p className="text-xs text-slate-600">
                  Orientation: <span className="font-medium">{result.report.orientation}</span>
                </p>
              )}
              {caps.dpiSelect && (
                <p className="text-xs text-slate-600">
                  Resolution:{' '}
                  <span className="font-medium">
                    {result.report.dpiRequested ? dpiLabel(result.report.dpiRequested) : 'printer default'}
                  </span>
                  {' — '}
                  {result.report.dpiNote}
                </p>
              )}
              <pre className="overflow-x-auto rounded-md bg-slate-900 p-2 text-xs text-slate-100">
                {result.report.command}
              </pre>
            </div>
          </section>
        )}

        <details className="border-t border-slate-200 pt-3 text-sm md:col-span-2">
          <summary className="cursor-pointer font-medium text-slate-700">Template: export / import</summary>
          <p className="mb-2 mt-2 text-xs text-slate-500">
            The saved template of the selected label lives on each device. Export it from one and import it on another
            (for example from desktop to Android) so both print the same layout.
          </p>
          <TemplateTransfer key={labelId} label={labelId} />
        </details>
      </div>
    </main>
  );
}
