import { useId } from 'react';
import type { FieldRule, GeneratorSpec, IntFormat, Transform } from '../generator/spec';
import { asFieldRule, type RULE_KINDS } from '../generator/spec';

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

/**
 * How the picker groups the kinds, in the order shown. Real data comes first because it is what a
 * label that prints from a system wants; the rest are ways of making values up. Every kind belongs
 * to exactly one group (a test checks that), so adding a kind to RULE_KINDS cannot leave it unlisted.
 */
export const RULE_GROUPS: { label: string; kinds: (typeof RULE_KINDS)[number][] }[] = [
  { label: 'Real data', kinds: ['api'] },
  { label: 'Random data', kinds: ['digits', 'int', 'pick', 'table', 'date', 'pattern'] },
  { label: 'Fixed or numbered', kinds: ['fixed', 'sequence'] },
  { label: 'From another field', kinds: ['copy'] },
];

// Every control in the Designer is 36px tall with a 8px radius, so a row of them lines up. The
// shape itself lives in index.css; these two aliases just keep the JSX short.
const inputCls = 'field';
const narrowCls = 'field w-20 text-center';
// The shared row for a rule's parameters: labels sit above their controls, so the controls are
// bottom-aligned and line up whatever the label wraps to; a hint goes on a line of its own below.
const rowCls = 'flex flex-wrap items-end gap-x-3 gap-y-2';

