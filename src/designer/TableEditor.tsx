import { useState } from 'react';
import { LIMITS } from '../generator/engine';
import type { GeneratorSpec, GeneratorTable } from '../generator/spec';

const cellCls =
  'w-full min-w-0 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs focus:border-indigo-500 ' +
  'focus:outline-none focus:ring-1 focus:ring-indigo-200';
const btnCls =
  'cursor-pointer rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 ' +
  'transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

const slug = (name: string, taken: string[]) => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table';
  return taken.includes(base) ? `${base}-${taken.length + 1}` : base;
};

/** Splits pasted CSV or tab-separated text into rows of cells. */
export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/\t|,/).map((cell) => cell.trim()))
    .filter((row) => row.length > 0 && row.some((cell) => cell !== ''));
}

type Props = {
  spec: GeneratorSpec;
  onChange: (next: GeneratorSpec) => void;
  /** Show the tables but do not let them be changed. */
  readOnly?: boolean;
};

/**
 * Tables of literal values that rules can read from, so several fields can stay consistent (a
 * postcode and the address that goes with it). One row is chosen per page and shared by every
 * field reading the same table.
 */
export default function TableEditor({ spec, onChange, readOnly }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [pasting, setPasting] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [target, setTarget] = useState<string>('');

  const locked = readOnly === true;

  const tables = spec.tables ?? {};
  const names = Object.keys(tables);

  const put = (next: Record<string, GeneratorTable>) => onChange({ ...spec, tables: next });

  const addTable = () => {
    const id = slug(name, names);
    if (names.includes(id)) return;
    put({ ...tables, [id]: { columns: ['column1'], rows: [['']] } });
    setName('');
    setAdding(false);
  };

  const edit = (tableName: string, table: GeneratorTable) => put({ ...tables, [tableName]: table });

  const remove = (tableName: string) => {
    const next = { ...tables };
    delete next[tableName];
    // A rule left pointing at a table that no longer exists is a validation error, so say so
    // rather than silently leaving a broken spec behind.
    onChange({ ...spec, tables: next });
  };

  const applyPaste = () => {
    if (!target) return;
    const rows = parseCsv(pasted);
    if (rows.length === 0) return;
    const existing = tables[target];
    // The first pasted line is taken as the column names when it is new text.
    const columns =
      rows[0].length === existing.columns.length && existing.rows.length === 0 ? rows[0] : existing.columns;
    const body = rows[0].length === existing.columns.length && existing.rows.length === 0 ? rows.slice(1) : rows;
    edit(target, {
      columns,
      rows: body.slice(0, LIMITS.maxTableRows).map((row) => columns.map((_, i) => row[i] ?? '')),
    });
    setPasting(null);
    setPasted('');
  };

  return (
    <div className="space-y-3">
      {names.length === 0 && (
        <p className="text-xs text-slate-500">
          No tables yet. A table is a list of values several fields can share, so a postcode and its address always
          match. A rule of the kind “From a table” reads one cell.
        </p>
      )}

      {names.map((tableName) => {
        const table = tables[tableName];
        const usedBy = Object.entries(spec.fields)
          .filter(([, r]) => r.kind === 'table' && r.table === tableName)
          .map(([field]) => field);
        return (
          <div key={tableName} className="rounded-xl border border-slate-200 bg-slate-50/60 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium text-slate-700">{tableName}</span>
              <span className="text-xs text-slate-500">
                {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
                {usedBy.length > 0 && ` · used by ${usedBy.join(', ')}`}
              </span>
              <span className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  className={btnCls}
                  disabled={locked}
                  onClick={() => {
                    setTarget(tableName);
                    setPasting(tableName);
                  }}
                >
                  Paste / import CSV
                </button>
                <button
                  type="button"
                  className={btnCls}
                  disabled={locked || table.columns.length >= LIMITS.maxTableRows}
                  onClick={() =>
                    edit(tableName, {
                      columns: [...table.columns, `column${table.columns.length + 1}`],
                      rows: table.rows.map((r) => [...r, '']),
                    })
                  }
                >
                  Add column
                </button>
                <button
                  type="button"
                  className={btnCls}
                  disabled={locked || table.rows.length >= LIMITS.maxTableRows}
                  onClick={() => edit(tableName, { ...table, rows: [...table.rows, table.columns.map(() => '')] })}
                >
                  Add row
                </button>
                <button type="button" className={btnCls} disabled={locked} onClick={() => remove(tableName)}>
                  Delete table
                </button>
              </span>
            </div>

            {pasting === tableName && (
              <div className="tab-enter mt-2 space-y-2 rounded-lg border border-indigo-200 bg-white p-2">
                <p className="text-xs text-slate-600">
                  Paste rows separated by commas or tabs. If the table has no rows yet, the first line is taken as the
                  column names.
                </p>
                <textarea
                  rows={4}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  className="w-full rounded border border-slate-300 p-1.5 font-mono text-xs"
                  placeholder={'150-0021, Tokyo\n100-0005, Tokyo'}
                />
                <div className="flex gap-1.5">
                  <button type="button" className={btnCls} onClick={applyPaste} disabled={!pasted.trim()}>
                    Replace rows
                  </button>
                  <button type="button" className={btnCls} onClick={() => setPasting(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="mt-2 overflow-x-auto">
              {/* One disabled fieldset rather than a disabled prop on every cell. */}
              <fieldset disabled={locked} className="contents">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {table.columns.map((c, ci) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells are plain strings with no id, and columns/rows are positional
                        <th key={ci} className="p-0.5 text-left font-medium text-slate-600">
                          <input
                            aria-label={`Column ${ci + 1} name`}
                            className={cellCls}
                            value={c}
                            onChange={(e) => {
                              const columns = table.columns.map((x, i) => (i === ci ? e.target.value : x));
                              edit(tableName, { ...table, columns });
                            }}
                          />
                        </th>
                      ))}
                      <th className="w-8 p-0.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, ri) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are plain strings with no id, and columns/rows are positional
                      <tr key={ri}>
                        {table.columns.map((_, ci) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: cells are plain strings with no id, and columns/rows are positional
                          <td key={ci} className="p-0.5">
                            <input
                              aria-label={`Row ${ri + 1}, ${table.columns[ci] ?? ci + 1}`}
                              className={cellCls}
                              value={row[ci] ?? ''}
                              onChange={(e) => {
                                const rows = table.rows.map((r, i) =>
                                  i === ri
                                    ? table.columns.map((_, k) => (k === ci ? e.target.value : (r[k] ?? '')))
                                    : r,
                                );
                                edit(tableName, { ...table, rows });
                              }}
                            />
                          </td>
                        ))}
                        <td className="p-0.5 text-right">
                          <button
                            type="button"
                            className="text-xs text-slate-400 hover:text-red-600"
                            aria-label={`Delete row ${ri + 1}`}
                            onClick={() => edit(tableName, { ...table, rows: table.rows.filter((_, i) => i !== ri) })}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </fieldset>
            </div>
            {table.rows.length === 0 && (
              <p className="mt-1 text-xs text-slate-500">No rows yet, so this table cannot fill anything.</p>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            aria-label="Table name"
            // biome-ignore lint/a11y/noAutofocus: focus the field when this dialog opens
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="destinations"
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <button type="button" className={btnCls} onClick={addTable}>
            Add table
          </button>
          <button
            type="button"
            className={btnCls}
            onClick={() => {
              setAdding(false);
              setName('');
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={btnCls} disabled={locked} onClick={() => setAdding(true)}>
          Add a table
        </button>
      )}
    </div>
  );
}
