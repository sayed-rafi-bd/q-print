/**
 * Turns a label's generator into the rows a print job needs: one row per page.
 *
 * Kept apart from `printApi.ts` (which pulls in pdfme and Tauri) so the logic can be unit tested
 * with an injected fetcher.
 *
 * A label with an `api` rule needs records, and a label with none does not. The address is not part
 * of the label: the person gives one per print, so `api` is required exactly when the rules say so,
 * and a label that needs nothing never makes a request.
 */

import { fetchRecords } from './apiClient';
import { type ApiRequest, checkSourceUrl, urlVariables } from './generator/apiSource';
import { generateRows, generateRowsFromRecords, hasApiRules } from './generator/engine';
import type { GeneratorSpec } from './generator/spec';

/** What the person typed to get records. Held for one print; the token is never written down. */
export type ApiInput = ApiRequest & {
  values: Record<string, string>;
  token?: string;
};

/** How many of a label's fields read from an API. Said once, here, for the print screen. */
export const usesApi = (generator: GeneratorSpec): boolean => hasApiRules(generator);

export type BuiltRows = {
  rows: Record<string, string>[];
  /** Number of API records, or null when the label has no API rules. */
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
  if (!hasApiRules(generator)) {
    return { rows: generateRows(generator, pages), records: null, fetchMs: 0 };
  }
  if (!api?.url.trim()) {
    throw new Error('This label reads data from an API. Enter an address to print it.');
  }
  const t0 = performance.now();
  const records = await fetcher(api, api.values, api.token);
  const fetchMs = performance.now() - t0;
  return { rows: generateRowsFromRecords(generator, records, pages), records: records.length, fetchMs };
}

/**
 * What is still missing before a print may start, as one sentence, or null when it is ready.
 * Checked before any request is made, so a blank field never costs a round trip. Only meaningful
 * for a label that has `api` rules, which is what {@link usesApi} says.
 */
export function missingInput(api: ApiInput): string | null {
  if (!api.url.trim()) return 'Enter the address to read the data from.';
  const problems = checkSourceUrl(api.url);
  if (problems.length > 0) return problems[0];
  for (const name of urlVariables(api.url)) {
    if (!(api.values[name] ?? '').trim()) return `Enter a value for “${name}”.`;
  }
  if (api.bearerAuth && !(api.token ?? '').trim()) return 'Enter the access token for this address.';
  return null;
}

/** The values to start with for a URL's variables: what was typed for this label last time. */
export function startingValues(url: string, remembered: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of urlVariables(url)) out[name] = remembered[name] ?? '';
  return out;
}
