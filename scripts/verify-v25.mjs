import assert from "node:assert/strict";
import {
  assignRegionToGroup,
  commitGroupingChange,
  createGroupingHistory,
  createInitialGrouping,
  mergeGroups,
  mergeSelectedRegions,
  redoGrouping,
  removeRegionFromGroup,
  renameGroup,
  rgbToHsl,
  splitSelectedRegionsToNewGroup,
  undoGrouping,
} from "./.dist/image-processor/region-grouper.js";
import {
  applyBrushStroke3D,
  commit3DChange,
  commitCandidateSelection3D,
  computeLuminancePreservingRgb,
  computePerceptualLuminance,
  create3DHistory,
  createEmpty3DState,
  findGroupAtPixel3D,
  floodFillSelect3D,
  prepare3DImageData,
  recomputeGroupTolerance3D,
  redo3D,
  renameGroup3D,
  render3DExportImageData,
  selectGlobalSimilar3D,
  smoothSelectionMask3D,
  subtractRegion3DAtPoint,
  toggleCandidatePoint3D,
  undo3D,
  updateGroupColor3D,
} from "./.dist/image-processor/recolor-3d-engine.js";

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

function getPixel(img, x, y) {
  const idx = (y * img.width + x) * 4;
  return {
    r: img.data[idx],
    g: img.data[idx + 1],
    b: img.data[idx + 2],
    a: img.data[idx + 3],
  };
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

// ---------------------------------------------------------------------------
// Test 1: renameGroup + GroupingHistory Undo/Redo + mergeGroups name preserve
// ---------------------------------------------------------------------------
{
  const mockRegions = [
    {
      regionId: 1,
      originalHex: "#C8A2C8",
      r: 200,
      g: 162,
      b: 200,
      assignedGroupId: "",
      pixelCount: 4000,
    },
    {
      regionId: 2,
      originalHex: "#FF6B6B",
      r: 255,
      g: 107,
      b: 107,
      assignedGroupId: "",
      pixelCount: 2500,
    },
    {
      regionId: 3,
      originalHex: "#FFD166",
      r: 255,
      g: 209,
      b: 102,
      assignedGroupId: "",
      pixelCount: 1200,
    },
  ].map((item) => ({
    ...item,
    boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 },
    centroid: { x: 1, y: 1 },
  }));

  const initial = createInitialGrouping(mockRegions);
  let history = createGroupingHistory(initial);

  // Empty rename must be ignored (returns identical reference)
  assert.equal(renameGroup(history.present, "group-1", "   "), history.present);

  // Custom rename with extra spacing gets normalized cleanly
  const renamed = renameGroup(history.present, "group-1", "  Topi   Kucing  ");
  assert.equal(renamed.groups[0].name, "Topi Kucing");

  history = commitGroupingChange(history, renamed);
  assert.equal(history.present.groups[0].name, "Topi Kucing");

  // Undo & Redo preserve rename history
  history = undoGrouping(history);
  assert.equal(history.present.groups[0].name, "Grup 1");
  history = redoGrouping(history);
  assert.equal(history.present.groups[0].name, "Topi Kucing");

  // Merge unnamed Grup 2 into custom "Topi Kucing" -> retains "Topi Kucing"
  const mergedIntoCustom = mergeGroups(history.present, "group-2", "group-1");
  assert.equal(mergedIntoCustom.groups.find((g) => g.groupId === "group-1")?.name, "Topi Kucing");

  // Merge custom "Syal" into unnamed "Grup 3" -> retains custom "Syal"
  const namedGroup2 = renameGroup(history.present, "group-2", "Syal");
  const mergedCustomIntoDefault = mergeGroups(namedGroup2, "group-2", "group-3");
  assert.equal(mergedCustomIntoDefault.groups.find((g) => g.groupId === "group-3")?.name, "Syal");

  console.log("Test 1 PASS: renameGroup, Undo/Redo, and mergeGroups name preservation verified.");
}

