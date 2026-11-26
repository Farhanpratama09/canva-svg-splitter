import { hslToRgb, rgbToHex } from "./color-quantizer";
import type { RegionInfo } from "./region-segmenter";

export const CANVA_FREE_MAX_COLORS = 5;
export const DEFAULT_MAX_HISTORY_STEPS = 30;

/** Curated soft/pastel & keyring-friendly color presets for instant Live Preview. */
export const PASTEL_COLOR_PRESETS = [
  "#FF6B6B",
  "#4ECDC4",
  "#FFD166",
  "#C8A2C8",
  "#60A5FA",
  "#F472B6",
  "#34D399",
  "#FB923C",
  "#A78BFA",
  "#FDE047",
  "#1E1E24",
  "#FFFFFF",
] as const;

export const INLINE_PALETTE_CATEGORIES = [
  {
    id: "pastel",
    label: "Pastel",
    colors: [
      "#FFD6E0",
      "#FFCAD4",
      "#FDE2E4",
      "#FFF1C9",
      "#D8F3DC",
      "#BDE0FE",
      "#C8A2C8",
      "#E2D4F0",
    ],
  },
  {
    id: "pop",
    label: "Cerah / Pop",
    colors: [
      "#FF3B5C",
      "#FF6B6B",
      "#FF9F1C",
      "#FFD166",
      "#06D6A0",
      "#14B8A6",
      "#3B82F6",
      "#8B5CF6",
    ],
  },
  {
    id: "neutral",
    label: "Netral",
    colors: [
      "#FFFFFF",
      "#F1F5F9",
      "#CBD5E1",
      "#94A3B8",
      "#64748B",
      "#334155",
      "#1E1E24",
      "#000000",
    ],
  },
] as const;

const DEFAULT_GROUP_NAME_REGEX = /^Grup \d+$/;

export interface ColorGroup {
  groupId: string;
  name: string;
  colorHex: string;
  r: number;
  g: number;
  b: number;
  regionIds: number[];
  totalPixels: number;
}

export interface RegionGroupingState {
  groups: ColorGroup[];
  regionToGroup: Record<number, string>;
  sourceRegions: RegionInfo[];
  nextGroupSeq: number;
}

export interface GroupingHistory {
  past: RegionGroupingState[];
  present: RegionGroupingState;
  future: RegionGroupingState[];
  maxSteps: number;
  lastCoalesceKey?: string;
  lastCoalesceAt?: number;
}

/**
 * Normalizes a CSS hex string (#RGB or #RRGGBB) to uppercase 6-digit #RRGGBB.
 * Returns null if invalid.
 */
export function normalizeHexColor(input: string): string | null {
  const trimmed = input.trim();
  const sixMatch = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (sixMatch) {
    return `#${sixMatch[1].toUpperCase()}`;
  }

  const threeMatch = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (threeMatch) {
    const [r, g, b] = threeMatch[1].toUpperCase().split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  return null;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hex) ?? "#000000";
  const value = parseInt(normalized.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

/**
 * Converts sRGB [0..255] to HSL: hue in [0, 360), saturation & lightness in [0, 1].
 */
export function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta <= 1e-6) {
    return { h: 0, s: 0, l };
  }

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;

  if (max === rn) {
    h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  } else if (max === gn) {
    h = ((bn - rn) / delta + 2) * 60;
  } else {
    h = ((rn - gn) / delta + 4) * 60;
  }

  return { h: (h + 360) % 360, s, l };
}

function pickDistinctColorHex(
  usedHexes: Set<string>,
  seq: number,
): string {
  for (const candidate of PASTEL_COLOR_PRESETS) {
    if (!usedHexes.has(candidate)) {
      return candidate;
    }
  }

  // Deterministic fallback golden-angle pastel if all presets are used
  const hue = (seq * 137.508) % 360;
  const [r, g, b] = hslToRgb(hue, 0.68, 0.65);
  return rgbToHex(r, g, b);
}

