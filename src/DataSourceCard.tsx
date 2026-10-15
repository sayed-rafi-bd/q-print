import { useEffect, useRef, useState } from 'react';
import { fetchRecords } from './apiClient';
import { buildUrl, normalizeUrl, urlVariables } from './generator/apiSource';
import { LIMITS } from './generator/engine';
import { MOCK_HOST } from './generator/mockApi';
import { startingValues } from './printRows';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100';

export type ApiState = {
  url: string;
  listPath: string;
  bearerAuth: boolean;
  values: Record<string, string>;
  token: string;
};

/** An empty one, so the print screen starts from nothing rather than from a stored address. */
export const emptyApi: ApiState = { url: '', listPath: '', bearerAuth: false, values: {}, token: '' };

/** The address as it will be called, with the host split out so it can be shown in bold. */
export function resolvedAddress(url: string, values: Record<string, string>): { host: string; rest: string } {
  let text: string;
  try {
    text = buildUrl(url, values);
  } catch {
    // Not every variable has a value yet: show the pattern with what is filled in so far.
    text = normalizeUrl(url).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
      (values[name] ?? '').trim() ? encodeURIComponent(values[name].trim()) : whole,
    );
  }
  const match = /^(https?:\/\/)([^/?#]*)(.*)$/i.exec(text);
  if (!match) return { host: '', rest: text };
  return { host: match[2], rest: `${match[1]}${match[2]}${match[3]}` };
}

export type CheckState = { records: number } | null;

/**
 * The "Data source" card of the Print tab: the address to read from, the values its variables ask
 * for, the access token, and a **Check data** button.
 *
 * The address is typed here and kept nowhere else. That is the point: it is not part of the label,
 * so no label can send a request to a host the person did not just choose, and the resolved address
 * is always on screen. The token is only ever held by the parent's React state.
 */
export default function DataSourceCard({
  api,
  onChange,
  remembered,
  copies,
  checked: providedChecked,
  onChecked,
  onRecords,
  variant = 'full',
  disabled,
}: {
  api: ApiState;
  onChange: (next: ApiState) => void;
  /**
   * Values typed for this label last time. The address itself is never remembered, so these cannot
   * be offered until the address is typed — at which point the variables it names are known.
   */
  remembered: Record<string, string>;
  /** Copies of each record, so the status can show the page total. */
  copies: number;
  /**
   * Left out, the card keeps its own check result. The Print tab passes one in so it can disable
   * Print until the data has been looked at; the Designer does not, because its check is only a test.
   */
  checked?: CheckState;
  onChecked?: (state: CheckState) => void;
  /** Given the records too, so the Designer can preview with them. Not used by the Print tab. */
  onRecords?: (records: unknown[]) => void;
  /**
   * `full` for the Print tab. `compact` when it is nested inside something that already explains
   * itself: the Designer's "Test with a real API" panel, where a second heading and a second
   * paragraph saying the same thing read as noise.
   */
  variant?: 'full' | 'compact';
  disabled?: boolean;
}) {
  const names = urlVariables(api.url);
  const address = resolvedAddress(api.url, api.values);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');
  const [first, setFirst] = useState('');
  const [ownChecked, setOwnChecked] = useState<CheckState>(null);
  // The Print tab owns the result, because it gates printing on it; otherwise this card does.
  // `onChecked` in the deps because `report` is not stable and the effect below re-runs on it.
  const checked = onChecked ? (providedChecked ?? null) : ownChecked;
  const report = (state: CheckState) => (onChecked ? onChecked(state) : setOwnChecked(state));
  // A late answer must not land on a different address or edited values: every check takes a number
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
    report(null);
  };

  const set = (patch: Partial<ApiState>) => {
    reset();
    onChange({ ...api, ...patch });
  };

  const onCheck = async () => {
    const me = ++run.current;
    setChecking(true);
    setProblem('');
    setFirst('');
    report(null);
    try {
      const records = await fetchRecords(
        { url: api.url, listPath: api.listPath || undefined, bearerAuth: api.bearerAuth },
        api.values,
        api.token,
      );
      if (me !== run.current) return;
      setFirst(JSON.stringify(records[0], null, 2));
      report({ records: records.length });
      onRecords?.(records);
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
      {variant === 'full' && (
        <>
          <h2 className="text-lead font-semibold text-slate-800">Data source</h2>
          <p className="field-hint">
            This label reads its fields from a web API. Type the address to use — it is not saved with the label.
          </p>
        </>
      )}

      <div className="space-y-1">
        <label htmlFor="api-url" className="text-sm font-medium text-slate-700">
          Address
        </label>
        <input
          id="api-url"
          type="text"
          required
          spellCheck={false}
          autoComplete="off"
          className={inputCls}
          placeholder="api.example.com/orders/{orderId}"
          value={api.url}
          disabled={disabled}
          onChange={(e) => set({ url: e.target.value, values: startingValues(e.target.value, remembered) })}
        />
      </div>

      {names.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {names.map((name) => (
            <div key={name} className="space-y-1">
              <label htmlFor={`var-${name}`} className="text-sm font-medium text-slate-700">
                {name}
              </label>
              <input
                id={`var-${name}`}
                type="text"
                required
                className={inputCls}
                value={api.values[name] ?? ''}
                disabled={disabled}
                onChange={(e) => set({ values: { ...api.values, [name]: e.target.value } })}
              />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="api-list-path" className="text-sm font-medium text-slate-700">
          Where the list is in the response
        </label>
        <input
          id="api-list-path"
          type="text"
          spellCheck={false}
          autoComplete="off"
          className={inputCls}
          placeholder="leave empty if the response is the list"
          value={api.listPath}
          disabled={disabled}
          onChange={(e) => set({ listPath: e.target.value })}
        />
        <p className="text-xs text-slate-500">Dot-separated, e.g. data.items. Empty uses the whole response.</p>
      </div>

      <p className="break-all text-xs text-slate-600" data-testid="resolved-url">
        <span className="text-slate-500">Will call: </span>
        {address.host ? <strong className="font-semibold text-slate-900">{address.rest}</strong> : address.rest}
      </p>

      {address.host === MOCK_HOST && (
        <p className="text-xs text-slate-500" data-testid="mock-note">
          Sample data made inside the app. Nothing is sent over the network.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          checked={api.bearerAuth}
          disabled={disabled}
          onChange={(e) => set({ bearerAuth: e.target.checked })}
        />
        Send an access token
      </label>

      {api.bearerAuth && (
        <div className="space-y-1">
          <label htmlFor="source-token" className="text-sm font-medium text-slate-700">
            Access token
          </label>
          <input
            id="source-token"
            type="password"
            autoComplete="off"
            className={inputCls}
            value={api.token}
            disabled={disabled}
            onChange={(e) => set({ token: e.target.value })}
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
