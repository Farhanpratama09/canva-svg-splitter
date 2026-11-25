import { hexToRgb } from "../image-processor/region-grouper";
import { rgbToHex } from "../image-processor/color-quantizer";
import type { RegionInfo } from "../image-processor/region-segmenter";

export interface SvgViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export interface NativeSvgElement {
  elementIndex: number;
  tagName: "path" | "rect" | "circle" | "ellipse" | "polygon";
  d: string;
  fillHex: string;
  fillRule: "evenodd" | "nonzero";
  transform?: string;
}

export interface ParsedNativeSvgResult {
  viewBox: SvgViewBox;
  /** Rasterized preview / hit-map pixel dimensions */
  width: number;
  height: number;
  imageData: ImageData;
  regionMap: Int32Array;
  regions: RegionInfo[];
  elements: NativeSvgElement[];
  /** Maps regionId (1..M) -> original NativeSvgElement */
  regionToElement: Record<number, NativeSvgElement>;
}

const CSS_NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#008000",
  blue: "#0000FF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  gray: "#808080",
  grey: "#808080",
  silver: "#C0C0C0",
  maroon: "#800000",
  olive: "#808000",
  purple: "#800080",
  teal: "#008080",
  navy: "#000080",
  orange: "#FFA500",
  pink: "#FFC0CB",
  brown: "#A52A2A",
  gold: "#FFD700",
};

const MAX_NATIVE_PREVIEW_SIZE = 1024;
const MIN_NATIVE_PREVIEW_SIZE = 512;

export function parseSvgColorToHex(raw: string | null | undefined): string | null {
  if (!raw) return "#000000";
  const value = raw.trim().toLowerCase();
  if (value === "none" || value === "transparent") return null;

  if (CSS_NAMED_COLORS[value]) {
    return CSS_NAMED_COLORS[value];
  }

  const hex6 = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex6) return `#${hex6[1].toUpperCase()}`;

  const hex3 = /^#([0-9a-f]{3})$/i.exec(value);
  if (hex3) {
    const [r, g, b] = hex3[1].toUpperCase().split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(
    value,
  );
  if (rgbMatch) {
    return rgbToHex(
      Number(rgbMatch[1]),
      Number(rgbMatch[2]),
      Number(rgbMatch[3]),
    );
  }

  // Fallback for url(#gradient) or unsupported CSS vars -> default dark solid
  return "#1E1E24";
}

function parseLengthPx(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) return null;
  const num = parseFloat(trimmed);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parseViewBoxAttr(
  viewBoxAttr: string | null,
  widthAttr: string | null,
  heightAttr: string | null,
): SvgViewBox {
  if (viewBoxAttr) {
    const parts = viewBoxAttr
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[2] > 0 &&
      parts[3] > 0
    ) {
      return {
        minX: parts[0],
        minY: parts[1],
        width: parts[2],
        height: parts[3],
      };
    }
  }

  const w = parseLengthPx(widthAttr) ?? 512;
  const h = parseLengthPx(heightAttr) ?? 512;
  return { minX: 0, minY: 0, width: w, height: h };
}

function rectToPathData(attrs: Record<string, string>): string {
  const x = parseFloat(attrs.x ?? "0") || 0;
  const y = parseFloat(attrs.y ?? "0") || 0;
  const w = parseFloat(attrs.width ?? "0") || 0;
  const h = parseFloat(attrs.height ?? "0") || 0;
  if (w <= 0 || h <= 0) return "";

  let rx = parseFloat(attrs.rx ?? "") || 0;
  let ry = parseFloat(attrs.ry ?? "") || 0;
  if (rx > 0 && ry === 0) ry = rx;
  if (ry > 0 && rx === 0) rx = ry;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);

  if (rx <= 0 || ry <= 0) {
    return `M${x} ${y}L${x + w} ${y}L${x + w} ${y + h}L${x} ${y + h}Z`;
  }

  return [
    `M${x + rx} ${y}`,
    `L${x + w - rx} ${y}`,
    `A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}`,
    `L${x + w} ${y + h - ry}`,
    `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}`,
    `L${x + rx} ${y + h}`,
    `A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}`,
    `L${x} ${y + ry}`,
    `A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`,
  ].join("");
}

function circleToPathData(attrs: Record<string, string>): string {
  const cx = parseFloat(attrs.cx ?? "0") || 0;
  const cy = parseFloat(attrs.cy ?? "0") || 0;
  const r = parseFloat(attrs.r ?? "0") || 0;
  if (r <= 0) return "";
  return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
}

