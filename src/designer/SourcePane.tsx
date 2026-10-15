import { useEffect, useRef, useState } from 'react';
import { fetchRecords } from '../apiClient';
import { checkSourceUrl, leafPaths, urlVariables } from '../generator/apiSource';
import { MOCK_HOST } from '../generator/mockApi';
import type { ApiSource } from '../generator/spec';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const inputCls =
  'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 ' +
  'focus:outline-none focus:ring-1 focus:ring-indigo-200 disabled:bg-slate-100';
const btnCls =
  'cursor-pointer rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 ' +
  'transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

type Props = {
  /** The label's data source, or undefined when it has none. */
  source: ApiSource | undefined;
  onChange: (next: ApiSource | undefined) => void;
  /** The sample fetched here (kept by the designer so the rules and the preview can use it). */
  sample: unknown[] | null;
  onSample: (records: unknown[] | null) => void;
  /** Whether any field already reads the API; only used for the hint. */
  usedByFields: boolean;
  readOnly?: boolean;
};

/**
 * The Source pane of the Data tab: the URL pattern, where the list lives in the response, the
 * optional names and defaults of the variables, whether a token is needed, and a way to fetch one
 * sample so the fields can be mapped to real paths.
 *
 * Nothing typed in the test area is saved with the label. The token is held only while the request
 * is made and is cleared straight after.
 */
