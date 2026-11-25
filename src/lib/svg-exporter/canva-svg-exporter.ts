import {
  CANVA_FREE_MAX_COLORS,
  normalizeHexColor,
  type ColorGroup,
  type RegionGroupingState,
} from "../image-processor/region-grouper";
import {
  DEFAULT_RDP_EPSILON,
  traceRegionGroupToSvgPath,
} from "./contour-tracer";
import type { ParsedNativeSvgResult } from "./native-svg-parser";

export interface ExportedSvgLayer {
  groupId: string;
  groupName: string;
  fillHex: string;
  subPathCount: number;
  vertexCount: number;
  pathElements: Array<{
    d: string;
    fillRule: "evenodd" | "nonzero";
    transform?: string;
  }>;
}

export interface ExportedSvgFile {
  partIndex: number;
  totalParts: number;
  fileName: string;
  svgString: string;
  byteSize: number;
  uniqueColors: string[];
  layerCount: number;
  hasAlignmentAnchors: boolean;
}

export interface CanvaSvgExportResult {
  files: ExportedSvgFile[];
  totalGroups: number;
  isMultiPartSplit: boolean;
  epsilon: number;
  smoothCurves: boolean;
  isNativeSvgSource: boolean;
  processingTimeMs: number;
}

export interface CanvaValidationReport {
  isValid: boolean;
  errors: string[];
  uniqueFillColors: string[];
  pathCount: number;
}

/**
 * Sanitizes a user file name into a clean lowercase slug for output files.
 */
export function sanitizeExportBaseName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^/.]+$/, "");
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "ilustrasi";
}

function buildAlignmentAnchorSubPaths(
  minX: number,
  minY: number,
  width: number,
  height: number,
): string {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const anchor = Number(Math.min(0.1, w * 0.005, h * 0.005).toFixed(4));
  const x0 = minX;
  const y0 = minY;
  const x1 = Number((minX + anchor).toFixed(4));
  const y1 = Number((minY + anchor).toFixed(4));
  const xMax = Number((minX + w).toFixed(4));
  const yMax = Number((minY + h).toFixed(4));
  const x2 = Number((xMax - anchor).toFixed(4));
  const y2 = Number((yMax - anchor).toFixed(4));

  return `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}ZM${x2} ${y2}L${xMax} ${y2}L${xMax} ${yMax}L${x2} ${yMax}Z`;
}

