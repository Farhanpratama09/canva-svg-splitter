"use client";

import { useCallback, useEffect, useState, type ChangeEvent, type DragEvent } from "react";
import { ImagePlus, Sparkles, ShieldCheck, AlertCircle, Box } from "lucide-react";
import { MAX_BATCH_FILES } from "@/lib/image-processor/image-loader";

interface ImageUploaderProps {
  onFilesSelect: (files: File[]) => void;
  onLoadSample: () => void;
  onLoadSample3D?: () => void;
  isLoading: boolean;
  errorMessage: string | null;
  onRequestPickFiles: () => void;
}

export function ImageUploader({
  onFilesSelect,
  onLoadSample,
  onLoadSample3D,
  isLoading,
  errorMessage,
  onRequestPickFiles,
}: ImageUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);

      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) {
        onFilesSelect(files);
      }
    },
    [onFilesSelect],
  );

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const pastedFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            pastedFiles.push(file);
          }
        }
      }
      if (pastedFiles.length > 0) {
        onFilesSelect(pastedFiles);
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [onFilesSelect]);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="flex h-full w-full items-center justify-center p-4 sm:p-6"
    >
      <div
        className={`relative flex w-full max-w-md flex-col items-center rounded-2xl border-2 border-dashed p-6 text-center transition-colors sm:p-8 ${
          isDragging
            ? "border-teal-400 bg-teal-500/10"
            : "border-slate-700 bg-[#171A21]/90 hover:border-slate-500"
        }`}
      >
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#222733] text-teal-400 ring-1 ring-white/10">
          <ImagePlus className="h-7 w-7" aria-hidden="true" />
        </div>

        <h2 className="text-lg font-semibold tracking-tight text-slate-100 sm:text-xl">
          Unggah Ilustrasi 2D, Render 3D, atau SVG
        </h2>

        <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-slate-300">
          Ketuk tombol di bawah atau seret hingga {MAX_BATCH_FILES} file stiker,
          render 3D/clay, atau vektor SVG ke area ini.
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 flex w-full items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-left text-xs text-rose-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="mt-5 flex w-full flex-col gap-2.5">
          <button
            type="button"
            onClick={onRequestPickFiles}
            disabled={isLoading}
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-teal-400 px-5 text-sm font-semibold text-slate-950 transition-colors hover:bg-teal-300 active:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ImagePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{isLoading ? "Memproses..." : "Pilih Gambar"}</span>
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onLoadSample}
              disabled={isLoading}
              className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-600 bg-[#1F242F] px-3 text-xs font-medium text-slate-100 transition-colors hover:border-slate-400 hover:bg-[#272D3A] disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
            >
              <Sparkles className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <span>Contoh 2D</span>
            </button>

            {onLoadSample3D && (
              <button
                type="button"
                onClick={onLoadSample3D}
                disabled={isLoading}
                className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-600 bg-[#1F242F] px-3 text-xs font-medium text-slate-100 transition-colors hover:border-teal-400/50 hover:bg-[#272D3A] disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
              >
                <Box className="h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
                <span>Contoh 3D</span>
              </button>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-slate-400">
          <span>PNG • JPG • WEBP • SVG</span>
          <span aria-hidden="true">•</span>
          <span>Batch maks. {MAX_BATCH_FILES} desain</span>
        </div>

        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#111318] px-3 py-1.5 text-xs text-slate-300 ring-1 ring-white/10">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-teal-400" aria-hidden="true" />
          <span>100% diproses di browser Anda</span>
        </div>
      </div>
    </div>
  );
}

interface HiddenFileInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFilesSelect: (files: File[]) => void;
}

export function HiddenFileInput({ inputRef, onFilesSelect }: HiddenFileInputProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      onFilesSelect(files);
    }
    event.target.value = "";
  };

  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
      onChange={handleChange}
      className="sr-only"
      aria-label="Pilih satu atau beberapa file PNG, JPG, WEBP, atau SVG"
    />
  );
}
