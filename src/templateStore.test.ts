import { describe, expect, it } from 'vitest';
import type { Template } from '@pdfme/common';
import { assertUsableTemplate, withValidBasePdf } from './templateStore';

const ok = (over: Partial<Template> = {}): Template => ({
  basePdf: { width: 100, height: 50, padding: [0, 0, 0, 0] },
  schemas: [[]],
  ...over,
} as unknown as Template);

describe('withValidBasePdf', () => {
  it('leaves a template that already has padding alone', () => {
    const t = ok();
    expect(withValidBasePdf(t)).toBe(t);
  });

  it('fills in the padding an older version did not write', () => {
    // pdfme refuses a page with no padding, and will not open the template at all.
    const repaired = withValidBasePdf(ok({ basePdf: { width: 100, height: 50 } } as unknown as Template));
    expect((repaired.basePdf as { padding: number[] }).padding).toEqual([0, 0, 0, 0]);
  });

  it('replaces padding that is the wrong shape', () => {
    for (const padding of [[0, 0, 0], 'none', [1, 2, 3, 'x'], null]) {
      const repaired = withValidBasePdf(ok({ basePdf: { width: 100, height: 50, padding } } as unknown as Template));
      expect((repaired.basePdf as { padding: number[] }).padding).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('assertUsableTemplate', () => {
  it('accepts a template pdfme can open', () => {
    expect(() => assertUsableTemplate(ok())).not.toThrow();
    expect(() => assertUsableTemplate(ok({ schemas: [[{ name: 'a', type: 'text' }]] } as unknown as Template))).not.toThrow();
  });

  it('rejects a basePdf that is not a page size', () => {
    // This is the case that left the Designer blank: pdfme accepts the template and draws nothing,
    // so nothing catches it unless it is checked here.
    expect(() => assertUsableTemplate(ok({ basePdf: 'not-a-pdf-at-all' } as unknown as Template)))
      .toThrow(/unreadable page/);
    expect(() => assertUsableTemplate(ok({ basePdf: null } as unknown as Template))).toThrow(/unreadable page/);
    expect(() => assertUsableTemplate(ok({ basePdf: [] } as unknown as Template))).toThrow(/unreadable page/);
  });

  it('rejects a page size that is not a positive number', () => {
    for (const basePdf of [
      { width: 0, height: 50 }, { width: 100, height: 0 }, { width: -1, height: 50 },
      { width: 'wide', height: 50 }, { width: NaN, height: 50 }, {},
    ]) {
      expect(() => assertUsableTemplate(ok({ basePdf } as unknown as Template)), JSON.stringify(basePdf))
        .toThrow(/no usable page size/);
    }
  });

  it('rejects a template with no field list', () => {
    expect(() => assertUsableTemplate(ok({ schemas: undefined } as unknown as Template))).toThrow(/no field list/);
    expect(() => assertUsableTemplate(ok({ schemas: {} } as unknown as Template))).toThrow(/no field list/);
    expect(() => assertUsableTemplate(ok({ schemas: ['not-a-page'] } as unknown as Template))).toThrow(/no field list/);
  });

  it('rejects things that are not a template at all', () => {
    for (const value of [null, undefined, 'a string', 42, []]) {
      expect(() => assertUsableTemplate(value), JSON.stringify(value)).toThrow();
    }
  });

  it('names what it was checking, so the message can say which label', () => {
    expect(() => assertUsableTemplate(ok({ basePdf: 'x' } as unknown as Template), 'The template for “parcel”'))
      .toThrow(/The template for “parcel”/);
  });
});
