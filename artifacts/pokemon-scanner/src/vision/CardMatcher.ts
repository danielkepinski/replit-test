import { CardFingerprint } from '../data/fingerprintDb';
import { hammingDistance } from '../utils/phash';
import { CropMode, CROP_MODES } from './ArtworkExtractor';

export type { CropMode };

export interface MatchEntry {
  card:       CardFingerprint;
  /** Minimum Hamming distance across all three crop-mode comparisons (0 = identical, 63 = max). */
  distance:   number;
  /** 0–100 — drops to 0 at distance ≥ 32 (worse-than-random territory). */
  confidence: number;
}

export interface MatchOutput {
  bestMatch:       MatchEntry;
  alternatives:    MatchEntry[];
  /** Which crop mode produced the winning (lowest) distance for the best match. */
  winningCropMode: CropMode;
  /** Total cards in the searched index. */
  indexSize:       number;
  /** Wall-clock time for the linear scan in milliseconds. */
  searchTime:      number;
}

/**
 * Key into a CardFingerprint for a given crop mode.
 * e.g. 'classic' → 'classicHash'
 */
function hashKey(mode: CropMode): 'classicHash' | 'fullArtHash' | 'borderlessHash' {
  return `${mode}Hash` as 'classicHash' | 'fullArtHash' | 'borderlessHash';
}

/**
 * Linear Hamming-distance scan across the full fingerprint index.
 *
 * For each card, computes one distance per crop mode (classic, fullArt,
 * borderless) — matching the same-mode query hash against the same-mode
 * stored hash.  The minimum across the three modes is used as the card's
 * overall distance, so:
 *   • Classic cards win on their classic crop.
 *   • Full-art / ex cards win on their fullArt or borderless crop.
 *
 * Performance: 3 × 20 000 BigInt XOR + popcount ≈ 1–4 ms in modern browsers.
 *
 * Confidence formula:
 *   conf = max(0, (32 − distance) / 32) × 100
 *   → 100 % at distance 0  (identical hash)
 *   → 50 %  at distance 16
 *   → 0 %   at distance ≥ 32 (statistically random)
 */
export function matchCard(
  queryHashes: Record<CropMode, bigint>,
  index:       CardFingerprint[],
  topN = 6,
): MatchOutput {
  const t0 = performance.now();

  // Pre-parse all stored hashes once outside the card loop
  const results: MatchEntry[] = index.map(card => {
    let bestDist = Infinity;

    for (const mode of CROP_MODES) {
      const storedHex  = card[hashKey(mode)];
      const storedHash = BigInt('0x' + storedHex);
      const dist       = hammingDistance(queryHashes[mode], storedHash);
      if (dist < bestDist) bestDist = dist;
    }

    const dist = bestDist;
    const conf = Math.max(0, (32 - dist) / 32 * 100);
    return { card, distance: dist, confidence: conf };
  });

  results.sort((a, b) => a.distance - b.distance);

  // Determine which crop mode produced the best match for the top result
  const topCard   = results[0].card;
  let winMode: CropMode = 'classic';
  let winDist = Infinity;
  for (const mode of CROP_MODES) {
    const storedHash = BigInt('0x' + topCard[hashKey(mode)]);
    const dist       = hammingDistance(queryHashes[mode], storedHash);
    if (dist < winDist) { winDist = dist; winMode = mode; }
  }

  return {
    bestMatch:       results[0],
    alternatives:    results.slice(1, topN),
    winningCropMode: winMode,
    indexSize:       index.length,
    searchTime:      performance.now() - t0,
  };
}