// ---------------------------------------------------------------------------
// Test 2: HSV + Sobel Edge-Aware Flood-Fill on Synthetic 3D Gradient Scene
// ---------------------------------------------------------------------------
{
  const w = 120;
  const h = 120;
  const src = new MockImageData(w, h);

  // 1) Glossy Blue 3D Sphere centered at (36, 52), radius 28
  //    Highlight near (26, 40) -> Midtone -> Deep Shadow near bottom-right
  const blueCx = 36;
  const blueCy = 52;
  const blueR = 28;
  for (let y = blueCy - blueR; y <= blueCy + blueR; y++) {
    for (let x = blueCx - blueR; x <= blueCx + blueR; x++) {
      const distCenter = Math.hypot(x - blueCx, y - blueCy);
      if (distCenter > blueR) continue;
      const dLight = Math.hypot(x - 26, y - 40) / (blueR * 1.85);
      const t = Math.min(1, dLight);
      let r, g, b;
      if (t < 0.3) {
        const u = t / 0.3;
        r = lerp(236, 42, u);
        g = lerp(246, 165, u);
        b = lerp(255, 245, u);
      } else {
        const u = (t - 0.3) / 0.7;
        r = lerp(42, 10, u);
        g = lerp(165, 38, u);
        b = lerp(245, 96, u);
      }
      // Keep soft AA edge on outer ring to verify smooth alpha preservation
      const alpha = distCenter > blueR - 1 ? 180 : 255;
      setPixel(src, x, y, r, g, b, alpha);
    }
  }

  // 2) Adjacent Coral-Red 3D Sphere centered at (86, 52), radius 22 (touching at x=64)
  const redCx = 86;
  const redCy = 52;
  const redR = 22;
  for (let y = redCy - redR; y <= redCy + redR; y++) {
    for (let x = redCx - redR; x <= redCx + redR; x++) {
      const distCenter = Math.hypot(x - redCx, y - redCy);
      if (distCenter > redR) continue;
      const t = Math.min(1, Math.hypot(x - 78, y - 42) / (redR * 1.85));
      const r = lerp(255, 118, t);
      const g = lerp(218, 22, t);
      const b = lerp(210, 26, t);
      setPixel(src, x, y, r, g, b, 255);
    }
  }

  // 3) Neutral White/Gray 3D Block at x: 18..102, y: 88..112
  for (let y = 88; y <= 112; y++) {
    const t = (y - 88) / 24;
    const v = lerp(255, 92, t);
    for (let x = 18; x <= 102; x++) {
      setPixel(src, x, y, v, v, Math.min(255, v + 3), 255);
    }
  }

  const prepared = prepare3DImageData(src);
  let state = createEmpty3DState(w, h);

  // Tap Blue Sphere midtone at (40, 56)
  const blueFill = floodFillSelect3D({
    state,
    prepared,
    seedX: 40,
    seedY: 56,
    tolerance: 28,
  });
  assert.ok(blueFill.groupId);
  state = blueFill.state;

  const blueGroupId = blueFill.groupId;
  const blueMaskId = state.groupToMaskId[blueGroupId];
  assert.ok(blueMaskId > 0);

  // Highlight (26, 40), Midtone (40, 56), and Deep Shadow (52, 68) MUST all belong to the same group
  assert.equal(state.maskMap[40 * w + 26], blueMaskId, "Specular highlight must be included in Blue 3D sphere mask");
  assert.equal(state.maskMap[56 * w + 40], blueMaskId, "Midtone must be included in Blue 3D sphere mask");
  assert.equal(state.maskMap[68 * w + 52], blueMaskId, "Deep shadow must be included in Blue 3D sphere mask");

  // Adjacent Red Sphere & Neutral Block MUST NOT leak into Blue Sphere mask
  assert.equal(state.maskMap[52 * w + 86], 0, "Red sphere center must remain unselected");
  assert.equal(state.maskMap[52 * w + 68], 0, "Red sphere edge must remain blocked by hue + Sobel barrier");
  assert.equal(state.maskMap[100 * w + 60], 0, "Neutral white block must remain unselected");

  // Tolerance slider recomputation (5..60)
  const tightState = recomputeGroupTolerance3D(state, prepared, blueGroupId, 10);
  const wideState = recomputeGroupTolerance3D(state, prepared, blueGroupId, 52);
  const tightCount = tightState.groups.find((g) => g.groupId === blueGroupId).pixelCount;
  const wideCount = wideState.groups.find((g) => g.groupId === blueGroupId).pixelCount;
  assert.ok(wideCount >= tightCount && wideCount > 1500);
  // Even at tolerance 52, red sphere must stay blocked!
  assert.equal(wideState.maskMap[52 * w + 86], 0);

  // Tap Neutral Block (60, 96) -> detected as neutral group
  const neutralFill = floodFillSelect3D({
    state: wideState,
    prepared,
    seedX: 60,
    seedY: 96,
    tolerance: 26,
  });
  assert.ok(neutralFill.groupId);
  const neutralGroup = neutralFill.state.groups.find((g) => g.groupId === neutralFill.groupId);
  assert.equal(neutralGroup.isNeutral, true, "White/gray shaded 3D block must be flagged isNeutral=true");
  assert.equal(neutralFill.state.maskMap[89 * w + 50], neutralFill.state.groupToMaskId[neutralGroup.groupId]);
  assert.equal(neutralFill.state.maskMap[110 * w + 50], neutralFill.state.groupToMaskId[neutralGroup.groupId]);

  // Brush + Eraser + Rename + Undo/Redo in Mode 3D
  let hist3D = create3DHistory(neutralFill.state);
  const brushed = applyBrushStroke3D({
    state: hist3D.present,
    prepared,
    groupId: blueGroupId,
    mode: "brush",
    points: [{ x: 86, y: 52 }, { x: 88, y: 52 }],
    radius: 3,
  });
  assert.equal(brushed.state.maskMap[52 * w + 86], brushed.state.groupToMaskId[blueGroupId]);
  hist3D = commit3DChange(hist3D, brushed.state);

  const erased = applyBrushStroke3D({
    state: hist3D.present,
    prepared,
    groupId: blueGroupId,
    mode: "eraser",
    points: [{ x: 86, y: 52 }],
    radius: 4,
  });
  assert.equal(erased.state.maskMap[52 * w + 86], 0);
  hist3D = commit3DChange(hist3D, erased.state);

  hist3D = commit3DChange(hist3D, renameGroup3D(hist3D.present, blueGroupId, "Bola Biru"));
  assert.equal(hist3D.present.groups.find((g) => g.groupId === blueGroupId)?.name, "Bola Biru");

  hist3D = undo3D(hist3D);
  assert.equal(hist3D.present.groups.find((g) => g.groupId === blueGroupId)?.name, "Area 1");
  hist3D = redo3D(hist3D);
  assert.equal(hist3D.present.groups.find((g) => g.groupId === blueGroupId)?.name, "Bola Biru");

  console.log(
    `Test 2 PASS: 3D HSV+Sobel flood-fill captured full sphere (tight=${tightCount}px, wide=${wideCount}px), blocked adjacent red object, and verified Brush/Eraser/Rename/Undo.`,
  );

  // -------------------------------------------------------------------------
  // Test 3: Luminance-Preserving Recolor (Colored 3D & Neutral White 3D)
  // -------------------------------------------------------------------------
  // Recolor Blue Sphere -> Emerald Green (#10B981) and Neutral White Block -> Pastel Blue (#93C5FD)
  let recoloredState = updateGroupColor3D(hist3D.present, blueGroupId, "#10B981");
  recoloredState = updateGroupColor3D(recoloredState, neutralGroup.groupId, "#93C5FD");

  const exported = render3DExportImageData(prepared, recoloredState);

  // 3a) Check colored 3D sphere: perceptual luminance preserved from highlight -> midtone -> shadow
  const sampleCoords = [
    [26, 40], // Highlight
    [40, 56], // Midtone
    [52, 68], // Shadow
  ];

  const lumsBefore = [];
  const lumsAfter = [];
  for (const [sx, sy] of sampleCoords) {
    const before = getPixel(src, sx, sy);
    const after = getPixel(exported, sx, sy);
    const lBefore = computePerceptualLuminance(before.r, before.g, before.b);
    const lAfter = computePerceptualLuminance(after.r, after.g, after.b);
    lumsBefore.push(lBefore);
    lumsAfter.push(lAfter);

    assert.ok(
      Math.abs(lAfter - lBefore) <= 0.035,
      `Perceptual luminance drifted too much at (${sx},${sy}): before=${lBefore.toFixed(3)}, after=${lAfter.toFixed(3)}`,
    );
  }

  assert.ok(
    lumsAfter[0] > lumsAfter[1] && lumsAfter[1] > lumsAfter[2],
    "Highlight > Midtone > Shadow luminance ordering must stay strictly intact",
  );

  // Midtone hue must have shifted to Green (~140..175 deg)
  const midAfter = getPixel(exported, 40, 56);
  const midHsl = rgbToHsl(midAfter.r, midAfter.g, midAfter.b);
  assert.ok(
    midHsl.h >= 135 && midHsl.h <= 178 && midHsl.s > 0.35,
    `Expected Green hue after recolor, got H=${midHsl.h.toFixed(1)}, S=${midHsl.s.toFixed(2)}`,
  );

  // Soft AA edge alpha preserved (not quantized to 255)
  const edgePixelBefore = getPixel(src, blueCx + blueR, blueCy);
  const edgePixelAfter = getPixel(exported, blueCx + blueR, blueCy);
  assert.equal(edgePixelAfter.a, edgePixelBefore.a, "Soft alpha silhouette must be preserved in Mode 3D");

  // Unselected Red Sphere remains 100% untouched
  const redBefore = getPixel(src, 86, 52);
  const redAfter = getPixel(exported, 86, 52);
  assert.deepEqual(redAfter, redBefore);

  // 3b) Check neutral white/gray 3D block -> Pastel Blue (#93C5FD) preserves 3D gradient
  const topWhiteAfter = getPixel(exported, 60, 89);
  const midGrayAfter = getPixel(exported, 60, 100);
  const darkGrayAfter = getPixel(exported, 60, 111);

  const topHsl = rgbToHsl(topWhiteAfter.r, topWhiteAfter.g, topWhiteAfter.b);
  assert.ok(
    topWhiteAfter.b > topWhiteAfter.r && topHsl.s > 0.35,
    `White 3D surface must be tinted pastel blue, got rgb(${topWhiteAfter.r},${topWhiteAfter.g},${topWhiteAfter.b})`,
  );

  const lumTop = computePerceptualLuminance(topWhiteAfter.r, topWhiteAfter.g, topWhiteAfter.b);
  const lumMid = computePerceptualLuminance(midGrayAfter.r, midGrayAfter.g, midGrayAfter.b);
  const lumDark = computePerceptualLuminance(darkGrayAfter.r, darkGrayAfter.g, darkGrayAfter.b);
  assert.ok(
    lumTop > lumMid && lumMid > lumDark,
    `Neutral tinted 3D shading gradient must remain monotonic (${lumTop.toFixed(3)} > ${lumMid.toFixed(3)} > ${lumDark.toFixed(3)})`,
  );

  // Direct pixel helper check
  const [cr, cg, cb] = computeLuminancePreservingRgb(40, 120, 230, 239, 68, 68, false);
  const origY = computePerceptualLuminance(40, 120, 230);
  const newY = computePerceptualLuminance(cr, cg, cb);
  assert.ok(Math.abs(origY - newY) <= 0.02);

  // 3c) Verify tolerance slider sensitivity (5 vs 55) on warm hue-shifting sunset gradient
  const gradW = 60;
  const gradH = 30;
  const gradImg = new MockImageData(gradW, gradH);
  for (let y = 0; y < gradH; y++) {
    for (let x = 0; x < gradW; x++) {
      const t = x / (gradW - 1);
      // Shifts smoothly from bright yellow (hue ~55) to deep orange-red (hue ~10)
      setPixel(gradImg, x, y, 250, lerp(230, 60, t), 30, 255);
    }
  }
  const gradPrep = prepare3DImageData(gradImg);
  const gradInit = floodFillSelect3D({
    state: createEmpty3DState(gradW, gradH),
    prepared: gradPrep,
    seedX: 5,
    seedY: 15,
    tolerance: 8,
  });
  const gradLowCount = gradInit.state.groups[0].pixelCount;
  const gradHighState = recomputeGroupTolerance3D(gradInit.state, gradPrep, gradInit.groupId, 52);
  const gradHighCount = gradHighState.groups[0].pixelCount;
  assert.ok(
    gradHighCount > gradLowCount,
    `Expected tolerance 52 (${gradHighCount}px) to select more hue-shifted gradient than tolerance 8 (${gradLowCount}px)`,
  );

  console.log(
    `Test 3 PASS: Luminance-Preserving Recolor preserved highlight/mid/shadow luminance (${lumsAfter.map((v) => v.toFixed(2)).join(" > ")}) and tinted white 3D gradient to pastel blue (tol 8->52: ${gradLowCount}->${gradHighCount}px).`,
  );
}

