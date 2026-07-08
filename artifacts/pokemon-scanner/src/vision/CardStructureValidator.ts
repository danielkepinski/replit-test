/**
 * CardStructureValidator
 *
 * Post-perspective-correction gate that confirms the warped rectangle looks
 * like a Pokémon card before we pass it to the pHash pipeline.
 *
 * Operates on the 488×680 normalised canvas produced by CardNormalizer.
 * Uses only pixel mathematics — no OpenCV, no colour assumptions.
 * Supports traditional yellow-border, full-art, silver/ex, and modern cards.
 *
 * Three independent checks (each 0–1):
 *
 *  sharpnessScore  — Laplacian variance.  Rejects motion-blurred captures
 *                    that would produce noisy hashes regardless.
 *
 *  borderScore     — The outer ~7 % ring of a Pokémon card is a distinct
 *                    frame (yellow, white, silver …) whose mean luminance
 *                    differs from the interior.  A tattoo or plain object
 *                    lacks this enclosed frame structure.
 *
 *  structureScore  — A card is dense with printed content (illustration,
 *                    name text, HP, attack stats, flavour text, set symbol).
 *                    Two sub-signals: (a) total Sobel edge energy per pixel,
 *                    and (b) variation across five horizontal zones — the
 *                    header, artwork, and text regions create a characteristic
 *                    vertical rhythm that flat objects lack.
 *
 * Composite: sharpness 20 % + border 35 % + structure 45 %.
 * Pass threshold: 0.28 (lenient to accommodate blurry/tilted captures).
 */

export interface CardStructureResult {
  /** True when the composite score meets the pass threshold. */
  pass: boolean;
  /** Composite score 0–1. */
  score: number;
  sharpnessScore: number;
  borderScore: number;
  structureScore: number;
  /** Human-readable reason when pass === false. */
  reason?: string;
}

const PASS_THRESHOLD = 0.28;

// ── Grayscale helpers ─────────────────────────────────────────────────────────

/** Fast luminance: BT.601 coefficients shifted into integer arithmetic. */
function toGray(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

function getGray(data: Uint8ClampedArray, w: number, x: number, y: number): number {
  const o = (y * w + x) * 4;
  return toGray(data[o], data[o + 1], data[o + 2]);
}

// ── Check 1: Sharpness ────────────────────────────────────────────────────────

/**
 * Laplacian variance over a subsampled grid.
 * A sharp card image has high variance; motion blur or heavy glare yields ~0.
 */
function computeSharpness(gray: Uint8Array, w: number, h: number): number {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y += 3) {
    for (let x = 1; x < w - 1; x += 3) {
      const i   = y * w + x;
      const lap = -4 * gray[i]
        + gray[i - 1] + gray[i + 1]
        + gray[i - w] + gray[i + w];
      sum   += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean     = sum / n;
  const variance = sumSq / n - mean * mean;
  // ~30+ = usable; ~300 = crisp; cap at 400 to normalise
  return Math.min(variance / 400, 1.0);
}

// ── Check 2: Border frame ─────────────────────────────────────────────────────

/**
 * Measures whether the outer ~7 % ring is a distinct, relatively uniform
 * frame compared with the interior.
 *
 * Scoring:
 *   contrast   — |mean(border) − mean(interior)| / 50  (capped at 1)
 *   uniformity — 1 − borderVariance / 2500            (capped at 0)
 *
 * Weights: contrast 65 %, uniformity 35 %.
 */
function computeBorderScore(gray: Uint8Array, w: number, h: number): number {
  const depth = Math.round(Math.min(w, h) * 0.07); // ~34 px on a 488-wide card

  let borderSum = 0, borderSumSq = 0, borderN = 0;
  let innerSum  = 0, innerN  = 0;

  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const v       = gray[y * w + x];
      const onEdge  = x < depth || x >= w - depth || y < depth || y >= h - depth;
      if (onEdge) {
        borderSum   += v;
        borderSumSq += v * v;
        borderN++;
      } else {
        innerSum += v;
        innerN++;
      }
    }
  }

  if (borderN === 0 || innerN === 0) return 0;

  const borderMean = borderSum   / borderN;
  const innerMean  = innerSum    / innerN;

  // Contrast between frame and content
  const contrast = Math.min(Math.abs(borderMean - innerMean) / 50, 1.0);

  // Frame uniformity (a silver or yellow border should be smooth)
  const borderVar  = borderSumSq / borderN - borderMean * borderMean;
  const uniformity = Math.max(0, 1 - borderVar / 2500);

  return contrast * 0.65 + uniformity * 0.35;
}

