# Pokémon Card Scanner

A browser-based Pokémon card scanner that uses real computer vision to detect, straighten, and identify Pokémon cards from a camera image.

## Run & Operate

- The app runs via the `artifacts/pokemon-scanner: web` workflow (managed by the artifact system) and is served at the root preview path `/`.
- `pnpm --filter @workspace/pokemon-scanner run dev` — run the frontend manually if needed (port auto-assigned)
- `pnpm run typecheck` — full typecheck across all packages
- Requires camera permission in the browser to scan cards; this is expected and not an error.
- The workspace also registers `api-server` and `mockup-sandbox` artifacts (standard platform scaffolding); they are not required to run or use the scanner.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind CSS
- Computer vision: OpenCV.js (CDN-loaded, main thread)
- Card matching: DCT-based perceptual hash (pHash) — custom implementation, no npm deps
- No backend — fully browser-only

## Where things live

- `artifacts/pokemon-scanner/src/vision/` — CV pipeline (CardDetector, PerspectiveCorrector, ImageNormalizer, CardMatcher)
- `artifacts/pokemon-scanner/src/utils/phash.ts` — 63-bit DCT pHash implementation
- `artifacts/pokemon-scanner/src/data/referenceCards.ts` — 15-card reference database (Base Set)
- `artifacts/pokemon-scanner/src/hooks/useCamera.ts` — getUserMedia + stream lifecycle
- `artifacts/pokemon-scanner/src/hooks/useScanner.ts` — full scan pipeline state machine

## Architecture decisions

- OpenCV.js is loaded via dynamic script injection (not npm), polled until `window.cv` is ready
- All cv.Mat objects are deleted in `finally` blocks to prevent memory leaks in WebAssembly heap
- Corners ordered by sum/diff method (TL=min(x+y), BR=max(x+y), TR=min(y-x), BL=max(y-x)) — robust to skew
- pHash excludes the DC coefficient at [0,0] to reduce brightness/exposure sensitivity
- Camera stream tracked via `useRef` (not useState) for deterministic cleanup on unmount

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
