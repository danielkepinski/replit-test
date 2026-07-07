/**
 * DCT-based perceptual hash (pHash).
 * Standard implementation: compute 2D DCT on a 32x32 grayscale image,
 * take the top-left 8x8 block of AC coefficients (excluding DC at [0,0]),
 * compare each against the median to produce a 63-bit hash.
 * Excluding DC reduces sensitivity to overall brightness/exposure changes.
 */
export function computePHash(imageData: ImageData): bigint {
  const size = 32;
  const data = imageData.data;
  const pixels = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) {
    // imageData is already grayscale (R=G=B); read the R channel
    pixels[i] = data[i * 4];
  }

  // 2D DCT-II by separability: rows first, then columns
  const dctRows = new Float64Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let u = 0; u < size; u++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        sum += pixels[r * size + x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
      }
      dctRows[r * size + u] = sum * (u === 0 ? 1 / Math.sqrt(2) : 1);
    }
  }

  const dct = new Float64Array(size * size);
  for (let c = 0; c < size; c++) {
    for (let v = 0; v < size; v++) {
      let sum = 0;
      for (let y = 0; y < size; y++) {
        sum += dctRows[y * size + c] * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
      }
      dct[v * size + c] = sum * (v === 0 ? 1 / Math.sqrt(2) : 1);
    }
  }

  // Collect top-left 8x8, but SKIP the DC component at [0,0] (index 0)
  // DC encodes overall brightness and hurts match stability across exposures
  const acCoeffs: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (y === 0 && x === 0) continue; // skip DC
      acCoeffs.push(dct[y * size + x]);
    }
  }
  // acCoeffs.length === 63

  const sorted = [...acCoeffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hash = 0n;
  for (let i = 0; i < acCoeffs.length; i++) {
    if (acCoeffs[i] > median) {
      hash |= (1n << BigInt(i));
    }
  }
  return hash;
}

export function hammingDistance(h1: bigint, h2: bigint): number {
  let x = h1 ^ h2;
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}