function ellipseToPathData(attrs: Record<string, string>): string {
  const cx = parseFloat(attrs.cx ?? "0") || 0;
  const cy = parseFloat(attrs.cy ?? "0") || 0;
  const rx = parseFloat(attrs.rx ?? "0") || 0;
  const ry = parseFloat(attrs.ry ?? "0") || 0;
  if (rx <= 0 || ry <= 0) return "";
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
}

function polygonToPathData(attrs: Record<string, string>): string {
  const raw = attrs.points ?? "";
  const nums = raw.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  if (nums.length < 6) return "";

  const parts: string[] = [`M${nums[0]} ${nums[1]}`];
  for (let i = 2; i + 1 < nums.length; i += 2) {
    parts.push(`L${nums[i]} ${nums[i + 1]}`);
  }
  parts.push("Z");
  return parts.join("");
}

function extractStyleProp(styleAttr: string | null, prop: string): string | null {
  if (!styleAttr) return null;
  const regex = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  const match = regex.exec(styleAttr);
  return match ? match[1].trim() : null;
}

/**
 * Parses inline attributes cleanly for fallback non-DOMParser environments (e.g. Node tests).
 */
function parseRawAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrText)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? "";
    // Security guard: strip event handlers and javascript: payloads
    if (key.startsWith("on") || /javascript:/i.test(val)) {
      continue;
    }
    attrs[key] = val;
  }
  return attrs;
}

function sanitizeAndExtractViaDomParser(svgText: string): {
  viewBox: SvgViewBox;
  elements: NativeSvgElement[];
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const parserError = doc.querySelector("parsererror");
  const root = doc.documentElement;

  if (parserError || !root || root.tagName.toLowerCase() !== "svg") {
    throw new Error("File SVG tidak valid atau XML rusak.");
  }

  // Strip potentially dangerous XML nodes & event-handler attributes
  const dangerousNodes = doc.querySelectorAll(
    "script, foreignObject, iframe, object, embed",
  );
  dangerousNodes.forEach((node) => node.remove());

  const allNodes = doc.querySelectorAll("*");
  allNodes.forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || /javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  const viewBox = parseViewBoxAttr(
    root.getAttribute("viewBox"),
    root.getAttribute("width"),
    root.getAttribute("height"),
  );

  const elements: NativeSvgElement[] = [];

  const walk = (
    node: Element,
    inheritedFill: string | null,
    inheritedFillRule: "evenodd" | "nonzero",
    inheritedTransform: string,
  ) => {
    const tag = node.tagName.toLowerCase();

    // Skip non-rendered definitions such as <defs>, <clipPath>, <mask>, <symbol>
    if (
      tag === "defs" ||
      tag === "clippath" ||
      tag === "mask" ||
      tag === "symbol" ||
      tag === "title" ||
      tag === "desc" ||
      tag === "metadata"
    ) {
      return;
    }

    const styleAttr = node.getAttribute("style");
    const rawFill =
      extractStyleProp(styleAttr, "fill") ?? node.getAttribute("fill");
    const resolvedFill =
      rawFill !== null ? parseSvgColorToHex(rawFill) : inheritedFill;

    const rawFillRule =
      extractStyleProp(styleAttr, "fill-rule") ?? node.getAttribute("fill-rule");
    const resolvedFillRule: "evenodd" | "nonzero" =
      rawFillRule === "evenodd"
        ? "evenodd"
        : rawFillRule === "nonzero"
          ? "nonzero"
          : inheritedFillRule;

    const ownTransform = node.getAttribute("transform")?.trim() ?? "";
    const combinedTransform = [inheritedTransform, ownTransform]
      .filter(Boolean)
      .join(" ");

    if (
      tag === "path" ||
      tag === "rect" ||
      tag === "circle" ||
      tag === "ellipse" ||
      tag === "polygon"
    ) {
      if (resolvedFill !== null) {
        const attrMap: Record<string, string> = {};
        for (const attr of Array.from(node.attributes)) {
          attrMap[attr.name.toLowerCase()] = attr.value;
        }

        let d = "";
        if (tag === "path") d = attrMap.d ?? "";
        else if (tag === "rect") d = rectToPathData(attrMap);
        else if (tag === "circle") d = circleToPathData(attrMap);
        else if (tag === "ellipse") d = ellipseToPathData(attrMap);
        else if (tag === "polygon") d = polygonToPathData(attrMap);

        if (d.trim().length > 0) {
          elements.push({
            elementIndex: elements.length + 1,
            tagName: tag,
            d: d.trim(),
            fillHex: resolvedFill,
            fillRule: resolvedFillRule,
            transform: combinedTransform || undefined,
          });
        }
      }
    }

    for (const child of Array.from(node.children)) {
      walk(child, resolvedFill, resolvedFillRule, combinedTransform);
    }
  };

  walk(root, "#000000", "nonzero", "");
  return { viewBox, elements };
}

