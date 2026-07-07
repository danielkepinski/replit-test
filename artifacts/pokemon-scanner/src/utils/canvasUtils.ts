export async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function imageToGrayscale32x32(img: HTMLImageElement | HTMLCanvasElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 32, 32);
  const imgData = ctx.getImageData(0, 0, 32, 32);
  
  for (let i = 0; i < imgData.data.length; i += 4) {
    const r = imgData.data[i];
    const g = imgData.data[i + 1];
    const b = imgData.data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    imgData.data[i] = gray;
    imgData.data[i + 1] = gray;
    imgData.data[i + 2] = gray;
  }
  return imgData;
}
