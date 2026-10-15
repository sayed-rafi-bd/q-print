import { checkTemplate, type Template } from '@pdfme/common';
import { BUILTINS, builtin, isBuiltin } from './builtinLabels';
import { isBundle, makeBundle, templateSizeMm } from './bundle';
import { getDb } from './db/client';
import * as store from './db/labels';
import type { User } from './db/users';
import { builtinSpec } from './generator/builtins';
import { scaffoldSpec } from './generator/scaffold';
import type { GeneratorSpec, LabelBundle } from './generator/spec';
import { isValidId, slugify } from './labelId';
import { sampleSpec, sampleTemplate } from './sampleLabel';
import {
  assertUsableTemplate,
  defaultLabelGenerator,
  loadBuiltinTemplate,
  saveBuiltinTemplate,
  withFont,
} from './templateStore';

/**
 * Every label the signed-in account can print: the built-ins, plus the labels of their own.
 *
 * A built-in keeps its layout in a file on this device and its generator in the app, so it can be
 * printed but not edited. A label the user created lives in the database, scoped to their account,
 * which is what lets two people use the same build without seeing each other's work.
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

/** A label's layout together with the generator that fills it. */
export type LabelContent = {
  template: Template;
  source: 'custom' | 'default' | 'custom label';
  generator: GeneratorSpec;
};

const metaFrom = (id: LabelId, name: string, size: { widthMm: number; heightMm: number } | null): LabelMeta => ({
  id,
  name,
  builtin: isBuiltin(id),
  ...(size ?? { widthMm: 100, heightMm: 50 }),
});

/** Where a new label's layout and rules come from. */
export type LabelSource = { kind: 'blank' } | { kind: 'sample' } | { kind: 'copy'; id: LabelId };

export type NewLabel = {
  name: string;
  widthMm: number;
  heightMm: number;
  from: LabelSource;
};

/** Checks an id against the rule the rest of the app assumes. */
export { isValidId, slugify };

/** The built-in labels, which live in the app rather than in anybody's account. */
export const builtinLabels = (): LabelMeta[] =>
  BUILTINS.map((b) => metaFrom(b.id, b.name, templateSizeMm(b.defaultTemplate)));

/** The built-ins plus the signed-in account's own labels. */
export async function listLabels(user: User): Promise<LabelMeta[]> {
  const rows = await store.listLabels(getDb(), user.id);
  return [
    ...builtinLabels(),
    ...rows.map((r) => metaFrom(r.slug, r.name, { widthMm: r.widthMm, heightMm: r.heightMm })),
  ];
}

/** The label to open: the one asked for, else the built-in default, else whatever exists. */
export async function resolveLabel(user: User, id: LabelId): Promise<LabelMeta | null> {
  const labels = await listLabels(user);
  const first = labels[0] ?? null;
  return labels.find((l) => l.id === id) ?? first;
}

/**
 * Everything needed to print a label: the layout in use and the generator that fills it.
 *
 * Built-in labels are assembled from the app and this device; everything else is one database row,
 * so the layout and the generator can never drift apart.
 */
export async function loadLabel(user: User, label: LabelId): Promise<LabelContent> {
  if (isBuiltin(label)) {
    const { template, source } = await loadBuiltinTemplate(label);
    return { template, source, generator: defaultLabelGenerator(label) };
  }
  const row = await store.getLabel(getDb(), user.id, label);
  if (!row) throw new Error(`There is no label called “${label}” on this account.`);
  // A stored template that pdfme could not open would leave the Designer blank with no way out, so
  // it is checked here and the caller falls back to a label that does open.
  const template = JSON.parse(row.template) as Template;
  assertUsableTemplate(template, `The template for “${label}”`);
  return {
    template: withFont(template),
    source: 'custom label',
    generator: JSON.parse(row.generator) as GeneratorSpec,
  };
}

/**
 * Saves a label's layout and rules together.
 *
 * For a built-in only the layout is stored; its rules ship with the app and the Data tab is
 * read-only, so there is nothing to save for them.
 */
export async function saveLabel(
  user: User,
  label: LabelId,
  name: string,
  template: Template,
  generator: GeneratorSpec,
): Promise<void> {
  if (isBuiltin(label)) {
    await saveBuiltinTemplate(label, template);
    return;
  }
  const db = getDb();
  const input = { name, template: JSON.stringify(template), generator: JSON.stringify(generator) };
  if (!(await store.updateLabel(db, user.id, label, input))) {
    await store.createLabel(db, user.id, label, input);
  }
}

