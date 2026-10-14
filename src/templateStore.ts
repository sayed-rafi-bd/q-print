import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import { isTauri } from './platform';
import { builtin, isBuiltin } from './builtinLabels';
import { builtinSpec } from './generator/builtins';

// Must match the key used in the `font` option of Designer / generate().
const FONT_NAME = 'NotoSansJP';

/**
 * pdfme rejects a blank page that has no `padding` ("Invalid input" at basePdf), and refuses to
 * open the template at all. An earlier version saved new labels without it, so fill it in here
 * rather than leave those labels unopenable.
 */
export function withValidBasePdf(t: Template): Template {
  const base = t.basePdf as unknown;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return t;
  const { padding } = base as { padding?: unknown };
  const ok = Array.isArray(padding) && padding.length === 4
    && padding.every(n => typeof n === 'number' && Number.isFinite(n));
  return ok ? t : { ...t, basePdf: { ...base, padding: [0, 0, 0, 0] } as Template['basePdf'] };
}

/**
 * The pdfme Designer only applies a custom font to a text field when the field has an
 * explicit `fontName`; otherwise it falls back to the page's CSS font. Set it here.
 */
export function withFont(t: Template): Template {
  return {
    ...withValidBasePdf(t),
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

// In a browser there is no app-data folder, so a built-in's saved layout is kept in this browser's
// localStorage instead. Like the file, it is local to the device.
const webKey = (label: string) => `q-print.template.${label}`;

const webRead = (label: string): string | null => {
  try { return localStorage.getItem(webKey(label)); } catch { return null; }
};

const webWrite = (label: string, json: string) => {
  try { localStorage.setItem(webKey(label), json); } catch {
    throw new Error('This browser would not let the template be saved. Check that site storage is allowed.');
  }
};

/**
 * Reads the built-in label's layout: the one saved from the Designer, else its bundled one.
 *
 * Built-in labels are the only thing still stored as a file. Everything a user creates lives in
 * the database; see `src/labels.ts`.
 */
export async function loadBuiltinTemplate(label: string): Promise<{ template: Template; source: 'custom' | 'default' }> {
  const saved = isTauri() ? await invoke<string | null>('load_template', { label }) : webRead(label);
  if (!saved) return { template: defaultLabelTemplate(label), source: 'default' };
  try {
    return { template: withFont(JSON.parse(saved) as Template), source: 'custom' };
  } catch {
    throw new Error('The saved template is corrupt. Open the Designer and use "Reset to default".');
  }
}

/** Saves the designer's layout for a built-in label; returns where it went. */
export async function saveBuiltinTemplate(label: string, template: Template): Promise<string> {
  const json = JSON.stringify(template);
  if (isTauri()) return invoke<string>('save_template', { label, json });
  webWrite(label, json);
  return 'this browser';
}

/** Deletes a built-in label's saved layout so its bundled one is used again. */
export async function resetBuiltinTemplate(label: string): Promise<void> {
  if (isTauri()) return invoke<void>('reset_template', { label });
  try { localStorage.removeItem(webKey(label)); } catch { /* nothing was saved */ }
}
