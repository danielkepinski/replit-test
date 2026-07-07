/**
 * Fingerprint database – pre-built at compile time by scripts/build-fingerprints.mjs.
 *
 * At runtime the JSON is loaded once via a dynamic import (Vite splits it into a
 * separate lazy chunk so it never blocks the initial render).  No card images are
 * fetched or decoded at runtime – only the pre-computed hex hashes are loaded.
 */

export interface CardFingerprint {
  /** pokemontcg.io card id, e.g. "base1-4" */
  id: string;
  name: string;
  /** Set display name, e.g. "Base Set" */
  set: string;
  /** Card number within the set, e.g. "4" */
  number: string;
  /** Small image URL (~245×342 JPEG from images.pokemontcg.io) */
  imageUrl: string;
  /**
   * 63-bit DCT perceptual hash stored as a zero-padded 16-character hex string.
   * Load with  BigInt('0x' + hash)  before comparing.
   */
  hash: string;
}

interface FingerprintDb {
  generated: string;
  count: number;
  cards: CardFingerprint[];
}

/** Module-level cache – populated once by loadFingerprintIndex(). */
let _index: CardFingerprint[] | null = null;

/**
 * Lazily load the pre-built fingerprint index.
 * Safe to call multiple times – only one network round-trip is made.
 */
export async function loadFingerprintIndex(): Promise<CardFingerprint[]> {
  if (_index) return _index;
  // Dynamic import → Vite emits fingerprints.json as a separate async chunk
  const mod = await import('./fingerprints.json');
  const db  = mod.default as FingerprintDb;
  _index    = db.cards;
  console.info(
    `[fingerprints] Loaded ${_index.length} card fingerprints ` +
    `(generated ${db.generated})`
  );
  return _index;
}

/**
 * Synchronous accessor – returns the already-loaded index (or empty array
 * if loadFingerprintIndex() hasn't resolved yet).  Used inside useScanner
 * at capture time, by which point the index is always loaded.
 */
export function getFingerprintIndex(): CardFingerprint[] {
  return _index ?? [];
}
