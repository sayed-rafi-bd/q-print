/**
 * The declarative generator format.
 *
 * A generator is data, not code: each template field gets one rule saying how to fill it, and one
 * small engine interprets the rules. That is what lets a user define their own data without
 * recompiling the app, while still running identically on desktop and Android.
 *
 * Keep this file free of runtime imports — it is shared by the engine, the UI and the tests.
 */

/** A table of literal values that several fields can read from, so they stay consistent. */
export type GeneratorTable = {
  /** Column names. A `table` rule names one of these. */
  columns: string[];
  /** Row values, in the same order as `columns`. */
  rows: string[][];
};

export type Transform = 'digits-only' | 'upper' | 'lower';

export type IntFormat = 'plain' | 'thousands' | 'yen';

/** Applied to every kind, after the rule produced its value. */
type Common = {
  /** Put in front of the value ("〒" for a Japanese postcode). */
  prefix?: string;
  /** Put after the value ("様" for an honorific). */
  suffix?: string;
  /** Applied in order, before the prefix/suffix. */
  transforms?: Transform[];
};

export type FieldRule = Common &
  /** Always the same text. */
  (
    | { kind: 'fixed'; value: string }
    /** N random digits, e.g. a 13-digit tracking number. */
    | { kind: 'digits'; length: number }
    /** A whole number in a range, optionally stepped. */
    | { kind: 'int'; min: number; max: number; step?: number; format?: IntFormat }
    /** One of a fixed list, e.g. a name or a time slot. */
    | { kind: 'pick'; values: string[] }
    /** One cell of a table. All fields reading the same table share a row for the whole page. */
    | { kind: 'table'; table: string; column: string }
    /** A date relative to today, `offsetDays: [from, to]`. */
    | { kind: 'date'; offsetDays: [number, number]; format: string }
    /** Text with `{d12}` (digits), `{D3}` (A-Z) or `{L3}` (a-z) runs mixed in, e.g. `A{d12}A`. */
    | { kind: 'pattern'; pattern: string }
    /** Counts up per page: `start`, `step`, zero-padded to `pad`. */
    | { kind: 'sequence'; start: number; step?: number; pad?: number }
    /**
     * Another field's value on the same page. `pattern` rebuilds it, where `{from}` is the
     * copied value and the other tokens are random, e.g. `{from}-{d1}-{d2}`.
     */
    | { kind: 'copy'; from: string; pattern?: string }
    /**
     * A value from an API record. `path` is relative to the record (the response object, or one item
     * of a response array): dot-separated keys plus `[n]` list positions, such as `user.name` or
     * `items[0].id`.
     *
     * A label says only which path it needs. Where the records come from is not part of the label:
     * the person gives an address at print time, or in the Designer to test a preview. See
     * {@link ApiRequest}.
     */
    | { kind: 'api'; path: string }
  );

export type GeneratorSpec = {
  version: 1;
  tables?: Record<string, GeneratorTable>;
  /** Keyed by pdfme field name. A template field with no rule prints its own content. */
  fields: Record<string, FieldRule>;
};

/** Every `kind`, in the order the UI offers them. */
export const RULE_KINDS = [
  'fixed',
  'digits',
  'int',
  'pick',
  'table',
  'date',
  'pattern',
  'sequence',
  'copy',
  'api',
] as const;

/** A label plus the generator that fills it, as stored in `labels/<id>.json` and exported. */
export type LabelBundle = {
  format: 'q-print-label';
  version: 1;
  name: string;
  /** pdfme template. */
  template: unknown;
  generator: GeneratorSpec;
};

export const isFieldRule = (v: unknown): v is FieldRule =>
  !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string';

/** Reads a rule back from JSON, returning null when it is not one. */
export function asFieldRule(v: unknown): FieldRule | null {
  if (!isFieldRule(v)) return null;
  const kind: string = v.kind;
  return (RULE_KINDS as readonly string[]).includes(kind) ? v : null;
}
