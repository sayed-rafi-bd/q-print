import { invoke } from '@tauri-apps/api/core';
import { generate } from '@pdfme/generator';
import { text, rectangle, barcodes } from '@pdfme/schemas';
import template from './templates/label.json';

const FONT_URL = '/fonts/NotoSansJP-Regular.ttf';
let fontCache: ArrayBuffer | null = null;

export type Orientation = 'auto' | 'portrait' | 'landscape';

export type PrintReport = {
  tool: string;
  command: string;
  paperRequested: string;
  paperApplied: boolean;
  paperNote: string;
  orientation: string;
};

export type Timings = { data: number; pdf: number; print: number; total: number };

export const listPrinters = () => invoke<string[]>('list_printers');

// The Vite dev server answers a missing file with index.html (status 200), so checking
// `res.ok` is not enough. Check the file's magic bytes instead.
async function loadFont(): Promise<ArrayBuffer> {
  if (fontCache) return fontCache;
  const res = await fetch(FONT_URL);
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf.slice(0, 4));
  const tag = String.fromCharCode(...b);
  const valid =
    tag === 'OTTO' || tag === 'true' || tag === 'ttcf' ||
    (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0);
  if (!valid) {
    throw new Error(
      `${FONT_URL} is missing or is not a TTF/OTF file ` +
      `(got ${res.headers.get('content-type')}, ${buf.byteLength} bytes). ` +
      `Save a static Noto Sans JP Regular .ttf at public/fonts/NotoSansJP-Regular.ttf ` +
      `(exact name, no .woff2) and restart the dev server.`,
    );
  }
  fontCache = buf;
  return buf;
}

export async function printLabels(opts: { printer: string; paper: string; orientation: Orientation; pages: number },
): Promise<{ timings: Timings; report: PrintReport }> {
  const t0 = performance.now();

  // 1. random data, one row per page
  const rows = await invoke<Record<string, string>[]>('generate_random_data', { count: opts.pages });
  const t1 = performance.now();

  // 2. one multi-page PDF: pdfme makes one page per input row
  const fontData = await loadFont();
  const pdf = await generate({
    template: template as any,
    inputs: rows,
    plugins: { text, rectangle, ...barcodes },
    options: { font: { NotoSansJP: { data: fontData, fallback: true } } },
  });
  const t2 = performance.now();

  // 3. silent print with scale-to-fit
  const report = await invoke<PrintReport>('print_pdf', {
    printer: opts.printer,
    paper: opts.paper,
    orientation: opts.orientation,
    bytes: Array.from(pdf),
  });
  const t3 = performance.now();

  return { timings: { data: t1 - t0, pdf: t2 - t1, print: t3 - t2, total: t3 - t0 }, report };
}