function chunkLayersForCanvaFree(
  layers: ExportedSvgLayer[],
): ExportedSvgLayer[][] {
  if (layers.length === 0) return [];

  const chunks: ExportedSvgLayer[][] = [];
  let currentChunk: ExportedSvgLayer[] = [];
  let currentColors = new Set<string>();

  for (const layer of layers) {
    const wouldExceedColors =
      !currentColors.has(layer.fillHex) &&
      currentColors.size >= CANVA_FREE_MAX_COLORS;
    const wouldExceedLayerLimit = currentChunk.length >= CANVA_FREE_MAX_COLORS;

    if (wouldExceedColors || wouldExceedLayerLimit) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentColors = new Set<string>();
    }

    currentChunk.push(layer);
    currentColors.add(layer.fillHex);
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function buildVectorLayers(params: {
  regionMap: Int32Array;
  width: number;
  height: number;
  groupingState: RegionGroupingState;
  epsilon: number;
  smoothCurves: boolean;
  nativeSvg?: ParsedNativeSvgResult;
}): {
  layers: ExportedSvgLayer[];
  vbMinX: number;
  vbMinY: number;
  vbWidth: number;
  vbHeight: number;
} {
  const {
    regionMap,
    width,
    height,
    groupingState,
    epsilon,
    smoothCurves,
    nativeSvg,
  } = params;

  const sortedGroups: ColorGroup[] = [...groupingState.groups]
    .filter((g) => g.regionIds.length > 0)
    .sort((a, b) => b.totalPixels - a.totalPixels);

  const layers: ExportedSvgLayer[] = [];

  if (nativeSvg) {
    // Dual-Pipeline Path A: Native SVG passthrough without raster re-tracing
    for (const group of sortedGroups) {
      const hex = normalizeHexColor(group.colorHex) ?? "#000000";
      const orderedIds = [...group.regionIds].sort((a, b) => a - b);

      // Combine non-transformed elements into one compound path, preserving transformed elements cleanly
      const pathElements: ExportedSvgLayer["pathElements"] = [];
      const plainSubPaths: string[] = [];

      for (const rid of orderedIds) {
        const el = nativeSvg.regionToElement[rid];
        if (!el || !el.d) continue;
        if (el.transform) {
          pathElements.push({
            d: el.d,
            fillRule: "evenodd",
            transform: el.transform,
          });
        } else {
          plainSubPaths.push(el.d);
        }
      }

      if (plainSubPaths.length > 0) {
        pathElements.unshift({
          d: plainSubPaths.join(""),
          fillRule: "evenodd",
        });
      }

      if (pathElements.length === 0) continue;

      layers.push({
        groupId: group.groupId,
        groupName: group.name,
        fillHex: hex,
        subPathCount: orderedIds.length,
        vertexCount: orderedIds.length,
        pathElements,
      });
    }

    return {
      layers,
      vbMinX: nativeSvg.viewBox.minX,
      vbMinY: nativeSvg.viewBox.minY,
      vbWidth: nativeSvg.viewBox.width,
      vbHeight: nativeSvg.viewBox.height,
    };
  }

  // Dual-Pipeline Path B: Raster contour tracing + RDP + selective Chaikin smoothing
  for (const group of sortedGroups) {
    const traced = traceRegionGroupToSvgPath({
      regionMap,
      width,
      height,
      regionIds: group.regionIds,
      sourceRegions: groupingState.sourceRegions,
      epsilon,
      smoothCurves,
    });

    if (!traced.d) continue;

    const hex = normalizeHexColor(group.colorHex) ?? "#000000";
    layers.push({
      groupId: group.groupId,
      groupName: group.name,
      fillHex: hex,
      subPathCount: traced.subPathCount,
      vertexCount: traced.vertexCount,
      pathElements: [{ d: traced.d, fillRule: "evenodd" }],
    });
  }

  return {
    layers,
    vbMinX: 0,
    vbMinY: 0,
    vbWidth: width,
    vbHeight: height,
  };
}

function serializeLayersToSvgString(params: {
  layers: ExportedSvgLayer[];
  vbMinX: number;
  vbMinY: number;
  vbWidth: number;
  vbHeight: number;
  anchorSubPaths?: string;
}): string {
  const { layers, vbMinX, vbMinY, vbWidth, vbHeight, anchorSubPaths } = params;
  const pathTags: string[] = [];

  layers.forEach((layer, layerIdx) => {
    layer.pathElements.forEach((p, elIdx) => {
      const shouldAppendAnchor =
        Boolean(anchorSubPaths) && layerIdx === 0 && elIdx === 0 && !p.transform;
      const dAttr = shouldAppendAnchor ? `${p.d}${anchorSubPaths}` : p.d;
      const transformAttr = p.transform ? ` transform="${p.transform}"` : "";
      pathTags.push(
        `  <path fill="${layer.fillHex}" fill-rule="${p.fillRule}"${transformAttr} d="${dAttr}" />`,
      );
    });
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbMinX} ${vbMinY} ${vbWidth} ${vbHeight}" width="${vbWidth}" height="${vbHeight}">`,
    ...pathTags,
    `</svg>`,
  ].join("\n");
}

/**
 * Builds a single unsplit pure-vector SVG containing all active ColorGroups
 * (used as the crisp source for 1x/2x/4x HD PNG & JPG rasterization).
 */
export function buildFullVectorSvgForRender(params: {
  regionMap: Int32Array;
  width: number;
  height: number;
  groupingState: RegionGroupingState;
  epsilon?: number;
  smoothCurves?: boolean;
  nativeSvg?: ParsedNativeSvgResult;
}): {
  svgString: string;
  viewBoxWidth: number;
  viewBoxHeight: number;
} {
  const epsilon = params.epsilon ?? DEFAULT_RDP_EPSILON;
  const smoothCurves = params.smoothCurves ?? true;

  const built = buildVectorLayers({
    regionMap: params.regionMap,
    width: params.width,
    height: params.height,
    groupingState: params.groupingState,
    epsilon,
    smoothCurves,
    nativeSvg: params.nativeSvg,
  });

  const svgString = serializeLayersToSvgString({
    layers: built.layers,
    vbMinX: built.vbMinX,
    vbMinY: built.vbMinY,
    vbWidth: built.vbWidth,
    vbHeight: built.vbHeight,
  });

  return {
    svgString,
    viewBoxWidth: built.vbWidth,
    viewBoxHeight: built.vbHeight,
  };
}

/**
 * Stage 4 (Canva SVG Engine v2): Supports Dual-Pipeline (Native SVG & Raster)
 * and builds 100% pure vector SVG files compliant with Canva Free's 5-color guard.
 */
export function buildCanvaSvgExport(params: {
  regionMap: Int32Array;
  width: number;
  height: number;
  groupingState: RegionGroupingState;
  baseFileName: string;
  epsilon?: number;
  smoothCurves?: boolean;
  nativeSvg?: ParsedNativeSvgResult;
}): CanvaSvgExportResult {
  const startTime =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const { regionMap, width, height, groupingState, baseFileName, nativeSvg } =
    params;
  const epsilon = params.epsilon ?? DEFAULT_RDP_EPSILON;
  const smoothCurves = params.smoothCurves ?? true;
  const safeBaseName = sanitizeExportBaseName(baseFileName);

  const built = buildVectorLayers({
    regionMap,
    width,
    height,
    groupingState,
    epsilon,
    smoothCurves,
    nativeSvg,
  });

  const chunks = chunkLayersForCanvaFree(built.layers);
  const totalParts = chunks.length;
  const isMultiPartSplit = totalParts > 1;
  const anchorSubPaths = isMultiPartSplit
    ? buildAlignmentAnchorSubPaths(
        built.vbMinX,
        built.vbMinY,
        built.vbWidth,
        built.vbHeight,
      )
    : undefined;

  const encoder =
    typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  const files: ExportedSvgFile[] = chunks.map((chunkLayers, idx) => {
    const partIndex = idx + 1;
    const fileName = isMultiPartSplit
      ? `${safeBaseName}-part-${partIndex}-of-${totalParts}.svg`
      : `${safeBaseName}-canva.svg`;

    const svgString = serializeLayersToSvgString({
      layers: chunkLayers,
      vbMinX: built.vbMinX,
      vbMinY: built.vbMinY,
      vbWidth: built.vbWidth,
      vbHeight: built.vbHeight,
      anchorSubPaths,
    });

    const uniqueColors = Array.from(
      new Set(chunkLayers.map((l) => l.fillHex)),
    );
    const byteSize = encoder
      ? encoder.encode(svgString).length
      : svgString.length;

    return {
      partIndex,
      totalParts,
      fileName,
      svgString,
      byteSize,
      uniqueColors,
      layerCount: chunkLayers.length,
      hasAlignmentAnchors: isMultiPartSplit,
    };
  });

  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) -
    startTime;

  return {
    files,
    totalGroups: built.layers.length,
    isMultiPartSplit,
    epsilon,
    smoothCurves,
    isNativeSvgSource: Boolean(nativeSvg),
    processingTimeMs: Math.round(elapsed * 10) / 10,
  };
}

