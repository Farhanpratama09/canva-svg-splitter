import { hslToRgb, rgbToHex } from "./color-quantizer";

export const DEFAULT_MIN_REGION_AREA = 4;

export interface RegionBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface RegionInfo {
  regionId: number;
  originalHex: string;
  r: number;
  g: number;
  b: number;
  assignedGroupId: string;
  pixelCount: number;
  boundingBox: RegionBoundingBox;
  centroid: {
    x: number;
    y: number;
  };
}

export interface RegionSegmentationOptions {
  /** Regions strictly smaller than this pixel count are absorbed as noise (default 4). */
  minArea?: number;
}

export interface RegionSegmentationResult {
  imageData: ImageData;
  /** Length = width * height. Value 0 = transparent background, 1..N = regionId. */
  regionMap: Int32Array;
  width: number;
  height: number;
  regions: RegionInfo[];
  absorbedSpeckleCount: number;
  processingTimeMs: number;
}

interface RawRegionStats {
  id: number;
  r: number;
  g: number;
  b: number;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
}

function resolveRoot(redirect: Int32Array, id: number): number {
  let curr = id;
  while (curr > 0 && redirect[curr] !== 0) {
    if (redirect[curr] < 0) {
      return -1;
    }
    curr = redirect[curr];
  }
  return curr;
}

/**
 * Stage 3 (Canva SVG Engine): 4-way Connected-Component Labeling (CCL)
 * using Int32Array BFS queue + automatic speckle removal (< minArea pixels).
 * Produces unique regionIds even for spatially separated regions of identical color.
 */
