import { describe, expect, it } from 'vitest';
import { type SnippetRequest, snippetFor, snippets, TOKEN_PLACEHOLDER } from './snippets';

/**
 * The lines on this page get pasted into somebody else's program. A wrong one is not a compile
 * error, it is a bug report days later, so they are worth testing on their own.
 */

const base: SnippetRequest = {
  method: 'GET',
  path: '/printers',
  baseUrl: 'http://127.0.0.1:17631/api/v1',
  token: 'a'.repeat(64),
  includeToken: false,
};

const printing: SnippetRequest = {
  ...base,
  method: 'POST',
  path: '/print',
  body: '{"label":"product","printer":"Office","pages":2,"rows":[{"name":"Tea"}]}',
};

describe('the token', () => {
  it('is a placeholder unless the person asked for the real one', () => {
    // The most-copied text on the page, and the most likely to end up in a ticket or a screenshot.
    // A leaked token spends paper until somebody notices.
    for (const language of ['curl', 'powershell', 'javascript'] as const) {
      expect(snippetFor({ ...printing, token: 'secret-token' }, language)).toContain(TOKEN_PLACEHOLDER);
      expect(snippetFor({ ...printing, token: 'secret-token' }, language)).not.toContain('secret-token');
    }
  });

  it('is the real one when it is asked for', () => {
    const r: SnippetRequest = { ...printing, token: 'secret-token', includeToken: true };
    expect(snippetFor(r, 'curl')).toContain('secret-token');
    expect(snippetFor(r, 'powershell')).toContain('secret-token');
    expect(snippetFor(r, 'javascript')).toContain('secret-token');
  });
});

describe('the URL', () => {
  it('joins the base and the path without doubling the slash', () => {
    expect(snippetFor({ ...base, baseUrl: 'http://127.0.0.1:17631/api/v1/' }, 'curl')).toContain(
      'http://127.0.0.1:17631/api/v1/printers',
    );
  });

  it('keeps a query string the page built for a PDF print', () => {
    // The printer name has to stay in the URL, because that is where the endpoint reads it from.
    const code = snippetFor(
      { method: 'POST', path: '/print/pdf?printer=Front%20desk', baseUrl: base.baseUrl, token: '', includeToken: true },
      'curl',
    );
    expect(code).toContain('/print/pdf?printer=Front%20desk');
  });
});

describe('a request with no body', () => {
  it('sends no content type, because there is nothing to describe', () => {
    const code = snippetFor(base, 'curl');
    expect(code).not.toContain('Content-Type');
    expect(code).toContain('curl -X GET');
    expect(snippetFor(base, 'javascript')).not.toContain('body:');
  });
});

describe('a JSON request', () => {
  it('carries the body, flattened so it fits on the command line', () => {
    const code = snippetFor(printing, 'curl');
    expect(code).toContain('-H "Content-Type: application/json"');
    expect(code).toContain('"label":"product"');
    // Newlines inside a single-quoted shell argument are a portability trap, not a style choice.
    expect(code).not.toMatch(/-d '[^']*\n[^']*'/);
  });

  it('shows PowerShell the body as a real string', () => {
    const code = snippetFor(printing, 'powershell');
    expect(code).toContain("$body = '{");
    expect(code).toContain('Invoke-RestMethod -Method POST');
  });

  it('shows JavaScript a readable object, not a pasted string', () => {
    const code = snippetFor(printing, 'javascript');
    expect(code).toContain('body: JSON.stringify({');
    // Indented, so the pasted code is something a person can read.
    expect(code).toContain('\n    "label": "product"');
  });

  it('survives a body that is not valid JSON', () => {
    // The page lets a person type anything; a broken snippet is worse than an honest string.
    const code = snippetFor({ ...printing, body: '{oops' }, 'javascript');
    expect(code).toContain('JSON.stringify("{oops")');
  });
});

describe('a PDF request', () => {
  const pdf: SnippetRequest = { ...base, method: 'POST', path: '/print/pdf?printer=Office' };

  it('sends the file, not a JSON body, because the body is the PDF', () => {
    expect(snippetFor({ ...pdf, filePath: 'label.pdf' }, 'curl')).toContain('--data-binary "@label.pdf"');
    expect(snippetFor({ ...pdf, filePath: 'label.pdf' }, 'curl')).toContain('"Content-Type: application/pdf"');
  });

  it('uses -AsByteStream in PowerShell, because a PDF cannot be read as text', () => {
    // `-Raw` on a PDF is the mistake everybody makes with this endpoint, so the snippet shows the
    // form that works rather than the shorter one that does not.
    const code = snippetFor({ ...pdf, filePath: 'label.pdf' }, 'powershell');
    expect(code).toContain('-AsByteStream');
    expect(code).not.toMatch(/Get-Content[^\n]*-Raw/);
  });

  it('assumes bytes the caller has already read in JavaScript', () => {
    const code = snippetFor({ ...pdf, filePath: 'label.pdf' }, 'javascript');
    expect(code).toContain('body: fileBytes');
    expect(code).toContain('"Content-Type": "application/pdf"');
  });
});

describe('the result of asking', () => {
  it('offers all three languages', () => {
    expect(snippets(printing).map((s) => s.language)).toEqual(['curl', 'powershell', 'javascript']);
    for (const s of snippets(printing)) expect(s.code.length).toBeGreaterThan(0);
  });
});
