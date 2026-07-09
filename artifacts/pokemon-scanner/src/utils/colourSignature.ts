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
 *
 * ── Regional extension ─────────────────────────────────────────────────────
 *
 * RegionalColourSignature splits the crop into a 3×3 grid and stores one
 * ColourSignature per cell, giving spatial awareness that the global
 * signature lacks. Two cards can share an identical global palette (e.g.
 * Vulpix and Ho-Oh V both being orange/red) yet differ regionally because
 * their artwork places colour differently across the frame. Comparing
 * cell-by-cell catches this.
 *
 * Serialised as a 270-char lowercase hex string:
 *   9 regions × 30 chars each, row-major order (top-left first).
 * Format intentionally mirrors the existing per-card colour fields so the
 * same decode path (hex → bytes) works for both.
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

// ── Regional colour signature ───────────────────────────────────────────────

/**
 * Grid constants for the 3×3 regional layout.
 * Changing these values is a breaking change: all stored regional signatures
 * must be regenerated if GRID_ROWS or GRID_COLS change.
 */
const GRID_ROWS = 3;
const GRID_COLS = 3;
const GRID_SIZE = GRID_ROWS * GRID_COLS; // 9

/**
 * Resolution used when sampling the canvas for regional extraction.
 * Must be divisible by both GRID_ROWS and GRID_COLS so every region gets
 * exactly REGION_PX × REGION_PX pixels.
 */
const REGIONAL_SAMPLE = 30;                         // divisible by 3
const REGION_PX       = REGIONAL_SAMPLE / GRID_COLS; // 10 pixels per region edge

/**
 * Expected length of a serialised RegionalColourSignature hex string:
 * 9 regions × 30 chars each.
 */
export const REGIONAL_COLOUR_HEX_LENGTH = GRID_SIZE * 30; // 270

/**
 * A 3×3 grid of ColourSignatures — one per spatial region.
 *
 * `regions` is row-major, top-left first:
 *   [0]=top-left  [1]=top-centre  [2]=top-right
 *   [3]=mid-left  [4]=mid-centre  [5]=mid-right
 *   [6]=bot-left  [7]=bot-centre  [8]=bot-right
 *
 * This gives spatial awareness on top of the global ColourSignature:
 * two cards that share the same dominant palette (e.g. Vulpix and Ho-Oh V,
 * both orange/red) will still differ regionally because their artwork
 * places colour mass differently across the frame.
 */
export interface RegionalColourSignature {
  regions: ColourSignature[]; // length === GRID_SIZE (9)
}

/**
 * Extract a RegionalColourSignature from an HTMLCanvasElement.
 *
 * Draws the canvas down to 30×30, then for each of the 9 non-overlapping
 * 10×10 blocks extracts the pixels and computes a ColourSignature using the
 * same algorithm as extractColourSignature (same saturation/value gate,
 * same 12-bin hue histogram).
 */
export function extractRegionalColourSignature(
  canvas: HTMLCanvasElement,
): RegionalColourSignature {
  const offscreen = document.createElement('canvas');
  offscreen.width  = REGIONAL_SAMPLE;
  offscreen.height = REGIONAL_SAMPLE;
  const ctx = offscreen.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, REGIONAL_SAMPLE, REGIONAL_SAMPLE);
  const { data } = ctx.getImageData(0, 0, REGIONAL_SAMPLE, REGIONAL_SAMPLE);

  const regions: ColourSignature[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const x0 = col * REGION_PX;
      const y0 = row * REGION_PX;
      const regionData = _extractRegionPixels(data, REGIONAL_SAMPLE, x0, y0, REGION_PX, REGION_PX);
      regions.push(_computeFromRGBA(regionData, REGION_PX * REGION_PX));
    }
  }
  return { regions };
}

/**
 * Serialise a RegionalColourSignature to a 270-char lowercase hex string.
 *
 * Format: 9 consecutive 30-char blocks, one per region in row-major order.
 * Each block is identical in structure to a serialised ColourSignature:
 *   RRGGBB (6 chars) + 24 chars for 12 hue-histogram bytes.
 */
export function serializeRegionalColour(sig: RegionalColourSignature): string {
  if (sig.regions.length !== GRID_SIZE) {
    throw new Error(`RegionalColourSignature must have exactly ${GRID_SIZE} regions, got ${sig.regions.length}`);
  }
  return sig.regions.map(serializeColour).join('');
}

