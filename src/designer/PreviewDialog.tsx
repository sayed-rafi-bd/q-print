import type { Template } from '@pdfme/common';
import { barcodes, rectangle, text } from '@pdfme/schemas';
import { Viewer } from '@pdfme/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type PreviewValues, previewInputs, usableValues } from '../generator/previewInputs';
import type { GeneratorSpec } from '../generator/spec';
import { loadFont } from '../printApi';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Props = {
  template: Template;
  spec: GeneratorSpec;
  /** Records fetched in the Source pane; the first three are previewed when there are any. */
  sample?: unknown[] | null;
  /** Placeholder values typed in the Data tab. They outrank a fetched record and a generated value. */
  previewValues?: PreviewValues;
  onClose: () => void;
};

/**
 * Shows the label as it will actually print, with a fresh set of generated data.
 *
 * This is the check that catches content a barcode format cannot encode, before it reaches a print
 * job: pdfme renders the real page here, so anything it would reject shows up as an error now.
 */
export default function PreviewDialog({ template, spec, sample = null, previewValues, onClose }: Props) {
  // A value the person typed wins over the fetched sample and over what a rule would generate.
  const typed = useMemo(() => usableValues(template, previewValues), [template, previewValues]);
  const typedCount = Object.keys(typed).length;
  // A record fetched by the "Test with a real API" section, or null. A label carries no address, so
  // records only ever come from a test the person just ran.
  const real = Boolean(sample && sample.length > 0);
  const standIns = !real;
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [standInBarcodes, setStandInBarcodes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    let viewer: Viewer | undefined;
    (async () => {
      try {
        // A handful of pages, so a sequence rule and a table read sensibly.
        const { inputs, standInBarcodes: madeUp } = previewInputs(template, spec, sample, typed);
        setStandInBarcodes(madeUp);
        const font = await loadFont();
        if (cancelled || !container.current) return;
        viewer = new Viewer({
          domContainer: container.current,
          template,
          inputs,
          plugins: { text, rectangle, ...barcodes },
          options: { font: { NotoSansJP: { data: font, fallback: true } } },
        });
        setBusy(false);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, [template, spec, sample, typed]);

  // Escape closes it, like the confirmation dialogs. Capturing, so it runs before pdfme's own handlers.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    // Fixed to the screen rather than to the page, so it is exactly one screen tall however far the
    // Designer behind it has been scrolled. The header stays put (Close is always reachable) and
    // the notices scroll inside their own band, leaving the rest of the height to the pages.
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white"
      role="dialog"
      aria-modal="true"
      aria-label="Label preview"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-4 py-2">
        <h2 className="text-body font-semibold text-slate-800">Preview</h2>
        <span className="min-w-0 flex-1 text-label text-slate-500">
          {typedCount > 0
            ? `Three pages, with your placeholder value in ${typedCount} field(s).`
            : real
              ? `The first ${Math.min(3, sample?.length ?? 0)} record(s) of the fetched sample.`
              : 'Three pages of freshly generated data.'}
        </span>
        <button type="button" className="btn btn-secondary ml-auto" onClick={onClose}>
          Close
        </button>
      </div>

      {(standIns || error) && (
        <div className="max-h-[30dvh] shrink-0 overflow-y-auto">
          {standIns && (
            <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-body text-amber-900">
              {typedCount > 0
                ? `Fields without a placeholder of your own show their path, since the API has not been fetched.`
                : 'No sample has been fetched, so fields that read the API show their path.'}
              {standInBarcodes.length > 0 &&
                ` Barcode field(s) ${standInBarcodes.join(', ')} show a made-up value, since a barcode cannot show a path.`}{' '}
              Type a placeholder value in the Data tab, or fetch a sample in the Source pane.
            </p>
          )}

          {error && (
            <p role="alert" className="break-words border-b border-red-200 bg-red-50 px-4 py-2 text-body text-red-700">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={container} className="absolute inset-0" />
        {busy && !error && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-500">
            <span
              className="text-3xl"
              style={{ animation: 'mascot-bounce 1.2s ease-in-out infinite' }}
              aria-hidden="true"
            >
              👀
            </span>
            Rendering…
          </div>
        )}
      </div>
    </div>
  );
}