export function segmentRegions(
  source: ImageData,
  options: RegionSegmentationOptions = {},
): RegionSegmentationResult {
  const startTime =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const width = source.width;
  const height = source.height;
  const totalPixels = width * height;
  const outputData = new Uint8ClampedArray(source.data);
  const outputImageData = new ImageData(outputData, width, height);
  const regionMap = new Int32Array(totalPixels);

  if (width <= 0 || height <= 0 || totalPixels === 0) {
    return {
      imageData: outputImageData,
      regionMap,
      width,
      height,
      regions: [],
      absorbedSpeckleCount: 0,
      processingTimeMs: 0,
    };
  }

  const minArea = Math.max(1, Math.round(options.minArea ?? DEFAULT_MIN_REGION_AREA));
  const queue = new Int32Array(totalPixels);
  const rawRegions: RawRegionStats[] = [];

  let nextRegionId = 0;

  // Pass 1: 4-way BFS Connected-Component Labeling
  for (let startIdx = 0; startIdx < totalPixels; startIdx++) {
    if (regionMap[startIdx] !== 0) continue;

    const startOff = startIdx * 4;
    if (outputData[startOff + 3] === 0) continue;

    const r = outputData[startOff];
    const g = outputData[startOff + 1];
    const b = outputData[startOff + 2];

    const regionId = ++nextRegionId;
    regionMap[startIdx] = regionId;

    let head = 0;
    let tail = 0;
    queue[tail++] = startIdx;

    let pixelCount = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;

      pixelCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;

      if (x > 0) {
        const left = idx - 1;
        if (regionMap[left] === 0) {
          const nOff = left * 4;
          if (
            outputData[nOff + 3] > 0 &&
            outputData[nOff] === r &&
            outputData[nOff + 1] === g &&
            outputData[nOff + 2] === b
          ) {
            regionMap[left] = regionId;
            queue[tail++] = left;
          }
        }
      }

      if (x + 1 < width) {
        const right = idx + 1;
        if (regionMap[right] === 0) {
          const nOff = right * 4;
          if (
            outputData[nOff + 3] > 0 &&
            outputData[nOff] === r &&
            outputData[nOff + 1] === g &&
            outputData[nOff + 2] === b
          ) {
            regionMap[right] = regionId;
            queue[tail++] = right;
          }
        }
      }

      if (y > 0) {
        const up = idx - width;
        if (regionMap[up] === 0) {
          const nOff = up * 4;
          if (
            outputData[nOff + 3] > 0 &&
            outputData[nOff] === r &&
            outputData[nOff + 1] === g &&
            outputData[nOff + 2] === b
          ) {
            regionMap[up] = regionId;
            queue[tail++] = up;
          }
        }
      }

      if (y + 1 < height) {
        const down = idx + width;
        if (regionMap[down] === 0) {
          const nOff = down * 4;
          if (
            outputData[nOff + 3] > 0 &&
            outputData[nOff] === r &&
            outputData[nOff + 1] === g &&
            outputData[nOff + 2] === b
          ) {
            regionMap[down] = regionId;
            queue[tail++] = down;
          }
        }
      }
    }

    rawRegions.push({
      id: regionId,
      r,
      g,
      b,
      pixelCount,
      minX,
      minY,
      maxX,
      maxY,
      sumX,
      sumY,
    });
  }

  // Pass 2: Speckle removal (< minArea pixels merged into largest non-transparent neighbor)
  const redirect = new Int32Array(rawRegions.length + 1);
  let absorbedSpeckleCount = 0;

  const tinyRegions = rawRegions
    .filter((reg) => reg.pixelCount < minArea)
    .sort((a, b) => a.pixelCount - b.pixelCount || a.id - b.id);

  if (tinyRegions.length > 0) {
    // Up to 2 passes handles chained tiny speckles cleanly
    for (let pass = 0; pass < 2; pass++) {
      let mergedAny = false;

      for (const tiny of tinyRegions) {
        if (redirect[tiny.id] !== 0) continue;

        const currentRoot = resolveRoot(redirect, tiny.id);
        if (currentRoot <= 0) continue;

        const currentStats = rawRegions[currentRoot - 1];
        if (currentStats.pixelCount >= minArea) continue;

        let bestNeighborRoot = 0;
        let bestNeighborCount = -1;

        for (let y = tiny.minY; y <= tiny.maxY; y++) {
          const rowBase = y * width;
          for (let x = tiny.minX; x <= tiny.maxX; x++) {
            const idx = rowBase + x;
            if (resolveRoot(redirect, regionMap[idx]) !== currentRoot) continue;

            const neighbors: number[] = [];
            if (x > 0) neighbors.push(regionMap[idx - 1]);
            if (x + 1 < width) neighbors.push(regionMap[idx + 1]);
            if (y > 0) neighbors.push(regionMap[idx - width]);
            if (y + 1 < height) neighbors.push(regionMap[idx + width]);

            for (const rawNeighbor of neighbors) {
              if (rawNeighbor === 0) continue;
              const neighborRoot = resolveRoot(redirect, rawNeighbor);
              if (neighborRoot <= 0 || neighborRoot === currentRoot) continue;

              const nStats = rawRegions[neighborRoot - 1];
              if (
                nStats.pixelCount > bestNeighborCount ||
                (nStats.pixelCount === bestNeighborCount &&
                  neighborRoot < bestNeighborRoot)
              ) {
                bestNeighborCount = nStats.pixelCount;
                bestNeighborRoot = neighborRoot;
              }
            }
          }
        }

        if (bestNeighborRoot > 0) {
          redirect[currentRoot] = bestNeighborRoot;
          const target = rawRegions[bestNeighborRoot - 1];
          target.pixelCount += currentStats.pixelCount;
          if (currentStats.minX < target.minX) target.minX = currentStats.minX;
          if (currentStats.minY < target.minY) target.minY = currentStats.minY;
          if (currentStats.maxX > target.maxX) target.maxX = currentStats.maxX;
          if (currentStats.maxY > target.maxY) target.maxY = currentStats.maxY;
          absorbedSpeckleCount++;
          mergedAny = true;
        } else if (pass === 1) {
          // Isolated dust pixel with zero non-transparent neighbors -> clear to transparent
          redirect[currentRoot] = -1;
          absorbedSpeckleCount++;
        }
      }

      if (!mergedAny && pass === 0) {
        // Still run second pass only if isolated regions remain to be cleared
        const hasIsolated = tinyRegions.some((t) => redirect[t.id] === 0);
        if (!hasIsolated) break;
      }
    }
  }

  // Pass 3: Compact surviving region IDs to contiguous 1..M & synchronize pixel colors + stats
  const compactMap = new Int32Array(rawRegions.length + 1);
  const compactStats: RawRegionStats[] = [];

  for (const reg of rawRegions) {
    if (redirect[reg.id] !== 0) continue;
    const compactId = compactStats.length + 1;
    compactMap[reg.id] = compactId;
    compactStats.push({
      id: compactId,
      r: reg.r,
      g: reg.g,
      b: reg.b,
      pixelCount: 0,
      minX: width,
      minY: height,
      maxX: -1,
      maxY: -1,
      sumX: 0,
      sumY: 0,
    });
  }

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const rawId = regionMap[idx];
      if (rawId === 0) continue;

      const rootId = resolveRoot(redirect, rawId);
      if (rootId <= 0) {
        regionMap[idx] = 0;
        const off = idx * 4;
        outputData[off] = 0;
        outputData[off + 1] = 0;
        outputData[off + 2] = 0;
        outputData[off + 3] = 0;
        continue;
      }

      const finalId = compactMap[rootId];
      regionMap[idx] = finalId;

      const stats = compactStats[finalId - 1];
      stats.pixelCount++;
      if (x < stats.minX) stats.minX = x;
      if (x > stats.maxX) stats.maxX = x;
      if (y < stats.minY) stats.minY = y;
      if (y > stats.maxY) stats.maxY = y;
      stats.sumX += x;
      stats.sumY += y;

      // Ensure absorbed speckles adopt the target region's exact solid RGB color
      if (rawId !== rootId) {
        const off = idx * 4;
        outputData[off] = stats.r;
        outputData[off + 1] = stats.g;
        outputData[off + 2] = stats.b;
        outputData[off + 3] = 255;
      }
    }
  }

  const regions: RegionInfo[] = compactStats.map((stats) => {
    const hex = rgbToHex(stats.r, stats.g, stats.b);
    return {
      regionId: stats.id,
      originalHex: hex,
      r: stats.r,
      g: stats.g,
      b: stats.b,
      assignedGroupId: `color-${hex.slice(1)}`,
      pixelCount: stats.pixelCount,
      boundingBox: {
        minX: stats.minX,
        minY: stats.minY,
        maxX: stats.maxX,
        maxY: stats.maxY,
        width: stats.maxX - stats.minX + 1,
        height: stats.maxY - stats.minY + 1,
      },
      centroid: {
        x: Math.round(stats.sumX / Math.max(1, stats.pixelCount)),
        y: Math.round(stats.sumY / Math.max(1, stats.pixelCount)),
      },
    };
  });

  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) -
    startTime;

  return {
    imageData: outputImageData,
    regionMap,
    width,
    height,
    regions,
    absorbedSpeckleCount,
    processingTimeMs: Math.round(elapsed * 10) / 10,
  };
}

