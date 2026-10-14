/**
 * Reads a pdfme template and works out which fields can receive generated data, what each one
 * needs, and which generator rules have been left behind by a rename or a delete.
 *
 * Type-only imports from pdfme, so this stays free of runtime dependencies and easy to test.
 */

import type { Template } from '@pdfme/common';
import { barcodeConstraint, barcodeHint } from './barcodeCheck';
import { asFieldRule, type FieldRule, type GeneratorSpec } from './spec';

/**
 * pdfme's barcode formats, mirrored from `@pdfme/schemas` (src/barcodes/constants.js) because
 * the package does not export the list. The value is the field's `type`.
 */
const BARCODE_TYPES = [
  'qrcode', 'japanpost', 'ean13', 'ean8', 'code39', 'code128',
  'nw7', 'itf14', 'upca', 'upce', 'gs1datamatrix', 'pdf417',
] as const;

export const isBarcodeType = (type: string): boolean => (BARCODE_TYPES as readonly string[]).includes(type);

export type TemplateField = {
  name: string;
  /** pdfme's own `type` string ('text', 'code128', 'rectangle', …). */
  type: string;
  /** What sort of data the field can take. `other` is decoration such as a rectangle. */
  kind: 'text' | 'barcode' | 'qr' | 'image' | 'other';
  readOnly: boolean;
  /** For barcodes and QR codes: what the format will accept. */
  hint?: string;
};

const fieldKind = (type: string): TemplateField['kind'] => {
  if (isBarcodeType(type)) return type === 'qrcode' ? 'qr' : 'barcode';
  if (type === 'text') return 'text';
  if (type === 'image') return 'image';
  return 'other';
};

/** Every field in the template, in page and layout order, with duplicates reported once. */
export function templateFields(template: Template | null | undefined): TemplateField[] {
  const seen = new Set<string>();
  const out: TemplateField[] = [];
  for (const page of template?.schemas ?? []) {
    for (const schema of page ?? []) {
      const name = schema?.name?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const type = String(schema?.type ?? 'text');
      const kind = fieldKind(type);
      out.push({
        name,
        type,
        kind,
        readOnly: schema?.readOnly === true,
        hint: kind === 'barcode' || kind === 'qr' ? barcodeHint(type) : undefined,
      });
    }
  }
  return out;
}

/**
 * The fields that should get a rule: anything that is not read-only (those keep their own text)
 * and can hold content at all. Rectangles and images are decoration, not data.
 */
export const dataFields = (template: Template | null | undefined): TemplateField[] =>
  templateFields(template).filter(
    f => !f.readOnly && (f.kind === 'text' || f.kind === 'barcode' || f.kind === 'qr'),
  );

/** A rule that produces something valid for this field, used for fields the user has just added. */
export function defaultRuleFor(field: TemplateField): FieldRule {
  if (field.kind === 'barcode' || field.kind === 'qr') {
    return { kind: 'digits', length: barcodeConstraint(field.type)?.digits ?? 12 };
  }
  return { kind: 'pick', values: [field.name, `${field.name} 2`, `${field.name} 3`] };
}

/**
 * A spec with a rule for every data field in the template.
 *
 * Existing rules are kept as they are, so calling this after a layout change only fills in the
 * gaps and never overwrites something the user wrote.
 */
export function scaffoldSpec(template: Template, base?: GeneratorSpec): GeneratorSpec {
  const fields: Record<string, FieldRule> = { ...(base?.fields ?? {}) };
  for (const field of dataFields(template)) {
    if (!asFieldRule(fields[field.name])) fields[field.name] = defaultRuleFor(field);
  }
  return { version: 1, tables: base?.tables, fields };
}

/**
 * Rules whose field is no longer in the template — the field was renamed or deleted in the
 * Layout. They are kept rather than dropped so the work is not silently lost; the UI offers to
 * move them to another field or delete them.
 */
export function orphanRules(template: Template, spec: GeneratorSpec): string[] {
  const names = new Set(templateFields(template).map(f => f.name));
  return Object.keys(spec?.fields ?? {}).filter(name => !names.has(name));
}
