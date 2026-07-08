import { useState, useRef, useEffect, useCallback } from 'react';
import { detectCard, Point } from '../vision/CardDetector';
import { correctPerspective } from '../vision/PerspectiveCorrector';
import { normalizeCard } from '../vision/CardNormalizer';
import { computePHash } from '../utils/phash';
import { matchCard, MatchOutput } from '../vision/CardMatcher';
import { getFingerprintIndex } from '../data/fingerprintDb';
import { imageToGrayscale32x32 } from '../utils/canvasUtils';
import { extractAllCrops, CropMode } from '../vision/ArtworkExtractor';
import { DetectDebugStats } from '../vision/CardDetector';
import { validateCardStructure, CardStructureResult } from '../vision/CardStructureValidator';
import { extractColourSignature, ColourSignature } from '../utils/colourSignature';
import { createCenteredFallbackCrop } from '../vision/FallbackCropper';

export type ScanState = 'idle' | 'detecting' | 'processing' | 'matched' | 'error';

/** Which crop path produced the card image that was actually hashed/matched
 *  — surfaced in the debug panel so it's clear whether OpenCV's rectangle
 *  detection or the centred fallback crop was used for a given scan. */
export type CropSource = 'perspective' | 'fallback' | null;

/** Below this sharpnessScore (from the existing structure validator), a
 *  failed capture is reported to the user as "too blurry" rather than the
 *  more generic border/layout wording. Purely a UI-copy classification —
 *  does not change CardStructureValidator's pass/fail scoring. */
const BLUR_SHARPNESS_THRESHOLD = 0.25;

/** Below this confidence (%), a technically-produced match is treated as a
 *  scan failure ("low confidence / unclear card") rather than shown as a
 *  result. Reads matchCard's existing confidence output; matching logic
 *  itself is unchanged. */
const LOW_CONFIDENCE_THRESHOLD = 50;

const emptyStats = (): DetectDebugStats => ({
  rawContourCount: 0,
  externalContourCount: 0,
  candidateCount: 0,
  rejectedByArea: 0,
  rejectedByPoints: 0,
  rejectedByAspectRatio: 0,
  rejectedByConvexity: 0,
  rejectedByEdge: 0,
  selectedRect: null,
  usedFallback: false,
  bestScore: null,
});

/** Blits a card canvas into the shared "normalized" debug slot so DebugPanel
 *  can display exactly what was fed into ArtworkExtractor, regardless of
 *  whether it came from the perspective or fallback crop path. */
function blitToNormalizedDebug(debugCanvas: HTMLCanvasElement, cardCanvas: HTMLCanvasElement) {
  debugCanvas.width  = cardCanvas.width;
  debugCanvas.height = cardCanvas.height;
  debugCanvas.getContext('2d')!.drawImage(cardCanvas, 0, 0);
}

/**
 * Runs the shared post-crop pipeline — structure validation, artwork
 * extraction, hashing, and matching — on an already-normalised 488×680
 * card canvas. Used identically for both the perspective-corrected crop
 * and the centred fallback crop; none of ArtworkExtractor, phash,
 * colourSignature, or CardMatcher's scoring is changed by reusing them here.
 */
function runMatchPipeline(cardCanvas: HTMLCanvasElement): {
  structResult: CardStructureResult;
  matchOutput: MatchOutput | null;
} {
  const structResult = validateCardStructure(cardCanvas);
  if (!structResult.pass) {
    return { structResult, matchOutput: null };
  }

  const crops = extractAllCrops(cardCanvas);
  const queryHashes: Record<CropMode, bigint> = {
    classic:    computePHash(imageToGrayscale32x32(crops.classic)),
    fullArt:    computePHash(imageToGrayscale32x32(crops.fullArt)),
    borderless: computePHash(imageToGrayscale32x32(crops.borderless)),
  };
  const queryColours: Record<CropMode, ColourSignature> = {
    classic:    extractColourSignature(crops.classic),
    fullArt:    extractColourSignature(crops.fullArt),
    borderless: extractColourSignature(crops.borderless),
  };
  const index  = getFingerprintIndex();
  const matchOutput = matchCard(queryHashes, queryColours, index);
  return { structResult, matchOutput };
}

