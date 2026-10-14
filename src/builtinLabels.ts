/**
 * The labels the app ships with. Kept apart from the label registry so both the registry and the
 * template store can use it without importing each other.
 */

import type { Template } from '@pdfme/common';
import shippingTemplate from './templates/label.json';
import productTemplate from './templates/product-label.json';

export type BuiltinLabel = {
  id: string;
  /** shown in the label <select> */
  name: string;
  /** bundled layout, used until a template is saved from the Designer */
  defaultTemplate: Template;
};

/** Keep in sync with `BUILTIN_IDS` in src-tauri/src/lib.rs. */
export const BUILTINS: BuiltinLabel[] = [
  { id: 'shipping', name: 'Shipping label (Sagawa)', defaultTemplate: shippingTemplate as Template },
  { id: 'product', name: 'Product label', defaultTemplate: productTemplate as Template },
];

/** The label chosen when nothing is remembered, and the one used if the choice has gone away. */
export const DEFAULT_LABEL = BUILTINS[0].id;

export const isBuiltin = (id: string): boolean => BUILTINS.some(b => b.id === id);

export const builtin = (id: string): BuiltinLabel | null => BUILTINS.find(b => b.id === id) ?? null;
