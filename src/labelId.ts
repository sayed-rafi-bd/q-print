/**
 * Turning a label name into the id used as its file name.
 *
 * Kept apart from the registry because it is pure: the same rule runs in Rust (`labels::validate_id`),
 * so both sides have to agree, and this is the half that can be tested without a filesystem.
 */

/**
 * Matches `validate_id` in src-tauri/src/labels.rs: 1-40 characters of a-z, 0-9 and '-', starting
 * with a letter or a digit. The id is used as a file name, so this is what keeps separators out.
 */
export function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
}

/** Longest id the backend accepts. */
const MAX_ID = 40;

/**
 * A file-name-safe id for `name`, derived from it rather than typed by the user, with a number
 * appended when the name is already taken. Names that hold nothing usable (a Japanese label name,
 * say) fall back to `label` rather than failing.
 */
export function slugify(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^-+/, '')
    .slice(0, MAX_ID)
    .replace(/-+$/, '');

  const base = cleaned && isValidId(cleaned) ? cleaned : 'label';
  if (!used.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (isValidId(candidate) && !used.has(candidate)) return candidate;
  }
  // Only reachable with a thousand labels of the same name; a timestamp is good enough.
  return `label-${Date.now()}`;
}
