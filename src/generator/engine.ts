/**
 * The generator engine: turns a {@link GeneratorSpec} into one row of data per page.
 *
 * Everything here is pure — no Tauri, no DOM — so the same code runs on desktop and Android and
 * can be unit tested by injecting a seeded RNG and a fixed `now`.
 */

import {
  asFieldRule,
  type FieldRule,
  type GeneratorSpec,
  type GeneratorTable,
  type IntFormat,
  type Transform,
} from './spec';

/** Caps that keep a hostile or accidental spec from hanging the print job. */
export const LIMITS = {
  /** Pages per print job. */
  maxRows: 10_000,
  /** Rows in any one table. */
  maxTableRows: 5_000,
  /** Serialized size of a spec. */
  maxSpecBytes: 1024 * 1024,
};

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** Tokens inside a `pattern`: `{d12}` digits, `{D3}` upper-case, `{L3}` lower-case. */
const PATTERN_TOKEN = /\{([dDL])(\d{1,3})\}/g;
/** A whole token, tested on its own. Kept non-global so `.test` has no `lastIndex` to carry over. */
const PATTERN_TOKEN_ONE = /^\{[dDL]\d{1,3}\}$/;
/** Anything that looks like it was meant to be a token, so unknown ones can be reported. */
const PATTERN_CANDIDATE = /\{[^}]*\}/g;
/**
 * `{from}` inside a `copy` rule's pattern stands for the copied value. Deliberately not global:
 * these regexes are module-level, and a /g regex keeps `lastIndex` between `.test` calls.
 */
const COPY_TOKEN = /\{from\}/;

/** Longest first, so "MM" is never read as "M" + "M". */
const DATE_TOKEN_RE = /YYYY|YY|MM|DD|HH|mm|ss|M|D/g;

export type GenerateOptions = {
  /** "Today" for `date` rules. Injectable so tests are deterministic. */
  now?: Date;
  /** Injectable so tests are deterministic. Must return a number in [0, 1). */
  rng?: () => number;
};

/** One page's worth of state. */
type Page = {
  now: Date;
  rng: () => number;
  /** Page number, 0-based; `sequence` counts from here. */
  index: number;
  /** Values of the fields already generated on this page, for `copy`. */
  values: Record<string, string>;
  /** The row each table contributes to this page, chosen once so fields stay consistent. */
  tableRows: Map<string, string[]>;
};

/** A random integer in [min, max]. Tolerates an rng that returns exactly 1. */
const randInt = (rng: () => number, min: number, max: number): number => {
  const span = max - min + 1;
  if (span <= 1) return min;
  return min + Math.min(Math.floor(rng() * span), span - 1);
};

