import JSZip from "jszip";
import { normalizeHexColor } from "../image-processor/region-grouper";
import { sanitizeExportBaseName } from "./canva-svg-exporter";

export const MAX_HD_RASTER_DIMENSION = 4096;

export type HdScaleFactor = 1 | 2 | 4;
export type HdRasterFormat = "png" | "jpg";
export type ExportFormatOption = "svg" | "png" | "jpg";

export interface HdDimensionsResult {
  width: number;
  height: number;
  effectiveScale: number;
  wasClamped: boolean;
}

export interface ExportedBinaryFile {
  fileName: string;
  blob: Blob;
  byteSize: number;
  width: number;
  height: number;
  format: ExportFormatOption;
}

export interface ZipEntryInput {
  fileName: string;
  content: string | Blob | Uint8Array;
}

/**
 * Computes exact 1x / 2x / 4x HD dimensions clamped safely to 4096px
 * on the longest side to protect mobile browser RAM.
 */
export function computeHdTargetDimensions(
  baseWidth: number,
  baseHeight: number,
  scale: HdScaleFactor,
  maxDimension: number = MAX_HD_RASTER_DIMENSION,
): HdDimensionsResult {
  const safeW = Math.max(1, baseWidth);
  const safeH = Math.max(1, baseHeight);

  const rawW = safeW * scale;
  const rawH = safeH * scale;
  const longest = Math.max(rawW, rawH);
  const wasClamped = longest > maxDimension;

  const clampRatio = wasClamped ? maxDimension / longest : 1;
  const width = Math.max(1, Math.round(rawW * clampRatio));
  const height = Math.max(1, Math.round(rawH * clampRatio));
  const effectiveScale = Number((width / safeW).toFixed(2));

  return {
    width,
    height,
    effectiveScale,
    wasClamped,
  };
}

function loadSvgBlobImage(svgBlobUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("Gagal merender vektor SVG ke kanvas HD."));
    img.src = svgBlobUrl;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Gagal mengonversi kanvas HD menjadi file."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

/**
 * Renders a pure-vector SVG string onto a high-resolution HTML5 Canvas
 * at 1x/2x/4x (max 4096px) and exports a PNG (transparent) or JPG (solid background).
 */
export async function renderSvgToHdRasterFile(params: {
  svgString: string;
  baseWidth: number;
  baseHeight: number;
  baseFileName: string;
  scale: HdScaleFactor;
  format: HdRasterFormat;
  jpgBackgroundHex?: string;
}): Promise<ExportedBinaryFile> {
  const {
    svgString,
    baseWidth,
    baseHeight,
    baseFileName,
    scale,
    format,
    jpgBackgroundHex = "#FFFFFF",
  } = params;

  const dims = computeHdTargetDimensions(baseWidth, baseHeight, scale);
  const safeSlug = sanitizeExportBaseName(baseFileName);
  const fileName = `${safeSlug}-${scale}x-${dims.width}x${dims.height}.${format}`;

  const svgBlob = new Blob([svgString], {
    type: "image/svg+xml;charset=utf-8",
  });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await loadSvgBlobImage(svgUrl);

    const canvas = document.createElement("canvas");
    canvas.width = dims.width;
    canvas.height = dims.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Browser gagal membuat konteks kanvas ekspor HD.");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (format === "jpg") {
      ctx.fillStyle = normalizeHexColor(jpgBackgroundHex) ?? "#FFFFFF";
      ctx.fillRect(0, 0, dims.width, dims.height);
    } else {
      ctx.clearRect(0, 0, dims.width, dims.height);
    }

    ctx.drawImage(img, 0, 0, dims.width, dims.height);

    const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
    const blob = await canvasToBlob(
      canvas,
      mimeType,
      format === "jpg" ? 0.94 : undefined,
    );

    return {
      fileName,
      blob,
      byteSize: blob.size,
      width: dims.width,
      height: dims.height,
      format,
    };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/**
 * Packages multiple exported files (.svg, .png, .jpg) into a single .zip archive
 * completely client-side via JSZip.
 */
export async function createZipArchiveBlob(
  entries: ZipEntryInput[],
): Promise<Blob> {
  const zip = new JSZip();

  // Deduplicate filenames inside the archive gracefully
  const usedNames = new Map<string, number>();

  for (const entry of entries) {
    let finalName = entry.fileName;
    const count = usedNames.get(finalName) ?? 0;
    if (count > 0) {
      const dotIdx = finalName.lastIndexOf(".");
      finalName =
        dotIdx > 0
          ? `${finalName.slice(0, dotIdx)}-${count + 1}${finalName.slice(dotIdx)}`
          : `${finalName}-${count + 1}`;
    }
    usedNames.set(entry.fileName, count + 1);

    zip.file(finalName, entry.content);
  }

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}
