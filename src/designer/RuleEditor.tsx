import type { FieldRule, GeneratorSpec, IntFormat, Transform } from '../generator/spec';
import { asFieldRule, RULE_KINDS } from '../generator/spec';

/** One sentence per rule kind, so the picker explains itself. */
export const KIND_LABELS: Record<(typeof RULE_KINDS)[number], string> = {
  fixed: 'Fixed text',
  digits: 'Random digits',
  int: 'Whole number',
  pick: 'Pick from a list',
  table: 'From a table',
  date: 'A date',
  pattern: 'Pattern',
  sequence: 'Numbering',
  copy: 'Copy another field',
  api: 'A value from the API response',
};

const base =
  'rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none ' +
  'focus:ring-1 focus:ring-indigo-200';
const inputCls = `${base} w-full min-w-0`;
const narrowCls = `${base} w-20`;

export function defaultRule(kind: FieldRule['kind'], tables: GeneratorSpec['tables']): FieldRule {
  const firstTable = Object.keys(tables ?? {})[0];
  switch (kind) {
    case 'fixed':
      return { kind: 'fixed', value: '' };
    case 'digits':
      return { kind: 'digits', length: 12 };
    case 'int':
      return { kind: 'int', min: 0, max: 100, step: 1, format: 'plain' };
    case 'pick':
      return { kind: 'pick', values: ['one', 'two'] };
    case 'table':
      return firstTable
        ? { kind: 'table', table: firstTable, column: tables![firstTable].columns[0] ?? '' }
        : { kind: 'pick', values: ['one', 'two'] };
    case 'date':
      return { kind: 'date', offsetDays: [0, 0], format: 'YYYY-MM-DD' };
    case 'pattern':
      return { kind: 'pattern', pattern: '{d8}' };
    case 'sequence':
      return { kind: 'sequence', start: 1, step: 1, pad: 0 };
    case 'copy':
      return { kind: 'copy', from: '' };
    case 'api':
      return { kind: 'api', path: '' };
    default:
      return { kind: 'fixed', value: '' };
  }
}

const Num = ({
  label,
  value,
  onChange,
  min = 0,
  max,
  width,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  width?: string;
}) => (
  <label className="flex items-center gap-1 text-xs text-slate-600">
    <span className="whitespace-nowrap">{label}</span>
    <input
      type="number"
      aria-label={label}
      className={width === 'wide' ? inputCls : narrowCls}
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      onChange={(e) => onChange(+e.target.value)}
    />
  </label>
);

/**
 * The parameters of one rule. `rule` is replaced wholesale by `onChange`, so the caller keeps one
 * source of truth and the sample shown next to it is always the rule that will be saved.
 */