/**
 * Deserialise a 270-char hex string back to a RegionalColourSignature.
 *
 * Returns null on any of:
 * - absent / wrong length / non-hex input (same guards as deserializeColour)
 * - any individual 30-char region block failing its own validation
 *
 * Guards against NaN propagation: every region is validated before the
 * object is assembled.
 */
export function deserializeRegionalColour(
  s: string | null | undefined,
): RegionalColourSignature | null {
  if (!s || s.length !== REGIONAL_COLOUR_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]{270}$/.test(s)) return null;

  const regions: ColourSignature[] = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    const chunk = s.slice(i * 30, (i + 1) * 30);
    const region = deserializeColour(chunk);
    if (region === null) return null; // belt-and-suspenders after regex guard
    regions.push(region);
  }
  return { regions };
}

/**
 * Regional colour similarity: 0 (completely different) → 1 (identical).
 *
 * Computes colourDistance for each of the 9 region pairs, averages the
 * distances, then converts to similarity. Region weights are uniform (equal
 * weight) in v1 — a future version could weight the centre region more
 * heavily since it usually contains the main artwork subject.
 *
 * Because distance is computed cell-by-cell, two cards with the same global
 * hue distribution but different spatial layout (e.g. orange top vs orange
 * bottom) produce a meaningfully lower similarity than two cards whose
 * orange mass is in the same location.
 */
export function compareRegionalColourSignature(
  a: RegionalColourSignature,
  b: RegionalColourSignature,
): number {
  let totalDist = 0;
  const n = Math.min(a.regions.length, b.regions.length, GRID_SIZE);
  for (let i = 0; i < n; i++) {
    totalDist += colourDistance(a.regions[i], b.regions[i]);
  }
  return 1 - totalDist / n;
}

// ── Self-test / console validator ──────────────────────────────────────────

/**
 * Pure (no-canvas) self-test for regional colour signature logic.
 * Call from the browser console: `import('/src/utils/colourSignature.ts').then(m => m.selfTestRegionalColour())`
 * or trigger it during app init in development.
 *
 * Returns { passed, failed, summary }.
 */
