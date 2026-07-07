export interface Point { x: number; y: number }

export interface DetectDebugStats {
  rawContourCount: number;
  externalContourCount: number;
  candidateCount: number;
  rejectedByArea: number;
  rejectedByPoints: number;
  rejectedByAspectRatio: number;
  rejectedByConvexity: number;
  selectedRect: Point[] | null;
  usedFallback: boolean;
}

export interface DetectResult {
  corners: Point[] | null;
  confidence: number;
  failReason?: string;
  debugStats: DetectDebugStats;
}

/**
 * Order 4 corners into [TL, TR, BR, BL] using sum/diff method.
 * Robust under perspective skew and rotation.
 */
function orderCorners(points: Point[]): [Point, Point, Point, Point] {
  const sums  = points.map(p => p.x + p.y);
  const diffs = points.map(p => p.y - p.x);
  const tl = points[sums.indexOf(Math.min(...sums))];
  const br = points[sums.indexOf(Math.max(...sums))];
  const tr = points[diffs.indexOf(Math.min(...diffs))];
  const bl = points[diffs.indexOf(Math.max(...diffs))];
  return [tl, tr, br, bl];
}

/**
 * Try progressively looser epsilon values to get a 4-point polygon.
 * Returns the 4 points if successful, null otherwise.
 */
function tryApproxTo4(cv: any, contour: any): Point[] | null {
  const peri = cv.arcLength(contour, true);
  for (const factor of [0.02, 0.03, 0.04, 0.06, 0.08, 0.10, 0.13]) {
    const approx = new cv.Mat();
    try {
      cv.approxPolyDP(contour, approx, factor * peri, true);
      if (approx.rows === 4) {
        const d    = approx.data32S;
        const pts: Point[] = [];
        for (let i = 0; i < 4; i++) pts.push({ x: d[i * 2], y: d[i * 2 + 1] });
        return pts;
      }
    } finally {
      approx.delete();
    }
  }
  return null;
}

/**
 * Compute the 4 corners of a minAreaRect without relying on cv.RotatedRect.points
 * (which is not reliably available across all OpenCV.js builds).
 */
function minAreaRectCorners(rect: { center: { x: number; y: number }; size: { width: number; height: number }; angle: number }): Point[] {
  const θ   = rect.angle * (Math.PI / 180);
  const hw  = rect.size.width  / 2;
  const hh  = rect.size.height / 2;
  const cx  = rect.center.x;
  const cy  = rect.center.y;
  const cos = Math.cos(θ);
  const sin = Math.sin(θ);
  // Four corners before rotation: (±hw, ±hh); apply 2D rotation then translate
  return [
    { x: cx - hw * cos + hh * sin, y: cy - hw * sin - hh * cos },
    { x: cx + hw * cos + hh * sin, y: cy + hw * sin - hh * cos },
    { x: cx + hw * cos - hh * sin, y: cy + hw * sin + hh * cos },
    { x: cx - hw * cos - hh * sin, y: cy - hw * sin + hh * cos },
  ];
}

/**
 * Measure the aspect ratio of a 4-point ordered quad [TL, TR, BR, BL].
 * Returns width/height.
 */
function quadAspectRatio(pts: [Point, Point, Point, Point]): number {
  const [tl, tr, br, bl] = pts;
  const wTop  = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBot  = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight= Math.hypot(br.x - tr.x, br.y - tr.y);
  const w     = (wTop  + wBot)  / 2;
  const h     = (hLeft + hRight) / 2;
  return h > 0 ? w / h : 999;
}

/** Pokémon card aspect ratio tolerance: 0.55–0.85 covers portrait + perspective skew. */
const RATIO_MIN = 0.55;
const RATIO_MAX = 0.85;
const CARD_RATIO = 2.5 / 3.5; // ~0.714 portrait

function isCardRatio(ratio: number): boolean {
  return ratio >= RATIO_MIN && ratio <= RATIO_MAX;
}

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

