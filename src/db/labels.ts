/**
 * Labels, one row each, always scoped to the account that owns them.
 *
 * `userId` is in the WHERE clause of every read and every write. It comes from the signed-in
 * account and never from a value the caller passes as "whose labels do you want", so a slug
 * guessed from another account finds nothing rather than someone else's label.
 *
 * Rows are keyed by `slug`, not the internal uuid, because the slug is what the rest of the app
 * has always called a label id — it is what appears in the picker, in the Designer and in exported
 * file names.
 *
 * A row is a LabelBundle split across columns, so export/import and the generator engine are
 * unchanged.
 */

import { and, count, desc, eq } from 'drizzle-orm';
import type { Database } from './client';
import { labels as labelsTable } from './schema';

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

type Row = typeof labelsTable.$inferSelect;

const toSummary = (row: Row): LabelSummary => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  ...sizeOfTemplateJson(row.template),
  updatedAt: row.updatedAt,
});

const toStored = (row: Row): StoredLabel => ({ ...toSummary(row), template: row.template, generator: row.generator });

/** Every label belonging to `userId`, most recently changed first. */
export async function listLabels(db: Database, userId: string): Promise<LabelSummary[]> {
  const rows = await db
    .select()
    .from(labelsTable)
    .where(eq(labelsTable.userId, userId))
    .orderBy(desc(labelsTable.updatedAt), labelsTable.name);
  return rows.map(toSummary);
}

/** One label, or null. Scoped, so another account's slug finds nothing. */
export async function getLabel(db: Database, userId: string, slug: string): Promise<StoredLabel | null> {
  const [row] = await db
    .select()
    .from(labelsTable)
    .where(and(eq(labelsTable.userId, userId), eq(labelsTable.slug, slug)))
    .limit(1);
  return row ? toStored(row) : null;
}

/** Stores a new label. Throws if this account already has one with that slug. */
export async function createLabel(db: Database, userId: string, slug: string, label: LabelInput): Promise<StoredLabel> {
  const now = new Date().toISOString();
  const row: Row = {
    id: crypto.randomUUID(),
    userId,
    name: label.name,
    slug,
    template: label.template,
    generator: label.generator,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(labelsTable).values(row);
  return toStored(row);
}

/**
 * Replaces a label's contents, or renames it. Scoped by account, so another account's slug changes
 * nothing. Returns false when the slug is not this account's.
 */
export async function updateLabel(
  db: Database,
  userId: string,
  slug: string,
  patch: Partial<LabelInput>,
): Promise<boolean> {
  const values: Partial<Row> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.template !== undefined) values.template = patch.template;
  if (patch.generator !== undefined) values.generator = patch.generator;
  if (Object.keys(values).length === 0) return false;

  const result = await db
    .update(labelsTable)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(and(eq(labelsTable.userId, userId), eq(labelsTable.slug, slug)))
    .returning({ id: labelsTable.id });

  return result.length > 0;
}

/** Removes a label. Returns false when the slug is not this account's. */
export async function deleteLabel(db: Database, userId: string, slug: string): Promise<boolean> {
  const result = await db
    .delete(labelsTable)
    .where(and(eq(labelsTable.userId, userId), eq(labelsTable.slug, slug)))
    .returning({ id: labelsTable.id });
  return result.length > 0;
}

/** How many labels an account has. Used to decide whether the one-time import should offer. */
export async function countLabels(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(labelsTable).where(eq(labelsTable.userId, userId));
  return Number(row?.n ?? 0);
}

/** The slugs this account already has, so an import can skip names that would collide. */
export async function listSlugs(db: Database, userId: string): Promise<string[]> {
  const rows = await db.select({ slug: labelsTable.slug }).from(labelsTable).where(eq(labelsTable.userId, userId));
  return rows.map((r) => r.slug);
}
