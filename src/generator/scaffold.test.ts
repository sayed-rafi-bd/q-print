import type { Template } from '@pdfme/common';
import { describe, expect, it } from 'vitest';
import product from '../templates/product-label.json';
import { barcodeHint, barcodeProblem } from './barcodeCheck';
import { builtinSpec } from './builtins';
import { generateRows, validateSpec } from './engine';
import { dataFields, defaultRuleFor, orphanRules, scaffoldSpec, templateFields } from './scaffold';
import type { GeneratorSpec } from './spec';

const blank = (schemas: unknown[]): Template =>
  ({ basePdf: { width: 100, height: 50, padding: [0, 0, 0, 0] }, schemas: [schemas] }) as unknown as Template;

describe('templateFields', () => {
  it('lists every field once, in layout order', () => {
    const names = templateFields(product as unknown as Template).map((f) => f.name);
    expect(names[0]).toBe('itemBarcode');
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('trackingBarcode');
  });

  it('tells text, barcode, QR and image fields apart', () => {
    const fields = templateFields(
      blank([
        { name: 'a', type: 'text' },
        { name: 'b', type: 'code128' },
        { name: 'c', type: 'qrcode' },
        { name: 'd', type: 'image' },
      ]),
    );
    expect(fields.map((f) => f.kind)).toEqual(['text', 'barcode', 'qr', 'image']);
  });

  it('leaves out fields with no name', () => {
    expect(
      templateFields(
        blank([
          { name: '', type: 'text' },
          { name: '  ', type: 'text' },
          { name: 'ok', type: 'text' },
        ]),
      ),
    ).toHaveLength(1);
  });

  it('survives an empty or broken template', () => {
    expect(templateFields(null)).toEqual([]);
    expect(templateFields({ schemas: [] } as unknown as Template)).toEqual([]);
  });
});

describe('dataFields', () => {
  it('skips read-only fields, which print their own text', () => {
    // A caption that prints its own text should never get a rule.
    const names = dataFields(
      blank([
        { name: 'lblCaption', type: 'text', readOnly: true },
        { name: 'value', type: 'text' },
      ]),
    ).map((f) => f.name);
    expect(names).not.toContain('lblCaption');
    expect(names).toContain('value');
  });

  it('skips decoration such as rectangles and images, which have no content to fill', () => {
    const fields = dataFields(
      blank([
        { name: 'logo', type: 'image' },
        { name: 'box', type: 'rectangle' },
        { name: 'rule', type: 'line' },
        { name: 'a', type: 'text' },
      ]),
    );
    expect(fields.map((f) => f.name)).toEqual(['a']);
  });

  it('can fill every field the product generator fills', () => {
    // The other way round is not required: a template may hold fields that print their own text.
    const fillable = new Set(dataFields(product as unknown as Template).map((f) => f.name));
    for (const name of Object.keys(builtinSpec('product').fields)) {
      expect(fillable.has(name), `${name} has a rule but cannot take data`).toBe(true);
    }
  });
});

describe('defaultRuleFor', () => {
  it('gives a text field some obvious placeholder values', () => {
    expect(defaultRuleFor({ name: 'title', type: 'text', kind: 'text', readOnly: false })).toEqual({
      kind: 'pick',
      values: ['title', 'title 2', 'title 3'],
    });
  });

  it('gives each barcode format a length it can actually encode', () => {
    const lengthFor = (type: string) =>
      (defaultRuleFor({ name: 'b', type, kind: 'barcode', readOnly: false }) as { length: number }).length;
    expect(lengthFor('ean13')).toBe(12);
    expect(lengthFor('ean8')).toBe(7);
    expect(lengthFor('upca')).toBe(11);
    expect(lengthFor('upce')).toBe(7);
    expect(lengthFor('itf14')).toBe(13);
    expect(lengthFor('japanpost')).toBe(13);
    expect(lengthFor('code128')).toBe(12);
  });

  it('produces a rule whose values the format accepts', () => {
    for (const type of ['ean13', 'ean8', 'upca', 'upce', 'itf14', 'code128', 'code39']) {
      const rule = defaultRuleFor({ name: 'b', type, kind: 'barcode', readOnly: false });
      const value = generateRows({ version: 1, fields: { b: rule } }, 1)[0].b;
      expect(barcodeProblem(type, value), `${type} -> ${value}`).toBeNull();
    }
  });
});

