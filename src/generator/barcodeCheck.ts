/**
 * What each barcode format will accept.
 *
 * pdfme throws (or silently drops the field) when a barcode's content does not fit its format, and
 * that would take the whole print job down, so the rules are checked while the user is still
 * editing: the constraint is shown next to the field, and a generated sample is verified before
 * it can be saved or printed.
 *
 * pdfme keeps its own `validateBarcodeInput` but does not export it (`@pdfme/schemas` blocks deep
 * imports), so the rules live here. Lengths given for the fixed-length formats are the payload
 * without the check digit, which the encoder adds.
 */

/** Characters a Codabar (nw7) barcode can use; start and stop must match and be one of these. */
const CODABAR = /^[0-9A-Da-d]$/;
/** Code 39's alphabet. */
const CODE39 = /^[0-9A-Z \-.$/+%]$/;

const digitsOnly = (lengths: number[]) => (value: string) => /^\d+$/.test(value) && lengths.includes(value.length);

const anyNonEmpty = (value: string) => value.length > 0;

export type BarcodeConstraint = {
  /** One line for the UI to show next to the field's rule. */
  hint: string;
  /** A digit length that produces a valid barcode, used when scaffolding a new field. */
  digits: number;
  /** Whether pdfme could encode this value in this format. */
  accepts: (value: string) => boolean;
  /** Why a value was rejected, for the error message. */
  reason: string;
};

const CONSTRAINTS: Record<string, BarcodeConstraint> = {
  qrcode: { hint: 'Any characters.', digits: 12, accepts: anyNonEmpty, reason: 'a QR code needs some content' },
  gs1datamatrix: { hint: 'Any characters.', digits: 12, accepts: anyNonEmpty, reason: 'needs some content' },
  pdf417: { hint: 'Any characters.', digits: 12, accepts: anyNonEmpty, reason: 'needs some content' },
  code128: { hint: 'Any characters.', digits: 12, accepts: anyNonEmpty, reason: 'needs some content' },

  japanpost: {
    hint: '13 characters: a 7-digit postcode then a 6-character address code.',
    digits: 13,
    accepts: (v) => v.length === 13,
    reason: 'a Japanese postal barcode is exactly 13 characters',
  },
  ean13: {
    hint: '12 digits; the check digit is added for you.',
    digits: 12,
    accepts: digitsOnly([12, 13]),
    reason: 'an EAN-13 barcode is 12 digits (or 13 with the check digit)',
  },
  ean8: {
    hint: '7 digits; the check digit is added for you.',
    digits: 7,
    accepts: digitsOnly([7, 8]),
    reason: 'an EAN-8 barcode is 7 digits (or 8 with the check digit)',
  },
  upca: {
    hint: '11 digits; the check digit is added for you.',
    digits: 11,
    accepts: digitsOnly([11, 12]),
    reason: 'a UPC-A barcode is 11 digits (or 12 with the check digit)',
  },
  upce: {
    hint: '7 digits; the check digit is added for you.',
    digits: 7,
    accepts: digitsOnly([7, 8]),
    reason: 'a UPC-E barcode is 7 digits (or 8 with the check digit)',
  },
  itf14: {
    hint: '13 digits; the check digit is added for you.',
    digits: 13,
    accepts: digitsOnly([13, 14]),
    reason: 'an ITF-14 barcode is 13 digits (or 14 with the check digit)',
  },
  code39: {
    hint: 'Digits and A-Z, plus space and - . $ / + %.',
    digits: 12,
    accepts: (v) => v.length > 0 && [...v].every((c) => CODE39.test(c)),
    reason: 'Code 39 only allows digits, A-Z, space and - . $ / + %',
  },
  nw7: {
    hint: 'Up to 20 characters of 0-9 and A-D; the first and last must match.',
    digits: 12,
    accepts: (v) => {
      if (v.length < 3 || v.length > 20) return false;
      if (![...v].every((c) => CODABAR.test(c))) return false;
      // Codabar frames the data with a start and stop character, which have to be the same.
      const first = v[0].toUpperCase();
      const last = v[v.length - 1].toUpperCase();
      return first === last && first >= 'A' && first <= 'D';
    },
    reason: 'a Codabar barcode is up to 20 characters of 0-9 and A-D, framed by the same letter',
  },
};

/** What is known about `type`, or undefined when it is not a barcode format. */
export const barcodeConstraint = (type: string): BarcodeConstraint | undefined => CONSTRAINTS[type];

/** The one-line constraint shown next to a barcode field's rule. */
export const barcodeHint = (type: string): string => CONSTRAINTS[type]?.hint ?? '';

/**
 * Checks one generated value against its barcode format.
 * Returns the reason it cannot be printed, or null when it is fine.
 */
export function barcodeProblem(type: string, value: string): string | null {
  const constraint = CONSTRAINTS[type];
  if (!constraint) return null;
  if (!constraint.accepts(value)) return constraint.reason;
  return null;
}
