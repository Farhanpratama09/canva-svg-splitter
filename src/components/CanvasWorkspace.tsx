"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { RegionBoundingBox } from "@/lib/image-processor/region-segmenter";

interface CanvasWorkspaceProps {
  imageData: ImageData;
  width: number;
  height: number;
  /** Increments only when a brand-new image is loaded so slider tweaks keep zoom/pan. */
  imageKey: number;
  resetTrigger: number;
  fileName: string;
  regionMap?: Int32Array | null;
  selectedBoundingBox?: RegionBoundingBox | null;
  onSelectRegion?: (regionId: number | null) => void;
}

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

interface PointerPoint {
  x: number;
  y: number;
}

interface PinchState {
  midX: number;
  midY: number;
  dist: number;
}

interface TapCandidate {
  pointerId: number;
  startX: number;
  startY: number;
  maxDistSq: number;
  wasMultiTouch: boolean;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 12;
// Touch Guard: tap only registers if pointer moves strictly less than 6px
const TAP_MAX_DIST_SQ = 6 * 6;

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function computeFitTransform(
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
): ViewTransform {
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return { x: 0, y: 0, scale: 1 };
  }

  const padding = viewportWidth < 640 ? 20 : 36;
  const availableWidth = Math.max(64, viewportWidth - padding * 2);
  const availableHeight = Math.max(64, viewportHeight - padding * 2);

  const fitScale = clampZoom(
    Math.min(availableWidth / imageWidth, availableHeight / imageHeight, 2),
  );

  const x = (viewportWidth - imageWidth * fitScale) / 2;
  const y = (viewportHeight - imageHeight * fitScale) / 2;

  return { x, y, scale: fitScale };
}

