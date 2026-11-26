"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Brush,
  Eraser,
  GitMerge,
  Layers,
  Minus,
  MousePointer,
  Pipette,
  Plus,
  RotateCcw,
  Scissors,
  Sparkles,
  X,
} from "lucide-react";
import { rgbToHex } from "@/lib/image-processor/color-quantizer";
import type { RegionBoundingBox } from "@/lib/image-processor/region-segmenter";
import type {
  BrushMode3D,
  Point2D,
  Recolor3DTool,
} from "@/lib/image-processor/recolor-3d-engine";

interface CanvasWorkspaceProps {
  imageData: ImageData;
  /** Original un-recolored image buffer used by the Touch Eyedropper (Pipet). */
  sourceImageData?: ImageData;
  width: number;
  height: number;
  /** Increments only when a brand-new image is loaded so slider tweaks keep zoom/pan. */
  imageKey: number;
  resetTrigger: number;
  fileName: string;
  processingMode: "2d" | "3d";
  activeTool: Recolor3DTool;
  onChangeTool?: (tool: Recolor3DTool) => void;
  isMultiSelectMode?: boolean;
  onToggleMultiSelectMode?: () => void;
  selectedCount?: number;
  canMergeSelection?: boolean;
  canSplitSelection?: boolean;
  onMergeSelection?: () => void;
  onSplitSelection?: () => void;
  onClearSelection?: () => void;
  isGlobalColorPickMode?: boolean;
  eyedropperTargetName?: string | null;
  onEyedropperPick?: (hex: string) => void;
  regionMap?: Int32Array | null;
  selectedBoundingBox?: RegionBoundingBox | null;
  onSelectRegion?: (regionId: number | null, multiSelectModifier?: boolean) => void;
  onTapCanvasPoint3D?: (
    x: number,
    y: number,
    multiSelectModifier?: boolean,
  ) => void;
  brushRadius?: number;
  brushMode?: BrushMode3D;
  onChangeBrushMode?: (mode: BrushMode3D) => void;
  onBrushStart3D?: () => void;
  onBrushSegment3D?: (points: Point2D[], mode: "brush" | "eraser") => void;
  onBrushEnd3D?: () => void;
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

interface TouchLoupeState {
  pointerId: number;
  viewportX: number;
  viewportY: number;
  viewportWidth: number;
  hex: string | null;
  isTransparent: boolean;
  wasMultiTouch: boolean;
}

interface BrushSessionState {
  pointerId: number;
  mode: "brush" | "eraser";
  lastPoint: Point2D;
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
  sourceImageData,
  width,
  height,
  imageKey,
  resetTrigger,
  fileName,
  processingMode,
  activeTool,
  onChangeTool,
  isMultiSelectMode = false,
  onToggleMultiSelectMode,
  selectedCount = 0,
  canMergeSelection = false,
  canSplitSelection = false,
  onMergeSelection,
  onSplitSelection,
  onClearSelection,
  isGlobalColorPickMode = false,
  eyedropperTargetName,
  onEyedropperPick,
  regionMap,
  selectedBoundingBox,
  onSelectRegion,
  onTapCanvasPoint3D,
  brushRadius = 16,
  brushMode = "smart",
  onChangeBrushMode,
  onBrushStart3D,
  onBrushSegment3D,
  onBrushEnd3D,
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
  const [loupe, setLoupe] = useState<TouchLoupeState | null>(null);
  const loupeRef = useRef<TouchLoupeState | null>(null);
  const [brushCursor, setBrushCursor] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const activePointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const prevPinchRef = useRef<PinchState | null>(null);
  const tapCandidateRef = useRef<TapCandidate | null>(null);
  const brushSessionRef = useRef<BrushSessionState | null>(null);
  const viewportRectRef = useRef<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const updateLoupe = useCallback((next: TouchLoupeState | null) => {
    loupeRef.current = next;
    setLoupe(next);
  }, []);