function sanitizeAndExtractFallback(svgText: string): {
  viewBox: SvgViewBox;
  elements: NativeSvgElement[];
} {
  // Strip dangerous script/foreignObject blocks cleanly
  const cleaned = svgText
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");

  const svgTagMatch = /<svg\b([^>]*)>/i.exec(cleaned);
  if (!svgTagMatch) {
    throw new Error("File SVG tidak valid.");
  }

  const svgAttrs = parseRawAttributes(svgTagMatch[1]);
  const viewBox = parseViewBoxAttr(
    svgAttrs.viewbox ?? null,
    svgAttrs.width ?? null,
    svgAttrs.height ?? null,
  );

  const elements: NativeSvgElement[] = [];
  const shapeRegex = /<(path|rect|circle|ellipse|polygon)\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;

  while ((match = shapeRegex.exec(cleaned)) !== null) {
    const tag = match[1].toLowerCase() as NativeSvgElement["tagName"];
    const attrs = parseRawAttributes(match[2]);
    const rawFill = extractStyleProp(attrs.style ?? null, "fill") ?? attrs.fill;
    const fillHex = rawFill !== undefined ? parseSvgColorToHex(rawFill) : "#000000";
    if (fillHex === null) continue;

    const rawFillRule =
      extractStyleProp(attrs.style ?? null, "fill-rule") ?? attrs["fill-rule"];
    const fillRule: "evenodd" | "nonzero" =
      rawFillRule === "evenodd" ? "evenodd" : "nonzero";

    let d = "";
    if (tag === "path") d = attrs.d ?? "";
    else if (tag === "rect") d = rectToPathData(attrs);
    else if (tag === "circle") d = circleToPathData(attrs);
    else if (tag === "ellipse") d = ellipseToPathData(attrs);
    else if (tag === "polygon") d = polygonToPathData(attrs);

    if (d.trim().length > 0) {
      elements.push({
        elementIndex: elements.length + 1,
        tagName: tag,
        d: d.trim(),
        fillHex,
        fillRule,
        transform: attrs.transform,
      });
    }
  }

  return { viewBox, elements };
}

function computePreviewDimensions(viewBox: SvgViewBox): {
  width: number;
  height: number;
} {
  const longest = Math.max(viewBox.width, viewBox.height);
  let targetLongest = longest;
  if (longest < MIN_NATIVE_PREVIEW_SIZE) {
    targetLongest = Math.min(MAX_NATIVE_PREVIEW_SIZE, Math.max(MIN_NATIVE_PREVIEW_SIZE, longest * 8));
  } else if (longest > MAX_NATIVE_PREVIEW_SIZE) {
    targetLongest = MAX_NATIVE_PREVIEW_SIZE;
  }

  const scale = targetLongest / longest;
  return {
    width: Math.max(1, Math.round(viewBox.width * scale)),
    height: Math.max(1, Math.round(viewBox.height * scale)),
  };
}

/**
 * Extracts approximate bounding coordinates from SVG path commands (M/L/H/V/C/S/Q/T/A/Z)
 * cleanly without misinterpreting arc flags as X/Y coordinates.
 */
