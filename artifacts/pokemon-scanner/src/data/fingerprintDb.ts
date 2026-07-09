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
 *   v4 – Adds regional colour signatures (future — requires fingerprint rebuild):
 *     { …, classicRegionalColor, fullArtRegionalColor, borderlessRegionalColor }
 *     Each regional field is a 270-char hex string (RegionalColourSignature,
 *     9 × ColourSignature blocks in row-major 3×3 grid order).
 *
 * loadFingerprintIndex() normalises older entries on the fly so matching works
 * without a rebuild; running build-fingerprints.mjs regenerates everything.
 *
 * At runtime the JSON is loaded once via a dynamic import (Vite lazy chunk).
 */

import {
  ColourSignature,
  deserializeColour,
  RegionalColourSignature,
  deserializeRegionalColour,
} from '../utils/colourSignature';

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
  /** v4 regional colour-signature fields (270-char hex, 3×3 grid). */
  classicRegionalColor?:    string;
  fullArtRegionalColor?:    string;
  borderlessRegionalColor?: string;
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
  /**
   * Regional colour signatures — null until fingerprints are rebuilt with
   * v4 support. When present, each field is a 3×3 grid of ColourSignatures
   * (row-major, 9 cells) enabling spatially-aware colour matching.
   * CardMatcher can optionally incorporate these when non-null.
   */
  classicRegionalColor:    RegionalColourSignature | null;
  fullArtRegionalColor:    RegionalColourSignature | null;
  borderlessRegionalColor: RegionalColourSignature | null;
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
    // Regional colour: deserialise 270-char hex → RegionalColourSignature;
    // null for all pre-v4 entries (requires fingerprint rebuild to populate).
    classicRegionalColor:    deserializeRegionalColour(raw.classicRegionalColor),
    fullArtRegionalColor:    deserializeRegionalColour(raw.fullArtRegionalColor),
    borderlessRegionalColor: deserializeRegionalColour(raw.borderlessRegionalColor),
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
