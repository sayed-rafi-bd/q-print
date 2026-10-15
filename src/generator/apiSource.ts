/**
 * Pure helpers for a label's API data source: reading the `{variables}` out of a URL pattern,
 * building the real URL, and turning the JSON response into records and text.
 *
 * No Tauri, no DOM and no network here, so all of it is unit tested on its own. The call itself
 * lives in `src/apiClient.ts` (and `src-tauri/src/http.rs`).
 */

/** Every `{...}` in a URL pattern, valid name or not, so typos can be reported. */
const BRACES = /\{([^{}]*)\}/g;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Unique variable names in a URL pattern, in order of appearance. */
export function urlVariables(url: string): string[] {
  const seen = new Set<string>();
  for (const match of String(url ?? '').matchAll(BRACES)) {
    if (VARIABLE_NAME.test(match[1])) seen.add(match[1]);
  }
  return [...seen];
}

/** True when the text starts with a scheme such as `https:`; `localhost:8080/x` does not. */
const hasScheme = (url: string): boolean => {
  const match = SCHEME.exec(url);
  if (!match) return false;
  const rest = url.slice(match[0].length);
  // "host:8080/path" is a host and a port, not a scheme.
  return rest.startsWith('//') || !/^\d+(?:[/?#]|$)/.test(rest);
};

/** Adds `https://` when the pattern has no scheme. */
export function normalizeUrl(url: string): string {
  const text = String(url ?? '').trim();
  if (hasScheme(text)) return text;
  return `https://${text.replace(/^\/\//, '')}`;
}

/**
 * Fills the variables in. Every value is URL-encoded, so a value such as `x/../../admin` cannot
 * change the path. Throws, naming the first variable that has no value.
 */
export function buildUrl(url: string, values: Record<string, string | undefined>): string {
  const normalized = normalizeUrl(url);
  for (const name of urlVariables(normalized)) {
    if (!(values[name] ?? '').trim()) throw new Error(`Enter a value for “${name}”.`);
  }
  // One pass, so a value that itself contains braces is never substituted again.
  return normalized.replace(BRACES, (whole, name: string) =>
    VARIABLE_NAME.test(name) ? encodeURIComponent((values[name] ?? '').trim()) : whole,
  );
}

/** Problems with a URL pattern, one sentence each. An empty array means it is usable. */
export function checkSourceUrl(url: string): string[] {
  const text = String(url ?? '').trim();
  if (!text) return ['Enter the URL to fetch the data from.'];

  const problems: string[] = [];
  for (const match of text.matchAll(BRACES)) {
    if (!VARIABLE_NAME.test(match[1])) {
      problems.push(
        `“{${match[1]}}” is not a valid variable name. Use letters, digits and _, and do not start with a digit.`,
      );
    }
  }
  if (text.replace(BRACES, '').match(/[{}]/)) problems.push('The URL has a { or } without its pair.');

  if (hasScheme(text)) {
    const scheme = SCHEME.exec(text)?.[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      problems.push(`Only http and https addresses are allowed (got “${scheme}:”).`);
      return problems;
    }
  }

  // Variables stand in as plain text, so the address can be checked as if it were filled in.
  const probe = normalizeUrl(text).replace(BRACES, 'x');
  const authority = /^https?:\/\/([^/?#]*)/i.exec(probe)?.[1];
  if (!authority) {
    problems.push('The URL has no host name.');
  } else if (authority.includes('@')) {
    problems.push('Do not put a user name or password in the URL. Use the access token instead.');
  } else {
    try {
      new URL(probe);
    } catch {
      problems.push('This is not a valid URL.');
    }
  }
  return problems;
}

/**
 * Splits `a.b[2].c` into `['a', 'b', 2, 'c']`, or returns null when the path is malformed.
 * Keys are anything but `.`, `[` and `]`; `[n]` is a list position.
 */
export function parsePath(path: string): Array<string | number> | null {
  const text = typeof path === 'string' ? path.trim() : '';
  if (!text) return null;
  const out: Array<string | number> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '[') {
      const end = text.indexOf(']', i);
      const inner = end < 0 ? '' : text.slice(i + 1, end);
      if (!/^\d+$/.test(inner)) return null;
      out.push(Number(inner));
      i = end + 1;
    } else if (c === '.' || c === ']') {
      return null;
    } else {
      let j = i;
      while (j < text.length && !'.[]'.includes(text[j])) j++;
      if (text[j] === ']') return null;
      out.push(text.slice(i, j));
      i = j;
    }
    // A key or index is followed by the end, a `[`, or one `.` and then something.
    if (text[i] === '.') {
      i++;
      if (i >= text.length) return null;
    } else if (i < text.length && text[i] !== '[') {
      return null;
    }
  }
  return out;
}

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

const kindOf = (value: unknown): string => {
  if (value === null) return 'nothing (null)';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string':
      return 'text';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'true/false';
    default:
      return 'an object';
  }
};

/**
 * Follows a path into a record. Throws a readable error when a step is missing; the caller adds
 * which field and which record it was. Only the record's own keys are read, never inherited ones.
 */
export function readPath(record: unknown, path: string): unknown {
  const steps = parsePath(path);
  if (!steps) throw new Error(`“${path}” is not a valid path.`);
  let current: unknown = record;
  let walked = '';
  for (const step of steps) {
    if (typeof step === 'number') {
      if (!Array.isArray(current)) {
        throw new Error(`“${path}” was not found (${walked || 'the record'} is ${kindOf(current)}, not a list).`);
      }
      if (step >= current.length) {
        const where = walked || 'the record';
        throw new Error(`“${path}” was not found (${where} has ${current.length} items, no [${step}]).`);
      }
      current = current[step];
      walked += `[${step}]`;
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`“${path}” was not found (${walked || 'the record'} is ${kindOf(current)}, not an object).`);
      }
      if (!hasOwn(current, step)) {
        throw new Error(`“${path}” was not found (“${step}” is missing${walked ? ` in ${walked}` : ''}).`);
      }
      current = (current as Record<string, unknown>)[step];
      walked += walked ? `.${step}` : step;
    }
  }
  return current;
}

/**
 * The records a response holds. A list gives one record per item; an object gives one record.
 * With `listPath`, that path is followed first (`data` for `{ "data": [ ... ] }`).
 */
export function extractRecords(json: unknown, listPath?: string): unknown[] {
  let root = json;
  const path = (listPath ?? '').trim();
  if (path) {
    try {
      root = readPath(json, path);
    } catch (e) {
      throw new Error(`The list path ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (Array.isArray(root)) {
    if (root.length === 0) throw new Error('The API returned an empty list, so there is nothing to print.');
    return root;
  }
  if (root !== null && typeof root === 'object') return [root];
  throw new Error(`The API returned ${kindOf(root)}. Expected an object or a list of objects.`);
}

/** The text a JSON value prints as. */
export function toText(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return '';
  if (Array.isArray(value)) throw new Error(`“${path}” points at a list; pick a field inside it.`);
  throw new Error(`“${path}” points at an object; pick a field inside it.`);
}
