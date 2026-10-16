import type { Template } from '@pdfme/common';
import { barcodes, rectangle, text } from '@pdfme/schemas';
import { Designer } from '@pdfme/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import { DEFAULT_LABEL } from './builtinLabels';
import { templateSizeMm } from './bundle';
import { importLegacyLabels, shouldOfferImport } from './db/migrate';
import DataEditor from './designer/DataEditor';
import { fitZoom, MAX_ZOOM_PERCENT, pxPerMm, worthChanging } from './designer/fitToScreen';
import LabelToolbar from './designer/LabelToolbar';
import PreviewDialog from './designer/PreviewDialog';
import { tabListKeyDown } from './designer/tabKeys';
import { validateSpec } from './generator/engine';
import type { PreviewValues } from './generator/previewInputs';
import { scaffoldSpec } from './generator/scaffold';
import type { GeneratorSpec } from './generator/spec';
import {
  type LabelId,
  type LabelMeta,
  listLabels,
  loadLabel,
  loadLastLabel,
  loadPreview,
  rememberLabel,
  resolveLabel,
  saveLabel,
  savePreview,
} from './labels';
import { isTauri } from './platform';
import { loadFont } from './printApi';
import TemplateTransfer from './TemplateTransfer';
import { defaultLabelTemplate, resetBuiltinTemplate } from './templateStore';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readSize(t: Template): { w: number; h: number } | null {
  const b = t.basePdf as unknown;
  if (b && typeof b === 'object' && 'width' in b && 'height' in b) {
    const { width, height } = b as { width: number; height: number };
    return { w: width, h: height };
  }
  return null;
}

// The recurring shapes live in index.css under @layer components, so a button looks the same
// everywhere. This one is here only to keep the JSX short.
const btnCls = 'btn btn-secondary';

/** The zoom until one has been measured, and for a template with no page size. */
const DEFAULT_ZOOM = 1;

/** The two tabs, each with the one-line description shown beside them. */
const TABS = [
  ['layout', 'Layout', 'Where things sit on the page.'],
  ['data', 'Data', 'What each field prints on every page.'],
] as const;
const TAB_IDS = TABS.map((t) => t[0]);

