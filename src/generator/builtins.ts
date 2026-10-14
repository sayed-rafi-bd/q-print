/**
 * The generators that used to be hard-coded in Rust (`generate_random_data`), re-expressed as
 * specs so that "duplicate a built-in" copies a real, editable generator.
 *
 * Every rule here produces the same shape of value the Rust version did; the one deliberate
 * difference is that dates are relative to today instead of being frozen in 2026.
 */

import type { GeneratorSpec } from './spec';

const SHIPPING: GeneratorSpec = {
  version: 1,
  tables: {
    // One row per page, so the postcode and the address always belong to the same place.
    destinations: {
      columns: ['zip', 'address'],
      rows: [
        ['150-0021', '東京都渋谷区恵比寿西1-13-7'],
        ['100-0005', '東京都千代田区丸の内1-9-1'],
        ['530-0001', '大阪府大阪市北区梅田3-1-1'],
        ['460-0008', '愛知県名古屋市中区栄3-4-5'],
      ],
    },
  },
  fields: {
    zip: { kind: 'table', table: 'destinations', column: 'zip', prefix: '〒' },
    zipBarcode: { kind: 'table', table: 'destinations', column: 'zip', transforms: ['digits-only'] },
    address: { kind: 'table', table: 'destinations', column: 'address' },

    sortMain: { kind: 'digits', length: 4 },
    sortSub: { kind: 'digits', length: 3 },

    tel: { kind: 'digits', length: 10, prefix: 'TEL:0' },
    recipient: {
      kind: 'pick',
      values: ['トントンタン', '山田 太郎', '佐藤 花子', '鈴木 一郎'],
      suffix: '様',
    },

    inquiryNo: { kind: 'pattern', pattern: 'A{d12}A' },
    count: { kind: 'int', min: 1, max: 5 },
    carrierName: { kind: 'fixed', value: '佐川代引（LC）' },

    // Relative to today, so the label does not start lying next year.
    shipDate: { kind: 'date', offsetDays: [0, 0], format: 'YYYY/MM/DD' },
    deliveryDate: { kind: 'date', offsetDays: [2, 2], format: 'YYYY/MM/DD' },

    timeSlot: { kind: 'pick', values: ['午前中', '14時〜16時', '16時〜18時', '18時〜20時'] },
    amount: { kind: 'int', min: 100, max: 3900, step: 100, format: 'yen' },
    requestNo: { kind: 'digits', length: 9 },

    senderName: { kind: 'fixed', value: 'FMHテスト用(テスト環境00)' },
    senderZip: { kind: 'fixed', value: '〒150-0021' },
    senderAddress: { kind: 'fixed', value: '東京都渋谷区恵比寿西1-13-7' },
    senderBuilding: { kind: 'fixed', value: 'ＫＢＳアーチビル' },
    senderTel: { kind: 'fixed', value: 'TEL: 0357840340' },
  },
};

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
  shipping: SHIPPING,
  product: PRODUCT,
};

/** A copy, so editing one label's generator cannot affect the built-in it started from. */
export const builtinSpec = (id: string): GeneratorSpec =>
  structuredClone(BUILTIN_SPECS[id] ?? { version: 1, fields: {} });
