/**
 * CardNormalizer
 *
 * Forces the perspective-corrected card to a fixed 488 × 680 canvas before
 * perceptual hashing.
 *
 * Why this is needed:
 *   PerspectiveCorrector outputs 400 × 560 (aspect ratio ≈ 0.714).  The
 *   pokemontcg.io "small" reference images are 245 × 342 (ratio ≈ 0.716) —
 *   close but not identical.  Without a fixed normalisation target, the
 *   artwork crop percentages in ArtworkExtractor map to subtly different
 *   pixel regions in the live feed vs the fingerprint database, causing
 *   mismatches.
 *
 * 488 × 680 is chosen because:
 *   - It is exactly 2× the pokemontcg.io "small" image dimensions (245 × 342
 *     rounded to even numbers), so ArtworkExtractor's crop percentages land on
 *     the same physical artwork region in both build-time and live-camera paths.
 *   - It is the canonical Pokémon card pixel size used throughout this project.
 *
 * The resize uses the browser's bilinear drawImage path — fast and
 * GPU-accelerated.  No OpenCV dependency is required.
 */

/** Canonical card dimensions shared by CardNormalizer and ArtworkExtractor. */
export const NORM_CARD_W = 488;
export const NORM_CARD_H = 680;

/**
 * Scales any ImageData to a fixed 488 × 680 HTMLCanvasElement.
 *
 * Input is expected to be the ImageData returned by PerspectiveCorrector
 * (nominally 400 × 560), but the function works at any input resolution
 * because it always scales to fill the fixed output size.
 */
export function normalizeCard(input: ImageData): HTMLCanvasElement {
  // Blit input onto a temporary canvas so drawImage can use it as a source
  const src = document.createElement('canvas');
  src.width  = input.width;
  src.height = input.height;
  src.getContext('2d', { willReadFrequently: false })!.putImageData(input, 0, 0);

  const out = document.createElement('canvas');
  out.width  = NORM_CARD_W;
  out.height = NORM_CARD_H;
  out.getContext('2d', { willReadFrequently: false })!.drawImage(
    src, 0, 0, NORM_CARD_W, NORM_CARD_H,
  );
  return out;
}
