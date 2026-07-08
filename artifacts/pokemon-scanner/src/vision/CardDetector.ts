export interface Point { x: number; y: number }

export interface DetectDebugStats {
  rawContourCount: number;
  externalContourCount: number;
  candidateCount: number;
  rejectedByArea: number;
  rejectedByPoints: number;
  rejectedByAspectRatio: number;
  rejectedByConvexity: number;
  rejectedByEdge: number;
  selectedRect: Point[] | null;
  usedFallback: boolean;
  /** Composite score (0–1) of the chosen candidate; null when nothing found. */
  bestScore: number | null;
}

export interface DetectResult {
  corners: Point[] | null;
  confidence: number;
  failReason?: string;
  debugStats: DetectDebugStats;
}

// ── Card geometry constants ───────────────────────────────────────────────────
/** Pokémon card ideal aspect ratio (width / height): 63 mm / 88 mm ≈ 0.716 */
const CARD_RATIO = 63 / 88;    // ~0.716

/**
 * Hard pre-filter window.  Only quads whose ratio falls entirely outside this
 * range (in either portrait or landscape orientation) are rejected before
 * scoring.  Wide enough to accommodate cards held at a significant camera
 * angle — perspective foreshortening can shift the apparent ratio well away
 * from the ideal 0.716.
 */
const RATIO_MIN = 0.50;
const RATIO_MAX = 0.90;

/**
 * Scoring anchor points — aspect-ratio score reaches exactly 0.0 at these
 * values.  They extend beyond the filter window so that cards near the
 * filter boundary still receive a meaningful partial score rather than
 * landing very close to zero.
 */
const SCORE_ANCHOR_MIN = 0.35;
const SCORE_ANCHOR_MAX = 1.10;

/**
 * Pixels (in work-resolution space) a corner may be from the image edge.
 * Contours whose corners touch the border are usually the camera frame
 * background, not the card.
 */
const EDGE_MARGIN = 8;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
function minAreaRectCorners(rect: {
  center: { x: number; y: number };
  size: { width: number; height: number };
  angle: number;
}): Point[] {
  const θ   = rect.angle * (Math.PI / 180);
  const hw  = rect.size.width  / 2;
  const hh  = rect.size.height / 2;
  const cx  = rect.center.x;
  const cy  = rect.center.y;
  const cos = Math.cos(θ);
  const sin = Math.sin(θ);
  return [
    { x: cx - hw * cos + hh * sin, y: cy - hw * sin - hh * cos },
    { x: cx + hw * cos + hh * sin, y: cy + hw * sin - hh * cos },
    { x: cx + hw * cos - hh * sin, y: cy + hw * sin + hh * cos },
    { x: cx - hw * cos - hh * sin, y: cy - hw * sin + hh * cos },
  ];
}

/**
 * Measure the aspect ratio of an ordered quad [TL, TR, BR, BL].
 * Returns width / height using the averaged top/bottom and left/right edges.
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

/** Area of a quad using the shoelace formula (always positive). */
function quadArea(pts: [Point, Point, Point, Point]): number {
  const [tl, tr, br, bl] = pts;
  return 0.5 * Math.abs(
    tl.x * (tr.y - bl.y) +
    tr.x * (br.y - tl.y) +
    br.x * (bl.y - tr.y) +
    bl.x * (tl.y - br.y),
  );
}

function isCardRatio(ratio: number): boolean {
  return ratio >= RATIO_MIN && ratio <= RATIO_MAX;
}

/**
 * Returns true if any corner is within EDGE_MARGIN pixels of the image boundary.
 * Such contours are almost always the background frame or a partially-visible card,
 * not the card we want.
 */
function touchesEdge(pts: Point[], w: number, h: number): boolean {
  return pts.some(
    p => p.x < EDGE_MARGIN || p.y < EDGE_MARGIN ||
         p.x > w - EDGE_MARGIN || p.y > h - EDGE_MARGIN,
  );
}

// ── Scoring ───────────────────────────────────────────────────────────────────

interface ScoredCandidate {
  pts: [Point, Point, Point, Point];
  contourArea: number;
  aspectRatioScore: number;
  rectangularityScore: number;
  cornerScore: number;
  areaScore: number;
  totalScore: number;
}

/**
 * Score a 4-corner candidate on four independent axes (each 0–1):
 *
 *  aspectRatioScore    — closeness to the ideal 0.716 card ratio.
 *                        Picks whichever orientation (portrait / landscape) is
 *                        closer to CARD_RATIO so a rotated-90° card is handled
 *                        automatically.  Piecewise linear from the scoring
 *                        anchors (SCORE_ANCHOR_MIN/MAX) to 1.0 at CARD_RATIO.
 *                        Uses extended anchors so cards near the filter
 *                        boundary still get a non-trivial score.
 *
 *  rectangularityScore — contourArea / quadArea.  A clean card edge scores
 *                        near 1.0; blobs distorted by a hand or background
 *                        score lower.  Primary discriminator vs. hands.
 *
 *  cornerScore         — how close the 4 interior angles are to 90°.
 *                        Score per corner = 1 − |cos θ|; averaged over all 4.
 *                        A rectangle (including perspective-distorted cards)
 *                        scores near 1.0; organic hand shapes score lower.
 *
 *  areaScore           — prefer cards that cover a substantial but not
 *                        overwhelming portion of the frame.
 *
 * Weights: aspect 25 %, rectangularity 40 %, corner 25 %, area 10 %.
 */
