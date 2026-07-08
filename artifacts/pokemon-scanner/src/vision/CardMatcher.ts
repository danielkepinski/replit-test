import { CardFingerprint } from '../data/fingerprintDb';
import { hammingDistance } from '../utils/phash';
import { ColourSignature, colourDistance } from '../utils/colourSignature';
import { CropMode, CROP_MODES } from './ArtworkExtractor';

export type { CropMode };

/**
 * Per-mode scoring weights.
 *
 * Classic cards have sharper, more distinctive illustration-box structure,
 * so colour gets a larger role (0.45) to separate palette-similar cards.
 *
 * Full-art cards bleed colour across nearly the full frame; similar colour
 * palettes appear across many cards, so the hash gets more trust (0.70).
 *
 * Borderless cards are similar to full-art in structure, so the hash weight
 * is slightly higher still (0.75) to resist false colour matches.
 */
export const MODE_WEIGHTS: Record<CropMode, { hash: number; colour: number }> = {
  classic:    { hash: 0.55, colour: 0.45 },
  fullArt:    { hash: 0.70, colour: 0.30 },
  borderless: { hash: 0.75, colour: 0.25 },
};

export interface MatchEntry {
  card:          CardFingerprint;
  /** Hamming distance of the winning crop mode (0 = identical, 63 = max). */
  distance:      number;
  /** Combined confidence 0–100 (combinedScore × 100). */
  confidence:    number;
  /** Hash similarity of the winning mode, 0–1. */
  hashScore:     number;
  /** Colour similarity of the winning mode, 0–1.
   *  Equals hashScore when colour data is unavailable (graceful fallback). */
  colourScore:   number;
  /** Weighted combined score, 0–1.
   *  hashScore × 0.65 + colourScore × 0.35  when colour available;
   *  hashScore                               when colour unavailable. */
  combinedScore: number;
}

export interface MatchOutput {
  bestMatch:       MatchEntry;
  alternatives:    MatchEntry[];
  /** Crop mode that produced the highest combined score for the best match. */
  winningCropMode: CropMode;
  /** Hash weight applied for the winning crop mode (from MODE_WEIGHTS). */
  hashWeight:      number;
  /** Colour weight applied for the winning crop mode (from MODE_WEIGHTS). */
  colourWeight:    number;
  /** Total cards in the searched index. */
  indexSize:       number;
  /** Wall-clock time for the linear scan in milliseconds. */
  searchTime:      number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hashKey(mode: CropMode): 'classicHash' | 'fullArtHash' | 'borderlessHash' {
  return `${mode}Hash` as 'classicHash' | 'fullArtHash' | 'borderlessHash';
}

function colourKey(mode: CropMode): 'classicColor' | 'fullArtColor' | 'borderlessColor' {
  return `${mode}Color` as 'classicColor' | 'fullArtColor' | 'borderlessColor';
}

// ── Main matcher ───────────────────────────────────────────────────────────

/**
 * Linear scan across the full fingerprint index using a combined
 * hash + colour score with crop-mode-aware weights (see MODE_WEIGHTS).
 *
 * For each card, each crop mode is scored independently:
 *
 *   hashSim   = max(0, (32 − hammingDist) / 32)                      → [0, 1]
 *   colourSim = 1 − colourDistance(query, stored)                     → [0, 1]
 *
 *   w         = MODE_WEIGHTS[mode]
 *   modeScore = hashSim × w.hash + colourSim × w.colour  (colour available)
 *             = hashSim                                   (colour unavailable)
 *
 * The mode with the highest modeScore wins for that card.
 * Cards are ranked by their winning modeScore (descending).
 *
 * Performance:  3 × N BigInt XOR + N × 3 × ~20 float ops.
 * At N = 20 000: well under 10 ms in modern browsers.
 *
 * Backwards compatibility: cards whose stored colour fields are null
 * (pre-v3 fingerprints) fall back to hash-only scoring automatically.
 */
export function matchCard(
  queryHashes:  Record<CropMode, bigint>,
  queryColours: Record<CropMode, ColourSignature | null> | null,
  index:        CardFingerprint[],
  topN = 6,
): MatchOutput {
  const t0 = performance.now();

  type Scored = MatchEntry & { _mode: CropMode };

  const results: Scored[] = index.map(card => {
    let bestScore    = -1;
    let bestMode:    CropMode = 'classic';
    let bestHash     = 0;
    let bestColour   = 0;
    let bestDist     = 63;

    for (const mode of CROP_MODES) {
      const storedHash = BigInt('0x' + card[hashKey(mode)]);
      const dist       = hammingDistance(queryHashes[mode], storedHash);
      const hashSim    = Math.max(0, (32 - dist) / 32);

      const storedColour = card[colourKey(mode)];
      const queryColour  = queryColours?.[mode] ?? null;
      const hasColour    = storedColour !== null && queryColour !== null;

      const colourSim = hasColour
        ? 1 - colourDistance(queryColour!, storedColour!)
        : hashSim; // neutral proxy — keeps scale consistent

      const w        = MODE_WEIGHTS[mode];
      const combined = hasColour
        ? hashSim * w.hash + colourSim * w.colour
        : hashSim;

      if (combined > bestScore) {
        bestScore  = combined;
        bestMode   = mode;
        bestHash   = hashSim;
        bestColour = colourSim;
        bestDist   = dist;
      }
    }

    return {
      card,
      distance:      bestDist,
      confidence:    bestScore * 100,
      hashScore:     bestHash,
      colourScore:   bestColour,
      combinedScore: bestScore,
      _mode:         bestMode,
    };
  });

  // Sort descending by combined score
  results.sort((a, b) => b.combinedScore - a.combinedScore);

  const best    = results[0];
  const winMode = best._mode;

  // Strip internal field before returning
  const clean = ({ _mode: _m, ...rest }: Scored): MatchEntry => rest;

  const winWeights = MODE_WEIGHTS[winMode];

  return {
    bestMatch:       clean(best),
    alternatives:    results.slice(1, topN).map(clean),
    winningCropMode: winMode,
    hashWeight:      winWeights.hash,
    colourWeight:    winWeights.colour,
    indexSize:       index.length,
    searchTime:      performance.now() - t0,
  };
}
