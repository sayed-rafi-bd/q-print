import { describe, expect, it } from 'vitest';
import { barcodeProblem } from './barcodeCheck';
import { builtinSpec } from './builtins';
import { generateRows, validateSpec } from './engine';

function seededRng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const NOW = new Date(2026, 9, 14); // 2026-10-14

/**
 * The shape each field prints. The built-in is a worked example, so it has to print a full page of
 * believable content with nothing typed and nothing fetched: it carries no address to type.
 */
const PRODUCT_SHAPES: Record<string, RegExp> = {
  itemBarcode: /^4901234\d{8}$/,
  itemCodeText: /^4901234\d{8}$/, // the same code as the barcode above
  issueDate: /^\d{2}\d{2}-\d{2}-\d{2} 再$/,
  brandName: /^Acme$/,
  productCode: /^SKU-\d{4}$/,
  productName: /^Sample product$/,
  locZone: /^13-$/,
  locCode: /^04-50$/,
  trackingBarcode: /^\d{12}$/,
  trackingText: /^\d{12}$/, // the same tracking number
  warehouse: /^Chiba・ロジ$/,
  operator: /^SUJON MD SAIDUR$/,
};

const runParity = (id: string, shapes: Record<string, RegExp>) => {
  expect(validateSpec(builtinSpec(id))).toEqual([]);
  const rows = generateRows(builtinSpec(id), 400, { now: NOW, rng: seededRng(7) });
  for (const row of rows) {
    for (const [field, shape] of Object.entries(shapes)) {
      expect(row[field], `${id}.${field} = ${JSON.stringify(row[field])}`).toMatch(shape);
    }
  }
  return rows;
};

describe('built-in product generator', () => {
  it('prints a full page of content', () => {
    const rows = runParity('product', PRODUCT_SHAPES);
    expect(rows).toHaveLength(400);
  });

  it('covers exactly the fields the label has', () => {
    expect(Object.keys(builtinSpec('product').fields).sort()).toEqual(Object.keys(PRODUCT_SHAPES).sort());
  });

  it('is valid on its own, with no address typed', () => {
    // The point of making it self-contained: a new build can print it before any account exists.
    expect(builtinSpec('product').fields).not.toHaveProperty('source');
    expect(Object.values(builtinSpec('product').fields).some((r) => r.kind === 'api')).toBe(false);
  });
});

describe('built-in label values that a barcode must accept', () => {
  const TYPES: Record<string, string> = {
    itemBarcode: 'code128',
    trackingBarcode: 'code128',
  };

  it.each(Object.entries(TYPES))('%s is a value %s accepts', (field, type) => {
    const rows = generateRows(builtinSpec('product'), 20, { now: NOW, rng: seededRng(3) });
    for (const row of rows) {
      expect(barcodeProblem(type, String(row[field])), row[field]).toBeNull();
    }
  });
});

describe('builtinSpec', () => {
  it('hands out a copy, so editing one cannot change the built-in', () => {
    const a = builtinSpec('product');
    a.fields.brandName = { kind: 'fixed', value: 'changed' };
    expect(builtinSpec('product').fields.brandName).not.toEqual({ kind: 'fixed', value: 'changed' });
  });

  it('falls back to an empty spec for an unknown id', () => {
    expect(validateSpec(builtinSpec('nope'))).toEqual([]);
    expect(Object.keys(builtinSpec('nope').fields)).toEqual([]);
  });
});