function buildRegionPixelLookup(
  sourceRegions: RegionInfo[],
): Map<number, RegionInfo> {
  const map = new Map<number, RegionInfo>();
  for (const reg of sourceRegions) {
    map.set(reg.regionId, reg);
  }
  return map;
}

function computeTotalPixels(
  regionIds: number[],
  regionLookup: Map<number, RegionInfo>,
): number {
  let sum = 0;
  for (const id of regionIds) {
    sum += regionLookup.get(id)?.pixelCount ?? 0;
  }
  return sum;
}

/**
 * Initializes immutable color groups from Stage 3 regions grouped by originalHex.
 */
export function createInitialGrouping(
  regions: RegionInfo[],
): RegionGroupingState {
  const byHex = new Map<string, RegionInfo[]>();

  for (const reg of regions) {
    const hex = normalizeHexColor(reg.originalHex) ?? "#000000";
    const bucket = byHex.get(hex);
    if (bucket) {
      bucket.push(reg);
    } else {
      byHex.set(hex, [reg]);
    }
  }

  // Sort initial groups by total pixel area descending
  const entries = Array.from(byHex.entries())
    .map(([hex, list]) => ({
      hex,
      regions: list,
      totalPixels: list.reduce((acc, item) => acc + item.pixelCount, 0),
    }))
    .sort((a, b) => b.totalPixels - a.totalPixels);

  const groups: ColorGroup[] = [];
  const regionToGroup: Record<number, string> = {};
  let seq = 1;

  for (const entry of entries) {
    const groupId = `group-${seq}`;
    const rgb = hexToRgb(entry.hex);
    const regionIds = entry.regions.map((r) => r.regionId);

    groups.push({
      groupId,
      name: `Grup ${seq}`,
      colorHex: entry.hex,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      regionIds,
      totalPixels: entry.totalPixels,
    });

    for (const regionId of regionIds) {
      regionToGroup[regionId] = groupId;
    }
    seq++;
  }

  return {
    groups,
    regionToGroup,
    sourceRegions: regions,
    nextGroupSeq: seq,
  };
}

/**
 * Splits a single region out of its current group into a brand-new ColorGroup.
 * Leaves all sibling regions in the old group intact.
 */
export function splitRegionToNewGroup(
  state: RegionGroupingState,
  regionId: number,
  customHex?: string,
): RegionGroupingState {
  const currentGroupId = state.regionToGroup[regionId];
  if (!currentGroupId) {
    return state;
  }

  const currentGroup = state.groups.find((g) => g.groupId === currentGroupId);
  if (!currentGroup) {
    return state;
  }

  // Already isolated in its own 1-region group
  if (currentGroup.regionIds.length <= 1) {
    if (!customHex) {
      return state;
    }
    const normalizedCustom = normalizeHexColor(customHex);
    if (!normalizedCustom || normalizedCustom === currentGroup.colorHex) {
      return state;
    }
    return updateGroupColor(state, currentGroup.groupId, normalizedCustom);
  }

  const regionLookup = buildRegionPixelLookup(state.sourceRegions);
  const usedHexes = new Set(state.groups.map((g) => g.colorHex));

  const normalizedCustom = customHex ? normalizeHexColor(customHex) : null;
  const newColorHex =
    normalizedCustom ?? pickDistinctColorHex(usedHexes, state.nextGroupSeq);
  const rgb = hexToRgb(newColorHex);

  const newGroupSeq = state.nextGroupSeq;
  const newGroupId = `group-${newGroupSeq}`;

  const updatedOldRegionIds = currentGroup.regionIds.filter(
    (id) => id !== regionId,
  );
  const movedPixels = regionLookup.get(regionId)?.pixelCount ?? 0;

  const newGroup: ColorGroup = {
    groupId: newGroupId,
    name: `Grup ${newGroupSeq}`,
    colorHex: newColorHex,
    r: rgb.r,
    g: rgb.g,
    b: rgb.b,
    regionIds: [regionId],
    totalPixels: movedPixels,
  };

  const nextGroups: ColorGroup[] = [];
  for (const group of state.groups) {
    if (group.groupId === currentGroupId) {
      nextGroups.push({
        ...group,
        regionIds: updatedOldRegionIds,
        totalPixels: computeTotalPixels(updatedOldRegionIds, regionLookup),
      });
      nextGroups.push(newGroup);
    } else {
      nextGroups.push(group);
    }
  }

  return {
    ...state,
    groups: nextGroups,
    regionToGroup: {
      ...state.regionToGroup,
      [regionId]: newGroupId,
    },
    nextGroupSeq: newGroupSeq + 1,
  };
}

