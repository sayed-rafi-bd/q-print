import type { Template } from '@pdfme/common';
import { barcodes, rectangle, text } from '@pdfme/schemas';
import { Viewer } from '@pdfme/ui';
import { useEffect, useRef, useState } from 'react';
import { previewInputs } from '../generator/previewInputs';
import type { GeneratorSpec } from '../generator/spec';
import { loadFont } from '../printApi';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const btnCls =
  'cursor-pointer rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 ' +
  'transition hover:bg-slate-50';

type Props = {
  template: Template;
  spec: GeneratorSpec;
  /** Records fetched in the Source pane; the first three are previewed when there are any. */
  sample?: unknown[] | null;
  onClose: () => void;
};

/**
 * Shows the label as it will actually print, with a fresh set of generated data.
 *
 * This is the check that catches content a barcode format cannot encode, before it reaches a print
 * job: pdfme renders the real page here, so anything it would reject shows up as an error now.
 */
export default function PreviewDialog({ template, spec, sample = null, onClose }: Props) {
  // A label with an API source previews the fetched sample, or ‹path› stand-ins when there is none.
  const real = Boolean(spec.source && sample && sample.length > 0);
  const standIns = Boolean(spec.source) && !real;
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
        const { inputs, standInBarcodes: madeUp } = previewInputs(template, spec, sample);
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
  }, [template, spec, sample]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white/95" role="dialog" aria-label="Label preview">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
        <span className="text-sm font-semibold text-slate-800">Preview</span>
        <span className="text-xs text-slate-500">
          {real
            ? `The first ${Math.min(3, sample?.length ?? 0)} record(s) of the fetched sample.`
            : 'Three pages of freshly generated data.'}
        </span>
        <button type="button" className={`${btnCls} ml-auto`} onClick={onClose}>
          Close
        </button>
      </div>

      {standIns && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          No sample has been fetched, so fields that read the API show their path.
          {standInBarcodes.length > 0 &&
            ` Barcode field(s) ${standInBarcodes.join(', ')} show a made-up value, since a barcode cannot show a path.`}{' '}
          Fetch a sample in the Source pane to preview real values.
        </p>
      )}

      {error && (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
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