// ---------------------------------------------------------------------------
// Test 4: Strict 4-Directional Connectivity, Hard Sobel Barrier & Dark Outline Wall
// ---------------------------------------------------------------------------
{
  const w = 80;
  const h = 64;
  const img = new MockImageData(w, h);

  // Fill top-left corner triangle (x + y < 28) with Coral-Peach (#F59E7A)
  // Diagonal 1px Dark Outline Wall at x + y === 28 (#1D1A1F, lum < 0.12, sat < 0.25)
  // Fill opposite side of diagonal wall (x + y > 28, x < 40, y < 40) with IDENTICAL Coral-Peach
  // -> Strict 4-way connectivity MUST NOT jump diagonally across this 1px dark outline!
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      if (x + y === 28) {
        setPixel(img, x, y, 29, 26, 31, 255); // 1px diagonal dark outline wall
      } else {
        setPixel(img, x, y, 245, 158, 122, 255);
      }
    }
  }

  // Right side (x = 40..79, y = 0..63):
  // Top-right face (#F5B995) separated from bottom-right yellow horn (#FACC15) by 1px dark outline at y = 30
  for (let y = 0; y < 30; y++) {
    for (let x = 41; x < 76; x++) {
      setPixel(img, x, y, 245, 185, 149, 255);
    }
  }
  for (let x = 40; x < 76; x++) {
    setPixel(img, x, 30, 24, 22, 26, 255); // Horizontal 1px black outline
  }
  for (let y = 31; y < 60; y++) {
    for (let x = 41; x < 76; x++) {
      setPixel(img, x, y, 250, 204, 21, 255);
    }
  }
  // Vertical 1px black divider separating diagonal zone from right-hand face/horn
  for (let y = 0; y < 60; y++) {
    setPixel(img, 40, y, 24, 22, 26, 255);
  }

  const prep = prepare3DImageData(img);

  // 4a) Verify strict 4-way flood-fill CANNOT jump across 1px diagonal dark outline at default tolerance 28
  const diagRes = floodFillSelect3D({
    state: createEmpty3DState(w, h),
    prepared: prep,
    seedX: 10,
    seedY: 10,
    tolerance: 28,
  });
  assert.ok(diagRes.groupId);
  const diagMaskId = diagRes.state.groupToMaskId[diagRes.groupId];
  assert.equal(diagRes.state.maskMap[10 * w + 10], diagMaskId, "Seed pixel must be selected");
  assert.equal(diagRes.state.maskMap[14 * w + 14], 0, "1px diagonal dark outline pixel must NEVER be selected");
  assert.equal(
    diagRes.state.maskMap[22 * w + 22],
    0,
    "4-way flood-fill must NOT leak diagonally across 1px dark outline even to same-colored pixels",
  );

  // 4b) Tap top-right Peach face (56, 15) at default tolerance 28 -> must NOT cross y=30 outline into yellow horn!
  const faceRes = floodFillSelect3D({
    state: diagRes.state,
    prepared: prep,
    seedX: 56,
    seedY: 15,
    tolerance: 28,
  });
  assert.ok(faceRes.groupId);
  const faceMaskId = faceRes.state.groupToMaskId[faceRes.groupId];
  assert.equal(faceRes.state.maskMap[15 * w + 56], faceMaskId, "Face seed must be selected");
  assert.equal(faceRes.state.maskMap[30 * w + 56], 0, "Horizontal dark outline must remain unselected");
  assert.equal(
    faceRes.state.maskMap[45 * w + 56],
    0,
    "Selection must NOT leak past 1px dark outline into yellow horn at default tolerance",
  );

  console.log("Test 4 PASS: Strict 4-way connectivity, hard Sobel barrier, and 1px dark outline wall blocking verified.");
}