/**
 * Reassigns a region to an existing target group and prunes the old group if empty.
 */
export function assignRegionToGroup(
  state: RegionGroupingState,
  regionId: number,
  targetGroupId: string,
): RegionGroupingState {
  const sourceGroupId = state.regionToGroup[regionId];
  if (!sourceGroupId || sourceGroupId === targetGroupId) {
    return state;
  }

  const targetExists = state.groups.some((g) => g.groupId === targetGroupId);
  if (!targetExists) {
    return state;
  }

  const regionLookup = buildRegionPixelLookup(state.sourceRegions);
  const nextGroups: ColorGroup[] = [];

  for (const group of state.groups) {
    if (group.groupId === sourceGroupId) {
      const remaining = group.regionIds.filter((id) => id !== regionId);
      if (remaining.length > 0) {
        nextGroups.push({
          ...group,
          regionIds: remaining,
          totalPixels: computeTotalPixels(remaining, regionLookup),
        });
      }
    } else if (group.groupId === targetGroupId) {
      const merged = group.regionIds.includes(regionId)
        ? group.regionIds
        : [...group.regionIds, regionId];
      nextGroups.push({
        ...group,
        regionIds: merged,
        totalPixels: computeTotalPixels(merged, regionLookup),
      });
    } else {
      nextGroups.push(group);
    }
  }

  return {
    ...state,
    groups: nextGroups,
    regionToGroup: {
      ...state.regionToGroup,
      [regionId]: targetGroupId,
    },
  };
}

/**
 * Removes a region from activeGroupId by splitting it out into a new group
 * with its original color (so Mode 2D regions remain valid and Undo/Redo works cleanly).
 * Returns state unchanged if the region does not belong to activeGroupId or is its sole member.
 */
export function removeRegionFromGroup(
  state: RegionGroupingState,
  regionId: number,
  activeGroupId: string,
): RegionGroupingState {
  const currentGroupId = state.regionToGroup[regionId];
  if (!currentGroupId || currentGroupId !== activeGroupId) {
    return state;
  }

  const activeGroup = state.groups.find((g) => g.groupId === activeGroupId);
  if (!activeGroup || activeGroup.regionIds.length <= 1) {
    return state;
  }

  const region = state.sourceRegions.find((r) => r.regionId === regionId);
  return splitRegionToNewGroup(state, regionId, region?.originalHex);
}

/**
 * Batch-merges all regions in selectedRegionIds into a single ColorGroup
 * (adopting targetGroupId if specified, otherwise the group of the first selected region).
 * Performs an atomic state update so the entire confirmation creates 1 Undo/Redo step.
 */
