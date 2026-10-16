import { generate } from '@pdfme/generator';
import { barcodes, rectangle, text } from '@pdfme/schemas';
import { invoke } from '@tauri-apps/api/core';
import { degrees, PDFDocument } from 'pdf-lib';
import type { User } from './db/users';
import { type LabelId, loadLabel } from './labels';
import { type ApiInput, buildRows } from './printRows';

const FONT_URL = '/fonts/NotoSansJP-Regular.ttf';
let fontCache: ArrayBuffer | null = null;

export type Orientation = 'auto' | 'portrait' | 'landscape';

export type Rotation = 0 | 90 | 180 | 270;

export type PrintReport = {
  /** 'sumatra' | 'cups' | 'android-dialog' | 'ipp' | 'raw' | 'vendor' */
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

/** `fetch` is the API call; it is 0 for a label without an API source. */
export type Timings = { fetch: number; data: number; pdf: number; print: number; total: number };

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
    tag === 'OTTO' || tag === 'true' || tag === 'ttcf' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0);
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

/** What to render. Everything needed to turn a label plus data into a PDF, and nothing about how
 * it is printed, so the same call can end in a printer or in a dry run that returns the PDF. */
export type RenderOptions = {
  user: User;
  label: LabelId;
  /** Copies of each record for a label with an API source; otherwise the number of pages. */
  pages: number;
  /** Required when the label has an API source. */
  api?: ApiInput;
  rotate: Rotation;
  margins: Margins;
  /**
   * Explicit rows, one per page. When these are given the label's own generator does not run at
   * all, so a caller's data reaches the label exactly as sent.
   *
   * This is how the local print API's `rows` field is honoured: without it the generator would
   * overwrite every field and the caller would get a different label from the one they asked for.
   */
  rows?: Record<string, string>[];
};

/** A rendered PDF, ready to send to a printer or to hand back to a caller that only wanted to see it. */
export type Rendered = {
  pdf: Uint8Array;
  /** The real number of pages. */
  pageCount: number;
  /** API records read, or null when the label has no API source. */
  records: number | null;
  templateSource: 'custom' | 'default' | 'custom label';
  /** How long the rows took, and how long the PDF. */
  dataMs: number;
  fetchMs: number;
  pdfMs: number;
};

/** Where a PDF is going, and how. */
export type PrintTarget = {
  printer: string;
  paper: string;
  orientation: Orientation;
  dpi: string;
};

/**
 * Turns a label and its data into a PDF, without printing it.
 *
 * Split out from `printLabels` so the print API can render and stop there: a `dryRun` hands the
 * caller exactly this PDF. The UI still goes through `printLabels`, which calls this and then
 * `sendToPrinter`, so there is one rendering path and the two can never produce different output.
 */
export async function renderLabelPdf(opts: RenderOptions): Promise<Rendered> {
  const t0 = performance.now();

  // 1. the label's template and generator. The rows are built here too, so nothing has to cross
  //    the IPC boundary just to be randomised -- unless the caller supplied them, in which case
  //    the generator would overwrite what they sent.
  const { template, source, generator } = await loadLabel(opts.user, opts.label);
  const built = opts.rows
    ? { rows: opts.rows, records: null, fetchMs: 0 }
    : await buildRows(generator, opts.pages, opts.api);
  const { rows, records, fetchMs } = built;
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

  return {
    pdf,
    pageCount: rows.length,
    records,
    templateSource: source,
    dataMs: t1 - t0 - fetchMs,
    fetchMs,
    pdfMs: t2 - t1,
  };
}

/**
 * Hands a PDF to the platform's print backend. The `PRINT_LOCK` in Rust serialises this against
 * every other job, including ones the local API started.
 *
 * The page count is passed in rather than measured from the PDF: the caller already knows it, and
 * counting it out of the bytes would be a guess that could send the two forms differently.
 */
export async function sendToPrinter(target: PrintTarget, pdf: Uint8Array, pageCount: number): Promise<PrintReport> {
  return pageCount > RAW_THRESHOLD_PAGES
    ? await invoke<PrintReport>('print_pdf_raw', pdf, {
        // header values must be ASCII; printer names may not be
        headers: { 'x-print-options': encodeURIComponent(JSON.stringify(target)) },
      })
    : await invoke<PrintReport>('print_pdf', { ...target, bytes: Array.from(pdf) });
}

export async function printLabels(opts: {
  user: User;
  label: LabelId;
  printer: string;
  paper: string;
  orientation: Orientation;
  rotate: Rotation;
  margins: Margins;
  dpi: string;
  /** Copies of each record for a label with an API source; otherwise the number of pages. */
  pages: number;
  /** Required when the label has an API source. */
  api?: ApiInput;
}): Promise<{
  timings: Timings;
  report: PrintReport;
  templateSource: 'custom' | 'default' | 'custom label';
  /** The real number of pages sent. */
  pageCount: number;
  /** API records read, or null when the label has no API source. */
  records: number | null;
}> {
  const t0 = performance.now();
  const rendered = await renderLabelPdf(opts);
  const t1 = performance.now();

  const report = await sendToPrinter(
    { printer: opts.printer, paper: opts.paper, orientation: opts.orientation, dpi: opts.dpi },
    rendered.pdf,
    rendered.pageCount,
  );
  const t2 = performance.now();

  return {
    timings: {
      fetch: rendered.fetchMs,
      data: rendered.dataMs,
      pdf: rendered.pdfMs,
      print: t2 - t1,
      total: t2 - t0,
    },
    report,
    templateSource: rendered.templateSource,
    pageCount: rendered.pageCount,
    records: rendered.records,
  };
}
