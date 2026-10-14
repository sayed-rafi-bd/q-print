import { useState } from 'react';
import NewLabelDialog from './NewLabelDialog';
import { createLabel, deleteLabel, renameLabel, type LabelId, type LabelMeta, type NewLabel } from '../labels';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const btnCls =
  'cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const btnPlainCls = btnCls + ' border border-slate-300 text-slate-700 hover:bg-slate-50';
const btnDangerCls = btnCls + ' border border-red-300 text-red-700 hover:bg-red-50';
const selectCls =
  'cursor-pointer rounded-xl border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-100';

type Props = {
  labels: LabelMeta[];
  /** Files in `labels/` that could not be read, so they can be cleaned up. */
  broken: { id: string; reason: string }[];
  value: LabelId;
  disabled?: boolean;
  /** Switching to another label. The page asks about unsaved changes first. */
  onPick: (id: LabelId) => void;
  /** After a create / rename / delete: reload the registry, then select `selectId` if given. */
  onChanged: (selectId?: LabelId) => void;
  onError: (message: string) => void;
};

/**
 * The label picker and the buttons that act on it: New, Duplicate, Rename, Delete.
 *
 * Built-in labels keep their names and their files, so they can be copied and reset but not renamed
 * or deleted. Everything else is the user's own.
 */
export default function LabelToolbar({ labels, broken, value, disabled, onPick, onChanged, onError }: Props) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = labels.find(l => l.id === value) ?? null;
  const off = disabled || !current;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (label: NewLabel): Promise<void> => {
    const created = await createLabel(label);
    setCreating(false);
    onChanged(created.id);
  };

  const onDuplicate = () =>
    run(async () => {
      const copy = await createLabel({
        name: `${current!.name} copy`,
        widthMm: current!.widthMm,
        heightMm: current!.heightMm,
        from: current!.id,
      });
      onChanged(copy.id);
    });

  const onRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || !current) return;
    await run(async () => {
      await renameLabel(current.id, name);
      setRenaming(false);
      onChanged();
    });
  };

  const onDelete = () =>
    run(async () => {
      const id = current!.id;
      setConfirmDelete(false);
      await deleteLabel(id);
      onChanged();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="designer-label" className="text-sm font-medium text-slate-700">Label</label>
        <select id="designer-label" value={value} disabled={disabled}
          onChange={e => onPick(e.target.value)}
          className={selectCls + ' max-w-64'}>
          {labels.map(l => (
            <option key={l.id} value={l.id}>{l.name}{l.builtin ? '' : ' (your label)'}</option>
          ))}
        </select>

        <button className={btnPlainCls} onClick={() => { setCreating(c => !c); setRenaming(false); setConfirmDelete(false); }}
          disabled={disabled || busy} aria-expanded={creating}>
          {creating ? 'Close' : 'New'}
        </button>

        <button className={btnPlainCls} onClick={() => { setNewName(current?.name ?? ''); setRenaming(r => !r); setCreating(false); }}
          disabled={off || busy || current?.builtin} aria-expanded={renaming}
          title={current?.builtin ? 'A built-in label keeps its name' : undefined}>
          Rename
        </button>

        <button className={btnPlainCls} onClick={onDuplicate} disabled={off || busy}>Duplicate</button>

        {current?.builtin ? (
          <span className="text-xs text-slate-500">A built-in label; use “Reset to default” below.</span>
        ) : confirmDelete ? (
          <span className="flex items-center gap-2 text-sm text-slate-700">
            Delete “{current?.name}”?
            <button className={btnDangerCls} onClick={onDelete} disabled={busy}>Yes, delete</button>
            <button className={btnPlainCls} onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        ) : (
          <button className={btnDangerCls} onClick={() => setConfirmDelete(true)} disabled={off || busy}>Delete</button>
        )}
      </div>

      {renaming && current && (
        <form onSubmit={onRename} className="tab-enter flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <label htmlFor="rename-label" className="font-medium">Rename</label>
          <input id="rename-label" autoFocus value={newName} onChange={e => setNewName(e.target.value)}
            className="w-64 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
          <button type="submit" className={btnPlainCls} disabled={busy || !newName.trim()}>Save</button>
          <button type="button" className={btnPlainCls} onClick={() => setRenaming(false)}>Cancel</button>
        </form>
      )}

      {creating && (
        <NewLabelDialog labels={labels} onCreate={onCreate} onClose={() => setCreating(false)} />
      )}

      {broken.length > 0 && (
        <div className="tab-enter space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">
            {broken.length} label file{broken.length > 1 ? 's' : ''} could not be read. They are not printable.
          </p>
          <ul className="space-y-1">
            {broken.map(b => (
              <li key={b.id || b.reason} className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-white/70 px-1.5 py-0.5">{b.id || '(unnamed)'}</code>
                <span className="break-words">{b.reason}</span>
                {b.id && (
                  <button className="underline" disabled={busy}
                    onClick={() => run(async () => { await deleteLabel(b.id); onChanged(); })}>
                    delete it
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