export function mergeSelectedRegions(
  state: RegionGroupingState,
  regionIds: number[],
  targetGroupId?: string,
): RegionGroupingState {
  const uniqueIds = Array.from(
    new Set(regionIds.filter((id) => Boolean(state.regionToGroup[id]))),
  );
  if (uniqueIds.length === 0) {
    return state;
  }

  const resolvedTargetGroupId =
    targetGroupId && state.groups.some((g) => g.groupId === targetGroupId)
      ? targetGroupId
      : state.regionToGroup[uniqueIds[0]];
  if (!resolvedTargetGroupId) {
    return state;
  }

  const selectedSet = new Set(uniqueIds);
  const alreadyAllInTarget = uniqueIds.every(
    (id) => state.regionToGroup[id] === resolvedTargetGroupId,
  );
  if (alreadyAllInTarget) {
    return state;
  }

  const regionLookup = buildRegionPixelLookup(state.sourceRegions);
  const nextRegionToGroup: Record<number, string> = { ...state.regionToGroup };
  for (const id of uniqueIds) {
    nextRegionToGroup[id] = resolvedTargetGroupId;
  }

  const targetGroupObj = state.groups.find(
    (g) => g.groupId === resolvedTargetGroupId,
  );
  if (!targetGroupObj) return state;

  // Preserve custom name if target still had default name & an absorbed emptied group had custom name
  let resolvedTargetName = targetGroupObj.name;
  if (DEFAULT_GROUP_NAME_REGEX.test(resolvedTargetName)) {
    for (const grp of state.groups) {
      if (grp.groupId === resolvedTargetGroupId) continue;
      const remains = grp.regionIds.some((id) => !selectedSet.has(id));
      if (!remains && !DEFAULT_GROUP_NAME_REGEX.test(grp.name)) {
        resolvedTargetName = grp.name;
        break;
      }
    }
  }

  const nextGroups: ColorGroup[] = [];
  for (const group of state.groups) {
    if (group.groupId === resolvedTargetGroupId) {
      const combinedIds = Array.from(new Set([...group.regionIds, ...uniqueIds]));
      nextGroups.push({
        ...group,
        name: resolvedTargetName,
        regionIds: combinedIds,
        totalPixels: computeTotalPixels(combinedIds, regionLookup),
      });
    } else {
      const remaining = group.regionIds.filter((id) => !selectedSet.has(id));
      if (remaining.length > 0) {
        nextGroups.push({
          ...group,
          regionIds: remaining,
          totalPixels: computeTotalPixels(remaining, regionLookup),
        });
      }
    }
  }

  return {
    ...state,
    groups: nextGroups,
    regionToGroup: nextRegionToGroup,
  };
}

/**
 * Batch-splits all regions in selectedRegionIds out of their existing groups
 * into a single brand-new ColorGroup in 1 atomic Undo/Redo step.
 */
export function splitSelectedRegionsToNewGroup(
  state: RegionGroupingState,
  regionIds: number[],
  customHex?: string,
): RegionGroupingState {
  const uniqueIds = Array.from(
    new Set(regionIds.filter((id) => Boolean(state.regionToGroup[id]))),
  );
  if (uniqueIds.length === 0) {
    return state;
  }

  // If the selection already constitutes the exact entirety of a single group, no split needed
  const firstGroupId = state.regionToGroup[uniqueIds[0]];
  const firstGroup = state.groups.find((g) => g.groupId === firstGroupId);
  if (
    firstGroup &&
    firstGroup.regionIds.length === uniqueIds.length &&
    uniqueIds.every((id) => state.regionToGroup[id] === firstGroupId)
  ) {
    if (!customHex) return state;
    const normalized = normalizeHexColor(customHex);
    if (!normalized || normalized === firstGroup.colorHex) return state;
    return updateGroupColor(state, firstGroup.groupId, normalized);
  }

  const regionLookup = buildRegionPixelLookup(state.sourceRegions);
  const usedHexes = new Set(state.groups.map((g) => g.colorHex));
  const normalizedCustom = customHex ? normalizeHexColor(customHex) : null;
  const newColorHex =
    normalizedCustom ?? pickDistinctColorHex(usedHexes, state.nextGroupSeq);
  const rgb = hexToRgb(newColorHex);

  const newGroupSeq = state.nextGroupSeq;
  const newGroupId = `group-${newGroupSeq}`;
  const selectedSet = new Set(uniqueIds);

  const newGroup: ColorGroup = {
    groupId: newGroupId,
    name: `Grup ${newGroupSeq}`,
    colorHex: newColorHex,
    r: rgb.r,
    g: rgb.g,
    b: rgb.b,
    regionIds: uniqueIds,
    totalPixels: computeTotalPixels(uniqueIds, regionLookup),
  };

  const nextGroups: ColorGroup[] = [];
  let inserted = false;

  for (const group of state.groups) {
    const remaining = group.regionIds.filter((id) => !selectedSet.has(id));
    if (remaining.length > 0) {
      nextGroups.push({
        ...group,
        regionIds: remaining,
        totalPixels: computeTotalPixels(remaining, regionLookup),
      });
    }
    if (group.groupId === firstGroupId && !inserted) {
      nextGroups.push(newGroup);
      inserted = true;
    }
  }
  if (!inserted) {
    nextGroups.push(newGroup);
  }

  const nextRegionToGroup: Record<number, string> = { ...state.regionToGroup };
  for (const id of uniqueIds) {
    nextRegionToGroup[id] = newGroupId;
  }

  return {
    ...state,
    groups: nextGroups,
    regionToGroup: nextRegionToGroup,
    nextGroupSeq: newGroupSeq + 1,
  };
}