function computeSvgPathBounds(d: string): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
  if (!tokens || tokens.length === 0) return null;

  let cmd = "";
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const record = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  const nextNum = () => Number(tokens[i++]);
  const hasNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i++];
    }
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;

    if (upper === "Z") {
      cx = sx;
      cy = sy;
      continue;
    }

    if (!hasNum()) {
      i++;
      continue;
    }

    if (upper === "M" || upper === "L" || upper === "T") {
      let first = true;
      while (hasNum()) {
        const x = nextNum() + (rel ? cx : 0);
        if (!hasNum()) break;
        const y = nextNum() + (rel ? cy : 0);
        cx = x;
        cy = y;
        if (upper === "M" && first) {
          sx = cx;
          sy = cy;
          first = false;
        }
        record(cx, cy);
      }
      if (upper === "M") cmd = rel ? "l" : "L";
    } else if (upper === "H") {
      while (hasNum()) {
        cx = nextNum() + (rel ? cx : 0);
        record(cx, cy);
      }
    } else if (upper === "V") {
      while (hasNum()) {
        cy = nextNum() + (rel ? cy : 0);
        record(cx, cy);
      }
    } else if (upper === "C") {
      while (hasNum()) {
        const x1 = nextNum() + (rel ? cx : 0);
        const y1 = nextNum() + (rel ? cy : 0);
        const x2 = nextNum() + (rel ? cx : 0);
        const y2 = nextNum() + (rel ? cy : 0);
        const x = nextNum() + (rel ? cx : 0);
        const y = nextNum() + (rel ? cy : 0);
        record(x1, y1);
        record(x2, y2);
        cx = x;
        cy = y;
        record(cx, cy);
      }
    } else if (upper === "S" || upper === "Q") {
      while (hasNum()) {
        const x1 = nextNum() + (rel ? cx : 0);
        const y1 = nextNum() + (rel ? cy : 0);
        const x = nextNum() + (rel ? cx : 0);
        const y = nextNum() + (rel ? cy : 0);
        record(x1, y1);
        cx = x;
        cy = y;
        record(cx, cy);
      }
    } else if (upper === "A") {
      while (hasNum()) {
        const rx = Math.abs(nextNum());
        const ry = Math.abs(nextNum());
        nextNum(); // xAxisRotation
        nextNum(); // largeArcFlag
        nextNum(); // sweepFlag
        const x = nextNum() + (rel ? cx : 0);
        const y = nextNum() + (rel ? cy : 0);
        record(cx, cy);
        record(x, y);
        if (Math.abs(cy - y) < 1e-6) {
          record((cx + x) / 2, cy - ry);
          record((cx + x) / 2, cy + ry);
        } else if (Math.abs(cx - x) < 1e-6) {
          record(cx - rx, (cy + y) / 2);
          record(cx + rx, (cy + y) / 2);
        }
        cx = x;
        cy = y;
      }
    } else {
      i++;
    }
  }

  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Fallback polygon/path rasterizer used only in headless Node tests where
 * document / HTML5 Canvas is unavailable.
 */
function rasterizeElementsHeadless(
  elements: NativeSvgElement[],
  viewBox: SvgViewBox,
  width: number,
  height: number,
): Int32Array {
  const regionMap = new Int32Array(width * height);
  const scaleX = width / viewBox.width;
  const scaleY = height / viewBox.height;

  for (const el of elements) {
    const bounds = computeSvgPathBounds(el.d);
    if (!bounds) continue;

    const px0 = Math.max(0, Math.floor((bounds.minX - viewBox.minX) * scaleX));
    const py0 = Math.max(0, Math.floor((bounds.minY - viewBox.minY) * scaleY));
    const px1 = Math.min(
      width - 1,
      Math.ceil((bounds.maxX - viewBox.minX) * scaleX) - 1,
    );
    const py1 = Math.min(
      height - 1,
      Math.ceil((bounds.maxY - viewBox.minY) * scaleY) - 1,
    );

    for (let y = py0; y <= py1; y++) {
      const row = y * width;
      for (let x = px0; x <= px1; x++) {
        regionMap[row + x] = el.elementIndex;
      }
    }
  }

  return regionMap;
}

/**
 * Browser offscreen canvas rasterizer: renders each SVG element separately onto
 * a clean scratch canvas so anti-aliasing never corrupts regionMap IDs.
 */
function rasterizeElementsInBrowser(
  elements: NativeSvgElement[],
  viewBox: SvgViewBox,
  width: number,
  height: number,
): Int32Array {
  const regionMap = new Int32Array(width * height);
  const scratchCanvas = document.createElement("canvas");
  scratchCanvas.width = width;
  scratchCanvas.height = height;
  const ctx = scratchCanvas.getContext("2d", { willReadFrequently: true });

  if (!ctx || typeof Path2D === "undefined") {
    return rasterizeElementsHeadless(elements, viewBox, width, height);
  }

  const scaleX = width / viewBox.width;
  const scaleY = height / viewBox.height;

  for (const el of elements) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.scale(scaleX, scaleY);
    ctx.translate(-viewBox.minX, -viewBox.minY);

    if (el.transform && typeof DOMMatrix !== "undefined") {
      try {
        const matrix = new DOMMatrix(el.transform);
        ctx.transform(
          matrix.a,
          matrix.b,
          matrix.c,
          matrix.d,
          matrix.e,
          matrix.f,
        );
      } catch {
        // Ignore malformed transform strings gracefully
      }
    }

    try {
      const path2D = new Path2D(el.d);
      ctx.fillStyle = "#000000";
      ctx.fill(path2D, el.fillRule);
    } catch {
      continue;
    }

    const pixels = ctx.getImageData(0, 0, width, height).data;
    const totalPixels = width * height;
    for (let i = 0; i < totalPixels; i++) {
      if (pixels[i * 4 + 3] >= 128) {
        regionMap[i] = el.elementIndex;
      }
    }
  }

  return regionMap;
}

