import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Designer } from '@pdfme/ui';
import { text, rectangle, barcodes } from '@pdfme/schemas';
import type { Template } from '@pdfme/common';
import { loadFont } from './printApi';
import TemplateTransfer from './TemplateTransfer';
import { LABELS, getLabel, loadLastLabel, type LabelId } from './labels';
import { defaultLabelTemplate, getTemplate, resetTemplate, saveTemplate, type TemplateSource } from './templateStore';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readSize(t: Template): { w: number; h: number } | null {
  const b = t.basePdf as unknown;
  if (b && typeof b === 'object' && 'width' in b && 'height' in b) {
    const { width, height } = b as { width: number; height: number };
    return { w: width, h: height };
  }
  return null;
}

const numCls =
  'w-20 rounded-xl border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';
const btnCls =
  'cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';

export default function DesignerPage() {
  const container = useRef<HTMLDivElement>(null);
  const designer = useRef<Designer | null>(null);
  const savedSnapshot = useRef('');
  // Which label's template the designer is showing. The ref mirrors the state so the async
  // handlers below always read the current one.
  const [labelId, setLabelId] = useState<LabelId>(loadLastLabel);
  const labelRef = useRef<LabelId>(labelId);
  const [pendingLabel, setPendingLabel] = useState<LabelId | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [source, setSource] = useState<TemplateSource>('default');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let d: Designer | undefined;
    (async () => {
      try {
        const [{ template, source }, font, rows] = await Promise.all([
          getTemplate(labelRef.current),
          loadFont(),
          invoke<Record<string, string>[]>('generate_random_data', { count: 1, label: labelRef.current }),
        ]);
        if (cancelled || !container.current) return;
        d = new Designer({
          domContainer: container.current,
          template,
          plugins: { text, rectangle, ...barcodes },
          options: { font: { NotoSansJP: { data: font, fallback: true } }, lang: 'en' },
        });
        savedSnapshot.current = JSON.stringify(template);
        d.onChangeTemplate(() => {
          setDirty(JSON.stringify(d!.getTemplate()) !== savedSnapshot.current);
        });
        designer.current = d;
        setSize(readSize(template));
        setSource(source);
        setKeys(Object.keys(rows[0] ?? {}));
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
      d?.destroy();
      designer.current = null;
    };
  }, []);

  const applySize = () => {
    const d = designer.current;
    if (!d || !size) return;
    const t = d.getTemplate();
    const old = t.basePdf as unknown as { padding?: [number, number, number, number] };
    d.updateTemplate({ ...t, basePdf: { width: size.w, height: size.h, padding: old.padding ?? [0, 0, 0, 0] } });
    setDirty(true);
    setMessage(`Page size set to ${size.w} × ${size.h} mm (not saved yet).`);
  };

  const onSave = async () => {
    const d = designer.current;
    if (!d) return;
    setError(''); setMessage('');
    try {
      const t = d.getTemplate();
      const path = await saveTemplate(labelRef.current, t);
      savedSnapshot.current = JSON.stringify(t);
      setDirty(false);
      setSource('custom');
      setMessage(`Saved. Printing now uses this template. (${path})`);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onReset = async () => {
    const d = designer.current;
    if (!d) return;
    setConfirmReset(false); setError(''); setMessage('');
    try {
      await resetTemplate(labelRef.current);
      const t = defaultLabelTemplate(labelRef.current);
      d.updateTemplate(t);
      savedSnapshot.current = JSON.stringify(d.getTemplate());
      setDirty(false);
      setSource('default');
      setSize(readSize(t));
      setMessage('Reset to the built-in default template.');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // Shows another label's template in the same designer instance.
  const switchLabel = async (id: LabelId) => {
    const d = designer.current;
    if (!d) return;
    setPendingLabel(null); setConfirmReset(false); setError(''); setMessage('');
    try {
      const [{ template, source }, rows] = await Promise.all([
        getTemplate(id),
        invoke<Record<string, string>[]>('generate_random_data', { count: 1, label: id }),
      ]);
      d.updateTemplate(template);
      savedSnapshot.current = JSON.stringify(d.getTemplate());
      labelRef.current = id;
      setLabelId(id);
      setDirty(false);
      setSource(source);
      setSize(readSize(template));
      setKeys(Object.keys(rows[0] ?? {}));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onPickLabel = (id: LabelId) => {
    if (id === labelId) return;
    if (dirty) setPendingLabel(id); // ask before throwing away unsaved edits
    else switchLabel(id);
  };

  // A template imported through the transfer panel is already saved; show it in the designer.
  const onImported = (t: Template) => {
    const d = designer.current;
    if (!d) return;
    d.updateTemplate(t);
    savedSnapshot.current = JSON.stringify(d.getTemplate());
    setDirty(false);
    setSource('custom');
    setSize(readSize(t));
    setError('');
    setMessage('Imported template saved. Printing now uses it.');
  };

  return (
    <div className="flex h-full flex-col bg-white/90">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2">
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <label htmlFor="designer-label" className="font-medium">Label</label>
          <select id="designer-label" value={labelId} disabled={!ready}
            onChange={e => onPickLabel(e.target.value as LabelId)}
            className="cursor-pointer rounded-xl border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-100">
            {LABELS.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        {size && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="font-medium">Page size</span>
            <input aria-label="Width in mm" type="number" min={10} className={numCls} value={size.w} disabled={!ready}
              onChange={e => setSize({ ...size, w: +e.target.value })} />
            <span>×</span>
            <input aria-label="Height in mm" type="number" min={10} className={numCls} value={size.h} disabled={!ready}
              onChange={e => setSize({ ...size, h: +e.target.value })} />
            <span className="text-slate-500">mm</span>
            <button onClick={applySize} disabled={!ready || size.w < 10 || size.h < 10}
              className={btnCls + ' border border-slate-300 text-slate-700 hover:bg-slate-50'}>Apply</button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-500">
            Template in use: <span className="font-medium text-slate-700">{source}</span>
            {dirty && <span className="ml-2 animate-pulse rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">✏️ unsaved changes</span>}
          </span>
          {confirmReset ? (
            <>
              <span className="text-sm text-slate-700">Discard your template?</span>
              <button onClick={onReset} className={btnCls + ' bg-red-600 text-white hover:bg-red-500'}>Yes, reset</button>
              <button onClick={() => setConfirmReset(false)}
                className={btnCls + ' border border-slate-300 text-slate-700 hover:bg-slate-50'}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmReset(true)} disabled={!ready}
              className={btnCls + ' border border-slate-300 text-slate-700 hover:bg-slate-50'}>Reset to default</button>
          )}
          <button onClick={onSave} disabled={!ready || !dirty}
            className={btnCls + ' bg-indigo-600 text-white hover:bg-indigo-500'}>Save template</button>
        </div>
      </div>

      {pendingLabel && (
        <div className="tab-enter flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <span>Discard unsaved changes to “{getLabel(labelId).name}” and open “{getLabel(pendingLabel).name}”?</span>
          <button onClick={() => switchLabel(pendingLabel)} className={btnCls + ' bg-red-600 text-white hover:bg-red-500'}>Discard and switch</button>
          <button onClick={() => setPendingLabel(null)}
            className={btnCls + ' border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}>Cancel</button>
        </div>
      )}

      {(error || message) && (
        <div key={error || message} className={(error ? 'alert-shake ' : 'tab-enter ') + 'border-b px-4 py-2 text-sm break-words ' +
          (error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
          {error || message}
        </div>
      )}

      <details className="border-b border-slate-200 px-4 py-2 text-sm">
        <summary className="cursor-pointer text-slate-700">Export / import template (move it between devices)</summary>
        <div className="mt-2"><TemplateTransfer key={labelId} label={labelId} onImported={onImported} /></div>
      </details>

      {keys.length > 0 && (
        <details className="border-b border-slate-200 px-4 py-2 text-sm">
          <summary className="cursor-pointer text-slate-700">
            Fields filled with random data when printing ({keys.length})
          </summary>
          <p className="mt-2 text-xs text-slate-500">
            Name a field exactly like one of these to get random data on each page. Any other field prints
            its own text as designed.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {keys.map(k => (
              <code key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800">{k}</code>
            ))}
          </div>
        </details>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={container} className="absolute inset-0" />
        {!ready && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-slate-500">
            <span className="text-4xl" style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }} aria-hidden="true">🎨</span>
            Loading designer…
          </div>
        )}
      </div>
    </div>
  );
}
