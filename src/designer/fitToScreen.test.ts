import { describe, expect, it } from 'vitest';
import {
  clamp,
  fitZoom,
  MAX_ZOOM,
  MAX_ZOOM_PERCENT,
  MIN_USEFUL_ZOOM,
  PADDING,
  pxPerMm,
  worthChanging,
} from './fitToScreen';

// A 100 × 50 mm label, which is what the sample and most shipping labels are. Measured on screen:
// 100 mm came out 378 px, so a millimetre is 3.78 px.
const pageMm = { widthMm: 100, heightMm: 50 };
const PX_PER_MM = 3.78;

describe('pxPerMm', () => {
  it('reads the scale off a measured page', () => {
    expect(pxPerMm(378, 100)).toBeCloseTo(3.78);
  });

  it('gives nothing rather than dividing by nonsense', () => {
    expect(pxPerMm(0, 100)).toBe(0);
    expect(pxPerMm(378, 0)).toBe(0);
    expect(pxPerMm(-5, 100)).toBe(0);
  });
});

describe('fitZoom', () => {
  it('grows a short label to fill a wide canvas, which is the problem it exists for', () => {
    // 835 × 544 of canvas. At 3.78 px/mm the page is 378 × 189, so it has room to grow well past 1.
    const zoom = fitZoom({ pageMm, availablePx: { width: 835, height: 544 }, pxPerMm: PX_PER_MM });
    expect(zoom).toBeGreaterThan(1);
    expect(zoom).toBe(MAX_ZOOM); // capped, not partial
  });

  it('leaves a label that does not fit alone: pdfme already shrinks it', () => {
    // A 190 × 160 mm label at 719 × 605 px in a 400 × 300 canvas. Asking for less would only make it
    // smaller than pdfme's own fit, so the answer is "no help needed".
    const zoom = fitZoom({
      pageMm: { widthMm: 190, heightMm: 160 },
      availablePx: { width: 400, height: 300 },
      pxPerMm: PX_PER_MM,
    });
    expect(zoom).toBe(MIN_USEFUL_ZOOM);
  });

  it('is limited by whichever side runs out first', () => {
    // Width has plenty of room; height does not.
    const zoom = fitZoom({ pageMm, availablePx: { width: 900, height: 250 }, pxPerMm: PX_PER_MM });
    expect(zoom).toBeLessThan(fitZoom({ pageMm, availablePx: { width: 500, height: 900 }, pxPerMm: PX_PER_MM }));
  });

  it('leaves room for the padding, so the page is not flush against the edge', () => {
    const wide = fitZoom({ pageMm, availablePx: { width: 835, height: 4000 }, pxPerMm: PX_PER_MM });
    expect(wide * pageMm.widthMm * PX_PER_MM).toBeLessThanOrEqual(835 - PADDING * 2);
  });

  it('falls back to the floor rather than to nonsense when nothing has been measured', () => {
    // pxPerMm of 0 is what a page that has not rendered looks like.
    expect(fitZoom({ pageMm, availablePx: { width: 800, height: 600 }, pxPerMm: 0 })).toBe(MIN_USEFUL_ZOOM);
    expect(
      fitZoom({ pageMm: { widthMm: 0, heightMm: 0 }, availablePx: { width: 800, height: 600 }, pxPerMm: PX_PER_MM }),
    ).toBe(MIN_USEFUL_ZOOM);
  });

  it('falls back to the floor when there is no room at all', () => {
    expect(fitZoom({ pageMm, availablePx: { width: PADDING, height: PADDING }, pxPerMm: PX_PER_MM })).toBe(
      MIN_USEFUL_ZOOM,
    );
    expect(fitZoom({ pageMm, availablePx: { width: 0, height: 0 }, pxPerMm: PX_PER_MM })).toBe(MIN_USEFUL_ZOOM);
  });

  it('never zooms past the limits', () => {
    const huge = fitZoom({ pageMm, availablePx: { width: 4000, height: 4000 }, pxPerMm: PX_PER_MM });
    expect(huge).toBe(MAX_ZOOM);
    const tiny = fitZoom({ pageMm, availablePx: { width: 200, height: 100 }, pxPerMm: PX_PER_MM });
    expect(tiny).toBe(MIN_USEFUL_ZOOM); // pdfme shrinks it itself
  });
});

describe('clamp', () => {
  it('rounds to a tenth so the zoom reads as deliberate', () => {
    expect(clamp(1.2837)).toBe(1.3);
    expect(clamp(1.24)).toBe(1.2);
  });

  it('falls back to the floor rather than to a nonsense value', () => {
    expect(clamp(Number.NaN)).toBe(MIN_USEFUL_ZOOM);
    expect(clamp(0)).toBe(MIN_USEFUL_ZOOM);
    expect(clamp(-3)).toBe(MIN_USEFUL_ZOOM);
  });

  it('holds the zoom inside the limits', () => {
    expect(clamp(99)).toBe(MAX_ZOOM);
    // Below the useful floor it would make a working page smaller, so it is held up at 1.
    expect(clamp(0.01)).toBe(MIN_USEFUL_ZOOM);
    expect(clamp(0.5)).toBe(MIN_USEFUL_ZOOM);
  });
});

describe('MAX_ZOOM_PERCENT', () => {
  it('is the multiplier as a percentage, which is what pdfme wants', () => {
    // pdfme divides its maxZoom by 100, so the multiplier has to be converted or it means 2%.
    expect(MAX_ZOOM_PERCENT).toBe(200);
  });
});

describe('worthChanging', () => {
  it('ignores a change too small to see, so the designer is not rebuilt for nothing', () => {
    expect(worthChanging(1, 1.05)).toBe(false);
    expect(worthChanging(1, 1.1)).toBe(true);
  });

  it('always acts when the page is badly out of place', () => {
    expect(worthChanging(1, 2)).toBe(true);
    expect(worthChanging(2, 0.5)).toBe(true);
  });
});