// ---------------------------------------------------------------------------
// Test 5: Multi-Select (+ Tambah / - Kurangi) in Mode 2D & Mode 3D + Undo/Redo
// ---------------------------------------------------------------------------
{
  // 5a) Mode 2D Multi-Select
  const regions2D = [
    { regionId: 1, originalHex: "#FF6B6B", r: 255, g: 107, b: 107, assignedGroupId: "", pixelCount: 500 },
    { regionId: 2, originalHex: "#4ECDC4", r: 78, g: 205, b: 196, assignedGroupId: "", pixelCount: 400 },
    { regionId: 3, originalHex: "#FFD166", r: 255, g: 209, b: 102, assignedGroupId: "", pixelCount: 300 },
  ].map((item) => ({
    ...item,
    boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 },
    centroid: { x: 1, y: 1 },
  }));

  let hist2D = createGroupingHistory(createInitialGrouping(regions2D));
  const g1 = hist2D.present.groups[0].groupId;

  // + Tambah region 2 & region 3 into group-1
  hist2D = commitGroupingChange(hist2D, assignRegionToGroup(hist2D.present, 2, g1));
  hist2D = commitGroupingChange(hist2D, assignRegionToGroup(hist2D.present, 3, g1));
  assert.deepEqual(hist2D.present.groups.find((g) => g.groupId === g1)?.regionIds, [1, 2, 3]);

  // - Kurangi region 2 out of group-1
  hist2D = commitGroupingChange(hist2D, removeRegionFromGroup(hist2D.present, 2, g1));
  assert.deepEqual(hist2D.present.groups.find((g) => g.groupId === g1)?.regionIds, [1, 3]);
  assert.notEqual(hist2D.present.regionToGroup[2], g1);

  // Undo & Redo verify
  hist2D = undoGrouping(hist2D);
  assert.deepEqual(hist2D.present.groups.find((g) => g.groupId === g1)?.regionIds, [1, 2, 3]);
  hist2D = redoGrouping(hist2D);
  assert.deepEqual(hist2D.present.groups.find((g) => g.groupId === g1)?.regionIds, [1, 3]);

  // 5b) Mode 3D Multi-Select (+ Tambah / - Kurangi)
  const w = 60;
  const h = 30;
  const img3D = new MockImageData(w, h);
  // Two disconnected purple islands separated by black outline
  for (let y = 5; y < 25; y++) {
    for (let x = 4; x < 18; x++) setPixel(img3D, x, y, 168, 85, 247, 255);
    for (let x = 22; x < 28; x++) setPixel(img3D, x, y, 25, 25, 30, 255);
    for (let x = 34; x < 50; x++) setPixel(img3D, x, y, 168, 85, 247, 255);
  }

  const prep3D = prepare3DImageData(img3D);
  let hist3D = create3DHistory(createEmpty3DState(w, h));

  // Initial tap on left island
  const first = floodFillSelect3D({
    state: hist3D.present,
    prepared: prep3D,
    seedX: 10,
    seedY: 15,
    tolerance: 24,
  });
  assert.ok(first.groupId);
  const active3DId = first.groupId;
  hist3D = commit3DChange(hist3D, first.state);
  const countAfterFirst = hist3D.present.groups[0].pixelCount;

  // + Tambah right island into the SAME active group
  const added = floodFillSelect3D({
    state: hist3D.present,
    prepared: prep3D,
    seedX: 42,
    seedY: 15,
    tolerance: 24,
    targetGroupId: active3DId,
  });
  hist3D = commit3DChange(hist3D, added.state);
  const countAfterAdd = hist3D.present.groups[0].pixelCount;
  assert.ok(countAfterAdd > countAfterFirst * 1.8, "Both islands must belong to active3DId after + Tambah");

  // Tolerance slider recomputation retains BOTH multi-selected islands
  const recomputed = recomputeGroupTolerance3D(hist3D.present, prep3D, active3DId, 36);
  const maskId = recomputed.groupToMaskId[active3DId];
  assert.equal(recomputed.maskMap[15 * w + 10], maskId);
  assert.equal(recomputed.maskMap[15 * w + 42], maskId);

  // - Kurangi right island out of active3DId
  const subtracted = subtractRegion3DAtPoint({
    state: hist3D.present,
    prepared: prep3D,
    groupId: active3DId,
    seedX: 42,
    seedY: 15,
    tolerance: 24,
  });
  assert.ok(subtracted.removedPixels > 200);
  hist3D = commit3DChange(hist3D, subtracted.state);
  assert.equal(hist3D.present.maskMap[15 * w + 42], 0, "Subtracted island must be cleared");
  assert.equal(hist3D.present.maskMap[15 * w + 10], hist3D.present.groupToMaskId[active3DId], "Left island must remain selected");

  // Undo restores subtracted island, Redo removes it again
  hist3D = undo3D(hist3D);
  assert.equal(hist3D.present.maskMap[15 * w + 42], hist3D.present.groupToMaskId[active3DId]);
  hist3D = redo3D(hist3D);
  assert.equal(hist3D.present.maskMap[15 * w + 42], 0);

  console.log("Test 5 PASS: Multi-Select (+ Tambah / - Kurangi) and Undo/Redo verified for Mode 2D and Mode 3D.");
}