/** Creates a label and saves it, ready to open in the Designer. */
export async function createLabel(user: User, { name, widthMm, heightMm, from }: NewLabel): Promise<LabelMeta> {
  const existing = await listLabels(user);
  const id = slugify(
    name,
    existing.map((l) => l.id),
  );
  if (!isValidId(id)) throw new Error(`“${name}” cannot be turned into a usable label id.`);

  let template: Template;
  let generator: GeneratorSpec;
  switch (from.kind) {
    case 'sample':
      template = sampleTemplate();
      generator = sampleSpec();
      break;

    case 'copy': {
      if (isBuiltin(from.id)) {
        template = structuredClone(builtin(from.id)!.defaultTemplate);
        generator = builtinSpec(from.id);
      } else {
        const content = await loadLabel(user, from.id);
        template = structuredClone(content.template);
        generator = structuredClone(content.generator);
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
  // pdfme needs `padding` on a blank page; leaving it out makes the label impossible to open.
  const prev = template.basePdf as unknown as { padding?: [number, number, number, number] } | undefined;
  template.basePdf = {
    width: widthMm,
    height: heightMm,
    padding: prev?.padding ?? [0, 0, 0, 0],
  } as unknown as Template['basePdf'];
  checkTemplate(template); // fail here, with pdfme's message, rather than save a label that cannot open
  generator = scaffoldSpec(template, generator);

  await store.createLabel(getDb(), user.id, id, {
    name: name.trim() || id,
    template: JSON.stringify(template),
    generator: JSON.stringify(generator),
  });
  return metaFrom(id, name.trim() || id, { widthMm, heightMm });
}

/**
 * Adds a label under a slug that already exists on disk, which is what the one-time import needs.
 *
 * Returns false when the account already has that slug, so an import can never overwrite or
 * duplicate work that is already in the database.
 */
export async function importLabel(
  user: User,
  slug: LabelId,
  name: string,
  template: Template,
  generator: GeneratorSpec,
): Promise<boolean> {
  if (!isValidId(slug)) return false;
  if (await store.getLabel(getDb(), user.id, slug)) return false;
  await store.createLabel(getDb(), user.id, slug, {
    name,
    template: JSON.stringify(template),
    generator: JSON.stringify(generator),
  });
  return true;
}

/** Changes only the display name; the id stays the same so nothing is rewritten. */
export async function renameLabel(user: User, label: LabelId, name: string): Promise<void> {
  if (isBuiltin(label)) throw new Error('A built-in label cannot be renamed.');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A label needs a name.');
  if (!(await store.updateLabel(getDb(), user.id, label, { name: trimmed }))) {
    throw new Error(`There is no label called “${label}” on this account.`);
  }
}

/** Removes one of the signed-in account's labels. Built-ins cannot be deleted, only reset. */
export async function deleteLabel(user: User, label: LabelId): Promise<void> {
  if (isBuiltin(label)) throw new Error('A built-in label cannot be deleted. Use "Reset to default" instead.');
  if (!(await store.deleteLabel(getDb(), user.id, label))) {
    throw new Error(`There is no label called “${label}” on this account.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Remembering which label was last used. Keyed by account so two people on one device do not
// fight over it.
// ---------------------------------------------------------------------------------------------

const lastKey = (user: User) => `q-print.label.${user.id}`;

export function loadLastLabel(user: User): LabelId | null {
  try {
    return localStorage.getItem(lastKey(user));
  } catch {
    return null;
  }
}

export function rememberLabel(user: User, label: LabelId) {
  try {
    localStorage.setItem(lastKey(user), label);
  } catch {
    /* not critical */
  }
}

/**
 * The values last typed for a label's URL variables, per account and label. They are not secret, so
 * localStorage is fine. The access token is deliberately never remembered.
 */
const valuesKey = (user: User, label: LabelId) => `q-print.source.${user.id}.${label}`;

export function loadSourceValues(user: User, label: LabelId): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(valuesKey(user, label)) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

export function rememberSourceValues(user: User, label: LabelId, values: Record<string, string>) {
  try {
    localStorage.setItem(valuesKey(user, label), JSON.stringify(values));
  } catch {
    /* not critical */
  }
}

// ---------------------------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------------------------

/** The whole label as a file: its layout and the generator that fills it. */
export const exportBundle = async (user: User, label: LabelId, name: string): Promise<LabelBundle> => {
  const { template, generator } = await loadLabel(user, label);
  return makeBundle(name, template, generator);
};

export { isBundle };
