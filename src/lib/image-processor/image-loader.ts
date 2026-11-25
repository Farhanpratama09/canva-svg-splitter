import {
  parseNativeSvg,
  type ParsedNativeSvgResult,
} from "../svg-exporter/native-svg-parser";

export const MAX_IMAGE_DIMENSION = 2048;
export const MAX_BATCH_FILES = 10;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|webp|svg)$/i;
const SVG_EXTENSION = /\.svg$/i;

export interface LoadedImageResult {
  kind: "raster" | "native-svg";
  imageData: ImageData;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasDownscaled: boolean;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  nativeSvg?: ParsedNativeSvgResult;
}

export function isSvgFile(file: File): boolean {
  return (
    file.type.toLowerCase() === "image/svg+xml" || SVG_EXTENSION.test(file.name)
  );
}

/**
 * Validates whether a user-selected File is a supported raster or SVG format.
 */
export function validateImageFile(file: File): string | null {
  if (!file || file.size === 0) {
    return "File gambar kosong atau tidak dapat dibaca.";
  }

  const hasValidMime = (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(
    file.type.toLowerCase(),
  );
  const hasValidExt = SUPPORTED_EXTENSIONS.test(file.name);

  if (!hasValidMime && !hasValidExt) {
    return "Format tidak didukung. Gunakan file PNG, JPG, WEBP, atau SVG.";
  }

  return null;
}

/**
 * Loads a local raster or .svg file completely client-side:
 * - For .svg files: parses DOM XML safely and extracts native vector elements
 *   plus an offscreen regionMap without raster quantization or re-tracing.
 * - For PNG/JPG/WEBP: loads via URL.createObjectURL(), downscales proportionally
 *   if longest side > 2048px, and always revokes the Object URL in finally.
 */
export async function loadImageFromFile(
  file: File,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): Promise<LoadedImageResult> {
  const validationError = validateImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  if (isSvgFile(file)) {
    const svgText = await file.text();
    const parsed = parseNativeSvg(svgText);
    return {
      kind: "native-svg",
      imageData: parsed.imageData,
      width: parsed.width,
      height: parsed.height,
      originalWidth: Math.round(parsed.viewBox.width),
      originalHeight: Math.round(parsed.viewBox.height),
      wasDownscaled: false,
      fileName: file.name,
      fileSizeBytes: file.size,
      mimeType: "image/svg+xml",
      nativeSvg: parsed,
    };
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const img = await decodeImageElement(objectUrl);
    const originalWidth = img.naturalWidth || img.width;
    const originalHeight = img.naturalHeight || img.height;

    if (originalWidth <= 0 || originalHeight <= 0) {
      throw new Error("Dimensi gambar tidak valid.");
    }

    const longestSide = Math.max(originalWidth, originalHeight);
    const wasDownscaled = longestSide > maxDimension;
    const scale = wasDownscaled ? maxDimension / longestSide : 1;

    const targetWidth = Math.max(1, Math.round(originalWidth * scale));
    const targetHeight = Math.max(1, Math.round(originalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Browser gagal membuat konteks HTML5 Canvas 2D.");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

    return {
      kind: "raster",
      imageData,
      width: targetWidth,
      height: targetHeight,
      originalWidth,
      originalHeight,
      wasDownscaled,
      fileName: file.name,
      fileSizeBytes: file.size,
      mimeType: file.type || "image/png",
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function decodeImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("Gagal memuat file gambar. Pastikan file tidak rusak."));
    img.src = src;
  });
}
