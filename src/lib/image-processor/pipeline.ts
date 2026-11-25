import type { LoadedImageResult } from "./image-loader";
import {
  removeCornerBackground,
  type BackgroundRemovalResult,
} from "./background-remover";
import {
  quantizeAndCleanColors,
  type PaletteColor,
} from "./color-quantizer";
import {
  segmentRegions,
  type RegionInfo,
} from "./region-segmenter";

export interface PipelineParameters {
  bgRemovalEnabled: boolean;
  tolerance: number;
  colorCount: number;
}

export interface UnifiedSegmentationResult {
  kind: "raster" | "native-svg";
  width: number;
  height: number;
  regionMap: Int32Array;
  regions: RegionInfo[];
  palette: PaletteColor[];
  bgRemovalResult: BackgroundRemovalResult | null;
  dominantClusterCount: number;
  isComplexPhoto: boolean;
  absorbedSpeckleCount: number;
  totalTimeMs: number;
}

/**
 * Unified Dual-Pipeline processor:
 * - Native SVG input: bypasses raster quantization & CCL completely, returning
 *   the parsed vector regions & offscreen hit-map directly.
 * - Raster input: executes Stage 1 (Flood-Fill) -> Stage 2 (AA/Quantize) -> Stage 3 (CCL).
 */
export function runUnifiedSegmentationPipeline(
  loaded: LoadedImageResult,
  params: PipelineParameters,
): UnifiedSegmentationResult {
  const startTime =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  if (loaded.kind === "native-svg" && loaded.nativeSvg) {
    const svg = loaded.nativeSvg;
    const paletteMap = new Map<string, PaletteColor>();

    for (const reg of svg.regions) {
      const existing = paletteMap.get(reg.originalHex);
      if (existing) {
        existing.pixelCount += reg.pixelCount;
      } else {
        paletteMap.set(reg.originalHex, {
          hex: reg.originalHex,
          r: reg.r,
          g: reg.g,
          b: reg.b,
          pixelCount: reg.pixelCount,
        });
      }
    }

    const palette = Array.from(paletteMap.values()).sort(
      (a, b) => b.pixelCount - a.pixelCount,
    );

    const elapsed =
      (typeof performance !== "undefined" ? performance.now() : Date.now()) -
      startTime;

    return {
      kind: "native-svg",
      width: svg.width,
      height: svg.height,
      regionMap: svg.regionMap,
      regions: svg.regions,
      palette,
      bgRemovalResult: null,
      dominantClusterCount: palette.length,
      isComplexPhoto: false,
      absorbedSpeckleCount: 0,
      totalTimeMs: Math.round(elapsed * 10) / 10,
    };
  }

  const bgRemovalResult = params.bgRemovalEnabled
    ? removeCornerBackground(loaded.imageData, { tolerance: params.tolerance })
    : null;

  const stage1ImageData = bgRemovalResult
    ? bgRemovalResult.imageData
    : loaded.imageData;

  const quantResult = quantizeAndCleanColors(stage1ImageData, {
    colorCount: params.colorCount,
  });

  const segResult = segmentRegions(quantResult.imageData);

  const totalTimeMs =
    Math.round(
      ((bgRemovalResult?.processingTimeMs ?? 0) +
        quantResult.processingTimeMs +
        segResult.processingTimeMs) *
        10,
    ) / 10;

  return {
    kind: "raster",
    width: segResult.width,
    height: segResult.height,
    regionMap: segResult.regionMap,
    regions: segResult.regions,
    palette: quantResult.palette,
    bgRemovalResult,
    dominantClusterCount: quantResult.dominantClusterCount,
    isComplexPhoto: quantResult.isComplexPhoto,
    absorbedSpeckleCount: segResult.absorbedSpeckleCount,
    totalTimeMs,
  };
}

/**
 * Generates a lightweight 72x72 thumbnail data URL once at import time
 * so the Batch Filmstrip does not retain extra Object URLs.
 */
export function createThumbnailDataUrl(imageData: ImageData): string {
  if (typeof document === "undefined") return "";

  const thumbSize = 72;
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = imageData.width;
  srcCanvas.height = imageData.height;
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) return "";
  srcCtx.putImageData(imageData, 0, 0);

  const dstCanvas = document.createElement("canvas");
  dstCanvas.width = thumbSize;
  dstCanvas.height = thumbSize;
  const dstCtx = dstCanvas.getContext("2d");
  if (!dstCtx) return "";

  const scale = Math.min(
    thumbSize / Math.max(1, imageData.width),
    thumbSize / Math.max(1, imageData.height),
  );
  const dw = Math.max(1, Math.round(imageData.width * scale));
  const dh = Math.max(1, Math.round(imageData.height * scale));
  const dx = Math.floor((thumbSize - dw) / 2);
  const dy = Math.floor((thumbSize - dh) / 2);

  dstCtx.clearRect(0, 0, thumbSize, thumbSize);
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = "medium";
  dstCtx.drawImage(srcCanvas, dx, dy, dw, dh);

  return dstCanvas.toDataURL("image/png");
}
