import { hslToRgb, rgbToHex } from "./color-quantizer";
import { hexToRgb, normalizeHexColor, rgbToHsl } from "./region-grouper";

export const MIN_3D_TOLERANCE = 5;
export const MAX_3D_TOLERANCE = 60;
export const DEFAULT_3D_TOLERANCE = 26;
export const MIN_3D_SHADOW_REACH = 0;
export const MAX_3D_SHADOW_REACH = 100;
export const DEFAULT_3D_SHADOW_REACH = 45;
export const DEFAULT_3D_BRUSH_RADIUS = 16;
export const DEFAULT_3D_MAX_HISTORY_STEPS = 25;
export const BRUSH_RADIUS_PRESETS = [6, 14, 24, 38] as const;

const DEFAULT_3D_GROUP_NAME_REGEX = /^Area \d+$/;
const ALPHA_VISIBLE_THRESHOLD = 4;
const NEUTRAL_SAT_THRESHOLD = 0.16;

export type Recolor3DTool = "select" | "brush" | "eraser" | "eyedropper";
export type BrushMode3D = "smart" | "manual";
export type SelectionOpMode = "new" | "add" | "subtract";
export type Recolor3DSelectionKind = "flood" | "global" | "brush";
export type Recolor3DPreviewMode = "live" | "solid" | "region-map";

const NEIGHBOR_4_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export interface Prepared3DImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  hue: Float32Array;
  hsvSat: Float32Array;
  hsvVal: Float32Array;
  hslSat: Float32Array;
  hslLight: Float32Array;
  chroma: Float32Array;
  lum: Float32Array;
  edgeMag: Float32Array;
}

export interface Recolor3DGroup {
  groupId: string;
  name: string;
  targetHex: string;
  r: number;
  g: number;
  b: number;
  seedHex: string;
  pixelCount: number;
  tolerance: number;
  shadowReach: number;
  /** Soft coverage mask in [0, 255] (0 = outside, 255 = full, 1..254 = feathered transition). */
  mask: Uint8Array;
  lastSeedIndex: number | null;
  seedIndices: number[];
  selectionKind: Recolor3DSelectionKind;
  isNeutral: boolean;
}

export interface Recolor3DState {
  width: number;
  height: number;
  groups: Recolor3DGroup[];
  /** Length = width * height. Value 0 = original unmasked, >0 = owning maskId. */
  maskMap: Int32Array;
  /** Length = width * height. Soft alpha matte coverage 0..255 for the maskMap owner. */
  coverageMap: Uint8Array;
  groupToMaskId: Record<string, number>;
  nextGroupSeq: number;
  nextMaskId: number;
}

export interface CandidateSelection3D {
  candidateId: number;
  kind: "flood" | "group";
  seedX: number;
  seedY: number;
  seedIndex: number;
  seedHex: string;
  tolerance: number;
  shadowReach: number;
  isNeutral: boolean;
  pixelCount: number;
  /** Non-empty when kind === "flood". */
  pixelIndices: Int32Array;
  /** Aligned soft coverage [1..255] per pixel in pixelIndices. */
  pixelCoverages: Uint8Array;
  /** Non-null when kind === "group". */
  existingGroupId: string | null;
}

export interface Recolor3DHistory {
  past: Recolor3DState[];
  present: Recolor3DState;
  future: Recolor3DState[];
  maxSteps: number;
  lastCoalesceKey?: string;
  lastCoalesceAt?: number;
}

export interface Point2D {
  x: number;
  y: number;
}

function clampTolerance(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_3D_TOLERANCE;
  return Math.max(
    MIN_3D_TOLERANCE,
    Math.min(MAX_3D_TOLERANCE, Math.round(value)),
  );
}

function clampShadowReach(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_3D_SHADOW_REACH;
  }
  return Math.max(
    MIN_3D_SHADOW_REACH,
    Math.min(MAX_3D_SHADOW_REACH, Math.round(value)),
  );
}

/**
 * Rec.601 perceptual luminance in [0, 1].
 */
export function computePerceptualLuminance(
  r: number,
  g: number,
  b: number,
): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function clipNormalizedRgb(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);

  if (n < 0) {
    const denom = Math.max(1e-6, l - n);
    r = l + ((r - l) * l) / denom;
    g = l + ((g - l) * l) / denom;
    b = l + ((b - l) * l) / denom;
  }
  if (x > 1) {
    const denom = Math.max(1e-6, x - l);
    r = l + ((r - l) * (1 - l)) / denom;
    g = l + ((g - l) * (1 - l)) / denom;
    b = l + ((b - l) * (1 - l)) / denom;
  }

  return [
    Math.max(0, Math.min(255, Math.round(r * 255))),
    Math.max(0, Math.min(255, Math.round(g * 255))),
    Math.max(0, Math.min(255, Math.round(b * 255))),
  ];
}

function setPerceptualLuminance(
  baseR: number,
  baseG: number,
  baseB: number,
  targetLum: number,
): [number, number, number] {
  const r = baseR / 255;
  const g = baseG / 255;
  const b = baseB / 255;
  const currentLum = 0.299 * r + 0.587 * g + 0.114 * b;
  const delta = targetLum - currentLum;
  return clipNormalizedRgb(r + delta, g + delta, b + delta);
}

/**
 * Luminance-Preserving Recolor core:
 * - Colored 3D areas: replaces Hue & Saturation with target color while
 *   keeping original perceptual luminance (specular shine & deep shadows) intact.
 * - Neutral white/gray/black 3D areas: applies Luminance-Preserving Tint / Multiply
 *   so white clay/ceramic surfaces can be tinted pastel/pop colors without erasing 3D shading.
 */
export function computeLuminancePreservingRgb(
  srcR: number,
  srcG: number,
  srcB: number,
  tgtR: number,
  tgtG: number,
  tgtB: number,
  forceNeutralMode?: boolean,
): [number, number, number] {
  const srcHsl = rgbToHsl(srcR, srcG, srcB);
  const tgtHsl = rgbToHsl(tgtR, tgtG, tgtB);
  const srcLum = computePerceptualLuminance(srcR, srcG, srcB);

  const computeColored = (): [number, number, number] => {
    const [baseR, baseG, baseB] = hslToRgb(tgtHsl.h, tgtHsl.s, srcHsl.l);
    return setPerceptualLuminance(baseR, baseG, baseB, srcLum);
  };

  const computeNeutralMultiply = (): [number, number, number] => {
    const mulR = Math.round((srcR * tgtR) / 255);
    const mulG = Math.round((srcG * tgtG) / 255);
    const mulB = Math.round((srcB * tgtB) / 255);
    return [mulR, mulG, mulB];
  };

  if (forceNeutralMode === true) {
    if (srcHsl.s <= 0.24) {
      return computeNeutralMultiply();
    }
    // Smoothly blend if user manually brushed onto a saturated edge pixel
    const blend = Math.min(1, (srcHsl.s - 0.24) / 0.16);
    const [nr, ng, nb] = computeNeutralMultiply();
    const [cr, cg, cb] = computeColored();
    return [
      Math.round(nr + (cr - nr) * blend),
      Math.round(ng + (cg - ng) * blend),
      Math.round(nb + (cb - nb) * blend),
    ];
  }

  if (forceNeutralMode === false) {
    return computeColored();
  }

  // Per-pixel automatic mode
  if (srcHsl.s < 0.12) {
    return computeNeutralMultiply();
  }
  if (srcHsl.s >= 0.22) {
    return computeColored();
  }

  const blend = (srcHsl.s - 0.12) / 0.1;
  const [nr, ng, nb] = computeNeutralMultiply();
  const [cr, cg, cb] = computeColored();
  return [
    Math.round(nr + (cr - nr) * blend),
    Math.round(ng + (cg - ng) * blend),
    Math.round(nb + (cb - nb) * blend),
  ];
}

function circularHueDistanceDeg(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2);
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Precomputes HSV, HSL, perceptual luminance, and 3x3 Color Sobel gradient
 * magnitude for instant interactive 3D flood-fill and live recoloring.
 */
