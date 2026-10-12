import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import defaultTemplate from './templates/label.json';

export type TemplateSource = 'custom' | 'default';

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

/** The template used for printing: the one saved from the Designer, else the built-in default. */
export async function getTemplate(): Promise<{ template: Template; source: TemplateSource }> {
  const saved = await invoke<string | null>('load_template');
  if (!saved) return { template: withFont(defaultTemplate as unknown as Template), source: 'default' };
  try {
    return { template: withFont(JSON.parse(saved) as Template), source: 'custom' };
  } catch {
    throw new Error('The saved template is corrupt. Open the Designer and use "Reset to default".');
  }
}

export const saveTemplate = (template: Template) =>
  invoke<string>('save_template', { json: JSON.stringify(template) });

export const resetTemplate = () => invoke<void>('reset_template');

export const defaultLabelTemplate = () => withFont(defaultTemplate as unknown as Template);
