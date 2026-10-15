/**
 * The data the preview feeds to pdfme.
 *
 * Where a value comes from, highest first:
 *
 * 1. A placeholder the person typed for that field (`stored`).
 * 2. A record fetched from the label's API in the Source pane.
 * 3. The field's own rule, generated as it would be at print time.
 * 4. For an `api` field with nothing to read: its path as `‹path›`. That is fine in a text field,
 *    but a barcode cannot encode it and pdfme rejects it, which used to make the whole preview fail.
 *    Those barcode fields get a value their format accepts instead, so the page still renders.
 *
 * Nothing here reaches a print job: `printRows.ts` builds those from the real records.
 */

import type { Template } from '@pdfme/common';
import { barcodeConstraint } from './barcodeCheck';
import { generateRows, generateRowsFromRecords, hasApiRules } from './engine';
import { templateFields } from './scaffold';
import type { GeneratorSpec } from './spec';

/** Marks a value the engine made up for an `api` field that has no record. */
const STAND_IN = /‹[^›]*›/;

/** A value `type` is guaranteed to accept, for a barcode that has no real data to show. */
export function barcodeStandIn(type: string): string {
  switch (type) {
    // Codabar must start and end with the same A-D frame character.
    case 'nw7':
      return 'A1234567A';
    // A 7-digit postcode and a 6-character address code.
    case 'japanpost':
      return '1500021123456';
    default: {
      const digits = barcodeConstraint(type)?.digits ?? 12;
      return '1234567890123456789'.slice(0, digits);
    }
  }
}

/** Field name to the value the person typed. The same shape as the stored row. */
export type PreviewValues = Record<string, string>;

export type PreviewData = {
  inputs: Record<string, string>[];
  /** Field names previewed with a value the person typed. */
  typedFields: string[];
  /**
   * Barcode fields showing a made-up value, because neither a placeholder nor the API gave them one.
   */
  standInBarcodes: string[];
};

/**
 * Only the entries for fields the template still has. A field renamed or deleted in the Layout must
 * not go on deciding what a page shows. An empty value is dropped too, so clearing one works.
 */
export function usableValues(template: Template, stored: PreviewValues | null | undefined): PreviewValues {
  if (!stored) return {};
  const names = new Set(templateFields(template).map((f) => f.name));
  const kept: PreviewValues = {};
  for (const [name, value] of Object.entries(stored)) {
    if (names.has(name) && typeof value === 'string' && value !== '') kept[name] = value;
  }
  return kept;
}

/** Writes the typed values over every page. Placeholders are constant; rules still vary per page. */
const applyTyped = (inputs: Record<string, string>[], typed: PreviewValues): void => {
  for (const row of inputs) {
    for (const [name, value] of Object.entries(typed)) row[name] = value;
  }
};

/**
 * A placeholder for every field, for the "Fill with placeholders" button.
 *
 * A barcode or QR field gets a value its format accepts, so the preview cannot fail on a page the
 * person only wanted to look at; a text field gets something readable. Existing values are kept, so
 * filling again does not throw away what was already typed.
 */
export function defaultPreviewValues(template: Template, current: PreviewValues = {}): PreviewValues {
  const values: PreviewValues = { ...current };
  for (const field of templateFields(template)) {
    if (values[field.name] !== undefined && values[field.name] !== '') continue;
    values[field.name] =
      field.kind === 'barcode' || field.kind === 'qr' ? barcodeStandIn(field.type) : `${field.name} sample`;
  }
  return values;
}

/** Up to three pages of preview data; see the file comment for where each value comes from. */
export function previewInputs(
  template: Template,
  spec: GeneratorSpec,
  sample: unknown[] | null | undefined,
  stored: PreviewValues | null | undefined = null,
  pages = 3,
): PreviewData {
  const typed = usableValues(template, stored);
  const typedFields = Object.keys(typed);
  // Records only ever come from a test the person just ran in the Designer: a label carries no
  // address, so there is nothing to fetch here by itself.
  const records = sample && sample.length > 0 ? sample.slice(0, pages) : null;
  const usesApi = hasApiRules(spec);

  let inputs: Record<string, string>[];
  if (records) {
    // Real records, with any typed value written over the fields it names.
    inputs = generateRowsFromRecords(spec, records, 1);
  } else {
    // With no record to read, an `api` field shows its path rather than failing.
    inputs = generateRows(spec, pages, { placeholders: usesApi });
  }
  applyTyped(inputs, typed);

  // A typed value is already a real value, so it is never one of these stand-ins; replacing is
  // driven by what is left, not by whether anything at all was typed.
  const standIn = new Set<string>();
  if (usesApi) {
    for (const field of templateFields(template)) {
      if (field.kind !== 'barcode' && field.kind !== 'qr') continue;
      for (const row of inputs) {
        // Only a value the engine made up is replaced. A real value that a format rejects must
        // still reach pdfme, because catching that is what the preview is for.
        if (typeof row[field.name] === 'string' && STAND_IN.test(row[field.name])) {
          row[field.name] = barcodeStandIn(field.type);
          standIn.add(field.name);
        }
      }
    }
  }

  return { inputs, typedFields, standInBarcodes: [...standIn] };
}
