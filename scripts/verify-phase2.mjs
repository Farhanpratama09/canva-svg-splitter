import assert from "node:assert/strict";
import { removeCornerBackground } from "./.dist/image-processor/background-remover.js";
import { quantizeAndCleanColors } from "./.dist/image-processor/color-quantizer.js";
import {
  createRegionMapImageData,
  segmentRegions,
} from "./.dist/image-processor/region-segmenter.js";

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

function getRgba(img, x, y) {
  const idx = (y * img.width + x) * 4;
  return [
    img.data[idx],
    img.data[idx + 1],
    img.data[idx + 2],
    img.data[idx + 3],
  ];
}

// Test 1: Separated identical-color objects (#1E1E24) receive distinct regionIds
{
  const w = 60;
  const h = 40;
  const src = new MockImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      setPixel(src, x, y, 255, 255, 255, 255);
    }
  }
  for (let y = 10; y < 25; y++) {
    for (let x = 5; x < 15; x++) setPixel(src, x, y, 30, 30, 36, 255);
    for (let x = 22; x < 35; x++) setPixel(src, x, y, 30, 30, 36, 255);
    for (let x = 42; x < 54; x++) setPixel(src, x, y, 30, 30, 36, 255);
  }

  const q = quantizeAndCleanColors(src, { colorCount: 4 });
  assert.equal(q.isComplexPhoto, false);
  const seg = segmentRegions(q.imageData);

  const idHat = seg.regionMap[15 * w + 10];
  const idGlasses = seg.regionMap[15 * w + 28];
  const idStar = seg.regionMap[15 * w + 48];
  const idWhite = seg.regionMap[2 * w + 2];

  assert.ok(idHat > 0 && idGlasses > 0 && idStar > 0 && idWhite > 0);
  assert.notEqual(idHat, idGlasses);
  assert.notEqual(idHat, idStar);
  assert.notEqual(idGlasses, idStar);
  assert.equal(seg.regions[idHat - 1].originalHex, "#1E1E24");
  assert.equal(seg.regions[idGlasses - 1].originalHex, "#1E1E24");
  assert.equal(seg.regions[idStar - 1].originalHex, "#1E1E24");
  assert.equal(seg.regions[idHat - 1].pixelCount, 150);
  assert.deepEqual(seg.regions[idHat - 1].boundingBox, {
    minX: 5,
    minY: 10,
    maxX: 14,
    maxY: 24,
    width: 10,
    height: 15,
  });
  console.log("Test 1 PASS: Separated identical-color objects have unique regionIds & exact O(1) hit-map.");
}

// Test 2: Alpha threshold snapping + AA transition cleanup (no muddy gray centroid)
{
  const w = 64;
  const h = 64;
  const src = new MockImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 30) {
        setPixel(src, x, y, 255, 255, 255, 255);
      } else if (x === 30) {
        setPixel(src, x, y, 142, 142, 145, 255);
      } else if (x < 40) {
        setPixel(src, x, y, 30, 30, 36, 255);
      } else if (y < 44) {
        setPixel(src, x, y, 200, 162, 200, 255);
      } else {
        setPixel(src, x, y, 255, 209, 102, 255);
      }
    }
  }
  setPixel(src, 0, 0, 255, 255, 255, 90);
  setPixel(src, 1, 0, 255, 255, 255, 200);

  const q = quantizeAndCleanColors(src, { colorCount: 4 });
  assert.equal(getRgba(q.imageData, 0, 0)[3], 0, "Alpha < 128 snapped to 0");
  assert.equal(getRgba(q.imageData, 1, 0)[3], 255, "Alpha >= 128 snapped to 255");

  const hexSet = new Set(q.palette.map((p) => p.hex));
  assert.ok(hexSet.has("#FFFFFF"), "White preserved");
  assert.ok(hexSet.has("#1E1E24"), "Black preserved");
  assert.ok(hexSet.has("#C8A2C8"), "Pastel preserved");
  assert.ok(hexSet.has("#FFD166"), "Small yellow accent preserved");

  const aaSnapped = getRgba(q.imageData, 30, 20);
  const snappedIsBlackOrWhite =
    (aaSnapped[0] === 255 && aaSnapped[1] === 255 && aaSnapped[2] === 255) ||
    (aaSnapped[0] === 30 && aaSnapped[1] === 30 && aaSnapped[2] === 36);
  assert.ok(snappedIsBlackOrWhite, "AA transition pixel snapped to solid color");
  console.log("Test 2 PASS: Alpha snapping & AA cleanup preserved all 4 solid colors without muddy gray.");
}

