import { useState, useRef, useEffect, useCallback } from 'react';
import { detectCard, Point } from '../vision/CardDetector';
import { correctPerspective } from '../vision/PerspectiveCorrector';
import { normalizeCard } from '../vision/CardNormalizer';
import { computePHash } from '../utils/phash';
import { matchCard, MatchOutput } from '../vision/CardMatcher';
import { getFingerprintIndex } from '../data/fingerprintDb';
import { imageToGrayscale32x32 } from '../utils/canvasUtils';
import { extractArtwork } from '../vision/ArtworkExtractor';
import { DetectDebugStats } from '../vision/CardDetector';

export type ScanState = 'idle' | 'detecting' | 'processing' | 'matched' | 'error';

const emptyStats = (): DetectDebugStats => ({
  rawContourCount: 0,
  externalContourCount: 0,
  candidateCount: 0,
  rejectedByArea: 0,
  rejectedByPoints: 0,
  rejectedByAspectRatio: 0,
  rejectedByConvexity: 0,
  selectedRect: null,
  usedFallback: false,
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

      // 3. Crop illustration window → 4. resize to 32×32 → 5. pHash
      const artworkCanvas = extractArtwork(normCanvas);
      const smallImgData  = imageToGrayscale32x32(artworkCanvas);
      const hash          = computePHash(smallImgData);
      setHashDebug(hash.toString(16).padStart(16, '0'));

      // Linear scan over the pre-built fingerprint index
      const index  = getFingerprintIndex();
      const output = matchCard(hash, index);
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
    capture,
    reset,
    startDetection,
  };
}