/**
 * Updates the solid hex fill color of a specific ColorGroup for Live Preview.
 */
export function updateGroupColor(
  state: RegionGroupingState,
  groupId: string,
  newHex: string,
): RegionGroupingState {
  const normalized = normalizeHexColor(newHex);
  if (!normalized) {
    return state;
  }

  const targetGroup = state.groups.find((g) => g.groupId === groupId);
  if (!targetGroup || targetGroup.colorHex === normalized) {
    return state;
  }

  const rgb = hexToRgb(normalized);
  const nextGroups = state.groups.map((group) =>
    group.groupId === groupId
      ? {
          ...group,
          colorHex: normalized,
          r: rgb.r,
          g: rgb.g,
          b: rgb.b,
        }
      : group,
  );

  return {
    ...state,
    groups: nextGroups,
  };
}

/**
 * Renames a specific ColorGroup cleanly (immutable, integrates with Undo/Redo).
 * Ignores empty names or no-op renames by returning the existing state reference.
 */
export function renameGroup(
  state: RegionGroupingState,
  groupId: string,
  newName: string,
): RegionGroupingState {
  const cleanName = newName.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!cleanName) {
    return state;
  }

  const targetGroup = state.groups.find((g) => g.groupId === groupId);
  if (!targetGroup || targetGroup.name === cleanName) {
    return state;
  }

  return {
    ...state,
    groups: state.groups.map((group) =>
      group.groupId === groupId ? { ...group, name: cleanName } : group,
    ),
  };
}

/**
 * Merges all regions from sourceGroupId into targetGroupId and removes sourceGroupId.
 * Preserves targetGroup's custom name (or inherits sourceGroup's custom name if target
 * still uses an auto-generated default name).
 */
export function mergeGroups(
  state: RegionGroupingState,
  sourceGroupId: string,
  targetGroupId: string,
): RegionGroupingState {
  if (sourceGroupId === targetGroupId) {
    return state;
  }

  const sourceGroup = state.groups.find((g) => g.groupId === sourceGroupId);
  const targetGroup = state.groups.find((g) => g.groupId === targetGroupId);
  if (!sourceGroup || !targetGroup) {
    return state;
  }

  const regionLookup = buildRegionPixelLookup(state.sourceRegions);
  const nextRegionToGroup: Record<number, string> = { ...state.regionToGroup };

  for (const id of sourceGroup.regionIds) {
    nextRegionToGroup[id] = targetGroupId;
  }

  const combinedIds = Array.from(
    new Set([...targetGroup.regionIds, ...sourceGroup.regionIds]),
  );

  const preserveSourceCustomName =
    DEFAULT_GROUP_NAME_REGEX.test(targetGroup.name) &&
    !DEFAULT_GROUP_NAME_REGEX.test(sourceGroup.name);
  const resolvedName = preserveSourceCustomName
    ? sourceGroup.name
    : targetGroup.name;

  const nextGroups: ColorGroup[] = [];
  for (const group of state.groups) {
    if (group.groupId === sourceGroupId) continue;
    if (group.groupId === targetGroupId) {
      nextGroups.push({
        ...group,
        name: resolvedName,
        regionIds: combinedIds,
        totalPixels: computeTotalPixels(combinedIds, regionLookup),
      });
    } else {
      nextGroups.push(group);
    }
  }

  return {
    ...state,
    groups: nextGroups,
    regionToGroup: nextRegionToGroup,
  };
}

