/**
 * The webview's half of the local print API.
 *
 * Rust does the listening, the auth and the routing. It cannot render a label, though: pdfme, the
 * label database and the generator rules all live in here. So a label-mode request travels
 * Rust → this → Rust, and this does the rendering with exactly the code the Print tab uses, which
 * is what stops the API and the UI printing differently.
 *
 * Mounted once, at app level, so it works whatever tab is open and whatever the window is doing.
 * It has to keep working while the window is hidden in the tray — that is the whole reason the
 * desktop build hides instead of closing.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { type LabelId, listLabels, loadLabel } from '../labels';
import { renderLabelPdf, sendToPrinter } from '../printApi';
import { recordAttempt } from '../printHistory';
import type { ApiInput } from '../printRows';

/** One request from Rust, shaped by `BridgeRequest` in `api_server.rs`. */
type ApiRequest = { id: string; kind: 'labels' } | { id: string; kind: 'print'; request: PrintRequestBody };

/** The body of `POST /print`, as the plan specifies it. */
type PrintRequestBody = {
  label?: string;
  printer?: string;
  pages?: number;
  rows?: Record<string, string>[];
  api?: ApiInput;
  paper?: string;
  orientation?: string;
  rotate?: number;
  margins?: { top: number; right: number; bottom: number; left: number };
  dpi?: string;
  dryRun?: boolean;
};

/** The reply Rust is waiting for. Exactly one of `result` / `error` has to be set. */
type Reply = (Record<string, unknown> & { error?: never }) | { error: string; status?: number };

const ok = (result: Record<string, unknown>): Reply => result;
const fail = (error: string, status = 422): Reply => ({ error, status });

/** Turns anything thrown while rendering into a message worth sending to an integration. */
function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function ApiBridge() {
  const { user } = useAuth();
  // The listener is set up once, but it needs the current user to answer `/labels`, and it must not
  // be torn down and rebuilt every time a render happens.
  const signedIn = useRef(user);
  signedIn.current = user;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const stop = await listen<ApiRequest>('api-request', (event) => {
          void answer(signedIn.current, event.payload);
        });
        // Stopped while this was loading: do not leave a listener behind answering nothing.
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        // No event plugin in this build. There is no API to serve either, so nothing to do.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return null;
}

/**
 * Answers one request. Every path ends in a reply, including the ones that throw, because Rust is
 * blocked on this id until something arrives and an unanswered request costs the caller a timeout.
 */
async function answer(user: ReturnType<typeof useAuth>['user'], request: ApiRequest) {
  const reply = await (async (): Promise<Reply> => {
    try {
      if (request.kind === 'labels') {
        if (!user) return fail('Nobody is signed in', 409);
        const labels = await listLabels(user);
        // The name is what an integration puts in its own logs, and the size is what it needs to
        // pick a printer's media.
        return ok({
          user: user.username,
          labels: labels.map((l) => ({ id: l.id, name: l.name, widthMm: l.widthMm, heightMm: l.heightMm })),
        });
      }

      const body = request.request;
      if (!user) return fail('Nobody is signed in', 409);
      const label = body.label as LabelId;
      const content = await loadLabel(user, label);

      // A label that is not on this account is a 404, not a 422: the caller asked for something
      // that is not there, and a different body would not help.
      const found = (await listLabels(user)).find((l) => l.id === label);
      if (!found) return fail(`There is no label called “${label}” on this account`, 404);

      // The rows the caller sent are used as given. The label's own rules would overwrite every
      // field, so they are bypassed entirely rather than run afterwards.
      const pages = body.pages ?? 1;
      let explicitRows: Record<string, string>[] | undefined;

      if (body.rows?.length) {
        const problem = checkRowKeys(body.rows, Object.keys(content.generator.fields));
        if (problem) return fail(problem, 422);
        // One entry means "this data, this many times", which is what a caller sending a single
        // record means. More than one is a page each, and the page count is then implied by them.
        explicitRows = body.rows.length === 1 ? Array.from({ length: pages }, () => body.rows![0]) : body.rows;
      }

      const rendered = await renderLabelPdf({
        user,
        label,
        pages,
        api: body.api,
        rotate: (body.rotate ?? 0) as 0 | 90 | 180 | 270,
        margins: body.margins ?? { top: 0, right: 0, bottom: 0, left: 0 },
        rows: explicitRows,
      });

      if (body.dryRun) {
        return ok({ dryRun: true, pages: rendered.pageCount, pdf: base64(rendered.pdf) });
      }

      const report = await sendToPrinter(
        {
          printer: body.printer ?? '',
          paper: body.paper ?? '',
          orientation: (body.orientation ?? 'auto') as 'auto' | 'portrait' | 'landscape',
          dpi: body.dpi ?? '',
        },
        rendered.pdf,
        rendered.pageCount,
      );

      // The same history the UI writes, with `source` so an API print can be told apart later.
      recordAttempt(user, {
        at: Date.now(),
        labelId: label,
        labelName: found.name,
        printer: body.printer ?? '',
        outcome: 'ok',
        pages: rendered.pageCount,
        records: rendered.records,
        transport: report.transport,
        error: null,
        ms: 0,
        source: 'api',
      });

      return ok({
        status: 'printed',
        label,
        printer: body.printer,
        pages: rendered.pageCount,
        records: rendered.records,
        transport: report.transport,
        report: {
          paperApplied: report.paperApplied,
          paperNote: report.paperNote,
          orientation: report.orientation,
          dpiApplied: report.dpiApplied,
          dpiNote: report.dpiNote,
        },
      });
    } catch (e) {
      // Anything that went wrong in here is a problem with what the caller asked for, which is a
      // 422. A printer failure surfaces as its own message, so the caller can see which it was.
      return fail(why(e), 422);
    }
  })();

  try {
    await invoke('api_bridge_reply', { id: request.id, result: JSON.stringify(reply) });
  } catch {
    // Rust stopped waiting. Nothing to do and nothing to say: the caller already gave up or the
    // app is closing.
  }
}

/**
 * Checks the caller's `rows` against the label's field names.
 *
 * A misspelled key would print a blank field and nothing else would look wrong, so this is worth
 * catching. The message names the keys that do not exist and the ones that do.
 */
export function checkRowKeys(rows: Record<string, string>[], fields: string[]): string | null {
  const known = new Set(fields);
  const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !known.has(k));
  if (unknown.length === 0) return null;
  return unknown.length === 1
    ? `This label has no field called “${unknown[0]}”. Its fields are: ${[...known].join(', ')}.`
    : `This label has no field called ${unknown.map((u) => `“${u}”`).join(' or ')}. Its fields are: ${[...known].join(', ')}.`;
}

/** Base64, because the reply travels as JSON and a PDF is binary. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked, because `String.fromCharCode(...bytes)` overflows the stack on a big job.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
