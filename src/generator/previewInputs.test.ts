import type { Template } from '@pdfme/common';
import { describe, expect, it } from 'vitest';
import { barcodeProblem } from './barcodeCheck';
import { barcodeStandIn, previewInputs } from './previewInputs';
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