describe('scaffoldSpec', () => {
  it('adds a rule for every data field', () => {
    const spec = scaffoldSpec(
      blank([
        { name: 'a', type: 'text' },
        { name: 'b', type: 'code128' },
      ]),
    );
    expect(Object.keys(spec.fields).sort()).toEqual(['a', 'b']);
    expect(validateSpec(spec)).toEqual([]);
  });

  it('leaves read-only fields alone', () => {
    const spec = scaffoldSpec(
      blank([
        { name: 'a', type: 'text' },
        { name: 'lbl', type: 'text', readOnly: true },
      ]),
    );
    expect(Object.keys(spec.fields)).toEqual(['a']);
  });

  it('never overwrites a rule the user already wrote', () => {
    const mine: GeneratorSpec = { version: 1, fields: { a: { kind: 'fixed', value: 'mine' } } };
    const spec = scaffoldSpec(
      blank([
        { name: 'a', type: 'text' },
        { name: 'new', type: 'text' },
      ]),
      mine,
    );
    expect(spec.fields.a).toEqual({ kind: 'fixed', value: 'mine' });
    expect(spec.fields.new).toBeDefined();
  });

  it('fills a field whose rule is not one it recognises', () => {
    const spec = scaffoldSpec(blank([{ name: 'a', type: 'text' }]), {
      version: 1,
      fields: { a: { kind: 'nonsense' } as never },
    });
    expect(spec.fields.a.kind).toBe('pick');
  });

  it('carries the tables over from the spec it was given', () => {
    const base = { version: 1 as const, tables: { t: { columns: ['c'], rows: [['1']] } }, fields: {} };
    expect(scaffoldSpec(blank([{ name: 'a', type: 'text' }]), base).tables).toBe(base.tables);
  });

  it('generates rows for a freshly scaffolded product label', () => {
    const spec = scaffoldSpec(product as unknown as Template);
    expect(validateSpec(spec)).toEqual([]);
    expect(() => generateRows(spec, 3)).not.toThrow();
  });
});

describe('orphanRules', () => {
  it('reports rules whose field is gone', () => {
    const template = blank([{ name: 'a', type: 'text' }]);
    const spec = {
      version: 1 as const,
      fields: { a: { kind: 'fixed' as const, value: 'x' }, gone: { kind: 'fixed' as const, value: 'y' } },
    };
    expect(orphanRules(template, spec)).toEqual(['gone']);
  });

  it('reports a rule whose field was renamed', () => {
    const spec = { version: 1 as const, fields: { oldName: { kind: 'fixed' as const, value: 'x' } } };
    expect(orphanRules(blank([{ name: 'newName', type: 'text' }]), spec)).toEqual(['oldName']);
  });

  it('reports nothing when every rule still matches a field', () => {
    const spec = { version: 1 as const, fields: { a: { kind: 'fixed' as const, value: 'x' } } };
    expect(
      orphanRules(
        blank([
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text' },
        ]),
        spec,
      ),
    ).toEqual([]);
  });
});

describe('barcodeProblem', () => {
  it('accepts content each format really allows', () => {
    expect(barcodeProblem('code128', 'ABC-123')).toBeNull();
    expect(barcodeProblem('ean13', '123456789012')).toBeNull();
    expect(barcodeProblem('ean13', '1234567890128')).toBeNull();
    expect(barcodeProblem('nw7', 'A123456789012A')).toBeNull();
    expect(barcodeProblem('nw7', 'D12D')).toBeNull();
    expect(barcodeProblem('code39', 'ABC 123')).toBeNull();
    expect(barcodeProblem('qrcode', 'https://example.com')).toBeNull();
  });

  it('rejects content a format would fail to encode', () => {
    expect(barcodeProblem('ean13', '12345')).toMatch(/12 digits/);
    expect(barcodeProblem('ean13', '12345678901a')).toMatch(/12 digits/);
    expect(barcodeProblem('nw7', 'A123456789012B')).toMatch(/framed by the same letter/);
    expect(barcodeProblem('nw7', 'E123E')).toMatch(/0-9 and A-D/);
    expect(barcodeProblem('code39', 'lower')).toMatch(/Code 39/);
    expect(barcodeProblem('japanpost', '1234567')).toMatch(/13 characters/);
    expect(barcodeProblem('code128', '')).toMatch(/needs some content/);
  });

  it('says nothing about a field that is not a barcode', () => {
    expect(barcodeProblem('text', 'anything at all')).toBeNull();
  });

  it('has a hint for every format it knows', () => {
    expect(barcodeHint('code128')).not.toBe('');
    expect(barcodeHint('nope')).toBe('');
  });
});

describe('scaffoldSpec with api rules', () => {
  it('keeps the api rules and only fills in the gaps', () => {
    const base: GeneratorSpec = { version: 1, fields: { a: { kind: 'api', path: 'user.name' } } };
    const out = scaffoldSpec(
      blank([
        { name: 'a', type: 'text' },
        { name: 'b', type: 'text' },
      ]),
      base,
    );
    expect(out.fields.a).toEqual({ kind: 'api', path: 'user.name' });
    expect(out.fields.b?.kind).toBe('pick');
    // Nothing to keep but rules and tables: a label holds no address.
    expect(Object.keys(out).sort()).toEqual(['fields', 'tables', 'version']);
  });

  it('keeps an api rule whose field was renamed, as an orphan', () => {
    const base: GeneratorSpec = { version: 1, fields: { gone: { kind: 'api', path: 'x' } } };
    expect(orphanRules(blank([{ name: 'a', type: 'text' }]), base)).toEqual(['gone']);
  });
});
