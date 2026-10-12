import { useEffect, useState } from 'react';
import {
  listPrinters, printerResolutions, printLabels, NO_MARGINS,
  type Margins, type Orientation, type PrintReport, type Rotation, type Timings,
} from './printApi';
import { useCapabilities } from './capabilities';
import TemplateTransfer from './TemplateTransfer';

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Shared look of every text/number/select control. Padding and width are NOT in here, so each
// variant sets its own (two conflicting utilities on one element are resolved by stylesheet order,
// not by class order, so overriding one with the other is unreliable).
const fieldBase =
  'rounded-lg border border-slate-300 bg-white text-sm shadow-sm ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100';
const inputCls = fieldBase + ' w-full px-3 py-2';
// The four margin boxes share one row, so they need tighter padding and must be allowed to shrink.
const marginInputCls = fieldBase + ' w-full min-w-0 px-2 py-1.5';

const PAPERS: { value: string; label: string }[] = [
  { value: '', label: 'Printer driver default (set this to 110 × 86 mm)' },
  ...['A2', 'A3', 'A4', 'A5', 'A6', 'letter', 'legal', 'tabloid', 'statement']
    .map(v => ({ value: v, label: v.length <= 2 ? v : v[0].toUpperCase() + v.slice(1) })),
];

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

function Field({ label, hint, htmlFor, children }: {
  label: string; hint?: string; htmlFor: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export default function PrintPage() {
  const caps = useCapabilities();
  const [printers, setPrinters] = useState<string[]>([]);
  const [printer, setPrinter] = useState('');
  const [paper, setPaper] = useState('');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [rotate, setRotate] = useState<Rotation>(0);
  const [margins, setMargins] = useState<Margins>(NO_MARGINS);
  const [dpi, setDpi] = useState('');
  const [resolutions, setResolutions] = useState<string[]>([]);
  const [dpiNote, setDpiNote] = useState('');
  const [pages, setPages] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ pages: number; printer: string; t: Timings; report: PrintReport; source: string } | null>(null);

  useEffect(() => {
    listPrinters()
      .then(p => { setPrinters(p); setPrinter(p[0] ?? ''); })
      .catch(e => setError(errMsg(e)));
  }, []);

  // Ask the driver which resolutions it supports whenever the printer changes.
  useEffect(() => {
    setDpi(''); setResolutions([]); setDpiNote('');
    if (!printer || !caps.dpiSelect) return;
    let stale = false;
    printerResolutions(printer)
      .then(r => { if (!stale) { setResolutions(r); if (r.length === 0) setDpiNote('This driver reports no selectable resolutions.'); } })
      .catch(e => { if (!stale) setDpiNote(`Could not read resolutions: ${errMsg(e)}`); });
    return () => { stale = true; };
  }, [printer, caps.dpiSelect]);

  const onPrint = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const { timings, report, templateSource } = await printLabels({ printer, paper, orientation, rotate, margins, dpi, pages });
      setResult({ pages, printer, t: timings, report, source: templateSource });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-full bg-slate-100 p-6">
      <div className="mx-auto max-w-md space-y-5 rounded-2xl bg-white p-6 shadow-lg ring-1 ring-slate-200">
        <header>
          <h1 className="text-xl font-semibold text-slate-900">Silent print test</h1>
          <p className="text-sm text-slate-500">
            {caps.silent
              ? 'Generate random 110 × 86 mm labels and print without a dialog.'
              : 'Generate random 110 × 86 mm labels and print them through the system print dialog.'}
          </p>
          {!caps.silent && caps.platform === 'android' && (
            <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
              Android cannot print silently through the system print service: pressing Print opens the
              print preview, where you pick the printer, paper and orientation and tap Print.
            </p>
          )}
        </header>

        <Field label="Printer" htmlFor="printer"
               hint={printers.length === 0 ? 'No printers found.' : `${printers.length} printer(s) detected`}>
          <select id="printer" className={inputCls + ' cursor-pointer disabled:cursor-not-allowed'} value={printer}
                  disabled={busy} onChange={e => setPrinter(e.target.value)}>
            {printers.map(p => <option key={p}>{p}</option>)}
          </select>
        </Field>

        {caps.paperSelect && (
        <Field label="Paper size" htmlFor="paper"
               hint="SumatraPDF can only set named sizes. A custom size such as 110 × 86 mm must be the printer driver's default paper.">
          <select id="paper" className={inputCls + ' cursor-pointer disabled:cursor-not-allowed'} value={paper}
                  disabled={busy} onChange={e => setPaper(e.target.value)}>
            {PAPERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
        )}

        {caps.orientationSelect && (
        <fieldset className="space-y-1" disabled={busy}>
          <legend className="text-sm font-medium text-slate-700">Orientation</legend>
          <div className="grid grid-cols-3 gap-2">
            {ORIENTATIONS.map(o => {
              const selected = orientation === o.value;
              return (
                <label key={o.value}
                       className={
                         'rounded-lg border px-3 py-2 text-center text-sm transition ' +
                         (busy ? 'cursor-not-allowed opacity-60 ' : 'cursor-pointer ') +
                         (selected
                           ? 'border-indigo-600 bg-indigo-50 font-medium text-indigo-700 ring-1 ring-indigo-600'
                           : 'border-slate-300 text-slate-700 hover:bg-slate-50')
                       }>
                  <input type="radio" name="orientation" value={o.value} checked={selected}
                         onChange={() => setOrientation(o.value)} className="sr-only" />
                  {o.label}
                </label>
              );
            })}
          </div>
          <p className="text-xs text-slate-500">
            The label itself is landscape (110 × 86 mm). Auto leaves the choice to the printer driver.
          </p>
        </fieldset>
        )}

        <fieldset className="space-y-1" disabled={busy}>
          <legend className="text-sm font-medium text-slate-700">Rotate label content</legend>
          <div className="grid grid-cols-4 gap-2">
            {ROTATIONS.map(r => {
              const selected = rotate === r;
              return (
                <label key={r}
                       className={
                         'rounded-lg border px-3 py-2 text-center text-sm transition ' +
                         (busy ? 'cursor-not-allowed opacity-60 ' : 'cursor-pointer ') +
                         (selected
                           ? 'border-indigo-600 bg-indigo-50 font-medium text-indigo-700 ring-1 ring-indigo-600'
                           : 'border-slate-300 text-slate-700 hover:bg-slate-50')
                       }>
                  <input type="radio" name="rotate" value={r} checked={selected}
                         onChange={() => setRotate(r)} className="sr-only" />
                  {r}°
                </label>
              );
            })}
          </div>
          <p className="text-xs text-slate-500">
            Rotates the label inside the PDF, so it works with any driver. On portrait stock (e.g. 86 × 110 mm)
            use 90° or 270° so the 110 × 86 mm label fills the paper at full size. If it prints upside-down, use the other one.
          </p>
        </fieldset>

        <fieldset className="space-y-1" disabled={busy}>
          <legend className="text-sm font-medium text-slate-700">Margins (mm)</legend>
          <div className="grid grid-cols-4 gap-2">
            {(['top', 'right', 'bottom', 'left'] as const).map(side => (
              <label key={side} className="flex flex-col gap-0.5 text-xs text-slate-500">
                <span className="capitalize">{side}</span>
                <input type="number" step={0.1} className={marginInputCls} value={margins[side]}
                       onChange={e => setMargins({ ...margins, [side]: Number.isFinite(+e.target.value) ? +e.target.value : 0 })} />
              </label>
            ))}
          </div>
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-slate-500">
              Positive adds white space (label prints smaller). Negative trims the label's edge so it fills more of the
              paper. Sides refer to the label before rotation. The printer's own non-printable area cannot be removed.
            </p>
            <button type="button" onClick={() => setMargins(NO_MARGINS)}
                    className="shrink-0 cursor-pointer text-xs text-indigo-600 hover:underline">Reset</button>
          </div>
        </fieldset>

        {caps.dpiSelect && (
        <Field label="Print resolution" htmlFor="dpi"
               hint={dpiNote || 'Options are what the printer driver reports. The previous setting is restored after printing.'}>
          <select id="dpi" className={inputCls + ' cursor-pointer disabled:cursor-not-allowed'} value={dpi}
                  disabled={busy} onChange={e => setDpi(e.target.value)}>
            <option value="">Printer default</option>
            {resolutions.map(r => <option key={r} value={r}>{dpiLabel(r)}</option>)}
          </select>
        </Field>
        )}

        <Field label="Number of pages" htmlFor="pages" hint="One label per page, each with different data.">
          <input id="pages" type="number" min={1} className={inputCls} value={pages} disabled={busy}
                 onChange={e => setPages(Math.max(1, Math.floor(+e.target.value) || 1))} />
        </Field>

        <button onClick={onPrint} disabled={!printer || busy}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300">
          {busy && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </svg>
          )}
          {busy ? (caps.silent ? 'Printing…' : 'Opening…') : (caps.silent ? 'Print' : 'Print…')}
        </button>

        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 break-words">
            {error}
          </div>
        )}

        {result && (
          <section className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm text-emerald-800">
              {caps.silent ? 'Sent' : 'Opened the print dialog for'} {result.pages} page(s) {caps.silent ? 'to' : 'via'} <span className="font-medium">{result.printer}</span>
              {' '}using the <span className="font-medium">{result.source}</span> template
            </p>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-600">Total time</span>
              <span className="text-2xl font-semibold text-slate-900">{fmt(result.t.total)}</span>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-center text-xs">
              {([['Data', result.t.data], ['PDF build', result.t.pdf], [caps.silent ? 'Send to printer' : 'Open dialog', result.t.print]] as const)
                .map(([k, v]) => (
                  <div key={k} className="rounded-md bg-white p-2 ring-1 ring-slate-200">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="mt-0.5 text-sm font-medium text-slate-900">{fmt(v)}</dd>
                  </div>
                ))}
            </dl>
            <p className="text-xs text-slate-500">
              {caps.silent
                ? '"Send to printer" ends when the print tool hands the job to the OS spooler, not when paper comes out.'
                : '"Open dialog" ends when the system print preview is requested, not when you tap Print or paper comes out.'}
            </p>

            <div className="space-y-1.5 border-t border-emerald-200 pt-3">
              <p className="text-xs text-slate-600">
                Transport: <span className="rounded-full bg-emerald-200 px-2 py-0.5 font-medium text-emerald-900">{result.report.transport}</span>
                {' '}<span className="text-slate-500">({result.report.tool})</span>
              </p>
              {caps.paperSelect ? (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">
                      Paper size <span className="font-medium text-slate-900">{result.report.paperRequested || '(driver default)'}</span>
                    </span>
                    <span className={
                      'rounded-full px-2 py-0.5 text-xs font-medium ' +
                      (result.report.paperApplied ? 'bg-emerald-200 text-emerald-900' : 'bg-slate-200 text-slate-800')
                    }>
                      {result.report.paperApplied ? `sent to ${result.report.tool}` : 'driver default'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 break-words">{result.report.paperNote}</p>
                </>
              ) : (
                <p className="text-xs text-slate-600 break-words">{result.report.paperNote}</p>
              )}
              {caps.orientationSelect && (
                <p className="text-xs text-slate-600">Orientation: <span className="font-medium">{result.report.orientation}</span></p>
              )}
              {caps.dpiSelect && (
                <p className="text-xs text-slate-600">
                  Resolution: <span className="font-medium">{result.report.dpiRequested ? dpiLabel(result.report.dpiRequested) : 'printer default'}</span>
                  {' — '}{result.report.dpiNote}
                </p>
              )}
              <pre className="overflow-x-auto rounded-md bg-slate-900 p-2 text-xs text-slate-100">{result.report.command}</pre>
            </div>
          </section>
        )}

        <details className="border-t border-slate-200 pt-3 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">Template: export / import</summary>
          <p className="mb-2 mt-2 text-xs text-slate-500">
            The saved label template lives on each device. Export it from one and import it on another
            (for example from desktop to Android) so both print the same layout.
          </p>
          <TemplateTransfer />
        </details>
      </div>
    </main>
  );
}
