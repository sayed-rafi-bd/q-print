import type { LabelId, LabelMeta } from './labels';

/**
 * Which label a reload should show.
 *
 * A reload must not pull the rug out from under someone who has already chosen a label: keep the
 * one selected if it is still there, then the one they used last time, then the first available.
 *
 * Pure, so the cases a button press and a background reload have to agree on are covered by tests
 * rather than by whether the tab happened to be visible.
 */
export function pickLabelAfterReload(
  labels: LabelMeta[],
  currentId: LabelId | null,
  remembered: LabelId | null,
): LabelMeta | null {
  return labels.find((l) => l.id === currentId) ?? labels.find((l) => l.id === remembered) ?? labels[0] ?? null;
}

/** True when the label the user was looking at is gone from the list. */
export const isLabelMissing = (labels: LabelMeta[], id: LabelId | null): boolean =>
  id !== null && labels.length > 0 && !labels.some((l) => l.id === id);
