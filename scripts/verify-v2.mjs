import assert from "node:assert/strict";
import JSZip from "jszip";
import { DEFAULT_COLOR_COUNT } from "./.dist/image-processor/color-quantizer.js";
import {
  applyPaletteToGrouping,
  autoCompactToFiveColors,
  createInitialGrouping,
  splitRegionToNewGroup,
} from "./.dist/image-processor/region-grouper.js";
import { applySelectiveChaikinSmoothing } from "./.dist/svg-exporter/contour-tracer.js";
import { parseNativeSvg } from "./.dist/svg-exporter/native-svg-parser.js";
import {
  buildCanvaSvgExport,
  validateCanvaSvgCompliance,
} from "./.dist/svg-exporter/canva-svg-exporter.js";
import {
  computeHdTargetDimensions,
  createZipArchiveBlob,
} from "./.dist/svg-exporter/raster-hd-exporter.js";

class MockImageData {
  constructor(dataOrWidth, widthOrHeight, maybeHeight) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = maybeHeight;
    } else {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
  }
}

globalThis.ImageData = MockImageData;

// Test 1: Native SVG parsing, XSS sanitization, regionMap generation, and passthrough export
{
  const maliciousSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" onload="alert('xss')">
      <script>window.evil = true;</script>
      <rect x="10" y="10" width="80" height="80" fill="#FF6B6B" onclick="steal()" />
      <circle cx="150" cy="50" r="30" fill="#4ECDC4" />
      <polygon points="100,110 140,180 60,180" fill="#FFD166" />
      <path d="M20 120L40 120L40 160L20 160Z" fill="#1E1E24" />
    </svg>
  `;

  const parsed = parseNativeSvg(maliciousSvg);
  assert.equal(parsed.viewBox.width, 200);
  assert.equal(parsed.viewBox.height, 200);
  assert.equal(parsed.elements.length, 4);
  assert.equal(parsed.regions.length, 4);
  assert.equal(parsed.regionMap.length, parsed.width * parsed.height);

  const scale = parsed.width / 200;
  const hitRect = parsed.regionMap[Math.round(40 * scale) * parsed.width + Math.round(40 * scale)];
  const hitCircle = parsed.regionMap[Math.round(50 * scale) * parsed.width + Math.round(150 * scale)];
  assert.ok(hitRect > 0 && hitCircle > 0 && hitRect !== hitCircle);

  const grouping = createInitialGrouping(parsed.regions);
  const split = splitRegionToNewGroup(grouping, parsed.regions[0].regionId, "#C8A2C8");
  const exp = buildCanvaSvgExport({
    regionMap: parsed.regionMap,
    width: parsed.width,
    height: parsed.height,
    groupingState: split,
    baseFileName: "vector-input.svg",
    nativeSvg: parsed,
  });

  assert.equal(exp.isNativeSvgSource, true);
  assert.equal(exp.files.length, 1);
  const outSvg = exp.files[0].svgString;
  assert.ok(outSvg.includes('viewBox="0 0 200 200"'));
  assert.ok(!outSvg.includes("script") && !outSvg.includes("onclick") && !outSvg.includes("onload"));
  assert.equal(validateCanvaSvgCompliance(outSvg).isValid, true);
  console.log("Test 1 PASS: Native SVG parsed safely with valid regionMap and passthrough export.");
}

// Test 2: autoCompactToFiveColors compacts 9 groups -> <= 5 groups preserving major colors
{
  const mockRegions = [
    { regionId: 1, originalHex: "#FFFFFF", r: 255, g: 255, b: 255, assignedGroupId: "", pixelCount: 10000 },
    { regionId: 2, originalHex: "#1E1E24", r: 30, g: 30, b: 36, assignedGroupId: "", pixelCount: 6000 },
    { regionId: 3, originalHex: "#C8A2C8", r: 200, g: 162, b: 200, assignedGroupId: "", pixelCount: 4000 },
    { regionId: 4, originalHex: "#FF6B6B", r: 255, g: 107, b: 107, assignedGroupId: "", pixelCount: 3000 },
    { regionId: 5, originalHex: "#FFD166", r: 255, g: 209, b: 102, assignedGroupId: "", pixelCount: 2500 },
    { regionId: 6, originalHex: "#F4F4F6", r: 244, g: 244, b: 246, assignedGroupId: "", pixelCount: 80 },
    { regionId: 7, originalHex: "#2A2A32", r: 42, g: 42, b: 50, assignedGroupId: "", pixelCount: 60 },
    { regionId: 8, originalHex: "#CEABCE", r: 206, g: 171, b: 206, assignedGroupId: "", pixelCount: 50 },
    { regionId: 9, originalHex: "#FF7A7A", r: 255, g: 122, b: 122, assignedGroupId: "", pixelCount: 40 },
  ].map((item) => ({
    ...item,
    boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 },
    centroid: { x: 1, y: 1 },
  }));

  const state9 = createInitialGrouping(mockRegions);
  assert.equal(state9.groups.length, 9);

  const compacted = autoCompactToFiveColors(state9);
  assert.equal(compacted.groups.length, 5);

  const hexSet = new Set(compacted.groups.map((g) => g.colorHex));
  assert.ok(hexSet.has("#FFFFFF"));
  assert.ok(hexSet.has("#1E1E24"));
  assert.ok(hexSet.has("#C8A2C8"));
  assert.ok(hexSet.has("#FF6B6B"));
  assert.ok(hexSet.has("#FFD166"));

  const totalBefore = state9.groups.reduce((acc, g) => acc + g.totalPixels, 0);
  const totalAfter = compacted.groups.reduce((acc, g) => acc + g.totalPixels, 0);
  assert.equal(totalBefore, totalAfter);
  console.log("Test 2 PASS: autoCompactToFiveColors compacted 9 groups to 5 dominant colors.");
}

// Test 3: Selective Chaikin smoothing preserves sharp <75 deg tips & smooths obtuse curve corners
{
  const loop = [
    { x: 50, y: 0 },
    { x: 65, y: 45 },
    { x: 90, y: 70 },
    { x: 50, y: 95 },
    { x: 10, y: 70 },
    { x: 35, y: 45 },
  ];

  const smoothed = applySelectiveChaikinSmoothing(loop, 1);
  const hasExactSharpTip = smoothed.some((p) => p.x === 50 && p.y === 0);
  assert.equal(hasExactSharpTip, true);
  assert.ok(smoothed.length > loop.length);
  console.log(`Test 3 PASS: Selective Chaikin preserved sharp <75° tip and smoothed obtuse vertices (${loop.length} -> ${smoothed.length}).`);
}

// Test 4: HD scaling dimensions (1x/2x/4x) and 4096px safety cap
{
  const d2 = computeHdTargetDimensions(800, 600, 2);
  assert.equal(d2.width, 1600);
  assert.equal(d2.height, 1200);
  assert.equal(d2.wasClamped, false);

  const d4Exact = computeHdTargetDimensions(1024, 1024, 4);
  assert.equal(d4Exact.width, 4096);
  assert.equal(d4Exact.height, 4096);
  assert.equal(d4Exact.wasClamped, false);

  const d4Clamped = computeHdTargetDimensions(1600, 1200, 4);
  assert.equal(d4Clamped.width, 4096);
  assert.equal(d4Clamped.height, 3072);
  assert.equal(d4Clamped.wasClamped, true);

  const d4RectClamped = computeHdTargetDimensions(2048, 1024, 4);
  assert.equal(d4RectClamped.width, 4096);
  assert.equal(d4RectClamped.height, 2048);
  assert.equal(d4RectClamped.wasClamped, true);
  console.log("Test 4 PASS: HD 2x/4x scaling and 4096px RAM safety cap verified.");
}

// Test 5: JSZip archive creation and integrity check
{
  const entries = [
    { fileName: "design-part-1-of-2.svg", content: "<svg></svg>" },
    { fileName: "design-part-2-of-2.svg", content: "<svg><path /></svg>" },
    { fileName: "preview-2x.png", content: new Uint8Array([137, 80, 78, 71]) },
  ];

  const zipBlob = await createZipArchiveBlob(entries);
  assert.ok(zipBlob.size > 0);
  const buffer = await zipBlob.arrayBuffer();
  const reopened = await JSZip.loadAsync(buffer);
  const names = Object.keys(reopened.files).sort();
  assert.deepEqual(names, [
    "design-part-1-of-2.svg",
    "design-part-2-of-2.svg",
    "preview-2x.png",
  ]);
  const svg1 = await reopened.file("design-part-1-of-2.svg").async("string");
  assert.equal(svg1, "<svg></svg>");
  console.log("Test 5 PASS: JSZip archive packed & verified 3 files cleanly.");
}

// Test 6: v2 defaults (DEFAULT_COLOR_COUNT = 4) & Batch palette sync
{
  assert.equal(DEFAULT_COLOR_COUNT, 4);
  const mockRegions = [
    { regionId: 1, originalHex: "#FFFFFF", r: 255, g: 255, b: 255, assignedGroupId: "", pixelCount: 500, boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 }, centroid: { x: 1, y: 1 } },
    { regionId: 2, originalHex: "#1E1E24", r: 30, g: 30, b: 36, assignedGroupId: "", pixelCount: 200, boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 }, centroid: { x: 1, y: 1 } },
  ];
  const state = createInitialGrouping(mockRegions);
  const synced = applyPaletteToGrouping(state, ["#FAF5FF", "#311042"]);
  assert.equal(synced.groups[0].colorHex, "#FAF5FF");
  assert.equal(synced.groups[1].colorHex, "#311042");
  console.log("Test 6 PASS: v2 default colorCount=4 & batch palette sync verified.");
}