export function selfTestRegionalColour(): { passed: number; failed: number; summary: string } {
  const results: string[] = [];
  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean): void {
    if (condition) {
      results.push(`  ✓ ${label}`);
      passed++;
    } else {
      results.push(`  ✗ ${label}`);
      failed++;
    }
  }

  // ── Helpers to build synthetic signatures ─────────────────────────────
  function makeSig(avgR: number, avgG: number, avgB: number, dominantBucket = 0): ColourSignature {
    const hueHist = Array(12).fill(0);
    hueHist[dominantBucket] = 200;
    return { avgR, avgG, avgB, hueHist };
  }

  function makeRegional(perRegion: ColourSignature[]): RegionalColourSignature {
    return { regions: perRegion };
  }

  // ── Serialise / deserialise roundtrip ─────────────────────────────────
  {
    const sig: RegionalColourSignature = makeRegional(
      Array.from({ length: 9 }, (_, i) => makeSig(i * 10, 50, 200 - i * 10, i % 12)),
    );
    const hex = serializeRegionalColour(sig);
    assert('serialize produces 270-char string', hex.length === 270);
    assert('serialize produces hex chars only', /^[0-9a-f]{270}$/.test(hex));

    const roundtrip = deserializeRegionalColour(hex);
    assert('deserialize returns non-null', roundtrip !== null);
    if (roundtrip) {
      assert('roundtrip has 9 regions', roundtrip.regions.length === 9);
      assert(
        'roundtrip region[0] avgR matches',
        roundtrip.regions[0].avgR === sig.regions[0].avgR,
      );
      assert(
        'roundtrip region[8] avgB matches',
        roundtrip.regions[8].avgB === sig.regions[8].avgB,
      );
      assert(
        'roundtrip region[4] hueHist[4] matches',
        roundtrip.regions[4].hueHist[4] === sig.regions[4].hueHist[4],
      );
    }
  }

  // ── Deserialise rejects invalid inputs ────────────────────────────────
  assert('null input → null', deserializeRegionalColour(null) === null);
  assert('empty string → null', deserializeRegionalColour('') === null);
  assert('wrong length → null', deserializeRegionalColour('abc') === null);
  assert(
    'non-hex chars → null',
    deserializeRegionalColour('z'.repeat(270)) === null,
  );
  assert(
    'exactly-1-char-short → null',
    deserializeRegionalColour('a'.repeat(269)) === null,
  );
  assert(
    'exactly-1-char-long → null',
    deserializeRegionalColour('a'.repeat(271)) === null,
  );

  // ── Similarity: identical → 1.0 ───────────────────────────────────────
  {
    const regions = Array.from({ length: 9 }, (_, i) => makeSig(i * 20, 100, 50, i % 12));
    const a = makeRegional(regions);
    const b = makeRegional(regions.map(r => ({ ...r, hueHist: [...r.hueHist] })));
    const sim = compareRegionalColourSignature(a, b);
    assert('identical signatures → similarity 1.0', sim === 1.0);
  }

  // ── Similarity: different spatial layout < same-card similarity ───────
  // Card A: orange (hue bucket 1 = 30°–60°) concentrated in top rows.
  // Card B: same amount of orange but in bottom rows.
  // Card C: orange uniformly distributed (would match A globally but not regionally).
  {
    function orangeTop(): RegionalColourSignature {
      return makeRegional(Array.from({ length: 9 }, (_, i) => {
        const inTop = i < 3;
        const hist = Array(12).fill(0);
        hist[1] = inTop ? 220 : 10; // heavy orange top, minimal bottom
        return { avgR: inTop ? 220 : 80, avgG: inTop ? 100 : 60, avgB: 30, hueHist: hist };
      }));
    }
    function orangeBottom(): RegionalColourSignature {
      return makeRegional(Array.from({ length: 9 }, (_, i) => {
        const inBot = i >= 6;
        const hist = Array(12).fill(0);
        hist[1] = inBot ? 220 : 10;
        return { avgR: inBot ? 220 : 80, avgG: inBot ? 100 : 60, avgB: 30, hueHist: hist };
      }));
    }
    function orangeUniform(): RegionalColourSignature {
      return makeRegional(Array.from({ length: 9 }, () => {
        const hist = Array(12).fill(0);
        hist[1] = 115; // split orange evenly (≈ avg of 220 and 10)
        return { avgR: 150, avgG: 80, avgB: 30, hueHist: hist };
      }));
    }

    const top  = orangeTop();
    const bot  = orangeBottom();
    const uni  = orangeUniform();
    const simSelf  = compareRegionalColourSignature(top, top);
    const simTopBot = compareRegionalColourSignature(top, bot);
    const simTopUni = compareRegionalColourSignature(top, uni);

    assert('self-comparison → 1.0', simSelf === 1.0);
    assert('top vs bottom layout < self', simTopBot < simSelf);
    assert('top vs uniform < self', simTopUni < simSelf);
    assert('spatial mismatch meaningfully distinct (sim < 0.9)', simTopBot < 0.9);
  }

  // ── serialize throws on wrong region count ────────────────────────────
  {
    let threw = false;
    try {
      serializeRegionalColour({ regions: [makeSig(0, 0, 0)] }); // only 1 region
    } catch {
      threw = true;
    }
    assert('serialize throws on wrong region count', threw);
  }

  const summary = [
    `Regional colour self-test: ${passed} passed, ${failed} failed`,
    ...results,
  ].join('\n');
  console.log(summary);
  return { passed, failed, summary };
}

// ── Internal ───────────────────────────────────────────────────────────────

/**
 * Copy one rectangular sub-region of an RGBA pixel array into a fresh
 * contiguous Uint8ClampedArray that _computeFromRGBA can iterate over.
 *
 * @param data      Full RGBA pixel buffer (row-major, 4 bytes per pixel).
 * @param fullWidth Width of the full canvas in pixels.
 * @param x0        Left edge of the region (inclusive).
 * @param y0        Top edge of the region (inclusive).
 * @param rw        Region width in pixels.
 * @param rh        Region height in pixels.
 */
function _extractRegionPixels(
  data:      Uint8ClampedArray,
  fullWidth: number,
  x0:        number,
  y0:        number,
  rw:        number,
  rh:        number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rw * rh * 4);
  let dst = 0;
  for (let row = y0; row < y0 + rh; row++) {
    for (let col = x0; col < x0 + rw; col++) {
      const src = (row * fullWidth + col) * 4;
      out[dst++] = data[src];
      out[dst++] = data[src + 1];
      out[dst++] = data[src + 2];
      out[dst++] = data[src + 3];
    }
  }
  return out;
}

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
