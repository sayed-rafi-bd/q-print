import { describe, expect, it } from 'vitest';
import { fetchRecords } from '../apiClient';
import { LIMITS } from './engine';
import { isMockUrl, MOCK_HOST, MOCK_PRODUCTS_URL, mockProducts, mockResponse } from './mockApi';

const NOW = new Date(2026, 9, 14);

describe('mock API', () => {
  it('recognises only its own host over https', () => {
    expect(isMockUrl(`https://${MOCK_HOST}/products?count=1`)).toBe(true);
    expect(isMockUrl(`http://${MOCK_HOST}/products`)).toBe(false);
    expect(isMockUrl('https://api.example.com/products')).toBe(false);
    expect(isMockUrl(`https://${MOCK_HOST}.evil.com/products`)).toBe(false);
    expect(isMockUrl('not a url')).toBe(false);
  });

  it('makes the number of records asked for, with the documented shape', () => {
    const rows = mockProducts(25, { now: NOW });
    expect(rows).toHaveLength(25);
    for (const r of rows) {
      expect(r.barcode).toMatch(/^100\d{4}$/);
      expect(r.issued).toMatch(/^\d{4} \d{2}$/);
      expect(r.productCode).toMatch(/^035\d{10}$/);
      expect(r.tracking).toMatch(/^\d{13}$/);
      expect(r.location.code.startsWith(`${r.location.zone}-`)).toBe(true);
    }
  });

  it('answers like a server: wrapped list, 404 and 400 errors', () => {
    const body = JSON.parse(mockResponse(`https://${MOCK_HOST}/products?count=3`));
    expect(body.data).toHaveLength(3);
    expect(() => mockResponse(`https://${MOCK_HOST}/nope?count=3`)).toThrow(/^HTTP 404/);
    for (const bad of ['0', '-1', '1.5', 'abc', '', String(LIMITS.maxRows + 1)]) {
      expect(() => mockResponse(`https://${MOCK_HOST}/products?count=${bad}`)).toThrow(/^HTTP 400/);
    }
  });

  it('is reached through fetchRecords without any network transport', async () => {
    const records = await fetchRecords(
      { url: MOCK_PRODUCTS_URL, listPath: 'data', variables: { count: { default: '4' } } },
      { count: '4' },
    );
    expect(records).toHaveLength(4);
  });

  it('turns a bad count into a readable error', async () => {
    await expect(fetchRecords({ url: MOCK_PRODUCTS_URL, listPath: 'data' }, { count: '0' })).rejects.toThrow(
      /count must be a whole number/,
    );
  });
});