// ---------------------------------------------------------------------------
// Test 6: selectGlobalSimilar3D (Global Color Range across black outline walls)
// ---------------------------------------------------------------------------
{
  const w = 90;
  const h = 40;
  const img = new MockImageData(w, h);

  // Fill background with black outline walls (#1E1E24)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      setPixel(img, x, y, 30, 30, 36, 255);
    }
  }

  // 3 disconnected shaded Yellow/Gold islands separated by black outlines
  for (let y = 6; y < 34; y++) {
    const shade = (y - 6) / 27;
    const yr = lerp(255, 224, shade);
    const yg = lerp(218, 165, shade);
    const yb = lerp(110, 28, shade);
    for (let x = 4; x < 18; x++) setPixel(img, x, y, yr, yg, yb, 255);
    for (let x = 24; x < 38; x++) setPixel(img, x, y, yr, yg, yb, 255);
    for (let x = 44; x < 58; x++) setPixel(img, x, y, yr, yg, yb, 255);
    // Green control island + White control island
    for (let x = 64; x < 74; x++) setPixel(img, x, y, 34, 197, 94, 255);
    for (let x = 78; x < 86; x++) setPixel(img, x, y, 255, 255, 255, 255);
  }

  // Direct call signature: selectGlobalSimilar3D(imageData, seedX, seedY, tolerance)
  const globalRes = selectGlobalSimilar3D(img, 10, 14, 28);
  assert.ok(globalRes.groupId);
  assert.ok(globalRes.pixelCount > 1000);

  // All 3 yellow islands must be selected across the black outline dividers (0..255 coverage mask)
  assert.ok(globalRes.mask[14 * w + 10] > 0 && globalRes.mask[14 * w + 10] <= 255, "Yellow island 1 selected");
  assert.ok(globalRes.mask[14 * w + 30] > 0 && globalRes.mask[14 * w + 30] <= 255, "Yellow island 2 selected across black wall");
  assert.ok(globalRes.mask[24 * w + 50] > 0 && globalRes.mask[24 * w + 50] <= 255, "Yellow island 3 shaded pixel selected");

  // Black outline walls, Green island, and White island must NOT be selected
  assert.equal(globalRes.mask[14 * w + 20], 0, "Black outline divider must NOT be selected");
  assert.equal(globalRes.mask[14 * w + 68], 0, "Green island must NOT be selected");
  assert.equal(globalRes.mask[14 * w + 82], 0, "White island must NOT be selected");

  console.log(`Test 6 PASS: selectGlobalSimilar3D matched all 3 yellow islands (${globalRes.pixelCount}px) ignoring black outline walls.`);
}