/**
 * Generates a high-contrast false-color Region Map ImageData with crisp 1px
 * boundary edges so users can visually inspect separated CCL regions.
 */
export function createRegionMapImageData(
  regionMap: Int32Array,
  width: number,
  height: number,
  regionCount: number,
): ImageData {
  const totalPixels = width * height;
  const previewData = new Uint8ClampedArray(totalPixels * 4);

  if (width <= 0 || height <= 0 || totalPixels === 0 || regionCount <= 0) {
    return new ImageData(previewData, Math.max(1, width), Math.max(1, height));
  }

  // Precompute distinct golden-angle hues per regionId
  const colorR = new Uint8Array(regionCount + 1);
  const colorG = new Uint8Array(regionCount + 1);
  const colorB = new Uint8Array(regionCount + 1);

  for (let id = 1; id <= regionCount; id++) {
    const hue = (id * 137.508) % 360;
    const lightness = id % 2 === 0 ? 0.56 : 0.64;
    const [r, g, b] = hslToRgb(hue, 0.78, lightness);
    colorR[id] = r;
    colorG[id] = g;
    colorB[id] = b;
  }

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const id = regionMap[idx];
      if (id <= 0 || id > regionCount) continue;

      const isBoundary =
        x === 0 ||
        y === 0 ||
        x + 1 === width ||
        y + 1 === height ||
        regionMap[idx - 1] !== id ||
        regionMap[idx + 1] !== id ||
        regionMap[idx - width] !== id ||
        regionMap[idx + width] !== id;

      const off = idx * 4;
      if (isBoundary) {
        // Dark crisp boundary outline around each segmented region
        previewData[off] = Math.round(colorR[id] * 0.28);
        previewData[off + 1] = Math.round(colorG[id] * 0.28);
        previewData[off + 2] = Math.round(colorB[id] * 0.28);
        previewData[off + 3] = 255;
      } else {
        previewData[off] = colorR[id];
        previewData[off + 1] = colorG[id];
        previewData[off + 2] = colorB[id];
        previewData[off + 3] = 255;
      }
    }
  }

  return new ImageData(previewData, width, height);
}
