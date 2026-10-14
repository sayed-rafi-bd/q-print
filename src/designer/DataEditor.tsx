import { useMemo, useState } from 'react';
import type { Template } from '@pdfme/common';
import type { FieldRule, GeneratorSpec } from '../generator/spec';
import { sampleField, validateSpec } from '../generator/engine';
import { barcodeProblem } from '../generator/barcodeCheck';
import { dataFields, orphanRules, templateFields, type TemplateField } from '../generator/scaffold';
import { RuleRow } from './RuleEditor';
import TableEditor from './TableEditor';

const btnCls =
  'cursor-pointer rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 ' +
  'transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
const tabCls = (on: boolean) =>
  'cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition '
  + (on ? 'bg-indigo-500 text-white' : 'text-slate-500 hover:bg-indigo-100');

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
};

/**
 * The Data tab: one rule per template field, what it will print, and the tables rules can read.
 *
 * This is deliberately a fixed set of rule kinds rather than a small language, so what a label
 * prints is always something the screen shows before saving.
 */
export default function DataEditor({ template, spec, onChange, onPreview, readOnly }: Props) {
  const [pane, setPane] = useState<'fields' | 'tables'>('fields');
  const [sampleTick, setSampleTick] = useState(0);

  const fields = useMemo(() => dataFields(template), [template]);
  const allNames = useMemo(() => templateFields(template).map(f => f.name), [template]);
  const orphans = useMemo(() => orphanRules(template, spec), [template, spec]);
  const problems = useMemo(() => validateSpec(spec), [spec]);

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

  const sampleFor = (field: TemplateField) => {
    // sampleTick makes "New sample" draw again from the same spec.
    void sampleTick;
    return sampleField(spec, field.name);
  };

  const problemsFor = (name: string) => problems.filter(p => p.startsWith(`“${name}”`));

  return (
    <div className="flex h-full flex-col overflow-auto bg-white/70 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Data</h2>
        <button className={tabCls(pane === 'fields')} onClick={() => setPane('fields')}>Fields</button>
        <button className={tabCls(pane === 'tables')} onClick={() => setPane('tables')}>Tables</button>
        <span className="ml-auto flex gap-1.5">
          <button className={btnCls} onClick={() => setSampleTick(t => t + 1)}>New sample</button>
          <button className={btnCls} onClick={onPreview}>Preview label</button>
        </span>
      </div>

      {problems.length > 0 && (
        <div role="alert" className="mb-3 space-y-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p className="font-medium">
            {problems.length === 1 ? 'This generator has one problem:' : `This generator has ${problems.length} problems:`}
          </p>
          <ul className="list-inside list-disc">
            {problems.map(p => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {locked && (
        <p className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This is a built-in label, so its data rules ship with the app and cannot be changed here.
          Use <strong>Duplicate</strong> above to get a copy you can edit, layout and data alike.
        </p>
      )}

      {pane === 'fields' && (
        <div className="space-y-2">
          {fields.length === 0 && (
            <p className="text-sm text-slate-500">
              This template has no fields that can take data. Add text or a barcode field in the
              Layout tab, and it will show up here.
            </p>
          )}

          {fields.map(field => {
            const rule = spec.fields[field.name] ?? null;
            const value = sampleFor(field);
            const barcode = field.kind === 'barcode' || field.kind === 'qr';
            const barcodeError = barcode ? barcodeProblem(field.type, value) : null;
            const fieldProblems = problemsFor(field.name);
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
                  {barcode && field.hint && (
                    <p className="text-xs text-slate-500">{field.hint}</p>
                  )}
                  <RuleRow rule={rule} spec={spec} fieldNames={allNames} locked={locked}
                    onChange={next => setRule(field.name, next)} />
                  {fieldProblems.length > 0 && (
                    <ul className="list-inside list-disc text-xs text-red-700">
                      {fieldProblems.map(p => <li key={p}>{p}</li>)}
                    </ul>
                  )}
                  {rule && (
                    <button className={btnCls} disabled={locked} onClick={() => setRule(field.name, null)}>
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
                A field was renamed or deleted in the Layout. These rules are kept until you move or
                remove them, so the work is not lost.
              </p>
              <ul className="mt-2 space-y-1">
                {orphans.map(name => (
                  <li key={name} className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="rounded bg-white/70 px-1.5 py-0.5 text-slate-800">{name}</code>
                    <label className="flex items-center gap-1">
                      <span className="text-amber-800">Move to</span>
                      <select className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                        value="" disabled={locked} onChange={e => e.target.value && moveRule(name, e.target.value)}>
                        <option value="">Choose a field…</option>
                        {fields.filter(f => !spec.fields[f.name]).map(f => (
                          <option key={f.name} value={f.name}>{f.name}</option>
                        ))}
                      </select>
                    </label>
                    <button className={btnCls} disabled={locked} onClick={() => dropRule(name)}>Delete rule</button>
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
