import { CardFingerprint } from '../data/fingerprintDb';
import { hammingDistance } from '../utils/phash';
import {
  ColourSignature,
  colourDistance,
  RegionalColourSignature,
  compareRegionalColourSignature,
} from '../utils/colourSignature';
import { CropMode, CROP_MODES } from './ArtworkExtractor';

export type { CropMode };

/**
 * When both global and regional colour signatures are available, the colour
 * term in the combined score is a weighted blend of the two:
 *
 *   colourScore = globalColourSim × GLOBAL_COLOUR_BLEND
 *               + regionalColourSim × REGIONAL_COLOUR_BLEND
 *
 * Regional colour divides the crop into a 3×3 grid and compares cell-by-cell,
 * catching cases where the global palette matches (e.g. Vulpix and Ho-Oh V
 * are both orange/red) but the spatial layout of that colour differs.
 * When regional data is absent (pre-v4 fingerprints), colourScore is the
 * global similarity alone — existing behaviour is unchanged.
 */
const GLOBAL_COLOUR_BLEND   = 0.55;
const REGIONAL_COLOUR_BLEND = 0.45;

/**
 * Per-mode scoring weights.
 *
 * Colour-only false positives (high colour similarity, weak structural/hash
 * similarity — e.g. Mega Greninja ex scans matching Kabutops on palette
 * alone) showed colour was overweighted relative to hash across all modes.
 * Hash weight was raised and colour weight lowered accordingly; see also
 * the low-hash penalty below, which further suppresses matches with weak
 * hash similarity regardless of how strong the colour similarity is.
 *
 * Full-art cards bleed colour across nearly the full frame; similar colour
 * palettes appear across many cards, so the hash gets the most trust (0.80).
 *
 * Borderless cards are similar to full-art in structure, so the hash weight
 * is slightly lower still (0.75) but remains hash-dominant.
 *
 * Classic cards have sharper, more distinctive illustration-box structure,
 * so colour retains a modest role (0.30) to help separate hash-similar cards.
 */
export const MODE_WEIGHTS: Record<CropMode, { hash: number; colour: number }> = {
  classic:    { hash: 0.70, colour: 0.30 },
  fullArt:    { hash: 0.80, colour: 0.20 },
  borderless: { hash: 0.75, colour: 0.25 },
};

/**
 * Low-hash penalty thresholds.
 *
 * A high colour score cannot rescue a card whose hash similarity is weak —
 * this is what produces colour-only false positives (matching a visually
 * different card that happens to share a dominant palette). Penalties are
 * applied to the mode's combined score (before the tie-break bonus, so the
 * tie-break bonus can never rescue a penalized low-hash score) and roll
 * straight through into the reported/displayed final score.
 *
 * No penalty applies once hashSimilarity >= LOW_HASH_THRESHOLD.
 */
const LOW_HASH_THRESHOLD        = 0.45; // below this: moderate penalty
const STRONG_LOW_HASH_THRESHOLD = 0.40; // below this: strong penalty
const LOW_HASH_PENALTY_FACTOR        = 0.75; // combined score ×= this
const STRONG_LOW_HASH_PENALTY_FACTOR = 0.60; // combined score ×= this

function applyLowHashPenalty(combined: number, hashSim: number): { combined: number; penalized: boolean } {
  if (hashSim < STRONG_LOW_HASH_THRESHOLD) {
    return { combined: combined * STRONG_LOW_HASH_PENALTY_FACTOR, penalized: true };
  }
  if (hashSim < LOW_HASH_THRESHOLD) {
    return { combined: combined * LOW_HASH_PENALTY_FACTOR, penalized: true };
  }
  return { combined, penalized: false };
}

/**
 * Small mode-selection tie-break bonus, added only when choosing which
 * crop mode "wins" for a card — never added to the reported/displayed
 * score. Modern ex / full-art / borderless cards often score nearly
 * identically to `classic` (their illustration overlaps the classic
 * illustration box), so `classic` — evaluated first — tends to win close
 * calls by default. This nudges fullArt/borderless to win genuine
 * near-ties without letting them beat classic by a wide margin, so
 * classic cards (where classic legitimately scores higher) are unaffected.
 */
const MODE_TIEBREAK_BONUS: Record<CropMode, number> = {
  classic:    0,
  fullArt:    0.03,
  borderless: 0.02,
};