// Test 3: Speckle removal (< 4px merged into largest neighbor, isolated dust cleared)
{
  const w = 30;
  const h = 30;
  const src = new MockImageData(w, h);
  for (let y = 5; y < 25; y++) {
    for (let x = 5; x < 25; x++) {
      setPixel(src, x, y, 252, 231, 200, 255);
    }
  }
  setPixel(src, 15, 15, 255, 107, 107, 255);
  setPixel(src, 16, 15, 255, 107, 107, 255);
  setPixel(src, 1, 1, 255, 107, 107, 255);

  const seg = segmentRegions(src);
  assert.equal(seg.regions.length, 1, "Only main region should survive");
  assert.ok(seg.absorbedSpeckleCount >= 2);
  assert.equal(seg.regionMap[15 * w + 15], 1, "2px interior noise merged into main region");
  assert.deepEqual(getRgba(seg.imageData, 15, 15), [252, 231, 200, 255]);
  assert.equal(seg.regionMap[1 * w + 1], 0, "Isolated 1px dust cleared");
  assert.equal(getRgba(seg.imageData, 1, 1)[3], 0);
  console.log("Test 3 PASS: Speckle removal (<4px) merged interior noise & cleared isolated dust.");
}

// Test 4: Complex photo detection (> 64 dominant clusters)
{
  const w = 128;
  const h = 128;
  const photo = new MockImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.round((x / (w - 1)) * 255);
      const g = Math.round((y / (h - 1)) * 255);
      const b = Math.round(((x + y) / (w + h - 2)) * 255);
      setPixel(photo, x, y, r, g, b, 255);
    }
  }
  const q = quantizeAndCleanColors(photo, { colorCount: 8 });
  assert.ok(q.dominantClusterCount > 64, `Expected >64 clusters, got ${q.dominantClusterCount}`);
  assert.equal(q.isComplexPhoto, true);
  console.log(`Test 4 PASS: Complex photo flagged (${q.dominantClusterCount} dominant clusters).`);
}

// Test 5: Full 1024x1024 Stage 1 -> 2 -> 3 pipeline benchmark (< 1500 ms)
{
  const w = 1024;
  const h = 1024;
  const src = new MockImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 120 || x >= 904 || y < 120 || y >= 904) {
        setPixel(src, x, y, 223, 226, 232, 255);
      } else if (x < 160 || x >= 864 || y < 160 || y >= 864) {
        setPixel(src, x, y, 255, 255, 255, 255);
      } else if (x < 180 || x >= 844 || y < 180 || y >= 844) {
        setPixel(src, x, y, 30, 30, 36, 255);
      } else if (y < 450) {
        setPixel(src, x, y, 200, 162, 200, 255);
      } else {
        setPixel(src, x, y, 252, 231, 200, 255);
      }
    }
  }

  const s1 = removeCornerBackground(src, { tolerance: 25 });
  const s2 = quantizeAndCleanColors(s1.imageData, { colorCount: 8 });
  const s3 = segmentRegions(s2.imageData);
  const regionPreview = createRegionMapImageData(
    s3.regionMap,
    s3.width,
    s3.height,
    s3.regions.length,
  );
  const totalMs =
    s1.processingTimeMs + s2.processingTimeMs + s3.processingTimeMs;

  assert.ok(totalMs < 1500, `Expected <1500ms, got ${totalMs}ms`);
  assert.equal(regionPreview.width, 1024);
  console.log(
    `Test 5 PASS: 1024x1024 Stage 1->2->3 completed in ${totalMs.toFixed(1)} ms ` +
      `(S1=${s1.processingTimeMs}ms, S2=${s2.processingTimeMs}ms, S3=${s3.processingTimeMs}ms, ` +
      `regions=${s3.regions.length}).`,
  );
}
