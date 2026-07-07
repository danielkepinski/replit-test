/**
 * ArtworkExtractor
 *
 * Crops the illustration window from a perspective-corrected card canvas
 * before perceptual hashing.
 *
 * Problem solved:
 *   Hashing the full card included the border, HP line, set symbol, energy
 *   icons, and text box — structural elements shared across eras. This caused
 *   modern full-art cards to collide with vintage cards that happen to share
 *   similar overall colour temperatures (e.g. Greninja SV → Sunkern Base Set).
 *
 * Fix:
 *   Restrict the hash to the illustration window only (top ~40% of the card
 *   interior). The artwork is unique per card; the chrome around it is not.
 *
 * Crop percentages (applied to whatever width×height the canvas has):
 *   x: 8% → 92%  — strips left/right border and holographic edge
 *   y: 15% → 55% — strips the name bar above; text box, HP, set symbol below
 *
 * The same constants are mirrored verbatim in scripts/build-fingerprints.mjs
 * so that stored fingerprints and live-camera hashes are computed identically.
 */

export const ARTWORK_CROP = {
  xMin: 0.08,
  xMax: 0.92,
  yMin: 0.15,
  yMax: 0.55,
} as const;

/**
 * Returns a new off-screen canvas containing only the illustration region.
 *
 * Input is the perspective-corrected card canvas (nominally 400 × 560 from
 * PerspectiveCorrector, but the function works at any resolution because all
 * coordinates are derived from percentages).
 */
export function extractArtwork(cardCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const cw = cardCanvas.width;
  const ch = cardCanvas.height;

  const x = Math.round(ARTWORK_CROP.xMin * cw);
  const y = Math.round(ARTWORK_CROP.yMin * ch);
  const w = Math.round((ARTWORK_CROP.xMax - ARTWORK_CROP.xMin) * cw);
  const h = Math.round((ARTWORK_CROP.yMax - ARTWORK_CROP.yMin) * ch);

  const out = document.createElement('canvas');
  out.width  = w;   // ~336 px at 400-wide input
  out.height = h;   // ~224 px at 560-tall input
  out.getContext('2d')!.drawImage(cardCanvas, x, y, w, h, 0, 0, w, h);
  return out;
}
