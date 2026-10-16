/**
 * Turning a request on the API tab into copy-and-paste code.
 *
 * Pure, and the only part of the API tab worth testing on its own: these are the lines an
 * integrator pastes into their own program, and a wrong one is a bug report rather than a
 * compile error.
 *
 * The token is a **placeholder** unless the person has ticked "include token". A snippet is the
 * most-copied text on the page and the most likely to end up pasted into a ticket, a chat, or a
 * screenshot of the tab, and a token in any of those spends the user's paper until it is noticed.
 */

export type SnippetRequest = {
  method: 'GET' | 'POST';
  /** Path below the base URL, e.g. `/print`. */
  path: string;
  /** e.g. `http://127.0.0.1:17631/api/v1` */
  baseUrl: string;
  token: string;
  /** Whether the real token is written out rather than a placeholder. */
  includeToken: boolean;
  /** Request body as JSON text, for `POST`. */
  body?: string;
  /** Path to a PDF on the caller's disk, for `/print/pdf`, whose body is the file itself. */
  filePath?: string;
};

export const TOKEN_PLACEHOLDER = '<your-token>';

export type Language = 'curl' | 'powershell' | 'javascript';

export type Snippet = { language: Language; label: string; code: string };

const tokenFor = (r: SnippetRequest) => (r.includeToken ? r.token : TOKEN_PLACEHOLDER);

/** The full URL, with a trailing slash on the base not doubled up. */
const url = (r: SnippetRequest) => `${r.baseUrl.replace(/\/+$/, '')}${r.path}`;

/** The query parameters of a `/print/pdf` request, as a map. */
function pdfQuery(r: SnippetRequest): [string, string][] {
  const query = new URLSearchParams();
  // The path carries `?printer=...` already, parsed out of the URL the tab is about to send.
  const parsed = new URL(url(r), 'http://127.0.0.1');
  for (const [k, v] of parsed.searchParams) query.set(k, v);
  return [...query.entries()];
}

function curl(r: SnippetRequest): string {
  const target = url(r);
  const parts = [`curl -X ${r.method} "${target}"`, `  -H "Authorization: Bearer ${tokenFor(r)}"`];
  if (r.method === 'POST' && r.filePath) {
    // The body is the file, which is the whole point of this endpoint.
    parts.push(`  -H "Content-Type: application/pdf"`, `  --data-binary "@${r.filePath}"`);
  } else if (r.method === 'POST' && r.body) {
    parts.push('  -H "Content-Type: application/json"', `  -d '${r.body.replace(/\s+/g, ' ')}'`);
  }
  return parts.join(' \\\n');
}

function powershell(r: SnippetRequest): string {
  const target = url(r);
  const body = r.method === 'POST' ? r.body : undefined;
  if (r.filePath && r.method === 'POST') {
    // `Get-Content -Raw -Encoding Byte` then -AsByteStream: a PDF cannot go through -Raw as text,
    // which is the mistake everybody makes with this endpoint.
    return [
      `$headers = @{ Authorization = "Bearer ${tokenFor(r)}" }`,
      `$body = Get-Content -Path '${r.filePath}' -AsByteStream`,
      `Invoke-RestMethod -Method ${r.method} -Uri "${target}" -Headers $headers \\`,
      `  -ContentType "application/pdf" -Body $body`,
    ].join('\n');
  }
  const parts = [`$headers = @{ Authorization = "Bearer ${tokenFor(r)}" }`];
  if (body) {
    parts.push(`$body = '${body.replace(/s+/g, ' ')}'`);
    parts.push(
      `Invoke-RestMethod -Method ${r.method} -Uri "${target}" -Headers $headers \\`,
      `  -ContentType "application/json" -Body $body`,
    );
  } else {
    parts.push(`Invoke-RestMethod -Method ${r.method} -Uri "${target}" -Headers $headers`);
  }
  return parts.join('\n');
}

function javascript(r: SnippetRequest): string {
  const target = url(r);
  const lines = [
    `const response = await fetch("${target}", {`,
    `  method: "${r.method}",`,
    `  headers: {`,
    `    Authorization: "Bearer ${tokenFor(r)}",`,
  ];
  if (r.method === 'POST' && r.filePath) {
    lines.push(`    "Content-Type": "application/pdf",`, `  },`, `  body: fileBytes,`);
  } else if (r.method === 'POST' && r.body) {
    lines.push(`    "Content-Type": "application/json",`, `  },`, `  body: JSON.stringify(${pretty(r.body)}),`);
  } else {
    lines.push(`  },`);
  }
  lines.push(
    `});`,
    `if (!response.ok) throw new Error(await response.text());`,
    `const result = await response.json();`,
  );
  return lines.join('\n');
}

/** Re-indents a JSON string so the snippet shows a readable object literal. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
      .split('\n')
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join('\n');
  } catch {
    // Not JSON, so it is whatever the person typed. Shown as a string rather than dropped.
    return JSON.stringify(body);
  }
}

export function snippetFor(r: SnippetRequest, language: Language): string {
  if (language === 'curl') return curl(r);
  if (language === 'powershell') return powershell(r);
  return javascript(r);
}

/** All three, in the order the page shows them. */
export function snippets(r: SnippetRequest): Snippet[] {
  return [
    { language: 'curl', label: 'curl (macOS / Linux)', code: snippetFor(r, 'curl') },
    { language: 'powershell', label: 'PowerShell (Windows)', code: snippetFor(r, 'powershell') },
    { language: 'javascript', label: 'JavaScript (fetch)', code: snippetFor(r, 'javascript') },
  ];
}

export { pdfQuery };
