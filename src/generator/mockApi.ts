/**
 * A mock web API that lives inside the app, so the built-in labels can use a real data source
 * (a URL with variables, JSON records) without any server and without a network connection.
 *
 * Any request to `MOCK_HOST` is answered here by `src/apiClient.ts` instead of being sent out.
 * The host ends in `.invalid`, a name that can never resolve, so even if a request were routed
 * wrongly it could not reach a real server.
 *
 * Pure: no Tauri, no DOM. `rng` and `now` can be injected so tests are repeatable.
 */

import { LIMITS } from './engine';

export const MOCK_HOST = 'mock.q-print.invalid';

/** The address the built-in product label reads. `{count}` is how many records to make. */
export const MOCK_PRODUCTS_URL = `https://${MOCK_HOST}/products?count={count}`;

export type MockOptions = { rng?: () => number; now?: Date };

/** True when the (already filled in) URL is a request for the mock API. */
export function isMockUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host.toLowerCase() === MOCK_HOST;
  } catch {
    return false;
  }
}

const PRODUCTS: ReadonlyArray<readonly [string, string]> = [
  ['ケラスターセ', 'EC専用 SP バンディバレント R 250ml'],
  ['ミルボン', 'EC専用 ディーセス エルジューダ 120ml'],
  ['資生堂', 'EC専用 プロフェッショナル ヘアマスク 200g'],
  ['ロレアル', 'EC専用 セリエ エクスパート 500ml'],
];

const DAY_MS = 86_400_000;

export type MockProduct = {
  id: number;
  barcode: string;
  /** `YYMM DD`, within the last 90 days. */
  issued: string;
  brand: string;
  name: string;
  productCode: string;
  location: { zone: string; code: string };
  tracking: string;
};

export function mockProducts(count: number, opts: MockOptions = {}): MockProduct[] {
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? new Date();
  const int = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
  const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('');
  const two = (n: number) => String(n).padStart(2, '0');

  return Array.from({ length: count }, (_, i) => {
    const [brand, name] = PRODUCTS[int(0, PRODUCTS.length - 1)];
    const date = new Date(now.getTime() - int(0, 90) * DAY_MS);
    const zone = String(int(10, 59));
    return {
      id: i + 1,
      barcode: `100${digits(4)}`,
      issued: `${two(date.getFullYear() % 100)}${two(date.getMonth() + 1)} ${two(date.getDate())}`,
      brand,
      name,
      productCode: `035${digits(10)}`,
      location: { zone, code: `${zone}-${int(0, 9)}-${two(int(0, 99))}` },
      tracking: digits(13),
    };
  });
}

/**
 * Answers a request to the mock API with the response body text. Errors read like a real server's
 * (`HTTP 404 Not Found`), so the same hints and messages apply as for any other API.
 */
export function mockResponse(url: string, opts: MockOptions = {}): string {
  const u = new URL(url);
  if (u.pathname !== '/products') throw new Error('HTTP 404 Not Found');
  const raw = u.searchParams.get('count') ?? '';
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || count < 1 || count > LIMITS.maxRows) {
    throw new Error(`HTTP 400 Bad Request: count must be a whole number from 1 to ${LIMITS.maxRows}.`);
  }
  return JSON.stringify({ data: mockProducts(count, opts) });
}