function scoreCandidate(
  pts: [Point, Point, Point, Point],
  contourArea: number,
  frameArea: number,
): ScoredCandidate {
  // ── Aspect ratio score ───────────────────────────────────────────────────
  // Pick the orientation (ratio or 1/ratio) that is closer to CARD_RATIO.
  // This handles landscape cards and perspective rotations without needing
  // a separate isCardRatio() gate inside the scorer.
  const ratio = quadAspectRatio(pts);
  const inv   = 1 / ratio;
  const effectiveRatio = Math.abs(ratio - CARD_RATIO) <= Math.abs(inv - CARD_RATIO)
    ? ratio : inv;

  // Piecewise linear: 1.0 at CARD_RATIO, 0.0 at SCORE_ANCHOR_MIN/MAX.
  // The anchors extend past RATIO_MIN/RATIO_MAX so boundary candidates still
  // receive a real score rather than landing near zero.
  const aspectRatioScore = effectiveRatio <= CARD_RATIO
    ? Math.max(0, (effectiveRatio - SCORE_ANCHOR_MIN) / (CARD_RATIO - SCORE_ANCHOR_MIN))
    : Math.max(0, (SCORE_ANCHOR_MAX - effectiveRatio) / (SCORE_ANCHOR_MAX - CARD_RATIO));

  // ── Rectangularity score ─────────────────────────────────────────────────
  const qa = quadArea(pts);
  const rectangularityScore = qa > 0 ? Math.min(contourArea / qa, 1) : 0;

  // ── Corner score ─────────────────────────────────────────────────────────
  // For each corner, measure the interior angle using the two outgoing edge
  // vectors.  score per corner = 1 − |cos θ|; perfect 90° → cos = 0 → 1.0.
  const [tl, tr, br, bl] = pts;
  function cornerCos(prev: Point, cur: Point, next: Point): number {
    const ax = prev.x - cur.x, ay = prev.y - cur.y;
    const bx = next.x - cur.x, by = next.y - cur.y;
    const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by);
    if (lenA === 0 || lenB === 0) return 0;
    return (ax * bx + ay * by) / (lenA * lenB);
  }
  const cosines = [
    cornerCos(bl, tl, tr),   // TL
    cornerCos(tl, tr, br),   // TR
    cornerCos(tr, br, bl),   // BR
    cornerCos(br, bl, tl),   // BL
  ];
  const cornerScore = cosines.reduce((sum, c) => sum + (1 - Math.abs(c)), 0) / 4;

  // ── Area score ───────────────────────────────────────────────────────────
  const areaFrac = contourArea / frameArea;
  let areaScore: number;
  if (areaFrac <= 0.65) {
    areaScore = Math.min(areaFrac / 0.30, 1.0);
  } else {
    areaScore = Math.max(0, 1.0 - (areaFrac - 0.65) / 0.35);
  }

  const totalScore =
    aspectRatioScore    * 0.25 +
    rectangularityScore * 0.40 +
    cornerScore         * 0.25 +
    areaScore           * 0.10;

  return { pts, contourArea, aspectRatioScore, rectangularityScore, cornerScore, areaScore, totalScore };
}

// ── emptyStats ────────────────────────────────────────────────────────────────

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

