import assert from "node:assert/strict";
import { segmentRegions } from "./.dist/image-processor/region-segmenter.js";
import {
  createInitialGrouping,
  splitRegionToNewGroup,
} from "./.dist/image-processor/region-grouper.js";
import {
  buildCanvaSvgExport,
  validateCanvaSvgCompliance,
} from "./.dist/svg-exporter/canva-svg-exporter.js";
import { traceRegionGroupToSvgPath } from "./.dist/svg-exporter/contour-tracer.js";

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

function setPixel(img, x, y, r, g, b, a = 255) {
  const idx = (y * img.width + x) * 4;
  img.data[idx] = r;
  img.data[idx + 1] = g;
  img.data[idx + 2] = b;
  img.data[idx + 3] = a;
}

// Test 1: Donut / hollow letter hole detection produces >= 2 sub-paths (outer + hole)
{
  const w = 40;
  const h = 40;
  const src = new MockImageData(w, h);

  for (let y = 6; y < 34; y++) {
    for (let x = 6; x < 34; x++) {
      const isHole = x >= 14 && x < 26 && y >= 14 && y < 26;
      if (!isHole) {
        setPixel(src, x, y, 30, 30, 36, 255);
      }
    }
  }

  const seg = segmentRegions(src);
  assert.equal(seg.regions.length, 1);

  const grouping = createInitialGrouping(seg.regions);
  const expStrict = buildCanvaSvgExport({
    regionMap: seg.regionMap,
    width: w,
    height: h,
    groupingState: grouping,
    baseFileName: "huruf-o.png",
    epsilon: 0.9,
    smoothCurves: false,
  });
  const expSmooth = buildCanvaSvgExport({
    regionMap: seg.regionMap,
    width: w,
    height: h,
    groupingState: grouping,
    baseFileName: "huruf-o.png",
    epsilon: 0.9,
    smoothCurves: true,
  });

  assert.equal(expStrict.files.length, 1);
  assert.equal(expSmooth.files.length, 1);
  const svgStrict = expStrict.files[0].svgString;
  const svgSmooth = expSmooth.files[0].svgString;
  const compliance = validateCanvaSvgCompliance(svgSmooth);
  assert.equal(compliance.isValid, true, `Compliance errors: ${compliance.errors.join("; ")}`);

  const mMatches = svgSmooth.match(/M/g) ?? [];
  const zMatches = svgSmooth.match(/Z/g) ?? [];
  assert.ok(mMatches.length >= 2, `Expected >=2 sub-paths (outer + hole), got ${mMatches.length}`);
  assert.equal(mMatches.length, zMatches.length);
  assert.ok(svgStrict.includes("M14 14"), "Hole boundary loop starting at (14,14) must be traced");
  console.log(`Test 1 PASS: Hollow ring generated ${mMatches.length} closed sub-paths with fill-rule="evenodd".`);
}

// Test 2: Canva 5-Color Guard — 4 groups => 1 SVG file, 7 groups => 2 SVG files with Alignment Anchors
{
  const w = 120;
  const h = 80;
  const src = new MockImageData(w, h);
  const colors = [
    [255, 255, 255],
    [30, 30, 36],
    [200, 162, 200],
    [255, 209, 102],
    [255, 107, 107],
    [86, 207, 225],
    [52, 211, 153],
  ];

  for (let i = 0; i < 4; i++) {
    const x0 = 10 + i * 25;
    const [r, g, b] = colors[i];
    for (let y = 10; y < 30; y++) {
      for (let x = x0; x < x0 + 18; x++) {
        setPixel(src, x, y, r, g, b, 255);
      }
    }
  }

  const seg4 = segmentRegions(src);
  const grp4 = createInitialGrouping(seg4.regions);
  const exp4 = buildCanvaSvgExport({
    regionMap: seg4.regionMap,
    width: w,
    height: h,
    groupingState: grp4,
    baseFileName: "Keyring Kucing!.png",
    epsilon: 0.9,
  });

  assert.equal(exp4.files.length, 1);
  assert.equal(exp4.isMultiPartSplit, false);
  assert.equal(exp4.files[0].fileName, "keyring-kucing-canva.svg");
  assert.equal(exp4.files[0].uniqueColors.length, 4);
  assert.equal(exp4.files[0].hasAlignmentAnchors, false);
  assert.equal(validateCanvaSvgCompliance(exp4.files[0].svgString).isValid, true);

  for (let i = 4; i < 7; i++) {
    const x0 = 10 + (i - 4) * 30;
    const [r, g, b] = colors[i];
    for (let y = 42; y < 62; y++) {
      for (let x = x0; x < x0 + 18; x++) {
        setPixel(src, x, y, r, g, b, 255);
      }
    }
  }

  const seg7 = segmentRegions(src);
  const grp7 = createInitialGrouping(seg7.regions);
  const exp7 = buildCanvaSvgExport({
    regionMap: seg7.regionMap,
    width: w,
    height: h,
    groupingState: grp7,
    baseFileName: "Keyring Kucing!.png",
    epsilon: 0.9,
  });

  assert.equal(exp7.files.length, 2);
  assert.equal(exp7.isMultiPartSplit, true);
  assert.equal(exp7.files[0].fileName, "keyring-kucing-part-1-of-2.svg");
  assert.equal(exp7.files[1].fileName, "keyring-kucing-part-2-of-2.svg");
  assert.equal(exp7.files[0].uniqueColors.length, 5);
  assert.equal(exp7.files[1].uniqueColors.length, 2);

  for (const file of exp7.files) {
    const comp = validateCanvaSvgCompliance(file.svgString);
    assert.equal(comp.isValid, true);
    assert.equal(file.hasAlignmentAnchors, true);
    assert.ok(file.svgString.includes(`viewBox="0 0 ${w} ${h}"`));
    assert.ok(file.svgString.includes("M0 0L0.1 0L0.1 0.1L0 0.1Z"));
    assert.ok(file.svgString.includes("M119.9 79.9L120 79.9L120 80L119.9 80Z"));
  }
  console.log("Test 2 PASS: 5-Color Guard produced 1 file (4 colors) and 2 split files (5+2 colors) with identical bounds & anchors.");
}

