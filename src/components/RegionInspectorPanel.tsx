"use client";

import { useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Brush,
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Eraser,
  GitMerge,
  Minimize2,
  MousePointer,
  Pencil,
  Pipette,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { hslToRgb, rgbToHex } from "@/lib/image-processor/color-quantizer";
import {
  CANVA_FREE_MAX_COLORS,
  INLINE_PALETTE_CATEGORIES,
  hexToRgb,
  normalizeHexColor,
  rgbToHsl,
  type ColorGroup,
} from "@/lib/image-processor/region-grouper";
import type { RegionInfo } from "@/lib/image-processor/region-segmenter";
import {
  BRUSH_RADIUS_PRESETS,
  DEFAULT_3D_SHADOW_REACH,
  MAX_3D_SHADOW_REACH,
  MAX_3D_TOLERANCE,
  MIN_3D_SHADOW_REACH,
  MIN_3D_TOLERANCE,
  type BrushMode3D,
  type Recolor3DTool,
} from "@/lib/image-processor/recolor-3d-engine";

export interface InspectorGroupView {
  groupId: string;
  name: string;
  colorHex: string;
  countLabel: string;
  isNeutral?: boolean;
}

interface CanvaGuardBadgeProps {
  groupCount: number;
  compact?: boolean;
  onAutoCompact?: () => void;
}

export function CanvaGuardBadge({
  groupCount,
  compact = false,
  onAutoCompact,
}: CanvaGuardBadgeProps) {
  const isWithinLimit = groupCount <= CANVA_FREE_MAX_COLORS;
  const splitFileCount = Math.max(
    1,
    Math.ceil(groupCount / CANVA_FREE_MAX_COLORS),
  );

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${
            isWithinLimit
              ? "border-emerald-400/35 bg-emerald-500/15 text-emerald-300"
              : "border-amber-400/40 bg-amber-500/15 text-amber-200"
          }`}
        >
          {isWithinLimit ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>
            {groupCount} / {CANVA_FREE_MAX_COLORS} Warna Canva
          </span>
        </div>

        {!isWithinLimit && onAutoCompact && (
          <button
            type="button"
            onClick={onAutoCompact}
            className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-xl border border-amber-400/45 bg-amber-400/20 px-2.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-400/30"
          >
            <Minimize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Ringkas ≤ 5 Warna</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      className={`rounded-xl border px-3 py-2.5 text-xs ${
        isWithinLimit
          ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
          : "border-amber-400/35 bg-amber-500/10 text-amber-100"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold">
          {isWithinLimit ? (
            <CheckCircle2
              className="h-4 w-4 shrink-0 text-emerald-300"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="h-4 w-4 shrink-0 text-amber-300"
              aria-hidden="true"
            />
          )}
          <span className="tabular-nums">
            {groupCount} / {CANVA_FREE_MAX_COLORS} Warna Canva
          </span>
        </div>

        <span
          className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
            isWithinLimit
              ? "bg-emerald-400/20 text-emerald-200"
              : "bg-amber-400/20 text-amber-200"
          }`}
        >
          {isWithinLimit ? "1 File SVG" : `${splitFileCount} File SVG`}
        </span>
      </div>

      <p className="mt-1 leading-relaxed text-slate-300">
        {isWithinLimit
          ? "Langsung mendukung color picker Canva Free dalam 1 file SVG."
          : `Melebihi 5 warna Canva Free — ringkas otomatis ke ≤ 5 warna atau ekspor terpecah menjadi ${splitFileCount} file SVG berlapis.`}
      </p>

      {!isWithinLimit && onAutoCompact && (
        <button
          type="button"
          onClick={onAutoCompact}
          className="mt-2.5 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-amber-300 px-3 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-200 active:bg-amber-400"
        >
          <Minimize2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Ringkas ke ≤ 5 Warna (1 File SVG)</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline HSL Color Picker (Replaces native mobile <input type="color"> popup)
// ---------------------------------------------------------------------------

interface InlineColorPickerProps {
  groupId: string;
  groupName: string;
  colorHex: string;
  onChangeColor: (newHex: string, coalesce?: boolean) => void;
  isEyedropperActive?: boolean;
  onToggleEyedropper?: () => void;
  onClose?: () => void;
}

type PaletteCategoryId = (typeof INLINE_PALETTE_CATEGORIES)[number]["id"];

export function InlineColorPicker({
  groupId,
  groupName,
  colorHex,
  onChangeColor,
  isEyedropperActive = false,
  onToggleEyedropper,
  onClose,
}: InlineColorPickerProps) {
  const [hslMemory, setHslMemory] = useState<{
    syncedHex: string;
    h: number;
    s: number;
    l: number;
  }>(() => {
    const rgb = hexToRgb(colorHex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return {
      syncedHex: colorHex,
      h: Math.round(hsl.h),
      s: Math.round(hsl.s * 100),
      l: Math.round(hsl.l * 100),
    };
  });

  const [hexDraft, setHexDraft] = useState<{
    baseHex: string;
    text: string;
  } | null>(null);
  const [paletteCategory, setPaletteCategory] =
    useState<PaletteCategoryId>("pastel");
  const [clipboardFeedback, setClipboardFeedback] = useState<string | null>(
    null,
  );

  // Derive active HSL without useEffect so external changes (Undo/Redo/Pipet/Presets) stay synced
  const effectiveHsl = (() => {
    if (hslMemory.syncedHex === colorHex) {
      return { h: hslMemory.h, s: hslMemory.s, l: hslMemory.l };
    }
    const rgb = hexToRgb(colorHex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return {
      h: hsl.s <= 0.01 ? hslMemory.h : Math.round(hsl.h),
      s: Math.round(hsl.s * 100),
      l: Math.round(hsl.l * 100),
    };
  })();

  const displayedHexText =
    hexDraft && hexDraft.baseHex === colorHex ? hexDraft.text : colorHex;

  const commitHsl = (nextH: number, nextS: number, nextL: number) => {
    const [r, g, b] = hslToRgb(nextH, nextS / 100, nextL / 100);
    const nextHex = rgbToHex(r, g, b);
    setHslMemory({
      syncedHex: nextHex,
      h: nextH,
      s: nextS,
      l: nextL,
    });
    setHexDraft(null);
    onChangeColor(nextHex, true);
  };

  const handleHexInputChange = (raw: string) => {
    const cleaned = raw.toUpperCase().slice(0, 7);
    setHexDraft({ baseHex: colorHex, text: cleaned });

    const candidate = cleaned.startsWith("#") ? cleaned : `#${cleaned}`;
    if (/^#[0-9A-F]{6}$/.test(candidate)) {
      const normalized = normalizeHexColor(candidate);
      if (normalized) {
        const rgb = hexToRgb(normalized);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        setHslMemory({
          syncedHex: normalized,
          h: hsl.s <= 0.01 ? effectiveHsl.h : Math.round(hsl.h),
          s: Math.round(hsl.s * 100),
          l: Math.round(hsl.l * 100),
        });
        onChangeColor(normalized, false);
      }
    }
  };

  const commitHexDraft = () => {
    if (!hexDraft) return;
    const normalized = normalizeHexColor(hexDraft.text);
    setHexDraft(null);
    if (normalized) {
      onChangeColor(normalized, false);
    }
  };

  const showTempFeedback = (msg: string) => {
    setClipboardFeedback(msg);
    setTimeout(() => {
      setClipboardFeedback((curr) => (curr === msg ? null : curr));
    }, 1800);
  };

  const handleCopyHex = async () => {
    try {
      await navigator.clipboard.writeText(colorHex);
      showTempFeedback("Disalin");
    } catch {
      showTempFeedback("Gagal salin");
    }
  };

  const handlePasteHex = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const normalized = normalizeHexColor(text);
      if (normalized) {
        setHexDraft(null);
        onChangeColor(normalized, false);
        showTempFeedback("Ditempel");
      } else {
        showTempFeedback("Hex tidak valid");
      }
    } catch {
      showTempFeedback("Izin tempel ditolak");
    }
  };

  const activeCategory =
    INLINE_PALETTE_CATEGORIES.find((c) => c.id === paletteCategory) ??
    INLINE_PALETTE_CATEGORIES[0];

  const hueTrackStyle = {
    "--hsl-track":
      "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
  } as CSSProperties;

  const satTrackStyle = {
    "--hsl-track": `linear-gradient(to right, hsl(${effectiveHsl.h}, 0%, ${effectiveHsl.l}%), hsl(${effectiveHsl.h}, 100%, ${effectiveHsl.l}%))`,
  } as CSSProperties;

  const lightTrackStyle = {
    "--hsl-track": `linear-gradient(to right, #000000 0%, hsl(${effectiveHsl.h}, ${effectiveHsl.s}%, 50%) 50%, #ffffff 100%)`,
  } as CSSProperties;

  return (
    <div
      data-group-id={groupId}
      className="rounded-xl border border-teal-400/35 bg-[#10141C] p-3 shadow-sm"
    >
      {/* Header Row: Active Color + Group Name + Pipet + Close */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-6 w-6 shrink-0 rounded-lg border border-white/30 shadow-inner"
            style={{ backgroundColor: colorHex }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-slate-100">
              Inline Color Picker • {groupName}
            </p>
            <p className="font-mono text-[11px] text-slate-400 tabular-nums">
              {colorHex} • HSL({effectiveHsl.h}°, {effectiveHsl.s}%,{" "}
              {effectiveHsl.l}%)
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onToggleEyedropper && (
            <button
              type="button"
              onClick={onToggleEyedropper}
              aria-pressed={isEyedropperActive}
              aria-label="Aktifkan alat Pipet untuk ambil warna dari gambar"
              title="Ambil warna dari kanvas (Pipet)"
              className={`flex min-h-[44px] items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-colors ${
                isEyedropperActive
                  ? "border-teal-300 bg-teal-400 text-slate-950"
                  : "border-white/15 bg-[#1B202C] text-slate-200 hover:border-teal-400/50 hover:text-teal-200"
              }`}
            >
              <Pipette className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Pipet</span>
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup panel warna"
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Real-time Hue, Saturation, Lightness Sliders */}
      <div className="mt-2.5 space-y-1.5">
        <div>
          <div className="flex items-center justify-between text-[11px]">
            <label
              htmlFor={`hsl-hue-${groupId}`}
              className="font-medium text-slate-300"
            >
              Rona (Hue)
            </label>
            <span className="font-mono text-teal-300 tabular-nums">
              {effectiveHsl.h}°
            </span>
          </div>
          <input
            id={`hsl-hue-${groupId}`}
            type="range"
            min={0}
            max={360}
            step={1}
            value={effectiveHsl.h}
            onChange={(e) =>
              commitHsl(
                Number(e.target.value),
                effectiveHsl.s,
                effectiveHsl.l,
              )
            }
            style={hueTrackStyle}
            aria-label={`Ubah rona warna (Hue) untuk ${groupName}`}
            className="hsl-slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px]">
            <label
              htmlFor={`hsl-sat-${groupId}`}
              className="font-medium text-slate-300"
            >
              Saturasi
            </label>
            <span className="font-mono text-teal-300 tabular-nums">
              {effectiveHsl.s}%
            </span>
          </div>
          <input
            id={`hsl-sat-${groupId}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={effectiveHsl.s}
            onChange={(e) =>
              commitHsl(
                effectiveHsl.h,
                Number(e.target.value),
                effectiveHsl.l,
              )
            }
            style={satTrackStyle}
            aria-label={`Ubah saturasi warna untuk ${groupName}`}
            className="hsl-slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px]">
            <label
              htmlFor={`hsl-light-${groupId}`}
              className="font-medium text-slate-300"
            >
              Kecerahan (Lightness)
            </label>
            <span className="font-mono text-teal-300 tabular-nums">
              {effectiveHsl.l}%
            </span>
          </div>
          <input
            id={`hsl-light-${groupId}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={effectiveHsl.l}
            onChange={(e) =>
              commitHsl(
                effectiveHsl.h,
                effectiveHsl.s,
                Number(e.target.value),
              )
            }
            style={lightTrackStyle}
            aria-label={`Ubah kecerahan warna (Lightness) untuk ${groupName}`}
            className="hsl-slider"
          />
        </div>
      </div>

      {/* Direct #RRGGBB Input + Copy / Paste Hex Buttons */}
      <div className="mt-2.5 flex items-center gap-1.5">
        <div className="relative flex min-h-[44px] flex-1 items-center rounded-xl border border-white/15 bg-[#1B202C] px-2.5 focus-within:border-teal-400">
          <span
            className="mr-2 h-4 w-4 shrink-0 rounded border border-white/25"
            style={{ backgroundColor: colorHex }}
            aria-hidden="true"
          />
          <input
            type="text"
            value={displayedHexText}
            onChange={(e) => handleHexInputChange(e.target.value)}
            onBlur={commitHexDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            spellCheck={false}
            autoCapitalize="characters"
            aria-label={`Input kode hex #RRGGBB untuk ${groupName}`}
            placeholder="#RRGGBB"
            className="w-full bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={() => void handleCopyHex()}
          aria-label="Salin kode warna hex"
          title="Salin Hex"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-xl border border-white/15 bg-[#1B202C] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/30 hover:bg-[#232938]"
        >
          <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Salin</span>
        </button>

        <button
          type="button"
          onClick={() => void handlePasteHex()}
          aria-label="Tempel kode warna hex"
          title="Tempel Hex"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-xl border border-white/15 bg-[#1B202C] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/30 hover:bg-[#232938]"
        >
          <ClipboardPaste className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Tempel</span>
        </button>
      </div>

      {clipboardFeedback && (
        <p
          role="status"
          className="mt-1.5 text-[11px] font-medium text-teal-300"
        >
          {clipboardFeedback}
        </p>
      )}

      {/* Categorized Quick Palette Swatches (>= 44x44px touch targets) */}
      <div className="mt-2.5 space-y-2 border-t border-white/10 pt-2.5">
        <div
          role="tablist"
          aria-label="Kategori palet warna cepat"
          className="grid grid-cols-3 gap-1 rounded-xl bg-[#161B26] p-1"
        >
          {INLINE_PALETTE_CATEGORIES.map((category) => {
            const isActive = category.id === activeCategory.id;
            return (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setPaletteCategory(category.id)}
                className={`flex min-h-[44px] items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors ${
                  isActive
                    ? "bg-teal-400 text-slate-950"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                {category.label}
              </button>
            );
          })}
        </div>

        <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-0.5">
          {activeCategory.colors.map((preset) => {
            const isSelected = preset === colorHex;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onChangeColor(preset, false)}
                aria-label={`Terapkan warna ${activeCategory.label} ${preset} ke ${groupName}`}
                aria-pressed={isSelected}
                style={{ backgroundColor: preset }}
                className={`h-11 w-11 shrink-0 rounded-xl border transition-transform active:scale-95 ${
                  isSelected
                    ? "border-2 border-teal-300 ring-2 ring-teal-400/50"
                    : "border-white/25 hover:border-white/60"
                }`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected Region Card (Mode 2D Tap-to-Split)
// ---------------------------------------------------------------------------

interface SelectedRegionCardProps {
  region: RegionInfo;
  group: ColorGroup;
  allGroups: ColorGroup[];
  onSplitToNewGroup: (regionId: number) => void;
  onAssignToGroup: (regionId: number, targetGroupId: string) => void;
  onChangeGroupColor: (
    groupId: string,
    newHex: string,
    coalesce?: boolean,
  ) => void;
  isEyedropperActive: boolean;
  onToggleEyedropper: () => void;
  onClearSelection: () => void;
}

export function SelectedRegionCard({
  region,
  group,
  allGroups,
  onSplitToNewGroup,
  onAssignToGroup,
  onChangeGroupColor,
  isEyedropperActive,
  onToggleEyedropper,
  onClearSelection,
}: SelectedRegionCardProps) {
  const canSplit = group.regionIds.length > 1;
  const otherGroups = allGroups.filter((g) => g.groupId !== group.groupId);

  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-teal-400/40 bg-[#10141C] p-3 shadow-sm">
        {/* Header info + Close action */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-5 w-5 shrink-0 rounded-md border border-white/25"
              style={{ backgroundColor: group.colorHex }}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-slate-100">
                Region #{region.regionId} • {group.name}
              </p>
              <p className="truncate text-[11px] text-slate-400 tabular-nums">
                {region.pixelCount.toLocaleString("id-ID")} px • Asal{" "}
                <span className="font-mono text-slate-300">
                  {region.originalHex}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClearSelection}
            aria-label="Tutup seleksi region"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Primary action row: Split to new group + Move to existing group */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onSplitToNewGroup(region.regionId)}
            disabled={!canSplit}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-teal-400 px-3 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-300 active:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
          >
            <Scissors className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {canSplit ? "Pisahkan ke Grup Baru" : "Sudah Grup Sendiri"}
            </span>
          </button>

          {otherGroups.length > 0 && (
            <div className="relative flex min-h-[44px] flex-1 items-center">
              <ArrowRightLeft
                className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-slate-400"
                aria-hidden="true"
              />
              <select
                aria-label="Pindahkan region ke grup warna lain"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    onAssignToGroup(region.regionId, e.target.value);
                  }
                }}
                className="min-h-[44px] w-full appearance-none rounded-xl border border-white/15 bg-[#1B202C] pr-3 pl-8 text-xs font-medium text-slate-100 focus:border-teal-400 focus:outline-none"
              >
                <option value="" disabled>
                  Pindah ke Grup...
                </option>
                {otherGroups.map((target) => (
                  <option key={target.groupId} value={target.groupId}>
                    {target.name} ({target.colorHex})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <InlineColorPicker
        groupId={group.groupId}
        groupName={group.name}
        colorHex={group.colorHex}
        onChangeColor={(hex, coalesce) =>
          onChangeGroupColor(group.groupId, hex, coalesce)
        }
        isEyedropperActive={isEyedropperActive}
        onToggleEyedropper={onToggleEyedropper}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Group List with Rename, Highlight Member Selection & Inline Picker
// ---------------------------------------------------------------------------

interface ColorGroupsListProps {
  groups: InspectorGroupView[];
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onFocusGroupColor?: (groupId: string) => void;
  onRenameGroup: (groupId: string, newName: string) => void;
  onChangeGroupColor: (
    groupId: string,
    newHex: string,
    coalesce?: boolean,
  ) => void;
  onMergeGroups: (sourceGroupId: string, targetGroupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onResetGrouping: () => void;
  isColorPickerOpen: boolean;
  onCloseColorPicker: () => void;
  isEyedropperActive: boolean;
  onToggleEyedropper: () => void;
  emptyMessage?: string;
  resetLabel?: string;
}

export function ColorGroupsList({
  groups,
  selectedGroupId,
  onSelectGroup,
  onFocusGroupColor,
  onRenameGroup,
  onChangeGroupColor,
  onMergeGroups,
  onDeleteGroup,
  onResetGrouping,
  isColorPickerOpen,
  onCloseColorPicker,
  isEyedropperActive,
  onToggleEyedropper,
  emptyMessage = "Belum ada grup warna.",
  resetLabel = "Reset Grup",
}: ColorGroupsListProps) {
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");

  const activeGroup =
    selectedGroupId !== null
      ? groups.find((g) => g.groupId === selectedGroupId) ?? null
      : null;

  const startRename = (group: InspectorGroupView) => {
    setEditingGroupId(group.groupId);
    setRenameDraft(group.name);
  };

  const commitRename = () => {
    if (!editingGroupId) return;
    const trimmed = renameDraft.trim();
    if (trimmed) {
      onRenameGroup(editingGroupId, trimmed);
    }
    setEditingGroupId(null);
  };

  const cancelRename = () => {
    setEditingGroupId(null);
    setRenameDraft("");
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          Daftar Grup Warna ({groups.length})
        </h2>

        {groups.length > 0 && (
          <button
            type="button"
            onClick={onResetGrouping}
            aria-label="Reset semua pengelompokan grup ke awal"
            className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{resetLabel}</span>
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-[#101217] px-3 py-3 text-xs text-slate-400">
          {emptyMessage}
        </div>
      ) : (
        <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-x-visible lg:pb-0">
          {groups.map((group) => {
            const isSelected = selectedGroupId === group.groupId;
            const isEditing = editingGroupId === group.groupId;
            const mergeTargets = groups.filter(
              (other) => other.groupId !== group.groupId,
            );

            return (
              <div
                key={group.groupId}
                className={`flex shrink-0 items-center justify-between gap-1 rounded-xl border p-1.5 transition-colors lg:w-full ${
                  isSelected
                    ? "border-teal-400/70 bg-teal-500/12 ring-1 ring-teal-400/30"
                    : "border-white/10 bg-[#101217] hover:border-white/20"
                }`}
              >
                {/* Swatch button: opens Inline Color Picker directly without native mobile dialog */}
                <button
                  type="button"
                  onClick={() =>
                    onFocusGroupColor
                      ? onFocusGroupColor(group.groupId)
                      : onSelectGroup(group.groupId)
                  }
                  aria-label={`Buka Inline Color Picker untuk ${group.name}`}
                  title={`Ubah warna ${group.name}`}
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-white/5"
                >
                  <span
                    className="h-7 w-7 rounded-lg border border-white/30 shadow-sm"
                    style={{ backgroundColor: group.colorHex }}
                    aria-hidden="true"
                  />
                </button>

                {isEditing ? (
                  <div className="flex min-w-[170px] flex-1 items-center gap-1">
                    <input
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      autoFocus
                      maxLength={40}
                      aria-label={`Nama baru untuk ${group.name}`}
                      placeholder="Mis. Topi, Bintang..."
                      className="min-h-[44px] min-w-[84px] flex-1 rounded-lg border border-teal-400 bg-[#1B202C] px-2.5 text-xs font-medium text-slate-100 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={commitRename}
                      aria-label="Simpan nama grup"
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg bg-teal-400 text-slate-950 hover:bg-teal-300"
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelRename}
                      aria-label="Batal ubah nama grup"
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg bg-[#1B202C] text-slate-300 hover:bg-white/10"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Group Title + Member Count: Tap to highlight all member regions on canvas */}
                    <button
                      type="button"
                      onClick={() => onSelectGroup(group.groupId)}
                      aria-pressed={isSelected}
                      aria-label={`Sorot semua anggota grup ${group.name}`}
                      className="flex min-h-[44px] min-w-[104px] flex-1 flex-col items-start justify-center rounded-lg px-1.5 text-left"
                    >
                      <div className="flex w-full items-center gap-1.5">
                        <span className="truncate text-xs font-semibold text-slate-100">
                          {group.name}
                        </span>
                        {isSelected && (
                          <span className="shrink-0 rounded bg-teal-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-teal-300">
                            Disorot
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400 tabular-nums">
                        <span className="font-mono text-slate-300">
                          {group.colorHex}
                        </span>{" "}
                        • {group.countLabel}
                      </span>
                    </button>

                    {/* Pencil Rename Button (>= 44x44px touch target) */}
                    <button
                      type="button"
                      onClick={() => startRename(group)}
                      aria-label={`Ganti nama grup ${group.name}`}
                      title={`Ganti nama ${group.name}`}
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-teal-300"
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </>
                )}

                {!isEditing && mergeTargets.length > 0 && (
                  <div className="relative flex min-h-[44px] shrink-0 items-center">
                    <GitMerge
                      className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400"
                      aria-hidden="true"
                    />
                    <select
                      aria-label={`Gabungkan ${group.name} ke grup lain`}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          onMergeGroups(group.groupId, e.target.value);
                        }
                      }}
                      className="min-h-[44px] w-[44px] cursor-pointer appearance-none rounded-lg border border-white/10 bg-[#1B202C] pl-8 text-xs text-transparent focus:border-teal-400 focus:outline-none lg:w-24 lg:pr-2 lg:text-slate-200"
                      title={`Gabung ${group.name} ke grup lain`}
                    >
                      <option value="" disabled className="text-slate-400">
                        Gabung
                      </option>
                      {mergeTargets.map((target) => (
                        <option
                          key={target.groupId}
                          value={target.groupId}
                          className="bg-[#171A21] text-slate-100"
                        >
                          Gabung → {target.name} ({target.colorHex})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {!isEditing && onDeleteGroup && (
                  <button
                    type="button"
                    onClick={() => onDeleteGroup(group.groupId)}
                    aria-label={`Hapus seleksi grup ${group.name}`}
                    title={`Hapus ${group.name}`}
                    className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Inline Color Picker mounted right below groups inside bottom control dock */}
      {isColorPickerOpen && activeGroup && (
        <InlineColorPicker
          groupId={activeGroup.groupId}
          groupName={activeGroup.name}
          colorHex={activeGroup.colorHex}
          onChangeColor={(hex, coalesce) =>
            onChangeGroupColor(activeGroup.groupId, hex, coalesce)
          }
          isEyedropperActive={isEyedropperActive}
          onToggleEyedropper={onToggleEyedropper}
          onClose={onCloseColorPicker}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode 3D Controls (HSV Tolerance Flood-Fill + Mask Brush & Eraser)
// ---------------------------------------------------------------------------

interface Mode3DControlsProps {
  activeTool: Recolor3DTool;
  onSelectTool: (tool: Recolor3DTool) => void;
  tolerance: number;
  onChangeTolerance: (value: number) => void;
  shadowReach?: number;
  onChangeShadowReach?: (value: number) => void;
  brushMode?: BrushMode3D;
  onChangeBrushMode?: (mode: BrushMode3D) => void;
  brushRadius: number;
  onChangeBrushRadius: (radius: number) => void;
  hasActiveGroup: boolean;
  activeGroupName: string | null;
  canAdjustActiveGroupTolerance: boolean;
  isGlobalColorPickMode?: boolean;
  onTriggerGlobalSimilar?: () => void;
}

export function Mode3DControls({
  activeTool,
  onSelectTool,
  tolerance,
  onChangeTolerance,
  shadowReach = DEFAULT_3D_SHADOW_REACH,
  onChangeShadowReach,
  brushMode = "smart",
  onChangeBrushMode,
  brushRadius,
  onChangeBrushRadius,
  hasActiveGroup,
  activeGroupName,
  canAdjustActiveGroupTolerance,
  isGlobalColorPickMode = false,
  onTriggerGlobalSimilar,
}: Mode3DControlsProps) {
  return (
    <div className="space-y-2.5 rounded-xl border border-white/10 bg-[#101217] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal
            className="h-4 w-4 text-teal-300"
            aria-hidden="true"
          />
          <h3 className="text-xs font-semibold text-slate-100">
            Alat Seleksi 3D &amp; Kuas Koreksi
          </h3>
        </div>
        {hasActiveGroup && activeGroupName && (
          <span className="truncate rounded bg-teal-400/15 px-2 py-0.5 text-[11px] font-medium text-teal-200">
            Aktif: {activeGroupName}
          </span>
        )}
      </div>

      {/* Tool Selector: Tap-Select | Brush + | Eraser | Pipet */}
      <div
        role="group"
        aria-label="Alat seleksi dan koreksi Mode 3D"
        className="grid grid-cols-4 gap-1 rounded-xl bg-[#161B26] p-1"
      >
        <button
          type="button"
          onClick={() => onSelectTool("select")}
          aria-pressed={activeTool === "select"}
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-1.5 text-xs font-semibold transition-colors ${
            activeTool === "select"
              ? "bg-teal-400 text-slate-950"
              : "text-slate-300 hover:text-white"
          }`}
        >
          <MousePointer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Ketuk</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTool("brush")}
          aria-pressed={activeTool === "brush"}
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-1.5 text-xs font-semibold transition-colors ${
            activeTool === "brush"
              ? "bg-teal-400 text-slate-950"
              : "text-slate-300 hover:text-white"
          }`}
        >
          <Brush className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Kuas +</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTool("eraser")}
          aria-pressed={activeTool === "eraser"}
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-1.5 text-xs font-semibold transition-colors ${
            activeTool === "eraser"
              ? "bg-teal-400 text-slate-950"
              : "text-slate-300 hover:text-white"
          }`}
        >
          <Eraser className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Hapus</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectTool("eyedropper")}
          aria-pressed={activeTool === "eyedropper"}
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-1.5 text-xs font-semibold transition-colors ${
            activeTool === "eyedropper"
              ? "bg-teal-400 text-slate-950"
              : "text-slate-300 hover:text-white"
          }`}
        >
          <Pipette className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Pipet</span>
        </button>
      </div>

      {/* Active Group 3D Hue Tolerance Slider (5-60) */}
      <div>
        <div className="flex items-center justify-between text-xs">
          <label
            htmlFor="tolerance-3d-slider"
            className="font-medium text-slate-200"
          >
            Toleransi Rona
          </label>
          <span className="rounded-md bg-[#202532] px-2 py-0.5 font-semibold text-teal-300 tabular-nums">
            {tolerance}
          </span>
        </div>

        <input
          id="tolerance-3d-slider"
          type="range"
          min={MIN_3D_TOLERANCE}
          max={MAX_3D_TOLERANCE}
          step={1}
          value={tolerance}
          onChange={(e) => onChangeTolerance(Number(e.target.value))}
          aria-label="Toleransi rona warna 3D dari 5 sampai 60"
          className="studio-slider"
        />

        <p className="text-[11px] text-slate-400">
          {canAdjustActiveGroupTolerance
            ? "Mengatur ketat/longgarnya kemiripan rona (Hue) pada grup aktif tanpa bocor ke abu-abu."
            : "Ketuk objek 3D di kanvas; Toleransi Rona menjaga jarak warna tetap ketat."}
        </p>
      </div>

      {/* Shadow Reach Slider (0-100): expands strictly into darker adjacent shadows */}
      {onChangeShadowReach && (
        <div>
          <div className="flex items-center justify-between text-xs">
            <label
              htmlFor="shadow-reach-3d-slider"
              className="font-medium text-slate-200"
            >
              Jangkauan Bayangan (Shadow Reach)
            </label>
            <span className="rounded-md bg-[#202532] px-2 py-0.5 font-semibold text-sky-300 tabular-nums">
              {shadowReach}%
            </span>
          </div>

          <input
            id="shadow-reach-3d-slider"
            type="range"
            min={MIN_3D_SHADOW_REACH}
            max={MAX_3D_SHADOW_REACH}
            step={1}
            value={shadowReach}
            onChange={(e) => onChangeShadowReach(Number(e.target.value))}
            aria-label="Jangkauan bayangan (Shadow Reach) dari 0 sampai 100"
            className="studio-slider"
          />

          <p className="text-[11px] text-slate-400">
            Menarik area bayangan gelap di tepi lipatan tanpa meluber keluar garis outline hitam.
          </p>
        </div>
      )}

      {/* Quick Global Color Range Button (Semua Warna Serupa) */}
      {onTriggerGlobalSimilar && (
        <div className="border-t border-white/10 pt-2">
          <button
            type="button"
            onClick={onTriggerGlobalSimilar}
            aria-pressed={isGlobalColorPickMode}
            className={`flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border px-3 text-xs font-semibold transition-colors ${
              isGlobalColorPickMode
                ? "border-sky-300 bg-sky-400 text-slate-950"
                : "border-sky-400/40 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25"
            }`}
          >
            <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {isGlobalColorPickMode
                ? "Ketuk Warna di Kanvas (Batal)"
                : "Semua Warna Serupa"}
            </span>
          </button>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Menyeleksi seluruh piksel berwarna mirip di kanvas (menembus garis
            outline hitam) sesuai slider Toleransi.
          </p>
        </div>
      )}

      {/* Smart Edge-Aware vs Manual Brush Mode + Size Selector (visible when Brush or Eraser is active) */}
      {(activeTool === "brush" || activeTool === "eraser") && (
        <div className="space-y-2.5 border-t border-white/10 pt-2">
          {activeTool === "brush" && onChangeBrushMode && (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-200">
                Mode Kuas +
              </span>
              <div
                role="group"
                aria-label="Pilih mode kuas pintar atau manual"
                className="grid grid-cols-2 gap-1.5 rounded-xl bg-[#161B26] p-1"
              >
                <button
                  type="button"
                  onClick={() => onChangeBrushMode("smart")}
                  aria-pressed={brushMode === "smart"}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors ${
                    brushMode === "smart"
                      ? "bg-teal-400 text-slate-950"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Kuas Pintar</span>
                </button>

                <button
                  type="button"
                  onClick={() => onChangeBrushMode("manual")}
                  aria-pressed={brushMode === "manual"}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors ${
                    brushMode === "manual"
                      ? "bg-teal-400 text-slate-950"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  <Brush className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Kuas Manual</span>
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                {brushMode === "smart"
                  ? "Batas Garis: sapu melewati banyak lipatan dalam 1 tarikan — terisi penuh dan otomatis berhenti di garis hitam."
                  : "Manual: mewarnai bebas mengikuti ukuran lingkaran kuas tanpa mengikuti garis batas."}
              </p>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-medium text-slate-200">
                Ukuran Kuas {activeTool === "brush" ? "Tambah" : "Hapus"}
              </span>
              <span className="font-mono text-[11px] text-teal-300 tabular-nums">
                {brushRadius * 2} px
              </span>
            </div>
          <div className="grid grid-cols-4 gap-1.5">
            {BRUSH_RADIUS_PRESETS.map((preset) => {
              const isActive = brushRadius === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onChangeBrushRadius(preset)}
                  aria-pressed={isActive}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition-colors ${
                    isActive
                      ? "border-teal-400 bg-teal-400/20 text-teal-200"
                      : "border-white/10 bg-[#171A21] text-slate-300 hover:border-white/25"
                  }`}
                >
                  <span
                    className="rounded-full bg-current"
                    style={{
                      width: Math.max(6, Math.min(18, Math.round(preset * 0.45))),
                      height: Math.max(6, Math.min(18, Math.round(preset * 0.45))),
                    }}
                    aria-hidden="true"
                  />
                  <span>{preset}</span>
                </button>
              );
            })}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