// ── detectCard ────────────────────────────────────────────────────────────────

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

  const origCanvas = document.createElement('canvas');
  origCanvas.width  = origW;
  origCanvas.height = origH;
  const origCtx = origCanvas.getContext('2d', { willReadFrequently: true });
  if (!origCtx) return { corners: null, confidence: 0, failReason: 'Canvas context error', debugStats: stats };
  origCtx.drawImage(video, 0, 0);

  if (debugCanvasOriginal) {
    debugCanvasOriginal.width  = origW;
    debugCanvasOriginal.height = origH;
    debugCanvasOriginal.getContext('2d')!.drawImage(origCanvas, 0, 0);
  }

  // ── Downsample to 640 px wide for processing ────────────────────────────────
  const WORK_W = 640;
  const scale  = Math.min(1, WORK_W / origW);
  const workW  = Math.round(origW * scale);
  const workH  = Math.round(origH * scale);

  const workCanvas = document.createElement('canvas');
  workCanvas.width  = workW;
  workCanvas.height = workH;
  workCanvas.getContext('2d')!.drawImage(origCanvas, 0, 0, workW, workH);

  const frameArea = workW * workH;
  const MIN_AREA  = frameArea * 0.05; // card must cover ≥ 5 % of frame

  let src: any, gray: any, blurred: any, edges: any, processed: any;
  let closeKernel: any, dilateKernel: any;
  let contours: any, hierarchy: any;

  try {
    src       = cv.imread(workCanvas);
    gray      = new cv.Mat();
    blurred   = new cv.Mat();
    edges     = new cv.Mat();
    processed = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 30, 100, 3, false);

    // Morphological CLOSE bridges gaps in the outer card edge
    closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    cv.morphologyEx(edges, processed, cv.MORPH_CLOSE, closeKernel,
                    new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT,
                    cv.morphologyDefaultBorderValue());

    // Extra dilate to seal small breaks
    dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(processed, processed, dilateKernel, new cv.Point(-1, -1), 1);

    if (debugCanvasEdges) cv.imshow(debugCanvasEdges, processed);

    // ── Find external contours only ─────────────────────────────────────────
    contours  = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(processed, contours, hierarchy,
                    cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    stats.rawContourCount      = contours.size();
    stats.externalContourCount = contours.size();

    // ── Evaluate each contour ───────────────────────────────────────────────
    const candidates: ScoredCandidate[]           = [];
    const fallbacks: { cnt: any; area: number }[] = [];

    for (let i = 0; i < contours.size(); ++i) {
      const cnt  = contours.get(i);
      const area = cv.contourArea(cnt);

      // 1. Minimum area
      if (area < MIN_AREA) {
        stats.rejectedByArea++;
        cnt.delete();
        continue;
      }

      // 2. Must simplify to exactly 4 corners
      const poly4 = tryApproxTo4(cv, cnt);
      if (!poly4) {
        stats.rejectedByPoints++;
        fallbacks.push({ cnt: cnt.clone(), area });
        cnt.delete();
        continue;
      }

      // 3. Convexity
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

      // 4. Aspect ratio hard filter (0.50–0.90).
      //    Only truly extreme shapes are rejected here; scoring handles the
      //    rest.  Perspective foreshortening can push a real card close to
      //    the boundary, so the window is intentionally wide.
      if (!isCardRatio(ratio) && !isCardRatio(1 / ratio)) {
        stats.rejectedByAspectRatio++;
        cnt.delete();
        continue;
      }

      // 5. Edge-touching rejection — background frames and partially-visible
      //    cards almost always have corners right against the image border
      if (touchesEdge(ordered, workW, workH)) {
        stats.rejectedByEdge++;
        cnt.delete();
        continue;
      }

      stats.candidateCount++;
      candidates.push(scoreCandidate(ordered, area, frameArea));
      cnt.delete();
    }

    // ── Select highest-scoring candidate ────────────────────────────────────
    let selectedPts: [Point, Point, Point, Point] | null = null;
    let selectedArea   = 0;
    let selectedScore  = 0;
    let usedFallback   = false;

    if (candidates.length > 0) {
      const best  = candidates.reduce((a, b) => a.totalScore > b.totalScore ? a : b);
      selectedPts  = best.pts;
      selectedArea = best.contourArea;
      selectedScore = best.totalScore;
    } else if (fallbacks.length > 0) {
      // ── minAreaRect fallback ──────────────────────────────────────────────
      // Sort largest first; score each and pick the best that passes all gates
      fallbacks.sort((a, b) => b.area - a.area);
      let bestFbScore = -1;
      for (const fb of fallbacks) {
        const rect    = cv.minAreaRect(fb.cnt);
        const raw4    = minAreaRectCorners(rect);
        const ordered = orderCorners(raw4);
        const ratio   = quadAspectRatio(ordered);
        if (!isCardRatio(ratio) && !isCardRatio(1 / ratio)) continue;
        if (touchesEdge(ordered, workW, workH)) continue;

        const sc = scoreCandidate(ordered, fb.area, frameArea);
        if (sc.totalScore > bestFbScore) {
          bestFbScore   = sc.totalScore;
          selectedPts   = ordered;
          selectedArea  = fb.area;
          selectedScore = sc.totalScore;
          usedFallback  = true;
        }
      }
    }

    fallbacks.forEach(f => f.cnt.delete());

    stats.usedFallback = usedFallback;
    stats.bestScore    = selectedPts ? selectedScore : null;

    // ── Return result ───────────────────────────────────────────────────────
    if (selectedPts) {
      // Scale corners back to original video resolution
      const corners = selectedPts.map(p => ({
        x: p.x / scale,
        y: p.y / scale,
      })) as [Point, Point, Point, Point];
      stats.selectedRect = corners;

      // Draw selected quad on the debug rect canvas
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

      // Confidence uses the composite score (already baked into bestScore)
      return { corners, confidence: selectedScore, debugStats: stats };
    }

    if (debugCanvasRect) cv.imshow(debugCanvasRect, src);
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
