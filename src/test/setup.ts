/**
 * Test setup.
 *
 * The app keeps a few things in `localStorage` (who is signed in, which label was last used, and
 * whether the one-time import has been offered). The tests run in node, where that does not exist,
 * so a minimal in-memory stand-in is provided rather than pulling in a whole DOM environment.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number { return this.map.size; }

  clear(): void { this.map.clear(); }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void { this.map.delete(key); }

  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: false,
    configurable: true,
  });
}
