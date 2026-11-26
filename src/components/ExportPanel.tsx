"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Download,
  FileCode2,
  FileImage,
  Info,
  Minimize2,
  Sparkles,
} from "lucide-react";
import {
  MAX_RDP_EPSILON,
  MIN_RDP_EPSILON,
} from "@/lib/svg-exporter/contour-tracer";
import type {
  CanvaSvgExportResult,
  ExportedSvgFile,
} from "@/lib/svg-exporter/canva-svg-exporter";
import {
  computeHdTargetDimensions,
  MAX_HD_RASTER_DIMENSION,
  triggerBlobDownload,
  type ExportFormatOption,
  type HdScaleFactor,
} from "@/lib/svg-exporter/raster-hd-exporter";
import { CANVA_FREE_MAX_COLORS } from "@/lib/image-processor/region-grouper";

const JPG_BG_PRESETS = ["#FFFFFF", "#F3F4F6", "#111318", "#FCE7F3"] as const;
const HD_SCALES: HdScaleFactor[] = [1, 2, 4];

interface ExportPanelProps {
  processingMode: "2d" | "3d";
  exportResult: CanvaSvgExportResult | null;
  baseWidth: number;
  baseHeight: number;
  isNativeSvgSource: boolean;
  epsilon: number;
  smoothCurves: boolean;
  onChangeEpsilon: (value: number) => void;
  onToggleSmoothCurves: () => void;
  onAutoCompactToFive: () => void;
  batchItemCount: number;
  onExportActiveHdRaster: (params: {
    format: "png" | "jpg";
    scale: HdScaleFactor;
    jpgBgHex: string;
  }) => Promise<void>;
  onExportAllZip: (params: {
    format: ExportFormatOption;
    scale: HdScaleFactor;
    jpgBgHex: string;
  }) => Promise<void>;
}

function formatKb(byteSize: number): string {
  const kb = byteSize / 1024;
  return kb < 1 ? `${byteSize} B` : `${kb.toFixed(1)} KB`;
}