export function detectCard(
  video: HTMLVideoElement,
  debugCanvasOriginal?: HTMLCanvasElement,
  debugCanvasEdges?: HTMLCanvasElement,
  debugCanvasRect?: HTMLCanvasElement
): DetectResult {
  const cv    = (window as any).cv;
  const stats = emptyStats();

  if (!cv) return { corners: null, confidence: 0, failReason: 'OpenCV not loaded', debugStats: stats };
  if (!video.videoWidth || !video.videoHeight) {
    return { corners: null, confidence: 0, failReason: 'Video not ready', debugStats: stats };
  }

  // ── Capture original frame ──────────────────────────────────────────────────
  const origW = video.videoWidth;
  const origH = video.videoHeight;

  const origCanvas     = document.createElement('canvas');
  origCanvas.width     = origW;
  origCanvas.height    = origH;
  const origCtx        = origCanvas.getContext('2d', { willReadFrequently: true });
  if (!origCtx) return { corners: null, confidence: 0, failReason: 'Canvas context error', debugStats: stats };
  origCtx.drawImage(video, 0, 0);

  if (debugCanvasOriginal) {
    debugCanvasOriginal.width  = origW;
    debugCanvasOriginal.height = origH;
    debugCanvasOriginal.getContext('2d')!.drawImage(origCanvas, 0, 0);
  }

  // ── Downsample to 640 px wide for processing ────────────────────────────────
  // Smaller image suppresses internal card artwork / text detail so only the
  // strong outer border edges dominate the Canny output.
  const WORK_W  = 640;
  const scale   = Math.min(1, WORK_W / origW);
  const workW   = Math.round(origW * scale);
  const workH   = Math.round(origH * scale);

  const workCanvas  = document.createElement('canvas');
  workCanvas.width  = workW;
  workCanvas.height = workH;
  workCanvas.getContext('2d')!.drawImage(origCanvas, 0, 0, workW, workH);

  const frameArea = workW * workH;
  const MIN_AREA  = frameArea * 0.05; // card must cover ≥5 % of frame

  let src: any, gray: any, blurred: any, edges: any, processed: any;
  let closeKernel: any, dilateKernel: any;
  let contours: any, hierarchy: any;

  try {
    src      = cv.imread(workCanvas);
    gray     = new cv.Mat();
    blurred  = new cv.Mat();
    edges    = new cv.Mat();
    processed= new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    // Slightly stronger blur to smooth internal card texture
    cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);
    // Lower thresholds to ensure the card border is always captured
    cv.Canny(blurred, edges, 30, 100, 3, false);

    // Morphological CLOSE (large kernel) bridges any gaps in the outer card edge
    closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    cv.morphologyEx(edges, processed, cv.MORPH_CLOSE, closeKernel,
                    new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT,
                    cv.morphologyDefaultBorderValue());

    // Extra dilate to further seal small breaks
    dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(processed, processed, dilateKernel, new cv.Point(-1, -1), 1);

    if (debugCanvasEdges) {
      cv.imshow(debugCanvasEdges, processed);
    }

    // ── Find external contours only ─────────────────────────────────────────
    contours  = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(processed, contours, hierarchy,
                    cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    stats.rawContourCount      = contours.size();
    stats.externalContourCount = contours.size();

    // ── Evaluate each contour ───────────────────────────────────────────────
    interface Candidate { pts: [Point, Point, Point, Point]; area: number }
    const candidates: Candidate[]                       = [];
    const fallbacks:  { cnt: any; area: number }[]      = [];

    for (let i = 0; i < contours.size(); ++i) {
      const cnt  = contours.get(i);
      const area = cv.contourArea(cnt);

      if (area < MIN_AREA) {
        stats.rejectedByArea++;
        cnt.delete();
        continue;
      }

      const poly4 = tryApproxTo4(cv, cnt);

      if (!poly4) {
        // Can't simplify to 4 points — keep for minAreaRect fallback
        stats.rejectedByPoints++;
        fallbacks.push({ cnt: cnt.clone(), area });
        cnt.delete();
        continue;
      }

      // Convexity check
      const mat4 = cv.matFromArray(4, 1, cv.CV_32SC2,
        poly4.flatMap(p => [Math.round(p.x), Math.round(p.y)]));
      const convex = cv.isContourConvex(mat4);
      mat4.delete();

      if (!convex) {
        stats.rejectedByConvexity++;
        cnt.delete();
        continue;
      }

      const ordered = orderCorners(poly4);
      const ratio   = quadAspectRatio(ordered);

      // Accept portrait AND slight landscape (tilted cards look wider/narrower)
      if (!isCardRatio(ratio) && !isCardRatio(1 / ratio)) {
        stats.rejectedByAspectRatio++;
        cnt.delete();
        continue;
      }

      stats.candidateCount++;
      candidates.push({ pts: ordered, area });
      cnt.delete();
    }

    // ── Select best candidate ───────────────────────────────────────────────
    let selectedPts: [Point, Point, Point, Point] | null = null;
    let selectedArea = 0;
    let usedFallback = false;

    if (candidates.length > 0) {
      // Largest qualifying quad wins
      const best  = candidates.reduce((a, b) => a.area > b.area ? a : b);
      selectedPts  = best.pts;
      selectedArea = best.area;
    } else if (fallbacks.length > 0) {
      // ── minAreaRect fallback ──────────────────────────────────────────────
      // Sort largest first; try each until one passes the aspect-ratio check
      fallbacks.sort((a, b) => b.area - a.area);
      for (const fb of fallbacks) {
        const rect    = cv.minAreaRect(fb.cnt);
        const raw4    = minAreaRectCorners(rect);
        const ordered = orderCorners(raw4);
        const ratio   = quadAspectRatio(ordered);
        if (isCardRatio(ratio) || isCardRatio(1 / ratio)) {
          selectedPts  = ordered;
          selectedArea = fb.area;
          usedFallback = true;
          break;
        }
      }
    }

    fallbacks.forEach(f => f.cnt.delete());

    stats.usedFallback = usedFallback;

    // ── Return result ───────────────────────────────────────────────────────
    if (selectedPts) {
      // Scale corners back to original video resolution
      const corners = selectedPts.map(p => ({
        x: p.x / scale,
        y: p.y / scale,
      })) as [Point, Point, Point, Point];
      stats.selectedRect = corners;

      // Debug rect drawn on work-resolution image
      if (debugCanvasRect) {
        const dst = src.clone();
        try {
          for (let i = 0; i < 4; i++) {
            cv.line(
              dst,
              new cv.Point(selectedPts[i].x, selectedPts[i].y),
              new cv.Point(selectedPts[(i + 1) % 4].x, selectedPts[(i + 1) % 4].y),
              new cv.Scalar(0, 255, 136, 255),
              3
            );
          }
          cv.imshow(debugCanvasRect, dst);
        } finally {
          dst.delete();
        }
      }

      const areaRatio       = selectedArea / frameArea;
      const ratio           = quadAspectRatio(selectedPts);
      const effectiveRatio  = isCardRatio(ratio) ? ratio : 1 / ratio;
      const aspectCloseness = 1 - Math.min(Math.abs(effectiveRatio - CARD_RATIO) / CARD_RATIO, 1);
      const confidence      = Math.min(areaRatio * 5, 1) * 0.3 + aspectCloseness * 0.7;

      return { corners, confidence, debugStats: stats };
    }

    // Nothing found — show what we processed in the rect debug canvas
    if (debugCanvasRect) {
      cv.imshow(debugCanvasRect, src);
    }
    return { corners: null, confidence: 0, failReason: 'No card shape detected', debugStats: stats };

  } catch (err) {
    return { corners: null, confidence: 0, failReason: `OpenCV error: ${String(err)}`, debugStats: stats };
  } finally {
    src?.delete();
    gray?.delete();
    blurred?.delete();
    edges?.delete();
    processed?.delete();
    closeKernel?.delete();
    dilateKernel?.delete();
    contours?.delete();
    hierarchy?.delete();
  }
}
