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

export type ScanState = 'idle' | 'detecting' | 'processing' | 'matched' | 'error';

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
    if (!detectedCorners) {
      // Reuse whatever the live detection loop last reported (e.g. "No card
      // shape detected"); fall back to a sensible default if it hasn't run yet.
      setFailReason(failReason ?? 'No card shape detected');
      setState('error');
      return;
    }

    setState('processing');
    const t0 = performance.now();

    try {
      // 1. Perspective-correct the card from the video frame
      const corrected     = correctPerspective(videoRef.current, detectedCorners, debugCanvases.current.crop);

      // 2. Normalize to fixed 488×680 — matches pokemontcg.io reference aspect ratio
      const normCanvas    = normalizeCard(corrected);

      // Blit normalized canvas into the debug slot so DebugPanel can display it
      const normDebug     = debugCanvases.current.normalized;
      normDebug.width     = normCanvas.width;
      normDebug.height    = normCanvas.height;
      normDebug.getContext('2d')!.drawImage(normCanvas, 0, 0);

      // 3. Post-perspective card structure validation
      //    Rejects non-cards (tattoos, signs, plain rectangles) before hashing
      const structResult = validateCardStructure(normCanvas);
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

      // 4. Extract all three crop regions → 5. hash + colour per crop
      const crops = extractAllCrops(normCanvas);
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
      // Linear scan — combined hash + colour score
      const index  = getFingerprintIndex();
      const output = matchCard(queryHashes, queryColours, index);
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
    } catch (err) {
      console.error(err);
      setFailReason(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [videoRef, detectedCorners, failReason]);

  const reset = useCallback(() => {
    setState('detecting');
    setMatchResult(null);
    setFailReason(null);
    setConfidence(0);
    setDetectedCorners(null);
    setHashDebug('');
    setDebugStats(emptyStats());
    setCardStructureResult(null);
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
    capture,
    reset,
    startDetection,
  };
}
