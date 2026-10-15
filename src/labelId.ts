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

/** Longest label name, in characters. Keeps names readable in the label list and dropdowns. */
export const MAX_NAME = 20;

const chars = (text: string): string[] => Array.from(text);

/** Why a label name cannot be used, or null when it can. */
export function nameProblem(name: string): string | null {
  const n = chars(name.trim()).length;
  if (n === 0) return 'A label needs a name.';
  if (n > MAX_NAME) return `A label name can have at most ${MAX_NAME} characters (this one has ${n}).`;
  return null;
}

/** `name` plus `suffix`, with the name shortened so the whole fits in {@link MAX_NAME}. */
export function fitName(name: string, suffix = ''): string {
  const room = Math.max(0, MAX_NAME - chars(suffix).length);
  return `${chars(name.trim()).slice(0, room).join('').trimEnd()}${suffix}`.trim();
}
