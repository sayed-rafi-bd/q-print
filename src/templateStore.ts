import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import { builtin, isBuiltin } from './builtinLabels';
import { builtinSpec } from './generator/builtins';

// Must match the key used in the `font` option of Designer / generate().
const FONT_NAME = 'NotoSansJP';

/**
 * The pdfme Designer only applies a custom font to a text field when the field has an
 * explicit `fontName`; otherwise it falls back to the page's CSS font. Set it here.
 */
export function withFont(t: Template): Template {
  return {
    ...t,
    schemas: t.schemas.map(page =>
      page.map(s => (s.type === 'text' && !s.fontName ? { ...s, fontName: FONT_NAME } : s)),
    ),
  };
}

/** The bundled layout for a built-in label. */
export const defaultLabelTemplate = (label: string): Template =>
  withFont(builtin(label)?.defaultTemplate ?? ({} as Template));

/** The generator that ships with a built-in label. */
export const defaultLabelGenerator = (label: string) => builtinSpec(label);

/**
 * Reads the built-in label's layout: the one saved from the Designer, else its bundled one.
 *
 * Built-in labels are the only thing still stored as a file. Everything a user creates lives in
 * the database; see `src/labels.ts`.
 */
export async function loadBuiltinTemplate(label: string): Promise<{ template: Template; source: 'custom' | 'default' }> {
  const saved = await invoke<string | null>('load_template', { label });
  if (!saved) return { template: defaultLabelTemplate(label), source: 'default' };
  try {
    return { template: withFont(JSON.parse(saved) as Template), source: 'custom' };
  } catch {
    throw new Error('The saved template is corrupt. Open the Designer and use "Reset to default".');
  }
}

/** Saves the designer's layout for a built-in label; returns the file path. */
export const saveBuiltinTemplate = (label: string, template: Template) =>
  invoke<string>('save_template', { label, json: JSON.stringify(template) });

/** Deletes a built-in label's saved layout so its bundled one is used again. */
export const resetBuiltinTemplate = (label: string) => invoke<void>('reset_template', { label });
