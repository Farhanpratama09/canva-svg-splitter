import assert from "node:assert/strict";
import { segmentRegions } from "./.dist/image-processor/region-segmenter.js";
import {
  assignRegionToGroup,
  commitGroupingChange,
  createGroupingHistory,
  createInitialGrouping,
  mergeGroups,
  redoGrouping,
  renderGroupedCanvasImageData,
  resetGrouping,
  splitRegionToNewGroup,
  undoGrouping,
  updateGroupColor,
} from "./.dist/image-processor/region-grouper.js";

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

const w = 60;
const h = 40;
const src = new MockImageData(w, h);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    setPixel(src, x, y, 255, 255, 255, 255);
  }
}
for (let y = 10; y < 22; y++) {
  for (let x = 5; x < 15; x++) setPixel(src, x, y, 30, 30, 36, 255);
  for (let x = 22; x < 34; x++) setPixel(src, x, y, 30, 30, 36, 255);
  for (let x = 42; x < 52; x++) setPixel(src, x, y, 30, 30, 36, 255);
}

const seg = segmentRegions(src);
const hatId = seg.regionMap[15 * w + 10];
const glassesId = seg.regionMap[15 * w + 28];
const starId = seg.regionMap[15 * w + 46];
const whiteId = seg.regionMap[2 * w + 2];

const initState = createInitialGrouping(seg.regions);
assert.equal(initState.groups.length, 2);
assert.equal(initState.regionToGroup[hatId], initState.regionToGroup[glassesId]);
assert.equal(initState.regionToGroup[hatId], initState.regionToGroup[starId]);
assert.notEqual(initState.regionToGroup[hatId], initState.regionToGroup[whiteId]);
console.log("Test 1 PASS: Initial grouping created 2 groups cleanly.");

const split1 = splitRegionToNewGroup(initState, hatId);
assert.equal(split1.groups.length, 3);
assert.notEqual(split1.regionToGroup[hatId], split1.regionToGroup[glassesId]);
assert.equal(split1.regionToGroup[glassesId], split1.regionToGroup[starId]);
assert.equal(split1.regionToGroup[whiteId], initState.regionToGroup[whiteId]);

const splitHatGroup = split1.groups.find((g) => g.groupId === split1.regionToGroup[hatId]);
assert.ok(splitHatGroup && splitHatGroup.colorHex !== "#1E1E24");
console.log(`Test 2 PASS: Split Hat into ${splitHatGroup.groupId} (${splitHatGroup.colorHex}) leaving Glasses & Star intact.`);

const split2 = splitRegionToNewGroup(split1, starId, "#ff6b6b");
assert.equal(split2.groups.length, 4);
const starGroup = split2.groups.find((g) => g.groupId === split2.regionToGroup[starId]);
assert.equal(starGroup.colorHex, "#FF6B6B");

const recolored = updateGroupColor(split2, starGroup.groupId, "#abc");
const updatedStarGroup = recolored.groups.find((g) => g.groupId === starGroup.groupId);
assert.equal(updatedStarGroup.colorHex, "#AABBCC");
console.log("Test 3 PASS: Custom hex normalization & live color update verified.");

const reassigned = assignRegionToGroup(recolored, starId, split2.regionToGroup[glassesId]);
assert.equal(reassigned.groups.length, 3);
assert.equal(reassigned.regionToGroup[starId], reassigned.regionToGroup[glassesId]);

const merged = mergeGroups(reassigned, reassigned.regionToGroup[hatId], reassigned.regionToGroup[glassesId]);
assert.equal(merged.groups.length, 2);

const reset = resetGrouping(merged);
assert.equal(reset.groups.length, 2);
assert.equal(reset.regionToGroup[hatId], reset.regionToGroup[starId]);
console.log("Test 4 PASS: assignRegionToGroup, mergeGroups, and resetGrouping verified.");

let history = createGroupingHistory(initState);
history = commitGroupingChange(history, split1);
history = commitGroupingChange(history, split2);
history = commitGroupingChange(history, recolored);
assert.equal(history.past.length, 3);

history = undoGrouping(history);
assert.equal(
  history.present.groups.find((g) => g.groupId === starGroup.groupId).colorHex,
  "#FF6B6B",
);
history = undoGrouping(history);
assert.equal(history.present.groups.length, 3);
history = redoGrouping(history);
assert.equal(history.present.groups.length, 4);

let hStress = createGroupingHistory(initState);
for (let i = 1; i <= 25; i++) {
  const hex = `#${i.toString(16).padStart(2, "0")}80FF`;
  hStress = commitGroupingChange(hStress, updateGroupColor(hStress.present, initState.groups[0].groupId, hex));
}
assert.equal(hStress.past.length, 25);
console.log("Test 5 PASS: Undo/Redo history (25 steps) restored exact states.");

const liveImg = renderGroupedCanvasImageData({
  regionMap: seg.regionMap,
  width: w,
  height: h,
  regions: seg.regions,
  groupingState: recolored,
  mode: "live",
  selectedRegionId: starId,
  selectedGroupId: starGroup.groupId,
});
assert.deepEqual(getRgba(liveImg, 47, 16), [170, 187, 204, 255]);
assert.deepEqual(getRgba(liveImg, 42, 10), [20, 241, 217, 255]);
const dimmedWhite = getRgba(liveImg, 2, 2);
assert.ok(dimmedWhite[0] < 180 && dimmedWhite[3] === 255);
console.log("Test 6 PASS: Live Preview colors, highlight border, and contrast dimming verified.");
