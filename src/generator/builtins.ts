/**
 * The generators the built-in labels ship with. They are not editable in the Designer, and
 * "Duplicate" copies one into a label of your own.
 *
 * Every field keeps the shape of value the old Rust generator made; dates are relative to today.
 */

import type { GeneratorSpec } from './spec';

/**
 * The product label is a worked example: it prints with no network and no address typed, so a new
 * build has something to show that works straight away. Its values are fixed rather than read from
 * an API, which is what makes it self-contained — a label does not carry an address anyway, so an
 * `api` field here would need one typed every time before it could print.
 *
 * Duplicate it to get a copy you can map to a real API.
 */
const PRODUCT: GeneratorSpec = {
  version: 1,
  fields: {
    itemBarcode: { kind: 'digits', length: 8, prefix: '4901234' },
    itemCodeText: { kind: 'copy', from: 'itemBarcode' },

    issueDate: { kind: 'date', offsetDays: [0, 0], format: 'YYYY-MM-DD', suffix: ' 再' },

    brandName: { kind: 'fixed', value: 'Acme' },
    productName: { kind: 'fixed', value: 'Sample product' },
    productCode: { kind: 'fixed', value: 'SKU-0000' },

    // The zone is one value shared by both fields; the copy rule rebuilds it with the dash.
    locZone: { kind: 'fixed', value: '13-' },
    locCode: { kind: 'fixed', value: '04-50' },

    trackingBarcode: { kind: 'digits', length: 12 },
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