// ---------------------------------------------------------------------------
// Test 7: Clean v2.5 3D Start + Active Tolerance + Multi-Select Candidates & Undo/Redo
// ---------------------------------------------------------------------------
{
  // 7A. Mode 2D: Non-destructive batch merge & split with atomic Undo/Redo
  const mockRegions2D = [
    { regionId: 1, originalHex: "#EF4444", r: 239, g: 68, b: 68, assignedGroupId: "", pixelCount: 1500 },
    { regionId: 2, originalHex: "#3B82F6", r: 59, g: 130, b: 246, assignedGroupId: "", pixelCount: 1800 },
    { regionId: 3, originalHex: "#10B981", r: 16, g: 185, b: 129, assignedGroupId: "", pixelCount: 1200 },
  ].map((item) => ({
    ...item,
    boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 },
    centroid: { x: 1, y: 1 },
  }));

  let hist2D = createGroupingHistory(createInitialGrouping(mockRegions2D));
  assert.equal(hist2D.present.groups.length, 3, "Initial 2D grouping starts with 3 groups");

  const tempSelected = [1, 3];
  assert.equal(hist2D.past.length, 0, "Temporary selection must not pollute Undo stack");

  const merged2D = mergeSelectedRegions(hist2D.present, tempSelected);
  hist2D = commitGroupingChange(hist2D, merged2D);
  assert.equal(hist2D.present.groups.length, 2, "Merging [1, 3] yields 2 groups");
  assert.equal(hist2D.present.regionToGroup[1], hist2D.present.regionToGroup[3]);
  assert.equal(hist2D.past.length, 1);

  hist2D = undoGrouping(hist2D);
  assert.equal(hist2D.present.groups.length, 3);
  hist2D = redoGrouping(hist2D);
  assert.equal(hist2D.present.groups.length, 2);

  const split2D = splitSelectedRegionsToNewGroup(hist2D.present, [3], "#F59E0B");
  hist2D = commitGroupingChange(hist2D, split2D);
  assert.equal(hist2D.present.groups.length, 3);
  const r3Group = hist2D.present.groups.find((g) => g.groupId === hist2D.present.regionToGroup[3]);
  assert.equal(r3Group?.colorHex, "#F59E0B");

  hist2D = undoGrouping(hist2D);
  assert.equal(hist2D.present.groups.length, 2);

  // 7B. Mode 3D: Clean initial start (groups: []) + 2-Stage Multi-Select Candidates + Undo/Redo
  const w = 96;
  const h = 64;
  const img3D = new MockImageData(w, h);

  // 1) Shaded Cyan Sphere at (22, 22), radius 13
  for (let y = 8; y <= 36; y++) {
    for (let x = 8; x <= 36; x++) {
      const dist = Math.hypot(x - 22, y - 22);
      if (dist <= 13) {
        const hl = Math.hypot(x - 18, y - 17);
        const shade = Math.max(0.35, 1 - dist / 15);
        const spec = Math.max(0, 1 - hl / 5) * 0.55;
        setPixel(
          img3D,
          x,
          y,
          Math.min(255, Math.round(25 * shade + 190 * spec)),
          Math.min(255, Math.round(205 * shade + 50 * spec)),
          Math.min(255, Math.round(230 * shade + 25 * spec)),
          255,
        );
      }
    }
  }

  // 2) Coral Shaded Sphere at (74, 22), radius 12
  for (let y = 9; y <= 35; y++) {
    for (let x = 61; x <= 87; x++) {
      const dist = Math.hypot(x - 74, y - 22);
      if (dist <= 12) {
        const shade = Math.max(0.4, 1 - dist / 14);
        setPixel(img3D, x, y, Math.round(240 * shade), Math.round(80 * shade), Math.round(70 * shade), 255);
      }
    }
  }

  // 3) Yellow Block at x=12..34, y=42..57
  for (let y = 42; y <= 57; y++) {
    for (let x = 12; x <= 34; x++) {
      const shade = 0.7 + ((x - 12) / 22) * 0.3;
      setPixel(img3D, x, y, Math.round(250 * shade), Math.round(215 * shade), Math.round(45 * shade), 255);
    }
  }

  // 4) Neutral White/Gray Base at x=48..80, y=42..57
  for (let y = 42; y <= 57; y++) {
    for (let x = 48; x <= 80; x++) {
      const v = Math.round(210 + ((y - 42) / 15) * 35);
      setPixel(img3D, x, y, v, v, v, 255);
    }
  }

  const prepared3D = prepare3DImageData(img3D);
  let hist3D = create3DHistory(createEmpty3DState(w, h));

  // Verify Mode 3D starts clean without auto-splitting all areas into many groups
  assert.equal(hist3D.present.groups.length, 0, "Mode 3D must start clean with groups: []");
  const cleanExport = render3DExportImageData(prepared3D, hist3D.present);
  assert.deepEqual(getPixel(cleanExport, 22, 22), getPixel(img3D, 22, 22));

  // Default tap creates 1 group on Cyan Sphere via floodFillSelect3D
  const tapCyan = floodFillSelect3D({
    state: hist3D.present,
    prepared: prepared3D,
    seedX: 22,
    seedY: 22,
    tolerance: 26,
  });
  assert.ok(tapCyan.groupId);
  hist3D = commit3DChange(hist3D, tapCyan.state);
  assert.equal(hist3D.present.groups.length, 1);
  assert.equal(findGroupAtPixel3D(hist3D.present, 22, 22), tapCyan.groupId);

  // Adjusting tolerance only affects active group (Coral/Yellow/White remain unmasked 0)
  const tolAdjusted = recomputeGroupTolerance3D(hist3D.present, prepared3D, tapCyan.groupId, 44);
  assert.equal(tolAdjusted.groups.length, 1);
  assert.equal(tolAdjusted.maskMap[22 * w + 74], 0, "Coral sphere remains unmasked on active group tolerance change");

  // Multi-Select ("Pilih Banyak" / Ctrl+Klik): collect candidates without mutating history
  let cands = [];
  let seq = 1;

  // Tap Yellow Block -> candidate #1
  let toggleRes = toggleCandidatePoint3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: cands,
    seedX: 22,
    seedY: 49,
    tolerance: 26,
    nextCandidateSeq: seq,
  });
  assert.equal(toggleRes.action, "added");
  cands = toggleRes.candidates;
  seq = toggleRes.nextCandidateSeq;

  // Tap White Base -> candidate #2
  toggleRes = toggleCandidatePoint3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: cands,
    seedX: 64,
    seedY: 49,
    tolerance: 26,
    nextCandidateSeq: seq,
  });
  assert.equal(toggleRes.action, "added");
  cands = toggleRes.candidates;
  seq = toggleRes.nextCandidateSeq;

  // Accidental tap on Coral Sphere -> candidate #3, then tap again to cancel it!
  toggleRes = toggleCandidatePoint3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: cands,
    seedX: 74,
    seedY: 22,
    tolerance: 26,
    nextCandidateSeq: seq,
  });
  assert.equal(toggleRes.action, "added");
  cands = toggleRes.candidates;
  seq = toggleRes.nextCandidateSeq;
  assert.equal(cands.length, 3);

  toggleRes = toggleCandidatePoint3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: cands,
    seedX: 74,
    seedY: 22,
    tolerance: 26,
    nextCandidateSeq: seq,
  });
  assert.equal(toggleRes.action, "removed", "Second tap on candidate toggles it back off cleanly");
  cands = toggleRes.candidates;
  assert.equal(cands.length, 2);

  // History past length must STILL be 1 (candidates are non-destructive)
  assert.equal(hist3D.past.length, 1, "Candidate toggles must not pollute Recolor3DHistory");

  // Confirm "Gabung Grup" -> commits Yellow + White into 1 single group in 1 Undo step
  const committed = commitCandidateSelection3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: cands,
  });
  assert.ok(committed.groupId);
  hist3D = commit3DChange(hist3D, committed.state);
  assert.equal(hist3D.present.groups.length, 2, "Committed merge adds 1 new unified group");
  const mergedMaskId = hist3D.present.groupToMaskId[committed.groupId];
  assert.equal(hist3D.present.maskMap[49 * w + 22], mergedMaskId, "Yellow block joined merged group");
  assert.equal(hist3D.present.maskMap[49 * w + 64], mergedMaskId, "White base joined merged group");
  assert.equal(hist3D.present.maskMap[22 * w + 74], 0, "Deselected Coral sphere was NOT committed");
  assert.equal(hist3D.past.length, 2);

  // 1-step Undo reverts merged candidate group cleanly
  hist3D = undo3D(hist3D);
  assert.equal(hist3D.present.groups.length, 1);
  assert.equal(hist3D.present.maskMap[49 * w + 22], 0);
  hist3D = redo3D(hist3D);
  assert.equal(hist3D.present.groups.length, 2);

  // Mix an existing committed group (Cyan Sphere) + unmasked Coral Sphere via Multi-Select -> merges into Cyan's group
  let mixCands = [];
  let mixSeq = 1;
  let m1 = toggleCandidatePoint3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: mixCands,
    seedX: 22,
    seedY: 22,
    tolerance: 26,
    nextCandidateSeq: mixSeq,
  });
  mixCands = m1.candidates;
  mixSeq = m1.nextCandidateSeq;
  assert.equal(mixCands[0].kind, "group");
  assert.equal(mixCands[0].existingGroupId, tapCyan.groupId);

  let m2 = toggleCandidatePoint3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: mixCands,
    seedX: 74,
    seedY: 22,
    tolerance: 26,
    nextCandidateSeq: mixSeq,
  });
  mixCands = m2.candidates;
  assert.equal(mixCands[1].kind, "flood");

  const mixCommitted = commitCandidateSelection3D({
    state: hist3D.present,
    prepared: prepared3D,
    candidates: mixCands,
  });
  assert.equal(mixCommitted.groupId, tapCyan.groupId);
  hist3D = commit3DChange(hist3D, mixCommitted.state);
  assert.equal(
    findGroupAtPixel3D(hist3D.present, 74, 22),
    tapCyan.groupId,
    "Coral sphere merged cleanly into existing Cyan group",
  );

  console.log(
    "Test 7 PASS: Clean v2.5 3D start (groups: []), active tolerance recomputation, Multi-Select candidate toggle/merge & atomic Undo/Redo verified.",
  );
}

