/**
 * The placeholder values a person typed while designing, so the preview looks the same next time.
 *
 * Design-time only: nothing here is ever read when a label prints. `printRows.ts` builds a print
 * job from `loadLabel` and the real records, and never comes near this table, so a placeholder can
 * only ever be seen on screen.
 *
 * `labelId` is a slug for a label of the account's own or a built-in id such as `product`. Both are
 * accepted, because a built-in label needs placeholders as much as one the person created.
 */

import { and, eq } from 'drizzle-orm';
import { type Database, labelPreview } from './schema';

/** Field name to the value to preview. Only string values; anything else is ignored on read. */
export type PreviewValues = Record<string, string>;

/** Keeps only string values, so a hand-edited row cannot hand the preview something else. */
const parse = (json: string): PreviewValues => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as PreviewValues;
  } catch {
    return {};
  }
};

/** This account's placeholder values for a label, or null when there are none. */
export async function loadPreviewValues(db: Database, userId: string, labelId: string): Promise<PreviewValues | null> {
  const row = await db
    .select()
    .from(labelPreview)
    .where(and(eq(labelPreview.userId, userId), eq(labelPreview.labelId, labelId)))
    .limit(1);
  const found = row[0];
  return found ? parse(found.valuesJson) : null;
}

/**
 * Replaces a label's placeholder values. An empty object removes the row rather than storing `{}`,
 * so "no placeholders" and "an empty placeholder" are not the same thing.
 */
export async function savePreviewValues(
  db: Database,
  userId: string,
  labelId: string,
  values: PreviewValues,
): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    await deletePreviewValues(db, userId, labelId);
    return;
  }
  const now = new Date().toISOString();
  const json = JSON.stringify(values);
  // Upsert: the row is keyed by (user_id, label_id), so a second save replaces it.
  await db
    .insert(labelPreview)
    .values({ userId, labelId, valuesJson: json, updatedAt: now })
    .onConflictDoUpdate({
      target: [labelPreview.userId, labelPreview.labelId],
      set: { valuesJson: json, updatedAt: now },
    });
}

/** Forgets a label's placeholders. Called when a label is deleted. */
export async function deletePreviewValues(db: Database, userId: string, labelId: string): Promise<void> {
  await db.delete(labelPreview).where(and(eq(labelPreview.userId, userId), eq(labelPreview.labelId, labelId)));
}

/**
 * Gives a new label the placeholders of the one it was copied from, so a duplicate of a label you
 * were working on still previews as you left it. A no-op when the original had none.
 */
export async function copyPreviewValues(
  db: Database,
  userId: string,
  fromLabelId: string,
  toLabelId: string,
): Promise<void> {
  const values = await loadPreviewValues(db, userId, fromLabelId);
  if (values && Object.keys(values).length > 0) await savePreviewValues(db, userId, toLabelId, values);
}
