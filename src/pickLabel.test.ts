import { describe, expect, it } from 'vitest';
import type { LabelMeta } from './labels';
import { isLabelMissing, pickLabelAfterReload } from './pickLabel';

const meta = (id: string): LabelMeta => ({ id, name: id, builtin: false, widthMm: 100, heightMm: 50 });

const labels = [meta('product'), meta('parcel'), meta('sample-label')];

describe('pickLabelAfterReload', () => {
  it('keeps the label that is selected, if it is still there', () => {
    expect(pickLabelAfterReload(labels, 'parcel', 'product')?.id).toBe('parcel');
  });

  it('falls back to the one used last time when the selection has gone', () => {
    expect(pickLabelAfterReload(labels, 'deleted', 'sample-label')?.id).toBe('sample-label');
  });

  it('falls back to the first label when neither is available', () => {
    expect(pickLabelAfterReload(labels, null, null)?.id).toBe('product');
    expect(pickLabelAfterReload(labels, 'gone', 'also-gone')?.id).toBe('product');
  });

  it('returns null when there is nothing to pick, so the caller can say so', () => {
    expect(pickLabelAfterReload([], 'parcel', 'product')).toBeNull();
  });

  it('prefers the selection over the remembered one, even if the remembered one is first', () => {
    expect(pickLabelAfterReload(labels, 'sample-label', 'product')?.id).toBe('sample-label');
  });

  it('handles a selection that matches nothing and no memory', () => {
    expect(pickLabelAfterReload([meta('only')], 'nope', null)?.id).toBe('only');
  });
});

describe('isLabelMissing', () => {
  it('is true when the label is no longer in the list', () => {
    expect(isLabelMissing(labels, 'deleted')).toBe(true);
  });

  it('is false when the label is still there', () => {
    expect(isLabelMissing(labels, 'parcel')).toBe(false);
  });

  it('says nothing while the list is empty, rather than reporting a problem it cannot see', () => {
    // An empty list after a failed reload must not look like a missing label.
    expect(isLabelMissing([], 'parcel')).toBe(false);
  });

  it('is false when nothing is selected yet', () => {
    expect(isLabelMissing(labels, null)).toBe(false);
  });
});