export function ExportPanel({
  processingMode,
  exportResult,
  baseWidth,
  baseHeight,
  isNativeSvgSource,
  epsilon,
  smoothCurves,
  onChangeEpsilon,
  onToggleSmoothCurves,
  onAutoCompactToFive,
  batchItemCount,
  onExportActiveHdRaster,
  onExportAllZip,
}: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormatOption>("svg");
  const [hdScale, setHdScale] = useState<HdScaleFactor>(2);
  const [jpgBgHex, setJpgBgHex] = useState<string>("#FFFFFF");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloadedParts, setDownloadedParts] = useState<Set<number>>(
    () => new Set(),
  );

  // In Mode 3D, SVG export is disabled and automatically routed to PNG/JPG HD
  const effectiveFormat: ExportFormatOption =
    processingMode === "3d" && format === "svg" ? "png" : format;

  const handleDownloadSingleSvg = useCallback((file: ExportedSvgFile) => {
    const blob = new Blob([file.svgString], {
      type: "image/svg+xml;charset=utf-8",
    });
    triggerBlobDownload(blob, file.fileName);
    setDownloadedParts((prev) => {
      const next = new Set(prev);
      next.add(file.partIndex);
      return next;
    });
  }, []);

  const handleHdDownload = useCallback(async () => {
    if (effectiveFormat === "svg") return;
    setIsExporting(true);
    setExportError(null);
    try {
      await onExportActiveHdRaster({
        format: effectiveFormat,
        scale: hdScale,
        jpgBgHex,
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Gagal mengekspor gambar HD.",
      );
    } finally {
      setIsExporting(false);
    }
  }, [effectiveFormat, hdScale, jpgBgHex, onExportActiveHdRaster]);

  const handleZipDownload = useCallback(async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      await onExportAllZip({
        format: effectiveFormat,
        scale: hdScale,
        jpgBgHex,
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Gagal membuat arsip ZIP.",
      );
    } finally {
      setIsExporting(false);
    }
  }, [effectiveFormat, hdScale, jpgBgHex, onExportAllZip]);

  const files = exportResult?.files ?? [];
  const totalBytes = files.reduce((acc, f) => acc + f.byteSize, 0);
  const hdDims = computeHdTargetDimensions(baseWidth, baseHeight, hdScale);
  const showZipButton =
    batchItemCount > 1 || (effectiveFormat === "svg" && files.length > 1);

  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          {processingMode === "3d" ? "Ekspor HD Mode 3D" : "Ekspor Multi-Format"}
        </h2>
        <span className="rounded-md bg-[#202532] px-2 py-0.5 text-[11px] font-medium text-teal-300">
          {processingMode === "3d"
            ? "3D Gradasi (PNG/JPG)"
            : isNativeSvgSource
              ? "Vektor SVG Asli"
              : "Vektor + HD"}
        </span>
      </div>

      {/* Format Selector: SVG (Mode 2D only) | PNG Transparan HD | JPG Katalog HD */}
      <div
        role="tablist"
        aria-label="Pilih format file ekspor"
        className="grid grid-cols-3 gap-1 rounded-xl bg-[#101217] p-1 ring-1 ring-white/10"
      >
        <button
          type="button"
          role="tab"
          aria-selected={effectiveFormat === "svg"}
          disabled={processingMode === "3d"}
          onClick={() => setFormat("svg")}
          title={
            processingMode === "3d"
              ? "Ekspor SVG hanya aktif di Mode 2D"
              : "Ekspor SVG siap Canva Free"
          }
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs font-semibold transition-colors ${
            processingMode === "3d"
              ? "cursor-not-allowed text-slate-500 line-through"
              : effectiveFormat === "svg"
                ? "bg-teal-400 text-slate-950"
                : "text-slate-300 hover:text-white"
          }`}
        >
          <FileCode2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>SVG</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={effectiveFormat === "png"}
          onClick={() => setFormat("png")}
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs font-semibold transition-colors ${
            effectiveFormat === "png"
              ? "bg-teal-400 text-slate-950"
              : "text-slate-300 hover:text-white"
          }`}
        >
          <FileImage className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>PNG HD</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={effectiveFormat === "jpg"}
          onClick={() => setFormat("jpg")}
          className={`flex min-h-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs font-semibold transition-colors ${
            effectiveFormat === "jpg"
              ? "bg-teal-400 text-slate-950"
              : "text-slate-300 hover:text-white"
          }`}
        >
          <FileImage className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>JPG HD</span>
        </button>
      </div>

      {/* Mode 3D Notice explaining why SVG is disabled */}
      {processingMode === "3d" && (
        <div
          role="note"
          className="flex items-start gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5 text-xs text-sky-100"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
          <p className="leading-relaxed">
            Ekspor <code>.svg</code> hanya aktif di <strong>Mode 2D</strong>{" "}
            karena Canva Free tidak mendukung gradasi 3D di dalam SVG. Gunakan{" "}
            <strong>PNG Transparan HD</strong> atau{" "}
            <strong>JPG Katalog HD</strong> agar kilap dan bayangan tetap utuh.
          </p>
        </div>
      )}

      {exportError && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {exportError}
        </div>
      )}

      {/* Raster-to-Vector Curve Settings (Mode 2D raster only) */}
      {processingMode === "2d" && !isNativeSvgSource && (
        <div className="space-y-2 rounded-xl border border-white/10 bg-[#101217] p-3">
          <div>
            <div className="flex items-center justify-between text-xs">
              <label
                htmlFor="rdp-epsilon-slider"
                className="font-medium text-slate-200"
              >
                Kehalusan Kurva (RDP)
              </label>
              <span className="rounded-md bg-[#202532] px-2 py-0.5 font-semibold text-teal-300 tabular-nums">
                {epsilon.toFixed(1)} px
              </span>
            </div>

            <input
              id="rdp-epsilon-slider"
              type="range"
              min={MIN_RDP_EPSILON}
              max={MAX_RDP_EPSILON}
              step={0.1}
              value={epsilon}
              onChange={(e) => {
                setDownloadedParts(new Set());
                onChangeEpsilon(Number(e.target.value));
              }}
              aria-label="Kehalusan kurva vektor RDP Epsilon dari 0.4 sampai 2.0"
              className="studio-slider"
            />
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-200">
                Chaikin Corner Smoothing
              </p>
              <p className="text-[11px] text-slate-400">
                Haluskan lengkungan tanpa menumpulkan sudut &lt; 75°
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={smoothCurves}
              aria-label="Aktifkan penghalusan kurva Chaikin selektif"
              onClick={() => {
                setDownloadedParts(new Set());
                onToggleSmoothCurves();
              }}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end"
            >
              <span
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                  smoothCurves ? "bg-teal-400" : "bg-slate-600"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-slate-950 shadow transition-transform ${
                    smoothCurves ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </span>
            </button>
          </div>
        </div>
      )}

      {/* SVG Format View (Mode 2D only) */}
      {effectiveFormat === "svg" && (
        <>
          {exportResult && files.length > 0 ? (
            <>
              <div
                role="status"
                className={`rounded-xl border px-3 py-2.5 text-xs ${
                  exportResult.isMultiPartSplit
                    ? "border-amber-400/35 bg-amber-500/10 text-amber-100"
                    : "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold">
                    {exportResult.isMultiPartSplit ? (
                      <AlertTriangle
                        className="h-4 w-4 shrink-0 text-amber-300"
                        aria-hidden="true"
                      />
                    ) : (
                      <CheckCircle2
                        className="h-4 w-4 shrink-0 text-emerald-300"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {exportResult.isMultiPartSplit
                        ? `Auto-Split ${files.length} File SVG`
                        : "1 File SVG Siap Canva Free"}
                    </span>
                  </div>

                  <span className="text-[11px] text-slate-300 tabular-nums">
                    {formatKb(totalBytes)} • {exportResult.processingTimeMs} ms
                  </span>
                </div>

                <p className="mt-1 leading-relaxed text-slate-300">
                  {exportResult.isMultiPartSplit
                    ? `Total ${exportResult.totalGroups} grup dipecah maksimal ${CANVA_FREE_MAX_COLORS} warna/file dengan Alignment Anchor.`
                    : isNativeSvgSource
                      ? `Vektor SVG asli dipertahankan utuh (${exportResult.totalGroups} grup warna).`
                      : `Semua ${exportResult.totalGroups} grup warna dalam 1 file SVG murni dengan fill-rule="evenodd".`}
                </p>

                {exportResult.isMultiPartSplit && (
                  <button
                    type="button"
                    onClick={onAutoCompactToFive}
                    className="mt-2.5 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-amber-300 px-3 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-200"
                  >
                    <Minimize2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Ringkas ke ≤ 5 Warna (1 File SVG)</span>
                  </button>
                )}
              </div>

              {showZipButton && (
                <button
                  type="button"
                  onClick={handleZipDownload}
                  disabled={isExporting}
                  className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-400 px-4 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-300 active:bg-teal-500 disabled:opacity-60"
                >
                  <Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {isExporting
                      ? "Mengemas ZIP..."
                      : batchItemCount > 1
                        ? `Unduh Semua Batch (${batchItemCount} Desain .ZIP)`
                        : `Unduh Semua (${files.length} Part .ZIP)`}
                  </span>
                </button>
              )}

              <div className="space-y-2">
                {files.map((file) => {
                  const isDownloaded = downloadedParts.has(file.partIndex);

                  return (
                    <div
                      key={file.fileName}
                      className="rounded-xl border border-white/10 bg-[#101217] p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <FileCode2
                            className="h-4 w-4 shrink-0 text-teal-300"
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-slate-100">
                              {file.fileName}
                            </p>
                            <p className="text-[11px] text-slate-400 tabular-nums">
                              {file.uniqueColors.length} /{" "}
                              {CANVA_FREE_MAX_COLORS} warna •{" "}
                              {formatKb(file.byteSize)}
                            </p>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleDownloadSingleSvg(file)}
                          aria-label={`Unduh ${file.fileName}`}
                          className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold transition-colors ${
                            !showZipButton
                              ? "bg-teal-400 text-slate-950 hover:bg-teal-300 active:bg-teal-500"
                              : "border border-teal-400/40 bg-teal-400/15 text-teal-200 hover:bg-teal-400/25"
                          }`}
                        >
                          {isDownloaded ? (
                            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                          ) : (
                            <Download
                              className="h-4 w-4 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <span>
                            {files.length > 1
                              ? `Part ${file.partIndex}`
                              : "Unduh SVG"}
                          </span>
                        </button>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {file.uniqueColors.map((hex) => (
                          <span
                            key={hex}
                            className="inline-flex items-center gap-1 rounded-md bg-[#171A21] px-1.5 py-0.5 text-[11px] text-slate-200 ring-1 ring-white/10"
                          >
                            <span
                              className="h-3 w-3 shrink-0 rounded-sm border border-white/25"
                              style={{ backgroundColor: hex }}
                              aria-hidden="true"
                            />
                            <span className="font-mono">{hex}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-xl border border-white/10 bg-[#101217] p-3 text-xs text-slate-300">
                <h3 className="font-semibold text-slate-100">
                  Cara Pakai di Canva Free (3 Langkah)
                </h3>
                <ol className="mt-1.5 list-decimal space-y-1 pl-4 leading-relaxed text-slate-300">
                  <li>
                    Buka <strong>Unggahan → Unggah file</strong> di Canva Free
                    dan pilih file <code>.svg</code> hasil unduhan.
                  </li>
                  <li>
                    Masukkan SVG ke desain, lalu ketuk objek untuk mengganti warna
                    tiap grup lewat kotak warna di toolbar atas.
                  </li>
                  <li>
                    {exportResult.isMultiPartSplit
                      ? "Tarik semua file part ke kanvas dengan ukuran sama dan ratakan Tengah/Tengah agar menumpuk presisi."
                      : "Setiap grup warna siap diganti warnanya secara terpisah tanpa ikon mahkota Pro."}
                  </li>
                </ol>
              </div>
            </>
          ) : (
            <p className="rounded-xl border border-white/10 bg-[#101217] p-3 text-xs text-slate-400">
              Tidak ada region vektor untuk diekspor.
            </p>
          )}
        </>
      )}

      {/* PNG HD & JPG Katalog HD Formats (Active in both 2D and 3D modes) */}
      {(effectiveFormat === "png" || effectiveFormat === "jpg") && (
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-[#101217] p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-200">
                Resolusi Output HD
              </span>
              <span className="font-semibold text-teal-300 tabular-nums">
                {hdDims.width}×{hdDims.height}px
              </span>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {HD_SCALES.map((scaleOption) => {
                const isActive = hdScale === scaleOption;
                return (
                  <button
                    key={scaleOption}
                    type="button"
                    onClick={() => setHdScale(scaleOption)}
                    aria-pressed={isActive}
                    className={`flex min-h-[44px] flex-col items-center justify-center rounded-xl border px-2 text-xs font-semibold transition-colors ${
                      isActive
                        ? "border-teal-400 bg-teal-400/20 text-teal-200"
                        : "border-white/10 bg-[#171A21] text-slate-300 hover:border-white/25"
                    }`}
                  >
                    <span>{scaleOption}x</span>
                    <span className="text-[10px] font-normal text-slate-400">
                      {scaleOption === 1
                        ? "Asli"
                        : scaleOption === 2
                          ? "HD"
                          : "Ultra HD"}
                    </span>
                  </button>
                );
              })}
            </div>

            {hdDims.wasClamped && (
              <p className="mt-2 text-[11px] text-amber-200">
                Skala dibatasi otomatis maksimal {MAX_HD_RASTER_DIMENSION}px
                pada sisi terpanjang agar aman di memori browser mobile.
              </p>
            )}

            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-teal-300" aria-hidden="true" />
              <span>
                {effectiveFormat === "png"
                  ? processingMode === "3d"
                    ? "PNG Transparan HD 3D: mempertahankan kilap cahaya, bayangan halus, dan alpha transparan."
                    : "PNG Transparan HD: bebas batas 5 warna, siap cetak keyring & stiker."
                  : "JPG Katalog HD: cocok untuk pratinjau WhatsApp & katalog klien."}
              </span>
            </p>
          </div>

          {effectiveFormat === "jpg" && (
            <div className="rounded-xl border border-white/10 bg-[#101217] p-3">
              <p className="mb-2 text-xs font-medium text-slate-200">
                Warna Latar Belakang JPG
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-h-[44px] flex-1 items-center gap-2 rounded-xl border border-white/15 bg-[#1B202C] px-2.5">
                  <span
                    className="h-5 w-5 shrink-0 rounded border border-white/25"
                    style={{ backgroundColor: jpgBgHex }}
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={jpgBgHex}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase().slice(0, 7);
                      setJpgBgHex(val);
                    }}
                    aria-label="Kode hex warna latar belakang JPG katalog"
                    className="w-full bg-transparent font-mono text-xs text-slate-100 focus:outline-none"
                  />
                </div>

                {JPG_BG_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setJpgBgHex(preset)}
                    aria-label={`Set latar JPG ke ${preset}`}
                    style={{ backgroundColor: preset }}
                    className={`h-11 w-11 shrink-0 rounded-xl border transition-transform active:scale-95 ${
                      jpgBgHex === preset
                        ? "border-2 border-teal-300 ring-2 ring-teal-400/50"
                        : "border-white/25 hover:border-white/60"
                    }`}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <button
              type="button"
              onClick={handleHdDownload}
              disabled={isExporting}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-400 px-4 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-300 active:bg-teal-500 disabled:opacity-60"
            >
              <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {isExporting
                  ? "Merender Gambar HD..."
                  : `Unduh ${effectiveFormat.toUpperCase()} (${hdDims.width}×${hdDims.height}px)`}
              </span>
            </button>

            {batchItemCount > 1 && (
              <button
                type="button"
                onClick={handleZipDownload}
                disabled={isExporting}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-teal-400/40 bg-teal-400/15 px-4 text-xs font-semibold text-teal-200 transition-colors hover:bg-teal-400/25 disabled:opacity-60"
              >
                <Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Unduh Semua Batch ({batchItemCount}{" "}
                  {effectiveFormat.toUpperCase()} .ZIP)
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