/**
 * Dual-Pipeline Stage A: Parses an uploaded .svg file safely using DOMParser,
 * preserves exact vector primitives without re-tracing, and builds an offscreen
 * O(1) regionMap + RegionInfo[] compatible with CanvasWorkspace & RegionGrouper.
 */
export function parseNativeSvg(svgText: string): ParsedNativeSvgResult {
  const extracted =
    typeof DOMParser !== "undefined"
      ? sanitizeAndExtractViaDomParser(svgText)
      : sanitizeAndExtractFallback(svgText);

  const { viewBox, elements } = extracted;

  if (elements.length === 0) {
    throw new Error(
      "File SVG tidak memiliki elemen vektor terisi (<path>, <rect>, <circle>, <polygon>, <ellipse>).",
    );
  }

  const { width, height } = computePreviewDimensions(viewBox);

  const rawRegionMap =
    typeof document !== "undefined"
      ? rasterizeElementsInBrowser(elements, viewBox, width, height)
      : rasterizeElementsHeadless(elements, viewBox, width, height);

  // Accumulate exact pixel statistics per visible surviving element
  const countArr = new Int32Array(elements.length + 1);
  const minXArr = new Int32Array(elements.length + 1).fill(width);
  const minYArr = new Int32Array(elements.length + 1).fill(height);
  const maxXArr = new Int32Array(elements.length + 1).fill(-1);
  const maxYArr = new Int32Array(elements.length + 1).fill(-1);
  const sumXArr = new Float64Array(elements.length + 1);
  const sumYArr = new Float64Array(elements.length + 1);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const eid = rawRegionMap[row + x];
      if (eid <= 0 || eid > elements.length) continue;

      countArr[eid]++;
      if (x < minXArr[eid]) minXArr[eid] = x;
      if (x > maxXArr[eid]) maxXArr[eid] = x;
      if (y < minYArr[eid]) minYArr[eid] = y;
      if (y > maxYArr[eid]) maxYArr[eid] = y;
      sumXArr[eid] += x;
      sumYArr[eid] += y;
    }
  }

  // Compact visible elements into contiguous regionIds 1..M
  const compactLookup = new Int32Array(elements.length + 1);
  const regions: RegionInfo[] = [];
  const regionToElement: Record<number, NativeSvgElement> = {};

  for (const el of elements) {
    const eid = el.elementIndex;
    const count = countArr[eid];
    if (count === 0) continue;

    const regionId = regions.length + 1;
    compactLookup[eid] = regionId;
    const rgb = hexToRgb(el.fillHex);

    regions.push({
      regionId,
      originalHex: el.fillHex,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      assignedGroupId: `color-${el.fillHex.slice(1)}`,
      pixelCount: count,
      boundingBox: {
        minX: minXArr[eid],
        minY: minYArr[eid],
        maxX: maxXArr[eid],
        maxY: maxYArr[eid],
        width: maxXArr[eid] - minXArr[eid] + 1,
        height: maxYArr[eid] - minYArr[eid] + 1,
      },
      centroid: {
        x: Math.round(sumXArr[eid] / count),
        y: Math.round(sumYArr[eid] / count),
      },
    });
    regionToElement[regionId] = el;
  }

  if (regions.length === 0) {
    throw new Error("Elemen vektor di dalam SVG tidak memiliki area piksel yang terlihat.");
  }

  const totalPixels = width * height;
  const regionMap = new Int32Array(totalPixels);
  const previewData = new Uint8ClampedArray(totalPixels * 4);

  for (let i = 0; i < totalPixels; i++) {
    const eid = rawRegionMap[i];
    if (eid <= 0 || eid > elements.length) continue;
    const rid = compactLookup[eid];
    if (rid <= 0) continue;

    regionMap[i] = rid;
    const reg = regions[rid - 1];
    const off = i * 4;
    previewData[off] = reg.r;
    previewData[off + 1] = reg.g;
    previewData[off + 2] = reg.b;
    previewData[off + 3] = 255;
  }

  return {
    viewBox,
    width,
    height,
    imageData: new ImageData(previewData, width, height),
    regionMap,
    regions,
    elements,
    regionToElement,
  };
}
