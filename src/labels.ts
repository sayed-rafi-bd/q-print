import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import { BUILTINS, DEFAULT_LABEL, builtin, isBuiltin } from './builtinLabels';
import { templateSizeMm } from './bundle';
import { scaffoldSpec } from './generator/scaffold';
import { builtinSpec } from './generator/builtins';
import { isValidId, slugify } from './labelId';
import { sampleSpec, sampleTemplate } from './sampleLabel';
import { loadBundle, saveBundle } from './templateStore';
import type { GeneratorSpec } from './generator/spec';

/**
 * Every label the app can print: the two built-ins plus whatever the user has created.
 *
 * A built-in keeps a saved template override next to its bundled one; a custom label is a single
 * file holding its template and its generator together. Adding a label is now a user action, so
 * this is a registry read from disk rather than a list compiled into the app.
 */
export type LabelId = string;

export type LabelMeta = {
  id: LabelId;
  name: string;
  builtin: boolean;
  /** Page size in mm; also the paper the printer must be set to. Read from the template. */
  widthMm: number;
  heightMm: number;
};

/** A file in `labels/` that is not a usable label, so the UI can offer to delete it. */
export type BrokenLabelFile = { id: string; reason: string };

/** What `list_custom_labels` sends back; one line per file. */
type LabelFileSummary = {
  id: string;
  name: string;
  widthMm: number | null;
  heightMm: number | null;
};

const FALLBACK_SIZE = { widthMm: 100, heightMm: 50 };

export type LabelRegistry = {
  labels: LabelMeta[];
  broken: BrokenLabelFile[];
};

const metaFrom = (id: string, name: string, size: { widthMm: number; heightMm: number } | null): LabelMeta => ({
  id,
  name,
  builtin: isBuiltin(id),
  ...(size ?? FALLBACK_SIZE),
});

/**
 * The built-ins and the user's own labels, in the order they are offered.
 *
 * A built-in's size is read from the template that would actually print, so a label resized in the
 * Designer shows the right size rather than the one it shipped with.
 */
export async function listLabels(): Promise<LabelRegistry> {
  const custom = await invoke<{ labels: LabelFileSummary[]; broken: BrokenLabelFile[] }>('list_custom_labels');

  const builtins: LabelMeta[] = BUILTINS.map(b => {
    // Only the size is needed here; the Designer and the print path load the template themselves.
    const size = templateSizeMm(b.defaultTemplate);
    return metaFrom(b.id, b.name, size);
  });

  const customs: LabelMeta[] = custom.labels.map(c =>
    metaFrom(
      c.id,
      c.name,
      c.widthMm && c.heightMm ? { widthMm: c.widthMm, heightMm: c.heightMm } : null,
    ),
  );

  return { labels: [...builtins, ...customs], broken: custom.broken };
}

/**
 * The label to fall back to: the one chosen last time, the default if that has been deleted, and
 * null if the registry is empty.
 */
export async function resolveLabel(id: LabelId): Promise<LabelMeta | null> {
  const { labels } = await listLabels();
  return labels.find(l => l.id === id) ?? labels.find(l => l.id === DEFAULT_LABEL) ?? labels[0] ?? null;
}

/** Checks an id against the rule the backend enforces, so the UI can fail before writing. */
export { isValidId, slugify };

/** Where a new label's layout and rules come from. */
export type LabelSource =
  /** An empty page of the requested size. */
  | { kind: 'blank' }
  /** The bundled sample, so there is something printable to start from. */
  | { kind: 'sample' }
  /** A copy of an existing label: its layout and its rules. */
  | { kind: 'copy'; id: LabelId };

export type NewLabel = {
  /** Shown in the picker. */
  name: string;
  widthMm: number;
  heightMm: number;
  from: LabelSource;
};

/** Creates a label and saves it, ready to open in the Designer. */
export async function createLabel({ name, widthMm, heightMm, from }: NewLabel): Promise<LabelMeta> {
  const { labels } = await listLabels();
  const id = slugify(name, labels.map(l => l.id));
  if (!isValidId(id)) throw new Error(`“${name}” cannot be turned into a usable label id.`);

  let template: Template;
  let generator: GeneratorSpec;
  switch (from.kind) {
    case 'sample':
      template = sampleTemplate();
      generator = sampleSpec();
      break;

    case 'copy': {
      const source = builtin(from.id);
      if (source) {
        template = structuredClone(source.defaultTemplate);
        generator = builtinSpec(from.id);
      } else if (labels.some(l => l.id === from.id)) {
        const bundle = await loadBundle(from.id);
        template = structuredClone(bundle.template as Template);
        generator = structuredClone(bundle.generator);
      } else {
        throw new Error(`There is no label called “${from.id}” to copy.`);
      }
      break;
    }

    default:
      template = {
        basePdf: { width: widthMm, height: heightMm, padding: [0, 0, 0, 0] },
        schemas: [[]],
      } as unknown as Template;
      generator = { version: 1, fields: {} };
      break;
  }

  // The copy gets the size the user asked for, not the one it was copied from.
  template.basePdf = { width: widthMm, height: heightMm } as Template['basePdf'];
  generator = scaffoldSpec(template, generator);
  await saveBundle(id, name.trim() || id, template, generator);
  return metaFrom(id, name.trim() || id, { widthMm, heightMm });
}

/** Changes only the display name; the id stays the same so the file does not move. */
export async function renameLabel(id: LabelId, name: string): Promise<void> {
  if (isBuiltin(id)) throw new Error('A built-in label cannot be renamed.');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A label needs a name.');
  const bundle = await loadBundle(id);
  await saveBundle(id, trimmed, bundle.template as Template, bundle.generator);
}

/** Removes a custom label. Built-ins cannot be deleted, only reset. */
export async function deleteLabel(id: LabelId): Promise<void> {
  if (isBuiltin(id)) throw new Error('A built-in label cannot be deleted. Use "Reset to default" instead.');
  await invoke<void>('delete_custom_label', { id });
}

const STORAGE_KEY = 'q-print.label';

/** The label chosen last time, or null when nothing valid is remembered. */
export function loadLastLabel(): LabelId | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage unavailable: not critical
  }
}

export function rememberLabel(id: LabelId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable: not critical */ }
}
