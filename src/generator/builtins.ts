/**
 * The generators that used to be hard-coded in Rust (`generate_random_data`), re-expressed as
 * specs so that "duplicate a built-in" copies a real, editable generator.
 *
 * Every rule here produces the same shape of value the Rust version did; the one deliberate
 * difference is that dates are relative to today instead of being frozen in 2026.
 */

import type { GeneratorSpec } from './spec';

const PRODUCT: GeneratorSpec = {
  version: 1,
  tables: {
    products: {
      columns: ['brand', 'name'],
      rows: [
        ['ケラスターセ', 'EC専用 SP バンディバレント R 250ml'],
        ['ミルボン', 'EC専用 ディーセス エルジューダ 120ml'],
        ['資生堂', 'EC専用 プロフェッショナル ヘアマスク 200g'],
        ['ロレアル', 'EC専用 セリエ エクスパート 500ml'],
      ],
    },
  },
  fields: {
    // Rust: format!("100{}", digits(4)) — the prefix is part of the 7 characters.
    itemBarcode: { kind: 'digits', length: 4, prefix: '100' },
    itemCodeText: { kind: 'copy', from: 'itemBarcode' },

    // The Rust version wrote a frozen "2610" era; this one is dated relative to today instead.
    issueDate: { kind: 'date', offsetDays: [-90, 0], format: 'YYMM DD', suffix: ' 再' },

    brandName: { kind: 'table', table: 'products', column: 'brand' },
    productName: { kind: 'table', table: 'products', column: 'name' },
    productCode: { kind: 'pattern', pattern: '035{d10}' },

    // The zone is one value shared by both fields: locCode rebuilds it from locZone, which already
    // carries the trailing dash ("35-" + "3" + "-" + "42" = "35-3-42").
    locZone: { kind: 'int', min: 10, max: 59, suffix: '-' },
    locCode: { kind: 'copy', from: 'locZone', pattern: '{from}{d1}-{d2}' },

    trackingBarcode: { kind: 'digits', length: 13 },
    trackingText: { kind: 'copy', from: 'trackingBarcode' },

    warehouse: { kind: 'fixed', value: 'Chiba・ロジ' },
    operator: { kind: 'fixed', value: 'SUJON MD SAIDUR' },
  },
};

export const BUILTIN_SPECS: Record<string, GeneratorSpec> = {
  product: PRODUCT,
};

/** A copy, so editing one label's generator cannot affect the built-in it started from. */
export const builtinSpec = (id: string): GeneratorSpec =>
  structuredClone(BUILTIN_SPECS[id] ?? { version: 1, fields: {} });
