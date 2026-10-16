/**
 * Working out the zoom a label should be drawn at.
 *
 * pdfme scales a page *down* to fit its canvas but never up, so a short label such as 100 × 50 mm
 * renders as a small rectangle in a large dark area on a desktop screen. Its `zoomLevel` multiplies
 * the page again on top of that fit, which is how the label is made to fill the space.
 *
 * Two things make this awkward, and both shaped this file:
 *
 * - The zoom can only be set when the Designer is constructed. `updateOptions` replaces the options
 *   object, but pdfme reads the zoom from a React context that is only consulted on mount, so a
 *   later change is ignored. The Designer is therefore rebuilt when a label needs a different zoom.
 * - How big one millimetre comes out on screen is not a constant. It moves with the font, the pdfme
 *   version and the device pixel ratio, so it is measured once from the real page and passed in
 *   rather than assumed.
 *
 * Pure and separately tested: `src/designer/fitToScreen.test.ts`.
 */

/** Room to leave around the page, so it is not flush against the canvas edge. */
export const PADDING = 24;

/** pdfme will not zoom past this, and past about 2× the detail stops being readable anyway. */
export const MAX_ZOOM = 2;

/**
 * The smallest zoom worth rebuilding for.
 *
 * pdfme already scales a page *down* to fit its canvas, capping itself at 100%. So a label that is
 * too big for the window is already handled, and correctly — asking for less would only make it
 * smaller than it needs to be. What it will not do is scale a label *up*, which is the case this
 * exists for. Anything at or below this needs no help from us, and rebuilding the Designer for it
 * would be a flicker for nothing.
 */
export const MIN_USEFUL_ZOOM = 1;

/**
 * `MAX_ZOOM` as pdfme's `maxZoom` option wants it, which is a percentage. Passing the multiplier
 * instead silently means "2%", and pdfme then refuses any zoom worth having.
 */
export const MAX_ZOOM_PERCENT = MAX_ZOOM * 100;

/**
 * The zoom that fills the space, for a page of `pageMm` drawn at `pxPerMm` per millimetre.
 *
 * Held at {@link MIN_USEFUL_ZOOM} or above, so a label that already fits is left for pdfme's own
 * scaling rather than being rebuilt to a slightly different size.
 */
export function fitZoom(opts: {
  /** The label's real size. */
  pageMm: { widthMm: number; heightMm: number };
  /** The space the page has to sit in, in CSS pixels. */
  availablePx: { width: number; height: number };
  /** How wide one millimetre comes out on screen at zoom 1. Measured from the live page. */
  pxPerMm: number;
}): number {
  const { pageMm, availablePx, pxPerMm } = opts;
  if (!(pxPerMm > 0) || !(pageMm.widthMm > 0) || !(pageMm.heightMm > 0)) return MIN_USEFUL_ZOOM;

  const roomW = availablePx.width - PADDING * 2;
  const roomH = availablePx.height - PADDING * 2;
  if (roomW <= 0 || roomH <= 0) return MIN_USEFUL_ZOOM;

  return clamp(Math.min(roomW / (pageMm.widthMm * pxPerMm), roomH / (pageMm.heightMm * pxPerMm)));
}

/** Rounded to a tenth so the zoom reads as deliberate, then held between the two limits. */
export function clamp(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return MIN_USEFUL_ZOOM;
  // Steps of 0.1 read as deliberate; 1.2837 would look like a glitch.
  return Math.min(MAX_ZOOM, Math.max(MIN_USEFUL_ZOOM, Math.round(zoom * 10) / 10));
}

/** How wide one millimetre comes out on screen, from a page that has been measured. */
export function pxPerMm(pagePx: number, pageMm: number): number {
  if (!(pagePx > 0) || !(pageMm > 0)) return 0;
  return pagePx / pageMm;
}

/**
 * Whether the difference is worth rebuilding over. Below a tenth the page changes size by a couple
 * of pixels, and rebuilding the whole Designer for that would not be worth the flicker.
 */
export function worthChanging(from: number, to: number): boolean {
  return Number.isFinite(to) && Math.abs(to - from) >= 0.1;
}