export function prepare3DImageData(source: ImageData): Prepared3DImage {
  const width = source.width;
  const height = source.height;
  const totalPixels = Math.max(0, width * height);
  const rgba = new Uint8ClampedArray(source.data);

  const hue = new Float32Array(totalPixels);
  const hsvSat = new Float32Array(totalPixels);
  const hsvVal = new Float32Array(totalPixels);
  const hslSat = new Float32Array(totalPixels);
  const hslLight = new Float32Array(totalPixels);
  const chroma = new Float32Array(totalPixels);
  const lum = new Float32Array(totalPixels);
  const edgeMag = new Float32Array(totalPixels);

  if (width <= 0 || height <= 0 || totalPixels === 0) {
    return {
      width,
      height,
      rgba,
      hue,
      hsvSat,
      hsvVal,
      hslSat,
      hslLight,
      chroma,
      lum,
      edgeMag,
    };
  }

  for (let i = 0; i < totalPixels; i++) {
    const off = i * 4;
    if (rgba[off + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;

    const r = rgba[off];
    const g = rgba[off + 1];
    const b = rgba[off + 2];

    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;

    chroma[i] = d;
    hsvVal[i] = max;
    hsvSat[i] = max > 1e-6 ? d / max : 0;
    lum[i] = 0.299 * rn + 0.587 * gn + 0.114 * bn;

    const hsl = rgbToHsl(r, g, b);
    hue[i] = hsl.h;
    hslSat[i] = hsl.s;
    hslLight[i] = hsl.l;
  }

  // Pass 2: 3x3 Color Sobel gradient barrier (repeats center RGB across transparent neighbors)
  const sampleChannel = (
    nx: number,
    ny: number,
    fallbackR: number,
    fallbackG: number,
    fallbackB: number,
  ): [number, number, number] => {
    const cx = nx < 0 ? 0 : nx >= width ? width - 1 : nx;
    const cy = ny < 0 ? 0 : ny >= height ? height - 1 : ny;
    const off = (cy * width + cx) * 4;
    if (rgba[off + 3] <= ALPHA_VISIBLE_THRESHOLD) {
      return [fallbackR, fallbackG, fallbackB];
    }
    return [rgba[off], rgba[off + 1], rgba[off + 2]];
  };

  const normDenom = 4 * 255;
  const sqrt3 = Math.sqrt(3);

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const off = idx * 4;
      if (rgba[off + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;

      const cr = rgba[off];
      const cg = rgba[off + 1];
      const cb = rgba[off + 2];

      const [r00, g00, b00] = sampleChannel(x - 1, y - 1, cr, cg, cb);
      const [r10, g10, b10] = sampleChannel(x, y - 1, cr, cg, cb);
      const [r20, g20, b20] = sampleChannel(x + 1, y - 1, cr, cg, cb);
      const [r01, g01, b01] = sampleChannel(x - 1, y, cr, cg, cb);
      const [r21, g21, b21] = sampleChannel(x + 1, y, cr, cg, cb);
      const [r02, g02, b02] = sampleChannel(x - 1, y + 1, cr, cg, cb);
      const [r12, g12, b12] = sampleChannel(x, y + 1, cr, cg, cb);
      const [r22, g22, b22] = sampleChannel(x + 1, y + 1, cr, cg, cb);

      const gxR = (-r00 + r20 - 2 * r01 + 2 * r21 - r02 + r22) / normDenom;
      const gyR = (-r00 - 2 * r10 - r20 + r02 + 2 * r12 + r22) / normDenom;
      const gxG = (-g00 + g20 - 2 * g01 + 2 * g21 - g02 + g22) / normDenom;
      const gyG = (-g00 - 2 * g10 - g20 + g02 + 2 * g12 + g22) / normDenom;
      const gxB = (-b00 + b20 - 2 * b01 + 2 * b21 - b02 + b22) / normDenom;
      const gyB = (-b00 - 2 * b10 - b20 + b02 + 2 * b12 + b22) / normDenom;

      const magSq =
        gxR * gxR + gyR * gyR + gxG * gxG + gyG * gyG + gxB * gxB + gyB * gyB;
      edgeMag[idx] = Math.min(1, Math.sqrt(magSq) / sqrt3);
    }
  }

  return {
    width,
    height,
    rgba,
    hue,
    hsvSat,
    hsvVal,
    hslSat,
    hslLight,
    chroma,
    lum,
    edgeMag,
  };
}

export function createEmpty3DState(
  width: number,
  height: number,
): Recolor3DState {
  const safeW = Math.max(0, width);
  const safeH = Math.max(0, height);
  return {
    width: safeW,
    height: safeH,
    groups: [],
    maskMap: new Int32Array(safeW * safeH),
    coverageMap: new Uint8Array(safeW * safeH),
    groupToMaskId: {},
    nextGroupSeq: 1,
    nextMaskId: 1,
  };
}

export function findGroupAtPixel3D(
  state: Recolor3DState,
  x: number,
  y: number,
): string | null {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= state.width || iy < 0 || iy >= state.height) {
    return null;
  }
  const maskId = state.maskMap[iy * state.width + ix];
  if (maskId <= 0) return null;

  for (const group of state.groups) {
    if (state.groupToMaskId[group.groupId] === maskId) {
      return group.groupId;
    }
  }
  return null;
}

function recalculateGroupStats(
  state: Recolor3DState,
  prepared: Prepared3DImage,
  updatedMaskIds?: Set<number>,
): Recolor3DGroup[] {
  const counts = new Map<number, number>();
  const satSums = new Map<number, number>();
  const { maskMap, coverageMap } = state;
  const { hslSat } = prepared;
  const total = maskMap.length;

  for (let i = 0; i < total; i++) {
    const mid = maskMap[i];
    if (mid <= 0 || coverageMap[i] === 0) continue;
    counts.set(mid, (counts.get(mid) ?? 0) + 1);
    satSums.set(mid, (satSums.get(mid) ?? 0) + hslSat[i]);
  }

  return state.groups
    .map((group) => {
      const mid = state.groupToMaskId[group.groupId];
      const count = counts.get(mid) ?? 0;
      if (count === 0) {
        return {
          ...group,
          pixelCount: 0,
        };
      }
      const avgSat = (satSums.get(mid) ?? 0) / count;
      let nextMask = group.mask;
      if (
        !updatedMaskIds ||
        updatedMaskIds.has(mid) ||
        nextMask.length !== total
      ) {
        nextMask = new Uint8Array(total);
        for (let i = 0; i < total; i++) {
          if (maskMap[i] === mid && coverageMap[i] > 0) {
            nextMask[i] = coverageMap[i];
          }
        }
      }
      return {
        ...group,
        pixelCount: count,
        mask: nextMask,
        isNeutral: avgSat < NEUTRAL_SAT_THRESHOLD,
      };
    })
    .filter((group) => group.pixelCount > 0);
}

interface FloodFillMaskResult {
  pixelCount: number;
  avgHslSat: number;
}

function isPrepared3DImage(
  input: ImageData | Prepared3DImage,
): input is Prepared3DImage {
  return "edgeMag" in input && "chroma" in input && "rgba" in input;
}

function isDarkOutlinePixel(lum: number, hslSat: number): boolean {
  return lum < 0.12 && hslSat < 0.25;
}

/**
 * Post-processes a binary/coverage mask into a smooth 0–255 soft alpha matte:
 * 1) Micro Hole-Fill: closes isolated 1–2 px enclosed holes (never dark ink outlines).
 * 2) Edge Feathering (1–2 px): softens perimeter anti-aliasing transitions (1..254)
 *    while preserving full 255 core and leaving dark outlines / adjacent hues untouched.
 */
export function smoothSelectionMask3D(params: {
  mask: Uint8Array;
  prepared: Prepared3DImage;
  seedHue?: number;
  seedIsChromatic?: boolean;
  guardDarkOutlines?: boolean;
  canTouch?: (idx: number) => boolean;
}): Uint8Array {
  const {
    mask,
    prepared,
    seedHue = 0,
    seedIsChromatic = false,
    guardDarkOutlines = true,
    canTouch,
  } = params;
  const { width, height, rgba, hue, chroma, lum, hslSat, edgeMag } = prepared;
  const totalPixels = width * height;
  if (width <= 0 || height <= 0 || mask.length !== totalPixels) {
    return new Uint8Array(mask);
  }

  // Locate tight bounding box around selected pixels for O(bbox) performance
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[rowBase + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return new Uint8Array(totalPixels);
  }

  const bMinX = Math.max(0, minX - 2);
  const bMinY = Math.max(0, minY - 2);
  const bMaxX = Math.min(width - 1, maxX + 2);
  const bMaxY = Math.min(height - 1, maxY + 2);

  const isOutline = (idx: number) =>
    guardDarkOutlines && isDarkOutlinePixel(lum[idx], hslSat[idx]);
  const isAvailable = (idx: number) =>
    rgba[idx * 4 + 3] > ALPHA_VISIBLE_THRESHOLD &&
    !isOutline(idx) &&
    (!canTouch || canTouch(idx));

  // Step 1: Micro Hole-Fill (isolated 1-2 px enclosed holes)
  const filled = new Uint8Array(mask);

  for (let y = bMinY; y <= bMaxY; y++) {
    const rowBase = y * width;
    for (let x = bMinX; x <= bMaxX; x++) {
      const idx = rowBase + x;
      if (filled[idx] > 0 || !isAvailable(idx)) continue;

      let sel4 = 0;
      let touchesForeign = false;
      let openCount = 0;
      let firstOpen = -1;

      for (let k = 0; k < NEIGHBOR_4_OFFSETS.length; k++) {
        const [dx, dy] = NEIGHBOR_4_OFFSETS[k];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (mask[nIdx] > 0) {
          sel4++;
        } else if (rgba[nIdx * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) {
          touchesForeign = true;
        } else if (!isOutline(nIdx)) {
          if (canTouch && !canTouch(nIdx)) {
            touchesForeign = true;
          } else {
            openCount++;
            if (firstOpen === -1) firstOpen = nIdx;
          }
        }
      }

      if (touchesForeign) continue;

      // 1-pixel hole completely enclosed on all non-outline cardinal sides
      if (openCount === 0 && sel4 >= 3) {
        filled[idx] = 255;
        continue;
      }

      // 2-pixel hole [idx, j] completely enclosed by selected/outline walls
      if (openCount === 1 && firstOpen > idx && sel4 >= 2) {
        const jx = firstOpen % width;
        const jy = (firstOpen - jx) / width;
        let selJ = 0;
        let openJ = 0;
        let foreignJ = false;

        for (let k = 0; k < NEIGHBOR_4_OFFSETS.length; k++) {
          const [dx, dy] = NEIGHBOR_4_OFFSETS[k];
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (nIdx === idx) continue;
          if (mask[nIdx] > 0) {
            selJ++;
          } else if (rgba[nIdx * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) {
            foreignJ = true;
          } else if (!isOutline(nIdx)) {
            if (canTouch && !canTouch(nIdx)) {
              foreignJ = true;
            } else {
              openJ++;
            }
          }
        }

        if (!foreignJ && openJ === 0 && selJ >= 2 && sel4 + selJ >= 5) {
          filled[idx] = 255;
          filled[firstOpen] = 255;
        }
      }
    }
  }

  // Step 2: 1-2 px Soft Edge Feathering (0..255 matte)
  const out = new Uint8Array(filled);

  const hasDarkOutlineNeighbor = (x: number, y: number): boolean => {
    for (let k = 0; k < NEIGHBOR_4_OFFSETS.length; k++) {
      const [dx, dy] = NEIGHBOR_4_OFFSETS[k];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (isDarkOutlinePixel(lum[ny * width + nx], hslSat[ny * width + nx])) {
        return true;
      }
    }
    return false;
  };

  for (let y = bMinY; y <= bMaxY; y++) {
    const rowBase = y * width;
    for (let x = bMinX; x <= bMaxX; x++) {
      const idx = rowBase + x;
      if (rgba[idx * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) {
        out[idx] = 0;
        continue;
      }

      if (filled[idx] > 0) {
        // Compute 8-connected weighted support (max = 12)
        let support = 0;
        let touchesBoundary = false;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const w = ox === 0 || oy === 0 ? 2 : 1;
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              touchesBoundary = true;
              continue;
            }
            if (filled[ny * width + nx] > 0) {
              support += w;
            } else {
              touchesBoundary = true;
            }
          }
        }

        if (touchesBoundary && support < 12) {
          // 1px outer perimeter feather (145..238)
          const existing = mask[idx];
          const edgeAlpha = Math.max(
            145,
            Math.min(238, Math.round(125 + (support / 12) * 114)),
          );
          out[idx] = existing > 0 && existing < 255 ? Math.min(existing, edgeAlpha) : edgeAlpha;
        } else if (edgeMag[idx] > 0.08 && hasDarkOutlineNeighbor(x, y)) {
          // 2nd-pixel gentle transition right behind dark AA outlines
          out[idx] = 244;
        } else {
          out[idx] = Math.max(filled[idx], 255);
        }
        continue;
      }

      // Cautious 1px outward AA transition blend (only onto genuine AA rim pixels next to selected core)
      if (!isAvailable(idx)) continue;

      let adjacentFull4 = 0;
      for (let k = 0; k < NEIGHBOR_4_OFFSETS.length; k++) {
        const [dx, dy] = NEIGHBOR_4_OFFSETS[k];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (filled[ny * width + nx] === 255) {
          adjacentFull4++;
        }
      }
      if (adjacentFull4 === 0) continue;

      // Never bleed outward onto vastly contrasting hues or clean neutral neighbor shapes
      if (seedIsChromatic) {
        if (chroma[idx] >= 0.08) {
          if (circularHueDistanceDeg(seedHue, hue[idx]) > 36) continue;
        } else {
          const isOutlineAA =
            edgeMag[idx] >= 0.14 &&
            lum[idx] <= 0.65 &&
            hasDarkOutlineNeighbor(x, y);
          if (!isOutlineAA) continue;
        }
      } else if (edgeMag[idx] < 0.08) {
        continue;
      }

      out[idx] = Math.min(184, 72 + adjacentFull4 * 36);
    }
  }

  return out;
}

/**
 * Applies a smoothed 0-255 coverage mask for targetMaskId cleanly into Recolor3DState,
 * keeping other groups untouched and syncing maskMap, coverageMap, and group.mask.
 */
function commitSmoothedMaskForGroup(params: {
  state: Recolor3DState;
  prepared: Prepared3DImage;
  targetMaskId: number;
  smoothedMask: Uint8Array;
  preserveUnchangedGroupMaskIds?: boolean;
}): { maskMap: Int32Array; coverageMap: Uint8Array } {
  const { state, targetMaskId, smoothedMask } = params;
  const totalPixels = preparedPixelsCount(state.width, state.height);
  const nextMaskMap = new Int32Array(state.maskMap);
  const nextCoverageMap = new Uint8Array(state.coverageMap);

  for (let i = 0; i < totalPixels; i++) {
    const cov = smoothedMask[i];
    if (cov > 0) {
      if (nextMaskMap[i] === 0 || nextMaskMap[i] === targetMaskId) {
        nextMaskMap[i] = targetMaskId;
        nextCoverageMap[i] = cov;
      }
    } else if (nextMaskMap[i] === targetMaskId) {
      nextMaskMap[i] = 0;
      nextCoverageMap[i] = 0;
    }
  }

  return { maskMap: nextMaskMap, coverageMap: nextCoverageMap };
}

function preparedPixelsCount(width: number, height: number): number {
  return Math.max(0, width) * Math.max(0, height);
}

function runEdgeAwareHsvFloodFill(params: {
  prepared: Prepared3DImage;
  maskMap: Int32Array;
  seedIndex: number;
  writeMaskValue: number;
  tolerance: number;
  shadowReach?: number;
  restrictToMaskId?: number;
  allowOverwriteMaskId?: number;
}): FloodFillMaskResult {
  const {
    prepared,
    maskMap,
    seedIndex,
    writeMaskValue,
    tolerance,
    shadowReach = DEFAULT_3D_SHADOW_REACH,
    restrictToMaskId,
    allowOverwriteMaskId,
  } = params;
  const { width, height, rgba, hue, hsvVal, hslSat, chroma, lum, edgeMag } =
    prepared;
  const totalPixels = width * height;

  if (
    seedIndex < 0 ||
    seedIndex >= totalPixels ||
    rgba[seedIndex * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD
  ) {
    return { pixelCount: 0, avgHslSat: 0 };
  }

  if (
    restrictToMaskId !== undefined &&
    maskMap[seedIndex] !== restrictToMaskId
  ) {
    return { pixelCount: 0, avgHslSat: 0 };
  }

  const tol = clampTolerance(tolerance);
  const tNorm = tol / MAX_3D_TOLERANCE;
  const sReach = clampShadowReach(shadowReach);
  const sNorm = sReach / MAX_3D_SHADOW_REACH;

  // Tolerance (5-60) governs Hue & lateral color precision strictly
  const maxHueDeg = 7 + tol * 0.85;
  const edgeBarrier = 0.08 + tNorm * 0.18;
  const maxLocalStep = 0.06 + tNorm * 0.18;
  const maxNeutralChroma = 0.095 + tNorm * 0.145;
  const maxNeutralLumDelta = 0.3 + tNorm * 0.55;

  const seedHue = hue[seedIndex];
  const seedChroma = chroma[seedIndex];
  const seedLum = lum[seedIndex];
  const seedIsChromatic = seedChroma >= 0.09;
  const guardDarkOutlines = seedLum >= 0.14;

  const maxLocalStepSq = maxLocalStep * maxLocalStep * 3 * (255 * 255);
  const boundaryStepSq = maxLocalStepSq * 0.55;

  const matchesSeed = (idx: number, stepSq: number): boolean => {
    const pxChroma = chroma[idx];
    const pxVal = hsvVal[idx];

    if (seedIsChromatic) {
      if (pxChroma >= 0.05) {
        return circularHueDistanceDeg(seedHue, hue[idx]) <= maxHueDeg;
      }
      // Allow smooth interior specular highlights only (reject bright neutral neighbors)
      if (pxVal >= 0.82 && stepSq <= maxLocalStepSq * 0.4) {
        return (
          pxChroma < 0.025 ||
          circularHueDistanceDeg(seedHue, hue[idx]) <= maxHueDeg
        );
      }
      return false;
    }

    return (
      pxChroma <= maxNeutralChroma &&
      Math.abs(seedLum - lum[idx]) <= maxNeutralLumDelta
    );
  };

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  const edgeRimSeeds: number[] = [];
  let head = 0;
  let tail = 0;

  visited[seedIndex] = 2;
  maskMap[seedIndex] = writeMaskValue;
  queue[tail++] = seedIndex;

  let pixelCount = 1;
  let satSum = hslSat[seedIndex];

  const tryNeighbor = (
    currR: number,
    currG: number,
    currB: number,
    nIdx: number,
  ) => {
    if (visited[nIdx] !== 0) return;
    visited[nIdx] = 1;

    const nOff = nIdx * 4;
    if (rgba[nOff + 3] <= ALPHA_VISIBLE_THRESHOLD) return;

    // Hard Outline Wall: neutral/dark ink lines block traversal completely when seed isn't black
    if (guardDarkOutlines && isDarkOutlinePixel(lum[nIdx], hslSat[nIdx])) {
      return;
    }

    const currentMask = maskMap[nIdx];
    if (restrictToMaskId !== undefined) {
      if (currentMask !== restrictToMaskId) return;
    } else if (
      currentMask !== 0 &&
      currentMask !== writeMaskValue &&
      currentMask !== allowOverwriteMaskId
    ) {
      return;
    }

    const dr = currR - rgba[nOff];
    const dg = currG - rgba[nOff + 1];
    const db = currB - rgba[nOff + 2];
    const stepSq = dr * dr + dg * dg + db * db;

    if (stepSq > maxLocalStepSq) return;

    const isEdgePixel = edgeMag[nIdx] > edgeBarrier;
    if (!matchesSeed(nIdx, stepSq)) return;

    if (isEdgePixel) {
      if (stepSq <= boundaryStepSq && (!guardDarkOutlines || lum[nIdx] >= 0.16)) {
        visited[nIdx] = 2;
        maskMap[nIdx] = writeMaskValue;
        pixelCount++;
        satSum += hslSat[nIdx];
        edgeRimSeeds.push(nIdx);
      }
      return;
    }

    visited[nIdx] = 2;
    maskMap[nIdx] = writeMaskValue;
    pixelCount++;
    satSum += hslSat[nIdx];
    queue[tail++] = nIdx;
  };

  while (head < tail) {
    const idx = queue[head++];
    const off = idx * 4;
    const r = rgba[off];
    const g = rgba[off + 1];
    const b = rgba[off + 2];

    const x = idx % width;
    const y = (idx - x) / width;

    // Strict 4-directional connectivity (Up/Down/Left/Right) prevents diagonal outline leaks
    for (let k = 0; k < NEIGHBOR_4_OFFSETS.length; k++) {
      const [dx, dy] = NEIGHBOR_4_OFFSETS[k];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      tryNeighbor(r, g, b, ny * width + nx);
    }
  }

  // Stage 2: Bounded Shadow Reach Expansion (when writing a foreground selection mask & shadowReach > 0)
  // Expands strictly downhill into darker adjacent shadows while preserving hard outline/neutral barriers.
  if (sReach > 0 && writeMaskValue > 0 && restrictToMaskId === undefined) {
    const minShadowLum = Math.max(
      guardDarkOutlines ? 0.12 : 0,
      seedLum - (0.04 + sNorm * 0.44),
    );
    const maxShadowStep = 0.08 + sNorm * 0.34;
    const maxShadowStepSq = maxShadowStep * maxShadowStep * 3 * (255 * 255);
    const shadowEdgeBarrier = edgeBarrier + sNorm * 0.26;
    const maxShadowHueDeg = maxHueDeg + sNorm * 16;

    const shadowQueue = new Int32Array(totalPixels);
    let sHead = 0;
    let sTail = 0;
    for (let q = 0; q < tail; q++) {
      shadowQueue[sTail++] = queue[q];
    }
    for (let e = 0; e < edgeRimSeeds.length; e++) {
      shadowQueue[sTail++] = edgeRimSeeds[e];
    }

    while (sHead < sTail) {
      const idx = shadowQueue[sHead++];
      const off = idx * 4;
      const cr = rgba[off];
      const cg = rgba[off + 1];
      const cb = rgba[off + 2];
      const cLum = lum[idx];
      const x = idx % width;
      const y = (idx - x) / width;

      for (let k = 0; k < NEIGHBOR_4_OFFSETS.length; k++) {
        const [dx, dy] = NEIGHBOR_4_OFFSETS[k];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

        const nIdx = ny * width + nx;
        if (visited[nIdx] >= 2) continue;
        visited[nIdx] = 3;

        const nOff = nIdx * 4;
        if (rgba[nOff + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;

        if (guardDarkOutlines && isDarkOutlinePixel(lum[nIdx], hslSat[nIdx])) {
          continue;
        }

        const existingMask = maskMap[nIdx];
        if (
          existingMask !== 0 &&
          existingMask !== writeMaskValue &&
          existingMask !== allowOverwriteMaskId
        ) {
          continue;
        }

        const nLum = lum[nIdx];
        // Strictly downhill darker shadow only: never climb back up to bright highlights or light grays
        if (nLum > cLum + 0.015 || nLum > seedLum + 0.01 || nLum < minShadowLum) {
          continue;
        }

        const dr = cr - rgba[nOff];
        const dg = cg - rgba[nOff + 1];
        const db = cb - rgba[nOff + 2];
        const stepSq = dr * dr + dg * dg + db * db;
        if (stepSq > maxShadowStepSq) continue;
        if (edgeMag[nIdx] > shadowEdgeBarrier) continue;

        if (seedIsChromatic) {
          const nChroma = chroma[nIdx];
          const nSat = hslSat[nIdx];
          // Reject separate light or muted neutral gray areas even if un-outlined
          if (nLum > 0.56 || nChroma < 0.025 || nSat < 0.14) continue;
          const hueOk =
            nChroma >= 0.06
              ? circularHueDistanceDeg(seedHue, hue[nIdx]) <= maxShadowHueDeg
              : hsvVal[nIdx] <= 0.48 &&
                circularHueDistanceDeg(seedHue, hue[nIdx]) <= maxShadowHueDeg * 1.35;
          if (!hueOk) continue;
        } else {
          if (chroma[nIdx] > maxNeutralChroma) continue;
        }

        visited[nIdx] = 2;
        maskMap[nIdx] = writeMaskValue;
        pixelCount++;
        satSum += hslSat[nIdx];
        shadowQueue[sTail++] = nIdx;
      }
    }
  }

  return {
    pixelCount,
    avgHslSat: pixelCount > 0 ? satSum / pixelCount : 0,
  };
}

function runGlobalColorMatch(params: {
  prepared: Prepared3DImage;
  maskMap: Int32Array;
  seedIndex: number;
  writeMaskValue: number;
  tolerance: number;
  allowOverwriteAll?: boolean;
}): { pixelCount: number; mask: Uint8Array } {
  const {
    prepared,
    maskMap,
    seedIndex,
    writeMaskValue,
    tolerance,
    allowOverwriteAll = false,
  } = params;
  const { width, height, rgba, hue, hsvVal, hslSat, chroma, lum } = prepared;
  const totalPixels = width * height;
  const mask = new Uint8Array(totalPixels);

  if (
    seedIndex < 0 ||
    seedIndex >= totalPixels ||
    rgba[seedIndex * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD
  ) {
    return { pixelCount: 0, mask };
  }

  const tol = clampTolerance(tolerance);
  const tNorm = tol / MAX_3D_TOLERANCE;
  const maxHueDeg = 8 + tol * 0.85;
  const maxValDiff = 0.35 + tNorm * 0.65;
  const maxNeutralChroma = 0.09 + tNorm * 0.14;
  const maxNeutralLumDelta = 0.18 + tNorm * 0.55;

  const seedHue = hue[seedIndex];
  const seedChroma = chroma[seedIndex];
  const seedVal = hsvVal[seedIndex];
  const seedLum = lum[seedIndex];
  const seedIsChromatic = seedChroma >= 0.09;
  const guardDarkOutlines = seedLum >= 0.14;

  let pixelCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (rgba[i * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;
    if (!allowOverwriteAll && maskMap[i] !== 0 && maskMap[i] !== writeMaskValue) {
      continue;
    }

    // Never sweep dark outline pixels into non-black color selections
    if (guardDarkOutlines && isDarkOutlinePixel(lum[i], hslSat[i])) {
      continue;
    }

    const pxChroma = chroma[i];
    const pxVal = hsvVal[i];

    let matched = false;
    if (seedIsChromatic) {
      // Strictly exclude neutral gray/white pixels when sweeping colored regions
      if (pxChroma >= 0.06) {
        matched =
          circularHueDistanceDeg(seedHue, hue[i]) <= maxHueDeg &&
          Math.abs(seedVal - pxVal) <= maxValDiff;
      } else if (pxVal >= 0.8 && pxChroma >= 0.04) {
        matched =
          circularHueDistanceDeg(seedHue, hue[i]) <= maxHueDeg * 1.15 &&
          Math.abs(seedVal - pxVal) <= maxValDiff;
      }
    } else {
      matched =
        pxChroma <= maxNeutralChroma &&
        Math.abs(seedLum - lum[i]) <= maxNeutralLumDelta;
    }

    if (matched) {
      maskMap[i] = writeMaskValue;
      mask[i] = 1;
      pixelCount++;
    }
  }

  return { pixelCount, mask };
}

/**
 * Runs 4-directional HSV + Hard Sobel Edge, Shadow Reach & Dark Outline Flood-Fill
 * starting at (seedX, seedY) with automatic micro hole-fill and 0-255 soft edge matte.
 */
export function floodFillSelect3D(params: {
  state: Recolor3DState;
  prepared: Prepared3DImage;
  seedX: number;
  seedY: number;
  tolerance?: number;
  shadowReach?: number;
  targetGroupId?: string;
}): { state: Recolor3DState; groupId: string | null } {
  const { state, prepared, seedX, seedY, targetGroupId } = params;
  const tolerance = clampTolerance(params.tolerance ?? DEFAULT_3D_TOLERANCE);

  const ix = Math.floor(seedX);
  const iy = Math.floor(seedY);
  if (ix < 0 || ix >= prepared.width || iy < 0 || iy >= prepared.height) {
    return { state, groupId: null };
  }

  const seedIndex = iy * prepared.width + ix;
  const seedOff = seedIndex * 4;
  if (prepared.rgba[seedOff + 3] <= ALPHA_VISIBLE_THRESHOLD) {
    return { state, groupId: null };
  }

  const nextMaskMap = new Int32Array(state.maskMap);
  const existingTarget = targetGroupId
    ? state.groups.find((g) => g.groupId === targetGroupId)
    : undefined;

  const shadowReach = clampShadowReach(
    params.shadowReach ?? existingTarget?.shadowReach,
  );
  const guardDarkOutlines = prepared.lum[seedIndex] >= 0.14;
  const seedIsChromatic = prepared.chroma[seedIndex] >= 0.09;
  const seedHue = prepared.hue[seedIndex];

  if (existingTarget) {
    const maskId = state.groupToMaskId[existingTarget.groupId];
    const tappedMask = nextMaskMap[seedIndex];
    const allowOverwriteMaskId =
      tappedMask > 0 && tappedMask !== maskId ? tappedMask : undefined;

    const fill = runEdgeAwareHsvFloodFill({
      prepared,
      maskMap: nextMaskMap,
      seedIndex,
      writeMaskValue: maskId,
      tolerance,
      shadowReach,
      allowOverwriteMaskId,
    });

    if (fill.pixelCount === 0) {
      return { state, groupId: existingTarget.groupId };
    }

    const totalPixels = prepared.width * prepared.height;
    const rawGroupBinary = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      if (nextMaskMap[i] === maskId) {
        rawGroupBinary[i] = 255;
      }
    }

    const smoothedMask = smoothSelectionMask3D({
      mask: rawGroupBinary,
      prepared,
      seedHue,
      seedIsChromatic,
      guardDarkOutlines,
      canTouch: (i) => nextMaskMap[i] === 0 || nextMaskMap[i] === maskId,
    });

    const merged = commitSmoothedMaskForGroup({
      state: { ...state, maskMap: nextMaskMap },
      prepared,
      targetMaskId: maskId,
      smoothedMask,
    });

    const updatedState: Recolor3DState = {
      ...state,
      maskMap: merged.maskMap,
      coverageMap: merged.coverageMap,
    };
    const nextSeeds = existingTarget.seedIndices.includes(seedIndex)
      ? existingTarget.seedIndices
      : [...existingTarget.seedIndices, seedIndex];

    const changedMaskIds = new Set<number>([maskId]);
    if (allowOverwriteMaskId) changedMaskIds.add(allowOverwriteMaskId);

    const syncedGroups = recalculateGroupStats(
      updatedState,
      prepared,
      changedMaskIds,
    ).map((g) =>
      g.groupId === existingTarget.groupId
        ? {
            ...g,
            tolerance,
            shadowReach,
            lastSeedIndex: seedIndex,
            seedIndices: nextSeeds,
            selectionKind: "flood" as const,
          }
        : g,
    );

    const nextGroupToMaskId: Record<string, number> = {};
    for (const grp of syncedGroups) {
      nextGroupToMaskId[grp.groupId] = updatedState.groupToMaskId[grp.groupId];
    }

    return {
      state: {
        ...updatedState,
        groups: syncedGroups,
        groupToMaskId: nextGroupToMaskId,
      },
      groupId: existingTarget.groupId,
    };
  }

  const seq = state.nextGroupSeq;
  const maskId = state.nextMaskId;
  const groupId = `group3d-${seq}`;

  const fill = runEdgeAwareHsvFloodFill({
    prepared,
    maskMap: nextMaskMap,
    seedIndex,
    writeMaskValue: maskId,
    tolerance,
    shadowReach,
  });

  if (fill.pixelCount === 0) {
    return { state, groupId: null };
  }

  const totalPixels = prepared.width * prepared.height;
  const rawBinary = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (nextMaskMap[i] === maskId) {
      rawBinary[i] = 255;
    }
  }

  const smoothedMask = smoothSelectionMask3D({
    mask: rawBinary,
    prepared,
    seedHue,
    seedIsChromatic,
    guardDarkOutlines,
    canTouch: (i) => state.maskMap[i] === 0,
  });

  const merged = commitSmoothedMaskForGroup({
    state,
    prepared,
    targetMaskId: maskId,
    smoothedMask,
  });

  let smoothCount = 0;
  let satSum = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (merged.maskMap[i] === maskId && smoothedMask[i] > 0) {
      smoothCount++;
      satSum += prepared.hslSat[i];
    }
  }

  const r = prepared.rgba[seedOff];
  const g = prepared.rgba[seedOff + 1];
  const b = prepared.rgba[seedOff + 2];
  const seedHex = rgbToHex(r, g, b);

  const newGroup: Recolor3DGroup = {
    groupId,
    name: `Area ${seq}`,
    targetHex: seedHex,
    r,
    g,
    b,
    seedHex,
    pixelCount: Math.max(1, smoothCount),
    tolerance,
    shadowReach,
    mask: smoothedMask,
    lastSeedIndex: seedIndex,
    seedIndices: [seedIndex],
    selectionKind: "flood",
    isNeutral:
      (smoothCount > 0 ? satSum / smoothCount : fill.avgHslSat) <
      NEUTRAL_SAT_THRESHOLD,
  };

  return {
    state: {
      ...state,
      groups: [...state.groups, newGroup],
      maskMap: merged.maskMap,
      coverageMap: merged.coverageMap,
      groupToMaskId: {
        ...state.groupToMaskId,
        [groupId]: maskId,
      },
      nextGroupSeq: seq + 1,
      nextMaskId: maskId + 1,
    },
    groupId,
  };
}

export interface GlobalSelect3DResult {
  state: Recolor3DState;
  groupId: string | null;
  /** Soft coverage mask 0..255 (0 = outside, 255 = full, 1..254 = feathered transition). */
  mask: Uint8Array;
  pixelCount: number;
}

/**
 * Selects all pixels across the entire canvas whose color matches (seedX, seedY)
 * within tolerance, ignoring spatial gaps and black outline barriers,
 * followed by micro hole-fill and 0-255 soft edge smoothing.
 */
export function selectGlobalSimilar3D(
  imageOrPrepared: ImageData | Prepared3DImage,
  seedX: number,
  seedY: number,
  tolerance: number = DEFAULT_3D_TOLERANCE,
  existingState?: Recolor3DState,
  targetGroupId?: string,
): GlobalSelect3DResult {
  const prepared = isPrepared3DImage(imageOrPrepared)
    ? imageOrPrepared
    : prepare3DImageData(imageOrPrepared);
  const state =
    existingState ?? createEmpty3DState(prepared.width, prepared.height);
  const clampedTol = clampTolerance(tolerance);

  const ix = Math.floor(seedX);
  const iy = Math.floor(seedY);
  if (ix < 0 || ix >= prepared.width || iy < 0 || iy >= prepared.height) {
    return {
      state,
      groupId: null,
      mask: new Uint8Array(prepared.width * prepared.height),
      pixelCount: 0,
    };
  }

  const seedIndex = iy * prepared.width + ix;
  const seedOff = seedIndex * 4;
  if (prepared.rgba[seedOff + 3] <= ALPHA_VISIBLE_THRESHOLD) {
    return {
      state,
      groupId: null,
      mask: new Uint8Array(prepared.width * prepared.height),
      pixelCount: 0,
    };
  }

  const totalPixels = prepared.width * prepared.height;
  const nextMaskMap = new Int32Array(state.maskMap);
  const existingTarget = targetGroupId
    ? state.groups.find((g) => g.groupId === targetGroupId)
    : undefined;

  const guardDarkOutlines = prepared.lum[seedIndex] >= 0.14;
  const seedIsChromatic = prepared.chroma[seedIndex] >= 0.09;
  const seedHue = prepared.hue[seedIndex];

  if (existingTarget) {
    const maskId = state.groupToMaskId[existingTarget.groupId];
    for (let i = 0; i < nextMaskMap.length; i++) {
      if (nextMaskMap[i] === maskId) {
        nextMaskMap[i] = 0;
      }
    }

    const res = runGlobalColorMatch({
      prepared,
      maskMap: nextMaskMap,
      seedIndex,
      writeMaskValue: maskId,
      tolerance: clampedTol,
    });

    if (res.pixelCount === 0) {
      return {
        state,
        groupId: existingTarget.groupId,
        mask: res.mask,
        pixelCount: 0,
      };
    }

    const rawBinary = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      if (res.mask[i] > 0) rawBinary[i] = 255;
    }

    const smoothedMask = smoothSelectionMask3D({
      mask: rawBinary,
      prepared,
      seedHue,
      seedIsChromatic,
      guardDarkOutlines,
      canTouch: (i) =>
        state.maskMap[i] === 0 || state.maskMap[i] === maskId,
    });

    const clearedState: Recolor3DState = {
      ...state,
      maskMap: nextMaskMap,
    };
    const merged = commitSmoothedMaskForGroup({
      state: clearedState,
      prepared,
      targetMaskId: maskId,
      smoothedMask,
    });

    let finalCount = 0;
    for (let i = 0; i < totalPixels; i++) {
      if (smoothedMask[i] > 0 && merged.maskMap[i] === maskId) finalCount++;
    }

    const updatedState: Recolor3DState = {
      ...state,
      maskMap: merged.maskMap,
      coverageMap: merged.coverageMap,
    };
    const syncedGroups = recalculateGroupStats(
      updatedState,
      prepared,
      new Set([maskId]),
    ).map((g) =>
      g.groupId === existingTarget.groupId
        ? {
            ...g,
            tolerance: clampedTol,
            lastSeedIndex: seedIndex,
            seedIndices: [seedIndex],
            selectionKind: "global" as const,
          }
        : g,
    );

    return {
      state: { ...updatedState, groups: syncedGroups },
      groupId: existingTarget.groupId,
      mask: smoothedMask,
      pixelCount: finalCount,
    };
  }

  const seq = state.nextGroupSeq;
  const maskId = state.nextMaskId;
  const groupId = `group3d-${seq}`;

  const res = runGlobalColorMatch({
    prepared,
    maskMap: nextMaskMap,
    seedIndex,
    writeMaskValue: maskId,
    tolerance: clampedTol,
    allowOverwriteAll: !existingState,
  });

  if (res.pixelCount === 0) {
    return {
      state,
      groupId: null,
      mask: res.mask,
      pixelCount: 0,
    };
  }

  const rawBinary = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (res.mask[i] > 0) rawBinary[i] = 255;
  }

  const allowAll = !existingState;
  const smoothedMask = smoothSelectionMask3D({
    mask: rawBinary,
    prepared,
    seedHue,
    seedIsChromatic,
    guardDarkOutlines,
    canTouch: allowAll ? undefined : (i) => state.maskMap[i] === 0,
  });

  const merged = commitSmoothedMaskForGroup({
    state,
    prepared,
    targetMaskId: maskId,
    smoothedMask,
  });

  let smoothCount = 0;
  let satSum = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (smoothedMask[i] > 0 && merged.maskMap[i] === maskId) {
      smoothCount++;
      satSum += prepared.hslSat[i];
    }
  }

  const r = prepared.rgba[seedOff];
  const g = prepared.rgba[seedOff + 1];
  const b = prepared.rgba[seedOff + 2];
  const seedHex = rgbToHex(r, g, b);
  const avgSat = smoothCount > 0 ? satSum / smoothCount : 0;

  const newGroup: Recolor3DGroup = {
    groupId,
    name: `Area ${seq}`,
    targetHex: seedHex,
    r,
    g,
    b,
    seedHex,
    pixelCount: Math.max(1, smoothCount),
    tolerance: clampedTol,
    shadowReach: DEFAULT_3D_SHADOW_REACH,
    mask: smoothedMask,
    lastSeedIndex: seedIndex,
    seedIndices: [seedIndex],
    selectionKind: "global",
    isNeutral: avgSat < NEUTRAL_SAT_THRESHOLD,
  };

  return {
    state: {
      ...state,
      groups: [...state.groups, newGroup],
      maskMap: merged.maskMap,
      coverageMap: merged.coverageMap,
      groupToMaskId: {
        ...state.groupToMaskId,
        [groupId]: maskId,
      },
      nextGroupSeq: seq + 1,
      nextMaskId: maskId + 1,
    },
    groupId,
    mask: smoothedMask,
    pixelCount: smoothCount,
  };
}