export interface MatchEntry {
  card:          CardFingerprint;
  /** Hamming distance of the winning crop mode (0 = identical, 63 = max). */
  distance:      number;
  /** Combined confidence 0–100 (combinedScore × 100). */
  confidence:    number;
  /** Hash similarity of the winning mode, 0–1. */
  hashScore:     number;
  /** Effective colour similarity used in scoring, 0–1.
   *  When regional colour data is available (v4 fingerprints):
   *    globalColourSim × GLOBAL_COLOUR_BLEND + regionalColourSim × REGIONAL_COLOUR_BLEND
   *  When regional unavailable: global colour similarity only.
   *  When all colour data unavailable: equals hashScore (graceful fallback). */
  colourScore:   number;
  /** Regional colour similarity for the winning mode, 0–1.
   *  null when regional colour data is unavailable on either the query or
   *  the stored fingerprint (pre-v4 fingerprints). Used for debug display;
   *  the scoring impact is already folded into colourScore. */
  regionalColourScore: number | null;
  /** Weighted combined score, 0–1, with the low-hash penalty (if any)
   *  already applied.
   *  hashScore × w.hash + colourScore × w.colour  when colour available (per MODE_WEIGHTS);
   *  hashScore                                     when colour unavailable;
   *  then ×= penalty factor when hashScore < LOW_HASH_THRESHOLD. */
  combinedScore: number;
  /** True when the low-hash penalty (moderate or strong) was applied to
   *  this entry's winning mode — i.e. hashScore was below the low-hash
   *  threshold and the combined score was reduced accordingly. */
  lowHashPenaltyApplied: boolean;
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

function regionalColourKey(mode: CropMode): 'classicRegionalColor' | 'fullArtRegionalColor' | 'borderlessRegionalColor' {
  return `${mode}RegionalColor` as 'classicRegionalColor' | 'fullArtRegionalColor' | 'borderlessRegionalColor';
}

// ── Main matcher ───────────────────────────────────────────────────────────

/**
 * Linear scan across the full fingerprint index using a combined
 * hash + colour score with crop-mode-aware weights (see MODE_WEIGHTS).
 *
 * For each card, each crop mode is scored independently:
 *
 *   hashSim         = max(0, (32 − hammingDist) / 32)                    → [0,1]
 *   globalColourSim = 1 − colourDistance(query, stored)                   → [0,1]
 *   regionalSim     = compareRegionalColourSignature(query, stored)       → [0,1]
 *
 *   colourSim = globalColourSim × 0.55 + regionalSim × 0.45  (both available)
 *             = globalColourSim                                (regional unavailable)
 *             = hashSim                                        (all colour unavailable)
 *
 *   w         = MODE_WEIGHTS[mode]
 *   modeScore = hashSim × w.hash + colourSim × w.colour  (colour available)
 *             = hashSim                                   (colour unavailable)
 *
 * The mode with the highest modeScore wins for that card.
 * Cards are ranked by their winning modeScore (descending).
 *
 * Performance:  3 × N BigInt XOR + N × 3 × ~30 float ops.
 * At N = 20 000: well under 10 ms in modern browsers.
 *
 * Backwards compatibility:
 *   - pre-v3 fingerprints (no colour fields) → hash-only scoring
 *   - pre-v4 fingerprints (no regional fields) → global colour only (no blend)
 *   - v4 fingerprints → full hash + blended colour scoring
 */
export function matchCard(
  queryHashes:    Record<CropMode, bigint>,
  queryColours:   Record<CropMode, ColourSignature | null> | null,
  index:          CardFingerprint[],
  topN = 6,
  queryRegionals: Record<CropMode, RegionalColourSignature | null> | null = null,
): MatchOutput {
  const t0 = performance.now();

  type Scored = MatchEntry & { _mode: CropMode };

  const results: Scored[] = index.map(card => {
    let bestBiased    = -1;          // includes MODE_TIEBREAK_BONUS — selection only
    let bestScore     = -1;          // penalized combined score — used for reporting/ranking
    let bestMode:     CropMode = 'classic';
    let bestHash      = 0;
    let bestColour    = 0;           // effective (blended) colour score for winning mode
    let bestRegional: number | null = null; // raw regional score for winning mode (debug only)
    let bestDist      = 63;
    let bestPenalized = false;

    for (const mode of CROP_MODES) {
      const storedHash = BigInt('0x' + card[hashKey(mode)]);
      const dist       = hammingDistance(queryHashes[mode], storedHash);
      const hashSim    = Math.max(0, (32 - dist) / 32);

      const storedColour = card[colourKey(mode)];
      const queryColour  = queryColours?.[mode] ?? null;
      const hasColour    = storedColour !== null && queryColour !== null;

      // Global colour similarity (or hashSim proxy when colour unavailable)
      const globalColourSim = hasColour
        ? 1 - colourDistance(queryColour!, storedColour!)
        : hashSim; // neutral proxy — keeps scale consistent

      // Regional colour similarity — only available when both the query and
      // stored fingerprint carry regional data (v4+).
      const storedRegional = card[regionalColourKey(mode)];
      const queryRegional  = queryRegionals?.[mode] ?? null;
      const hasRegional    = storedRegional !== null && queryRegional !== null;
      const regionalSim    = hasRegional
        ? compareRegionalColourSignature(queryRegional!, storedRegional!)
        : null;

      // Blend: when regional data is present, weight global 55 % + regional 45 %.
      // When absent, use global colour alone — pre-v4 behaviour is unchanged.
      const colourSim = (hasRegional && regionalSim !== null)
        ? globalColourSim * GLOBAL_COLOUR_BLEND + regionalSim * REGIONAL_COLOUR_BLEND
        : globalColourSim;

      const w           = MODE_WEIGHTS[mode];
      const rawCombined = hasColour
        ? hashSim * w.hash + colourSim * w.colour
        : hashSim;

      // Low-hash penalty is applied BEFORE the tie-break bonus, so the
      // tie-break bonus can never rescue a penalized low-hash false positive.
      const { combined, penalized } = applyLowHashPenalty(rawCombined, hashSim);

      // Tie-break bonus only affects which mode wins for this card — the
      // reported score (bestScore) stays the true, penalized combined score.
      const biased = combined + MODE_TIEBREAK_BONUS[mode];

      if (biased > bestBiased) {
        bestBiased    = biased;
        bestScore     = combined;
        bestMode      = mode;
        bestHash      = hashSim;
        bestColour    = colourSim;   // blended when regional available
        bestRegional  = regionalSim; // null when regional unavailable
        bestDist      = dist;
        bestPenalized = penalized;
      }
    }

    return {
      card,
      distance:              bestDist,
      confidence:            bestScore * 100,
      hashScore:             bestHash,
      colourScore:           bestColour,
      regionalColourScore:   bestRegional,
      combinedScore:         bestScore,
      lowHashPenaltyApplied: bestPenalized,
      _mode:                 bestMode,
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
