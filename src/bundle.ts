/**
 * Reading and writing a label file: a pdfme template plus the generator that fills it.
 *
 * Kept pure so both the Designer and the import/export panel can use it, and so the round trip can
 * be tested without a filesystem or Tauri.
 */

import type { Template } from '@pdfme/common';
import { validateSpec } from './generator/engine';
import type { GeneratorSpec, LabelBundle } from './generator/spec';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The largest file accepted from a download or paste, to match what the backend allows. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** Throws unless `value` looks like a pdfme template. */
export function parseTemplate(text: string): Template {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${errMsg(e)}`);
  }
  if (!isTemplate(value)) {
    throw new Error('This does not look like a pdfme template (needs "basePdf" and "schemas").');
  }
  return value;
}

export function isTemplate(value: unknown): value is Template {
  const t = value as Partial<Template> | null;
  return !!t && typeof t === 'object' && Array.isArray(t.schemas) && t.basePdf != null;
}

/** True for a label file we wrote; a plain pdfme template is *not* a bundle. */
export function isBundle(value: unknown): value is LabelBundle {
  const b = value as Partial<LabelBundle> | null;
  return !!b && typeof b === 'object' && b.format === 'q-print-label' && isTemplate(b.template);
}

/**
 * Parses a label file, returning it alongside whether it was a bundle or a bare template.
 * A bare template is what older versions exported; it imports as a template only.
 */
export function parseBundle(text: string): { bundle?: LabelBundle; template?: Template } {
  if (text.length > MAX_BUNDLE_BYTES) {
    throw new Error(`This file is ${(text.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${errMsg(e)}`);
  }
  if (isBundle(value)) {
    const bundle = value;
    // A generator that cannot run is not worth importing; say why instead of failing at print time.
    const problems = validateSpec(bundle.generator);
    if (problems.length > 0) throw new Error(`This label's data generator is not usable. ${problems[0]}`);
    return { bundle };
  }
  return { template: parseTemplate(text) };
}

export function bundleJson(bundle: LabelBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** Builds a label file around a template, filling in a generator that matches its fields. */
export function makeBundle(name: string, template: Template, generator: GeneratorSpec): LabelBundle {
  return { format: 'q-print-label', version: 1, name, template, generator };
}

/** The page size a template declares, in mm. pdfme stores `basePdf` in millimetres. */
export function templateSizeMm(template: Template | null | undefined): { widthMm: number; heightMm: number } | null {
  const base = template?.basePdf as { width?: unknown; height?: unknown } | undefined;
  const w = base?.width;
  const h = base?.height;
  if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return null;
  return { widthMm: w, heightMm: h };
}