/**
 * Removes the tapped sub-region (via 4-way edge-aware flood-fill constrained to groupId's mask)
 * from groupId cleanly in "- Kurangi" mode. Prunes the group if zero pixels remain.
 */
export function subtractRegion3DAtPoint(params: {
  state: Recolor3DState;
  prepared: Prepared3DImage;
  groupId: string;
  seedX: number;
  seedY: number;
  tolerance?: number;
}): { state: Recolor3DState; groupId: string | null; removedPixels: number } {
  const { state, prepared, groupId, seedX, seedY } = params;
  const targetGroup = state.groups.find((g) => g.groupId === groupId);
  if (!targetGroup) {
    return { state, groupId: null, removedPixels: 0 };
  }

  const maskId = state.groupToMaskId[groupId];
  if (!maskId) {
    return { state, groupId, removedPixels: 0 };
  }

  const ix = Math.floor(seedX);
  const iy = Math.floor(seedY);
  if (ix < 0 || ix >= prepared.width || iy < 0 || iy >= prepared.height) {
    return { state, groupId, removedPixels: 0 };
  }

  const seedIndex = iy * prepared.width + ix;
  if (state.maskMap[seedIndex] !== maskId) {
    return { state, groupId, removedPixels: 0 };
  }

  const nextMaskMap = new Int32Array(state.maskMap);
  const nextCoverageMap = new Uint8Array(state.coverageMap);
  const tol = clampTolerance(params.tolerance ?? targetGroup.tolerance);

  const sub = runEdgeAwareHsvFloodFill({
    prepared,
    maskMap: nextMaskMap,
    seedIndex,
    writeMaskValue: 0,
    tolerance: tol,
    shadowReach: 0,
    restrictToMaskId: maskId,
  });

  if (sub.pixelCount === 0) {
    return { state, groupId, removedPixels: 0 };
  }

  for (let i = 0; i < nextMaskMap.length; i++) {
    if (nextMaskMap[i] === 0 && state.maskMap[i] === maskId) {
      nextCoverageMap[i] = 0;
    }
  }

  const nextState: Recolor3DState = {
    ...state,
    maskMap: nextMaskMap,
    coverageMap: nextCoverageMap,
  };

  const remainingGroups = recalculateGroupStats(
    nextState,
    prepared,
    new Set([maskId]),
  ).map((g) => {
    if (g.groupId !== groupId) return g;
    const survivingSeeds = g.seedIndices.filter(
      (idx) => nextMaskMap[idx] === maskId,
    );
    return {
      ...g,
      seedIndices: survivingSeeds,
      lastSeedIndex:
        survivingSeeds.length > 0
          ? survivingSeeds[survivingSeeds.length - 1]
          : null,
    };
  });

  const nextGroupToMaskId: Record<string, number> = {};
  for (const grp of remainingGroups) {
    nextGroupToMaskId[grp.groupId] = nextState.groupToMaskId[grp.groupId];
  }

  const groupSurvived = remainingGroups.some((g) => g.groupId === groupId);

  return {
    state: {
      ...nextState,
      groups: remainingGroups,
      groupToMaskId: nextGroupToMaskId,
    },
    groupId: groupSurvived ? groupId : null,
    removedPixels: sub.pixelCount,
  };
}

