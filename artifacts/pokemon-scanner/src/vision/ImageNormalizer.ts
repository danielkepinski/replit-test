export function normalizeImage(imageData: ImageData): ImageData {
  const cv = (window as any).cv;

  const canvas = document.createElement('canvas');
  canvas.width  = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')!.putImageData(imageData, 0, 0);

  let src: any, gray: any, clahe: any, dst: any, norm: any, resized: any;
  try {
    src  = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    dst   = new cv.Mat();
    clahe.apply(gray, dst);

    norm = new cv.Mat();
    cv.normalize(dst, norm, 0, 255, cv.NORM_MINMAX, cv.CV_8UC1);

    resized = new cv.Mat();
    cv.resize(norm, resized, new cv.Size(400, 560));

    const outCanvas = document.createElement('canvas');
    outCanvas.width  = 400;
    outCanvas.height = 560;
    cv.imshow(outCanvas, resized);

    return outCanvas.getContext('2d')!.getImageData(0, 0, 400, 560);
  } finally {
    src?.delete();
    gray?.delete();
    clahe?.delete();
    dst?.delete();
    norm?.delete();
    resized?.delete();
  }
}
