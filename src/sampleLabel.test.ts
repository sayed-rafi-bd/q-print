import { describe, expect, it } from 'vitest';
import { SAMPLE_LABEL_NAME, SAMPLE_SIZE, sampleSpec, sampleTemplate } from './sampleLabel';
import { generateRows, validateSpec } from './generator/engine';
import { barcodeProblem } from './generator/barcodeCheck';
import { dataFields, orphanRules } from './generator/scaffold';
import { templateSizeMm } from './bundle';
import type { Template } from '@pdfme/common';

const NOW = new Date(2026, 9, 14); // 2026-10-14

function seededRng(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('the sample label', () => {
  const template = sampleTemplate();
  const spec = sampleSpec();

  it('is a usable generator, so it can be created and saved', () => {
    expect(validateSpec(spec)).toEqual([]);
  });

  it('has a page of the size it says it does', () => {
    expect(templateSizeMm(template)).toEqual(SAMPLE_SIZE);
    expect(SAMPLE_LABEL_NAME).toBe('Sample label');
  });

  it('gives every field in the template that can take data a rule', () => {
    // The whole point of the sample is that it prints, so nothing may be left unfilled.
    expect(dataFields(template).map(f => f.name).sort()).toEqual(Object.keys(spec.fields).sort());
  });

  it('has no rule pointing at a field that is not there', () => {
    expect(orphanRules(template, spec)).toEqual([]);
  });

  it('leaves the read-only heading to print its own text', () => {
    expect(spec.fields).not.toHaveProperty('title');
  });

  it('fills every field with something, for every page', () => {
    const rows = generateRows(spec, 50, { now: NOW, rng: seededRng(7) });
    for (const row of rows) {
      for (const name of Object.keys(spec.fields)) {
        expect(row[name], `${name} was empty`).not.toBe('');
      }
    }
  });

  it('dates the label today, whenever today is', () => {
    for (const now of [new Date(2026, 0, 1), new Date(2027, 6, 4)]) {
      const [row] = generateRows(spec, 1, { now, rng: seededRng() });
      expect(row.madeOn).toBe(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      );
    }
  });

  it('keeps the postcode and the city on the same destination', () => {
    const byCity: Record<string, string> = {
      'Shibuya, Tokyo': '〒150-0021',
      'Marunouchi, Tokyo': '〒100-0005',
      'Umeda, Osaka': '〒530-0001',
      'Sakae, Nagoya': '〒460-0008',
    };
    for (const row of generateRows(spec, 100, { now: NOW, rng: seededRng(11) })) {
      expect(row.zip).toBe(byCity[row.city]);
    }
  });

  it('numbers the pages and repeats the barcode as text', () => {
    const rows = generateRows(spec, 4, { now: NOW, rng: seededRng(13) });
    expect(rows.map(r => r.pageNo)).toEqual(['0001', '0002', '0003', '0004']);
    for (const row of rows) expect(row.itemCodeText).toBe(row.itemCode);
  });

  it('generates content its barcode can actually encode', () => {
    // The sample must not be the thing that fails a user's first print job.
    const barcodes = dataFields(template).filter(f => f.kind === 'barcode' || f.kind === 'qr');
    expect(barcodes.map(f => f.type)).toContain('code128');
    for (const row of generateRows(spec, 200, { now: NOW, rng: seededRng(17) })) {
      for (const field of barcodes) {
        expect(barcodeProblem(field.type, row[field.name]), `${field.name} = ${row[field.name]}`).toBeNull();
      }
    }
  });

  it('hands out copies, so editing one sample cannot change the next', () => {
    const first = sampleTemplate() as Template & { basePdf: { width: number } };
    first.basePdf.width = 999;
    expect(templateSizeMm(sampleTemplate())).toEqual(SAMPLE_SIZE);

    const specA = sampleSpec();
    specA.fields.note = { kind: 'fixed', value: 'changed' };
    expect(sampleSpec().fields.note).not.toEqual({ kind: 'fixed', value: 'changed' });
  });
});
