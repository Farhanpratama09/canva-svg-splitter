"use client";

import { CopyPlus, Palette, Plus, X } from "lucide-react";
import { MAX_BATCH_FILES } from "@/lib/image-processor/image-loader";

export interface BatchFilmstripItem {
  id: string;
  fileName: string;
  thumbnailUrl: string;
  isNativeSvg: boolean;
  processingMode: "2d" | "3d";
  groupCount: number;
}

interface BatchFilmstripProps {
  items: BatchFilmstripItem[];
  activeItemId: string;
  onSelectItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
  onAddMore: () => void;
  onDuplicateActive: () => void;
  onSyncPaletteToAll: () => void;
  paletteSyncMessage: string | null;
}

export function BatchFilmstrip({
  items,
  activeItemId,
  onSelectItem,
  onRemoveItem,
  onAddMore,
  onDuplicateActive,
  onSyncPaletteToAll,
  paletteSyncMessage,
}: BatchFilmstripProps) {
  const canAddMore = items.length < MAX_BATCH_FILES;
  const hasMultiple = items.length > 1;

  return (
    <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#13161D] px-2.5 sm:px-4">
      {/* Scrollable Thumbnail Strip */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {items.map((item, idx) => {
          const isActive = item.id === activeItemId;

          return (
            <div
              key={item.id}
              className={`relative flex shrink-0 items-center rounded-lg border transition-colors ${
                isActive
                  ? "border-teal-400 bg-teal-400/15"
                  : "border-white/10 bg-[#1B1F29] hover:border-white/25"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectItem(item.id)}
                aria-label={`Pilih desain ${idx + 1}: ${item.fileName}`}
                aria-current={isActive ? "true" : undefined}
                className="flex min-h-[44px] items-center gap-2 rounded-lg pr-2 pl-1.5 text-left"
              >
                <div className="checkerboard-surface relative h-8 w-8 shrink-0 overflow-hidden rounded border border-white/20">
                  {item.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.thumbnailUrl}
                      alt={item.fileName}
                      className="h-full w-full object-contain"
                    />
                  ) : null}
                </div>

                <div className="hidden max-w-[96px] min-w-0 sm:block">
                  <p className="truncate text-[11px] font-medium text-slate-100">
                    {item.fileName}
                  </p>
                  <p className="text-[10px] text-slate-400 tabular-nums">
                    {item.processingMode === "3d"
                      ? "3D"
                      : item.isNativeSvg
                        ? "SVG"
                        : "2D"}{" "}
                    • {item.groupCount} grup
                  </p>
                </div>
              </button>

              {hasMultiple && (
                <button
                  type="button"
                  onClick={() => onRemoveItem(item.id)}
                  aria-label={`Hapus ${item.fileName} dari antrean`}
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-r-lg text-slate-400 hover:bg-rose-500/20 hover:text-rose-200"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}

        {/* Add More Button */}
        {canAddMore && (
          <button
            type="button"
            onClick={onAddMore}
            aria-label="Tambah gambar lain ke antrean batch"
            title={`Tambah Gambar (${items.length}/${MAX_BATCH_FILES})`}
            className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-dashed border-slate-600 bg-[#1A1E28] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-teal-400 hover:text-teal-300"
          >
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Tambah</span>
          </button>
        )}
      </div>

      {/* Batch Actions: Duplicate Colorway & Sync Palette */}
      <div className="flex shrink-0 items-center gap-1">
        {paletteSyncMessage && (
          <span className="hidden rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300 md:inline">
            {paletteSyncMessage}
          </span>
        )}

        <button
          type="button"
          onClick={onDuplicateActive}
          disabled={!canAddMore}
          aria-label="Duplikat desain aktif untuk varian colorway baru"
          title="Duplikat Desain"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#1B1F29] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 hover:bg-[#232836] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CopyPlus className="h-4 w-4 shrink-0 text-teal-300" aria-hidden="true" />
          <span className="hidden md:inline">Duplikat</span>
        </button>

        {hasMultiple && (
          <button
            type="button"
            onClick={onSyncPaletteToAll}
            aria-label="Salin palet warna desain aktif ke seluruh desain di antrean"
            title="Salin Palet ke Semua"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-teal-400/35 bg-teal-400/15 px-2.5 text-xs font-semibold text-teal-200 transition-colors hover:bg-teal-400/25"
          >
            <Palette className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">Salin Palet ke Semua</span>
            <span className="hidden sm:inline lg:hidden">Salin Palet</span>
          </button>
        )}
      </div>
    </div>
  );
}
