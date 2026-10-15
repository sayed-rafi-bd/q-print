import type { Template } from '@pdfme/common';
import { useMemo, useState } from 'react';
import { leafPaths, readPath } from '../generator/apiSource';
import { barcodeProblem } from '../generator/barcodeCheck';
import { sampleField, validateSpec } from '../generator/engine';
import { defaultPreviewValues, type PreviewValues, usableValues } from '../generator/previewInputs';
import { dataFields, orphanRules, type TemplateField, templateFields } from '../generator/scaffold';
import type { FieldRule, GeneratorSpec } from '../generator/spec';
import { RuleRow } from './RuleEditor';
import TableEditor from './TableEditor';

const btnCls =
  'cursor-pointer rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 ' +
  'transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const tabCls = (on: boolean) =>
  'cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition ' +
  (on ? 'bg-indigo-500 text-white' : 'text-slate-500 hover:bg-indigo-100');

type Props = {
  template: Template;
  spec: GeneratorSpec;
  onChange: (next: GeneratorSpec) => void;
  /** Opens the label preview with the data as it stands now. */
  onPreview: () => void;
  /**
   * A built-in label keeps only its layout on disk; its generator lives in the app, so edits here
   * would be thrown away on save. Duplicate the label to get an editable copy.
   */
  readOnly?: boolean;
  /** Records fetched from the label's API in the Source pane, kept by the designer. Never saved. */
  sample?: unknown[] | null;
  /** Switches the designer to its Source tab, where the API address is set. */
  onOpenSource?: () => void;
  /**
   * Placeholder values typed here to see the label previewed, and how to change them. They are saved
   * with the label and only ever seen on screen: a print job builds its data from the real records.
   */
  previewValues: PreviewValues;
  onPreviewValues: (next: PreviewValues) => void;
};

/**
 * The Data tab: one rule per template field, what it will print, and the tables rules can read.
 *
 * This is deliberately a fixed set of rule kinds rather than a small language, so what a label
 * prints is always something the screen shows before saving.
 */
