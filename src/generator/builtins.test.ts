import { describe, expect, it } from 'vitest';
import { generateRows, validateSpec } from './engine';
import { builtinSpec } from './builtins';
import { barcodeProblem } from './barcodeCheck';
import { dataFields } from './scaffold';
import product from '../templates/product-label.json';
import type { Template } from '@pdfme/common';

function seededRng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const NOW = new Date(2026, 9, 14); // 2026-10-14

/**
 * The shape each field had when the data was generated in Rust. If a rule changes what a field
 * prints, one of these fails and the change is a deliberate one.
 */
const PRODUCT_SHAPES: Record<string, RegExp> = {
  itemBarcode: /^100\d{4}$/,
  itemCodeText: /^100\d{4}$/, // the same code as the barcode above
  issueDate: /^\d{2}\d{2} \d{2} 再$/,
  brandName: /^(ケラスターセ|ミルボン|資生堂|ロレアル)$/,
  productCode: /^035\d{10}$/,
  productName: /^EC専用 /,
  locZone: /^\d{2}-$/,
  locCode: /^\d{2}-\d-\d{2}$/,
  trackingBarcode: /^\d{13}$/,
  trackingText: /^\d{13}$/, // the same tracking number
  warehouse: /^Chiba・ロジ$/,
  operator: /^SUJON MD SAIDUR$/,
};

const runParity = (id: string, shapes: Record<string, RegExp>, now = NOW) => {
  const spec = builtinSpec(id);
  expect(validateSpec(spec)).toEqual([]);

  const rows = generateRows(spec, 400, { now, rng: seededRng(7) });
  for (const row of rows) {
    for (const [field, shape] of Object.entries(shapes)) {
      expect(row[field], `${id}.${field} = ${JSON.stringify(row[field])}`).toMatch(shape);
    }
  }
  return rows;
};

describe('built-in product generator', () => {
  it('produces the same shape of value the Rust generator did', () => runParity('product', PRODUCT_SHAPES));

  it('covers exactly the fields the Rust generator filled', () => {
    expect(Object.keys(builtinSpec('product').fields).sort()).toEqual(Object.keys(PRODUCT_SHAPES).sort());
  });

  it('keeps the location code inside the zone it is filed under', () => {
    for (const row of runParity('product', PRODUCT_SHAPES)) {
      expect(row.locCode.startsWith(row.locZone)).toBe(true);
    }
  });

  it('keeps the brand and the product name together', () => {
    const pairs: Record<string, string> = {
      ケラスターセ: 'EC専用 SP バンディバレント R 250ml',
      ミルボン: 'EC専用 ディーセス エルジューダ 120ml',
      資生堂: 'EC専用 プロフェッショナル ヘアマスク 200g',
      ロレアル: 'EC専用 セリエ エクスパート 500ml',
    };
    for (const row of runParity('product', PRODUCT_SHAPES)) {
      expect(row.productName).toBe(pairs[row.brandName]);
    }
  });

  it('dates the issue within the last three months', () => {
    const now = new Date(2026, 9, 14);
    const [row] = generateRows(builtinSpec('product'), 1, { now, rng: seededRng() });
    // The Rust version wrote "2610 05 再"; the format is still YY MM DD, but relative to today.
    const parsed = /^(\d{2})(\d{2}) (\d{2}) 再$/.exec(row.issueDate);
    expect(parsed, row.issueDate).not.toBeNull();
    const [, yy, mm, dd] = parsed!;
    const issued = new Date(2000 + Number(yy), Number(mm) - 1, Number(dd));
    const days = Math.round((Date.parse('2026-10-14T00:00:00') - Date.parse(issued.toISOString())) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(0);
    expect(days).toBeLessThanOrEqual(90);
  });
});

describe('built-in barcodes', () => {
  const cases: { id: string; template: unknown }[] = [
    { id: 'product', template: product },
  ];

  for (const { id, template } of cases) {
    it(`generates content every ${id} barcode can encode`, () => {
      const spec = builtinSpec(id);
      const barcodes = dataFields(template as Template).filter(f => f.kind === 'barcode' || f.kind === 'qr');
      expect(barcodes.length).toBeGreaterThan(0);

      const rows = generateRows(spec, 300, { now: NOW, rng: seededRng(13) });
      for (const field of barcodes) {
        for (const row of rows) {
          expect(barcodeProblem(field.type, row[field.name]), `${id}.${field.name} (${field.type}) = ${row[field.name]}`)
            .toBeNull();
        }
      }
    });
  }
});

describe('built-in specs', () => {
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
