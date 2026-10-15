/**
 * Turns a label's generator into the rows a print job needs: one row per page.
 *
 * Kept apart from `printApi.ts` (which pulls in pdfme and Tauri) so the logic can be unit tested
 * with an injected fetcher. A label with an API data source fetches its records first, and fails
 * here, before any PDF is built, when the request or a record is wrong.
 */

import { fetchRecords } from './apiClient';
import { urlVariables } from './generator/apiSource';
import { generateRows, generateRowsFromRecords } from './generator/engine';
import type { GeneratorSpec } from './generator/spec';

/** What the person typed for a label that reads an API. The token lives in memory for one print only. */
export type ApiInput = { values: Record<string, string>; token?: string };

export type BuiltRows = {
  rows: Record<string, string>[];
  /** Number of API records, or null when the label has no API source. */
  records: number | null;
  /** Milliseconds spent on the API call (0 without one). */
  fetchMs: number;
};

type Fetcher = typeof fetchRecords;

export async function buildRows(
  generator: GeneratorSpec,
  pages: number,
  api?: ApiInput,
  fetcher: Fetcher = fetchRecords,
): Promise<BuiltRows> {
  if (!generator.source) {
    return { rows: generateRows(generator, pages), records: null, fetchMs: 0 };
  }
  if (!api) throw new Error('This label needs values for its URL. Fill in its Data source and try again.');
  const t0 = performance.now();
  const records = await fetcher(generator.source, api.values, api.token);
  const fetchMs = performance.now() - t0;
  return { rows: generateRowsFromRecords(generator, records, pages), records: records.length, fetchMs };
}

/**
 * What is still missing before a print may start, as one sentence, or null when it is ready.
 * Checked before any request is made, so a blank field never costs a round trip.
 */
export function missingInput(
  source: { url: string; bearerAuth?: boolean },
  values: Record<string, string>,
  token: string,
): string | null {
  for (const name of urlVariables(source.url)) {
    if (!(values[name] ?? '').trim()) return `Enter a value for “${name}”.`;
  }
  if (source.bearerAuth && !token.trim()) return 'Enter the access token for this label.';
  return null;
}

/** The values to start with: what was typed last time, else the label's default, else empty. */
export function startingValues(
  source: { url: string; variables?: Record<string, { default?: string }> },
  remembered: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of urlVariables(source.url)) {
    out[name] = remembered[name] ?? source.variables?.[name]?.default ?? '';
  }
  return out;
}