// Test 3: Splitting two identical black regions exports 2 separate editable <path> layers
{
  const w = 60;
  const h = 40;
  const src = new MockImageData(w, h);
  for (let y = 10; y < 22; y++) {
    for (let x = 6; x < 18; x++) setPixel(src, x, y, 30, 30, 36, 255);
    for (let x = 32; x < 44; x++) setPixel(src, x, y, 30, 30, 36, 255);
  }
  const seg = segmentRegions(src);
  const initGrp = createInitialGrouping(seg.regions);
  const splitGrp = splitRegionToNewGroup(initGrp, seg.regions[1].regionId, "#FF6B6B");
  const exp = buildCanvaSvgExport({
    regionMap: seg.regionMap,
    width: w,
    height: h,
    groupingState: splitGrp,
    baseFileName: "split-test",
  });
  assert.equal(exp.files[0].layerCount, 2);
  assert.deepEqual(exp.files[0].uniqueColors.sort(), ["#1E1E24", "#FF6B6B"]);
  console.log("Test 3 PASS: Split regions exported as independent editable <path> layers.");
}

// Test 4: Diagonal staircase RDP simplification
{
  const w = 40;
  const h = 40;
  const src = new MockImageData(w, h);
  for (let y = 5; y < 35; y++) {
    for (let x = 5; x <= y; x++) {
      setPixel(src, x, y, 30, 30, 36, 255);
    }
  }
  const seg = segmentRegions(src);
  const tracedStrict = traceRegionGroupToSvgPath({
    regionMap: seg.regionMap,
    width: w,
    height: h,
    regionIds: [1],
    sourceRegions: seg.regions,
    epsilon: 0,
  });
  const tracedRdp = traceRegionGroupToSvgPath({
    regionMap: seg.regionMap,
    width: w,
    height: h,
    regionIds: [1],
    sourceRegions: seg.regions,
    epsilon: 0.9,
  });
  assert.ok(tracedRdp.vertexCount < tracedStrict.vertexCount / 3);
  console.log(`Test 4 PASS: RDP reduced staircase vertices from ${tracedStrict.vertexCount} to ${tracedRdp.vertexCount}.`);
}

// Test 5: 1024x1024 tracing + SVG build benchmark (< 1500 ms)
{
  const w = 1024;
  const h = 1024;
  const src = new MockImageData(w, h);
  const cx = 512;
  const cy = 512;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const rSq = dx * dx + dy * dy;
      if (rSq > 420 * 420) continue;
      if (rSq > 370 * 370) {
        setPixel(src, x, y, 255, 255, 255, 255);
      } else if (rSq > 345 * 345) {
        setPixel(src, x, y, 30, 30, 36, 255);
      } else if (y < 380) {
        setPixel(src, x, y, 200, 162, 200, 255);
      } else if (y > 620) {
        setPixel(src, x, y, 255, 107, 107, 255);
      } else if (Math.abs(dx) < 80 && Math.abs(dy) < 50) {
        setPixel(src, x, y, 86, 207, 225, 255);
      } else {
        setPixel(src, x, y, 252, 231, 200, 255);
      }
    }
  }

  const seg = segmentRegions(src);
  const grouping = createInitialGrouping(seg.regions);
  const exp = buildCanvaSvgExport({
    regionMap: seg.regionMap,
    width: w,
    height: h,
    groupingState: grouping,
    baseFileName: "benchmark-1024.png",
    epsilon: 0.9,
  });

  assert.ok(exp.processingTimeMs < 1500);
  assert.equal(exp.files.length, 2);
  for (const f of exp.files) {
    assert.equal(validateCanvaSvgCompliance(f.svgString).isValid, true);
  }
  console.log(
    `Test 5 PASS: 1024x1024 tracing + SVG export completed in ${exp.processingTimeMs} ms ` +
      `(${exp.files.length} files, sizes: ${exp.files.map((f) => `${(f.byteSize / 1024).toFixed(1)}KB`).join(" + ")}).`,
  );
}
