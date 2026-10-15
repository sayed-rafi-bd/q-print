import type { Template } from '@pdfme/common';
import { describe, expect, it } from 'vitest';
import { barcodeProblem } from './barcodeCheck';
import { barcodeStandIn, defaultPreviewValues, previewInputs } from './previewInputs';
import type { GeneratorSpec } from './spec';

const template = {
  basePdf: { width: 100, height: 50, padding: [0, 0, 0, 0] },
  schemas: [
    [
      { type: 'text', name: 'name', content: '', position: { x: 0, y: 0 }, width: 50, height: 5 },
      { type: 'ean13', name: 'ean', content: '', position: { x: 0, y: 10 }, width: 50, height: 10 },
      { type: 'qrcode', name: 'qr', content: '', position: { x: 0, y: 20 }, width: 20, height: 20 },
    ],
  ],
} as unknown as Template;

const spec: GeneratorSpec = {
  version: 1,
  source: { url: 'api.example.com/items' },
  fields: {
    name: { kind: 'api', path: 'user.name' },
    ean: { kind: 'api', path: 'ean' },
    qr: { kind: 'api', path: 'link' },
  },
};

describe('barcodeStandIn', () => {
  it.each(['qrcode', 'code128', 'ean13', 'ean8', 'upca', 'upce', 'itf14', 'code39', 'nw7', 'japanpost', 'pdf417'])(
    'is accepted by %s',
    (type) => {
      expect(barcodeProblem(type, barcodeStandIn(type))).toBeNull();
    },
  );
});

describe('previewInputs without a sample', () => {
  it('keeps the path in text fields and gives barcodes a valid value', () => {
    const { inputs, standInBarcodes } = previewInputs(template, spec, null);
    expect(inputs).toHaveLength(3);
    expect(inputs[0].name).toBe('‹user.name›');
    expect(barcodeProblem('ean13', inputs[0].ean)).toBeNull();
    expect(inputs[0].qr).not.toContain('‹');
    expect(standInBarcodes.sort()).toEqual(['ean', 'qr']);
  });
});

describe('previewInputs with a sample', () => {
  it('uses the real values and replaces nothing', () => {
    const sample = [{ user: { name: 'Aki' }, ean: '123', link: 'x' }];
    const { inputs, standInBarcodes } = previewInputs(template, spec, sample);
    expect(inputs).toEqual([{ name: 'Aki', ean: '123', qr: 'x' }]);
    expect(standInBarcodes).toEqual([]);
  });
});

describe('typed placeholder values', () => {
  it('outrank the fetched record', () => {
    const sample = [{ user: { name: 'Aki' }, ean: '123', link: 'x' }];
    const { inputs, typedFields } = previewInputs(template, spec, sample, { name: 'My widget' });
    expect(inputs[0].name).toBe('My widget');
    expect(inputs[0].ean).toBe('123'); // the fields not named still come from the record
    expect(typedFields).toEqual(['name']);
  });

  it('outrank the path shown when nothing has been fetched', () => {
    const { inputs } = previewInputs(template, spec, null, { name: 'My widget', qr: 'hello' });
    expect(inputs[0].name).toBe('My widget');
    expect(inputs[0].qr).toBe('hello');
    expect(inputs[1].name).toBe('My widget'); // constant on every page, unlike a rule
  });

  it('leave the barcode stand-in alone for fields it does not name', () => {
    const { inputs, standInBarcodes } = previewInputs(template, spec, null, { name: 'My widget' });
    expect(barcodeProblem('ean13', inputs[0].ean)).toBeNull();
    expect(standInBarcodes.sort()).toEqual(['ean', 'qr']);
  });

  it('are ignored for a field the template no longer has, so a renamed field starts clean', () => {
    const { inputs, typedFields } = previewInputs(template, spec, null, { gone: 'x' });
    expect(typedFields).toEqual([]);
    expect(inputs[0].name).toBe('‹user.name›');
  });

  it('are ignored when empty, so clearing one really clears it', () => {
    const { typedFields, inputs } = previewInputs(template, spec, null, { name: '' });
    expect(typedFields).toEqual([]);
    expect(inputs[0].name).toBe('‹user.name›');
  });

  it('reach a label with no API source too', () => {
    const plain: GeneratorSpec = { version: 1, fields: { name: { kind: 'fixed', value: 'Designed in' } } };
    const { inputs, typedFields } = previewInputs(template, plain, null, { name: 'My widget' });
    expect(typedFields).toEqual(['name']);
    expect(inputs[0].name).toBe('My widget');
  });

  it('do not reach a print job: generateRows is untouched by them', async () => {
    // The print path never receives these values, so a placeholder cannot leak into real output.
    const { generateRows } = await import('./engine');
    expect(generateRows(spec, 1, { placeholders: true })[0].name).toBe('‹user.name›');
  });
});

describe('defaultPreviewValues', () => {
  it('gives every field something, with a value each barcode format accepts', () => {
    const values = defaultPreviewValues(template);
    expect(Object.keys(values).sort()).toEqual(['ean', 'name', 'qr']);
    expect(barcodeProblem('ean13', values.ean)).toBeNull();
    expect(barcodeProblem('qrcode', values.qr)).toBeNull();
  });

  it('keeps what is already typed, so filling again is not destructive', () => {
    const values = defaultPreviewValues(template, { name: 'Mine' });
    expect(values.name).toBe('Mine');
    expect(values.ean).not.toBe('');
  });

  it('fills a cleared field again, because the button asks for every field to have one', () => {
    const values = defaultPreviewValues(template, { name: '' });
    expect(values.name).toBe('name sample');
  });
});
