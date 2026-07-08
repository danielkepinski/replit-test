/**
 * ColourSignature — compact colour descriptor for a crop canvas.
 *
 * Stores:
 *   - average R, G, B (0–255 each)
 *   - hue histogram with 12 × 30° buckets, each normalised to 0–255
 *     (fraction-of-colour-pixels in each hue bucket, scaled to byte range)
 *
 * Serialised as a 30-char lowercase hex string:
 *   RRGGBB + 24 hex chars for the 12 histogram bytes
 * Compact enough to bundle in fingerprints.json alongside pHash strings.
 *
 * Near-grey / very-dark pixels are excluded from the hue histogram
 * (HSV saturation < 0.12 or value < 0.08) so the descriptor is robust
 * to different exposure / white-balance conditions.
 *
 * Distance formula:
 *   40 % – average-RGB L2 distance   (overall colour cast)
 *   60 % – hue-histogram L1 distance (dominant hue distribution)
 * Result is in [0, 1]: 0 = identical, 1 = maximally different.
 */

export interface ColourSignature {
  avgR:    number;    // 0–255
  avgG:    number;    // 0–255
  avgB:    number;    // 0–255
  hueHist: number[];  // 12 values, each 0–255 (normalised fraction × 255)
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract a ColourSignature from an HTMLCanvasElement.
 * The canvas is sampled at 32×32 resolution for speed; the crop
 * window is assumed already applied by the caller (ArtworkExtractor).
 */
export function extractColourSignature(canvas: HTMLCanvasElement): ColourSignature {
  const SAMPLE = 32;
  const offscreen = document.createElement('canvas');
  offscreen.width  = Math.min(canvas.width,  SAMPLE);
  offscreen.height = Math.min(canvas.height, SAMPLE);
  const ctx = offscreen.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height);
  const { data } = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
  return _computeFromRGBA(data, offscreen.width * offscreen.height);
}

/**
 * Serialise a ColourSignature to a 30-char lowercase hex string.
 * Format: RRGGBB (6 chars) + 24 chars for 12 hue-histogram bytes.
 */
export function serializeColour(sig: ColourSignature): string {
  const bytes = [sig.avgR, sig.avgG, sig.avgB, ...sig.hueHist];
  return bytes.map(b => (Math.round(b) & 0xff).toString(16).padStart(2, '0')).join('');
}

/**
 * Deserialise a 30-char hex string back to a ColourSignature.
 * Returns null if the string is absent, the wrong length, or contains any
 * non-hex characters — guards against NaN propagation into colour scoring.
 */
export function deserializeColour(s: string | null | undefined): ColourSignature | null {
  if (!s || s.length !== 30) return null;
  // Strict hex validation — reject anything that isn't [0-9a-fA-F]{30}
  if (!/^[0-9a-fA-F]{30}$/.test(s)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 30; i += 2) {
    const b = parseInt(s.slice(i, i + 2), 16);
    if (isNaN(b)) return null;   // belt-and-suspenders after regex guard
    bytes.push(b);
  }
  if (bytes.length !== 15) return null;
  return { avgR: bytes[0], avgG: bytes[1], avgB: bytes[2], hueHist: bytes.slice(3) };
}

/**
 * Colour distance: 0 (identical) → 1 (maximally different).
 *
 * Weighted combination:
 *   40 % — average-RGB L2 normalised to [0,1]
 *   60 % — hue-histogram L1 normalised to [0,1]
 */
export function colourDistance(a: ColourSignature, b: ColourSignature): number {
  // Average-RGB L2
  const dr = (a.avgR - b.avgR) / 255;
  const dg = (a.avgG - b.avgG) / 255;
  const db = (a.avgB - b.avgB) / 255;
  const avgDist = Math.sqrt((dr * dr + dg * dg + db * db) / 3);

  // Hue-histogram L1  (max possible = 2 × 255 when all mass swaps one bucket)
  let l1 = 0;
  for (let i = 0; i < 12; i++) l1 += Math.abs(a.hueHist[i] - b.hueHist[i]);
  const histDist = l1 / (2 * 255);

  return 0.4 * avgDist + 0.6 * histDist;
}

// ── Internal ───────────────────────────────────────────────────────────────

function _computeFromRGBA(
  data: Uint8ClampedArray | Uint8Array,
  pixelCount: number,
): ColourSignature {
  let sumR = 0, sumG = 0, sumB = 0;
  const hist = new Float64Array(12);
  let colourPixels = 0;

  for (let i = 0; i < pixelCount * 4; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sumR += r; sumG += g; sumB += b;

    // HSV saturation + value gate — skip near-grey / very-dark pixels
    const maxV = Math.max(r, g, b) / 255;
    const minV = Math.min(r, g, b) / 255;
    const sat  = maxV === 0 ? 0 : (maxV - minV) / maxV;
    if (sat >= 0.12 && maxV >= 0.08) {
      const rN = r / 255, gN = g / 255, bN = b / 255;
      let hue: number;
      // Note: maxV === rN/gN/bN when that channel is the max (same float value)
      if (maxV === rN)      hue = ((gN - bN) / (maxV - minV) + 6) % 6;
      else if (maxV === gN) hue = (bN - rN)  / (maxV - minV) + 2;
      else                  hue = (rN - gN)  / (maxV - minV) + 4;
      hist[Math.min(11, Math.floor((hue * 60) % 360 / 30))]++;
      colourPixels++;
    }
  }

  const avgR = Math.round(sumR / pixelCount);
  const avgG = Math.round(sumG / pixelCount);
  const avgB = Math.round(sumB / pixelCount);

  const hueHist = Array.from({ length: 12 }, (_, i) =>
    colourPixels > 0 ? Math.round((hist[i] / colourPixels) * 255) : 0,
  );

  return { avgR, avgG, avgB, hueHist };
}
