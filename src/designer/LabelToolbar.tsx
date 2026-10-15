import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { fitName, MAX_NAME } from '../labelId';
import { createLabel, deleteLabel, type LabelId, type LabelMeta, type NewLabel, renameLabel } from '../labels';
import Modal from './Modal';
import NewLabelDialog from './NewLabelDialog';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Shared shapes, defined once in index.css so a button looks the same in every panel.
const btnPlainCls = 'btn btn-secondary';
const btnDangerCls = 'btn btn-danger';
const selectCls = 'field w-56 truncate cursor-pointer';

type Props = {
  labels: LabelMeta[];
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
export default function LabelToolbar({ labels, value, disabled, onPick, onChanged, onError }: Props) {
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = labels.find((l) => l.id === value) ?? null;
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
    if (!user) throw new Error('You are not signed in.');
    const created = await createLabel(user, label);
    setCreating(false);
    onChanged(created.id);
  };

  const onDuplicate = () =>
    run(async () => {
      if (!user) throw new Error('You are not signed in.');
      const copy = await createLabel(user, {
        name: fitName(current!.name, ' copy'),
        widthMm: current!.widthMm,
        heightMm: current!.heightMm,
        from: { kind: 'copy', id: current!.id },
      });
      onChanged(copy.id);
    });

  const onRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || !current) return;
    if (!user) return;
    await run(async () => {
      await renameLabel(user, current.id, name);
      setRenaming(false);
      onChanged();
    });
  };

  const onDelete = () =>
    run(async () => {
      if (!user) throw new Error('You are not signed in.');
      const id = current!.id;
      setConfirmDelete(false);
      await deleteLabel(user, id);
      onChanged();
    });

  return (
    <div className="space-y-2">
      {/* The picker on the left, then its actions in a tight group, then Delete pushed away to the far
          end. It used to sit between Duplicate and the page size, where it read as one of four
          equally-weighted row buttons. */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="designer-label" className="text-body font-semibold text-slate-700">
          Label
        </label>
        <select
          id="designer-label"
          value={value}
          disabled={disabled}
          onChange={(e) => onPick(e.target.value)}
          className={`${selectCls} sm:w-64`}
        >
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={btnPlainCls}
          onClick={() => {
            setCreating((c) => !c);
            setRenaming(false);
            setConfirmDelete(false);
          }}
          disabled={disabled || busy}
          aria-expanded={creating}
        >
          {creating ? 'Close' : 'New'}
        </button>

        <button
          type="button"
          className={btnPlainCls}
          onClick={() => {
            setNewName(current?.name ?? '');
            setRenaming((r) => !r);
            setCreating(false);
          }}
          disabled={off || busy || current?.builtin}
          aria-expanded={renaming}
          title={current?.builtin ? 'A built-in label keeps its name' : undefined}
        >
          Rename
        </button>

        <button type="button" className={btnPlainCls} onClick={onDuplicate} disabled={off || busy}>
          Duplicate
        </button>

        {current?.builtin ? (
          <span className="ml-auto text-label text-slate-500">A built-in label; use “Reset to default” below.</span>
        ) : (
          <button
            type="button"
            className={`${btnDangerCls} ml-auto`}
            onClick={() => setConfirmDelete(true)}
            disabled={off || busy}
          >
            Delete
          </button>
        )}
      </div>

      {current && (
        <Modal
          open={confirmDelete}
          title="Delete label"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" className={btnDangerCls} onClick={onDelete} disabled={busy}>
                {busy ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button type="button" className={btnPlainCls} onClick={() => setConfirmDelete(false)} disabled={busy}>
                Cancel
              </button>
            </>
          }
        >
          <p>
            “{current.name}” will be removed from your account for good. There is no undo, and the label is gone on
            every device you use this account on.
          </p>
        </Modal>
      )}

      {renaming && current && (
        <form onSubmit={onRename} className="tab-enter flex flex-wrap items-center gap-2 text-body text-slate-700">
          <label htmlFor="rename-label" className="font-semibold">
            Rename
          </label>
          <input
            id="rename-label"
            // biome-ignore lint/a11y/noAutofocus: focus the field when this dialog opens
            autoFocus
            value={newName}
            maxLength={MAX_NAME}
            onChange={(e) => setNewName(e.target.value)}
            className="field w-56"
          />
          <button type="submit" className={btnPlainCls} disabled={busy || !newName.trim()}>
            Save
          </button>
          <button type="button" className={btnPlainCls} onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      )}

      {creating && <NewLabelDialog labels={labels} onCreate={onCreate} onClose={() => setCreating(false)} />}
    </div>
  );
}
