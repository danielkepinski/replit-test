/**
 * ArtworkExtractor
 *
 * Produces one or more crop canvases from a perspective-corrected,
 * normalised card canvas (488 × 680) for perceptual hashing.
 *
 * Three crop regions handle different card eras:
 *
 *  classic    x: 8–92 %, y: 15–55 %
 *    The classic illustration box used on Base Set–era through early EX cards.
 *    Strips the name bar (top 15 %), text box, HP, set symbol (below 55 %),
 *    and the left/right border chrome.
 *
 *  fullArt    x: 5–95 %, y: 5–75 %
 *    Full-art / ex / GX / VMAX / VSTAR cards where the illustration bleeds
 *    across the entire upper portion of the card. Extends to y = 75 % to
 *    include the lower artwork of cards whose attack / description box starts
 *    only near the bottom quarter.
 *
 *  borderless x: 2–98 %, y: 2–98 %
 *    Near-full-card crop used for trainer full-art, alternate-art, and
 *    rainbow-rare cards where the illustration fills the entire face.
 *    Retains a 2 % sliver on each edge to exclude the thin outer border.
 *
 * ─── Matching strategy ────────────────────────────────────────────────────
 * All three crops are hashed on the live camera path.  The matcher tries
 * each against its corresponding stored hash and returns the minimum
 * (best-match) Hamming distance.  Classic cards win on the classic crop;
 * full-art cards win on the fullArt or borderless crop.
 *
 * ─── Backward compatibility ───────────────────────────────────────────────
 * The existing fingerprints.json was built with the classic crop only.
 * fingerprintDb.ts promotes old single-hash entries so classicHash =
 * fullArtHash = borderlessHash = hash.  Matching still works; rebuilding
 * with this script improves full-art / ex card accuracy.
 *
 * The same CROP_REGIONS constants are mirrored in build-fingerprints.mjs.
 */

export const CROP_REGIONS = {
  classic: {
    xMin: 0.08, xMax: 0.92,
    yMin: 0.15, yMax: 0.55,
  },
  fullArt: {
    xMin: 0.05, xMax: 0.95,
    yMin: 0.05, yMax: 0.75,
  },
  borderless: {
    xMin: 0.02, xMax: 0.98,
    yMin: 0.02, yMax: 0.98,
  },
} as const;

export type CropMode = keyof typeof CROP_REGIONS;
export const CROP_MODES: CropMode[] = ['classic', 'fullArt', 'borderless'];

/** Legacy export — kept so existing callers compile without changes. */
export const ARTWORK_CROP = CROP_REGIONS.classic;

// ── Internal helper ────────────────────────────────────────────────────────

function cropCanvas(
  src: HTMLCanvasElement,
  region: { xMin: number; xMax: number; yMin: number; yMax: number },
): HTMLCanvasElement {
  const cw = src.width;
  const ch = src.height;
  const x  = Math.round(region.xMin * cw);
  const y  = Math.round(region.yMin * ch);
  const w  = Math.round((region.xMax - region.xMin) * cw);
  const h  = Math.round((region.yMax - region.yMin) * ch);
  const out = document.createElement('canvas');
  out.width  = w;
  out.height = h;
  out.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract a single named crop region from a normalised card canvas.
 */
export function extractArtworkCrop(
  cardCanvas: HTMLCanvasElement,
  mode: CropMode,
): HTMLCanvasElement {
  return cropCanvas(cardCanvas, CROP_REGIONS[mode]);
}

/**
 * Extract all three crop regions in one call.
 * Returns an object keyed by CropMode.
 */
export function extractAllCrops(
  cardCanvas: HTMLCanvasElement,
): Record<CropMode, HTMLCanvasElement> {
  return {
    classic:    cropCanvas(cardCanvas, CROP_REGIONS.classic),
    fullArt:    cropCanvas(cardCanvas, CROP_REGIONS.fullArt),
    borderless: cropCanvas(cardCanvas, CROP_REGIONS.borderless),
  };
}

/**
 * Legacy export — equivalent to extractArtworkCrop(cardCanvas, 'classic').
 * Kept for backward compatibility.
 */
export function extractArtwork(cardCanvas: HTMLCanvasElement): HTMLCanvasElement {
  return cropCanvas(cardCanvas, CROP_REGIONS.classic);
}
