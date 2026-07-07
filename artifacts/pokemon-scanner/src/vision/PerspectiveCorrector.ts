import { Point } from './CardDetector';

export function correctPerspective(
  video: HTMLVideoElement,
  corners: Point[],
  debugCanvasCrop?: HTMLCanvasElement
): ImageData {
  const cv = (window as any).cv;

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(video, 0, 0);

  let src: any, dst: any, srcTri: any, dstTri: any, M: any;
  try {
    src = cv.imread(canvas);
    dst = new cv.Mat();

    // corners are ordered [TL, TR, BR, BL] by CardDetector.orderCorners
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      corners[0].x, corners[0].y,  // TL
      corners[1].x, corners[1].y,  // TR
      corners[2].x, corners[2].y,  // BR
      corners[3].x, corners[3].y,  // BL
    ]);

    const w = 400;
    const h = 560;
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,   // TL
      w, 0,   // TR
      w, h,   // BR
      0, h,   // BL
    ]);

    M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, dst, M, new cv.Size(w, h));

    if (debugCanvasCrop) {
      cv.imshow(debugCanvasCrop, dst);
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width  = w;
    outCanvas.height = h;
    cv.imshow(outCanvas, dst);

    return outCanvas.getContext('2d')!.getImageData(0, 0, w, h);
  } finally {
    src?.delete();
    dst?.delete();
    srcTri?.delete();
    dstTri?.delete();
    M?.delete();
  }
}
