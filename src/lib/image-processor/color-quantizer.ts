export const DEFAULT_COLOR_COUNT = 4;
export const MIN_COLOR_COUNT = 2;
export const MAX_COLOR_COUNT = 16;
export const COMPLEX_PHOTO_CLUSTER_THRESHOLD = 64;

const ALPHA_SNAP_THRESHOLD = 128;
// 5 bits per RGB channel -> 32 * 32 * 32 = 32,768 color histogram bins
const HIST_SIZE = 32768;
// Minimum contrast squared distance between opposing neighbors to test AA interpolation
const AA_CONTRAST_SQ = 40 * 40;

export interface ColorQuantizationOptions {
  /** Target solid palette size (2–16, default 8). */
  colorCount?: number;
}

export interface PaletteColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  pixelCount: number;
}

export interface ColorQuantizationResult {
  imageData: ImageData;
  palette: PaletteColor[];
  dominantClusterCount: number;
  isComplexPhoto: boolean;
  opaquePixelCount: number;
  processingTimeMs: number;
}

interface WeightedBin {
  key: number;
  r: number;
  g: number;
  b: number;
  weight: number;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hslToRgb(
  hueDeg: number,
  sat: number,
  light: number,
): [number, number, number] {
  const h = ((hueDeg % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;

  let rp = 0;
  let gp = 0;
  let bp = 0;

  if (h < 60) {
    rp = c;
    gp = x;
  } else if (h < 120) {
    rp = x;
    gp = c;
  } else if (h < 180) {
    gp = c;
    bp = x;
  } else if (h < 240) {
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }

  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

function distSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * Checks whether center pixel C lies monotonically along the RGB segment
 * between opposing high-contrast neighbors A and B (classic anti-aliasing pixel),
 * while preserving 1px solid dark/colored outlines that are extrema.
 */
function isInterpolatedBetween(
  cr: number,
  cg: number,
  cb: number,
  ar: number,
  ag: number,
  ab: number,
  br: number,
  bg: number,
  bb: number,
): boolean {
  const dAB = distSq(ar, ag, ab, br, bg, bb);
  if (dAB <= AA_CONTRAST_SQ) return false;

  const dAC = distSq(ar, ag, ab, cr, cg, cb);
  const dCB = distSq(cr, cg, cb, br, bg, bb);
  return Math.sqrt(dAC) + Math.sqrt(dCB) <= Math.sqrt(dAB) * 1.12;
}

function buildWeightedBins(
  weights: Float64Array,
  sumR: Float64Array,
  sumG: Float64Array,
  sumB: Float64Array,
  counts: Uint32Array,
): WeightedBin[] {
  const bins: WeightedBin[] = [];
  for (let i = 0; i < HIST_SIZE; i++) {
    const count = counts[i];
    const weight = weights[i];
    if (count > 0 && weight > 0) {
      bins.push({
        key: i,
        r: sumR[i] / count,
        g: sumG[i] / count,
        b: sumB[i] / count,
        weight,
      });
    }
  }
  return bins;
}

/**
 * Deterministic weighted K-Means++ over compact RGB histogram bins.
 * Zero Math.random() calls so identical inputs always yield identical palettes.
 */
function runDeterministicKMeans(
  bins: WeightedBin[],
  targetK: number,
): Array<{ r: number; g: number; b: number }> {
  if (bins.length === 0) {
    return [];
  }

  const k = Math.min(targetK, bins.length);
  const centroids: Array<{ r: number; g: number; b: number }> = [];

  // Seed 1: highest-weight bin (deterministic tie-break by smallest bin key)
  let firstBin = bins[0];
  for (let i = 1; i < bins.length; i++) {
    if (
      bins[i].weight > firstBin.weight ||
      (bins[i].weight === firstBin.weight && bins[i].key < firstBin.key)
    ) {
      firstBin = bins[i];
    }
  }
  centroids.push({ r: firstBin.r, g: firstBin.g, b: firstBin.b });

  const minDistSq = new Float64Array(bins.length);
  for (let i = 0; i < bins.length; i++) {
    minDistSq[i] = distSq(
      bins[i].r,
      bins[i].g,
      bins[i].b,
      centroids[0].r,
      centroids[0].g,
      centroids[0].b,
    );
  }

  // Seeds 2..k: deterministic K-Means++ maximizing weight * minDistSq
  for (let c = 1; c < k; c++) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < bins.length; i++) {
      const score = bins[i].weight * minDistSq[i];
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestScore <= 0) {
      break;
    }

    const chosen = bins[bestIdx];
    const nextCentroid = { r: chosen.r, g: chosen.g, b: chosen.b };
    centroids.push(nextCentroid);

    for (let i = 0; i < bins.length; i++) {
      const d = distSq(
        bins[i].r,
        bins[i].g,
        bins[i].b,
        nextCentroid.r,
        nextCentroid.g,
        nextCentroid.b,
      );
      if (d < minDistSq[i]) {
        minDistSq[i] = d;
      }
    }
  }

  // Lloyd refinement iterations on compact bin list
  const actualK = centroids.length;
  const accR = new Float64Array(actualK);
  const accG = new Float64Array(actualK);
  const accB = new Float64Array(actualK);
  const accW = new Float64Array(actualK);

  const MAX_ITERATIONS = 16;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    accR.fill(0);
    accG.fill(0);
    accB.fill(0);
    accW.fill(0);

    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      let nearestIdx = 0;
      let nearestDist = distSq(
        bin.r,
        bin.g,
        bin.b,
        centroids[0].r,
        centroids[0].g,
        centroids[0].b,
      );

      for (let c = 1; c < actualK; c++) {
        const d = distSq(
          bin.r,
          bin.g,
          bin.b,
          centroids[c].r,
          centroids[c].g,
          centroids[c].b,
        );
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = c;
        }
      }

      accR[nearestIdx] += bin.r * bin.weight;
      accG[nearestIdx] += bin.g * bin.weight;
      accB[nearestIdx] += bin.b * bin.weight;
      accW[nearestIdx] += bin.weight;
    }