export default function DesignerPage() {
  const { user } = useAuth();
  const container = useRef<HTMLDivElement>(null);
  const designer = useRef<Designer | null>(null);
  const savedSnapshot = useRef<string>('');
  // The zoom the designer was built with, and how wide a millimetre comes out on screen. The zoom is
  // fixed at construction — see `zoomFor` — so these two decide when it has to be rebuilt.
  const zoomRef = useRef(DEFAULT_ZOOM);
  const canvasScale = useRef(0);
  /** Set on unmount, so work that is still loading does not draw into a page that has gone. */
  const gone = useRef(false);
  // The label whose layout is on screen. The ref mirrors the state so the async handlers below
  // always read the current one.
  const [labelId, setLabelId] = useState<LabelId>('');
  const labelRef = useRef<LabelId>('');
  const [pendingLabel, setPendingLabel] = useState<LabelId | null>(null);

  const [labels, setLabels] = useState<LabelMeta[]>([]);
  const [meta, setMeta] = useState<LabelMeta | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [generator, setGenerator] = useState<GeneratorSpec>({ version: 1, fields: {} });
  const [generatorSaved, setGeneratorSaved] = useState<GeneratorSpec>({ version: 1, fields: {} });
  const [tab, setTab] = useState<'layout' | 'source' | 'data'>('layout');
  const [previewing, setPreviewing] = useState(false);
  // Records fetched in the Source pane to map fields and preview. Memory only, never saved, and
  // dropped whenever another label is opened.
  const [sample, setSample] = useState<unknown[] | null>(null);
  // Placeholder values the person typed to see the label previewed. Kept in the database, so they
  // are the same next time they open this label. Design-time only: printing never reads them.
  const [previewValues, setPreviewValues] = useState<PreviewValues>({});
  const [previewSaved, setPreviewSaved] = useState<PreviewValues>({});
  const [confirmReset, setConfirmReset] = useState(false);
  // A one-off offer to copy label files from an earlier version onto this account.
  const [offerImport, setOfferImport] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a sample belongs to one label, so it is dropped whenever the open label changes
  useEffect(() => {
    setSample(null);
  }, [labelId]);

  /** True when the layout, the page size, the generator or the preview values have something unsaved. */
  const generatorDirty = JSON.stringify(generator) !== JSON.stringify(generatorSaved);
  const previewDirty = JSON.stringify(previewValues) !== JSON.stringify(previewSaved);
  const dirty = layoutDirty || generatorDirty || previewDirty;

  /**
   * How wide one millimetre of label comes out on screen, measured once from the real page.
   *
   * Nothing here is assumed. It moves with the font, the pdfme version and the device pixel ratio, so
   * it is read off a page that has actually rendered and then reused for every zoom calculation.
   */
  const measureScale = useCallback((template: Template) => {
    const canvas = container.current?.querySelector('.pdfme-designer-canvas') as HTMLElement | null;
    const wrapper = Array.from(canvas?.children ?? []).find((c) => /scale\(/.test(c.getAttribute('style') ?? ''));
    const page = wrapper?.firstElementChild as HTMLElement | null;
    if (!page) return;
    const mm = templateSizeMm(template);
    if (!mm) return;
    const scale = new DOMMatrix(getComputedStyle(wrapper as HTMLElement).transform).a;
    const width = page.getBoundingClientRect().width;
    canvasScale.current = pxPerMm(width, mm.widthMm) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  }, []);

  /**
   * Tears the designer down exactly once, whoever asks.
   *
   * pdfme throws if `destroy` is called on an instance that was already destroyed, and a rebuild
   * followed by an unmount would do exactly that — the local `d` in the effect is the instance the
   * rebuild replaced. Clearing the ref is what makes it idempotent.
   */
  const destroyDesigner = useCallback(() => {
    const d = designer.current;
    designer.current = null;
    if (!d) return;
    try {
      d.destroy();
    } catch {
      // Already gone: unmounting after a rebuild is the normal case, not an error.
    }
  }, []);

  /** The zoom this label should be drawn at, or `zoomRef.current` when it cannot be worked out. */
  const zoomFor = useCallback((template: Template): number => {
    const root = container.current;
    const mm = templateSizeMm(template);
    if (!root || !mm || canvasScale.current <= 0) return zoomRef.current;
    const room = root.getBoundingClientRect();
    if (room.width <= 0 || room.height <= 0) return zoomRef.current;
    return fitZoom({ pageMm: mm, availablePx: room, pxPerMm: canvasScale.current });
  }, []);

  /**
   * Rebuilds the designer at a different zoom.
   *
   * Necessary because pdfme takes `zoomLevel` only when it is constructed — see `zoomFor`. Called
   * when a label needs a different one, which is rare, so the cost of a fresh mount is worth it. The
   * layout is put back straight away, so nothing on screen appears to change but the size.
   */
  const rebuildAtZoom = useCallback(
    async (template: Template) => {
      const root = container.current;
      if (!root) return;
      const next = zoomFor(template);
      if (!worthChanging(zoomRef.current, next)) return;
      destroyDesigner();
      zoomRef.current = next;
      const font = await loadFont();
      // The page may have moved on while the font was loading — signing out, or another label. Drawing
      // into a container that is no longer on screen is how an already-destroyed instance gets used.
      if (gone.current || !container.current) return;
      const d = new Designer({
        domContainer: root,
        template,
        plugins: { text, rectangle, ...barcodes },
        options: {
          font: { NotoSansJP: { data: font, fallback: true } },
          lang: 'en',
          zoomLevel: zoomRef.current,
          maxZoom: MAX_ZOOM_PERCENT,
        },
      });
      designer.current = d;
      d.onChangeTemplate(() => {
        setLayoutDirty(JSON.stringify(d!.getTemplate()) !== savedSnapshot.current);
      });
      savedSnapshot.current = JSON.stringify(template);
      setLayoutDirty(false);
    },
    [zoomFor, destroyDesigner],
  );

  /** Puts a label's template and generator into the designer. */
  const openLabel = useCallback(
    async (target: LabelMeta) => {
      const d = designer.current;
      if (!d || !user) return;
      const { template, generator: gen } = await loadLabel(user, target.id);
      d.updateTemplate(template);
      savedSnapshot.current = JSON.stringify(d.getTemplate());
      labelRef.current = target.id;
      setLabelId(target.id);
      setMeta(target);
      setLayoutDirty(false);
      // A different page size usually wants a different zoom, and the zoom can only be set when the
      // designer is built.
      await rebuildAtZoom(template);
      setSize(readSize(template));
      setGenerator(gen);
      setGeneratorSaved(gen);
      // A built-in has no row in `labels`, but it can still have preview values of its own here.
      const values = await loadPreview(user, target.id);
      setPreviewValues(values);
      setPreviewSaved(values);
      setError('');
      setConfirmReset(false);
    },
    [user, rebuildAtZoom],
  );

  /**
   * Show the whole label in the space the canvas has.
   *
   * pdfme scales a page down to fit its canvas but never up, so a 100 × 50 mm label sits as a small
   * rectangle in a large dark area on a desktop screen. Measure what is actually on screen and set
   * the zoom from that.
   *
   * It has to be driven by a ResizeObserver rather than an animation frame or a window listener: the
   * canvas is 0 px tall while the page is coming up and again when the tab changes, and measuring
   * then fits the page to a sliver and leaves it there.
   */
  useEffect(() => {
    let cancelled = false;
    if (!user) return;
    let d: Designer | undefined;
    (async () => {
      try {
        const font = await loadFont();
        if (cancelled || !container.current) return;
        d = new Designer({
          domContainer: container.current,
          // A placeholder so the designer has something to show before the registry has been read;
          // openLabel replaces it as soon as the real label is loaded.
          template: defaultLabelTemplate(DEFAULT_LABEL),
          plugins: { text, rectangle, ...barcodes },
          options: {
            font: { NotoSansJP: { data: font, fallback: true } },
            lang: 'en',
            // A percentage, not a multiplier: pdfme divides it by 100. Past 2× the detail stops
            // being readable on a phone, so the fit never asks for more.
            maxZoom: MAX_ZOOM_PERCENT,
          },
        });
        designer.current = d;
        d.onChangeTemplate(() => {
          setLayoutDirty(JSON.stringify(d!.getTemplate()) !== savedSnapshot.current);
          // The page may have changed size, so re-fit. Idempotent, so it costs nothing when it
          // has not.
        });
        const registry = await listLabels(user);
        if (cancelled) return;
        setLabels(registry);
        // The label remembered last time, unless it has since been deleted.
        const wanted = loadLastLabel(user) ?? '';
        const target = registry.find((l) => l.id === wanted) ?? (await resolveLabel(user, wanted));
        if (!target) {
          setError('No labels were found.');
          return;
        }
        // If the remembered label cannot be opened, fall back to a built-in one instead of leaving
        // the designer stuck on "Loading": otherwise a single bad label locks the user out of
        // every other label, including the one they would need to delete it.
        const attempt = async (meta: LabelMeta) => {
          const { template, generator: gen } = await loadLabel(user, meta.id);
          if (cancelled) return false;
          d!.updateTemplate(template);
          savedSnapshot.current = JSON.stringify(d!.getTemplate());
          labelRef.current = meta.id;
          setLabelId(meta.id);
          setMeta(meta);
          setSize(readSize(template));
          setGenerator(gen);
          // What was just loaded is, by definition, what is saved. Without these two the page
          // started out claiming "unsaved changes" and "data not saved" on an untouched label.
          setGeneratorSaved(gen);
          setLayoutDirty(false);
          // Placeholders belong to the label, so they load here too. A built-in has no row in
          // `labels` but can still have its own.
          const values = await loadPreview(user, meta.id);
          if (cancelled) return false;
          setPreviewValues(values);
          setPreviewSaved(values);
          measureScale(template);
          rememberLabel(user, meta.id);
          return true;
        };
        try {
          if (!(await attempt(target))) return;
        } catch (e) {
          const fallback = registry.find((l) => l.builtin);
          if (!fallback || fallback.id === target.id) throw e;
          setError(`Could not open “${target.name}”: ${errMsg(e)}`);
          if (!(await attempt(fallback))) return;
        }
        setReady(true);
        await rebuildAtZoom(d!.getTemplate());
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    gone.current = false;
    return () => {
      cancelled = true;
      gone.current = true;
      // Destroy whichever instance is live now, not the one this closure created: rebuilding swaps
      // it, and pdfme refuses to destroy an instance that has already been destroyed. Signing out
      // hits this, because the rebuild is still in flight while the page is unmounting.
      destroyDesigner();
    };
  }, [user, measureScale, rebuildAtZoom, destroyDesigner]);

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
    if (!d || !meta || !user) return;
    setError('');
    setMessage('');
    try {
      const template = d.getTemplate();
      // A field added in the Layout but never given a rule gets a sensible default, so printing
      // fills it rather than showing the designer's placeholder text. A built-in's generator lives
      // in the app, so this only applies to a label the user owns.
      const next = meta.builtin ? generator : scaffoldSpec(template, generator);
      const problems = validateSpec(next);
      if (problems.length > 0) throw new Error(problems[0]);

      await saveLabel(user, meta.id, meta.name, template, next);
      await savePreview(user, meta.id, previewValues);
      savedSnapshot.current = JSON.stringify(template);
      setGenerator(next);
      setGeneratorSaved(next);
      setPreviewSaved(previewValues);
      setLayoutDirty(false);
      setMeta({ ...meta, widthMm: size?.w ?? meta.widthMm, heightMm: size?.h ?? meta.heightMm });
      setMessage(
        meta.builtin
          ? isTauri()
            ? 'Saved. Printing now uses this template.'
            : 'Saved in this browser. Printing on a device uses its own copy.'
          : 'Saved. This label is on your account.',
      );
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onReset = async () => {
    const d = designer.current;
    if (!d || !meta || !user) return;
    setConfirmReset(false);
    setError('');
    setMessage('');
    try {
      if (!meta.builtin) throw new Error('A label of your own has no default to go back to.');
      await resetBuiltinTemplate(meta.id);
      const { template, generator: gen } = await loadLabel(user, meta.id);
      d.updateTemplate(template);
      savedSnapshot.current = JSON.stringify(d.getTemplate());
      setLayoutDirty(false);
      setSize(readSize(template));
      setGenerator(gen);
      setGeneratorSaved(gen);
      setMessage('Reset to the built-in default template.');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /** Offer the import once the Designer is up, since this is where labels are managed. */
  useEffect(() => {
    if (!ready || !user) return;
    let cancelled = false;
    shouldOfferImport(user)
      .then((offer) => {
        if (!cancelled) setOfferImport(offer);
      })
      .catch(() => {
        /* not worth a message */
      });
    return () => {
      cancelled = true;
    };
  }, [ready, user]);

  const runImport = async () => {
    if (!user) return;
    setOfferImport(false);
    setError('');
    setMessage('');
    try {
      const result = await importLegacyLabels(user);
      await onLabelsChanged();
      setMessage(
        `Copied ${result.imported} label${result.imported === 1 ? '' : 's'} onto this account.` +
          (result.skipped.length > 0 ? ` ${result.skipped.length} could not be read and were left alone.` : ''),
      );
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /** Shows another label in the same designer instance. */
  const switchLabel = async (id: string) => {
    setPendingLabel(null);
    setError('');
    setMessage('');
    if (!user) return;
    const target = labels.find((l) => l.id === id);
    if (!target) {
      setError(`There is no label called “${id}”.`);
      return;
    }
    // The picker follows the selection even if the label turns out not to open. Otherwise a broken
    // label could be seen in the list but never selected, and so never renamed or deleted —
    // `meta` still points at whatever the canvas is really showing, so Save and Reset stay honest.
    setLabelId(target.id);
    try {
      await openLabel(target);
      rememberLabel(user, target.id);
    } catch (e) {
      setError(`Could not open “${target.name}”: ${errMsg(e)}`);
    }
  };

  const onPickLabel = (id: string) => {
    if (id === labelId) return;
    if (dirty)
      setPendingLabel(id); // ask before throwing away unsaved edits
    else switchLabel(id);
  };

  /** After a create, rename or delete in the toolbar. */
  const onLabelsChanged = async (select?: string) => {
    setError('');
    setMessage('');
    if (!user) return;
    try {
      const registry = await listLabels(user);
      setLabels(registry);
      const target = select
        ? registry.find((l) => l.id === select)
        : (registry.find((l) => l.id === labelRef.current) ?? registry[0]);
      if (target) {
        await openLabel(target);
        rememberLabel(user, target.id);
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
    setSize(readSize(t));
    setGenerator((g) => {
      const next = meta?.builtin ? g : scaffoldSpec(t, g);
      setGeneratorSaved(next);
      return next;
    });
    setError('');
    setMessage('Imported template saved. Printing now uses it.');
  };

  /** The layout as the designer holds it right now, for the Data tab and the preview. */
  const currentTemplate = designer.current?.getTemplate() ?? defaultLabelTemplate(labelId || DEFAULT_LABEL);
  const generatorProblems = validateSpec(generator);

  return (
    // `min-h-full`, not `h-full`: on a short screen the page grows past the window and the Designer
    // section scrolls, instead of the canvas being squeezed until it is unusable. The canvas keeps a
    // floor of its own below.
    <div className="relative flex min-h-full flex-col bg-white/90">
      {/* One row for the label picker and the actions on the page as a whole. It wraps, so on a phone
          the actions drop under the picker, still right-aligned, rather than overflowing. The New and
          Rename forms are part of the toolbar but sit on a line of their own across the whole row. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-4 py-2">
        <LabelToolbar
          labels={labels}
          value={labelId}
          disabled={!ready}
          onPick={onPickLabel}
          onChanged={onLabelsChanged}
          onError={setError}
        />

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* One state, not two. "data not saved" and "unsaved changes" said almost the same thing
              and could not both be needed, so the generator-only case is named inside one badge. */}
          {dirty && (
            <span className="badge badge-warn" role="status">
              <span aria-hidden="true">✏️</span>
              {generatorDirty ? 'Data not saved' : 'Unsaved changes'}
            </span>
          )}
          {confirmReset ? (
            <>
              <span className="text-body text-slate-700">Discard your template?</span>
              <button type="button" onClick={onReset} className="btn btn-danger-solid">
                Yes, reset
              </button>
              <button type="button" onClick={() => setConfirmReset(false)} className={btnCls}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              disabled={!ready || !meta?.builtin}
              title={meta?.builtin ? undefined : 'A label of your own has no default to go back to'}
              className={btnCls}
            >
              Reset to default
            </button>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!ready || !dirty || generatorProblems.length > 0}
            title={generatorProblems.length > 0 ? 'Fix the data generator first' : undefined}
            className="btn btn-primary"
          >
            Save
          </button>
        </div>
      </div>

      {/* The tabs, what the current one is for, and the page size. The tab list holds only tabs: the
          hint describes whichever panel is showing, so it sits beside the list (and is the panels'
          description), not inside it, where a screen reader would count it as a tab. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-4 py-2">
        <div
          role="tablist"
          aria-label="Designer sections"
          className="flex items-center gap-1.5"
          onKeyDown={(e) => tabListKeyDown(e, TAB_IDS, tab === 'data' ? 'data' : 'layout', setTab)}
        >
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className="tab"
              onClick={() => setTab(id)}
            >
              {label}
              {id === 'data' && generatorDirty && (
                <span
                  className="ml-1.5 inline-block size-1.5 rounded-full bg-current align-middle"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
        <span id="designer-tab-hint" className="hidden min-w-0 flex-1 truncate text-body text-slate-500 lg:block">
          {TABS.find((t) => t[0] === tab)?.[2]}
        </span>

        {size && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-label font-semibold text-slate-500">Page size</span>
            <input
              aria-label="Width in mm"
              type="number"
              min={10}
              className="field field-num"
              value={size.w}
              disabled={!ready}
              onChange={(e) => setSize({ ...size, w: +e.target.value })}
            />
            <span aria-hidden="true" className="text-slate-400">
              ×
            </span>
            <input
              aria-label="Height in mm"
              type="number"
              min={10}
              className="field field-num"
              value={size.h}
              disabled={!ready}
              onChange={(e) => setSize({ ...size, h: +e.target.value })}
            />
            <span className="text-label text-slate-500">mm</span>
            <button
              type="button"
              onClick={applySize}
              disabled={!ready || size.w < 10 || size.h < 10}
              className="btn btn-secondary btn-sm"
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {pendingLabel && (
        <div className="tab-enter flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-body text-amber-900">
          <span className="min-w-0 break-words">
            Discard unsaved changes to “{meta?.name}” and open “{labels.find((l) => l.id === pendingLabel)?.name}”?
          </span>
          <button type="button" onClick={() => switchLabel(pendingLabel)} className="btn btn-danger-solid">
            Discard and switch
          </button>
          <button type="button" onClick={() => setPendingLabel(null)} className={btnCls}>
            Cancel
          </button>
        </div>
      )}

      {offerImport && (
        <div className="tab-enter flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-body text-indigo-900">
          <span className="min-w-0 break-words">
            This device has labels saved from an earlier version. Copy them onto “{user?.username}”?
          </span>
          <button type="button" onClick={runImport} className="btn btn-primary">
            Copy them
          </button>
          <button type="button" onClick={() => setOfferImport(false)} className={btnCls}>
            Not now
          </button>
          <span className="text-label text-indigo-700">The files stay on this device either way.</span>
        </div>
      )}

      {(error || message) && (
        <div
          key={error || message}
          className={
            (error ? 'alert-shake ' : 'tab-enter ') +
            'border-b px-4 py-2 text-sm break-words ' +
            (error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800')
          }
        >
          {error || message}
        </div>
      )}

      {/* The workspace. It takes whatever height is left and never less than 28rem, so a short window
          scrolls the page rather than shrinking the canvas. The Data tab is in the flow here (and so
          sets the height when it is longer); the canvas is absolutely positioned inside it. */}
      <div className="relative flex min-h-[28rem] flex-1 flex-col">
        {/* pdfme keeps drawing into this exact element for as long as the page lives, so it must stay
            mounted while the Data tab is showing. Unmounting it left pdfme painting into a detached
            node, and the Layout tab came back blank. It is hidden, not removed. */}
        <div
          ref={container}
          data-testid="designer-canvas"
          role="tabpanel"
          id="panel-layout"
          aria-labelledby="tab-layout"
          aria-describedby="designer-tab-hint"
          className={`absolute inset-0${tab === 'layout' ? '' : ' tab-hidden'}`}
        />
        {tab === 'layout' && !ready && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-slate-500">
            <span
              className="text-4xl"
              style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }}
              aria-hidden="true"
            >
              🎨
            </span>
            Loading designer…
          </div>
        )}
        {/* Always present so the Data tab's aria-controls points at something; empty until selected. */}
        <div
          role="tabpanel"
          id="panel-data"
          aria-labelledby="tab-data"
          aria-describedby="designer-tab-hint"
          hidden={tab !== 'data'}
          className="relative flex min-w-0 flex-1 flex-col"
        >
          {tab === 'data' && (
            <DataEditor
              template={currentTemplate}
              spec={generator}
              readOnly={meta?.builtin === true}
              onChange={setGenerator}
              sample={sample}
              onPreview={() => setPreviewing(true)}
              previewValues={previewValues}
              onPreviewValues={setPreviewValues}
              onSample={setSample}
            />
          )}
        </div>
      </div>

      {/* Below the canvas, folded away: it is something done now and then, not part of designing. When
          open it is capped and scrolls inside itself, so it cannot push the canvas off the screen. */}
      <details className="border-t border-slate-200 bg-white/70 px-4 py-2 text-body">
        <summary className="cursor-pointer font-medium text-slate-700">
          Export / import label (move it between devices)
        </summary>
        <div className="mt-2 max-h-[min(20rem,45dvh)] overflow-y-auto pb-1 pr-1">
          <TemplateTransfer key={labelId} label={labelId} onImported={onImported} />
        </div>
      </details>

      {previewing && (
        <PreviewDialog
          template={currentTemplate}
          spec={generator}
          sample={sample}
          previewValues={previewValues}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>
  );
}
