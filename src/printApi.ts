import { invoke } from '@tauri-apps/api/core';
import { generate } from '@pdfme/generator';
import { PDFDocument, degrees } from 'pdf-lib';
import { text, rectangle, barcodes } from '@pdfme/schemas';
import { getTemplate, type TemplateSource } from './templateStore';
import type { LabelId } from './labels';

const FONT_URL = '/fonts/NotoSansJP-Regular.ttf';
let fontCache: ArrayBuffer | null = null;

export type Orientation = 'auto' | 'portrait' | 'landscape';

export type Rotation = 0 | 90 | 180 | 270;

export type PrintReport = {
  /** 'sumatra' | 'android-dialog' | 'ipp' | 'raw' | 'vendor' */
  transport: string;
  tool: string;
  command: string;
  paperRequested: string;
  paperApplied: boolean;
  paperNote: string;
  orientation: string;
  dpiRequested: string;
  dpiApplied: boolean;
  dpiNote: string;
};

/** Jobs with more pages than this are sent as a raw binary payload instead of a JSON number array. */
const RAW_THRESHOLD_PAGES = 50;

export type Timings = { data: number; pdf: number; print: number; total: number };

export const listPrinters = () => invoke<string[]>('list_printers');

export type PrinterKind = 'ipp' | 'raw' | 'bluetooth' | 'usb';
/** What is sent. ipp: auto | pdf | pwg. raw: pdf | zpl | tspl | escpos | cpcl. bluetooth/usb: zpl | tspl | escpos | cpcl. */
export type PrinterLanguage = 'auto' | 'pdf' | 'pwg' | 'zpl' | 'tspl' | 'escpos' | 'cpcl';

/** A printer the user added (network, Bluetooth or USB). Prints without any dialog. */
export type SavedPrinter = {
  name: string;
  kind: PrinterKind;
  /** IP / host name (ipp, raw), Bluetooth MAC address, or USB "vendorId:productId" */
  host: string;
  /** TCP port (ipp, raw) */
  port: number;
  /** IPP resource path, e.g. /ipp/print (ipp only) */
  path: string;
  language: PrinterLanguage;
  /** resolution the page is rendered at when sent as a bitmap */
  dpi: number;
};
/** A printer found on the network (mDNS), ready to fill the form. */
export type DiscoveredPrinter = { name: string; kind: 'ipp' | 'raw'; host: string; port: number; path: string };
/** A paired Bluetooth device or a connected USB printer. `id` is the MAC address / "vid:pid". */
export type PickableDevice = { name: string; id: string };
export type PrinterTest = { summary: string; supportsPdf: boolean | null };

export const listSavedPrinters = () => invoke<SavedPrinter[]>('list_saved_printers');
export const savePrinter = (printer: SavedPrinter) => invoke<void>('save_printer', { printer });
export const deletePrinter = (name: string) => invoke<void>('delete_printer', { name });
export const discoverPrinters = () => invoke<DiscoveredPrinter[]>('discover_printers');
export const listDevices = (kind: 'bluetooth' | 'usb') => invoke<PickableDevice[]>('list_devices', { kind });
export const testPrinter = (printer: SavedPrinter) => invoke<PrinterTest>('test_printer', { printer });
export const printerResolutions = (printer: string) => invoke<string[]>('printer_resolutions', { printer });

export type Margins = { top: number; right: number; bottom: number; left: number };
export const NO_MARGINS: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

const MM = 72 / 25.4;

// Post-processes every page inside the PDF itself, so it works the same on any printer driver.
//  - margins (mm, in the label's own orientation): positive adds white space around the label
//    (label prints smaller), negative trims the label's edge (label prints larger). SumatraPDF's
//    "fit" then scales the resulting page box to the printable area.
//  - rotate: turns the page 0/90/180/270.
async function postProcessPdf(bytes: Uint8Array, angle: Rotation, m: Margins): Promise<Uint8Array> {
  const hasMargin = m.top || m.right || m.bottom || m.left;
  if (!angle && !hasMargin) return bytes;
  const doc = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    if (hasMargin) {
      const { x, y, width, height } = page.getMediaBox();
      const nx = x - m.left * MM;
      const ny = y - m.bottom * MM;
      const nw = width + (m.left + m.right) * MM;
      const nh = height + (m.top + m.bottom) * MM;
      if (nw < 10 || nh < 10) throw new Error('Margins are too large: nothing of the label would be left.');
      page.setMediaBox(nx, ny, nw, nh);
      page.setCropBox(nx, ny, nw, nh);
    }
    if (angle) page.setRotation(degrees((page.getRotation().angle + angle) % 360));
  }
  return doc.save();
}

// The Vite dev server answers a missing file with index.html (status 200), so checking
// `res.ok` is not enough. Check the file's magic bytes instead.
export async function loadFont(): Promise<ArrayBuffer> {
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

export async function printLabels(opts: { label: LabelId; printer: string; paper: string; orientation: Orientation; rotate: Rotation; margins: Margins; dpi: string; pages: number },
): Promise<{ timings: Timings; report: PrintReport; templateSource: TemplateSource }> {
  const t0 = performance.now();

  // 1. random data, one row per page
  const [rows, { template, source }] = await Promise.all([
    invoke<Record<string, string>[]>('generate_random_data', { count: opts.pages, label: opts.label }),
    getTemplate(opts.label),
  ]);
  const t1 = performance.now();

  // 2. one multi-page PDF: pdfme makes one page per input row
  const fontData = await loadFont();
  const generated = await generate({
    template,
    inputs: rows,
    plugins: { text, rectangle, ...barcodes },
    options: { font: { NotoSansJP: { data: fontData, fallback: true } } },
  });
  const pdf = await postProcessPdf(generated, opts.rotate, opts.margins);
  const t2 = performance.now();

  // 3. print (silent with scale-to-fit where the platform allows it, else the system dialog)
  const printOpts = { printer: opts.printer, paper: opts.paper, orientation: opts.orientation, dpi: opts.dpi };
  const report = opts.pages > RAW_THRESHOLD_PAGES
    ? await invoke<PrintReport>('print_pdf_raw', pdf, {
        // header values must be ASCII; printer names may not be
        headers: { 'x-print-options': encodeURIComponent(JSON.stringify(printOpts)) },
      })
    : await invoke<PrintReport>('print_pdf', { ...printOpts, bytes: Array.from(pdf) });
  const t3 = performance.now();

  return {
    timings: { data: t1 - t0, pdf: t2 - t1, print: t3 - t2, total: t3 - t0 },
    report,
    templateSource: source,
  };
}