/**
 * Dynamically updates a 3D group's selection mask when the user drags either the
 * Hue Tolerance slider (5–60) or Shadow Reach slider (0–100).
 */
export function recomputeGroupTolerance3D(
  state: Recolor3DState,
  prepared: Prepared3DImage,
  groupId: string,
  newTolerance: number,
  newShadowReach?: number,
): Recolor3DState {
  const group = state.groups.find((g) => g.groupId === groupId);
  if (!group) return state;

  const seeds =
    group.seedIndices.length > 0
      ? group.seedIndices
      : group.lastSeedIndex !== null
        ? [group.lastSeedIndex]
        : [];
  if (seeds.length === 0) {
    return state;
  }

  const clampedTol = clampTolerance(newTolerance);
  const clampedShadow = clampShadowReach(
    newShadowReach ?? group.shadowReach,
  );
  const maskId = state.groupToMaskId[groupId];
  if (!maskId) return state;

  const nextMaskMap = new Int32Array(state.maskMap);
  for (let i = 0; i < nextMaskMap.length; i++) {
    if (nextMaskMap[i] === maskId) {
      nextMaskMap[i] = 0;
    }
  }

  if (group.selectionKind === "global") {
    const res = runGlobalColorMatch({
      prepared,
      maskMap: nextMaskMap,
      seedIndex: seeds[seeds.length - 1],
      writeMaskValue: maskId,
      tolerance: clampedTol,
    });
    if (res.pixelCount === 0) {
      return state;
    }
  } else {
    let filledAny = false;
    for (const sIdx of seeds) {
      const fill = runEdgeAwareHsvFloodFill({
        prepared,
        maskMap: nextMaskMap,
        seedIndex: sIdx,
        writeMaskValue: maskId,
        tolerance: clampedTol,
        shadowReach: clampedShadow,
      });
      if (fill.pixelCount > 0) filledAny = true;
    }
    if (!filledAny) {
      return state;
    }
  }

  const totalPixels = prepared.width * prepared.height;
  const rawBinary = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (nextMaskMap[i] === maskId) {
      rawBinary[i] = 255;
    }
  }

  const primarySeed = seeds[seeds.length - 1];
  const smoothedMask = smoothSelectionMask3D({
    mask: rawBinary,
    prepared,
    seedHue: prepared.hue[primarySeed],
    seedIsChromatic: prepared.chroma[primarySeed] >= 0.09,
    guardDarkOutlines: prepared.lum[primarySeed] >= 0.14,
    canTouch: (i) => state.maskMap[i] === 0 || state.maskMap[i] === maskId,
  });

  const clearedBase: Recolor3DState = {
    ...state,
    maskMap: nextMaskMap,
    coverageMap: new Uint8Array(state.coverageMap),
  };
  for (let i = 0; i < totalPixels; i++) {
    if (state.maskMap[i] === maskId && nextMaskMap[i] !== maskId) {
      clearedBase.coverageMap[i] = 0;
    }
  }

  const merged = commitSmoothedMaskForGroup({
    state: clearedBase,
    prepared,
    targetMaskId: maskId,
    smoothedMask,
  });

  const updatedState: Recolor3DState = {
    ...state,
    maskMap: merged.maskMap,
    coverageMap: merged.coverageMap,
  };
  const nextGroups = recalculateGroupStats(
    updatedState,
    prepared,
    new Set([maskId]),
  ).map((item) =>
    item.groupId === groupId
      ? {
          ...item,
          tolerance: clampedTol,
          shadowReach: clampedShadow,
        }
      : item,
  );

  return {
    ...updatedState,
    groups: nextGroups,
  };
}