// ── Check 3: Internal content structure ───────────────────────────────────────

/**
 * A Pokémon card is packed with content: name / HP text at the top, an
 * illustration, attack blocks, flavour text, and a footer with set symbols.
 *
 * Two sub-signals built from per-row Sobel gradient energy:
 *   energyScore    — mean edge energy per pixel across the card.
 *                    Cards score ~30–60 units; plain rectangles ~5–15.
 *   variationScore — coefficient-of-variation² across five horizontal zones.
 *                    The header / artwork / text rhythm creates non-uniform
 *                    energy that flat objects lack.
 *
 * Weights: energy 65 %, zone-variation 35 %.
 */
function computeStructureScore(gray: Uint8Array, w: number, h: number): number {
  const rowEnergy = new Float32Array(h);

  for (let y = 1; y < h - 1; y++) {
    let e = 0, n = 0;
    for (let x = 1; x < w - 1; x += 4) {
      const i  = y * w + x;
      // 3×3 Sobel Gx and Gy
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
                 +gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
                 +gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      e += Math.sqrt(gx * gx + gy * gy);
      n++;
    }
    rowEnergy[y] = n > 0 ? e / n : 0;
  }

  const totalMean = rowEnergy.reduce((a, b) => a + b, 0) / h;
  // Cards: ~30–60 units; blank/tattoo rectangles: ~5–20.  Cap at 55.
  const energyScore = Math.min(totalMean / 55, 1.0);

  // Zone variation
  const ZONES = 5;
  const zoneMeans = Array.from({ length: ZONES }, (_, z) => {
    const y0 = Math.round(z       * h / ZONES);
    const y1 = Math.round((z + 1) * h / ZONES);
    let s = 0;
    for (let y = y0; y < y1; y++) s += rowEnergy[y];
    return s / Math.max(y1 - y0, 1);
  });
  const zm  = zoneMeans.reduce((a, b) => a + b, 0) / ZONES;
  const zv  = zoneMeans.reduce((a, z) => a + (z - zm) ** 2, 0) / ZONES;
  // CV² (normalised variance).  Cap at 1.
  const variationScore = Math.min(zv / (zm * zm + 1) * 0.8, 1.0);

  return energyScore * 0.65 + variationScore * 0.35;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function validateCardStructure(canvas: HTMLCanvasElement): CardStructureResult {
  const w   = canvas.width;   // 488
  const h   = canvas.height;  // 680
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { pass: false, score: 0, sharpnessScore: 0, borderScore: 0, structureScore: 0, reason: 'Canvas context unavailable' };
  }

  const { data } = ctx.getImageData(0, 0, w, h);

  // Build grayscale buffer
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o  = i * 4;
    gray[i]  = toGray(data[o], data[o + 1], data[o + 2]);
  }

  const sharpnessScore = computeSharpness(gray, w, h);
  const borderScore    = computeBorderScore(gray, w, h);
  const structureScore = computeStructureScore(gray, w, h);

  const score =
    sharpnessScore * 0.20 +
    borderScore    * 0.35 +
    structureScore * 0.45;

  let reason: string | undefined;
  if (score < PASS_THRESHOLD) {
    if (sharpnessScore < 0.05) {
      reason = `Too blurry (sharp ${pct(sharpnessScore)})`;
    } else if (structureScore < 0.15) {
      reason = `No card layout (struct ${pct(structureScore)})`;
    } else if (borderScore < 0.12) {
      reason = `No frame border (border ${pct(borderScore)})`;
    } else {
      reason = `Low card structure score (${pct(score)})`;
    }
  }

  return { pass: score >= PASS_THRESHOLD, score, sharpnessScore, borderScore, structureScore, reason };
}

function pct(v: number): string {
  return (v * 100).toFixed(0) + '%';
}