/**
 * Resets grouping back to initial Stage 3 color groups.
 */
export function resetGrouping(
  stateOrRegions: RegionGroupingState | RegionInfo[],
): RegionGroupingState {
  const regions = Array.isArray(stateOrRegions)
    ? stateOrRegions
    : stateOrRegions.sourceRegions;
  return createInitialGrouping(regions);
}

/**
 * Progressively merges the closest color-group pairs (Euclidean RGB distance,
 * prioritizing smaller-pixel groups into larger dominant color groups) until
 * the total active groups fit within Canva Free's <= 5 color limit.
 */
export function autoCompactToFiveColors(
  state: RegionGroupingState,
  maxColors: number = CANVA_FREE_MAX_COLORS,
): RegionGroupingState {
  if (state.groups.length <= maxColors || maxColors < 1) {
    return state;
  }

  let current = state;
  while (current.groups.length > maxColors) {
    const groups = current.groups;
    let bestSourceId = "";
    let bestTargetId = "";
    let bestScore = Infinity;

    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const dr = a.r - b.r;
        const dg = a.g - b.g;
        const db = a.b - b.b;
        const colorDistSq = dr * dr + dg * dg + db * db;

        // Prioritize merging tiny accent/shade clusters into closest larger dominant groups
        const smaller = a.totalPixels <= b.totalPixels ? a : b;
        const larger = a.totalPixels <= b.totalPixels ? b : a;
        const sizeBias = 1 + Math.log10(1 + smaller.totalPixels) * 0.12;
        const score = colorDistSq * sizeBias;

        if (score < bestScore) {
          bestScore = score;
          bestSourceId = smaller.groupId;
          bestTargetId = larger.groupId;
        }
      }
    }

    if (!bestSourceId || !bestTargetId) break;
    const next = mergeGroups(current, bestSourceId, bestTargetId);
    if (next === current) break;
    current = next;
  }

  return current;
}

/**
 * Applies a reference palette (ordered hex list from another batch design)
 * onto the target state's groups ordered by descending pixel area.
 */
