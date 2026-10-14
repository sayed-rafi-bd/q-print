/**
 * A ready-made label to try the app out on.
 *
 * Creating a label from blank gives an empty page, which is not much to go on. This is a small
 * printable label that is already filled in, and between them its fields show most of what the
 * Data tab can do: fixed text, a date that moves with today, values read from a table, per-page
 * numbering, a pattern, and one field built from another's value.
 *
 * It is a *starting point*, not a shipped label: choosing it writes an ordinary label of your own
 * that you can rename, edit and delete like any other. It deliberately never appears in the label
 * list until you make one.
 */

import type { Template } from '@pdfme/common';
import type { GeneratorSpec } from './generator/spec';

/** Preselected as the name when the sample is chosen. */
export const SAMPLE_LABEL_NAME = 'Sample label';

/** The size the sample is drawn for; the New dialog still lets the user change it. */
export const SAMPLE_SIZE: { widthMm: number; heightMm: number } = {
  widthMm: 100,
  heightMm: 50,
};

const text = (name: string, y: number, extra: Record<string, unknown> = {}) => ({
  type: 'text', name, content: '',
  position: { x: 4, y }, width: 92, height: 5, fontSize: 8, ...extra,
});

const SAMPLE_TEMPLATE = {
  basePdf: { width: SAMPLE_SIZE.widthMm, height: SAMPLE_SIZE.heightMm, padding: [0, 0, 0, 0] },
  schemas: [[
    {
      // Read-only, so it prints its own text and never gets a rule.
      type: 'text', name: 'title', content: 'Sample label',
      position: { x: 4, y: 3 }, width: 60, height: 7, fontSize: 13, readOnly: true,
    },
    text('note', 12, { width: 60, content: 'Change any of this in the Data tab.' }),
    text('madeOn', 18),
    text('city', 24),
    text('zip', 30, { width: 40 }),
    text('pageNo', 36, { width: 20 }),
    {
      type: 'code128', name: 'itemCode', content: '',
      position: { x: 4, y: 40 }, width: 92, height: 8, includetext: true,
    },
    text('itemCodeText', 40, { width: 92, fontSize: 6 }),
  ]],
} as unknown as Template;

const SAMPLE_SPEC: GeneratorSpec = {
  version: 1,
  tables: {
    // One row is chosen per page, so the postcode and the city always belong to the same place.
    cities: {
      columns: ['zip', 'city'],
      rows: [
        ['150-0021', 'Shibuya, Tokyo'],
        ['100-0005', 'Marunouchi, Tokyo'],
        ['530-0001', 'Umeda, Osaka'],
        ['460-0008', 'Sakae, Nagoya'],
      ],
    },
  },
  fields: {
    // `title` is read-only and so is absent here: a template field with no rule prints its own text.
    note: { kind: 'fixed', value: 'Change any of this in the Data tab.' },
    madeOn: { kind: 'date', offsetDays: [0, 0], format: 'YYYY-MM-DD' },
    city: { kind: 'table', table: 'cities', column: 'city' },
    zip: { kind: 'table', table: 'cities', column: 'zip', prefix: '〒' },
    pageNo: { kind: 'sequence', start: 1, pad: 4 },
    itemCode: { kind: 'pattern', pattern: '20{d10}' },
    // The same value as the barcode above, as readable text.
    itemCodeText: { kind: 'copy', from: 'itemCode' },
  },
};

/** Deep copies, so the caller's label can be resized and edited without touching the bundle. */
export const sampleTemplate = (): Template => structuredClone(SAMPLE_TEMPLATE);
export const sampleSpec = (): GeneratorSpec => structuredClone(SAMPLE_SPEC);
