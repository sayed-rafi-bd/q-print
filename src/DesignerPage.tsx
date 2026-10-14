import { useCallback, useEffect, useRef, useState } from 'react';
import { Designer } from '@pdfme/ui';
import { text, rectangle, barcodes } from '@pdfme/schemas';
import type { Template } from '@pdfme/common';
import { loadFont } from './printApi';
import TemplateTransfer from './TemplateTransfer';
import LabelToolbar from './designer/LabelToolbar';
import DataEditor from './designer/DataEditor';
import PreviewDialog from './designer/PreviewDialog';
import {
  listLabels, loadLastLabel, rememberLabel, resolveLabel,
  type BrokenLabelFile, type LabelId, type LabelMeta,
} from './labels';
import {
  loadLabel, defaultLabelTemplate, resetBuiltinTemplate, saveBuiltinTemplate, saveBundle,
  type TemplateSource,
} from './templateStore';
import { scaffoldSpec } from './generator/scaffold';
import { validateSpec } from './generator/engine';
import type { GeneratorSpec } from './generator/spec';

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
  const savedSnapshot = useRef<string>('');
  // The label whose layout is on screen. The ref mirrors the state so the async handlers below
  // always read the current one.
  const [labelId, setLabelId] = useState<LabelId>('');
  const labelRef = useRef<LabelId>('');
  const [pendingLabel, setPendingLabel] = useState<LabelId | null>(null);

  const [labels, setLabels] = useState<LabelMeta[]>([]);
  const [broken, setBroken] = useState<BrokenLabelFile[]>([]);
  const [meta, setMeta] = useState<LabelMeta | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState<TemplateSource>('default');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [generator, setGenerator] = useState<GeneratorSpec>({ version: 1, fields: {} });
  const [generatorSaved, setGeneratorSaved] = useState<GeneratorSpec>({ version: 1, fields: {} });
  const [tab, setTab] = useState<'layout' | 'data'>('layout');
  const [previewing, setPreviewing] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  /** True when the layout, the page size or the generator has something unsaved. */
  const generatorDirty = JSON.stringify(generator) !== JSON.stringify(generatorSaved);
  const dirty = layoutDirty || generatorDirty;

  /** Puts a label's template and generator into the designer. */
  const openLabel = useCallback(async (target: LabelMeta) => {
    const d = designer.current;
    if (!d) return;
    const { template, source: from, generator: gen } = await loadLabel(target.id);
    d.updateTemplate(template);
    savedSnapshot.current = JSON.stringify(d.getTemplate());
    labelRef.current = target.id;
    setLabelId(target.id);
    setMeta(target);
    setLayoutDirty(false);
    setSource(from);
    setSize(readSize(template));
    setGenerator(gen);
    setGeneratorSaved(gen);
    setError('');
    setConfirmReset(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let d: Designer | undefined;
    (async () => {
      try {
        const font = await loadFont();
        if (cancelled || !container.current) return;
        d = new Designer({
          domContainer: container.current,
          // A placeholder so the designer has something to show before the registry has been read;
          // openLabel replaces it as soon as the real label is loaded.
          template: defaultLabelTemplate('shipping'),
          plugins: { text, rectangle, ...barcodes },
          options: { font: { NotoSansJP: { data: font, fallback: true } }, lang: 'en' },
        });
        designer.current = d;
        d.onChangeTemplate(() => {
          setLayoutDirty(JSON.stringify(d!.getTemplate()) !== savedSnapshot.current);
        });
        const registry = await listLabels();
        if (cancelled) return;
        setLabels(registry.labels);
        setBroken(registry.broken);
        // The label remembered last time, unless it has since been deleted.
        const wanted = loadLastLabel() ?? '';
        const target = registry.labels.find(l => l.id === wanted) ?? await resolveLabel(wanted);
        if (!target) {
          setError('No labels were found.');
          return;
        }
        const { template, source: from, generator: gen } = await loadLabel(target.id);
        if (cancelled) return;
        d.updateTemplate(template);
        savedSnapshot.current = JSON.stringify(d.getTemplate());
        labelRef.current = target.id;
        setLabelId(target.id);
        setMeta(target);
        setSource(from);
        setSize(readSize(template));
        setGenerator(gen);
        rememberLabel(target.id);
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
    setLayoutDirty(true);
    setMessage(`Page size set to ${size.w} × ${size.h} mm (not saved yet).`);
  };

  /** Saves layout and data together, which is what keeps them from drifting apart. */
  const onSave = async () => {
    const d = designer.current;
    if (!d || !meta) return;
    setError(''); setMessage('');
    try {
      const template = d.getTemplate();
      // A field added in the Layout but never given a rule gets a sensible default, so printing
      // fills it rather than showing the designer's placeholder text.
      const next = scaffoldSpec(template, generator);
      const problems = validateSpec(next);
      if (problems.length > 0) throw new Error(problems[0]);

      const path = meta.builtin
        ? await saveBuiltinTemplate(meta.id, template)
        : await saveBundle(meta.id, meta.name, template, next);
      savedSnapshot.current = JSON.stringify(template);
      setGenerator(next);
      setGeneratorSaved(next);
      setLayoutDirty(false);
      setSource(meta.builtin ? 'custom' : 'custom label');
      setMeta({ ...meta, widthMm: size?.w ?? meta.widthMm, heightMm: size?.h ?? meta.heightMm });
      setMessage(`Saved. Printing now uses this template. (${path})`);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onReset = async () => {
    const d = designer.current;
    if (!d || !meta) return;
    setConfirmReset(false); setError(''); setMessage('');
    try {
      if (!meta.builtin) throw new Error('A label of your own has no default to go back to.');
      await resetBuiltinTemplate(meta.id);
      const { template, generator: gen } = await loadLabel(meta.id);
      d.updateTemplate(template);
      savedSnapshot.current = JSON.stringify(d.getTemplate());
      setLayoutDirty(false);
      setSource('default');
      setSize(readSize(template));
      setGenerator(gen);
      setGeneratorSaved(gen);
      setMessage('Reset to the built-in default template.');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /** Shows another label in the same designer instance. */
  const switchLabel = async (id: string) => {
    setPendingLabel(null); setError(''); setMessage('');
    try {
      const target = labels.find(l => l.id === id);
      if (!target) throw new Error(`There is no label called “${id}”.`);
      await openLabel(target);
      rememberLabel(target.id);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onPickLabel = (id: string) => {
    if (id === labelId) return;
    if (dirty) setPendingLabel(id); // ask before throwing away unsaved edits
    else switchLabel(id);
  };

  /** After a create, rename or delete in the toolbar. */
  const onLabelsChanged = async (select?: string) => {
    setError(''); setMessage('');
    try {
      const registry = await listLabels();
      setLabels(registry.labels);
      setBroken(registry.broken);
      const target = select
        ? registry.labels.find(l => l.id === select)
        : registry.labels.find(l => l.id === labelRef.current) ?? registry.labels[0];
      if (target) {
        await openLabel(target);
        rememberLabel(target.id);
      } else {
        setError('No labels were found.');
      }
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // A template imported through the transfer panel is already saved; show it in the designer.
  const onImported = (t: Template) => {
    const d = designer.current;
    if (!d) return;
    d.updateTemplate(t);
    savedSnapshot.current = JSON.stringify(d.getTemplate());
    setLayoutDirty(false);
    setSource(meta?.builtin ? 'custom' : 'custom label');
    setSize(readSize(t));
    setGenerator(g => { const next = scaffoldSpec(t, g); setGeneratorSaved(next); return next; });
    setError('');
    setMessage('Imported template saved. Printing now uses it.');
  };

  /** The layout as the designer holds it right now, for the Data tab and the preview. */
  const currentTemplate = designer.current?.getTemplate() ?? defaultLabelTemplate(labelId || 'shipping');
  const generatorProblems = validateSpec(generator);

  return (
    <div className="relative flex h-full flex-col bg-white/90">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2">
        <LabelToolbar labels={labels} broken={broken} value={labelId} disabled={!ready}
          onPick={onPickLabel} onChanged={onLabelsChanged} onError={setError} />

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
            {generatorDirty && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">✏️ data not saved</span>}
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
            <button onClick={() => setConfirmReset(true)} disabled={!ready || !meta?.builtin}
              title={meta?.builtin ? undefined : 'A label of your own has no default to go back to'}
              className={btnCls + ' border border-slate-300 text-slate-700 hover:bg-slate-50'}>Reset to default</button>
          )}
          <button onClick={onSave} disabled={!ready || !dirty || generatorProblems.length > 0}
            title={generatorProblems.length > 0 ? 'Fix the data generator first' : undefined}
            className={btnCls + ' bg-indigo-600 text-white hover:bg-indigo-500'}>Save</button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-slate-200 px-4 py-1.5">
        <button onClick={() => setTab('layout')}
          className={'cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition '
            + (tab === 'layout' ? 'bg-indigo-500 text-white' : 'text-slate-500 hover:bg-indigo-100')}>
          Layout
        </button>
        <button onClick={() => setTab('data')}
          className={'cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition '
            + (tab === 'data' ? 'bg-indigo-500 text-white' : 'text-slate-500 hover:bg-indigo-100')}>
          Data{generatorDirty ? ' •' : ''}
        </button>
        <span className="ml-2 text-xs text-slate-400">
          {tab === 'layout' ? 'Where things sit on the page.' : 'What each field prints on every page.'}
        </span>
      </div>

      {pendingLabel && (
        <div className="tab-enter flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <span>Discard unsaved changes to “{meta?.name}” and open “{labels.find(l => l.id === pendingLabel)?.name}”?</span>
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
        <summary className="cursor-pointer text-slate-700">Export / import label (move it between devices)</summary>
        <div className="mt-2"><TemplateTransfer key={labelId} label={labelId} onImported={onImported} /></div>
      </details>

      {tab === 'data' ? (
        <div className="min-h-0 flex-1">
          <DataEditor template={currentTemplate} spec={generator}
            onChange={setGenerator} onPreview={() => setPreviewing(true)} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div ref={container} className="absolute inset-0" />
          {!ready && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-slate-500">
              <span className="text-4xl" style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }} aria-hidden="true">🎨</span>
              Loading designer…
            </div>
          )}
        </div>
      )}

      {previewing && (
        <PreviewDialog template={currentTemplate} spec={generator} onClose={() => setPreviewing(false)} />
      )}
    </div>
  );
}