/**
 * Applies a continuous Mask Brush (add to active group) or Eraser (remove from mask)
 * along a sequence of canvas coordinates:
 * - brushMode = "smart" (default): each sample point along the swipe runs local
 *   edge-aware flood-fill according to the touched fold color and stops hard at dark outline walls.
 * - brushMode = "manual": stamps freeform circles ignoring outline barriers.
 * Both finish with hole-fill + 0-255 soft edge smoothing.
 */
export function applyBrushStroke3D(params: {
  state: Recolor3DState;
  prepared: Prepared3DImage;
  groupId: string | null;
  mode: "brush" | "eraser";
  points: Point2D[];
  radius: number;
  brushMode?: BrushMode3D;
  tolerance?: number;
  shadowReach?: number;
}): { state: Recolor3DState; activeGroupId: string | null } {
  const { state, prepared, mode, points, radius } = params;
  const brushMode: BrushMode3D = params.brushMode ?? "smart";

  if (points.length === 0 || prepared.width <= 0 || prepared.height <= 0) {
    return { state, activeGroupId: params.groupId };
  }

  const safeRadius = Math.max(2, Math.min(64, radius));
  const rSq = safeRadius * safeRadius;
  const width = prepared.width;
  const height = prepared.height;
  const totalPixels = width * height;

  let workingState = state;
  let targetGroupId = params.groupId;

  // Build interpolated center points along stroke
  const interpolatedPts: Array<{ x: number; y: number }> = [];
  const stepDist =
    mode === "brush" && brushMode === "smart"
      ? Math.max(1, Math.min(2.5, safeRadius * 0.25))
      : Math.max(1, safeRadius * 0.35);

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    if (i === 0) {
      interpolatedPts.push(curr);
      continue;
    }
    const prev = points[i - 1];
    const dist = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const steps = Math.max(1, Math.ceil(dist / stepDist));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      interpolatedPts.push({
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t,
      });
    }
  }

  // If painting with Brush and no group exists/is selected, create a new group seeded at first valid non-outline point
  if (mode === "brush" && !targetGroupId) {
    let seedIdx = -1;
    for (const pt of interpolatedPts) {
      const fx = Math.round(pt.x);
      const fy = Math.round(pt.y);
      if (fx < 0 || fx >= width || fy < 0 || fy >= height) continue;
      const idx = fy * width + fx;
      if (prepared.rgba[idx * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;
      if (
        brushMode === "smart" &&
        isDarkOutlinePixel(prepared.lum[idx], prepared.hslSat[idx])
      ) {
        continue;
      }
      seedIdx = idx;
      break;
    }

    if (seedIdx === -1) {
      return { state, activeGroupId: params.groupId };
    }

    const off = seedIdx * 4;
    const seq = workingState.nextGroupSeq;
    const maskId = workingState.nextMaskId;
    const newGroupId = `group3d-${seq}`;
    const r = prepared.rgba[off];
    const g = prepared.rgba[off + 1];
    const b = prepared.rgba[off + 2];
    const seedHex = rgbToHex(r, g, b);
    const rgb = hexToRgb(seedHex);

    const activeTol = clampTolerance(params.tolerance ?? DEFAULT_3D_TOLERANCE);
    const activeShadow = clampShadowReach(params.shadowReach);

    workingState = {
      ...workingState,
      groups: [
        ...workingState.groups,
        {
          groupId: newGroupId,
          name: `Area ${seq}`,
          targetHex: seedHex,
          r: rgb.r,
          g: rgb.g,
          b: rgb.b,
          seedHex,
          pixelCount: 0,
          tolerance: activeTol,
          shadowReach: activeShadow,
          mask: new Uint8Array(totalPixels),
          lastSeedIndex: null,
          seedIndices: [],
          selectionKind: "brush",
          isNeutral: prepared.hslSat[seedIdx] < NEUTRAL_SAT_THRESHOLD,
        },
      ],
      groupToMaskId: {
        ...workingState.groupToMaskId,
        [newGroupId]: maskId,
      },
      nextGroupSeq: seq + 1,
      nextMaskId: maskId + 1,
    };
    targetGroupId = newGroupId;
  }

  const targetGroup = targetGroupId
    ? workingState.groups.find((g) => g.groupId === targetGroupId)
    : undefined;
  const targetMaskId = targetGroupId
    ? workingState.groupToMaskId[targetGroupId] ?? 0
    : 0;

  if (mode === "brush" && targetMaskId <= 0) {
    return { state, activeGroupId: params.groupId };
  }

  const nextMaskMap = new Int32Array(workingState.maskMap);
  const nextCoverageMap = new Uint8Array(workingState.coverageMap);
  const changedMaskIds = new Set<number>();
  if (targetMaskId > 0) changedMaskIds.add(targetMaskId);
  let modified = false;

  if (mode === "eraser") {
    const stampErase = (cx: number, cy: number) => {
      const minX = Math.max(0, Math.floor(cx - safeRadius));
      const maxX = Math.min(width - 1, Math.ceil(cx + safeRadius));
      const minY = Math.max(0, Math.floor(cy - safeRadius));
      const maxY = Math.min(height - 1, Math.ceil(cy + safeRadius));

      for (let y = minY; y <= maxY; y++) {
        const dy = y - cy;
        const dySq = dy * dy;
        const rowBase = y * width;
        for (let x = minX; x <= maxX; x++) {
          const dx = x - cx;
          if (dx * dx + dySq > rSq) continue;

          const idx = rowBase + x;
          const prevMid = nextMaskMap[idx];
          if (prevMid === 0) continue;

          if (targetMaskId > 0) {
            if (prevMid === targetMaskId) {
              nextMaskMap[idx] = 0;
              nextCoverageMap[idx] = 0;
              modified = true;
            }
          } else {
            changedMaskIds.add(prevMid);
            nextMaskMap[idx] = 0;
            nextCoverageMap[idx] = 0;
            modified = true;
          }
        }
      }
    };

    for (const pt of interpolatedPts) {
      stampErase(pt.x, pt.y);
    }

    if (!modified) {
      return { state, activeGroupId: params.groupId };
    }

    const erasedState: Recolor3DState = {
      ...workingState,
      maskMap: nextMaskMap,
      coverageMap: nextCoverageMap,
    };
    const nextGroups = recalculateGroupStats(
      erasedState,
      prepared,
      changedMaskIds,
    );
    const nextGroupToMaskId: Record<string, number> = {};
    for (const grp of nextGroups) {
      nextGroupToMaskId[grp.groupId] = erasedState.groupToMaskId[grp.groupId];
    }

    const survivingActive =
      targetGroupId && nextGroups.some((g) => g.groupId === targetGroupId)
        ? targetGroupId
        : null;

    return {
      state: {
        ...erasedState,
        groups: nextGroups,
        groupToMaskId: nextGroupToMaskId,
      },
      activeGroupId: survivingActive,
    };
  }

  // mode === "brush"
  const activeTol = clampTolerance(
    params.tolerance ?? targetGroup?.tolerance ?? DEFAULT_3D_TOLERANCE,
  );
  const activeShadow = clampShadowReach(
    params.shadowReach ?? targetGroup?.shadowReach,
  );
  let lastValidSampleIdx = -1;

  if (brushMode === "smart") {
    // Smart Edge-Aware Brush: each point along stroke runs local flood-fill stopped by black outlines
    for (const pt of interpolatedPts) {
      const ix = Math.floor(pt.x);
      const iy = Math.floor(pt.y);
      if (ix < 0 || ix >= width || iy < 0 || iy >= height) continue;

      const idx = iy * width + ix;
      if (prepared.rgba[idx * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;

      // Never seed onto or fill dark ink outline walls
      if (isDarkOutlinePixel(prepared.lum[idx], prepared.hslSat[idx])) continue;

      // Skip already-filled pocket interior cleanly (fast O(1) path)
      if (nextMaskMap[idx] === targetMaskId && nextCoverageMap[idx] >= 200) {
        continue;
      }

      const prevMid = nextMaskMap[idx];
      const allowOverwrite =
        prevMid > 0 && prevMid !== targetMaskId ? prevMid : undefined;
      if (allowOverwrite) changedMaskIds.add(allowOverwrite);

      const fill = runEdgeAwareHsvFloodFill({
        prepared,
        maskMap: nextMaskMap,
        seedIndex: idx,
        writeMaskValue: targetMaskId,
        tolerance: activeTol,
        shadowReach: activeShadow,
        allowOverwriteMaskId: allowOverwrite,
      });

      if (fill.pixelCount > 0) {
        modified = true;
        lastValidSampleIdx = idx;
      }
    }
  } else {
    // Manual Brush: freeform circle painting ignoring outline barriers
    const stampManual = (cx: number, cy: number) => {
      const minX = Math.max(0, Math.floor(cx - safeRadius));
      const maxX = Math.min(width - 1, Math.ceil(cx + safeRadius));
      const minY = Math.max(0, Math.floor(cy - safeRadius));
      const maxY = Math.min(height - 1, Math.ceil(cy + safeRadius));

      for (let y = minY; y <= maxY; y++) {
        const dy = y - cy;
        const dySq = dy * dy;
        const rowBase = y * width;
        for (let x = minX; x <= maxX; x++) {
          const dx = x - cx;
          if (dx * dx + dySq > rSq) continue;

          const idx = rowBase + x;
          if (prepared.rgba[idx * 4 + 3] <= ALPHA_VISIBLE_THRESHOLD) continue;

          if (nextMaskMap[idx] !== targetMaskId) {
            if (nextMaskMap[idx] > 0) changedMaskIds.add(nextMaskMap[idx]);
            nextMaskMap[idx] = targetMaskId;
            modified = true;
            lastValidSampleIdx = idx;
          }
        }
      }
    };

    for (const pt of interpolatedPts) {
      stampManual(pt.x, pt.y);
    }
  }

  if (!modified) {
    return { state, activeGroupId: params.groupId };
  }

  const rawGroupBinary = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (nextMaskMap[i] === targetMaskId) {
      rawGroupBinary[i] = 255;
    }
  }

  const refIdx =
    lastValidSampleIdx >= 0
      ? lastValidSampleIdx
      : targetGroup?.lastSeedIndex ?? 0;

  const smoothedMask = smoothSelectionMask3D({
    mask: rawGroupBinary,
    prepared,
    seedHue: prepared.hue[refIdx],
    seedIsChromatic:
      brushMode === "smart" && prepared.chroma[refIdx] >= 0.09,
    guardDarkOutlines: brushMode === "smart",
    canTouch: (i) => nextMaskMap[i] === 0 || nextMaskMap[i] === targetMaskId,
  });

  const merged = commitSmoothedMaskForGroup({
    state: {
      ...workingState,
      maskMap: nextMaskMap,
      coverageMap: nextCoverageMap,
    },
    prepared,
    targetMaskId,
    smoothedMask,
  });

  const nextState: Recolor3DState = {
    ...workingState,
    maskMap: merged.maskMap,
    coverageMap: merged.coverageMap,
  };
  const nextGroups = recalculateGroupStats(
    nextState,
    prepared,
    changedMaskIds,
  );
  const nextGroupToMaskId: Record<string, number> = {};
  for (const grp of nextGroups) {
    nextGroupToMaskId[grp.groupId] = nextState.groupToMaskId[grp.groupId];
  }

  const survivingActive =
    targetGroupId && nextGroups.some((g) => g.groupId === targetGroupId)
      ? targetGroupId
      : null;

  return {
    state: {
      ...nextState,
      groups: nextGroups,
      groupToMaskId: nextGroupToMaskId,
    },
    activeGroupId: survivingActive,
  };
}

export function renameGroup3D(
  state: Recolor3DState,
  groupId: string,
  newName: string,
): Recolor3DState {
  const cleanName = newName.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!cleanName) return state;

  const target = state.groups.find((g) => g.groupId === groupId);
  if (!target || target.name === cleanName) return state;

  return {
    ...state,
    groups: state.groups.map((group) =>
      group.groupId === groupId ? { ...group, name: cleanName } : group,
    ),
  };
}

export function updateGroupColor3D(
  state: Recolor3DState,
  groupId: string,
  newHex: string,
): Recolor3DState {
  const normalized = normalizeHexColor(newHex);
  if (!normalized) return state;

  const target = state.groups.find((g) => g.groupId === groupId);
  if (!target || target.targetHex === normalized) return state;

  const rgb = hexToRgb(normalized);
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.groupId === groupId
        ? { ...group, targetHex: normalized, r: rgb.r, g: rgb.g, b: rgb.b }
        : group,
    ),
  };
}

