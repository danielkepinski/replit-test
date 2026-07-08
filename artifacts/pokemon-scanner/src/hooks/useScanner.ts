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

export type ScanState = 'idle' | 'detecting' | 'processing' | 'matched' | 'error';

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
      if (result.failReason) setFailReason(result.failReason);
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
    if (!videoRef.current || !detectedCorners) return;
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
        setFailReason(structResult.reason ?? 'Not a Pokémon card');
        setProcessingTime(Math.round(performance.now() - t0));
        setState('error');
        return;
      }

      // 4. Extract all three crop regions → 5. resize each to 32×32 → 6. pHash
      const crops = extractAllCrops(normCanvas);
      const queryHashes: Record<CropMode, bigint> = {
        classic:    computePHash(imageToGrayscale32x32(crops.classic)),
        fullArt:    computePHash(imageToGrayscale32x32(crops.fullArt)),
        borderless: computePHash(imageToGrayscale32x32(crops.borderless)),
      };
      // Linear scan over the pre-built fingerprint index — best distance wins
      const index  = getFingerprintIndex();
      const output = matchCard(queryHashes, index);
      // Show classic hash + which crop mode produced the best match
      setHashDebug(
        queryHashes.classic.toString(16).padStart(16, '0') +
        ` [${output.winningCropMode}]`
      );
      setMatchResult(output);

      setProcessingTime(Math.round(performance.now() - t0));
      setState('matched');
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