function Params({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div>
      <div className={rowCls}>{children}</div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

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
  <label className="block">
    <span className="field-label">{label}</span>
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
  // Several fields can be open at once, so nothing here may use a fixed id: each rule editor gets its
  // own, and a label always points at the input beside it rather than at the first one on the page.
  const uid = useId();
  const tables = spec.tables ?? {};
  const tableNames = Object.keys(tables);
  // Changing the prefix/suffix/transforms must not lose the kind-specific part of the rule.
  const set = (patch: Partial<FieldRule>) => onChange({ ...rule, ...patch } as FieldRule);

  /* A titled group, because these three apply to every rule kind and sit under the rule's own
     settings. Each label is above its control, and the transforms become toggles rather than
     tiny checkboxes with 11px text. */
  const common = (
    <fieldset className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <legend className="px-1 text-label font-semibold text-slate-500">Around the value</legend>
      <div className="@container">
        <div className="grid gap-3 @sm:grid-cols-2">
          <div className="min-w-0">
            <label className="field-label" htmlFor={`${uid}-prefix`}>
              Before
            </label>
            <input
              id={`${uid}-prefix`}
              aria-label="Text before the value"
              className={inputCls}
              value={rule.prefix ?? ''}
              onChange={(e) => set({ prefix: e.target.value })}
            />
          </div>
          <div className="min-w-0">
            <label className="field-label" htmlFor={`${uid}-suffix`}>
              After
            </label>
            <input
              id={`${uid}-suffix`}
              aria-label="Text after the value"
              className={inputCls}
              value={rule.suffix ?? ''}
              onChange={(e) => set({ suffix: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="mt-3">
        <span className="field-label">Then</span>
        <div className="flex flex-wrap gap-1.5">
          {(['digits-only', 'upper', 'lower'] as Transform[]).map((t) => {
            const on = (rule.transforms ?? []).includes(t);
            return (
              <label
                key={t}
                className={
                  'pill flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-label font-medium transition ' +
                  (on
                    ? 'border-indigo-300 bg-indigo-100 text-indigo-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400')
                }
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  onChange={(e) => {
                    const current = rule.transforms ?? [];
                    const next = e.target.checked ? [...current, t] : current.filter((x) => x !== t);
                    set({ transforms: next.length ? next : undefined });
                  }}
                />
                {t === 'digits-only' ? 'digits only' : t}
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );

  let params: React.ReactNode = null;
  switch (rule.kind) {
    case 'fixed':
      params = (
        <label className="block">
          <span className="field-label">Text to print</span>
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
        <Params>
          <Num label="From" value={rule.min} onChange={(min) => set({ min })} />
          <Num label="To" value={rule.max} onChange={(max) => set({ max })} />
          <Num label="Step" value={rule.step ?? 1} min={1} onChange={(step) => set({ step })} />
          <label className="block">
            <span className="field-label">As</span>
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
        </Params>
      );
      break;

    case 'pick':
      params = (
        <label className="block">
          <span className="field-label">One per line</span>
          <textarea
            aria-label="Values to pick from"
            rows={3}
            className={`${inputCls} font-mono`}
            value={rule.values.join('\n')}
            onChange={(e) => set({ values: e.target.value.split('\n').filter((v) => v.length > 0) })}
          />
        </label>
      );
      break;

    case 'table':
      params =
        tableNames.length === 0 ? (
          <p className="field-hint text-amber-700">Add a table below first, then pick a column here.</p>
        ) : (
          <Params hint="Fields reading the same table get the same row on a page.">
            <label className="block">
              <span className="field-label">Table</span>
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
            <label className="block">
              <span className="field-label">Column</span>
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
          </Params>
        );
      break;

    case 'date':
      params = (
        <Params hint="YYYY MM DD, for example.">
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
          <label className="block">
            <span className="field-label">Format</span>
            <input
              aria-label="Date format"
              className={`${inputCls} w-32 font-mono`}
              value={rule.format}
              onChange={(e) => set({ format: e.target.value })}
            />
          </label>
        </Params>
      );
      break;

    case 'pattern':
      params = (
        <label className="block">
          <span className="field-label">{`Anything else is printed as typed. {d3} digits, {D2} A-Z, {L2} a-z.`}</span>
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
        <Params hint="Counts up per page, starting again on every print job.">
          <Num label="Start" value={rule.start} min={0} onChange={(start) => set({ start })} />
          <Num label="Step" value={rule.step ?? 1} min={1} onChange={(step) => set({ step })} />
          <Num label="Pad to" value={rule.pad ?? 0} min={0} max={20} onChange={(pad) => set({ pad })} />
        </Params>
      );
      break;

    case 'copy':
      params = (
        <Params hint={`{from} is the copied value.`}>
          <label className="block">
            <span className="field-label">From</span>
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
          <label className="block">
            <span className="field-label">Rebuild as</span>
            <input
              aria-label="Pattern to rebuild the copied value"
              className={`${inputCls} w-40 font-mono`}
              placeholder="{from}-{d1}-{d2}"
              value={rule.pattern ?? ''}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
            />
          </label>
        </Params>
      );
      break;

    case 'api':
      params = (
        <label className="block">
          <span className="field-label">
            Path in each record, such as user.name or items[0].id.
            {samplePaths.length === 0 && ' Fetch a sample in the Source tab to pick from the real paths.'}
          </span>
          <input
            aria-label="Path in the API record"
            list={`${uid}-paths`}
            className={`${inputCls} font-mono`}
            value={rule.path}
            onChange={(e) => set({ path: e.target.value })}
          />
          <datalist id={`${uid}-paths`}>
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
  const kindId = `${useId()}-kind`;
  return (
    <div className="space-y-3">
      {/* The label sits above its control rather than beside it. Sharing one flex row is what
          made "Fill with" wrap onto three lines on a phone. */}
      <div>
        <label className="field-label" htmlFor={kindId}>
          Fill this field with
        </label>
        <select
          id={kindId}
          aria-label="Rule"
          disabled={locked}
          className={inputCls}
          value={rule?.kind ?? ''}
          onChange={(e) =>
            onChange(e.target.value ? defaultRule(e.target.value as FieldRule['kind'], spec.tables) : null)
          }
        >
          <option value="">— nothing, print the text as designed —</option>
          {/* The API kind is offered whether or not anything has been fetched, unless the caller turns it
              off; a group with nothing left in it is not drawn. */}
          {RULE_GROUPS.map((group) => {
            const kinds = group.kinds.filter((k) => k !== 'api' || hasApi || rule?.kind === 'api');
            if (kinds.length === 0) return null;
            return (
              <optgroup key={group.label} label={group.label}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
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