export function mergeGroups3D(
  state: Recolor3DState,
  sourceGroupId: string,
  targetGroupId: string,
  prepared?: Prepared3DImage,
): Recolor3DState {
  if (sourceGroupId === targetGroupId) return state;

  const source = state.groups.find((g) => g.groupId === sourceGroupId);
  const target = state.groups.find((g) => g.groupId === targetGroupId);
  if (!source || !target) return state;

  const sourceMaskId = state.groupToMaskId[sourceGroupId];
  const targetMaskId = state.groupToMaskId[targetGroupId];
  if (!sourceMaskId || !targetMaskId) return state;

  const nextMaskMap = new Int32Array(state.maskMap);
  const nextCoverageMap = new Uint8Array(state.coverageMap);
  const mergedMask = new Uint8Array(nextMaskMap.length);
  for (let i = 0; i < nextMaskMap.length; i++) {
    if (nextMaskMap[i] === sourceMaskId) {
      nextMaskMap[i] = targetMaskId;
    }
    if (nextMaskMap[i] === targetMaskId) {
      mergedMask[i] = nextCoverageMap[i];
    }
  }

  const preserveSourceCustomName =
    DEFAULT_3D_GROUP_NAME_REGEX.test(target.name) &&
    !DEFAULT_3D_GROUP_NAME_REGEX.test(source.name);
  const resolvedName = preserveSourceCustomName ? source.name : target.name;

  const nextGroupToMaskId = { ...state.groupToMaskId };
  delete nextGroupToMaskId[sourceGroupId];

  const baseState: Recolor3DState = {
    ...state,
    maskMap: nextMaskMap,
    coverageMap: nextCoverageMap,
    groupToMaskId: nextGroupToMaskId,
    groups: state.groups
      .filter((g) => g.groupId !== sourceGroupId)
      .map((g) =>
        g.groupId === targetGroupId
          ? {
              ...g,
              name: resolvedName,
              mask: mergedMask,
              pixelCount: target.pixelCount + source.pixelCount,
              seedIndices: Array.from(
                new Set([...target.seedIndices, ...source.seedIndices]),
              ),
              lastSeedIndex:
                source.lastSeedIndex ?? target.lastSeedIndex,
            }
          : g,
      ),
  };

  if (prepared) {
    return {
      ...baseState,
      groups: recalculateGroupStats(
        baseState,
        prepared,
        new Set([targetMaskId]),
      ),
    };
  }
  return baseState;
}