// ---------------------------------------------------------------------------
// Test 8: Soft Alpha Matte (0-255), Auto Hole-Fill, Shadow Reach & Smart Brush
// ---------------------------------------------------------------------------
{
  // 8A) Micro Hole-Fill (1-2px closed, dark outline dot preserved) + Soft Edge Matte (1..254) + Proportional Render Blend
  {
    const w = 60;
    const h = 40;
    const img = new MockImageData(w, h);

    for (let y = 6; y <= 32; y++) {
      for (let x = 6; x <= 36; x++) {
        setPixel(img, x, y, 220, 48, 48, 255);
      }
      // 1px dark-red AA transition column next to black ink outline
      setPixel(img, 37, y, 108, 40, 44, 255);
      // Black ink outline column
      setPixel(img, 38, y, 20, 18, 22, 255);
      // White area across black outline
      for (let x = 39; x <= 54; x++) {
        setPixel(img, x, y, 245, 245, 245, 255);
      }
    }
    // 1x1 black ink dot inside the red area at (12, 12) -> MUST NOT be hole-filled!
    setPixel(img, 12, 12, 18, 18, 20, 255);

    const prep = prepare3DImageData(img);

    // Direct hole-fill + feather test with artificial 2x1 unmasked shadow pinhole + 1px dark ink dot
    const rawMask = new Uint8Array(w * h);
    for (let y = 8; y <= 30; y++) {
      for (let x = 8; x <= 36; x++) {
        rawMask[y * w + x] = 255;
      }
    }
    // Carve 2x1 enclosed hole at (18,18)-(19,18) & keep dark dot (12,12) = 0
    rawMask[18 * w + 18] = 0;
    rawMask[18 * w + 19] = 0;
    rawMask[12 * w + 12] = 0;

    const smoothed = smoothSelectionMask3D({
      mask: rawMask,
      prepared: prep,
      seedHue: prep.hue[14 * w + 22],
      seedIsChromatic: true,
      guardDarkOutlines: true,
    });

    assert.equal(smoothed[18 * w + 18], 255, "2x1 enclosed micro-hole pixel 1 must be auto-filled");
    assert.equal(smoothed[18 * w + 19], 255, "2x1 enclosed micro-hole pixel 2 must be auto-filled");
    assert.equal(smoothed[12 * w + 12], 0, "1px dark outline dot inside object must NEVER be hole-filled");
    assert.equal(smoothed[14 * w + 22], 255, "Deep interior remains full coverage 255");
    assert.ok(
      smoothed[14 * w + 36] > 0 && smoothed[14 * w + 36] < 255,
      `Outer perimeter pixel must have soft 1-254 coverage, got ${smoothed[14 * w + 36]}`,
    );
    assert.equal(smoothed[14 * w + 38], 0, "Black outline column remains strictly 0");
    assert.equal(smoothed[14 * w + 42], 0, "White area beyond black outline remains strictly 0");

    // Verify floodFillSelect3D attaches 0-255 Recolor3DGroup.mask & blends proportionally on export
    const sel = floodFillSelect3D({
      state: createEmpty3DState(w, h),
      prepared: prep,
      seedX: 22,
      seedY: 16,
      tolerance: 24,
    });
    assert.ok(sel.groupId);
    const grp = sel.state.groups[0];
    assert.ok(grp.mask instanceof Uint8Array && grp.mask.length === w * h);
    const rimCov = grp.mask[16 * w + 36];
    assert.ok(rimCov > 0 && rimCov < 255, `Expected soft outer rim alpha (1..254), got ${rimCov}`);

    const recoloredState = updateGroupColor3D(sel.state, grp.groupId, "#2563EB");
    const exported = render3DExportImageData(prep, recoloredState);
    const centerPx = getPixel(exported, 22, 16);
    const rimPx = getPixel(exported, 36, 16);
    const outlinePx = getPixel(exported, 38, 16);
    assert.ok(centerPx.b > centerPx.r, "Full 255 interior shifted completely to blue");
    assert.ok(rimPx.r > centerPx.r && rimPx.b > 48, "Partial matte rim blends proportionally between red and blue");
    assert.deepEqual(outlinePx, getPixel(img, 38, 16), "Black outline pixel stays 100% intact");
  }

  // 8B) Shadow Reach Separation (tolerance=16 strict + shadowReach 0 vs 85 pulls deep shadow without leaking to gray)
  {
    const w = 72;
    const h = 40;
    const img = new MockImageData(w, h);

    // Top Red Cloak Midtone (y=5..18) with steeper drop directly to Deep Crimson Shadow (y=19..34)
    for (let x = 6; x <= 36; x++) {
      for (let y = 5; y <= 18; y++) {
        setPixel(img, x, y, 218, 42, 42, 255); // lum ~ 0.33
      }
      for (let y = 19; y <= 34; y++) {
        setPixel(img, x, y, 88, 22, 22, 255); // lum ~ 0.145, deep colored shadow step (diff=130)
      }
    }
    // 2px black outline divider (x=37..38) + Neutral Gray Armor (x=39..66)
    for (let y = 5; y <= 34; y++) {
      setPixel(img, 37, y, 22, 22, 26, 255);
      setPixel(img, 38, y, 22, 22, 26, 255);
      for (let x = 39; x <= 66; x++) {
        setPixel(img, x, y, 138, 138, 142, 255);
      }
    }

    const prep = prepare3DImageData(img);

    // Tight tolerance 16 + shadowReach 0 -> captures midtone only, stops before steep crimson shadow
    const noShadow = floodFillSelect3D({
      state: createEmpty3DState(w, h),
      prepared: prep,
      seedX: 20,
      seedY: 10,
      tolerance: 16,
      shadowReach: 0,
    });
    assert.ok(noShadow.groupId);
    const midMaskId = noShadow.state.groupToMaskId[noShadow.groupId];
    assert.equal(noShadow.state.maskMap[10 * w + 20], midMaskId);
    assert.equal(noShadow.state.maskMap[28 * w + 20], 0, "Deep shadow fold excluded when shadowReach=0");

    // Raise ONLY shadowReach to 85 (keeping tolerance=16!) -> pulls in deep crimson shadow without leaking into gray armor
    const withShadow = recomputeGroupTolerance3D(
      noShadow.state,
      prep,
      noShadow.groupId,
      16,
      85,
    );
    const grp = withShadow.groups[0];
    assert.equal(grp.shadowReach, 85);
    assert.equal(withShadow.maskMap[28 * w + 20], midMaskId, "ShadowReach=85 captures deep colored shadow fold");
    assert.equal(withShadow.maskMap[20 * w + 37], 0, "Black outline remains strictly blocked");
    assert.equal(withShadow.maskMap[20 * w + 52], 0, "Neutral gray area across outline stays completely untouched");
  }

  // 8C) Smart Edge-Aware Brush ("smart"): single swipe fills 3 pockets separated by black outlines without coloring outlines
  {
    const w = 80;
    const h = 40;
    const img = new MockImageData(w, h);

    // Draw dark ink dividers at x=21..23, x=41..43, x=61..63
    for (let y = 4; y <= 35; y++) {
      for (let x = 4; x <= 20; x++) setPixel(img, x, y, 224, 62, 62, 255); // Pocket 1
      for (let x = 21; x <= 23; x++) setPixel(img, x, y, 22, 20, 24, 255); // Outline 1
      for (let x = 24; x <= 40; x++) setPixel(img, x, y, 212, 54, 58, 255); // Pocket 2
      for (let x = 41; x <= 43; x++) setPixel(img, x, y, 22, 20, 24, 255); // Outline 2
      for (let x = 44; x <= 60; x++) setPixel(img, x, y, 232, 74, 66, 255); // Pocket 3
      for (let x = 61; x <= 63; x++) setPixel(img, x, y, 22, 20, 24, 255); // Outline 3
      for (let x = 64; x <= 76; x++) setPixel(img, x, y, 245, 200, 45, 255); // Yellow control outside swipe
    }

    const prep = prepare3DImageData(img);
    const swipe = applyBrushStroke3D({
      state: createEmpty3DState(w, h),
      prepared: prep,
      groupId: null,
      mode: "brush",
      brushMode: "smart",
      points: [
        { x: 12, y: 20 },
        { x: 52, y: 20 },
      ],
      radius: 8,
      tolerance: 26,
      shadowReach: 45,
    });

    assert.ok(swipe.activeGroupId);
    const swipeMaskId = swipe.state.groupToMaskId[swipe.activeGroupId];

    // Check far vertical reaches (y=8, y=32 — far outside radius 8 center y=20!) in all 3 pockets filled automatically
    assert.equal(swipe.state.maskMap[8 * w + 12], swipeMaskId, "Pocket 1 filled vertically to border");
    assert.equal(swipe.state.maskMap[32 * w + 32], swipeMaskId, "Pocket 2 filled vertically across outline 1");
    assert.equal(swipe.state.maskMap[8 * w + 52], swipeMaskId, "Pocket 3 filled vertically across outline 2");

    // Check black outline dividers stayed untouched
    assert.equal(swipe.state.maskMap[20 * w + 22], 0, "Black outline 1 must NOT be painted by Smart Brush");
    assert.equal(swipe.state.maskMap[20 * w + 42], 0, "Black outline 2 must NOT be painted by Smart Brush");
    assert.equal(swipe.state.maskMap[20 * w + 70], 0, "Untouched yellow section must remain 0");
  }

  console.log(
    "Test 8 PASS: Soft Alpha Matte (0-255), Auto Hole-Fill, Shadow Reach (0-100) & Smart Edge-Aware Brush multi-fold swipe verified.",
  );
}
