import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In a browser there is no Tauri shell, so every `invoke()` would throw. If any code path still
// reaches for it, this mock makes the test fail loudly instead of passing by accident.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    throw new Error(`invoke(${cmd}) must not be called on the web`);
  },
}));

import { builtin, DEFAULT_LABEL } from './builtinLabels';
import { shouldOfferImport } from './db/migrate';
import type { User } from './db/users';
import { isTauri } from './platform';
import { loadBuiltinTemplate, resetBuiltinTemplate, saveBuiltinTemplate } from './templateStore';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('running as a web page', () => {
  it('is not mistaken for the Tauri shell', () => {
    expect(isTauri()).toBe(false);
  });

  it('is recognised as Tauri when the shell injects its marker', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(isTauri()).toBe(true);
  });

  it('opens a built-in label from its bundled layout when nothing was saved', async () => {
    const { source } = await loadBuiltinTemplate(DEFAULT_LABEL);
    expect(source).toBe('default');
  });

  it('keeps a saved built-in layout in the browser and reads it back', async () => {
    const template = { ...builtin(DEFAULT_LABEL)!.defaultTemplate, schemas: [[]] };
    await saveBuiltinTemplate(DEFAULT_LABEL, template);
    const { source, template: loaded } = await loadBuiltinTemplate(DEFAULT_LABEL);
    expect(source).toBe('custom');
    expect(loaded.schemas).toEqual([[]]);
  });

  it('goes back to the bundled layout after a reset', async () => {
    await saveBuiltinTemplate(DEFAULT_LABEL, builtin(DEFAULT_LABEL)!.defaultTemplate);
    await resetBuiltinTemplate(DEFAULT_LABEL);
    expect((await loadBuiltinTemplate(DEFAULT_LABEL)).source).toBe('default');
  });

  it('reports a corrupt saved layout instead of crashing', async () => {
    localStorage.setItem(`q-print.template.${DEFAULT_LABEL}`, '{not json');
    await expect(loadBuiltinTemplate(DEFAULT_LABEL)).rejects.toThrow(/corrupt/);
  });

  it('does not offer to import label files, since a browser has none', async () => {
    const user = { id: 'u1', username: 'ann' } as User;
    expect(await shouldOfferImport(user)).toBe(false);
  });
});
