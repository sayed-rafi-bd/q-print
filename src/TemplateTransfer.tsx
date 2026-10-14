import { useState } from 'react';
import type { Template } from '@pdfme/common';
import { getTemplate, saveTemplate } from './templateStore';
import type { LabelId } from './labels';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const btnBase =
  'cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition ' +
  'disabled:cursor-not-allowed disabled:opacity-50';
// Colours are in separate variants so no element carries two conflicting colour utilities.
const btnCls = btnBase + ' border-slate-300 text-slate-700 hover:bg-slate-50';
const btnPrimaryCls = btnBase + ' border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-500';

/** Throws unless `value` looks like a pdfme template. */
function parseTemplate(text: string): Template {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${errMsg(e)}`);
  }
  const t = value as Partial<Template> | null;
  if (!t || typeof t !== 'object' || !Array.isArray(t.schemas) || t.basePdf == null) {
    throw new Error('This does not look like a pdfme template (needs "basePdf" and "schemas").');
  }
  return t as Template;
}

/**
 * Moves the saved template between devices as JSON, so a layout designed on desktop can be used on
 * Android. Works with a file picker or copy/paste (a download link is not reliable in every WebView).
 */
export default function TemplateTransfer({ label, onImported }: { label: LabelId; onImported?: (t: Template) => void }) {
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const reset = () => { setError(''); setMessage(''); };

  const openExport = async () => {
    reset(); setBusy(true);
    try {
      const { template, source } = await getTemplate(label);
      setText(JSON.stringify(template, null, 2));
      setMode('export');
      setMessage(`Exporting the ${source} template (the saved one, not unsaved Designer edits).`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openImport = () => { reset(); setText(''); setMode('import'); };

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
    a.download = `label-template-${label}.json`;
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
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const apply = async () => {
    reset(); setBusy(true);
    try {
      const t = parseTemplate(text);
      await saveTemplate(label, t);
      onImported?.(t);
      setMessage('Imported and saved. Printing now uses this template.');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className={btnCls} disabled={busy} onClick={openExport}>Export template</button>
        <button className={btnCls} disabled={busy} onClick={openImport}>Import template</button>
        {mode && <button className={btnCls} onClick={() => { setMode(null); reset(); }}>Close</button>}
      </div>

      {mode && (
        <div className="space-y-2">
          {mode === 'import' && (
            <input type="file" accept=".json,application/json" className="block w-full text-sm text-slate-700"
              onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          )}
          <textarea value={text} readOnly={mode === 'export'} rows={8} spellCheck={false}
            placeholder={mode === 'import' ? 'Choose a .json file above or paste the template JSON here' : ''}
            onChange={e => setText(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs text-slate-800" />
          <div className="flex flex-wrap gap-2">
            {mode === 'export' ? (
              <>
                <button className={btnCls} onClick={copy}>Copy</button>
                <button className={btnCls} onClick={download}>Download .json</button>
              </>
            ) : (
              <button className={btnPrimaryCls}
                disabled={busy || !text.trim()} onClick={apply}>Save as my template</button>
            )}
          </div>
        </div>
      )}

      {error && <p role="alert" className="break-words text-xs text-red-700">{error}</p>}
      {message && <p className="break-words text-xs text-emerald-800">{message}</p>}
    </div>
  );
}