export function applyPaletteToGrouping(
  state: RegionGroupingState,
  paletteHexes: string[],
): RegionGroupingState {
  if (paletteHexes.length === 0 || state.groups.length === 0) {
    return state;
  }

  const normalizedPalette = paletteHexes
    .map((h) => normalizeHexColor(h))
    .filter((h): h is string => h !== null);

  if (normalizedPalette.length === 0) {
    return state;
  }

  // Sort group indices by pixel prominence so major structural layers match cleanly
  const rankedGroupIds = [...state.groups]
    .sort((a, b) => b.totalPixels - a.totalPixels)
    .map((g) => g.groupId);

  let next = state;
  for (let i = 0; i < rankedGroupIds.length; i++) {
    const targetHex = normalizedPalette[i % normalizedPalette.length];
    next = updateGroupColor(next, rankedGroupIds[i], targetHex);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Immutable Undo / Redo History Engine (>= 20 steps, default 30)
// ---------------------------------------------------------------------------

export function createGroupingHistory(
  initial: RegionGroupingState,
  maxSteps: number = DEFAULT_MAX_HISTORY_STEPS,
): GroupingHistory {
  return {
    past: [],
    present: initial,
    future: [],
    maxSteps: Math.max(20, maxSteps),
  };
}

export function commitGroupingChange(
  history: GroupingHistory,
  nextPresent: RegionGroupingState,
  coalesceKey?: string,
): GroupingHistory {
  if (nextPresent === history.present) {
    return history;
  }

  const now = Date.now();
  const canCoalesce =
    Boolean(coalesceKey) &&
    history.lastCoalesceKey === coalesceKey &&
    typeof history.lastCoalesceAt === "number" &&
    now - history.lastCoalesceAt < 600 &&
    history.past.length > 0;

  if (canCoalesce) {
    return {
      ...history,
      present: nextPresent,
      future: [],
      lastCoalesceKey: coalesceKey,
      lastCoalesceAt: now,
    };
  }

  const nextPast = [...history.past, history.present];
  const trimmedPast =
    nextPast.length > history.maxSteps
      ? nextPast.slice(nextPast.length - history.maxSteps)
      : nextPast;

  return {
    ...history,
    past: trimmedPast,
    present: nextPresent,
    future: [],
    lastCoalesceKey: coalesceKey,
    lastCoalesceAt: coalesceKey ? now : undefined,
  };
}

export function undoGrouping(history: GroupingHistory): GroupingHistory {
  if (history.past.length === 0) {
    return history;
  }

  const previous = history.past[history.past.length - 1];
  const nextPast = history.past.slice(0, -1);

  return {
    ...history,
    past: nextPast,
    present: previous,
    future: [history.present, ...history.future],
    lastCoalesceKey: undefined,
    lastCoalesceAt: undefined,
  };
}

export function redoGrouping(history: GroupingHistory): GroupingHistory {
  if (history.future.length === 0) {
    return history;
  }

  const next = history.future[0];
  const nextFuture = history.future.slice(1);

  return {
    ...history,
    past: [...history.past, history.present],
    present: next,
    future: nextFuture,
    lastCoalesceKey: undefined,
    lastCoalesceAt: undefined,
  };
}

// ---------------------------------------------------------------------------
// Live Preview & Visual Selection Highlight Renderer
// ---------------------------------------------------------------------------

export type CanvasPreviewMode = "live" | "solid" | "region-map";

/**
 * Renders the fast O(W*H) ImageData preview for Live Preview, Original Solid,
 * or Region Map, with crisp contrast dimming & boundary highlights on the
 * currently selected region and its active group siblings.
 */
export function renderGroupedCanvasImageData(params: {
  regionMap: Int32Array;
  width: number;
  height: number;
  regions: RegionInfo[];
  groupingState: RegionGroupingState;
  mode: CanvasPreviewMode;
  selectedRegionId?: number | null;
  selectedRegionIds?: number[];
  selectedGroupId: string | null;
}): ImageData {
  const {
    regionMap,
    width,
    height,
    regions,
    groupingState,
    mode,
    selectedRegionId = null,
    selectedRegionIds,
    selectedGroupId,
  } = params;

  const totalPixels = width * height;
  const out = new Uint8ClampedArray(totalPixels * 4);
  const regionCount = regions.length;

  if (width <= 0 || height <= 0 || totalPixels === 0 || regionCount === 0) {
    return new ImageData(out, Math.max(1, width), Math.max(1, height));
  }

  const groupMap = new Map<string, ColorGroup>();
  for (const group of groupingState.groups) {
    groupMap.set(group.groupId, group);
  }

  const activeRegionIds =
    selectedRegionIds && selectedRegionIds.length > 0
      ? selectedRegionIds
      : selectedRegionId !== null
        ? [selectedRegionId]
        : [];
  const selectedRegionSet = new Set(activeRegionIds);
  const hasExplicitRegions = selectedRegionSet.size > 0;

  const effectiveGroupId =
    selectedGroupId ??
    (activeRegionIds.length === 1
      ? groupingState.regionToGroup[activeRegionIds[0]] ?? null
      : null);

  const hasSelection = hasExplicitRegions || effectiveGroupId !== null;

  const lutR = new Uint8Array(regionCount + 1);
  const lutG = new Uint8Array(regionCount + 1);
  const lutB = new Uint8Array(regionCount + 1);
  // 0 = dimmed non-selected, 1 = group member, 2 = active selected region
  const tier = new Uint8Array(regionCount + 1);

  for (const reg of regions) {
    const id = reg.regionId;
    if (id <= 0 || id > regionCount) continue;

    if (mode === "live") {
      const gid = groupingState.regionToGroup[id];
      const grp = gid ? groupMap.get(gid) : undefined;
      if (grp) {
        lutR[id] = grp.r;
        lutG[id] = grp.g;
        lutB[id] = grp.b;
      } else {
        lutR[id] = reg.r;
        lutG[id] = reg.g;
        lutB[id] = reg.b;
      }
    } else if (mode === "solid") {
      lutR[id] = reg.r;
      lutG[id] = reg.g;
      lutB[id] = reg.b;
    } else {
      const hue = (id * 137.508) % 360;
      const lightness = id % 2 === 0 ? 0.56 : 0.64;
      const [r, g, b] = hslToRgb(hue, 0.78, lightness);
      lutR[id] = r;
      lutG[id] = g;
      lutB[id] = b;
    }

    if (!hasSelection) {
      tier[id] = 1;
    } else if (hasExplicitRegions) {
      tier[id] = selectedRegionSet.has(id) ? 2 : 0;
    } else if (
      effectiveGroupId !== null &&
      groupingState.regionToGroup[id] === effectiveGroupId
    ) {
      tier[id] = 2;
    } else {
      tier[id] = 0;
    }
  }

  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x;
      const id = regionMap[idx];
      if (id <= 0 || id > regionCount) continue;

      const off = idx * 4;
      const regTier = tier[id];

      if (hasSelection && regTier === 2) {
        const isPrimaryEdge =
          x === 0 ||
          y === 0 ||
          x + 1 === width ||
          y + 1 === height ||
          tier[regionMap[idx - 1]] !== 2 ||
          tier[regionMap[idx + 1]] !== 2 ||
          tier[regionMap[idx - width]] !== 2 ||
          tier[regionMap[idx + width]] !== 2;

        if (isPrimaryEdge) {
          // Crisp cyan-teal selection border (#14F1D9) visible on both white & black
          out[off] = 20;
          out[off + 1] = 241;
          out[off + 2] = 217;
          out[off + 3] = 255;
          continue;
        }
      }

      if (mode === "region-map" && regTier !== 2) {
        const isBoundary =
          x === 0 ||
          y === 0 ||
          x + 1 === width ||
          y + 1 === height ||
          regionMap[idx - 1] !== id ||
          regionMap[idx + 1] !== id ||
          regionMap[idx - width] !== id ||
          regionMap[idx + width] !== id;

        if (isBoundary) {
          const factor = hasSelection && regTier === 0 ? 0.14 : 0.28;
          out[off] = Math.round(lutR[id] * factor);
          out[off + 1] = Math.round(lutG[id] * factor);
          out[off + 2] = Math.round(lutB[id] * factor);
          out[off + 3] = 255;
          continue;
        }
      }

      if (hasSelection && regTier === 0) {
        // Contrast dimming for inactive groups so selected group members stand out cleanly
        out[off] = Math.round(lutR[id] * 0.34 + 8);
        out[off + 1] = Math.round(lutG[id] * 0.34 + 10);
        out[off + 2] = Math.round(lutB[id] * 0.34 + 14);
        out[off + 3] = 255;
      } else {
        out[off] = lutR[id];
        out[off + 1] = lutG[id];
        out[off + 2] = lutB[id];
        out[off + 3] = 255;
      }
    }
  }

  return new ImageData(out, width, height);
}
