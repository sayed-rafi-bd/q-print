import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import { getLabel, type LabelId } from './labels';

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

/** The template used for printing `label`: the one saved from the Designer, else the built-in default. */
export async function getTemplate(label: LabelId): Promise<{ template: Template; source: TemplateSource }> {
  const saved = await invoke<string | null>('load_template', { label });
  if (!saved) return { template: defaultLabelTemplate(label), source: 'default' };
  try {
    return { template: withFont(JSON.parse(saved) as Template), source: 'custom' };
  } catch {
    throw new Error('The saved template is corrupt. Open the Designer and use "Reset to default".');
  }
}

export const saveTemplate = (label: LabelId, template: Template) =>
  invoke<string>('save_template', { label, json: JSON.stringify(template) });

export const resetTemplate = (label: LabelId) => invoke<void>('reset_template', { label });

export const defaultLabelTemplate = (label: LabelId) => withFont(getLabel(label).defaultTemplate as Template);
