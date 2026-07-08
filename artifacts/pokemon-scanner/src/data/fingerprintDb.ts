/**
 * Fingerprint database – pre-built at compile time by scripts/build-fingerprints.mjs.
 *
 * Schema generations:
 *
 *   v1 – Legacy (single-hash):
 *     { id, name, set, number, imageUrl, hash }
 *
 *   v2 – Multi-crop hashes:
 *     { …, classicHash, fullArtHash, borderlessHash }
 *
 *   v3 – Multi-crop hashes + colour signatures (current):
 *     { …, classicColor, fullArtColor, borderlessColor }
 *     Each colour field is a 30-char hex string (ColourSignature).
 *
 * loadFingerprintIndex() normalises older entries on the fly so matching works
 * without a rebuild; running build-fingerprints.mjs regenerates everything.
 *
 * At runtime the JSON is loaded once via a dynamic import (Vite lazy chunk).
 */

import { ColourSignature, deserializeColour } from '../utils/colourSignature';

// ── Raw JSON shape (any generation) ───────────────────────────────────────

interface RawEntry {
  id:              string;
  name:            string;
  set:             string;
  number:          string;
  imageUrl:        string;
  /** v1 single-hash field. */
  hash?:           string;
  /** v2 multi-crop hash fields. */
  classicHash?:    string;
  fullArtHash?:    string;
  borderlessHash?: string;
  /** v3 colour-signature fields (30-char hex). */
  classicColor?:    string;
  fullArtColor?:    string;
  borderlessColor?: string;
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
  /** Colour signatures — null when not yet computed (pre-v3 entries). */
  classicColor:    ColourSignature | null;
  fullArtColor:    ColourSignature | null;
  borderlessColor: ColourSignature | null;
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
    // Colour: deserialise hex → ColourSignature; null if missing (pre-v3)
    classicColor:    deserializeColour(raw.classicColor),
    fullArtColor:    deserializeColour(raw.fullArtColor),
    borderlessColor: deserializeColour(raw.borderlessColor),
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
