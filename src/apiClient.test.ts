import { afterEach, describe, expect, it } from 'vitest';
import { browserTransport, fetchRecords, makeTauriTransport, scrub, type Transport } from './apiClient';
import type { ApiRequest } from './generator/apiSource';

const source: ApiRequest = { url: 'api.example.com/day/{day}/count/{count}/logs' };
const values = { day: '15', count: '3' };

/** A transport that records what it was asked for and answers with `body`. */
const fake = (body: string) => {
  const calls: { url: string; bearer: string | undefined }[] = [];
  const transport: Transport = async (url, bearer) => {
    calls.push({ url, bearer });
    return body;
  };
  return { transport, calls };
};

describe('fetchRecords', () => {
  it('builds the URL and returns one record per list item', async () => {
    const { transport, calls } = fake('[{"a":1},{"a":2}]');
    expect(await fetchRecords(source, values, undefined, { transport })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(calls).toEqual([{ url: 'https://api.example.com/day/15/count/3/logs', bearer: undefined }]);
  });

  it('returns an object response as one record, and follows the list path', async () => {
    expect(await fetchRecords(source, values, undefined, { transport: fake('{"a":1}').transport })).toEqual([{ a: 1 }]);
    const nested = { ...source, listPath: 'data.items' };
    const { transport } = fake('{"data":{"items":[{"a":1},{"a":2}]}}');
    expect(await fetchRecords(nested, values, undefined, { transport })).toHaveLength(2);
  });

  it('checks the URL and the values before any request is made', async () => {
    const { transport, calls } = fake('{}');
    await expect(fetchRecords({ url: 'file:///x' }, {}, undefined, { transport })).rejects.toThrow(
      /Only http and https/,
    );
    await expect(fetchRecords(source, { day: '15' }, undefined, { transport })).rejects.toThrow(
      'Enter a value for “count”.',
    );
    expect(calls).toHaveLength(0);
  });

  it('sends the token only when bearer auth is asked for', async () => {
    const bearer = { ...source, bearerAuth: true };
    const a = fake('{}');
    await fetchRecords(bearer, values, '  tok-123  ', { transport: a.transport });
    expect(a.calls[0].bearer).toBe('tok-123');

    const b = fake('{}');
    await fetchRecords(source, values, 'tok-123', { transport: b.transport });
    expect(b.calls[0].bearer).toBeUndefined();
  });

  it('needs a token when one is asked for, and refuses to send it over http', async () => {
    const { transport, calls } = fake('{}');
    await expect(fetchRecords({ ...source, bearerAuth: true }, values, '  ', { transport })).rejects.toThrow(
      'Enter the access token',
    );
    await expect(
      fetchRecords({ url: 'http://192.168.1.5/x', bearerAuth: true }, {}, 'secret', { transport }),
    ).rejects.toThrow('Refusing to send an access token without HTTPS.');
    expect(calls).toHaveLength(0);
  });

  it('never lets the token into an error', async () => {
    const leaky: Transport = async (_url, bearer) => {
      throw new Error(`rejected Bearer ${bearer} by server`);
    };
    const err = await fetchRecords({ ...source, bearerAuth: true }, values, 'secret-token', { transport: leaky }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('rejected Bearer *** by server');
    expect((err as Error).message).not.toContain('secret-token');
  });

  it('passes a transport error through unchanged when there is no token', async () => {
    const failing: Transport = async () => {
      throw new Error('HTTP 401 Unauthorized: Bad credentials');
    };
    await expect(fetchRecords(source, values, undefined, { transport: failing })).rejects.toThrow(
      'HTTP 401 Unauthorized: Bad credentials',
    );
  });

  it('says when the response is not JSON, empty, or the wrong shape', async () => {
    const run = (body: string) => fetchRecords(source, values, undefined, { transport: fake(body).transport });
    await expect(run('<html>nope</html>')).rejects.toThrow('The response is not valid JSON.');
    await expect(run('[]')).rejects.toThrow(/empty list/);
    await expect(run('"text"')).rejects.toThrow(/returned text/);
  });
});

describe('makeTauriTransport', () => {
  it('calls fetch_json with the url and the token, and returns the body', async () => {
    const seen: { cmd: string; args: Record<string, unknown> }[] = [];
    const transport = makeTauriTransport(async (cmd, args) => {
      seen.push({ cmd, args });
      return '{"ok":true}';
    });
    expect(await transport('https://x.com/a', 'tok')).toBe('{"ok":true}');
    expect(await transport('https://x.com/a', undefined)).toBe('{"ok":true}');
    expect(seen).toEqual([
      { cmd: 'fetch_json', args: { url: 'https://x.com/a', bearer: 'tok' } },
      { cmd: 'fetch_json', args: { url: 'https://x.com/a', bearer: null } },
    ]);
  });

  it('turns the string Rust rejects with into an Error, and scrubs the token', async () => {
    const transport = makeTauriTransport(async () => {
      throw 'HTTP 403 Forbidden: bad token tok-9';
    });
    const err = await transport('https://x.com/a', 'tok-9').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('HTTP 403 Forbidden: bad token ***');
  });
});

describe('browserTransport', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const respond = (body: string, responseInit: ResponseInit = {}) => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
      calls.push({ url, init: requestInit });
      return new Response(body, responseInit);
    }) as typeof fetch;
    return calls;
  };

  it('sends a GET asking for JSON, with the token only when there is one', async () => {
    const calls = respond('{"a":1}');
    expect(await browserTransport('https://x.com/a', 'tok')).toBe('{"a":1}');
    expect(await browserTransport('https://x.com/a', undefined)).toBe('{"a":1}');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer tok' });
    expect(calls[1].init.headers).toEqual({ Accept: 'application/json' });
  });

  it('quotes the server’s explanation for an error status', async () => {
    respond('{"message":"Bad credentials"}', { status: 401, statusText: 'Unauthorized' });
    await expect(browserTransport('https://x.com/a', undefined)).rejects.toThrow(
      'HTTP 401 Unauthorized: {"message":"Bad credentials"}',
    );
  });

  it('explains a blocked request as probably CORS, without the token', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch tok-5');
    }) as typeof fetch;
    const err = await browserTransport('https://x.com/a', 'tok-5').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Could not reach x\.com.*CORS/);
    expect((err as Error).message).not.toContain('tok-5');
  });

  it('refuses a response over the size cap', async () => {
    respond('x'.repeat(5 * 1024 * 1024 + 1));
    await expect(browserTransport('https://x.com/a', undefined)).rejects.toThrow('larger than 5 MB');
  });
});

describe('scrub', () => {
  it('replaces every occurrence and leaves text alone without a token', () => {
    expect(scrub('a tok b tok', 'tok')).toBe('a *** b ***');
    expect(scrub('nothing', undefined)).toBe('nothing');
    expect(scrub('nothing', '')).toBe('nothing');
  });
});