    let movedSq = 0;
    for (let c = 0; c < actualK; c++) {
      if (accW[c] <= 0) continue;
      const nr = accR[c] / accW[c];
      const ng = accG[c] / accW[c];
      const nb = accB[c] / accW[c];
      movedSq += distSq(nr, ng, nb, centroids[c].r, centroids[c].g, centroids[c].b);
      centroids[c].r = nr;
      centroids[c].g = ng;
      centroids[c].b = nb;
    }

    if (movedSq < 0.25) {
      break;
    }
  }

  // Deduplicate rounded RGB values while preserving order
  const uniqueMap = new Map<number, { r: number; g: number; b: number }>();
  for (const c of centroids) {
    const rr = Math.max(0, Math.min(255, Math.round(c.r)));
    const gg = Math.max(0, Math.min(255, Math.round(c.g)));
    const bb = Math.max(0, Math.min(255, Math.round(c.b)));
    const packed = (rr << 16) | (gg << 8) | bb;
    if (!uniqueMap.has(packed)) {
      uniqueMap.set(packed, { r: rr, g: gg, b: bb });
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Stage 2 (Canva SVG Engine): Alpha Threshold Snapping + Anti-Aliasing Cleanup +
 * Deterministic Color Quantization (2-16 solid colors).
 *
 * Suppresses monotonic 1px anti-aliasing edge transitions during palette discovery
 * and snaps AA transition pixels strictly toward their adjacent solid region colors
 * to eliminate unrelated 3rd-color edge halos.
 */
export function quantizeAndCleanColors(
  source: ImageData,
  options: ColorQuantizationOptions = {},
): ColorQuantizationResult {
  const startTime =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const width = source.width;
  const height = source.height;
  const totalPixels = width * height;
  const srcData = source.data;
  const outputData = new Uint8ClampedArray(srcData);
  const outputImageData = new ImageData(outputData, width, height);

  if (width <= 0 || height <= 0 || totalPixels === 0) {
    return {
      imageData: outputImageData,
      palette: [],
      dominantClusterCount: 0,
      isComplexPhoto: false,
      opaquePixelCount: 0,
      processingTimeMs: 0,
    };
  }

  const targetColors = Math.max(
    MIN_COLOR_COUNT,
    Math.min(
      MAX_COLOR_COUNT,
      Math.round(options.colorCount ?? DEFAULT_COLOR_COUNT),
    ),
  );

  // First pass: crisp alpha threshold snapping (0 or 255)
  let opaquePixelCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    const off = i * 4;
    if (outputData[off + 3] < ALPHA_SNAP_THRESHOLD) {
      outputData[off] = 0;
      outputData[off + 1] = 0;
      outputData[off + 2] = 0;
      outputData[off + 3] = 0;
    } else {
      outputData[off + 3] = 255;
      opaquePixelCount++;
    }
  }

  if (opaquePixelCount === 0) {
    const elapsed =
      (typeof performance !== "undefined" ? performance.now() : Date.now()) -
      startTime;
    return {
      imageData: outputImageData,
      palette: [],
      dominantClusterCount: 0,
      isComplexPhoto: false,
      opaquePixelCount: 0,
      processingTimeMs: Math.round(elapsed * 10) / 10,
    };
  }

  // Second pass: build 5-bit color histogram & flag AA transition pixels
  const allCounts = new Uint32Array(HIST_SIZE);
  const allWeights = new Float64Array(HIST_SIZE);
  const discWeights = new Float64Array(HIST_SIZE);
  const sumR = new Float64Array(HIST_SIZE);
  const sumG = new Float64Array(HIST_SIZE);
  const sumB = new Float64Array(HIST_SIZE);

  // 0 = background or non-AA, 1 = AA transition pixel
  const isAaMask = new Uint8Array(totalPixels);
  const aaIndices: number[] = [];
  let nonAaWeightSum = 0;

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const off = idx * 4;
      if (outputData[off + 3] === 0) continue;

      const r = outputData[off];
      const g = outputData[off + 1];
      const b = outputData[off + 2];

      const binKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      allCounts[binKey]++;
      allWeights[binKey] += 1;
      sumR[binKey] += r;
      sumG[binKey] += g;
      sumB[binKey] += b;

      let isAaTransition = false;

      if (x > 0 && x + 1 < width) {
        const lOff = (idx - 1) * 4;
        const rOff = (idx + 1) * 4;
        if (outputData[lOff + 3] > 0 && outputData[rOff + 3] > 0) {
          if (
            isInterpolatedBetween(
              r,
              g,
              b,
              outputData[lOff],
              outputData[lOff + 1],
              outputData[lOff + 2],
              outputData[rOff],
              outputData[rOff + 1],
              outputData[rOff + 2],
            )
          ) {
            isAaTransition = true;
          }
        }
      }

      if (!isAaTransition && y > 0 && y + 1 < height) {
        const tOff = (idx - width) * 4;
        const bOff = (idx + width) * 4;
        if (outputData[tOff + 3] > 0 && outputData[bOff + 3] > 0) {
          if (
            isInterpolatedBetween(
              r,
              g,
              b,
              outputData[tOff],
              outputData[tOff + 1],
              outputData[tOff + 2],
              outputData[bOff],
              outputData[bOff + 1],
              outputData[bOff + 2],
            )
          ) {
            isAaTransition = true;
          }
        }
      }

      if (isAaTransition) {
        isAaMask[idx] = 1;
        aaIndices.push(idx);
        discWeights[binKey] += 0.05;
      } else {
        discWeights[binKey] += 1;
        nonAaWeightSum += 1;
      }
    }
  }

  // Count significant dominant 5-bit color clusters to distinguish 2D art vs photos
  const dominantThreshold = Math.max(4, Math.floor(opaquePixelCount * 0.0002));
  let dominantClusterCount = 0;
  for (let i = 0; i < HIST_SIZE; i++) {
    if (allCounts[i] >= dominantThreshold) {
      dominantClusterCount++;
    }
  }
  const isComplexPhoto =
    dominantClusterCount > COMPLEX_PHOTO_CLUSTER_THRESHOLD;

  const useFilteredBins = nonAaWeightSum >= opaquePixelCount * 0.05;
  const discoveryBins = buildWeightedBins(
    useFilteredBins ? discWeights : allWeights,
    sumR,
    sumG,
    sumB,
    allCounts,
  );

  const centroids = runDeterministicKMeans(discoveryBins, targetColors);
  const k = centroids.length;

  const palR = new Uint8Array(k);
  const palG = new Uint8Array(k);
  const palB = new Uint8Array(k);
  const palCounts = new Uint32Array(k);

  for (let c = 0; c < k; c++) {
    palR[c] = centroids[c].r;
    palG[c] = centroids[c].g;
    palB[c] = centroids[c].b;
  }

  // Track palette index per pixel (-1 = unresolved/transparent)
  const assignedPalIdx = new Int16Array(totalPixels);
  assignedPalIdx.fill(-1);

  if (k > 0) {
    // Pass 3a: Snap non-AA solid pixels to nearest global palette color
    for (let i = 0; i < totalPixels; i++) {
      const off = i * 4;
      if (outputData[off + 3] === 0 || isAaMask[i] === 1) continue;

      const r = srcData[off];
      const g = srcData[off + 1];
      const b = srcData[off + 2];

      let bestIdx = 0;
      let bestDist = distSq(r, g, b, palR[0], palG[0], palB[0]);

      for (let c = 1; c < k; c++) {
        const d = distSq(r, g, b, palR[c], palG[c], palB[c]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }

      outputData[off] = palR[bestIdx];
      outputData[off + 1] = palG[bestIdx];
      outputData[off + 2] = palB[bestIdx];
      assignedPalIdx[i] = bestIdx;
      palCounts[bestIdx]++;
    }

    // Pass 3b: Snap AA edge transition pixels strictly toward adjacent resolved neighbors
    // (2 sweeps handles 2px-wide AA bands; remaining isolated pixels fall back to global palette)
    let pendingAa = aaIndices;
    for (let sweep = 0; sweep < 2 && pendingAa.length > 0; sweep++) {
      const nextPending: number[] = [];
      const resolvedInSweep: Array<{ idx: number; palIdx: number }> = [];

      for (let p = 0; p < pendingAa.length; p++) {
        const idx = pendingAa[p];
        const x = idx % width;
        const y = (idx - x) / width;
        const off = idx * 4;
        const sr = srcData[off];
        const sg = srcData[off + 1];
        const sb = srcData[off + 2];

        let bestPalIdx = -1;
        let bestDist = Infinity;

        if (x > 0) {
          const nPal = assignedPalIdx[idx - 1];
          if (nPal >= 0) {
            const d = distSq(sr, sg, sb, palR[nPal], palG[nPal], palB[nPal]);
            if (d < bestDist) {
              bestDist = d;
              bestPalIdx = nPal;
            }
          }
        }
        if (x + 1 < width) {
          const nPal = assignedPalIdx[idx + 1];
          if (nPal >= 0) {
            const d = distSq(sr, sg, sb, palR[nPal], palG[nPal], palB[nPal]);
            if (d < bestDist) {
              bestDist = d;
              bestPalIdx = nPal;
            }
          }
        }
        if (y > 0) {
          const nPal = assignedPalIdx[idx - width];
          if (nPal >= 0) {
            const d = distSq(sr, sg, sb, palR[nPal], palG[nPal], palB[nPal]);
            if (d < bestDist) {
              bestDist = d;
              bestPalIdx = nPal;
            }
          }
        }
        if (y + 1 < height) {
          const nPal = assignedPalIdx[idx + width];
          if (nPal >= 0) {
            const d = distSq(sr, sg, sb, palR[nPal], palG[nPal], palB[nPal]);
            if (d < bestDist) {
              bestDist = d;
              bestPalIdx = nPal;
            }
          }
        }

        if (bestPalIdx >= 0) {
          resolvedInSweep.push({ idx, palIdx: bestPalIdx });
        } else {
          nextPending.push(idx);
        }
      }

      for (const item of resolvedInSweep) {
        const off = item.idx * 4;
        outputData[off] = palR[item.palIdx];
        outputData[off + 1] = palG[item.palIdx];
        outputData[off + 2] = palB[item.palIdx];
        assignedPalIdx[item.idx] = item.palIdx;
        palCounts[item.palIdx]++;
      }

      pendingAa = nextPending;
    }

    // Fallback for any remaining unresolved AA pixels
    for (const idx of pendingAa) {
      const off = idx * 4;
      const sr = srcData[off];
      const sg = srcData[off + 1];
      const sb = srcData[off + 2];

      let bestIdx = 0;
      let bestDist = distSq(sr, sg, sb, palR[0], palG[0], palB[0]);
      for (let c = 1; c < k; c++) {
        const d = distSq(sr, sg, sb, palR[c], palG[c], palB[c]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }

      outputData[off] = palR[bestIdx];
      outputData[off + 1] = palG[bestIdx];
      outputData[off + 2] = palB[bestIdx];
      assignedPalIdx[idx] = bestIdx;
      palCounts[bestIdx]++;
    }
  }

  const palette: PaletteColor[] = [];
  for (let c = 0; c < k; c++) {
    if (palCounts[c] === 0) continue;
    palette.push({
      hex: rgbToHex(palR[c], palG[c], palB[c]),
      r: palR[c],
      g: palG[c],
      b: palB[c],
      pixelCount: palCounts[c],
    });
  }
  palette.sort((a, b) => b.pixelCount - a.pixelCount);

  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) -
    startTime;

  return {
    imageData: outputImageData,
    palette,
    dominantClusterCount,
    isComplexPhoto,
    opaquePixelCount,
    processingTimeMs: Math.round(elapsed * 10) / 10,
  };
}