export function deleteGroup3D(
  state: Recolor3DState,
  groupId: string,
): Recolor3DState {
  const maskId = state.groupToMaskId[groupId];
  const target = state.groups.find((g) => g.groupId === groupId);
  if (!maskId || !target) return state;

  const nextMaskMap = new Int32Array(state.maskMap);
  const nextCoverageMap = new Uint8Array(state.coverageMap);
  for (let i = 0; i < nextMaskMap.length; i++) {
    if (nextMaskMap[i] === maskId) {
      nextMaskMap[i] = 0;
      nextCoverageMap[i] = 0;
    }
  }

  const nextGroupToMaskId = { ...state.groupToMaskId };
  delete nextGroupToMaskId[groupId];

  return {
    ...state,
    maskMap: nextMaskMap,
    coverageMap: nextCoverageMap,
    groupToMaskId: nextGroupToMaskId,
    groups: state.groups.filter((g) => g.groupId !== groupId),
  };
}

// ---------------------------------------------------------------------------
// 2-Stage Non-Destructive Multi-Select Candidates for Mode 3D
// ---------------------------------------------------------------------------

export function toggleCandidatePoint3D(params: {
  state: Recolor3DState;
  prepared: Prepared3DImage;
  candidates: CandidateSelection3D[];
  seedX: number;
  seedY: number;
  tolerance?: number;
  shadowReach?: number;
  nextCandidateSeq: number;
}): {
  candidates: CandidateSelection3D[];
  nextCandidateSeq: number;
  action: "added" | "removed" | "ignored";
} {
  const { state, prepared, candidates, seedX, seedY, nextCandidateSeq } = params;
  const clampedTol = clampTolerance(params.tolerance ?? DEFAULT_3D_TOLERANCE);
  const clampedShadow = clampShadowReach(params.shadowReach);

  const ix = Math.floor(seedX);
  const iy = Math.floor(seedY);
  if (ix < 0 || ix >= prepared.width || iy < 0 || iy >= prepared.height) {
    return { candidates, nextCandidateSeq, action: "ignored" };
  }

  const seedIndex = iy * prepared.width + ix;
  const seedOff = seedIndex * 4;
  if (prepared.rgba[seedOff + 3] <= ALPHA_VISIBLE_THRESHOLD) {
    return { candidates, nextCandidateSeq, action: "ignored" };
  }

  // 1) If tap hits an existing flood candidate, remove it (undo accidental tap)
  for (const cand of candidates) {
    if (cand.kind === "flood" && cand.pixelIndices.includes(seedIndex)) {
      return {
        candidates: candidates.filter((c) => c.candidateId !== cand.candidateId),
        nextCandidateSeq,
        action: "removed",
      };
    }
  }

  // 2) If tap hits an already-committed group, toggle that group in/out of candidates
  const hitGroupId = findGroupAtPixel3D(state, ix, iy);
  if (hitGroupId) {
    const existingEntry = candidates.find(
      (c) => c.kind === "group" && c.existingGroupId === hitGroupId,
    );
    if (existingEntry) {
      return {
        candidates: candidates.filter(
          (c) => c.candidateId !== existingEntry.candidateId,
        ),
        nextCandidateSeq,
        action: "removed",
      };
    }

    const grp = state.groups.find((g) => g.groupId === hitGroupId);
    if (!grp) {
      return { candidates, nextCandidateSeq, action: "ignored" };
    }

    return {
      candidates: [
        ...candidates,
        {
          candidateId: nextCandidateSeq,
          kind: "group",
          seedX: ix,
          seedY: iy,
          seedIndex,
          seedHex: grp.targetHex,
          tolerance: grp.tolerance,
          shadowReach: grp.shadowReach,
          isNeutral: grp.isNeutral,
          pixelCount: grp.pixelCount,
          pixelIndices: new Int32Array(0),
          pixelCoverages: new Uint8Array(0),
          existingGroupId: hitGroupId,
        },
      ],
      nextCandidateSeq: nextCandidateSeq + 1,
      action: "added",
    };
  }

  // 3) Unmasked 3D pixel -> run flood-fill + smoothing on temporary scratch mask
  const totalPixels = prepared.width * prepared.height;
  const scratchMask = new Int32Array(state.maskMap);
  for (const cand of candidates) {
    if (cand.kind !== "flood") continue;
    const idxs = cand.pixelIndices;
    for (let i = 0; i < idxs.length; i++) {
      scratchMask[idxs[i]] = -1;
    }
  }

  const candidateWriteMask = state.nextMaskId + 10000;
  const fill = runEdgeAwareHsvFloodFill({
    prepared,
    maskMap: scratchMask,
    seedIndex,
    writeMaskValue: candidateWriteMask,
    tolerance: clampedTol,
    shadowReach: clampedShadow,
  });

  if (fill.pixelCount === 0) {
    return { candidates, nextCandidateSeq, action: "ignored" };
  }

  const rawBinary = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (scratchMask[i] === candidateWriteMask) rawBinary[i] = 255;
  }

  const smoothed = smoothSelectionMask3D({
    mask: rawBinary,
    prepared,
    seedHue: prepared.hue[seedIndex],
    seedIsChromatic: prepared.chroma[seedIndex] >= 0.09,
    guardDarkOutlines: prepared.lum[seedIndex] >= 0.14,
    canTouch: (i) => scratchMask[i] === 0 || scratchMask[i] === candidateWriteMask,
  });

  let smoothCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (smoothed[i] > 0) smoothCount++;
  }

  const pixelIndices = new Int32Array(smoothCount);
  const pixelCoverages = new Uint8Array(smoothCount);
  let cursor = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (smoothed[i] > 0) {
      pixelIndices[cursor] = i;
      pixelCoverages[cursor] = smoothed[i];
      cursor++;
    }
  }

  const seedHex = rgbToHex(
    prepared.rgba[seedOff],
    prepared.rgba[seedOff + 1],
    prepared.rgba[seedOff + 2],
  );

  return {
    candidates: [
      ...candidates,
      {
        candidateId: nextCandidateSeq,
        kind: "flood",
        seedX: ix,
        seedY: iy,
        seedIndex,
        seedHex,
        tolerance: clampedTol,
        shadowReach: clampedShadow,
        isNeutral: fill.avgHslSat < NEUTRAL_SAT_THRESHOLD,
        pixelCount: smoothCount,
        pixelIndices,
        pixelCoverages,
        existingGroupId: null,
      },
    ],
    nextCandidateSeq: nextCandidateSeq + 1,
    action: "added",
  };
}

/**
 * Confirms all collected temporary 3D multi-select candidates into a single
 * Recolor3DGroup atomically (creating 1 Undo/Redo history step on commit).
 */
export function commitCandidateSelection3D(params: {
  state: Recolor3DState;
  prepared: Prepared3DImage;
  candidates: CandidateSelection3D[];
}): { state: Recolor3DState; groupId: string | null } {
  const { state, prepared, candidates } = params;
  if (candidates.length === 0) {
    return { state, groupId: null };
  }

  const groupCands = candidates.filter(
    (c) =>
      c.kind === "group" &&
      c.existingGroupId !== null &&
      Boolean(state.groupToMaskId[c.existingGroupId]),
  );
  const floodCands = candidates.filter(
    (c) => c.kind === "flood" && c.pixelIndices.length > 0,
  );

  if (groupCands.length === 0 && floodCands.length === 0) {
    return { state, groupId: null };
  }

  const totalPixels = prepared.width * prepared.height;

  // Case A: At least one existing committed group is part of the selection
  if (groupCands.length > 0) {
    const primaryGroupId = groupCands[0].existingGroupId!;
    if (groupCands.length === 1 && floodCands.length === 0) {
      return { state, groupId: primaryGroupId };
    }

    let working = state;
    for (let i = 1; i < groupCands.length; i++) {
      const otherGid = groupCands[i].existingGroupId!;
      if (otherGid !== primaryGroupId) {
        working = mergeGroups3D(working, otherGid, primaryGroupId, prepared);
      }
    }

    if (floodCands.length > 0) {
      const targetMaskId = working.groupToMaskId[primaryGroupId];
      if (!targetMaskId) {
        return { state: working, groupId: primaryGroupId };
      }

      const nextMaskMap = new Int32Array(working.maskMap);
      const nextCoverageMap = new Uint8Array(working.coverageMap);
      const extraSeeds: number[] = [];
      for (const cand of floodCands) {
        extraSeeds.push(cand.seedIndex);
        for (let i = 0; i < cand.pixelIndices.length; i++) {
          const pIdx = cand.pixelIndices[i];
          const cov = cand.pixelCoverages[i] ?? 255;
          if (nextMaskMap[pIdx] === 0) {
            nextMaskMap[pIdx] = targetMaskId;
            nextCoverageMap[pIdx] = cov;
          } else if (nextMaskMap[pIdx] === targetMaskId) {
            nextCoverageMap[pIdx] = Math.max(nextCoverageMap[pIdx], cov);
          }
        }
      }

      const withPixels: Recolor3DState = {
        ...working,
        maskMap: nextMaskMap,
        coverageMap: nextCoverageMap,
      };
      const syncedGroups = recalculateGroupStats(
        withPixels,
        prepared,
        new Set([targetMaskId]),
      ).map((g) => {
        if (g.groupId !== primaryGroupId) return g;
        const combinedSeeds = Array.from(
          new Set([...g.seedIndices, ...extraSeeds]),
        );
        return {
          ...g,
          seedIndices: combinedSeeds,
          lastSeedIndex:
            extraSeeds[extraSeeds.length - 1] ?? g.lastSeedIndex,
          selectionKind: "flood" as const,
        };
      });

      working = {
        ...withPixels,
        groups: syncedGroups,
      };
    }

    return { state: working, groupId: primaryGroupId };
  }

  // Case B: Brand-new merged group formed from 1+ flood candidates
  const seq = state.nextGroupSeq;
  const maskId = state.nextMaskId;
  const groupId = `group3d-${seq}`;
  const first = floodCands[0];

  const nextMaskMap = new Int32Array(state.maskMap);
  const nextCoverageMap = new Uint8Array(state.coverageMap);
  const groupMask = new Uint8Array(totalPixels);
  const seedIndices: number[] = [];
  let painted = 0;

  for (const cand of floodCands) {
    seedIndices.push(cand.seedIndex);
    for (let i = 0; i < cand.pixelIndices.length; i++) {
      const pIdx = cand.pixelIndices[i];
      const cov = cand.pixelCoverages[i] ?? 255;
      if (nextMaskMap[pIdx] === 0) {
        nextMaskMap[pIdx] = maskId;
        nextCoverageMap[pIdx] = cov;
        groupMask[pIdx] = cov;
        painted++;
      } else if (nextMaskMap[pIdx] === maskId && cov > groupMask[pIdx]) {
        nextCoverageMap[pIdx] = cov;
        groupMask[pIdx] = cov;
      }
    }
  }

  if (painted === 0) {
    return { state, groupId: null };
  }

  const firstOff = first.seedIndex * 4;
  const r = prepared.rgba[firstOff];
  const g = prepared.rgba[firstOff + 1];
  const b = prepared.rgba[firstOff + 2];
  const seedHex = rgbToHex(r, g, b);

  const prelimState: Recolor3DState = {
    ...state,
    groups: [
      ...state.groups,
      {
        groupId,
        name: `Area ${seq}`,
        targetHex: seedHex,
        r,
        g,
        b,
        seedHex,
        pixelCount: painted,
        tolerance: first.tolerance,
        shadowReach: first.shadowReach,
        mask: groupMask,
        lastSeedIndex: first.seedIndex,
        seedIndices: Array.from(new Set(seedIndices)),
        selectionKind: "flood",
        isNeutral: first.isNeutral,
      },
    ],
    maskMap: nextMaskMap,
    coverageMap: nextCoverageMap,
    groupToMaskId: {
      ...state.groupToMaskId,
      [groupId]: maskId,
    },
    nextGroupSeq: seq + 1,
    nextMaskId: maskId + 1,
  };

  return {
    state: {
      ...prelimState,
      groups: recalculateGroupStats(prelimState, prepared, new Set([maskId])),
    },
    groupId,
  };
}

