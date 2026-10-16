import { describe, expect, it } from 'vitest';
import { fetchRecords, type Transport, withHint } from './apiClient';

const failing =
  (message: string): Transport =>
  async () => {
    throw new Error(message);
  };

describe('error hints', () => {
  it('points a 401 or 403 at the token, or at the missing token', () => {
    expect(withHint('HTTP 401 Unauthorized', { bearerAuth: true })).toBe(
      'HTTP 401 Unauthorized Check the access token.',
    );
    expect(withHint('HTTP 403 Forbidden: nope', { bearerAuth: false })).toContain('is not sending an access token');
  });

  it('points a 404 at the values', () => {
    expect(withHint('HTTP 404 Not Found', {})).toContain('Check the values you entered.');
  });

  it('leaves other errors alone', () => {
    expect(withHint('Could not reach api.example.com: timeout', {})).toBe('Could not reach api.example.com: timeout');
    expect(withHint('HTTP 500 Internal Server Error', {})).toBe('HTTP 500 Internal Server Error');
  });

  it('adds the hint through fetchRecords and still never shows the token', async () => {
    const source = { url: 'https://api.example.com/x', bearerAuth: true };
    const err = await fetchRecords(source, {}, 'sekret', {
      transport: failing('HTTP 401 Unauthorized: bad sekret'),
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('Check the access token.');
    expect((err as Error).message).not.toContain('sekret');
  });
});