export default function DataEditor({
  template,
  spec,
  onChange,
  onPreview,
  readOnly,
  sample = null,
  onOpenSource,
  previewValues,
  onPreviewValues,
}: Props) {
  const [pane, setPane] = useState<'fields' | 'tables'>('fields');
  const [sampleTick, setSampleTick] = useState(0);

  const fields = useMemo(() => dataFields(template), [template]);
  const allNames = useMemo(() => templateFields(template).map((f) => f.name), [template]);
  const orphans = useMemo(() => orphanRules(template, spec), [template, spec]);
  const problems = useMemo(() => validateSpec(spec), [spec]);
  // Entries for fields that no longer exist are ignored, so a renamed field starts clean.
  const typed = useMemo(() => usableValues(template, previewValues), [template, previewValues]);

  const locked = readOnly === true;

  const setRule = (name: string, rule: FieldRule | null) => {
    const fields = { ...spec.fields };
    if (rule) fields[name] = rule;
    else delete fields[name];
    onChange({ ...spec, fields });
  };

  const moveRule = (from: string, to: string) => {
    const fields = { ...spec.fields };
    const rule = fields[from];
    if (!rule) return;
    delete fields[from];
    fields[to] = rule;
    onChange({ ...spec, fields });
  };

  const dropRule = (name: string) => {
    const fields = { ...spec.fields };
    delete fields[name];
    onChange({ ...spec, fields });
  };

  const firstRecord = sample?.[0];
  const samplePaths = useMemo(() => (firstRecord === undefined ? [] : leafPaths(firstRecord)), [firstRecord]);

  /** Sets or clears one field's placeholder. Clearing it removes the entry, not sets it to "". */
  const setTyped = (name: string, value: string) => {
    const next = { ...typed };
    if (value === '') delete next[name];
    else next[name] = value;
    onPreviewValues(next);
  };

  const sampleFor = (field: TemplateField) => {
    // sampleTick makes "New sample" draw again from the same spec.
    void sampleTick;
    // An `api` field shows the real value from the fetched sample, else its path in ‹ ›.
    return sampleField(spec, field.name, { placeholders: true, record: firstRecord });
  };

  /** For an `api` rule with a fetched sample: what is wrong with its path, if anything. */
  const apiPathProblem = (rule: FieldRule | null): string | null => {
    if (rule?.kind !== 'api' || firstRecord === undefined || !rule.path.trim()) return null;
    try {
      readPath(firstRecord, rule.path);
      return null;
    } catch (e) {
      return e instanceof Error ? `${e.message} (checked against the first record of the sample)` : String(e);
    }
  };

  const problemsFor = (name: string) => problems.filter((p) => p.startsWith(`“${name}”`));

  return (
    <div className="flex h-full flex-col overflow-auto bg-white/70 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Data</h2>
        <button type="button" className={tabCls(pane === 'fields')} onClick={() => setPane('fields')}>
          Fields
        </button>
        <button type="button" className={tabCls(pane === 'tables')} onClick={() => setPane('tables')}>
          Tables
        </button>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button
            type="button"
            className={btnCls}
            onClick={() => onPreviewValues(defaultPreviewValues(template, typed))}
          >
            Fill with placeholders
          </button>
          <button
            type="button"
            className={btnCls}
            disabled={Object.keys(typed).length === 0}
            onClick={() => onPreviewValues({})}
          >
            Clear placeholders
          </button>
          <button type="button" className={btnCls} onClick={() => setSampleTick((t) => t + 1)}>
            New sample
          </button>
          <button type="button" className={btnCls} onClick={onPreview}>
            Preview label
          </button>
        </span>
      </div>

      {problems.length > 0 && (
        <div
          role="alert"
          className="mb-3 space-y-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <p className="font-medium">
            {problems.length === 1
              ? 'This generator has one problem:'
              : `This generator has ${problems.length} problems:`}
          </p>
          <ul className="list-inside list-disc">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {locked && (
        <p className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This is a built-in label, so its data rules ship with the app and cannot be changed here. Use{' '}
          <strong>Duplicate</strong> above to get a copy you can edit, layout and data alike.
        </p>
      )}

      {pane === 'fields' && (
        <div className="space-y-2">
          {!spec.source && onOpenSource && (
            <p className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
              To fill fields from a web API, set the address in the{' '}
              <button type="button" className="cursor-pointer font-semibold underline" onClick={onOpenSource}>
                Source tab
              </button>{' '}
              first.
            </p>
          )}
          {fields.length === 0 && (
            <p className="text-sm text-slate-500">
              This template has no fields that can take data. Add text or a barcode field in the Layout tab, and it will
              show up here.
            </p>
          )}

          {fields.map((field) => {
            const rule = spec.fields[field.name] ?? null;
            const value = sampleFor(field);
            const barcode = field.kind === 'barcode' || field.kind === 'qr';
            const barcodeError = barcode ? barcodeProblem(field.type, value) : null;
            const fieldProblems = problemsFor(field.name);
            const pathProblem = apiPathProblem(rule);
            return (
              <details key={field.name} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800">{field.name}</code>
                  <span className="text-xs text-slate-400">{field.type}</span>
                  {!rule && <span className="text-xs text-amber-700">prints its own text</span>}
                  <span className="ml-auto flex items-center gap-2">
                    {barcodeError && (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                        ✕ {barcodeError}
                      </span>
                    )}
                    <span className="max-w-56 truncate font-mono text-xs text-slate-600">{value || '—'}</span>
                  </span>
                </summary>

                <div className="mt-2 space-y-2">
                  {barcode && field.hint && <p className="text-xs text-slate-500">{field.hint}</p>}
                  <label className="block text-xs text-slate-600">
                    <span className="font-medium text-slate-700">Preview value</span>
                    <input
                      type="text"
                      aria-label={`Preview value for ${field.name}`}
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                      value={typed[field.name] ?? ''}
                      placeholder="leave empty to generate one"
                      onChange={(e) => setTyped(field.name, e.target.value)}
                    />
                    <span className="mt-1 block text-slate-500">
                      Only used by the preview, never printed. Saved with this label, so the preview looks the same next
                      time.
                    </span>
                  </label>
                  <RuleRow
                    rule={rule}
                    spec={spec}
                    fieldNames={allNames}
                    samplePaths={samplePaths}
                    locked={locked}
                    onChange={(next) => setRule(field.name, next)}
                  />
                  {pathProblem && <p className="text-xs text-amber-700">{pathProblem}</p>}
                  {fieldProblems.length > 0 && (
                    <ul className="list-inside list-disc text-xs text-red-700">
                      {fieldProblems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                  {rule && (
                    <button
                      type="button"
                      className={btnCls}
                      disabled={locked}
                      onClick={() => setRule(field.name, null)}
                    >
                      Remove this rule
                    </button>
                  )}
                </div>
              </details>
            );
          })}

          {orphans.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              <h3 className="text-sm font-semibold text-amber-900">Rules for fields that are gone</h3>
              <p className="mt-1 text-xs text-amber-800">
                A field was renamed or deleted in the Layout. These rules are kept until you move or remove them, so the
                work is not lost.
              </p>
              <ul className="mt-2 space-y-1">
                {orphans.map((name) => (
                  <li key={name} className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="rounded bg-white/70 px-1.5 py-0.5 text-slate-800">{name}</code>
                    <label className="flex items-center gap-1">
                      <span className="text-amber-800">Move to</span>
                      <select
                        className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                        value=""
                        disabled={locked}
                        onChange={(e) => e.target.value && moveRule(name, e.target.value)}
                      >
                        <option value="">Choose a field…</option>
                        {fields
                          .filter((f) => !spec.fields[f.name])
                          .map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button type="button" className={btnCls} disabled={locked} onClick={() => dropRule(name)}>
                      Delete rule
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {pane === 'tables' && <TableEditor spec={spec} onChange={onChange} readOnly={locked} />}
    </div>
  );
}
