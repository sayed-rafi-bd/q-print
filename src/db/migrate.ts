import { invoke } from '@tauri-apps/api/core';
import type { Template } from '@pdfme/common';
import { isBundle, makeBundle } from '../bundle';
import { scaffoldSpec } from '../generator/scaffold';
import type { GeneratorSpec } from '../generator/spec';
import { importLabel } from '../labels';
import { getDb } from './client';
import { countLabels } from './labels';
import type { User } from './users';

/** What the version before the database left behind: one file per label. */
type LegacyLabel = { slug: string; name: string; json: string };

const doneKey = (user: User) => `q-print.labels.imported.${user.id}`;

/** Has this account already been offered the import? */
export const importAlreadyDone = (user: User): boolean => {
  try { return localStorage.getItem(doneKey(user)) === '1'; } catch { return true; }
};

const markDone = (user: User) => {
  try { localStorage.setItem(doneKey(user), '1'); } catch { /* not critical */ }
};

const readLegacy = (): Promise<LegacyLabel[]> => invoke<LegacyLabel[]>('read_legacy_labels');

/**
 * Whether to offer the import: there are files on this device, and the account has nothing yet.
 *
 * The account having no labels is the guard that matters. It means a deliberate deletion can never
 * be undone by the import coming back on a later launch.
 */
export async function shouldOfferImport(user: User): Promise<boolean> {
  if (importAlreadyDone(user)) return false;
  try {
    if ((await readLegacy()).length === 0) {
      // Nothing to rescue; do not ask again.
      markDone(user);
      return false;
    }
    return (await countLabels(getDb(), user.id)) === 0;
  } catch {
    // Cannot tell, so do not start a conversation about it.
    markDone(user);
    return false;
  }
}

export type ImportResult = {
  imported: number;
  /** Names of files that could not be read, or that were already in the database. */
  skipped: string[];
};

/**
 * Copies label files from this device onto the account.
 *
 * The files are left where they are. They are the only copy until this runs, and afterwards they
 * are clutter, but deleting somebody's work without being asked is not this code's call.
 */
export async function importLegacyLabels(user: User): Promise<ImportResult> {
  const legacy = await readLegacy();
  const result: ImportResult = { imported: 0, skipped: [] };

  for (const file of legacy) {
    try {
      const value: unknown = JSON.parse(file.json);
      // An old file is a label bundle; a bare template gets a generator made for it.
      const bundle = isBundle(value)
        ? value
        : makeBundle(file.name, value as Template, { version: 1, fields: {} });
      const template = bundle.template as Template;
      const generator: GeneratorSpec = scaffoldSpec(template, bundle.generator);

      const added = await importLabel(user, file.slug, file.name, template, generator);
      if (added) result.imported += 1;
      else result.skipped.push(file.name);
    } catch {
      result.skipped.push(file.name);
    }
  }

  markDone(user);
  return result;
}
