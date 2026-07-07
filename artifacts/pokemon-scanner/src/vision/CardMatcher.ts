import { CardFingerprint } from '../data/fingerprintDb';
import { hammingDistance } from '../utils/phash';

export interface MatchEntry {
  card: CardFingerprint;
  /** Hamming distance between query hash and reference hash (0 = identical, 63 = max) */
  distance: number;
  /** 0–100 — drops to 0 at distance ≥ 32 (worse-than-random territory) */
  confidence: number;
}

export interface MatchOutput {
  bestMatch: MatchEntry;
  alternatives: MatchEntry[];
  /** Total cards in the searched index */
  indexSize: number;
  /** Wall-clock time for the linear scan in milliseconds */
  searchTime: number;
}

/**
 * Linear Hamming-distance scan across the full fingerprint index.
 *
 * Performance: 20 000 cards × one BigInt XOR + popcount ≈ 0.5–2 ms in
 * modern browsers — comfortably under the 500 ms budget with no spatial
 * index needed.
 *
 * Confidence formula:
 *   conf = max(0, (32 − distance) / 32) × 100
 *   → 100 % at distance 0 (identical hash)
 *   → 50 %  at distance 16
 *   → 0 %   at distance ≥ 32 (statistically random)
 */
export function matchCard(
  queryHash: bigint,
  index: CardFingerprint[],
  topN = 6
): MatchOutput {
  const t0 = performance.now();

  const results: MatchEntry[] = index.map(card => {
    const refHash  = BigInt('0x' + card.hash);
    const dist     = hammingDistance(queryHash, refHash);
    const conf     = Math.max(0, (32 - dist) / 32 * 100);
    return { card, distance: dist, confidence: conf };
  });

  results.sort((a, b) => a.distance - b.distance);

  return {
    bestMatch:    results[0],
    alternatives: results.slice(1, topN),
    indexSize:    index.length,
    searchTime:   performance.now() - t0,
  };
}
