---
name: Colour-aware matching
description: ColourSignature format, scoring weights, build-script parity, and deserialization rules for the Pokémon card scanner.
---

## ColourSignature format
30-char lowercase hex string: `RRGGBB` (6 chars) + 24 chars for 12 hue-histogram bytes.
Each hue bucket covers 30°; value is fraction-of-colour-pixels × 255 (byte, 0–255).
Pixels with HSV saturation < 0.12 or value < 0.08 are excluded from the histogram (near-grey / dark excluded).

Implemented in: `src/utils/colourSignature.ts`

## Scoring weights
combinedScore = hashSim × 0.65 + colourSim × 0.35  (when colour available)
combinedScore = hashSim                              (when colour unavailable — null fields)

colourDistance = 0.4 × avgRGB_L2 + 0.6 × hueHist_L1  (both normalised to [0,1])

## Backwards compatibility
- Pre-v3 fingerprints lack colour fields → `deserializeColour(null)` → `null`
- Matcher detects null stored colour and falls back to hash-only for that card/mode
- No rebuild required to use old fingerprints; accuracy improves after rebuild

## Deserialization strictness
`deserializeColour` requires exactly 30 chars matching `/^[0-9a-fA-F]{30}$/`; returns null on any mismatch.
**Why:** non-hex strings produce NaN from parseInt, which propagates silently into score math.

## Build-script parity
Sharp path uses `.resize(32, 32, { kernel: 'nearest' })` to match the pure-JS fallback path.
Browser path uses `canvas.drawImage` (bilinear) — minor difference is tolerable given coarse 12-bin histogram.

## Fingerprint schema versions
- v1: `{ id, name, set, number, imageUrl, hash }` (single classic hash)
- v2: `{ …, classicHash, fullArtHash, borderlessHash }` (multi-crop)
- v3 (current): `{ …, classicColor, fullArtColor, borderlessColor }` (+ colour sigs)

fingerprintDb.ts normalises v1→v2 on load. v3 colour fields are null for v1/v2 entries.
