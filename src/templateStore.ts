import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import { builtin, isBuiltin } from './builtinLabels';
import { builtinSpec } from './generator/builtins';
import { scaffoldSpec } from './generator/scaffold';
import type { GeneratorSpec, LabelBundle } from './generator/spec';
import { makeBundle, parseBundle } from './bundle';

/** Where the template being printed came from, shown after a print job. */
export type TemplateSource = 'custom' | 'default' | 'custom label';

export type LabelId = string;

/** A label's template together with the generator that fills it. */
export type LabelContent = {
  template: Template;
  source: TemplateSource;
  generator: GeneratorSpec;
};

// Must match the key used in the `font` option of Designer / generate().
const FONT_NAME = 'NotoSansJP';

// The pdfme Designer only applies a custom font to a text field when the field has an
// explicit `fontName`; otherwise it falls back to the page's CSS font. Set it here.
function withFont(t: Template): Template {
  return {
    ...t,
    schemas: t.schemas.map(page =>
      page.map(s => (s.type === 'text' && !s.fontName ? { ...s, fontName: FONT_NAME } : s)),
    ),
  };
}

/** The bundled layout for a built-in label. */
export const defaultLabelTemplate = (label: LabelId): Template =>
  withFont(builtin(label)?.defaultTemplate ?? ({} as Template));

/** The generator that ships with a built-in label. */
export const defaultLabelGenerator = (label: LabelId): GeneratorSpec => builtinSpec(label);

/**
 * Everything needed to print a label: the layout in use and the generator that fills it.
 *
 * A built-in uses the template saved from the Designer, else its bundled one. A custom label keeps
 * both in a single file, so the layout and the generator can never drift apart.
 */
export async function loadLabel(label: LabelId): Promise<LabelContent> {
  if (!isBuiltin(label)) {
    const bundle = await loadBundle(label);
    return { template: withFont(bundle.template as Template), source: 'custom label', generator: bundle.generator };
  }
  const saved = await invoke<string | null>('load_template', { label });
  if (!saved) {
    return { template: defaultLabelTemplate(label), source: 'default', generator: defaultLabelGenerator(label) };
  }
  try {
    return { template: withFont(JSON.parse(saved) as Template), source: 'custom', generator: defaultLabelGenerator(label) };
  } catch {
    throw new Error('The saved template is corrupt. Open the Designer and use "Reset to default".');
  }
}

/** Just the layout. */
export async function getTemplate(label: LabelId): Promise<{ template: Template; source: TemplateSource }> {
  const { template, source } = await loadLabel(label);
  return { template, source };
}

/** Saves the designer's template for a built-in label; returns the file path. */
export const saveBuiltinTemplate = (label: LabelId, template: Template) =>
  invoke<string>('save_template', { label, json: JSON.stringify(template) });

/** Deletes a built-in label's saved template so its bundled layout is used again. */
export const resetBuiltinTemplate = (label: LabelId) => invoke<void>('reset_template', { label });

/** Reads a custom label's file. */
export async function loadBundle(label: LabelId): Promise<LabelBundle> {
  const json = await invoke<string>('load_custom_label', { id: label });
  const parsed = parseBundle(json);
  if (parsed.bundle) return parsed.bundle;
  // A hand-placed file, or one from a future version: accept the layout rather than refusing it,
  // and give it a generator that matches the fields it has.
  return makeBundle(label, parsed.template!, scaffoldSpec(parsed.template!));
}

/** Saves a custom label's template and generator together; returns the file path. */
export const saveBundle = (label: LabelId, name: string, template: Template, generator: GeneratorSpec) =>
  invoke<string>('save_custom_label', {
    id: label,
    json: JSON.stringify(makeBundle(name, template, generator)),
  });
