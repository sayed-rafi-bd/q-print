import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ApiSettings,
  type ApiStatus,
  getRecent,
  getStatus,
  type RecentCall,
  regenerateToken,
  setSettings,
  UNAVAILABLE,
} from './apiClient';
import { type SnippetRequest, snippets } from './snippets';

/**
 * The API tab: try every endpoint from inside the app, and see how to call it.
 *
 * The Send button uses real `fetch` against the local server rather than a Tauri command. That is
 * deliberate and is the reason the app's own origins are on the server's allow-list: going through
 * the real path means "it works on this page" is the same statement as "it works for an
 * integrator", rather than a second implementation that could behave differently.
 */

/** Which endpoint the form is set up for. */
type Endpoint = 'health' | 'printers' | 'labels' | 'print' | 'printPdf';

const ENDPOINTS: { id: Endpoint; method: 'GET' | 'POST'; path: string; blurb: string }[] = [
  { id: 'health', method: 'GET', path: '/health', blurb: 'Is it up? Needs no token.' },
  { id: 'printers', method: 'GET', path: '/printers', blurb: 'Installed printers.' },
  { id: 'labels', method: 'GET', path: '/labels', blurb: "The signed-in account's labels." },
  { id: 'print', method: 'POST', path: '/print', blurb: 'Render a saved label and print it.' },
  { id: 'printPdf', method: 'POST', path: '/print/pdf', blurb: 'Print a PDF you already have.' },
];

/** What came back from the last send. */
type Result = {
  status: number;
  ms: number;
  contentType: string;
  json: string | null;
  /** A dry run's PDF, as an object URL to show. */
  pdfUrl: string | null;
  error: string | null;
};

const NONE: Result = { status: 0, ms: 0, contentType: '', json: null, pdfUrl: null, error: null };

