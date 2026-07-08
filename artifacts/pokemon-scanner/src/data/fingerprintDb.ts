/**
 * Fingerprint database – pre-built at compile time by scripts/build-fingerprints.mjs.
 *
 * Schema has two generations:
 *
 *   Legacy (single-hash):
 *     { id, name, set, number, imageUrl, hash }
 *     Built with the classic artwork crop only.
 *
 *   Multi-crop (current):
 *     { id, name, set, number, imageUrl, classicHash, fullArtHash, borderlessHash }
 *     Three independent hashes — one per ArtworkExtractor crop region.
 *
 * loadFingerprintIndex() normalises legacy entries on the fly:
 *   classicHash = fullArtHash = borderlessHash = hash
 * so matching works immediately without a rebuild.  Running
 * build-fingerprints.mjs regenerates all three hashes per card.
 *
 * At runtime the JSON is loaded once via a dynamic import (Vite splits it into
 * a separate lazy chunk so it never blocks the initial render).
 */

// ── Raw JSON shape (either generation) ────────────────────────────────────

interface RawEntry {
  id:             string;
  name:           string;
  set:            string;
  number:         string;
  imageUrl:       string;
  /** Legacy single-hash field. Present in old format entries only. */
  hash?:          string;
  /** Multi-crop fields. Present in new format entries. */
  classicHash?:   string;
  fullArtHash?:   string;
  borderlessHash?: string;
}

interface FingerprintDb {
  generated: string;
  count:     number;
  cards:     RawEntry[];
}

// ── Normalised type used everywhere else ───────────────────────────────────

export interface CardFingerprint {
  /** pokemontcg.io card id, e.g. "base1-4" */
  id:             string;
  name:           string;
  /** Set display name, e.g. "Base Set" */
  set:            string;
  /** Card number within the set, e.g. "4" */
  number:         string;
  /** Small image URL from images.pokemontcg.io */
  imageUrl:       string;
  /** classic artwork-box crop pHash (x:8–92 %, y:15–55 %). */
  classicHash:    string;
  /** Full-art / ex / VMAX crop pHash (x:5–95 %, y:5–75 %). */
  fullArtHash:    string;
  /** Near-full-card crop pHash (x:2–98 %, y:2–98 %). */
  borderlessHash: string;
}

// ── Normalisation ──────────────────────────────────────────────────────────

const ZERO_HASH = '0'.repeat(16);

function normalise(raw: RawEntry): CardFingerprint {
  const fallback = raw.hash ?? ZERO_HASH;
  return {
    id:             raw.id,
    name:           raw.name,
    set:            raw.set,
    number:         raw.number,
    imageUrl:       raw.imageUrl,
    classicHash:    raw.classicHash    ?? fallback,
    fullArtHash:    raw.fullArtHash    ?? fallback,
    borderlessHash: raw.borderlessHash ?? fallback,
  };
}

// ── Module-level cache ─────────────────────────────────────────────────────

let _index: CardFingerprint[] | null = null;

/**
 * Lazily load the pre-built fingerprint index.
 * Safe to call multiple times – only one network round-trip is made.
 */
export async function loadFingerprintIndex(): Promise<CardFingerprint[]> {
  if (_index) return _index;
  const mod = await import('./fingerprints.json');
  const db  = mod.default as FingerprintDb;
  _index    = db.cards.map(normalise);
  console.info(
    `[fingerprints] Loaded ${_index.length} card fingerprints ` +
    `(generated ${db.generated})`
  );
  return _index;
}

/**
 * Synchronous accessor – returns the already-loaded index (or empty array
 * if loadFingerprintIndex() hasn't resolved yet).
 */
export function getFingerprintIndex(): CardFingerprint[] {
  return _index ?? [];
}