export function applyPaletteTo3DState(
  state: Recolor3DState,
  paletteHexes: string[],
): Recolor3DState {
  if (paletteHexes.length === 0 || state.groups.length === 0) {
    return state;
  }

  const normalizedPalette = paletteHexes
    .map((h) => normalizeHexColor(h))
    .filter((h): h is string => h !== null);

  if (normalizedPalette.length === 0) return state;

  const rankedGroupIds = [...state.groups]
    .sort((a, b) => b.pixelCount - a.pixelCount)
    .map((g) => g.groupId);

  let next = state;
  for (let i = 0; i < rankedGroupIds.length; i++) {
    const hex = normalizedPalette[i % normalizedPalette.length];
    next = updateGroupColor3D(next, rankedGroupIds[i], hex);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Immutable Undo / Redo History for Mode 3D
// ---------------------------------------------------------------------------

export function create3DHistory(
  initial: Recolor3DState,
  maxSteps: number = DEFAULT_3D_MAX_HISTORY_STEPS,
): Recolor3DHistory {
  return {
    past: [],
    present: initial,
    future: [],
    maxSteps: Math.max(20, maxSteps),
  };
}

export function commit3DChange(
  history: Recolor3DHistory,
  nextPresent: Recolor3DState,
  coalesceKey?: string,
): Recolor3DHistory {
  if (nextPresent === history.present) {
    return history;
  }

  const now = Date.now();
  const canCoalesce =
    Boolean(coalesceKey) &&
    history.lastCoalesceKey === coalesceKey &&
    typeof history.lastCoalesceAt === "number" &&
    now - history.lastCoalesceAt < 650 &&
    history.past.length > 0;

  if (canCoalesce) {
    return {
      ...history,
      present: nextPresent,
      future: [],
      lastCoalesceKey: coalesceKey,
      lastCoalesceAt: now,
    };
  }

  const nextPast = [...history.past, history.present];
  const trimmedPast =
    nextPast.length > history.maxSteps
      ? nextPast.slice(nextPast.length - history.maxSteps)
      : nextPast;

  return {
    ...history,
    past: trimmedPast,
    present: nextPresent,
    future: [],
    lastCoalesceKey: coalesceKey,
    lastCoalesceAt: coalesceKey ? now : undefined,
  };
}

export function undo3D(history: Recolor3DHistory): Recolor3DHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastCoalesceKey: undefined,
    lastCoalesceAt: undefined,
  };
}

export function redo3D(history: Recolor3DHistory): Recolor3DHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    ...history,
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
    lastCoalesceKey: undefined,
    lastCoalesceAt: undefined,
  };
}

// ---------------------------------------------------------------------------
// Live Preview & Final HD Recolor Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the clean final Luminance-Preserving recolored 3D ImageData
 * (with original smooth alpha preserved and zero selection highlights/dimming).
 */
export function render3DExportImageData(
  prepared: Prepared3DImage,
  state: Recolor3DState,
): ImageData {
  return render3DCanvasImageData({
    prepared,
    state,
    mode: "live",
    selectedGroupId: null,
  });
}

/**
 * Renders fast interactive 3D Canvas ImageData for Live Preview, Original,
 * or Selection Mask Overlay with #14F1D9 boundary highlight on selected group.
 */
export function render3DCanvasImageData(params: {
  prepared: Prepared3DImage;
  state: Recolor3DState;
  mode: Recolor3DPreviewMode;
  selectedGroupId: string | null;
  candidates?: CandidateSelection3D[] | null;
}): ImageData {
  const { prepared, state, mode, selectedGroupId, candidates } = params;
  const { width, height, rgba } = prepared;
  const totalPixels = width * height;
  const out = new Uint8ClampedArray(rgba);

  if (width <= 0 || height <= 0 || totalPixels === 0) {
    return new ImageData(out, Math.max(1, width), Math.max(1, height));
  }

  if (mode === "solid") {
    return new ImageData(out, width, height);
  }

  const { maskMap, coverageMap } = state;
  const maxMaskId = Math.max(
    0,
    ...state.groups.map((g) => state.groupToMaskId[g.groupId] ?? 0),
  );
  const maskGroupLut = new Array<Recolor3DGroup | undefined>(maxMaskId + 1);
  const overlayColors = new Array<[number, number, number] | undefined>(
    maxMaskId + 1,
  );

  for (const group of state.groups) {
    const mid = state.groupToMaskId[group.groupId];
    if (mid > 0) {
      maskGroupLut[mid] = group;
      if (mode === "region-map") {
        const hue = (mid * 137.508) % 360;
        overlayColors[mid] = hslToRgb(hue, 0.85, 0.58);
      }
    }
  }

  const hasCandidates = Boolean(candidates && candidates.length > 0);
  const candidateLut = hasCandidates ? new Uint8Array(totalPixels) : null;
  const candidateGroupMaskIds = new Set<number>();

  if (candidateLut && candidates) {
    for (const cand of candidates) {
      if (cand.kind === "flood") {
        const idxs = cand.pixelIndices;
        for (let i = 0; i < idxs.length; i++) {
          candidateLut[idxs[i]] = 1;
        }
      } else if (cand.existingGroupId) {
        const mid = state.groupToMaskId[cand.existingGroupId];
        if (mid > 0) candidateGroupMaskIds.add(mid);
      }
    }
    if (candidateGroupMaskIds.size > 0) {
      for (let i = 0; i < totalPixels; i++) {
        if (candidateGroupMaskIds.has(maskMap[i]) && coverageMap[i] > 0) {
          candidateLut[i] = 1;
        }
      }
    }
  }

  const selectedMaskId =
    !hasCandidates && selectedGroupId !== null
      ? state.groupToMaskId[selectedGroupId] ?? 0
      : 0;
  const hasSelection = hasCandidates || selectedMaskId > 0;

  const isPixelHighlighted = (idx: number): boolean => {
    if (candidateLut) {
      return candidateLut[idx] === 1;
    }
    return (
      selectedMaskId > 0 &&
      maskMap[idx] === selectedMaskId &&
      coverageMap[idx] > 0
    );
  };

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const off = idx * 4;
      const alpha = rgba[off + 3];
      if (alpha === 0) continue;

      const mid = maskMap[idx];
      const cov = mid > 0 ? coverageMap[idx] : 0;
      const grp = mid > 0 && cov > 0 ? maskGroupLut[mid] : undefined;
      const sr = rgba[off];
      const sg = rgba[off + 1];
      const sb = rgba[off + 2];
      const highlighted = hasSelection && isPixelHighlighted(idx);

      if (highlighted) {
        const isEdge =
          x === 0 ||
          y === 0 ||
          x + 1 === width ||
          y + 1 === height ||
          !isPixelHighlighted(idx - 1) ||
          !isPixelHighlighted(idx + 1) ||
          !isPixelHighlighted(idx - width) ||
          !isPixelHighlighted(idx + width);

        if (isEdge) {
          out[off] = 20;
          out[off + 1] = 241;
          out[off + 2] = 217;
          out[off + 3] = Math.max(alpha, 220);
          continue;
        }
      }

      if (mode === "region-map") {
        if (grp && overlayColors[mid]) {
          const [or, og, ob] = overlayColors[mid]!;
          const covNorm = cov / 255;
          const tintFactor = (hasSelection && !highlighted ? 0.22 : 0.48) * covNorm;
          const baseScale = 1 - tintFactor;
          out[off] = Math.round(sr * baseScale + or * tintFactor);
          out[off + 1] = Math.round(sg * baseScale + og * tintFactor);
          out[off + 2] = Math.round(sb * baseScale + ob * tintFactor);
          out[off + 3] = alpha;
        } else if (highlighted) {
          out[off] = Math.round(sr * 0.52 + 20 * 0.48);
          out[off + 1] = Math.round(sg * 0.52 + 241 * 0.48);
          out[off + 2] = Math.round(sb * 0.52 + 217 * 0.48);
          out[off + 3] = alpha;
        } else if (hasSelection) {
          out[off] = Math.round(sr * 0.42 + 8);
          out[off + 1] = Math.round(sg * 0.42 + 10);
          out[off + 2] = Math.round(sb * 0.42 + 14);
          out[off + 3] = alpha;
        }
        continue;
      }

      // Live Preview & Export: Proportional Luminance-Preserving Recolor via Soft Matte (cov / 255)
      let rr = sr;
      let rg = sg;
      let rb = sb;

      if (grp && cov > 0 && grp.targetHex !== grp.seedHex) {
        const [cr, cg, cb] = computeLuminancePreservingRgb(
          sr,
          sg,
          sb,
          grp.r,
          grp.g,
          grp.b,
          grp.isNeutral,
        );
        if (cov >= 255) {
          rr = cr;
          rg = cg;
          rb = cb;
        } else {
          const blend = cov / 255;
          rr = Math.round(sr + (cr - sr) * blend);
          rg = Math.round(sg + (cg - sg) * blend);
          rb = Math.round(sb + (cb - sb) * blend);
        }
      }

      if (hasSelection && !highlighted) {
        out[off] = Math.round(rr * 0.4 + 8);
        out[off + 1] = Math.round(rg * 0.4 + 10);
        out[off + 2] = Math.round(rb * 0.4 + 14);
        out[off + 3] = alpha;
      } else {
        out[off] = rr;
        out[off + 1] = rg;
        out[off + 2] = rb;
        out[off + 3] = alpha;
      }
    }
  }

  return new ImageData(out, width, height);
}
