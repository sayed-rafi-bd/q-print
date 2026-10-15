/**
 * The data the preview feeds to pdfme.
 *
 * With a fetched sample, the first records are used as they are. Without one, `api` fields have
 * nothing to read, so the engine prints their path as `‹path›`. That is fine in a text field, but
 * a barcode cannot encode it and pdfme rejects it, which used to make the whole preview fail.
 * Here such barcode fields get a value their format accepts instead, so the page still renders.
 */

import type { Template } from '@pdfme/common';
import { barcodeConstraint } from './barcodeCheck';
import { generateRows, generateRowsFromRecords } from './engine';
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

export type PreviewData = {
  inputs: Record<string, string>[];
  /** Names of barcode fields that show a made-up value because the API has not been fetched. */
  standInBarcodes: string[];
};

/** Up to three pages of preview data; see the file comment for what a missing sample means. */
export function previewInputs(
  template: Template,
  spec: GeneratorSpec,
  sample: unknown[] | null | undefined,
  pages = 3,
): PreviewData {
  if (spec.source && sample && sample.length > 0) {
    return { inputs: generateRowsFromRecords(spec, sample.slice(0, pages), 1), standInBarcodes: [] };
  }

  const inputs = generateRows(spec, pages, { placeholders: Boolean(spec.source) });
  const standIn = new Set<string>();
  if (spec.source) {
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
  return { inputs, standInBarcodes: [...standIn] };
}
