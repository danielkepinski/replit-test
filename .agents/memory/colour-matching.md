---
name: Colour-aware matching
description: ColourSignature format, scoring weights, regional extension, build-script parity, and deserialization rules for the Pokémon card scanner.
---

## ColourSignature format (v3, current)
30-char lowercase hex string: `RRGGBB` (6 chars) + 24 chars for 12 hue-histogram bytes.
Each hue bucket covers 30°; value is fraction-of-colour-pixels × 255 (byte, 0–255).
Pixels with HSV saturation < 0.12 or value < 0.08 are excluded from the histogram (near-grey / dark excluded).

Implemented in: `src/utils/colourSignature.ts`

## Scoring weights (CardMatcher — updated, hash-dominant)
Per-mode weights after false-positive reduction pass:
  classic:    hash 0.70, colour 0.30
  fullArt:    hash 0.80, colour 0.20
  borderless: hash 0.75, colour 0.25

Low-hash penalty applied before tie-break bonus (so tie-break cannot rescue a penalised match):
  hashSim < 0.40 → combinedScore ×= 0.60  (strong penalty)
  hashSim < 0.45 → combinedScore ×= 0.75  (moderate penalty)
  hashSim ≥ 0.45 → no penalty

`MatchEntry.lowHashPenaltyApplied: boolean` is exposed for UI display.

colourDistance = 0.4 × avgRGB_L2 + 0.6 × hueHist_L1  (both normalised to [0,1])

## RegionalColourSignature format (v4, not yet in fingerprints.json)
270-char lowercase hex string: 9 × 30-char blocks, row-major order (top-left first).
3×3 grid; each cell is a full ColourSignature (avgRGB + 12-bin hue histogram).
Extraction samples canvas at 30×30 → 9 non-overlapping 10×10 pixel regions.

**Why:** Global palette matching produces false positives when two cards share similar
dominant colours but differ spatially (e.g. Vulpix vs Ho-Oh V — both orange/red, different
layout). Cell-by-cell comparison catches spatial layout differences the global signature misses.

**How to apply:** CardMatcher can gate on non-null regional fields to add a regional colour
term alongside the existing global colour term. All current fingerprints have null regional
fields — activate only after fingerprint rebuild populates v4 data.

Key constants (breaking if changed — rebuild required):
  GRID_ROWS = 3, GRID_COLS = 3, REGIONAL_SAMPLE = 30, REGIONAL_COLOUR_HEX_LENGTH = 270

## Backwards compatibility
- Pre-v3 fingerprints lack colour fields → `deserializeColour(null)` → `null`
- Pre-v4 fingerprints lack regional fields → `deserializeRegionalColour(null)` → `null`
- Matcher detects null stored colour and falls back to hash-only for that card/mode
- No rebuild required to use old fingerprints; accuracy improves after rebuild

## Deserialization strictness
`deserializeColour` requires exactly 30 chars matching `/^[0-9a-fA-F]{30}$/`; returns null on any mismatch.
`deserializeRegionalColour` requires exactly 270 chars matching `/^[0-9a-fA-F]{270}$/`, plus per-region chunk validation; returns null on any mismatch.
**Why:** non-hex strings produce NaN from parseInt, which propagates silently into score math.

## Self-test
`selfTestRegionalColour()` exported from `colourSignature.ts` — pure (no-canvas), callable
from browser console. Covers: roundtrip, invalid inputs, identity similarity, spatial layout distinction.

## Build-script parity
Sharp path uses `.resize(32, 32, { kernel: 'nearest' })` to match the pure-JS fallback path.
Browser path uses `canvas.drawImage` (bilinear) — minor difference is tolerable given coarse 12-bin histogram.

## Fingerprint schema versions
- v1: `{ id, name, set, number, imageUrl, hash }` (single classic hash)
- v2: `{ …, classicHash, fullArtHash, borderlessHash }` (multi-crop)
- v3 (current): `{ …, classicColor, fullArtColor, borderlessColor }` (+ colour sigs, 30-char hex)
- v4 (future): `{ …, classicRegionalColor, fullArtRegionalColor, borderlessRegionalColor }` (+ regional colour sigs, 270-char hex)

fingerprintDb.ts normalises v1→v2 on load. v3 colour fields are null for v1/v2 entries. v4 regional fields are null for all current entries.
