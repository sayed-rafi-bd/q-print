import type { Template } from '@pdfme/common';
import { describe, expect, it } from 'vitest';
import { bundleJson, isBundle, isTemplate, makeBundle, parseBundle, parseTemplate, templateSizeMm } from './bundle';
import { builtinSpec } from './generator/builtins';
import { isValidId, slugify } from './labelId';
import product from './templates/product-label.json';

const template = product as unknown as Template;

describe('slugify', () => {
  it('makes a usable id out of a name', () => {
    expect(slugify('My Parcel Label')).toBe('my-parcel-label');
    expect(slugify('Product label (Chiba)')).toBe('product-label-chiba');
    expect(slugify('A4 stickers')).toBe('a4-stickers');
  });

  it('never produces an id the backend would reject', () => {
    const names = ['Parcel 2', '---', '  ', 'Trailing---', 'Über Label', 'ラベル', 'a'.repeat(80), 'UPPER'];
    for (const name of names) {
      const id = slugify(name);
      expect(isValidId(id), `${name} -> ${id}`).toBe(true);
      expect(id.length).toBeLessThanOrEqual(40);
    }
  });

  it('falls back when the name holds nothing usable', () => {
    expect(slugify('ラベル')).toBe('label');
    expect(slugify('')).toBe('label');
    expect(slugify('!!!')).toBe('label');
  });

  it('adds a number when the id is taken', () => {
    expect(slugify('Parcel', ['parcel'])).toBe('parcel-2');
    expect(slugify('Parcel', ['parcel', 'parcel-2'])).toBe('parcel-3');
  });

  it('keeps the number inside the length limit', () => {
    const id = slugify('x'.repeat(60), ['x'.repeat(60)]);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(isValidId(id)).toBe(true);
  });

  it('agrees with the Rust rule on the examples in its tests', () => {
    for (const id of ['a', '0', 'shipping', 'my-parcel-2', 'a'.repeat(40)]) expect(isValidId(id)).toBe(true);
    for (const id of ['', '-lead', 'Upper', 'a/b', 'a.b', '..', 'a'.repeat(41)]) expect(isValidId(id)).toBe(false);
  });
});

describe('parseTemplate', () => {
  it('reads a pdfme template', () => {
    expect(parseTemplate(JSON.stringify(template)).schemas).toHaveLength(1);
  });

  it('rejects text that is not JSON, with a readable reason', () => {
    expect(() => parseTemplate('not json')).toThrow(/Not valid JSON/);
  });

  it('rejects JSON that is not a template', () => {
    expect(() => parseTemplate('{"hello":1}')).toThrow(/does not look like a pdfme template/);
    expect(() => parseTemplate('[]')).toThrow(/does not look like a pdfme template/);
    expect(() => parseTemplate('null')).toThrow(/does not look like a pdfme template/);
  });
});

describe('bundles', () => {
  const bundle = makeBundle('My parcel', template, builtinSpec('product'));

  it('round-trips through text', () => {
    const back = parseBundle(bundleJson(bundle));
    expect(back.bundle).toBeDefined();
    expect(back.bundle!.name).toBe('My parcel');
    expect(back.bundle!.generator).toEqual(bundle.generator);
    expect(isTemplate(back.bundle!.template)).toBe(true);
  });

  it('survives a round trip through the JSON the backend would store', () => {
    // What list_custom_labels parses when it only wants the name and the size.
    const text = JSON.stringify(bundle);
    expect(JSON.parse(text).name).toBe('My parcel');
    expect(JSON.parse(text).template.basePdf.width).toBe(190);
  });

  it('is recognised as a bundle, and a bare template is not', () => {
    expect(isBundle(bundle)).toBe(true);
    expect(isBundle(template)).toBe(false);
    expect(isBundle({ format: 'something-else' })).toBe(false);
    expect(isBundle(null)).toBe(false);
  });

  it('reads a bare template as a template, for files written by older versions', () => {
    const parsed = parseBundle(JSON.stringify(template));
    expect(parsed.bundle).toBeUndefined();
    expect(isTemplate(parsed.template)).toBe(true);
  });

  it('refuses a bundle whose generator cannot run, and says which field', () => {
    const broken = makeBundle('Bad', template, { version: 1, fields: { zip: { kind: 'pick', values: [] } } });
    expect(() => parseBundle(JSON.stringify(broken))).toThrow(/data generator is not usable.*“zip”/s);
  });

  it('refuses an unsupported generator version rather than printing nothing', () => {
    const broken = makeBundle('Future', template, { version: 2, fields: {} } as never);
    expect(() => parseBundle(JSON.stringify(broken))).toThrow(/version/i);
  });

  it('refuses a file over the size cap', () => {
    const huge = `{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`;
    expect(() => parseBundle(huge)).toThrow(/the limit is 5 MB/);
  });
});

describe('templateSizeMm', () => {
  it('reads the page size pdfme stores, in millimetres', () => {
    expect(templateSizeMm(template)).toEqual({ widthMm: 190, heightMm: 160 });
  });

  it('returns null for something that is not a sized template', () => {
    expect(templateSizeMm(null)).toBeNull();
    expect(templateSizeMm({ schemas: [] } as unknown as Template)).toBeNull();
    expect(templateSizeMm({ basePdf: { width: 0, height: 10 } } as unknown as Template)).toBeNull();
    expect(templateSizeMm({ basePdf: 'A4' } as unknown as Template)).toBeNull();
  });
});

describe('a label with an API data source', () => {
  const generator = {
    version: 1 as const,
    source: {
      url: 'api.example.com/day/{day}',
      listPath: 'data',
      bearerAuth: true,
      variables: { day: { label: 'Day', default: '1' } },
    },
    fields: { a: { kind: 'api' as const, path: 'user.name' } },
  };

  it('round-trips through a label file', () => {
    const json = bundleJson(makeBundle('Api label', template, generator));
    expect(parseBundle(json).bundle?.generator).toEqual(generator);
  });

  it('has no place for an access token in the exported file', () => {
    const json = bundleJson(makeBundle('Api label', template, generator));
    expect(json.toLowerCase()).not.toContain('token');
    expect(Object.keys(generator.source).sort()).toEqual(['bearerAuth', 'listPath', 'url', 'variables']);
  });

  it('refuses a file that smuggles a token into the source', () => {
    const withToken = { ...generator, source: { ...generator.source, token: 'abc' } };
    const bad = makeBundle('Api label', template, withToken as never);
    expect(() => parseBundle(bundleJson(bad))).toThrow(/unknown setting “token”/);
  });

  it('refuses an import whose URL is not usable', () => {
    const bad = makeBundle('Api label', template, { ...generator, source: { url: 'file:///etc/passwd' } });
    expect(() => parseBundle(bundleJson(bad))).toThrow(/Only http and https/);
  });
});