export default function RuleEditor({
  rule,
  spec,
  fieldNames,
  samplePaths = [],
  onChange,
}: {
  rule: FieldRule;
  spec: GeneratorSpec;
  fieldNames: string[];
  /** Paths found in a fetched sample, offered as suggestions for an `api` rule. */
  samplePaths?: string[];
  onChange: (next: FieldRule) => void;
}) {
  const tables = spec.tables ?? {};
  const tableNames = Object.keys(tables);
  // Changing the prefix/suffix/transforms must not lose the kind-specific part of the rule.
  const set = (patch: Partial<FieldRule>) => onChange({ ...rule, ...patch } as FieldRule);

  const common = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <label className="flex items-center gap-1">
        <span>Before</span>
        <input
          aria-label="Text before the value"
          className={`${inputCls} w-24`}
          value={rule.prefix ?? ''}
          onChange={(e) => set({ prefix: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-1">
        <span>After</span>
        <input
          aria-label="Text after the value"
          className={`${inputCls} w-24`}
          value={rule.suffix ?? ''}
          onChange={(e) => set({ suffix: e.target.value })}
        />
      </label>
      <span className="flex items-center gap-1">
        Then
        {(['digits-only', 'upper', 'lower'] as Transform[]).map((t) => (
          <label key={t} className="flex items-center gap-0.5">
            <input
              type="checkbox"
              checked={(rule.transforms ?? []).includes(t)}
              onChange={(e) => {
                const current = rule.transforms ?? [];
                const next = e.target.checked ? [...current, t] : current.filter((x) => x !== t);
                set({ transforms: next.length ? next : undefined });
              }}
            />
            <span>{t === 'digits-only' ? 'digits only' : t}</span>
          </label>
        ))}
      </span>
    </div>
  );

  let params: React.ReactNode = null;
  switch (rule.kind) {
    case 'fixed':
      params = (
        <label className="block text-xs text-slate-600">
          <span className="mb-1 block">Text to print</span>
          <input
            aria-label="Fixed text"
            className={inputCls}
            value={rule.value}
            onChange={(e) => set({ value: e.target.value })}
          />
        </label>
      );
      break;

    case 'digits':
      params = <Num label="Digits" value={rule.length} min={1} onChange={(length) => set({ length })} />;
      break;

    case 'int':
      params = (
        <div className="flex flex-wrap items-center gap-2">
          <Num label="From" value={rule.min} onChange={(min) => set({ min })} />
          <Num label="To" value={rule.max} onChange={(max) => set({ max })} />
          <Num label="Step" value={rule.step ?? 1} min={1} onChange={(step) => set({ step })} />
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span>As</span>
            <select
              aria-label="Number format"
              className={`${inputCls} w-auto`}
              value={rule.format ?? 'plain'}
              onChange={(e) => set({ format: e.target.value as IntFormat })}
            >
              <option value="plain">1234</option>
              <option value="thousands">1,234</option>
              <option value="yen">¥1,234</option>
            </select>
          </label>
        </div>
      );
      break;

    case 'pick':
      params = (
        <label className="block text-xs text-slate-600">
          <span className="mb-1 block">One per line</span>
          <textarea
            aria-label="Values to pick from"
            rows={3}
            className={`${inputCls} font-mono text-xs`}
            value={rule.values.join('\n')}
            onChange={(e) => set({ values: e.target.value.split('\n').filter((v) => v.length > 0) })}
          />
        </label>
      );
      break;

    case 'table':
      params =
        tableNames.length === 0 ? (
          <p className="text-xs text-amber-700">Add a table below first, then pick a column here.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <span>Table</span>
              <select
                aria-label="Table"
                className={`${inputCls} w-auto`}
                value={rule.table}
                onChange={(e) => {
                  const table = tables[e.target.value];
                  set({ table: e.target.value, column: table?.columns[0] ?? '' });
                }}
              >
                {tableNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <span>Column</span>
              <select
                aria-label="Column"
                className={`${inputCls} w-auto`}
                value={rule.column}
                onChange={(e) => set({ column: e.target.value })}
              >
                {(tables[rule.table]?.columns ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-slate-500">Fields reading the same table get the same row on a page.</span>
          </div>
        );
      break;

    case 'date':
      params = (
        <div className="flex flex-wrap items-center gap-2">
          <Num
            label="Days from today"
            value={rule.offsetDays?.[0] ?? 0}
            onChange={(from) => set({ offsetDays: [from, rule.offsetDays[1]] })}
          />
          <Num
            label="to"
            value={rule.offsetDays?.[1] ?? 0}
            onChange={(to) => set({ offsetDays: [rule.offsetDays[0], to] })}
          />
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span>Format</span>
            <input
              aria-label="Date format"
              className={`${inputCls} w-32 font-mono`}
              value={rule.format}
              onChange={(e) => set({ format: e.target.value })}
            />
          </label>
          <span className="text-xs text-slate-500">YYYY MM DD, for example.</span>
        </div>
      );
      break;

    case 'pattern':
      params = (
        <label className="block text-xs text-slate-600">
          <span className="mb-1 block">{`Anything else is printed as typed. {d3} digits, {D2} A-Z, {L2} a-z.`}</span>
          <input
            aria-label="Pattern"
            className={`${inputCls} font-mono`}
            value={rule.pattern}
            onChange={(e) => set({ pattern: e.target.value })}
          />
        </label>
      );
      break;

    case 'sequence':
      params = (
        <div className="flex flex-wrap items-center gap-2">
          <Num label="Start" value={rule.start} min={0} onChange={(start) => set({ start })} />
          <Num label="Step" value={rule.step ?? 1} min={1} onChange={(step) => set({ step })} />
          <Num label="Pad to" value={rule.pad ?? 0} min={0} max={20} onChange={(pad) => set({ pad })} />
          <span className="text-xs text-slate-500">Counts up per page, starting again on every print job.</span>
        </div>
      );
      break;

    case 'copy':
      params = (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span>From</span>
            <select
              aria-label="Field to copy"
              className={`${inputCls} w-auto`}
              value={rule.from}
              onChange={(e) => set({ from: e.target.value })}
            >
              <option value="">Choose a field…</option>
              {fieldNames
                .filter((n) => n !== '')
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <span>Rebuild as</span>
            <input
              aria-label="Pattern to rebuild the copied value"
              className={`${inputCls} w-40 font-mono`}
              placeholder="{from}-{d1}-{d2}"
              value={rule.pattern ?? ''}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
            />
          </label>
          <span className="text-xs text-slate-500">{`{from} is the copied value.`}</span>
        </div>
      );
      break;

    case 'api':
      params = (
        <label className="block text-xs text-slate-600">
          <span className="mb-1 block">
            Path in each record, such as user.name or items[0].id.
            {samplePaths.length === 0 && ' Fetch a sample in the Source tab to pick from the real paths.'}
          </span>
          <input
            aria-label="Path in the API record"
            list="api-sample-paths"
            className={`${inputCls} font-mono`}
            value={rule.path}
            onChange={(e) => set({ path: e.target.value })}
          />
          <datalist id="api-sample-paths">
            {samplePaths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
      );
      break;

    default:
      params = null;
  }

  return (
    <div className="space-y-2">
      {params}
      {common}
    </div>
  );
}

/** The rule picker plus its parameters, for one field. */
export function RuleRow({
  rule,
  spec,
  fieldNames,
  samplePaths,
  onChange,
  locked,
  hasApi = true,
}: {
  rule: FieldRule | null;
  spec: GeneratorSpec;
  fieldNames: string[];
  samplePaths?: string[];
  onChange: (next: FieldRule | null) => void;
  /** Show the rule but do not let it be changed. */
  locked?: boolean;
  /**
   * Offer the `api` kind. A label can map a field to a record path whether or not anything has been
   * fetched, because the address is given at print time rather than stored with the label.
   */
  hasApi?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <span>Fill with</span>
          <select
            aria-label="Rule"
            disabled={locked}
            className={`${inputCls} w-auto`}
            value={rule?.kind ?? ''}
            onChange={(e) =>
              onChange(e.target.value ? defaultRule(e.target.value as FieldRule['kind'], spec.tables) : null)
            }
          >
            <option value="">— nothing, print the text as designed —</option>
            {/* `api` needs a data source to read from, so it is offered once the label has one (or already uses it). */}
            {RULE_KINDS.filter((k) => k !== 'api' || hasApi || rule?.kind === 'api').map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rule && asFieldRule(rule) && (
        // A locked rule still shows its settings, so it can be read and copied into a duplicate.
        <fieldset disabled={locked} className="contents">
          <RuleEditor rule={rule} spec={spec} fieldNames={fieldNames} samplePaths={samplePaths} onChange={onChange} />
        </fieldset>
      )}
    </div>
  );
}