export function useScanner(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [state, setState]               = useState<ScanState>('idle');
  const [confidence, setConfidence]     = useState(0);
  const [processingTime, setProcessingTime] = useState(0);
  const [failReason, setFailReason]     = useState<string | null>(null);
  const [matchResult, setMatchResult]   = useState<MatchOutput | null>(null);
  const [detectedCorners, setDetectedCorners] = useState<Point[] | null>(null);
  const [hashDebug, setHashDebug]       = useState<string>('');
  const [debugStats, setDebugStats]     = useState<DetectDebugStats>(emptyStats);
  const [cardStructureResult, setCardStructureResult] = useState<CardStructureResult | null>(null);
  const [cropSource, setCropSource]     = useState<CropSource>(null);

  const debugCanvases = useRef({
    original:   document.createElement('canvas'),
    edges:      document.createElement('canvas'),
    rect:       document.createElement('canvas'),
    crop:       document.createElement('canvas'),
    normalized: document.createElement('canvas'),
  });

  const requestRef     = useRef<number>(0);
  const lastDetectTime = useRef<number>(0);

  const detectLoop = useCallback((time: number) => {
    if (state !== 'detecting' || !videoRef.current) return;
    if (time - lastDetectTime.current > 1000 / 15) { // ~15 fps cap
      const result = detectCard(
        videoRef.current,
        debugCanvases.current.original,
        debugCanvases.current.edges,
        debugCanvases.current.rect,
      );
      setConfidence(result.confidence);
      setDetectedCorners(result.corners);
      setDebugStats(result.debugStats);
      // Keep failReason fresh: clear it on a successful detect so a later
      // "no card shape" capture can't inherit a stale reason from an
      // earlier, now-resolved frame.
      if (result.failReason) setFailReason(result.failReason);
      else if (result.corners) setFailReason(null);
      lastDetectTime.current = time;
    }
    requestRef.current = requestAnimationFrame(detectLoop);
  }, [state, videoRef]);

  useEffect(() => {
    if (state === 'detecting') {
      requestRef.current = requestAnimationFrame(detectLoop);
    } else {
      cancelAnimationFrame(requestRef.current);
    }
    return () => cancelAnimationFrame(requestRef.current);
  }, [state, detectLoop]);

  const capture = useCallback(async () => {
    // The Scan button is always tappable now (see ScanButton) — capture is
    // responsible for explaining *why* it can't produce a match rather than
    // being gated behind detection state. Each branch below reuses reasons
    // already produced by the existing detection/validation/matching
    // pipeline; no detection or matching logic is changed here.
    if (!videoRef.current || !videoRef.current.videoWidth) {
      setFailReason('Video not ready');
      setState('error');
      return;
    }

    setState('processing');
    const t0 = performance.now();

    try {
      if (detectedCorners) {
        // ── Primary path: OpenCV found a rectangle ──────────────────────────
        // 1. Perspective-correct the card from the video frame
        const corrected  = correctPerspective(videoRef.current, detectedCorners, debugCanvases.current.crop);
        // 2. Normalize to fixed 488×680 — matches pokemontcg.io reference aspect ratio
        const cardCanvas = normalizeCard(corrected);
        blitToNormalizedDebug(debugCanvases.current.normalized, cardCanvas);
        setCropSource('perspective');

        // 3. Post-perspective card structure validation
        //    Rejects non-cards (tattoos, signs, plain rectangles) before hashing
        const { structResult, matchOutput } = runMatchPipeline(cardCanvas);
        setCardStructureResult(structResult);

        if (!structResult.pass) {
          // sharpnessScore is an existing pipeline output (Laplacian variance);
          // when it's the dominant weak signal, surface "too blurry" instead of
          // the more generic border/layout wording — no change to the
          // validator's own pass/fail scoring or thresholds.
          const reason = structResult.sharpnessScore < BLUR_SHARPNESS_THRESHOLD
            ? 'Too blurry — hold the camera steady and refocus'
            : (structResult.reason ?? 'Weak border/layout — card frame not clearly visible');
          setFailReason(reason);
          setProcessingTime(Math.round(performance.now() - t0));
          setState('error');
          return;
        }

        const output = matchOutput!;
        setHashDebug(`[${output.winningCropMode}]`);
        setMatchResult(output);
        setProcessingTime(Math.round(performance.now() - t0));

        // matchCard always returns *some* best match from the index (it's a
        // linear nearest-neighbour scan, not a threshold classifier), so a
        // weak/ambiguous capture still "matches" something with low
        // confidence. Surface that as a scan failure instead of presenting an
        // unreliable result as if it were a confident identification. This
        // reads the existing confidence output — matchCard's scoring itself is
        // unchanged.
        if (output.bestMatch.confidence < LOW_CONFIDENCE_THRESHOLD) {
          setFailReason(
            `Low confidence match (${output.bestMatch.confidence.toFixed(0)}%) — unclear card`
          );
          setState('error');
          return;
        }

        setState('matched');
      } else {
        // ── Fallback path: OpenCV couldn't find a card rectangle ───────────
        // Fingers/glare often hide the card's outline even though the
        // artwork itself is perfectly usable. Try a centred, aspect-ratio-
        // correct crop through the exact same downstream pipeline before
        // giving up. No OpenCV, CardDetector, or CardMatcher changes here.
        const cardCanvas = createCenteredFallbackCrop(videoRef.current, debugCanvases.current.crop);
        blitToNormalizedDebug(debugCanvases.current.normalized, cardCanvas);
        setCropSource('fallback');

        const { structResult, matchOutput } = runMatchPipeline(cardCanvas);
        setCardStructureResult(structResult);
        setProcessingTime(Math.round(performance.now() - t0));

        const fallbackConfident =
          matchOutput !== null && matchOutput.bestMatch.confidence >= LOW_CONFIDENCE_THRESHOLD;

        if (!fallbackConfident) {
          // Both the rectangle detector AND the fallback crop failed to
          // produce a usable card — only now do we tell the user we
          // couldn't find a card at all.
          setFailReason('No card detected');
          setState('error');
          return;
        }

        setHashDebug(`[${matchOutput!.winningCropMode}]`);
        setMatchResult(matchOutput);
        setState('matched');
      }
    } catch (err) {
      console.error(err);
      setFailReason(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [videoRef, detectedCorners]);

  const reset = useCallback(() => {
    setState('detecting');
    setMatchResult(null);
    setFailReason(null);
    setConfidence(0);
    setDetectedCorners(null);
    setHashDebug('');
    setDebugStats(emptyStats());
    setCardStructureResult(null);
    setCropSource(null);
  }, []);

  const startDetection = useCallback(() => {
    setState('detecting');
  }, []);

  return {
    state,
    confidence,
    processingTime,
    failReason,
    matchResult,
    detectedCorners,
    debugCanvases: debugCanvases.current,
    hashDebug,
    debugStats,
    cardStructureResult,
    cropSource,
    capture,
    reset,
    startDetection,
  };
}
