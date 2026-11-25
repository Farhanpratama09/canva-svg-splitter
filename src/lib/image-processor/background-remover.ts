export const DEFAULT_BG_TOLERANCE = 25;
export const MIN_BG_TOLERANCE = 0;
export const MAX_BG_TOLERANCE = 50;

export interface BackgroundRemovalOptions {
  /** Euclidean RGB distance tolerance (0–50, default 25). */
  tolerance?: number;
}

export interface BackgroundRemovalResult {
  imageData: ImageData;
  removedPixelCount: number;
  totalPixelCount: number;
  removedPercentage: number;
  detectedBackgroundHex: string | null;
  alreadyTransparent: boolean;
  processingTimeMs: number;
}

interface CornerSample {
  x: number;
  y: number;
  index: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colorDistanceSq(
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
 * Selects the dominant opaque background color across the 4 canvas corners
 * and returns the corner pixel indices matching that dominant background.
 */
function selectDominantCornerSeeds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): {
  seeds: number[];
  refR: number;
  refG: number;
  refB: number;
} | null {
  const rawCoords: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  const seenIndices = new Set<number>();
  const opaqueCorners: CornerSample[] = [];

  for (const [x, y] of rawCoords) {
    const index = y * width + x;
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);

    const offset = index * 4;
    const a = data[offset + 3];
    if (a > 10) {
      opaqueCorners.push({
        x,
        y,
        index,
        r: data[offset],
        g: data[offset + 1],
        b: data[offset + 2],
        a,
      });
    }
  }

  if (opaqueCorners.length === 0) {
    return null;
  }

  // Group corners that agree within a small clustering threshold to handle slight JPEG noise.
  const clusterThresholdSq = Math.pow(Math.max(tolerance, 14), 2);
  let bestCluster: CornerSample[] = [opaqueCorners[0]];

  for (const anchor of opaqueCorners) {
    const cluster = opaqueCorners.filter(
      (candidate) =>
        colorDistanceSq(
          anchor.r,
          anchor.g,
          anchor.b,
          candidate.r,
          candidate.g,
          candidate.b,
        ) <= clusterThresholdSq,
    );
    if (cluster.length > bestCluster.length) {
      bestCluster = cluster;
    }
  }

  // Filter exact-tolerance peers around the cluster anchor so tolerance=0 remains exact.
  const anchor = bestCluster[0];
  const strictThresholdSq = tolerance * tolerance;
  const strictCluster = bestCluster.filter(
    (c) =>
      colorDistanceSq(anchor.r, anchor.g, anchor.b, c.r, c.g, c.b) <=
      strictThresholdSq,
  );
  const finalGroup = strictCluster.length > 0 ? strictCluster : [anchor];

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const corner of finalGroup) {
    sumR += corner.r;
    sumG += corner.g;
    sumB += corner.b;
  }

  return {
    seeds: finalGroup.map((c) => c.index),
    refR: Math.round(sumR / finalGroup.length),
    refG: Math.round(sumG / finalGroup.length),
    refB: Math.round(sumB / finalGroup.length),
  };
}

/**
 * Stage 1 (Canva SVG Engine): Corner Flood-Fill Background Removal.
 * Reads the 4 corner pixels, runs a 4-way BFS flood fill using typed arrays
 * within the Euclidean RGB tolerance, and clears exterior background pixels
 * without crossing solid white die-cut borders or character outlines.
 */
export function removeCornerBackground(
  source: ImageData,
  options: BackgroundRemovalOptions = {},
): BackgroundRemovalResult {
  const startTime =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const width = source.width;
  const height = source.height;
  const totalPixels = width * height;
  const outputData = new Uint8ClampedArray(source.data);
  const cloned = new ImageData(outputData, width, height);

  if (width <= 0 || height <= 0 || totalPixels === 0) {
    return {
      imageData: cloned,
      removedPixelCount: 0,
      totalPixelCount: 0,
      removedPercentage: 0,
      detectedBackgroundHex: null,
      alreadyTransparent: true,
      processingTimeMs: 0,
    };
  }

  const tolerance = Math.max(
    MIN_BG_TOLERANCE,
    Math.min(MAX_BG_TOLERANCE, options.tolerance ?? DEFAULT_BG_TOLERANCE),
  );

  const cornerSelection = selectDominantCornerSeeds(
    outputData,
    width,
    height,
    tolerance,
  );

  if (!cornerSelection) {
    const elapsed =
      (typeof performance !== "undefined" ? performance.now() : Date.now()) -
      startTime;
    return {
      imageData: cloned,
      removedPixelCount: 0,
      totalPixelCount: totalPixels,
      removedPercentage: 0,
      detectedBackgroundHex: null,
      alreadyTransparent: true,
      processingTimeMs: Math.round(elapsed * 10) / 10,
    };
  }

  const { seeds, refR, refG, refB } = cornerSelection;
  const maxDistSq = tolerance * tolerance;
  const detectedBackgroundHex = rgbToHex(refR, refG, refB);

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let head = 0;
  let tail = 0;
  let removedPixelCount = 0;

  for (const seedIndex of seeds) {
    if (visited[seedIndex] === 0) {
      visited[seedIndex] = 1;
      queue[tail++] = seedIndex;
    }
  }

  while (head < tail) {
    const pixelIndex = queue[head++];
    const offset = pixelIndex * 4;
    const alpha = outputData[offset + 3];

    if (alpha <= 10) {
      continue;
    }

    const r = outputData[offset];
    const g = outputData[offset + 1];
    const b = outputData[offset + 2];

    if (colorDistanceSq(r, g, b, refR, refG, refB) > maxDistSq) {
      continue;
    }

    // Clear RGB and Alpha to prevent premultiplied color fringing.
    outputData[offset] = 0;
    outputData[offset + 1] = 0;
    outputData[offset + 2] = 0;
    outputData[offset + 3] = 0;
    removedPixelCount++;

    const x = pixelIndex % width;
    const y = (pixelIndex - x) / width;

    if (x > 0) {
      const left = pixelIndex - 1;
      if (visited[left] === 0) {
        visited[left] = 1;
        queue[tail++] = left;
      }
    }
    if (x + 1 < width) {
      const right = pixelIndex + 1;
      if (visited[right] === 0) {
        visited[right] = 1;
        queue[tail++] = right;
      }
    }
    if (y > 0) {
      const up = pixelIndex - width;
      if (visited[up] === 0) {
        visited[up] = 1;
        queue[tail++] = up;
      }
    }
    if (y + 1 < height) {
      const down = pixelIndex + width;
      if (visited[down] === 0) {
        visited[down] = 1;
        queue[tail++] = down;
      }
    }
  }

  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) -
    startTime;

  return {
    imageData: cloned,
    removedPixelCount,
    totalPixelCount: totalPixels,
    removedPercentage: Math.round((removedPixelCount / totalPixels) * 1000) / 10,
    detectedBackgroundHex,
    alreadyTransparent: false,
    processingTimeMs: Math.round(elapsed * 10) / 10,
  };
}