export default function ApiPage() {
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [recent, setRecent] = useState<RecentCall[]>([]);
  const [endpoint, setEndpoint] = useState<Endpoint>('health');
  const [showToken, setShowToken] = useState(false);
  const [includeToken, setIncludeToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(NONE);
  const [copied, setCopied] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  // The print form. Kept as strings so nothing is reformatted under the person typing.
  const [label, setLabel] = useState('');
  const [printer, setPrinter] = useState('');
  const [pages, setPages] = useState('1');
  const [rows, setRows] = useState('[\n  { "name": "Tea 500g", "barcode": "4901234567894" }\n]');
  const [dryRun, setDryRun] = useState(false);
  const [filePath, setFilePath] = useState('C:\\labels\\sample.pdf');
  const [options, setOptions] = useState('{\n  "paper": "A6",\n  "orientation": "auto",\n  "dpi": "203x203"\n}');

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus());
      setRecent(await getRecent());
    } catch {
      // A build with no server. The page still renders, and says so.
      setStatus(UNAVAILABLE);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const settings = status?.settings;
  const baseUrl = status?.baseUrl ?? '';
  const chosen = ENDPOINTS.find((e) => e.id === endpoint)!;

  /** The JSON body the form currently describes, or a reason it cannot make one. */
  const body = useMemo((): { json?: string; problem?: string } => {
    if (chosen.method !== 'POST' || chosen.id === 'printPdf') return {};
    let options_: Record<string, unknown> = {};
    if (options.trim()) {
      try {
        options_ = JSON.parse(options);
      } catch (e) {
        return { problem: `The print options are not valid JSON: ${(e as Error).message}` };
      }
    }
    if (!label.trim()) return { problem: 'Choose a label.' };
    if (!printer.trim()) return { problem: 'Choose a printer.' };
    const count = Number(pages);
    if (!Number.isInteger(count) || count < 1) return { problem: 'Pages must be a whole number, at least 1.' };
    let rows_: unknown;
    if (rows.trim()) {
      try {
        rows_ = JSON.parse(rows);
      } catch (e) {
        return { problem: `The rows are not valid JSON: ${(e as Error).message}` };
      }
      if (!Array.isArray(rows_)) return { problem: 'Rows must be a list of objects.' };
    }
    return {
      json: JSON.stringify(
        {
          label,
          printer,
          pages: count,
          ...(rows_ ? { rows: rows_ } : {}),
          ...options_,
          ...(dryRun ? { dryRun: true } : {}),
        },
        null,
        2,
      ),
    };
  }, [chosen, dryRun, label, options, pages, printer, rows]);

  /** The request as the page is about to send it, which is also what the snippets describe. */
  const request = useMemo((): SnippetRequest => {
    const query = chosen.id === 'printPdf' ? `?printer=${encodeURIComponent(printer)}` : '';
    return {
      method: chosen.method,
      path: `${chosen.path}${query}`,
      baseUrl,
      token: settings?.token ?? '',
      includeToken,
      body: body.json,
      filePath: chosen.id === 'printPdf' ? filePath : undefined,
    };
  }, [baseUrl, body.json, chosen, filePath, includeToken, printer, settings?.token]);

  const send = async () => {
    setBusy(true);
    setResult(NONE);
    const started = performance.now();
    try {
      if (body.problem) {
        setResult({ ...NONE, error: body.problem });
        return;
      }
      // The real thing, over a real socket, with the real token -- the same call an integrator makes.
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${request.path}`, {
        method: chosen.method,
        headers: {
          Authorization: `Bearer ${settings?.token ?? ''}`,
          ...(body.json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body.json ?? undefined,
      });
      const ms = Math.round(performance.now() - started);
      const type = response.headers.get('content-type') ?? '';

      if (type.includes('application/pdf')) {
        const blob = await response.blob();
        setResult({
          status: response.status,
          ms,
          contentType: type,
          json: null,
          pdfUrl: URL.createObjectURL(blob),
          error: null,
        });
      } else {
        const text = await response.text();
        let pretty: string | null = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Not JSON at all. Shown as it came, which is more use than an error.
        }
        setResult({ status: response.status, ms, contentType: type, json: pretty, pdfUrl: null, error: null });
      }
      void refresh();
    } catch (e) {
      // Almost always the one failure a person can fix: the server is not listening.
      setResult({ ...NONE, ms: Math.round(performance.now() - started), error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied('failed');
    }
  };

  const apply = (next: Partial<ApiSettings>) => {
    if (!settings) return;
    void setSettings({ ...settings, ...next }).then(setStatus);
  };

  if (!status) {
    return <div className="p-8 text-center text-sm text-slate-500">Checking the print API…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-10 md:p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-slate-900">Print API</h1>
        <p className="max-w-lg text-sm text-slate-600">
          Anything on this PC can print through a local HTTP API while the app is running. The buttons here make real
          calls to it, so what works here works for your program.
        </p>
      </header>

      {!status.available ? (
        <p className="card p-4 text-sm text-amber-900 ring-1 ring-amber-200">{status.problem}</p>
      ) : (
        <>
          {/* 1. Status and access */}
          <section className="card space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lead font-semibold text-slate-800">Status</h2>
              {status.running ? (
                <span className="badge badge-accent">Running</span>
              ) : status.settings.enabled ? (
                <span className="badge badge-warn">Not running</span>
              ) : (
                <span className="badge badge-neutral">Off</span>
              )}
            </div>
            {status.problem && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">
                {status.problem}
              </p>
            )}

            <Field label="Base URL">
              <div className="flex gap-2">
                <input className="field flex-1" readOnly value={baseUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-secondary" onClick={() => copy('url', baseUrl)}>
                  {copied === 'url' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </Field>

            <Field label="Token" hint="Sent as `Authorization: Bearer …`. Shown only here; regenerate to change it.">
              <div className="flex gap-2">
                <input
                  className="field flex-1 font-mono text-xs"
                  readOnly
                  value={showToken ? (settings?.token ?? '') : '•'.repeat(24)}
                  onFocus={(e) => e.target.select()}
                />
                <button type="button" className="btn btn-ghost" onClick={() => setShowToken((v) => !v)}>
                  {showToken ? 'Hide' : 'Reveal'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => copy('token', settings?.token ?? '')}
                  disabled={!settings?.token}
                >
                  {copied === 'token' ? 'Copied' : 'Copy'}
                </button>
                {regenerating ? (
                  <span className="text-xs text-amber-800">The old token stops working at once.</span>
                ) : (
                  <button type="button" className="btn btn-danger" onClick={() => setRegenerating(true)}>
                    New token
                  </button>
                )}
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Port" hint="Between 1024 and 65535.">
                <div className="flex gap-2">
                  <input
                    className="field w-32"
                    type="number"
                    defaultValue={settings?.port ?? ''}
                    onBlur={(e) => {
                      const port = Number(e.target.value);
                      if (port !== settings?.port) apply({ port });
                    }}
                  />
                  <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
                    Re-check
                  </button>
                </div>
              </Field>
              <Field
                label="Turn the API off"
                hint="Nothing is printed until you put it back. The port stops being listened on."
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings?.enabled ?? false}
                    onChange={(e) => apply({ enabled: e.target.checked })}
                  />
                  {settings?.enabled ? 'On' : 'Off'}
                </label>
              </Field>
            </div>

            <Field
              label="Extra origins"
              hint="For a web page on another machine's site to call this. The app's own pages are always allowed."
            >
              <textarea
                className="field h-20 font-mono text-xs"
                defaultValue={(settings?.allowedOrigins ?? []).join('\n')}
                placeholder="http://pos.local:8080"
                onBlur={(e) =>
                  apply({
                    allowedOrigins: e.target.value
                      .split('\n')
                      .map((o) => o.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          </section>

          {/* 2. Try it */}
          <section className="card space-y-4 p-5">
            <h2 className="text-lead font-semibold text-slate-800">Try it</h2>
            <div className="flex flex-wrap gap-2">
              {ENDPOINTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    setEndpoint(e.id);
                    setResult(NONE);
                  }}
                  className={`cursor-pointer rounded-full px-3 py-1.5 font-mono text-xs transition ${
                    endpoint === e.id ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-700 hover:bg-indigo-100'
                  }`}
                >
                  {e.method} {e.path}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">{chosen.blurb}</p>

            {chosen.id === 'print' && (
              <>
                <Field label="Label">
                  <input
                    className="field"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="product"
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Printer">
                    <input
                      className="field"
                      value={printer}
                      onChange={(e) => setPrinter(e.target.value)}
                      placeholder="Zebra ZD421"
                    />
                  </Field>
                  <Field label="Pages">
                    <input
                      className="field"
                      type="number"
                      min={1}
                      value={pages}
                      onChange={(e) => setPages(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Rows" hint="One object per page. A single object is used for every page.">
                  <textarea
                    className="field h-32 font-mono text-xs"
                    value={rows}
                    onChange={(e) => setRows(e.target.value)}
                  />
                </Field>
                <Field
                  label="Other options"
                  hint="paper, orientation, dpi, rotate, margins. Left as they are if empty."
                >
                  <textarea
                    className="field h-24 font-mono text-xs"
                    value={options}
                    onChange={(e) => setOptions(e.target.value)}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                  Dry run — return the PDF instead of printing it
                </label>
              </>
            )}

            {chosen.id === 'printPdf' && (
              <>
                <Field label="Printer" hint="Sent as a query parameter, because the body is the file.">
                  <input
                    className="field"
                    value={printer}
                    onChange={(e) => setPrinter(e.target.value)}
                    placeholder="Zebra ZD421"
                  />
                </Field>
                <Field
                  label="PDF file"
                  hint="The snippet below reads this from disk. The Send button needs a running server, so pick a real one."
                >
                  <input
                    className="field font-mono text-xs"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                  />
                </Field>
              </>
            )}

            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !status.running}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
            {!status.running && (
              <p className="text-xs text-amber-800">The server is not running, so there is nothing to send to.</p>
            )}
          </section>

          {/* 3. Result */}
          {result.status > 0 && (
            <section className="card space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lead font-semibold text-slate-800">Result</h2>
                <span className={`badge ${result.status < 400 ? 'badge-accent' : 'badge-danger'}`}>
                  HTTP {result.status}
                </span>
                <span className="text-xs text-slate-500">{result.ms} ms</span>
                <span className="ml-auto text-xs text-slate-400">{result.contentType}</span>
              </div>
              {result.error && (
                <p className="rounded-xl bg-red-50 p-3 font-mono text-xs text-red-800 ring-1 ring-red-200">
                  {result.error}
                </p>
              )}
              {result.json && (
                <pre className="max-h-72 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-xs text-slate-100">
                  {result.json}
                </pre>
              )}
              {result.pdfUrl && (
                <iframe
                  title="The PDF a dry run returned"
                  src={result.pdfUrl}
                  className="h-96 w-full rounded-xl border"
                />
              )}
            </section>
          )}

          {/* 4. Copy as code */}
          <section className="card space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lead font-semibold text-slate-800">Copy as code</h2>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={includeToken} onChange={(e) => setIncludeToken(e.target.checked)} />
                Include the real token
              </label>
            </div>
            {!includeToken && (
              <p className="rounded-xl bg-indigo-50 p-2.5 text-xs text-indigo-900 ring-1 ring-indigo-200">
                The token is left out until you ask for it. It is the one part of this page worth not pasting into a
                chat or a screenshot.
              </p>
            )}
            {snippets(request).map((s) => (
              <div key={s.language} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-600">{s.label}</span>
                  <button type="button" className="btn btn-ghost" onClick={() => copy(s.language, s.code)}>
                    {copied === s.language ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-xl bg-slate-900 p-3 font-mono text-xs text-slate-100">
                  {s.code}
                </pre>
              </div>
            ))}
          </section>

          {/* 5. Recent calls */}
          <section className="card space-y-2 p-5">
            <h2 className="text-lead font-semibold text-slate-800">Recent API calls</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing yet. Try a button above, or call it from elsewhere.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-xs">
                {recent.map((c) => (
                  // `seq`, not the index: the list grows at the top, and an index key would make
                  // every row re-render whenever a call arrives.
                  <li key={c.seq} className="flex items-center gap-2 py-1.5">
                    <span className="font-mono text-slate-700">
                      {c.method} {c.path}
                    </span>
                    <span className={`badge ${c.status < 400 ? 'badge-accent' : 'badge-danger'}`}>{c.status}</span>
                    <span className="ml-auto text-slate-400">{c.ms} ms</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {regenerating && (
            <div className="card flex flex-wrap items-center gap-3 p-4">
              <span className="text-sm text-slate-700">
                Make a new token? Anything using the old one stops working.
              </span>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setRegenerating(false);
                  void regenerateToken().then(setStatus).then(refresh);
                }}
              >
                New token
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setRegenerating(false)}>
                Keep it
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A labelled control.
 *
 * A `<div>` rather than a `<label>`: these fields hold checkboxes, textareas and buttons as well as
 * inputs, and a label wrapping a button is not a label for anything. Screen readers get the
 * association from the text in the caption.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