  const sampleOriginalPixel = useCallback(
    (clientX: number, clientY: number) => {
      const rect = viewportRectRef.current;
      const t = transformRef.current;
      const viewportX = clientX - rect.left;
      const viewportY = clientY - rect.top;
      const ix = Math.floor((viewportX - t.x) / t.scale);
      const iy = Math.floor((viewportY - t.y) / t.scale);

      const viewportWidth = viewportSizeRef.current.width || 360;
      const sampleBuffer = sourceImageData ?? imageData;
      if (
        ix < 0 ||
        ix >= sampleBuffer.width ||
        iy < 0 ||
        iy >= sampleBuffer.height
      ) {
        return {
          viewportX,
          viewportY,
          viewportWidth,
          hex: null,
          isTransparent: true,
        };
      }

      const off = (iy * sampleBuffer.width + ix) * 4;
      const alpha = sampleBuffer.data[off + 3];
      if (alpha < 10) {
        return {
          viewportX,
          viewportY,
          viewportWidth,
          hex: null,
          isTransparent: true,
        };
      }

      const hex = rgbToHex(
        sampleBuffer.data[off],
        sampleBuffer.data[off + 1],
        sampleBuffer.data[off + 2],
      );
      return {
        viewportX,
        viewportY,
        viewportWidth,
        hex,
        isTransparent: false,
      };
    },
    [imageData, sourceImageData],
  );

  const clientToImagePoint = useCallback(
    (clientX: number, clientY: number): Point2D => {
      const rect = viewportRectRef.current;
      const t = transformRef.current;
      return {
        x: (clientX - rect.left - t.x) / t.scale,
        y: (clientY - rect.top - t.y) / t.scale,
      };
    },
    [],
  );

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
        if (activeTool === "eyedropper") {
          const sampled = sampleOriginalPixel(event.clientX, event.clientY);
          updateLoupe({
            pointerId: event.pointerId,
            viewportX: sampled.viewportX,
            viewportY: sampled.viewportY,
            viewportWidth: sampled.viewportWidth,
            hex: sampled.hex,
            isTransparent: sampled.isTransparent,
            wasMultiTouch: false,
          });
          return;
        }

        if (
          processingMode === "3d" &&
          (activeTool === "brush" || activeTool === "eraser")
        ) {
          const imgPt = clientToImagePoint(event.clientX, event.clientY);
          brushSessionRef.current = {
            pointerId: event.pointerId,
            mode: activeTool,
            lastPoint: imgPt,
          };
          setBrushCursor({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          });
          onBrushStart3D?.();
          onBrushSegment3D?.([imgPt], activeTool);
          return;
        }

        tapCandidateRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          maxDistSq: 0,
          wasMultiTouch: false,
        };
      } else {
        // Multi-touch gesture (pinch-to-zoom) immediately invalidates tap/eyedropper/brush
        if (tapCandidateRef.current) {
          tapCandidateRef.current.wasMultiTouch = true;
        }
        if (loupeRef.current) {
          updateLoupe(null);
        }
        if (brushSessionRef.current) {
          brushSessionRef.current = null;
          setBrushCursor(null);
          onBrushEnd3D?.();
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
    [
      activeTool,
      clientToImagePoint,
      onBrushEnd3D,
      onBrushSegment3D,
      onBrushStart3D,
      processingMode,
      sampleOriginalPixel,
      updateLoupe,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const el = viewportRef.current;
      if (
        processingMode === "3d" &&
        (activeTool === "brush" || activeTool === "eraser") &&
        el
      ) {
        const rect = el.getBoundingClientRect();
        viewportRectRef.current = { left: rect.left, top: rect.top };
        setBrushCursor({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }

      const pointers = activePointersRef.current;
      if (!pointers.has(event.pointerId)) return;

      const previousPoint = pointers.get(event.pointerId)!;
      const nextPoint = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, nextPoint);

      if (pointers.size === 1) {
        // Touch Eyedropper tracking with raised Touch Loupe
        const currentLoupe = loupeRef.current;
        if (
          activeTool === "eyedropper" &&
          currentLoupe &&
          !currentLoupe.wasMultiTouch &&
          currentLoupe.pointerId === event.pointerId
        ) {
          const sampled = sampleOriginalPixel(event.clientX, event.clientY);
          updateLoupe({
            pointerId: event.pointerId,
            viewportX: sampled.viewportX,
            viewportY: sampled.viewportY,
            viewportWidth: sampled.viewportWidth,
            hex: sampled.hex,
            isTransparent: sampled.isTransparent,
            wasMultiTouch: false,
          });
          return;
        }

        // Mode 3D Brush / Eraser continuous stroke
        const activeBrush = brushSessionRef.current;
        if (
          processingMode === "3d" &&
          activeBrush &&
          activeBrush.pointerId === event.pointerId
        ) {
          const nextImgPt = clientToImagePoint(event.clientX, event.clientY);
          onBrushSegment3D?.(
            [activeBrush.lastPoint, nextImgPt],
            activeBrush.mode,
          );
          activeBrush.lastPoint = nextImgPt;
          return;
        }

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
    [
      activeTool,
      clientToImagePoint,
      onBrushSegment3D,
      processingMode,
      sampleOriginalPixel,
      updateLoupe,
    ],
  );

  const cleanupPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, allowReleaseAction: boolean) => {
      const pointers = activePointersRef.current;
      if (!pointers.has(event.pointerId)) return;

      const currentLoupe = loupeRef.current;
      const shouldCommitEyedropper =
        allowReleaseAction &&
        activeTool === "eyedropper" &&
        currentLoupe !== null &&
        currentLoupe.pointerId === event.pointerId &&
        !currentLoupe.wasMultiTouch &&
        pointers.size === 1;

      const activeBrush = brushSessionRef.current;
      const shouldCommitBrush =
        activeBrush !== null && activeBrush.pointerId === event.pointerId;

      const tapCandidate = tapCandidateRef.current;
      const shouldEvaluateTap =
        allowReleaseAction &&
        activeTool === "select" &&
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

      if (currentLoupe && currentLoupe.pointerId === event.pointerId) {
        const sampledHex = currentLoupe.hex;
        const wasTransparent = currentLoupe.isTransparent;
        updateLoupe(null);
        if (shouldCommitEyedropper && !wasTransparent && sampledHex) {
          onEyedropperPick?.(sampledHex);
        }
      }

      if (shouldCommitBrush) {
        brushSessionRef.current = null;
        if (event.pointerType !== "mouse") {
          setBrushCursor(null);
        }
        onBrushEnd3D?.();
      }

      if (shouldEvaluateTap) {
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const t = transformRef.current;
        const ix = Math.floor((event.clientX - rect.left - t.x) / t.scale);
        const iy = Math.floor((event.clientY - rect.top - t.y) / t.scale);
        const multiSelectModifier = event.ctrlKey || event.metaKey;

        if (processingMode === "3d") {
          if (ix >= 0 && ix < width && iy >= 0 && iy < height) {
            onTapCanvasPoint3D?.(ix, iy, multiSelectModifier);
          } else {
            onClearSelection?.();
          }
          return;
        }

        if (onSelectRegion && regionMap) {
          if (ix >= 0 && ix < width && iy >= 0 && iy < height) {
            const hitRegionId = regionMap[iy * width + ix];
            onSelectRegion(
              hitRegionId > 0 ? hitRegionId : null,
              multiSelectModifier,
            );
          } else {
            onSelectRegion(null, multiSelectModifier);
          }
        }
      }
    },
    [
      activeTool,
      height,
      onBrushEnd3D,
      onClearSelection,
      onEyedropperPick,
      onSelectRegion,
      onTapCanvasPoint3D,
      processingMode,
      regionMap,
      updateLoupe,
      width,
    ],
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
  const vw = loupe?.viewportWidth ?? 360;
  const loupeTop = loupe ? Math.max(44, loupe.viewportY - 76) : 0;
  const loupeLeft = loupe ? Math.max(44, Math.min(vw - 44, loupe.viewportX)) : 0;
  const brushScreenDiameter = Math.max(10, brushRadius * 2 * transform.scale);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#101217] select-none">
      {/* Interactive Pan, Pinch-Zoom, Tap-to-Select, Eyedropper & 3D Brush Surface */}
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setBrushCursor(null)}
        className={`relative h-full w-full touch-none ${
          activeTool === "eyedropper"
            ? "cursor-crosshair"
            : activeTool === "brush" || activeTool === "eraser"
              ? "cursor-none"
              : isGrabbing
                ? "cursor-grabbing"
                : onSelectRegion || processingMode === "3d"
                  ? "cursor-crosshair"
                  : "cursor-grab"
        }`}
        aria-label={`Kanvas interaktif ${fileName}. Ketuk area ilustrasi untuk memilih, cubit untuk zoom, atau gunakan alat Pipet dan Kuas.`}
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

        {/* Screen-space Brush / Eraser ring indicator */}
        {processingMode === "3d" &&
          (activeTool === "brush" || activeTool === "eraser") &&
          brushCursor && (
            <div
              aria-hidden="true"
              style={{
                left: brushCursor.x,
                top: brushCursor.y,
                width: brushScreenDiameter,
                height: brushScreenDiameter,
                transform: "translate(-50%, -50%)",
              }}
              className={`pointer-events-none absolute rounded-full border-2 shadow-[0_0_0_1px_rgba(15,17,21,0.85)] ${
                activeTool === "brush"
                  ? "border-teal-300 bg-teal-400/15"
                  : "border-rose-300 bg-rose-400/15"
              }`}
            />
          )}

        {/* Touch Loupe for Eyedropper (positioned above thumb so finger never hides color) */}
        {loupe && (
          <>
            <div
              aria-hidden="true"
              style={{
                left: loupe.viewportX,
                top: loupe.viewportY,
                transform: "translate(-50%, -50%)",
              }}
              className="pointer-events-none absolute h-3.5 w-3.5 rounded-full border-2 border-white bg-teal-300/40 shadow-[0_0_0_1.5px_rgba(15,17,21,0.9)]"
            />

            <div
              aria-hidden="true"
              style={{
                left: loupeLeft,
                top: loupeTop,
                transform: "translate(-50%, -50%)",
              }}
              className="pointer-events-none absolute z-30 flex flex-col items-center gap-1"
            >
              <div
                style={
                  loupe.isTransparent || !loupe.hex
                    ? undefined
                    : { backgroundColor: loupe.hex }
                }
                className={`flex h-16 w-16 items-center justify-center rounded-full border-4 border-white shadow-[0_10px_28px_rgba(0,0,0,0.65)] ring-2 ring-slate-950 ${
                  loupe.isTransparent || !loupe.hex
                    ? "checkerboard-surface"
                    : ""
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full border border-white bg-slate-950/50 shadow" />
              </div>

              <span className="rounded-full bg-[#101217]/95 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-slate-100 shadow ring-1 ring-white/20">
                {loupe.isTransparent || !loupe.hex ? "Transparan" : loupe.hex}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Active Tool / Multi-Select Hint Banner */}
      {activeTool === "eyedropper" ? (
        <div
          role="status"
          className="pointer-events-none absolute top-16 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-teal-400/45 bg-[#121722]/95 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-teal-200 shadow-lg backdrop-blur-md"
        >
          <Pipette className="h-3.5 w-3.5 shrink-0 text-teal-300" aria-hidden="true" />
          <span>
            Sentuh &amp; geser untuk ambil warna
            {eyedropperTargetName ? ` → ${eyedropperTargetName}` : ""}
          </span>
        </div>
      ) : activeTool === "select" && isGlobalColorPickMode ? (
        <div
          role="status"
          className="pointer-events-none absolute top-16 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-sky-400/50 bg-[#121722]/95 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-sky-200 shadow-lg backdrop-blur-md"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />
          <span>Ketuk warna di kanvas untuk pilih semua warna serupa</span>
        </div>
      ) : activeTool === "brush" && processingMode === "3d" ? (
        <div
          role="status"
          className="pointer-events-none absolute top-16 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-1.5 rounded-full border border-teal-400/45 bg-[#121722]/95 px-3 py-1 text-xs font-medium whitespace-nowrap text-teal-200 shadow-lg backdrop-blur-md sm:flex"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-teal-300" aria-hidden="true" />
          <span>
            {brushMode === "smart"
              ? "Kuas Pintar (Batas Garis) — sapu melintasi lipatan, berhenti di garis hitam"
              : "Kuas Manual — sapuan bebas tanpa batas garis"}
          </span>
        </div>
      ) : activeTool === "select" && isMultiSelectMode ? (
        <div
          role="status"
          className="pointer-events-none absolute top-16 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-1.5 rounded-full border border-teal-400/45 bg-[#121D1A]/95 px-3 py-1 text-xs font-medium whitespace-nowrap text-teal-200 shadow-lg backdrop-blur-md sm:flex"
        >
          <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {processingMode === "3d"
              ? "Mode Pilih Banyak 3D aktif — ketuk beberapa bagian lalu Gabung Grup"
              : "Mode Pilih Banyak aktif — ketuk beberapa bagian lalu Gabung/Pisah"}
          </span>
        </div>
      ) : null}

      {/* Responsive Bottom Stack: Floating Selection Action Bar + Tool Strip + Zoom Controls */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex flex-col gap-2"
      >
        {/* Quick Smart/Manual Brush Mode Toggle above Bottom Bar when Kuas + is active */}
        {processingMode === "3d" &&
          activeTool === "brush" &&
          onChangeBrushMode && (
            <div
              role="group"
              aria-label="Pilih mode Kuas Pintar atau Manual"
              className="pointer-events-auto flex w-fit max-w-full items-center gap-1 self-start rounded-xl border border-teal-400/40 bg-[#121722]/95 p-1 shadow-xl backdrop-blur-md"
            >
              <button
                type="button"
                onClick={() => onChangeBrushMode("smart")}
                aria-pressed={brushMode === "smart"}
                className={`flex min-h-[44px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors ${
                  brushMode === "smart"
                    ? "bg-teal-400 text-slate-950"
                    : "text-slate-200 hover:bg-white/10"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Kuas Pintar (Batas Garis)</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeBrushMode("manual")}
                aria-pressed={brushMode === "manual"}
                className={`flex min-h-[44px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors ${
                  brushMode === "manual"
                    ? "bg-teal-400 text-slate-950"
                    : "text-slate-200 hover:bg-white/10"
                }`}
              >
                <Brush className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Kuas Manual</span>
              </button>
            </div>
          )}
        {/* 2-Stage Selection Confirmation Action Bar */}
        {selectedCount > 0 && activeTool === "select" && (
          <div
            role="toolbar"
            aria-label="Aksi konfirmasi seleksi sementara"
            className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 self-center rounded-2xl border border-teal-400/45 bg-[#121722]/95 p-1.5 shadow-2xl backdrop-blur-md"
          >
            <span className="shrink-0 whitespace-nowrap rounded-xl bg-teal-400/15 px-3 py-1.5 text-xs font-semibold text-teal-200 tabular-nums">
              {selectedCount} bagian dipilih
            </span>

            {onMergeSelection && (
              <button
                type="button"
                onClick={onMergeSelection}
                disabled={!canMergeSelection}
                aria-label="Gabung Grup dari bagian terpilih (Enter atau Ctrl+G)"
                title="Gabung Grup (Enter / Ctrl+G)"
                className="flex min-h-[44px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-teal-400 px-3.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-300 active:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                <GitMerge className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="whitespace-nowrap">Gabung Grup</span>
              </button>
            )}

            {onSplitSelection && (
              <button
                type="button"
                onClick={onSplitSelection}
                disabled={!canSplitSelection}
                aria-label="Pisah Grup menjadi grup baru (Shift+Enter)"
                title="Pisah Grup (Shift+Enter)"
                className="flex min-h-[44px] shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-sky-400/45 bg-sky-500/20 px-3.5 text-xs font-semibold text-sky-100 transition-colors hover:bg-sky-500/30 active:bg-sky-500/40 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-slate-800 disabled:text-slate-400"
              >
                <Scissors className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="whitespace-nowrap">Pisah Grup</span>
              </button>
            )}

            {onClearSelection && (
              <button
                type="button"
                onClick={onClearSelection}
                aria-label="Batalkan seleksi sementara (Esc)"
                title="Batal (Esc)"
                className="flex min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-[#1B202C] px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10"
              >
                <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="whitespace-nowrap">Batal</span>
              </button>
            )}
          </div>
        )}

        {/* Bottom Row: Left Tool Strip + Right Zoom Controls */}
        <div className="flex flex-wrap-reverse items-end justify-between gap-2">
          {(onChangeTool || onToggleMultiSelectMode) ? (
            <div
              role="group"
              aria-label="Alat seleksi dan kanvas interaktif"
              className="pointer-events-auto flex w-fit max-w-full shrink-0 items-center gap-1.5 overflow-x-auto rounded-xl border border-white/10 bg-[#171A21]/92 p-1.5 shadow-lg backdrop-blur-md no-scrollbar"
            >
              {onToggleMultiSelectMode && activeTool === "select" && (
                <button
                  type="button"
                  onClick={onToggleMultiSelectMode}
                  aria-pressed={isMultiSelectMode}
                  aria-label="Aktifkan atau nonaktifkan mode Pilih Banyak (Ctrl+Klik di desktop)"
                  title="Pilih Banyak (Ctrl+Klik)"
                  className={`flex min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors ${
                    isMultiSelectMode
                      ? "bg-emerald-400 text-slate-950"
                      : "text-slate-200 hover:bg-white/10"
                  }`}
                >
                  <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="shrink-0 whitespace-nowrap">Pilih Banyak</span>
                </button>
              )}

              {onChangeTool && processingMode === "3d" && (
                <>
                  <button
                    type="button"
                    onClick={() => onChangeTool("select")}
                    aria-pressed={activeTool === "select"}
                    aria-label="Alat ketuk area seleksi 3D"
                    title="Ketuk Area 3D"
                    className={`flex min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                      activeTool === "select"
                        ? "bg-teal-400 text-slate-950"
                        : "text-slate-200 hover:bg-white/10"
                    }`}
                  >
                    <MousePointer className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="hidden whitespace-nowrap md:inline">Ketuk</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onChangeTool("brush")}
                    aria-pressed={activeTool === "brush"}
                    aria-label="Kuas tambah seleksi 3D"
                    title="Kuas Tambah Seleksi"
                    className={`flex min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                      activeTool === "brush"
                        ? "bg-teal-400 text-slate-950"
                        : "text-slate-200 hover:bg-white/10"
                    }`}
                  >
                    <Brush className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="hidden whitespace-nowrap md:inline">Kuas +</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onChangeTool("eraser")}
                    aria-pressed={activeTool === "eraser"}
                    aria-label="Kuas hapus seleksi 3D"
                    title="Kuas Hapus Seleksi"
                    className={`flex min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                      activeTool === "eraser"
                        ? "bg-teal-400 text-slate-950"
                        : "text-slate-200 hover:bg-white/10"
                    }`}
                  >
                    <Eraser className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="hidden whitespace-nowrap md:inline">Hapus</span>
                  </button>
                </>
              )}

              {onChangeTool && (
                <button
                  type="button"
                  onClick={() =>
                    onChangeTool(
                      activeTool === "eyedropper" ? "select" : "eyedropper",
                    )
                  }
                  aria-pressed={activeTool === "eyedropper"}
                  aria-label="Alat Pipet untuk mengambil warna dari gambar"
                  title="Pipet Warna (Touch Eyedropper)"
                  className={`flex min-h-[44px] min-w-[44px] shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                    activeTool === "eyedropper"
                      ? "bg-teal-400 text-slate-950"
                      : "text-slate-200 hover:bg-white/10"
                  }`}
                >
                  <Pipette className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span
                    className={`whitespace-nowrap ${
                      processingMode === "2d" ? "inline" : "hidden md:inline"
                    }`}
                  >
                    Pipet
                  </span>
                </button>
              )}
            </div>
          ) : (
            <div />
          )}

          {/* Floating Zoom & Reset Controls (min 44x44px touch targets) */}
          <div className="pointer-events-auto ml-auto flex w-fit max-w-full shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-[#171A21]/92 p-1.5 shadow-lg backdrop-blur-md">
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
      </div>
    </div>
  );
}
