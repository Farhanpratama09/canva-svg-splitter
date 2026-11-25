"use client";

import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  GitMerge,
  Minimize2,
  RotateCcw,
  Scissors,
  X,
} from "lucide-react";
import {
  CANVA_FREE_MAX_COLORS,
  PASTEL_COLOR_PRESETS,
  type ColorGroup,
  type RegionGroupingState,
} from "@/lib/image-processor/region-grouper";
import type { RegionInfo } from "@/lib/image-processor/region-segmenter";

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
  onClearSelection: () => void;
}

export function SelectedRegionCard({
  region,
  group,
  allGroups,
  onSplitToNewGroup,
  onAssignToGroup,
  onChangeGroupColor,
  onClearSelection,
}: SelectedRegionCardProps) {
  const canSplit = group.regionIds.length > 1;
  const otherGroups = allGroups.filter((g) => g.groupId !== group.groupId);

  return (
    <div className="rounded-xl border border-teal-400/40 bg-[#10141C] p-3 shadow-sm">
      {/* Header info + Split & Close actions */}
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

      {/* Color Picker + Touch-friendly Pastel/Soft Swatches */}
      <div className="mt-2.5 flex items-center gap-2">
        <label
          className="relative flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-white/15 bg-[#1B202C] px-2.5 transition-colors hover:border-white/30"
          title="Pilih warna kustom untuk grup ini"
        >
          <input
            type="color"
            value={group.colorHex}
            onChange={(e) =>
              onChangeGroupColor(group.groupId, e.target.value, true)
            }
            aria-label={`Ubah warna kustom untuk ${group.name}`}
            className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          <span className="font-mono text-xs font-medium text-slate-100">
            {group.colorHex}
          </span>
        </label>

        <div className="no-scrollbar flex flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
          {PASTEL_COLOR_PRESETS.map((preset) => {
            const isActive = preset === group.colorHex;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onChangeGroupColor(group.groupId, preset, false)}
                aria-label={`Terapkan warna preset ${preset} ke ${group.name}`}
                aria-pressed={isActive}
                style={{ backgroundColor: preset }}
                className={`h-11 w-11 shrink-0 rounded-xl border transition-transform active:scale-95 ${
                  isActive
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

interface ColorGroupsListProps {
  groupingState: RegionGroupingState;
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onChangeGroupColor: (
    groupId: string,
    newHex: string,
    coalesce?: boolean,
  ) => void;
  onMergeGroups: (sourceGroupId: string, targetGroupId: string) => void;
  onResetGrouping: () => void;
}

export function ColorGroupsList({
  groupingState,
  selectedGroupId,
  onSelectGroup,
  onChangeGroupColor,
  onMergeGroups,
  onResetGrouping,
}: ColorGroupsListProps) {
  const { groups } = groupingState;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          Daftar Grup Warna ({groups.length})
        </h2>

        <button
          type="button"
          onClick={onResetGrouping}
          aria-label="Reset semua pengelompokan warna ke awal"
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Reset Grup</span>
        </button>
      </div>

      {/* Horizontal compact strip on mobile when unselected, vertical stack on desktop */}
      <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-x-visible lg:pb-0">
        {groups.map((group) => {
          const isSelected = selectedGroupId === group.groupId;
          const mergeTargets = groups.filter(
            (other) => other.groupId !== group.groupId,
          );

          return (
            <div
              key={group.groupId}
              className={`flex shrink-0 items-center justify-between gap-2 rounded-xl border p-1.5 transition-colors lg:w-full ${
                isSelected
                  ? "border-teal-400/60 bg-teal-500/10"
                  : "border-white/10 bg-[#101217] hover:border-white/20"
              }`}
            >
              <label
                className="flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-white/5"
                title={`Ganti warna ${group.name}`}
              >
                <input
                  type="color"
                  value={group.colorHex}
                  onChange={(e) =>
                    onChangeGroupColor(group.groupId, e.target.value, true)
                  }
                  aria-label={`Ubah warna ${group.name}`}
                  className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
                />
              </label>

              <button
                type="button"
                onClick={() => onSelectGroup(group.groupId)}
                className="flex min-h-[44px] min-w-[110px] flex-1 flex-col items-start justify-center rounded-lg px-1.5 text-left"
              >
                <span className="text-xs font-semibold text-slate-100">
                  {group.name}
                </span>
                <span className="text-[11px] text-slate-400 tabular-nums">
                  <span className="font-mono text-slate-300">
                    {group.colorHex}
                  </span>{" "}
                  • {group.regionIds.length} bagian
                </span>
              </button>

              {mergeTargets.length > 0 && (
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
