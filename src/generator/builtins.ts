/**
 * The generators the built-in labels ship with. They read the in-app mock API, are not editable in
 * the Designer, and "Duplicate" copies one into a label of your own.
 *
 * Every field keeps the shape of value the old Rust generator made; dates are relative to today.
 */

import { MOCK_PRODUCTS_URL } from './mockApi';
import type { GeneratorSpec } from './spec';

/**
 * The product label reads its data from the in-app mock API (`mockApi.ts`), like a label of your
 * own would read a real one. Each record holds finished values; the rules only pick them out.
 */
const PRODUCT: GeneratorSpec = {
  version: 1,
  source: {
    url: MOCK_PRODUCTS_URL,
    listPath: 'data',
    variables: { count: { label: 'Number of labels', default: '1' } },
  },
  fields: {
    itemBarcode: { kind: 'api', path: 'barcode' },
    itemCodeText: { kind: 'copy', from: 'itemBarcode' },

    issueDate: { kind: 'api', path: 'issued', suffix: ' 再' },

    brandName: { kind: 'api', path: 'brand' },
    productName: { kind: 'api', path: 'name' },
    productCode: { kind: 'api', path: 'productCode' },

    // The zone is one value shared by both fields; the API sends it without the trailing dash.
    locZone: { kind: 'api', path: 'location.zone', suffix: '-' },
    locCode: { kind: 'api', path: 'location.code' },

    trackingBarcode: { kind: 'api', path: 'tracking' },
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
