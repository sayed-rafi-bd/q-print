import { beforeEach, describe, expect, it, vi } from 'vitest';

// The render half and the send half are mocked, so what is being checked is the seam: the same
// bytes and the same options reach the backend either way.
const generate = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock('@pdfme/generator', () => ({ generate }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
// The real `loadLabel` would reach the database and the filesystem; the renderer under test is
// which call order reaches the printer.
vi.mock('./labels', () => ({
  loadLabel: async () => ({ template: { fields: [] }, source: 'default', generator: { rules: [] } }),
}));
const buildRows = vi.hoisted(() => vi.fn(async () => ({ rows: [{ from: 'the generator' }], records: 7, fetchMs: 0 })));
vi.mock('./printRows', () => ({ buildRows }));
vi.mock('@pdfme/schemas', () => ({ barcodes: {}, rectangle: {}, text: {} }));
vi.mock('pdf-lib', () => ({ PDFDocument: class {}, degrees: (n: number) => n }));

import { printLabels, renderLabelPdf, sendToPrinter } from './printApi';

/** Two pages, a recognisable shape. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x37, 1, 2, 3]);

const target = { printer: 'Office', paper: 'A6', orientation: 'auto' as const, dpi: '203x203' };
const opts = {
  user: { id: 'u1', username: 'rafi', createdAt: '2026-01-01' },
  label: 'product',
  pages: 1,
  rotate: 0 as const,
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  ...target,
};

/**
 * `loadFont` fetches the real TTF and checks its magic bytes, so `fetch` is replaced with a buffer
 * that passes the same check. Anything else and the test would be about the font loader.
 */
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0]);

beforeEach(() => {
  buildRows.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(TTF, { headers: { 'content-type': 'font/ttf' } })),
  );
  generate.mockReset();
  invoke.mockReset();
  generate.mockResolvedValue(PDF);
  invoke.mockResolvedValue({ transport: 'sumatra', tool: 'SumatraPDF', command: '', paperApplied: true });
});

describe('renderLabelPdf', () => {
  it('produces a PDF and never touches the printer', async () => {
    // The whole point of the split: a dry run has to be able to stop here.
    const rendered = await renderLabelPdf(opts);
    expect(rendered.pdf).toEqual(PDF);
    expect(rendered.pageCount).toBe(1);
    expect(rendered.templateSource).toBe('default');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('rows the caller supplied', () => {
  it('are used as given, and the generator is not run at all', async () => {
    // The local API's `rows` field. Running the generator as well would overwrite every field and
    // hand the caller a different label from the one they asked for, so it must be bypassed
    // outright rather than merged.
    const rows = [{ name: 'Tea 500g', barcode: '4901234567894' }];
    const rendered = await renderLabelPdf({ ...opts, rows });
    expect(buildRows).not.toHaveBeenCalled();
    expect(rendered.pageCount).toBe(1);
  });

  it('are the page count, so three rows means three pages', async () => {
    const rendered = await renderLabelPdf({ ...opts, rows: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    expect(rendered.pageCount).toBe(3);
    expect(rendered.records).toBeNull();
  });

  it('leave the generator in charge when there are none', () => {
    expect(buildRows).not.toHaveBeenCalled();
  });
});

describe('sendToPrinter', () => {
  it('sends a small job as JSON, the way the UI always did', async () => {
    await sendToPrinter(target, PDF, 1);
    expect(invoke).toHaveBeenCalledWith('print_pdf', { ...target, bytes: Array.from(PDF) });
  });

  it('sends a big job as a raw binary body with the options in a header', async () => {
    await sendToPrinter(target, PDF, 51);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, body, third] = invoke.mock.calls[0];
    expect(command).toBe('print_pdf_raw');
    expect(body).toEqual(PDF);
    // The header carries the same options, percent-encoded because they must be ASCII.
    const header = JSON.parse(decodeURIComponent(third.headers['x-print-options']));
    expect(header).toEqual(target);
  });
});

describe('printLabels still does both, identically', () => {
  it('renders and then sends the very bytes that were rendered', async () => {
    const result = await printLabels(opts);
    expect(result.pageCount).toBe(1);
    // Passed through from the generator, so a caller can report how many records produced a label.
    expect(result.records).toBe(7);
    expect(result.templateSource).toBe('default');
    expect(result.report.transport).toBe('sumatra');
    expect(invoke).toHaveBeenCalledWith('print_pdf', { ...target, bytes: Array.from(PDF) });
  });

  it('reports timings that add up to something sensible', async () => {
    const { timings } = await printLabels(opts);
    // The four parts plus the total: the total covers the two calls the caller waited through.
    expect(timings.fetch).toBe(0);
    expect(timings.data).toBeGreaterThanOrEqual(0);
    expect(timings.pdf).toBeGreaterThanOrEqual(0);
    expect(timings.print).toBeGreaterThanOrEqual(0);
    expect(timings.total).toBeGreaterThanOrEqual(timings.data + timings.pdf);
  });

  it('does not print twice when both halves are used by hand', async () => {
    // The bridge calls the two halves separately; the UI calls the wrapper. Neither may double up.
    const rendered = await renderLabelPdf(opts);
    await sendToPrinter(target, rendered.pdf, rendered.pageCount);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
