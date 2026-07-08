/**
 * FallbackCropper
 *
 * When CardDetector cannot find a rectangular card outline in the frame —
 * a common failure when fingers or glare obscure the card's edge on a
 * hand-held capture — the card artwork itself is often still perfectly
 * usable. This produces a centred crop at the correct Pokémon card aspect
 * ratio so the existing ArtworkExtractor / CardMatcher pipeline can still
 * attempt a match, without any perspective correction (there are no
 * detected corners to warp from).
 *
 * This module does not depend on or modify OpenCV, CardDetector, or
 * CardMatcher — it is a plain 2D canvas crop that feeds into the same
 * downstream normalised-card pipeline used for the perspective-corrected
 * path (ArtworkExtractor → phash/colour → CardMatcher), all of which are
 * untouched.
 */

import { NORM_CARD_W, NORM_CARD_H } from './CardNormalizer';

/**
 * Pokémon card aspect ratio (width / height): 63 mm / 88 mm ≈ 0.716.
 * Intentionally duplicated from CardDetector's own CARD_RATIO constant
 * (rather than importing it) to keep this fallback path fully decoupled
 * from the detection module.
 */
const CARD_RATIO = 63 / 88;

/**
 * Fraction of the limiting frame dimension the fallback crop occupies.
 * A hand-held card usually fills a large, but not full, portion of the
 * frame when centred — this leaves a margin so nearby background/hand
 * pixels outside the card are mostly excluded even without a detected
 * outline to crop to exactly.
 */
const FALLBACK_FILL_FRACTION = 0.82;

/**
 * Builds a centred, aspect-ratio-correct crop of the current video frame
 * and scales it directly to the canonical 488×680 normalised card size
 * (matching CardNormalizer's output), so it can be handed straight to
 * ArtworkExtractor / CardStructureValidator without further resizing.
 */
export function createCenteredFallbackCrop(
  video: HTMLVideoElement,
  debugCanvas?: HTMLCanvasElement,
): HTMLCanvasElement {
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // Largest CARD_RATIO box that fits within FALLBACK_FILL_FRACTION of the
  // frame on whichever axis is limiting, centred on both axes.
  let cropH = vh * FALLBACK_FILL_FRACTION;
  let cropW = cropH * CARD_RATIO;
  if (cropW > vw * FALLBACK_FILL_FRACTION) {
    cropW = vw * FALLBACK_FILL_FRACTION;
    cropH = cropW / CARD_RATIO;
  }

  const x = (vw - cropW) / 2;
  const y = (vh - cropH) / 2;

  const out = document.createElement('canvas');
  out.width  = NORM_CARD_W;
  out.height = NORM_CARD_H;
  out.getContext('2d')!.drawImage(video, x, y, cropW, cropH, 0, 0, NORM_CARD_W, NORM_CARD_H);

  if (debugCanvas) {
    debugCanvas.width  = NORM_CARD_W;
    debugCanvas.height = NORM_CARD_H;
    debugCanvas.getContext('2d')!.drawImage(out, 0, 0);
  }

  return out;
}