/**
 * Validates an SVG output string against Canva Free compatibility rules.
 */
export function validateCanvaSvgCompliance(
  svgString: string,
): CanvaValidationReport {
  const errors: string[] = [];

  if (/<image\b/i.test(svgString) || /data:image\//i.test(svgString)) {
    errors.push("Mengandung tag raster <image> atau data URL tersembunyi.");
  }
  if (
    /<(linearGradient|radialGradient|filter|feDropShadow|feGaussianBlur)\b/i.test(
      svgString,
    )
  ) {
    errors.push("Mengandung gradien atau filter SVG yang tidak didukung Canva.");
  }
  if (/rgba\(/i.test(svgString)) {
    errors.push("Mengandung nilai rgba() yang tidak kompatibel.");
  }

  const fillMatches = Array.from(
    svgString.matchAll(/<path[^>]*\bfill="([^"]+)"/gi),
  );
  const uniqueFillColors: string[] = [];
  const seen = new Set<string>();

  for (const match of fillMatches) {
    const fillVal = match[1];
    if (!/^#[0-9A-F]{6}$/i.test(fillVal)) {
      errors.push(`Format fill tidak valid untuk Canva: ${fillVal}`);
      continue;
    }
    const upper = fillVal.toUpperCase();
    if (!seen.has(upper)) {
      seen.add(upper);
      uniqueFillColors.push(upper);
    }
  }

  if (uniqueFillColors.length > CANVA_FREE_MAX_COLORS) {
    errors.push(
      `Jumlah warna unik (${uniqueFillColors.length}) melebihi batas maksimal 5 warna Canva Free.`,
    );
  }

  const pathTags = svgString.match(/<path\b[^>]*>/gi) ?? [];
  for (const tag of pathTags) {
    if (!/fill-rule="evenodd"/i.test(tag)) {
      errors.push('Terdapat elemen <path> tanpa fill-rule="evenodd".');
      break;
    }
  }

  return {
    isValid: errors.length === 0 && pathTags.length > 0,
    errors,
    uniqueFillColors,
    pathCount: pathTags.length,
  };
}
