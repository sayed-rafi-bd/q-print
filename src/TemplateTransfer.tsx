import type { Template } from '@pdfme/common';
import { useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import { isBuiltin } from './builtinLabels';
import { bundleJson, makeBundle, parseBundle } from './bundle';
import { scaffoldSpec } from './generator/scaffold';
import { fitName } from './labelId';
import { createLabel, type LabelId, loadLabel, saveLabel } from './labels';
import { saveBuiltinTemplate } from './templateStore';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The shared button shapes from index.css, so the panel looks the same on the Designer and Print pages.
const btnCls = 'btn btn-secondary';
const btnPrimaryCls = 'btn btn-primary';

/**
 * Moves a label between devices as JSON, so one designed on desktop can be used on Android.
 *
 * Export writes the whole label — layout *and* the data generator — so the receiving device
 * produces the same data, not just the same picture. Import also accepts a bare pdfme template,
 * which is what older versions exported: that replaces the layout and leaves the generator alone.
 *
 * Works with a file picker or copy/paste (a download link is not reliable in every WebView).
 */
export default function TemplateTransfer({
  label,
  onImported,
}: {
  label: LabelId;
  onImported?: (t: Template) => void;
}) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState(`label-${label}.json`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const reset = () => {
    setError('');
    setMessage('');
  };

  const openExport = async () => {
    reset();
    setBusy(true);
    try {
      if (!user) throw new Error('You are not signed in.');
      const { template, source, generator } = await loadLabel(user, label);
      // Export what is saved, not unsaved Designer edits.
      setText(bundleJson(makeBundle(label, template, generator)));
      setFileName(`label-${label}.json`);
      setMode('export');
      setMessage(`Exporting the ${source} label, with its data generator.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openImport = () => {
    reset();
    setText('');
    setMode('import');
  };

  const copy = async () => {
    reset();
    try {
      await navigator.clipboard.writeText(text);
      setMessage('Copied to the clipboard.');
    } catch (e) {
      setError(`Could not copy (${errMsg(e)}). Select the text and copy it manually.`);
    }
  };

  const download = () => {
    reset();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setMessage('Download started. If nothing was saved on this device, use Copy instead.');
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    reset();
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const apply = async () => {
    reset();
    setBusy(true);
    try {
      const parsed = parseBundle(text);

      if (parsed.bundle) {
        // A whole label. Imported as a new label of its own, so it cannot overwrite one by mistake.
        const name = fitName(parsed.bundle.name) || 'Imported label';
        const template = parsed.bundle.template as Template;
        const generator = scaffoldSpec(template, parsed.bundle.generator);
        const size = (template.basePdf as { width?: number; height?: number }) ?? {};
        if (!user) throw new Error('You are not signed in.');
        const created = await createLabel(user, {
          name,
          widthMm: Number(size.width) || 100,
          heightMm: Number(size.height) || 50,
          from: { kind: 'blank' },
        });
        // createLabel starts from blank, so write the imported layout and rules over the top.
        await saveLabel(user, created.id, name, template, generator);
        setMode(null);
        setMessage(`Imported as a new label, “${name}”. Find it in the label list above.`);
        onImported?.(template);
        return;
      }

      // A bare template from an older version: replace the selected label's layout and keep its
      // generator, so the fields it already fills still do.
      if (!user) throw new Error('You are not signed in.');
      const template = parsed.template!;
      if (isBuiltin(label)) {
        await saveBuiltinTemplate(label, template);
      } else {
        const { generator } = await loadLabel(user, label);
        await saveLabel(user, label, label, template, scaffoldSpec(template, generator));
      }
      setMode(null);
      setMessage('Imported the template. Printing now uses this layout, with the label’s existing data.');
      onImported?.(template);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnCls} disabled={busy || !label} onClick={openExport}>
          Export label
        </button>
        <button type="button" className={btnCls} disabled={busy} onClick={openImport}>
          Import label
        </button>
        {mode && (
          <button
            type="button"
            className={btnCls}
            onClick={() => {
              setMode(null);
              reset();
            }}
          >
            Close
          </button>
        )}
      </div>

      {mode && (
        <div className="tab-enter space-y-2">
          {mode === 'import' && (
            <input
              type="file"
              accept=".json,application/json"
              className="block w-full text-body text-slate-700 file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-body file:font-semibold file:text-slate-700 hover:file:bg-slate-50"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          )}
          <textarea
            value={text}
            readOnly={mode === 'export'}
            rows={8}
            spellCheck={false}
            placeholder={mode === 'import' ? 'Choose a .json file above or paste the label JSON here' : ''}
            onChange={(e) => setText(e.target.value)}
            className="field font-mono"
          />
          <div className="flex flex-wrap gap-2">
            {mode === 'export' ? (
              <>
                <button type="button" className={btnCls} onClick={copy}>
                  Copy
                </button>
                <button type="button" className={btnCls} onClick={download}>
                  Download .json
                </button>
              </>
            ) : (
              <button type="button" className={btnPrimaryCls} disabled={busy || !text.trim()} onClick={apply}>
                Import it
              </button>
            )}
          </div>
          {mode === 'import' && (
            <p className="field-hint mt-0">
              A full label file becomes a new label. A bare pdfme template replaces the layout of “{label}” and keeps
              its data generator.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="break-words text-body text-red-700">
          {error}
        </p>
      )}
      {message && <p className="break-words text-body text-emerald-800">{message}</p>}
    </div>
  );
}