export function CanvasWorkspace({
  imageData,
  width,
  height,
  imageKey,
  resetTrigger,
  fileName,
  regionMap,
  selectedBoundingBox,
  onSelectRegion,
}: CanvasWorkspaceProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportSizeRef = useRef<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const [transform, setTransform] = useState<ViewTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const transformRef = useRef<ViewTransform>(transform);
  const [isGrabbing, setIsGrabbing] = useState(false);

  const activePointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const prevPinchRef = useRef<PinchState | null>(null);
  const tapCandidateRef = useRef<TapCandidate | null>(null);
  const viewportRectRef = useRef<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const resetViewToFit = useCallback(() => {
    const { width: vw, height: vh } = viewportSizeRef.current;
    if (vw > 0 && vh > 0) {
      setTransform(computeFitTransform(vw, vh, width, height));
      return;
    }

    const el = viewportRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      viewportSizeRef.current = { width: rect.width, height: rect.height };
      setTransform(computeFitTransform(rect.width, rect.height, width, height));
    });
  }, [width, height]);

  // Track viewport size cleanly via ResizeObserver without forced layout reflows
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextW = entry.contentRect.width;
        const nextH = entry.contentRect.height;
        const prev = viewportSizeRef.current;
        viewportSizeRef.current = { width: nextW, height: nextH };

        if (prev.width === 0 && prev.height === 0 && nextW > 0 && nextH > 0) {
          setTransform(computeFitTransform(nextW, nextH, width, height));
        }
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  // Fit canvas whenever a new image is loaded or external reset trigger fires
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      resetViewToFit();
    });
    return () => cancelAnimationFrame(frame);
  }, [imageKey, resetTrigger, resetViewToFit]);

  // Paint ImageData onto the HTML5 Canvas whenever pixel buffer updates
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (canvas.width !== imageData.width) {
      canvas.width = imageData.width;
    }
    if (canvas.height !== imageData.height) {
      canvas.height = imageData.height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(imageData, 0, 0);
  }, [imageData]);

  // Wheel / trackpad pinch zoom anchored at cursor position
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;

      const sensitivity = event.ctrlKey ? 0.008 : 0.0018;
      const factor = Math.exp(-event.deltaY * sensitivity);

      setTransform((prev) => {
        const nextScale = clampZoom(prev.scale * factor);
        const ratio = nextScale / prev.scale;
        return {
          scale: nextScale,
          x: anchorX - (anchorX - prev.x) * ratio,
          y: anchorY - (anchorY - prev.y) * ratio,
        };
      });
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const zoomAtCenter = useCallback((multiplier: number) => {
    const { width: vw, height: vh } = viewportSizeRef.current;
    const anchorX = vw > 0 ? vw / 2 : 160;
    const anchorY = vh > 0 ? vh / 2 : 160;

    setTransform((prev) => {
      const nextScale = clampZoom(prev.scale * multiplier);
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: anchorX - (anchorX - prev.x) * ratio,
        y: anchorY - (anchorY - prev.y) * ratio,
      };
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const el = viewportRef.current;
      if (!el) return;

      el.setPointerCapture(event.pointerId);
      const rect = el.getBoundingClientRect();
      viewportRectRef.current = { left: rect.left, top: rect.top };

      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      setIsGrabbing(true);

      if (activePointersRef.current.size === 1) {
        tapCandidateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          maxDistSq: 0,
          wasMultiTouch: false,
        };
      } else {
        // Multi-touch gesture (pinch-to-zoom) immediately invalidates tap selection
        if (tapCandidateRef.current) {
          tapCandidateRef.current.wasMultiTouch = true;
        }
        const points = Array.from(activePointersRef.current.values());
        const p1 = points[0];
        const p2 = points[1];
        prevPinchRef.current = {
          midX: (p1.x + p2.x) / 2 - rect.left,
          midY: (p1.y + p2.y) / 2 - rect.top,
          dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
        };
      }
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pointers = activePointersRef.current;
      if (!pointers.has(event.pointerId)) return;

      const previousPoint = pointers.get(event.pointerId)!;
      const nextPoint = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, nextPoint);

      const tapCandidate = tapCandidateRef.current;
      if (
        tapCandidate &&
        !tapCandidate.wasMultiTouch &&
        tapCandidate.pointerId === event.pointerId
      ) {
        const moveDx = event.clientX - tapCandidate.startX;
        const moveDy = event.clientY - tapCandidate.startY;
        const distSq = moveDx * moveDx + moveDy * moveDy;
        if (distSq > tapCandidate.maxDistSq) {
          tapCandidate.maxDistSq = distSq;
        }
      }

      if (pointers.size === 1) {
        const dx = nextPoint.x - previousPoint.x;
        const dy = nextPoint.y - previousPoint.y;

        setTransform((prev) => ({
          ...prev,
          x: prev.x + dx,
          y: prev.y + dy,
        }));
        return;
      }

      if (pointers.size >= 2) {
        const points = Array.from(pointers.values());
        const p1 = points[0];
        const p2 = points[1];
        const { left, top } = viewportRectRef.current;

        const newMidX = (p1.x + p2.x) / 2 - left;
        const newMidY = (p1.y + p2.y) / 2 - top;
        const newDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

        const prevPinch = prevPinchRef.current;
        if (prevPinch && prevPinch.dist > 4 && newDist > 4) {
          const distRatio = newDist / prevPinch.dist;

          setTransform((prev) => {
            const nextScale = clampZoom(prev.scale * distRatio);
            const actualRatio = nextScale / prev.scale;
            return {
              scale: nextScale,
              x: newMidX - (prevPinch.midX - prev.x) * actualRatio,
              y: newMidY - (prevPinch.midY - prev.y) * actualRatio,
            };
          });
        }

        prevPinchRef.current = {
          midX: newMidX,
          midY: newMidY,
          dist: newDist,
        };
      }
    },
    [],
  );

  const cleanupPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, allowTapSelect: boolean) => {
      const pointers = activePointersRef.current;
      if (!pointers.has(event.pointerId)) return;

      const tapCandidate = tapCandidateRef.current;
      const shouldEvaluateTap =
        allowTapSelect &&
        tapCandidate !== null &&
        tapCandidate.pointerId === event.pointerId &&
        !tapCandidate.wasMultiTouch &&
        tapCandidate.maxDistSq < TAP_MAX_DIST_SQ &&
        pointers.size === 1;

      pointers.delete(event.pointerId);

      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Ignore capture release errors on canceled touches
      }

      if (pointers.size < 2) {
        prevPinchRef.current = null;
      }
      if (pointers.size === 0) {
        setIsGrabbing(false);
        tapCandidateRef.current = null;
      }

      // O(1) Region Map hit-test on validated single-finger/mouse tap
      if (shouldEvaluateTap && onSelectRegion && regionMap) {
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const t = transformRef.current;
        const ix = Math.floor((event.clientX - rect.left - t.x) / t.scale);
        const iy = Math.floor((event.clientY - rect.top - t.y) / t.scale);

        if (ix >= 0 && ix < width && iy >= 0 && iy < height) {
          const hitRegionId = regionMap[iy * width + ix];
          onSelectRegion(hitRegionId > 0 ? hitRegionId : null);
        } else {
          onSelectRegion(null);
        }
      }
    },
    [height, onSelectRegion, regionMap, width],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      cleanupPointer(event, true);
    },
    [cleanupPointer],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      cleanupPointer(event, false);
    },
    [cleanupPointer],
  );

  const zoomPercent = Math.round(transform.scale * 100);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#101217] select-none">
      {/* Interactive Pan, Pinch-Zoom, and Tap-to-Select Surface */}
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className={`relative h-full w-full touch-none ${
          isGrabbing
            ? "cursor-grabbing"
            : onSelectRegion
              ? "cursor-crosshair"
              : "cursor-grab"
        }`}
        aria-label={`Kanvas interaktif ${fileName}. Ketuk area ilustrasi untuk memilih region, cubit untuk zoom, atau geser untuk menggerakkan kanvas.`}
      >
        <div
          style={{
            width,
            height,
            transformOrigin: "0 0",
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          }}
          className="checkerboard-surface relative will-change-transform shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/20"
        >
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            style={{
              imageRendering: transform.scale >= 2 ? "pixelated" : "auto",
            }}
            className="block h-full w-full"
          />
        </div>

        {/* Crisp Screen-Space Bounding Highlight for Selected Region */}
        {selectedBoundingBox && (
          <div
            aria-hidden="true"
            style={{
              left: transform.x + selectedBoundingBox.minX * transform.scale,
              top: transform.y + selectedBoundingBox.minY * transform.scale,
              width: Math.max(6, selectedBoundingBox.width * transform.scale),
              height: Math.max(6, selectedBoundingBox.height * transform.scale),
            }}
            className="pointer-events-none absolute rounded-sm border-2 border-dashed border-teal-300 shadow-[0_0_0_1px_rgba(15,17,21,0.85)]"
          />
        )}
      </div>

      {/* Bottom-left subtle gesture hint on tablet/desktop */}
      <div className="pointer-events-none absolute bottom-3 left-3 hidden rounded-lg bg-[#171A21]/85 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-white/10 backdrop-blur-sm md:block">
        Ketuk bagian untuk memilih • Geser pan • Cubit/scroll zoom
      </div>

      {/* Floating Zoom & Reset Controls (min 44x44px touch targets) */}
      <div
        className="absolute right-3 bottom-3 flex max-w-[95vw] items-center gap-1 rounded-xl border border-white/10 bg-[#171A21]/92 p-1 shadow-lg backdrop-blur-md"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomAtCenter(1 / 1.25)}
          aria-label="Perkecil tampilan kanvas"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-slate-200 transition-colors hover:bg-white/10 active:bg-white/15"
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>

        <span
          className="min-w-[52px] shrink-0 px-1 text-center text-xs font-medium text-slate-200 tabular-nums"
          aria-live="polite"
        >
          {zoomPercent}%
        </span>

        <button
          type="button"
          onClick={() => zoomAtCenter(1.25)}
          aria-label="Perbesar tampilan kanvas"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-slate-200 transition-colors hover:bg-white/10 active:bg-white/15"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="mx-0.5 h-6 w-px shrink-0 bg-white/10" aria-hidden="true" />

        <button
          type="button"
          onClick={resetViewToFit}
          aria-label="Reset posisi dan zoom kanvas"
          className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-teal-300 transition-colors hover:bg-teal-400/15 active:bg-teal-400/25"
        >
          <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Reset View</span>
        </button>
      </div>
    </div>
  );
}