export default function SourcePane({ source, onChange, sample, onSample, usedByFields, readOnly }: Props) {
  const locked = readOnly === true;
  const names = source ? urlVariables(source.url) : [];
  const urlProblems = source ? checkSourceUrl(source.url) : [];

  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [token, setToken] = useState('');
  const [fetching, setFetching] = useState(false);
  const [problem, setProblem] = useState('');
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  // A sample fetched for another address or list path says nothing about the new one.
  const edit = (patch: Partial<ApiSource>) => {
    if (!source) return;
    const next: ApiSource = { ...source, ...patch };
    if (!next.listPath) delete next.listPath;
    if (!next.bearerAuth) delete next.bearerAuth;
    // Settings of variables the URL no longer has are dropped, so nothing stale is saved.
    const keep = new Set(urlVariables(next.url));
    if (next.variables) {
      const vars = Object.fromEntries(Object.entries(next.variables).filter(([k]) => keep.has(k)));
      if (Object.keys(vars).length > 0) next.variables = vars;
      else delete next.variables;
    }
    if (patch.url !== undefined || patch.listPath !== undefined) {
      run.current++;
      setFetching(false);
      setProblem('');
      onSample(null);
    }
    onChange(next);
  };

  const setVariable = (name: string, patch: { label?: string; default?: string }) => {
    if (!source) return;
    const current = { ...(source.variables?.[name] ?? {}), ...patch };
    if (!current.label) delete current.label;
    if (!current.default) delete current.default;
    const variables = { ...(source.variables ?? {}) };
    if (Object.keys(current).length > 0) variables[name] = current;
    else delete variables[name];
    edit({ variables });
  };

  const onFetch = async () => {
    if (!source) return;
    const me = ++run.current;
    setFetching(true);
    setProblem('');
    try {
      // The label's defaults fill in what was not typed here.
      const values = Object.fromEntries(names.map((n) => [n, testValues[n] ?? source.variables?.[n]?.default ?? '']));
      const records = await fetchRecords(source, values, token);
      if (me === run.current) onSample(records);
    } catch (e) {
      if (me === run.current) {
        onSample(null);
        setProblem(errMsg(e));
      }
    } finally {
      if (me === run.current) setFetching(false);
      setToken(''); // not kept after the request
    }
  };

  if (!source) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-slate-600">
          A label can fill its fields from a web API instead of random data. At print time the app asks for the
          variables in the address, calls it, and prints one label per record.
        </p>
        <button type="button" className={btnCls} disabled={locked} onClick={() => onChange({ url: '' })}>
          Use an API as the data source
        </button>
      </div>
    );
  }

  const paths = sample?.[0] !== undefined ? leafPaths(sample[0]) : [];

  return (
    <div className="space-y-4">
      {locked && (
        <p className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
          This built-in label reads sample data from an API that runs inside the app, so no network is used. The address
          and field mapping are fixed. Use <strong>Duplicate</strong> to get a copy you can point at your own API.
        </p>
      )}
      {source.url.includes(MOCK_HOST) && !locked && (
        <p className="text-xs text-slate-500">This address is the app's built-in sample API; it needs no network.</p>
      )}
      <div className="space-y-1">
        <label htmlFor="source-url" className="text-xs font-medium text-slate-700">
          URL pattern
        </label>
        <input
          id="source-url"
          className={`${inputCls} font-mono`}
          placeholder="api.example.com/day/{day}/count/{count}/logs"
          value={source.url}
          disabled={locked}
          onChange={(e) => edit({ url: e.target.value })}
        />
        <p className="text-xs text-slate-500">
          Put a name in braces wherever a value is typed at print time. Without http:// or https:// the address is
          called with https.
        </p>
        {names.length > 0 && (
          <p className="flex flex-wrap items-center gap-1 text-xs text-slate-600">
            Variables:
            {names.map((n) => (
              <code key={n} className="rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-800">
                {n}
              </code>
            ))}
          </p>
        )}
        {urlProblems.length > 0 && source.url.trim() !== '' && (
          <ul className="list-inside list-disc text-xs text-red-700">
            {urlProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="source-list" className="text-xs font-medium text-slate-700">
          List path (optional)
        </label>
        <input
          id="source-list"
          className={`${inputCls} font-mono`}
          placeholder="data"
          value={source.listPath ?? ''}
          disabled={locked}
          onChange={(e) => edit({ listPath: e.target.value })}
        />
        <p className="text-xs text-slate-500">
          {
            'If the response is { "data": [ ... ] } enter data. Empty means the response itself: a list gives one label per item, an object gives one label.'
          }
        </p>
      </div>

      {names.length > 0 && (
        <fieldset className="space-y-2" disabled={locked}>
          <legend className="text-xs font-medium text-slate-700">Variables</legend>
          {names.map((n) => (
            <div key={n} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <code className="w-20 truncate rounded bg-slate-100 px-1.5 py-0.5 text-slate-800">{n}</code>
              <input
                aria-label={`Label for ${n}`}
                className={`${inputCls} w-40`}
                placeholder="Label shown when printing"
                value={source.variables?.[n]?.label ?? ''}
                onChange={(e) => setVariable(n, { label: e.target.value })}
              />
              <input
                aria-label={`Default for ${n}`}
                className={`${inputCls} w-40`}
                placeholder="Default value"
                value={source.variables?.[n]?.default ?? ''}
                onChange={(e) => setVariable(n, { default: e.target.value })}
              />
            </div>
          ))}
        </fieldset>
      )}

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={source.bearerAuth === true}
            disabled={locked}
            onChange={(e) => edit({ bearerAuth: e.target.checked })}
          />
          Use a bearer token
        </label>
        <p className="text-xs text-slate-500">
          The token is asked for when printing. It is not saved in the label or in exported files.
        </p>
      </div>

      <section aria-label="Test" className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <h3 className="text-xs font-semibold text-slate-700">Test the address</h3>
        <p className="text-xs text-slate-500">
          Fetch one sample so the fields can pick real values. The sample is not saved with the label.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {names.map((n) => (
            <label key={n} className="flex flex-col gap-0.5 text-xs text-slate-600">
              <span>{source.variables?.[n]?.label || n}</span>
              <input
                className={`${inputCls} w-36`}
                value={testValues[n] ?? source.variables?.[n]?.default ?? ''}
                onChange={(e) => setTestValues({ ...testValues, [n]: e.target.value })}
              />
            </label>
          ))}
          {source.bearerAuth && (
            <label className="flex flex-col gap-0.5 text-xs text-slate-600">
              <span>Access token</span>
              <input
                type="password"
                autoComplete="off"
                className={`${inputCls} w-44`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          )}
          <button type="button" className={btnCls} disabled={fetching || urlProblems.length > 0} onClick={onFetch}>
            {fetching ? 'Fetching…' : 'Fetch sample'}
          </button>
        </div>

        {problem && (
          <p role="alert" className="break-words rounded-lg bg-red-50 p-2 text-xs text-red-700 ring-1 ring-red-200">
            {problem}
          </p>
        )}
        {sample && (
          <div className="space-y-2">
            <p role="status" className="text-xs text-emerald-800">
              {sample.length} {sample.length === 1 ? 'record' : 'records'} found. The first one:
            </p>
            <pre className="max-h-48 overflow-auto rounded-md bg-slate-900 p-2 text-xs text-slate-100">
              {JSON.stringify(sample[0], null, 2)}
            </pre>
            {paths.length > 0 && (
              <p className="text-xs text-slate-600">
                Paths you can use in a field:{' '}
                {paths.map((p) => (
                  <code
                    key={p}
                    className="mr-1 inline-block rounded bg-white px-1 py-0.5 text-slate-800 ring-1 ring-slate-200"
                  >
                    {p}
                  </code>
                ))}
              </p>
            )}
          </div>
        )}
      </section>

      {!usedByFields && (
        <p className="text-xs text-amber-700">
          No field reads the API yet. In the Fields tab, choose “{'A value from the API response'}” for a field.
        </p>
      )}

      <button
        type="button"
        className={btnCls}
        disabled={locked}
        onClick={() => {
          onSample(null);
          onChange(undefined);
        }}
      >
        Stop using an API
      </button>
    </div>
  );
}
