/**
 * Fetches the records a label's API data source describes.
 *
 * In the app the request is made by Rust (`fetch_json` in `src-tauri/src/http.rs`), which is not
 * subject to CORS and enforces the size, time and redirect rules. In a plain browser (the web
 * build, `pnpm dev`) it falls back to `fetch`, where the server has to allow the page's origin.
 *
 * The access token is used for this one request. It is never stored, logged or put in an error.
 */

import { invoke } from '@tauri-apps/api/core';
import { buildUrl, checkSourceUrl, extractRecords } from './generator/apiSource';
import { LIMITS } from './generator/engine';
import type { ApiSource } from './generator/spec';
import { isTauri } from './platform';

/** Gets the response body as text. Injectable so the logic around it can be tested. */
export type Transport = (url: string, bearer: string | undefined, signal?: AbortSignal) => Promise<string>;

/** How much of an error response is quoted back, matching `http.rs`. */
const ERROR_BODY_CHARS = 200;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Replaces the token wherever it appears, as a last line of defence against leaking it. */
export const scrub = (text: string, token: string | undefined): string =>
  token ? text.split(token).join('***') : text;

/** The request made by the app's Rust side. */
export const makeTauriTransport =
  (invokeFn: (cmd: string, args: Record<string, unknown>) => Promise<unknown> = invoke): Transport =>
  async (url, bearer) => {
    try {
      return (await invokeFn('fetch_json', { url, bearer: bearer ?? null })) as string;
    } catch (e) {
      // Rust returns plain-text errors that never contain the token; scrub anyway.
      throw new Error(scrub(message(e), bearer));
    }
  };

/** The fallback for a plain browser. */
export const browserTransport: Transport = async (url, bearer, signal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const host = new URL(url).host;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) {
        const seconds = LIMITS.fetchTimeoutMs / 1000;
        throw new Error(signal?.aborted ? 'The request was cancelled.' : `${host} did not answer within ${seconds} seconds.`);
      }
      throw new Error(
        `Could not reach ${host}. In a browser this is often CORS: the server must allow requests from this page. ` +
          `The desktop and Android apps are not affected. (${scrub(message(e), bearer)})`,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).split(/\s+/).filter(Boolean).join(' ').slice(0, ERROR_BODY_CHARS);
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`.trim());
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > LIMITS.maxResponseBytes) throw new Error(tooLarge());
    const text = await res.text();
    if (new TextEncoder().encode(text).length > LIMITS.maxResponseBytes) throw new Error(tooLarge());
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const tooLarge = (): string => `The response is larger than ${LIMITS.maxResponseBytes / 1024 / 1024} MB.`;

/**
 * Builds the URL from the pattern and the typed values, fetches it, and returns the records.
 *
 * `token` is sent only when the source asks for bearer auth, and never over plain `http://`.
 * Every error is a sentence the person can read.
 */
export async function fetchRecords(
  source: ApiSource,
  values: Record<string, string>,
  token?: string,
  opts: { signal?: AbortSignal; transport?: Transport } = {},
): Promise<unknown[]> {
  const problems = checkSourceUrl(source.url);
  if (problems.length > 0) throw new Error(problems[0]);

  const url = buildUrl(source.url, values);
  const bearer = source.bearerAuth ? token?.trim() || undefined : undefined;
  if (source.bearerAuth && !bearer) throw new Error('Enter the access token for this label.');
  if (bearer && !/^https:\/\//i.test(url)) throw new Error('Refusing to send an access token without HTTPS.');

  const transport = opts.transport ?? (isTauri() ? makeTauriTransport() : browserTransport);
  let text: string;
  try {
    text = await transport(url, bearer, opts.signal);
  } catch (e) {
    throw new Error(scrub(message(e), bearer));
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The response is not valid JSON.');
  }
  return extractRecords(json, source.listPath);
}
