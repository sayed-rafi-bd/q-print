import shippingTemplate from './templates/label.json';
import productTemplate from './templates/product-label.json';

/**
 * Every label the app can print. To add a third one: add its pdfme template under src/templates/,
 * add an entry here, and add a matching branch in `generate_random_data` and `LABEL_IDS`
 * (src-tauri/src/lib.rs).
 */
export type LabelId = 'shipping' | 'product';

export type LabelDef = {
  id: LabelId;
  /** shown in the label <select> */
  name: string;
  /** page size in mm; also the paper the printer must be set to */
  widthMm: number;
  heightMm: number;
  /** built-in layout, used until a template is saved from the Designer */
  defaultTemplate: unknown;
};

export const LABELS: LabelDef[] = [
  { id: 'shipping', name: 'Shipping label (Sagawa)', widthMm: 110, heightMm: 86, defaultTemplate: shippingTemplate },
  { id: 'product', name: 'Product label', widthMm: 190, heightMm: 160, defaultTemplate: productTemplate },
];

export const DEFAULT_LABEL: LabelId = 'shipping';

export const getLabel = (id: LabelId): LabelDef => LABELS.find(l => l.id === id) ?? LABELS[0];

const STORAGE_KEY = 'q-print.label';

/** The label chosen last time, or the default if nothing valid is remembered. */
export function loadLastLabel(): LabelId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LABELS.some(l => l.id === v) ? (v as LabelId) : DEFAULT_LABEL;
  } catch {
    return DEFAULT_LABEL;
  }
}

export function rememberLabel(id: LabelId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable: not critical */ }
}
