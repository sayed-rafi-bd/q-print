/**
 * Labels, one row each, always scoped to the account that owns them.
 *
 * `user_id` is in the WHERE clause of every read and every write. It comes from the signed-in
 * account and never from a value the caller passes as "whose labels do you want", so a label id
 * guessed from another account finds nothing rather than someone else's label.
 *
 * A row is a LabelBundle split across columns, so export/import and the generator engine are
 * unchanged.
 */

import { one, str, strOr, type Db, type Row } from './types';

/** What the picker needs: enough to draw a row, not the whole template. */
export type LabelSummary = {
  id: string;
  slug: string;
  name: string;
  /** Page size in mm, read from the template so it cannot go stale. */
  widthMm: number;
  heightMm: number;
  updatedAt: string;
};

/** A whole label. */
export type StoredLabel = LabelSummary & {
  template: string;
  generator: string;
};

export type LabelInput = {
  name: string;
  slug: string;
  /** pdfme template, as JSON text. */
  template: string;
  /** generator spec, as JSON text. */
  generator: string;
};

/** Largest a single label may be, matching what the backend used to accept. */
export const MAX_LABEL_BYTES = 5 * 1024 * 1024;

/**
 * Reads a page size out of a stored template, falling back to a size that at least renders.
 * A row whose template is unreadable should still show up in the list, not break it.
 */
export function sizeOfTemplateJson(templateJson: string): { widthMm: number; heightMm: number } {
  const fallback = { widthMm: 100, heightMm: 50 };
  try {
    const base = (JSON.parse(templateJson) as { basePdf?: { width?: unknown; height?: unknown } }).basePdf;
    const w = Number(base?.width);
    const h = Number(base?.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fallback;
    return { widthMm: w, heightMm: h };
  } catch {
    return fallback;
  }
}

const toSummary = (row: Row): LabelSummary => {
  const template = strOr(row, 'template', '');
  const { widthMm, heightMm } = sizeOfTemplateJson(template);
  return {
    id: strOr(row, 'id', ''),
    slug: strOr(row, 'slug', ''),
    name: strOr(row, 'name', ''),
    widthMm,
    heightMm,
    updatedAt: strOr(row, 'updated_at', ''),
  };
};

const toStored = (row: Row): StoredLabel => ({
  ...toSummary(row),
  template: strOr(row, 'template', ''),
  generator: strOr(row, 'generator', ''),
});

const COLUMNS = 'id, slug, name, template, generator, created_at, updated_at';

/** Every label belonging to `userId`, most recently changed first. */
export async function listLabels(db: Db, userId: string): Promise<LabelSummary[]> {
  const { rows } = await db.execute({
    sql: `SELECT ${COLUMNS} FROM labels WHERE user_id = ? ORDER BY updated_at DESC, name`,
    args: [userId],
  });
  return rows.map(toSummary);
}

/** One label, or null. Scoped, so another account's label id finds nothing. */
export async function getLabel(db: Db, userId: string, id: string): Promise<StoredLabel | null> {
  const { rows } = await db.execute({
    sql: `SELECT ${COLUMNS} FROM labels WHERE user_id = ? AND id = ?`,
    args: [userId, id],
  });
  const row = one(rows);
  return row ? toStored(row) : null;
}

/** One label by its per-user slug, which is how the registry and the UI address labels. */
export async function getLabelBySlug(db: Db, userId: string, slug: string): Promise<StoredLabel | null> {
  const { rows } = await db.execute({
    sql: `SELECT ${COLUMNS} FROM labels WHERE user_id = ? AND slug = ?`,
    args: [userId, slug],
  });
  const row = one(rows);
  return row ? toStored(row) : null;
}

/** Stores a new label. Throws if the slug is already taken by this account. */
export async function createLabel(db: Db, userId: string, label: LabelInput): Promise<StoredLabel> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO labels (id, user_id, name, slug, template, generator, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, userId, label.name, label.slug, label.template, label.generator, now, now],
  });
  return { ...toSummary({ id, slug: label.slug, name: label.name, template: label.template, updated_at: now }), template: label.template, generator: label.generator };
}

/**
 * Replaces a label's contents, or renames it. Scoped by user, so a guess at another account's id
 * changes nothing. Returns false when the id is not this account's.
 */
export async function updateLabel(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<LabelInput>,
): Promise<boolean> {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  for (const column of ['name', 'slug', 'template', 'generator'] as const) {
    const value = patch[column];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      args.push(value);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  args.push(new Date().toISOString(), userId, id);

  const { rows } = await db.execute({
    sql: `UPDATE labels SET ${sets.join(', ')} WHERE user_id = ? AND id = ? RETURNING id`,
    args,
  });
  return rows.length > 0;
}

/** Removes a label. Returns false when the id is not this account's. */
export async function deleteLabel(db: Db, userId: string, id: string): Promise<boolean> {
  const { rows } = await db.execute({
    sql: 'DELETE FROM labels WHERE user_id = ? AND id = ? RETURNING id',
    args: [userId, id],
  });
  return rows.length > 0;
}

/** How many labels an account has. Used to decide whether the one-time import should offer. */
export async function countLabels(db: Db, userId: string): Promise<number> {
  const { rows } = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM labels WHERE user_id = ?',
    args: [userId],
  });
  return Number(rows[0]?.n ?? 0);
}

/** Every label belonging to an account, for the one-time import from files on disk. */
export async function listSlugs(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.execute({ sql: 'SELECT slug FROM labels WHERE user_id = ?', args: [userId] });
  return rows.map(r => str(r, 'slug') ?? '');
}