const groupThousands = (n: number): string => {
  const rounded = Math.round(Math.abs(n));
  const digits = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${digits}` : digits;
};

const formatInt = (n: number, format: IntFormat): string => {
  switch (format) {
    case 'thousands': return groupThousands(n);
    // "¥1,234", and plain "¥400" below a thousand — the shape Japanese labels use.
    case 'yen': return `¥${groupThousands(n)}`;
    default: return String(n);
  }
};

const formatDate = (d: Date, format: string): string => {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const parts: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: p2(d.getFullYear() % 100),
    MM: p2(d.getMonth() + 1),
    DD: p2(d.getDate()),
    HH: p2(d.getHours()),
    mm: p2(d.getMinutes()),
    ss: p2(d.getSeconds()),
    M: String(d.getMonth() + 1),
    D: String(d.getDate()),
  };
  // One left-to-right pass, longest token first, so "MM" is never read as "M"+"M".
  return format.replace(DATE_TOKEN_RE, t => parts[t] ?? t);
};

const applyTransforms = (value: string, transforms: Transform[] | undefined): string =>
  (transforms ?? []).reduce((v, t) => {
    switch (t) {
      case 'digits-only': return v.replace(/\D/g, '');
      case 'upper': return v.toUpperCase();
      case 'lower': return v.toLowerCase();
      default: return v;
    }
  }, value);

/** The prefix/suffix/transforms every rule shares. */
const decorate = (raw: string, rule: FieldRule): string =>
  `${rule.prefix ?? ''}${applyTransforms(raw, rule.transforms)}${rule.suffix ?? ''}`;

const tableRowFor = (page: Page, spec: GeneratorSpec, name: string): string[] => {
  const cached = page.tableRows.get(name);
  if (cached) return cached;
  const table = spec.tables?.[name];
  const rows = table?.rows ?? [];
  const row = rows.length > 0 ? rows[randInt(page.rng, 0, rows.length - 1)] : [];
  page.tableRows.set(name, row);
  return row;
};

/** Builds a random run of `length` characters from the set `d` / `D` / `L`. */
const randomRun = (rng: () => number, set: string, length: number): string => {
  let out = '';
  for (let i = 0; i < length; i++) {
    if (set === 'd') out += String(randInt(rng, 0, 9));
    else out += (set === 'D' ? UPPER : LOWER)[randInt(rng, 0, 25)];
  }
  return out;
};

/** Expands `{d2}`/`{D3}`/`{L3}`. Unknown tokens are left alone (validateSpec reports them). */
const expandPattern = (pattern: string, rng: () => number, literal?: string): string =>
  pattern
    .replace(PATTERN_TOKEN, (_all, set: string, len: string) => randomRun(rng, set, Number(len)))
    .replace(COPY_TOKEN, () => literal ?? '');

const evaluate = (rule: FieldRule, page: Page, spec: GeneratorSpec): string => {
  switch (rule.kind) {
    case 'fixed':
      return rule.value;

    case 'digits':
      return randomRun(page.rng, 'd', rule.length);

    case 'int': {
      const lo = Math.min(rule.min, rule.max);
      const hi = Math.max(rule.min, rule.max);
      const step = rule.step && rule.step > 0 ? rule.step : 1;
      const steps = Math.max(Math.floor((hi - lo) / step), 0);
      const value = lo + step * randInt(page.rng, 0, steps);
      return formatInt(Math.min(value, hi), rule.format ?? 'plain');
    }

    case 'pick':
      return rule.values[randInt(page.rng, 0, rule.values.length - 1)] ?? '';

    case 'table': {
      const row = tableRowFor(page, spec, rule.table);
      const index = spec.tables?.[rule.table]?.columns.indexOf(rule.column) ?? -1;
      return index >= 0 ? (row[index] ?? '') : '';
    }

    case 'date': {
      const [from, to] = rule.offsetDays;
      const offset = randInt(page.rng, Math.min(from, to), Math.max(from, to));
      // Built from parts rather than by adding milliseconds, so a day is a local calendar day and
      // never shifts across a DST boundary. The clock time is kept from `now`, which is what the
      // HH/mm/ss tokens show.
      const n = page.now;
      const base = new Date(
        n.getFullYear(), n.getMonth(), n.getDate() + offset,
        n.getHours(), n.getMinutes(), n.getSeconds(),
      );
      return formatDate(base, rule.format);
    }

    case 'pattern':
      return expandPattern(rule.pattern, page.rng);

    case 'sequence': {
      const value = rule.start + (rule.step ?? 1) * page.index;
      const text = String(value);
      return rule.pad && rule.pad > 0 ? text.padStart(rule.pad, '0') : text;
    }

    case 'copy': {
      const from = page.values[rule.from] ?? '';
      return rule.pattern ? expandPattern(rule.pattern, page.rng, from) : from;
    }

    default:
      return '';
  }
};

/**
 * Orders the fields so a `copy` always runs after the field it reads.
 * Returns the order plus any problem found; a cycle leaves the remaining fields out.
 */
const resolveOrder = (fields: Record<string, FieldRule>): { order: string[]; errors: string[] } => {
  const order: string[] = [];
  const errors: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, path: string[]): void => {
    const seen = state.get(name);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      errors.push(`“${[...path, name].join('” → “')}” copies in a circle.`);
      return;
    }
    state.set(name, 'visiting');
    const rule = asFieldRule(fields?.[name]);
    if (rule?.kind === 'copy') {
      if (rule.from === name) {
        errors.push(`“${name}” copies from itself.`);
      } else if (!asFieldRule(fields?.[rule.from])) {
        errors.push(`“${name}” copies from “${rule.from}”, which has no rule of its own.`);
      } else {
        visit(rule.from, [...path, name]);
      }
    }
    state.set(name, 'done');
    order.push(name);
  };

  for (const name of Object.keys(fields ?? {})) visit(name, []);
  return { order, errors };
};

const checkTable = (name: string, table: unknown, errors: string[]): void => {
  const label = `table “${name}”`;
  if (!table || typeof table !== 'object') {
    errors.push(`${label} is not a table.`);
    return;
  }
  const { columns, rows } = table as GeneratorTable;
  if (!Array.isArray(columns) || columns.length === 0) {
    errors.push(`${label} has no columns.`);
  }
  if (!Array.isArray(rows)) {
    errors.push(`${label} has no rows.`);
    return;
  }
  if (rows.length > LIMITS.maxTableRows) {
    errors.push(`${label} has ${rows.length} rows, over the limit of ${LIMITS.maxTableRows}.`);
  }
  const width = Array.isArray(columns) ? columns.length : 0;
  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== width) {
      errors.push(`${label} row ${i + 1} has ${Array.isArray(row) ? row.length : 0} values but there are ${width} columns.`);
    }
  });
};

/** Every `{...}` in a pattern that is not a run token is a typo the user needs to see. */
const checkPattern = (field: string, pattern: unknown, errors: string[]): void => {
  if (typeof pattern !== 'string') {
    errors.push(`“${field}” has no pattern.`);
    return;
  }
  for (const token of pattern.match(PATTERN_CANDIDATE) ?? []) {
    // `{from}` is only meaningful on a `copy`; everything else must be a known run token.
    if (token === '{from}' || PATTERN_TOKEN_ONE.test(token)) continue;
    errors.push(`“${field}” uses an unknown pattern token ${token}. Use {d3}, {D2} or {L2}.`);
  }
};

/**
 * Date formats use a fixed set of tokens. Strip the ones we know; whatever letters are left over
 * were meant to be a token but are not one.
 */
const checkDateFormat = (field: string, format: string, errors: string[]): void => {
  const stray = format.replace(DATE_TOKEN_RE, '').match(/[A-Za-z]+/g);
  if (stray) {
    errors.push(
      `“${field}” does not understand ${stray.map(s => `“${s}”`).join(', ')} in its date format. ` +
      'Use YYYY, YY, MM, DD, HH, mm or ss.',
    );
  }
};

/**
 * Checks a spec and returns one message per problem, each naming the field or table at fault.
 * An empty array means the spec is good to generate from (and to save).
 */
export function validateSpec(spec: GeneratorSpec | null | undefined): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== 'object') return ['This is not a data generator.'];
  if (spec.version !== 1) errors.push(`Unsupported generator version ${String(spec.version)}.`);

  const fields = spec.fields;
  if (!fields || typeof fields !== 'object') {
    errors.push('The generator has no fields.');
    return errors;
  }

  try {
    const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
    if (bytes > LIMITS.maxSpecBytes) {
      errors.push(`The generator is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${LIMITS.maxSpecBytes / 1024 / 1024} MB limit.`);
    }
  } catch {
    errors.push('The generator could not be measured.');
  }

  for (const [name, table] of Object.entries(spec.tables ?? {})) checkTable(name, table, errors);

  for (const [field, value] of Object.entries(fields)) {
    const rule = asFieldRule(value);
    if (!rule) {
      errors.push(`“${field}” has an unknown rule.`);
      continue;
    }
    switch (rule.kind) {
      case 'digits':
        if (!Number.isFinite(rule.length) || rule.length < 1) {
          errors.push(`“${field}” needs a length of at least 1.`);
        }
        break;

      case 'int':
        if (!Number.isFinite(rule.min) || !Number.isFinite(rule.max)) {
          errors.push(`“${field}” needs a lowest and highest value.`);
        } else if (rule.min > rule.max) {
          errors.push(`“${field}” has its lowest value above its highest one.`);
        }
        break;

      case 'pick':
        if (!Array.isArray(rule.values) || rule.values.length === 0) {
          errors.push(`“${field}” has nothing to pick from.`);
        }
        break;

      case 'table': {
        const table = spec.tables?.[rule.table];
        if (!table) {
          errors.push(`“${field}” reads table “${rule.table}”, which does not exist.`);
        } else if (!Array.isArray(table.columns) || !table.columns.includes(rule.column)) {
          errors.push(`“${field}” reads column “${rule.column}”, which table “${rule.table}” does not have.`);
        }
        break;
      }

      case 'date':
        if (!Array.isArray(rule.offsetDays) || rule.offsetDays.length !== 2
          || !rule.offsetDays.every(n => Number.isFinite(n))) {
          errors.push(`“${field}” needs a range of days from today.`);
        } else if (typeof rule.format !== 'string' || rule.format.length === 0) {
          errors.push(`“${field}” has no date format.`);
        } else {
          checkDateFormat(field, rule.format, errors);
        }
        break;

      case 'pattern':
        checkPattern(field, rule.pattern, errors);
        break;

      case 'copy':
        if (!rule.pattern) break;
        checkPattern(field, rule.pattern, errors);
        if (!COPY_TOKEN.test(rule.pattern)) {
          errors.push(`“${field}” rebuilds its pattern without {from}, so the value it copies is thrown away.`);
        }
        break;

      default:
        break;
    }
  }

  errors.push(...resolveOrder(fields).errors);
  return errors;
}

/** Throws when the spec is not usable, naming the first problem. */
export function assertValidSpec(spec: GeneratorSpec): void {
  const errors = validateSpec(spec);
  if (errors.length > 0) throw new Error(errors[0]);
}

/**
 * One value for one field, for the editor's live samples.
 *
 * Falls back to generating that rule on its own, so a field still shows a sample while some other
 * field is half-finished.
 */
export function sampleField(
  spec: GeneratorSpec,
  field: string,
  opts: GenerateOptions = {},
): string {
  const { now = new Date(), rng = Math.random } = opts;
  try {
    return generateRows(spec, 1, { now, rng })[0]?.[field] ?? '';
  } catch {
    const rule = asFieldRule(spec?.fields?.[field]);
    if (!rule) return '';
    try {
      const page: Page = { now, rng, index: 0, values: {}, tableRows: new Map() };
      return decorate(evaluate(rule, page, spec), rule);
    } catch {
      return '';
    }
  }
}

/**
 * One row of data per page, keyed by template field name.
 *
 * Throws if the spec is invalid or `count` is out of range, so a bad generator fails here with a
 * readable message instead of producing a label full of `undefined`.
 */
export function generateRows(
  spec: GeneratorSpec,
  count: number,
  { now = new Date(), rng = Math.random }: GenerateOptions = {},
): Record<string, string>[] {
  assertValidSpec(spec);
  if (!Number.isInteger(count) || count < 1) throw new Error('A print job needs at least one page.');
  if (count > LIMITS.maxRows) throw new Error(`A print job is limited to ${LIMITS.maxRows} pages.`);

  const { order } = resolveOrder(spec.fields);
  return Array.from({ length: count }, (_, index) => {
    const page: Page = { now, rng, index, values: {}, tableRows: new Map() };
    for (const name of order) page.values[name] = decorate(evaluate(spec.fields[name], page, spec), spec.fields[name]);
    return { ...page.values };
  });
}
