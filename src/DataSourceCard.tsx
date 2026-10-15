import { useEffect, useRef, useState } from 'react';
import { fetchRecords } from './apiClient';
import { buildUrl, normalizeUrl, urlVariables } from './generator/apiSource';
import { LIMITS } from './generator/engine';
import { MOCK_HOST } from './generator/mockApi';
import type { ApiSource } from './generator/spec';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100';

/** The address as it will be called, with the host split out so it can be shown in bold. */
export function resolvedAddress(
  source: ApiSource,
  values: Record<string, string>,
): { scheme: string; host: string; rest: string; ready: boolean } {
  let ready = true;
  let text: string;
  try {
    text = buildUrl(source.url, values);
  } catch {
    ready = false;
    // Not every variable has a value yet: show the pattern with what is filled in so far.
    text = normalizeUrl(source.url).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
      (values[name] ?? '').trim() ? encodeURIComponent(values[name].trim()) : whole,
    );
  }
  const match = /^(https?:\/\/)([^/?#]*)(.*)$/i.exec(text);
  if (!match) return { scheme: '', host: '', rest: text, ready };
  return { scheme: match[1], host: match[2], rest: match[3], ready };
}

export type CheckState = { records: number } | null;

/**
 * The "Data source" card of the Print tab: the variables the label's URL asks for, the address
 * that will be called (always visible, so an imported label cannot send a request unseen), the
 * access token if the label needs one, and an optional **Check data** button.
 *
 * The token is only ever held by the parent's React state; nothing here writes it anywhere.
 */
export default function DataSourceCard({
  source,
  values,
  onValues,
  token,
  onToken,
  copies,
  checked,
  onChecked,
  disabled,
}: {
  source: ApiSource;
  values: Record<string, string>;
  onValues: (values: Record<string, string>) => void;
  token: string;
  onToken: (token: string) => void;
  copies: number;
  checked: CheckState;
  onChecked: (state: CheckState) => void;
  disabled?: boolean;
}) {
  const names = urlVariables(source.url);
  const address = resolvedAddress(source, values);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');
  const [first, setFirst] = useState('');
  // A late answer must not land on a different label or edited values: every check takes a number
  // and only the newest one may write its result.
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  // Editing anything invalidates the earlier check.
  const reset = () => {
    run.current++;
    setChecking(false);
    setProblem('');
    setFirst('');
    onChecked(null);
  };

  const onCheck = async () => {
    const me = ++run.current;
    setChecking(true);
    setProblem('');
    setFirst('');
    onChecked(null);
    try {
      const records = await fetchRecords(source, values, token);
      if (me !== run.current) return;
      setFirst(JSON.stringify(records[0], null, 2));
      onChecked({ records: records.length });
    } catch (e) {
      if (me === run.current) setProblem(errMsg(e));
    } finally {
      if (me === run.current) setChecking(false);
    }
  };

  const total = checked ? checked.records * copies : 0;

  return (
    <section
      aria-label="Data source"
      className="space-y-3 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 md:col-span-2"
    >
      <h2 className="text-sm font-semibold text-slate-800">Data source</h2>

      {names.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {names.map((name) => (
            <div key={name} className="space-y-1">
              <label htmlFor={`var-${name}`} className="text-sm font-medium text-slate-700">
                {source.variables?.[name]?.label || name}
              </label>
              <input
                id={`var-${name}`}
                type="text"
                required
                className={inputCls}
                value={values[name] ?? ''}
                disabled={disabled}
                onChange={(e) => {
                  reset();
                  onValues({ ...values, [name]: e.target.value });
                }}
              />
            </div>
          ))}
        </div>
      )}

      <p className="break-all text-xs text-slate-600" data-testid="resolved-url">
        <span className="text-slate-500">Will call: </span>
        {address.host ? (
          <>
            {address.scheme}
            <strong className="font-semibold text-slate-900">{address.host}</strong>
            {address.rest}
          </>
        ) : (
          address.rest
        )}
      </p>

      {address.host === MOCK_HOST && (
        <p className="text-xs text-slate-500" data-testid="mock-note">
          Sample data made inside the app. Nothing is sent over the network.
        </p>
      )}

      {source.bearerAuth && (
        <div className="space-y-1">
          <label htmlFor="source-token" className="text-sm font-medium text-slate-700">
            Access token
          </label>
          <input
            id="source-token"
            type="password"
            autoComplete="off"
            className={inputCls}
            value={token}
            disabled={disabled}
            onChange={(e) => {
              reset();
              onToken(e.target.value);
            }}
          />
          <p className="text-xs text-slate-500">Sent only with this request. It is not saved anywhere.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onCheck}
          disabled={disabled || checking}
          className="cursor-pointer rounded-xl border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {checking ? 'Checking…' : 'Check data'}
        </button>
        {checked && (
          <p role="status" className="text-sm text-emerald-800">
            {checked.records} {checked.records === 1 ? 'record' : 'records'} found
            {total > 0 && ` · ${checked.records} × ${copies} = ${total} ${total === 1 ? 'page' : 'pages'}`}
            {total > LIMITS.maxRows && ` (over the limit of ${LIMITS.maxRows})`}
          </p>
        )}
      </div>

      {problem && (
        <p role="alert" className="break-words rounded-xl bg-red-50 p-2.5 text-xs text-red-700 ring-1 ring-red-200">
          {problem}
        </p>
      )}
      {first && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-600">First record</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-slate-900 p-2 text-slate-100">{first}</pre>
        </details>
      )}
    </section>
  );
}
