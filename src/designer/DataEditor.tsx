import type { Template } from '@pdfme/common';
import { useMemo, useState } from 'react';
import { leafPaths, readPath } from '../generator/apiSource';
import { barcodeProblem } from '../generator/barcodeCheck';
import { sampleField, validateSpec } from '../generator/engine';
import { defaultPreviewValues, type PreviewValues, usableValues } from '../generator/previewInputs';
import { dataFields, orphanRules, type TemplateField, templateFields } from '../generator/scaffold';
import type { FieldRule, GeneratorSpec } from '../generator/spec';
import { KIND_LABELS, RuleRow } from './RuleEditor';
import TableEditor from './TableEditor';
import TestApiSection from './TestApiSection';
import { tabListKeyDown } from './tabKeys';

const btnCls = 'btn btn-secondary';
const PANES = ['fields', 'tables'] as const;

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
  /** Records fetched by the "Test with a real API" section, used to preview. Never saved. */
  sample?: unknown[] | null;
  onSample: (records: unknown[] | null) => void;
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
  onSample,
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
    <div className="flex min-w-0 flex-1 flex-col bg-white/70 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-lead font-semibold text-slate-800">Data</h2>
        <div
          role="tablist"
          aria-label="Data sections"
          className="flex items-center gap-1"
          onKeyDown={(e) => tabListKeyDown(e, PANES, pane, setPane)}
        >
          {PANES.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`data-tab-${id}`}
              aria-selected={pane === id}
              aria-controls={`data-pane-${id}`}
              tabIndex={pane === id ? 0 : -1}
              className="tab"
              onClick={() => setPane(id)}
            >
              {id === 'fields' ? 'Fields' : 'Tables'}
            </button>
          ))}
        </div>
        {/* Preview first: it is what you came here to check. The placeholder buttons are a
            maintenance action and sit at the quieter end. */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn btn-primary btn-sm" onClick={onPreview}>
            Preview label
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onPreviewValues(defaultPreviewValues(template, typed))}
          >
            Fill with placeholders
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={Object.keys(typed).length === 0}
            onClick={() => onPreviewValues({})}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSampleTick((t) => t + 1)}
            title="Generate the values afresh, the way a new print would"
          >
            New sample
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <div
          role="alert"
          className="mb-3 space-y-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-body text-red-700"
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
        <p className="card-quiet mb-3 px-3 py-2 text-body text-slate-600">
          This is a built-in label, so its data rules ship with the app and cannot be changed here. Use{' '}
          <strong>Duplicate</strong> above to get a copy you can edit, layout and data alike.
        </p>
      )}

      {pane === 'fields' && (
        <div role="tabpanel" id="data-pane-fields" aria-labelledby="data-tab-fields" className="min-w-0 space-y-2">
          <TestApiSection sample={sample} onSample={onSample} />
          {fields.length === 0 && (
            <p className="text-body text-slate-500">
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
            const previewed = typed[field.name] !== undefined;
            return (
              <details
                key={field.name}
                className="group card transition-colors open:border-indigo-200 hover:border-slate-300"
              >
                {/* Name and sample on the left, status on the right, capped at a readable width.
                    The value used to sit hard against the far edge with a hand's width of dead
                    space after it, which meant the eye had to cross the screen to pair them. */}
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                  <span className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-slate-400 transition-transform group-open:rotate-90"
                    >
                      ▶
                    </span>
                    <code className="field-chip break-all">{field.name}</code>
                    <span className="shrink-0 text-label text-slate-500">{field.type}</span>
                    {rule && !previewed && (
                      <span className="badge badge-accent shrink-0">{KIND_LABELS[rule.kind]}</span>
                    )}
                    {previewed && <span className="badge badge-neutral shrink-0">placeholder</span>}
                    {!rule && <span className="badge badge-warn shrink-0">prints its own text</span>}
                  </span>

                  <span className="flex min-w-0 max-w-full items-center gap-2">
                    {barcodeError && (
                      <span className="badge badge-danger-soft whitespace-normal">✕ {barcodeError}</span>
                    )}
                    {fieldProblems.length > 0 && <span className="badge badge-danger-soft">problem</span>}
                    <span className="min-w-0 max-w-56 truncate font-mono text-label text-slate-600">
                      {value || '—'}
                    </span>
                  </span>
                </summary>

                {/* Two columns when the *panel* is wide enough, one when it is not — a container query, so
                    it follows the Designer's width and not the window's. Everything is a label above its
                    control, which is what stopped "Fill with" wrapping onto three lines. */}
                <div className="@container border-t border-slate-100">
                  <div className="grid gap-4 px-3 py-3 @xl:grid-cols-2">
                    <div className="min-w-0 space-y-2">
                      <RuleRow
                        rule={rule}
                        spec={spec}
                        fieldNames={allNames}
                        samplePaths={samplePaths}
                        locked={locked}
                        onChange={(next) => setRule(field.name, next)}
                      />
                      {barcode && field.hint && <p className="field-hint">{field.hint}</p>}
                      {pathProblem && <p className="field-hint text-amber-700">{pathProblem}</p>}
                      {fieldProblems.length > 0 && (
                        <ul className="list-inside list-disc text-label text-red-700">
                          {fieldProblems.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      )}
                      {rule && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={locked}
                          onClick={() => setRule(field.name, null)}
                        >
                          Remove this rule
                        </button>
                      )}
                    </div>

                    <div className="min-w-0">
                      <label className="field-label" htmlFor={`preview-${field.name}`}>
                        Preview value
                      </label>
                      <input
                        id={`preview-${field.name}`}
                        type="text"
                        aria-label={`Preview value for ${field.name}`}
                        className="field font-mono"
                        value={typed[field.name] ?? ''}
                        placeholder="leave empty to generate one"
                        onChange={(e) => setTyped(field.name, e.target.value)}
                      />
                      <p className="field-hint">
                        Only used by the preview, never printed. Saved with this label, so the preview looks the same
                        next time.
                      </p>
                    </div>
                  </div>
                </div>
              </details>
            );
          })}

          {orphans.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
              <h3 className="text-body font-semibold text-amber-900">Rules for fields that are gone</h3>
              <p className="mt-1 text-body text-amber-800">
                A field was renamed or deleted in the Layout. These rules are kept until you move or remove them, so the
                work is not lost.
              </p>
              <ul className="mt-2 space-y-2">
                {orphans.map((name) => (
                  <li key={name} className="flex flex-wrap items-center gap-2 text-body">
                    <code className="field-chip bg-white/70 break-all">{name}</code>
                    <label className="flex items-center gap-2">
                      <span className="text-amber-800">Move to</span>
                      <select
                        className="field w-auto"
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
                    <button
                      type="button"
                      className={`${btnCls} btn-sm`}
                      disabled={locked}
                      onClick={() => dropRule(name)}
                    >
                      Delete rule
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {pane === 'tables' && (
        <div role="tabpanel" id="data-pane-tables" aria-labelledby="data-tab-tables" className="min-w-0">
          <TableEditor spec={spec} onChange={onChange} readOnly={locked} />
        </div>
      )}
    </div>
  );
}
