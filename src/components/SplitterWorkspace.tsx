"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  Box,
  Download,
  Eraser,
  Eye,
  FolderOpen,
  Grid2x2,
  Info,
  Layers,
  Palette,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  loadImageFromFile,
  MAX_BATCH_FILES,
  MAX_IMAGE_DIMENSION,
  type LoadedImageResult,
} from "@/lib/image-processor/image-loader";
import {
  DEFAULT_BG_TOLERANCE,
  MAX_BG_TOLERANCE,
  MIN_BG_TOLERANCE,
  removeCornerBackground,
  type BackgroundRemovalResult,
} from "@/lib/image-processor/background-remover";
import {
  DEFAULT_COLOR_COUNT,
  MAX_COLOR_COUNT,
  MIN_COLOR_COUNT,
} from "@/lib/image-processor/color-quantizer";
import type { RegionInfo } from "@/lib/image-processor/region-segmenter";
import {
  applyPaletteToGrouping,
  assignRegionToGroup,
  autoCompactToFiveColors,
  commitGroupingChange,
  createGroupingHistory,
  createInitialGrouping,
  mergeGroups,
  mergeSelectedRegions,
  redoGrouping,
  renameGroup,
  renderGroupedCanvasImageData,
  resetGrouping,
  splitRegionToNewGroup,
  splitSelectedRegionsToNewGroup,
  undoGrouping,
  updateGroupColor,
  type CanvasPreviewMode,
  type GroupingHistory,
} from "@/lib/image-processor/region-grouper";
import {
  applyBrushStroke3D,
  applyPaletteTo3DState,
  commit3DChange,
  commitCandidateSelection3D,
  create3DHistory,
  createEmpty3DState,
  DEFAULT_3D_BRUSH_RADIUS,
  DEFAULT_3D_SHADOW_REACH,
  DEFAULT_3D_TOLERANCE,
  deleteGroup3D,
  findGroupAtPixel3D,
  floodFillSelect3D,
  mergeGroups3D,
  prepare3DImageData,
  recomputeGroupTolerance3D,
  redo3D,
  renameGroup3D,
  render3DCanvasImageData,
  render3DExportImageData,
  selectGlobalSimilar3D,
  toggleCandidatePoint3D,
  undo3D,
  updateGroupColor3D,
  type BrushMode3D,
  type CandidateSelection3D,
  type Point2D,
  type Prepared3DImage,
  type Recolor3DHistory,
  type Recolor3DState,
  type Recolor3DTool,
} from "@/lib/image-processor/recolor-3d-engine";
import {
  createThumbnailDataUrl,
  runUnifiedSegmentationPipeline,
  type PipelineParameters,
  type UnifiedSegmentationResult,
} from "@/lib/image-processor/pipeline";
import {
  createSample3DRenderImage,
  createSampleStickerImage,
} from "@/lib/image-processor/sample-illustration";
import { DEFAULT_RDP_EPSILON } from "@/lib/svg-exporter/contour-tracer";
import {
  buildCanvaSvgExport,
  buildFullVectorSvgForRender,
  sanitizeExportBaseName,
  type CanvaSvgExportResult,
} from "@/lib/svg-exporter/canva-svg-exporter";
import {
  createZipArchiveBlob,
  renderImageDataToHdRasterFile,
  renderSvgToHdRasterFile,
  triggerBlobDownload,
  type ExportFormatOption,
  type HdScaleFactor,
  type ZipEntryInput,
} from "@/lib/svg-exporter/raster-hd-exporter";
import {
  BatchFilmstrip,
  type BatchFilmstripItem,
} from "@/components/BatchFilmstrip";
import { CanvasWorkspace } from "@/components/CanvasWorkspace";
import { ExportPanel } from "@/components/ExportPanel";
import { HiddenFileInput, ImageUploader } from "@/components/ImageUploader";
import {
  CanvaGuardBadge,
  ColorGroupsList,
  Mode3DControls,
  SelectedRegionCard,
  type InspectorGroupView,
} from "@/components/RegionInspectorPanel";

type ProcessingMode = "2d" | "3d";
type MobilePanelTab = "groups" | "quantize" | "background" | "export";
type DesktopDockMode = "inspector" | "export";

interface BatchItem {
  id: string;
  processingMode: ProcessingMode;
  loadedImage: LoadedImageResult;
  thumbnailUrl: string;
  bgRemovalEnabled: boolean;
  tolerance: number;
  colorCount: number;
  rdpEpsilon: number;
  smoothCurves: boolean;
  cachedParams: PipelineParameters;
  segmentation: UnifiedSegmentationResult;
  history: GroupingHistory;
  // Mode 3D state (clean start with empty groups until tapped)
  tolerance3D: number;
  shadowReach3D: number;
  cached3DBgParams: { bgRemovalEnabled: boolean; tolerance: number } | null;
  prepared3D: Prepared3DImage | null;
  bgRemoval3DResult: BackgroundRemovalResult | null;
  history3D: Recolor3DHistory | null;
}

interface TempSelection2DState {
  itemId: string;
  segmentation: UnifiedSegmentationResult;
  ids: number[];
}

interface TempCandidates3DState {
  itemId: string;
  prepared: Prepared3DImage;
  nextCandidateSeq: number;
  candidates: CandidateSelection3D[];
}

interface HighlightedGroupState {
  itemId: string;
  mode: ProcessingMode;
  groupId: string | null;
}

interface BrushDraftState {
  itemId: string;
  state: Recolor3DState;
  activeGroupId: string | null;
}

function buildDuplicateFileName(originalName: string, copyNumber: number): string {
  const dotIdx = originalName.lastIndexOf(".");
  if (dotIdx > 0) {
    return `${originalName.slice(0, dotIdx)}-v${copyNumber}${originalName.slice(dotIdx)}`;
  }
  return `${originalName}-v${copyNumber}`;
}

function prepare3DForImage(
  loaded: LoadedImageResult,
  bgRemovalEnabled: boolean,
  tolerance: number,
): {
  prepared: Prepared3DImage;
  bgResult: BackgroundRemovalResult | null;
} {
  if (bgRemovalEnabled && loaded.kind === "raster") {
    const bgResult = removeCornerBackground(loaded.imageData, { tolerance });
    return {
      prepared: prepare3DImageData(bgResult.imageData),
      bgResult,
    };
  }
  return {
    prepared: prepare3DImageData(loaded.imageData),
    bgResult: null,
  };
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  ) {
    return true;
  }
  return el.isContentEditable;
}

export function SplitterWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filePickModeRef = useRef<"append" | "replace">("append");
  const nextBatchSeqRef = useRef(1);

  const [workspaceMode, setWorkspaceMode] = useState<ProcessingMode>("2d");
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [canvasKeyMap, setCanvasKeyMap] = useState<Record<string, number>>({});
  const [resetTrigger, setResetTrigger] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [dismissedDownscaleNotice, setDismissedDownscaleNotice] =
    useState(false);
  const [dismissedComplexPhotoNotice, setDismissedComplexPhotoNotice] =
    useState(false);

  const [previewMode, setPreviewMode] = useState<CanvasPreviewMode>("live");
  const [mobileTab, setMobileTab] = useState<MobilePanelTab>("groups");
  const [desktopDockMode, setDesktopDockMode] =
    useState<DesktopDockMode>("inspector");

  // Non-destructive 2-stage selection baskets & group-list highlight
  const [tempSelection2D, setTempSelection2D] =
    useState<TempSelection2DState | null>(null);
  const [tempCandidates3D, setTempCandidates3D] =
    useState<TempCandidates3DState | null>(null);
  const [highlightedGroupState, setHighlightedGroupState] =
    useState<HighlightedGroupState | null>(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [canvasTool, setCanvasTool] = useState<Recolor3DTool>("select");
  const [isGlobalColorPickMode, setIsGlobalColorPickMode] = useState(false);
  const [brushMode3D, setBrushMode3D] = useState<BrushMode3D>("smart");
  const [brushRadius3D, setBrushRadius3D] = useState<number>(
    DEFAULT_3D_BRUSH_RADIUS,
  );

  // Live Brush/Eraser transient refs & state for smooth 1-step Undo strokes
  const brushPreStrokeRef = useRef<{
    itemId: string;
    history: Recolor3DHistory;
    selectedGroupId: string | null;
  } | null>(null);
  const brushLatestRef = useRef<BrushDraftState | null>(null);
  const [brushDraft, setBrushDraft] = useState<BrushDraftState | null>(null);

  const showTransientStatus = useCallback((msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((curr) => (curr === msg ? null : curr));
    }, 2600);
  }, []);

  const createBatchItem = useCallback(
    (
      loaded: LoadedImageResult,
      modeOverride?: ProcessingMode,
    ): BatchItem => {
      const id = `item-${nextBatchSeqRef.current++}`;
      const mode = modeOverride ?? workspaceMode;
      const defaultParams: PipelineParameters = {
        bgRemovalEnabled: true,
        tolerance: DEFAULT_BG_TOLERANCE,
        colorCount: DEFAULT_COLOR_COUNT,
      };
      const segmentation = runUnifiedSegmentationPipeline(loaded, defaultParams);
      const history = createGroupingHistory(
        createInitialGrouping(segmentation.regions),
      );
      const thumbnailUrl = createThumbnailDataUrl(loaded.imageData);

      let prepared3D: Prepared3DImage | null = null;
      let bgRemoval3DResult: BackgroundRemovalResult | null = null;
      let history3D: Recolor3DHistory | null = null;
      let cached3DBgParams: {
        bgRemovalEnabled: boolean;
        tolerance: number;
      } | null = null;

      if (mode === "3d") {
        const res3D = prepare3DForImage(
          loaded,
          defaultParams.bgRemovalEnabled,
          defaultParams.tolerance,
        );
        prepared3D = res3D.prepared;
        bgRemoval3DResult = res3D.bgResult;
        cached3DBgParams = {
          bgRemovalEnabled: defaultParams.bgRemovalEnabled,
          tolerance: defaultParams.tolerance,
        };
        history3D = create3DHistory(
          createEmpty3DState(prepared3D.width, prepared3D.height),
        );
      }

      return {
        id,
        processingMode: mode,
        loadedImage: loaded,
        thumbnailUrl,
        bgRemovalEnabled: defaultParams.bgRemovalEnabled,
        tolerance: defaultParams.tolerance,
        colorCount: defaultParams.colorCount,
        rdpEpsilon: DEFAULT_RDP_EPSILON,
        smoothCurves: true,
        cachedParams: defaultParams,
        segmentation,
        history,
        tolerance3D: DEFAULT_3D_TOLERANCE,
        shadowReach3D: DEFAULT_3D_SHADOW_REACH,
        cached3DBgParams,
        prepared3D,
        bgRemoval3DResult,
        history3D,
      };
    },
    [workspaceMode],
  );

  const activeItem = useMemo(
    () =>
      batchItems.find((item) => item.id === activeItemId) ??
      batchItems[0] ??
      null,
    [batchItems, activeItemId],
  );

  const activeMode: ProcessingMode = activeItem
    ? activeItem.processingMode
    : workspaceMode;

  // Deferred pipeline values keep slider dragging smooth on mobile
  const deferredBgEnabled = useDeferredValue(
    activeItem?.bgRemovalEnabled ?? true,
  );
  const deferredTolerance = useDeferredValue(
    activeItem?.tolerance ?? DEFAULT_BG_TOLERANCE,
  );
  const deferredColorCount = useDeferredValue(
    activeItem?.colorCount ?? DEFAULT_COLOR_COUNT,
  );
  const deferredEpsilon = useDeferredValue(
    activeItem?.rdpEpsilon ?? DEFAULT_RDP_EPSILON,
  );

  // Active 2D segmentation (0 ms cache hit for Native SVG or unchanged raster params)
  const liveSegmentation: UnifiedSegmentationResult | null = useMemo(() => {
    if (!activeItem) return null;
    if (activeItem.loadedImage.kind === "native-svg") {
      return activeItem.segmentation;
    }

    const { cachedParams } = activeItem;
    if (
      cachedParams.bgRemovalEnabled === deferredBgEnabled &&
      cachedParams.tolerance === deferredTolerance &&
      cachedParams.colorCount === deferredColorCount
    ) {
      return activeItem.segmentation;
    }

    return runUnifiedSegmentationPipeline(activeItem.loadedImage, {
      bgRemovalEnabled: deferredBgEnabled,
      tolerance: deferredTolerance,
      colorCount: deferredColorCount,
    });
  }, [activeItem, deferredBgEnabled, deferredTolerance, deferredColorCount]);

  // Active 2D grouping history
  const liveHistory: GroupingHistory | null = useMemo(() => {
    if (!activeItem || !liveSegmentation) return null;
    if (liveSegmentation === activeItem.segmentation) {
      return activeItem.history;
    }
    return createGroupingHistory(
      createInitialGrouping(liveSegmentation.regions),
    );
  }, [activeItem, liveSegmentation]);

  const groupingState = liveHistory?.present ?? null;

  // Active Mode 3D Prepared Image + Auto-Split History (live updates on tolerance slider)
  const livePrepared3DBundle = useMemo(() => {
    if (!activeItem || activeItem.processingMode !== "3d") return null;
    const cached = activeItem.cached3DBgParams;
    if (
      activeItem.prepared3D &&
      cached &&
      cached.bgRemovalEnabled === deferredBgEnabled &&
      cached.tolerance === deferredTolerance
    ) {
      return {
        prepared: activeItem.prepared3D,
        bgResult: activeItem.bgRemoval3DResult,
        rebuiltBg: false,
      };
    }
    const res = prepare3DForImage(
      activeItem.loadedImage,
      deferredBgEnabled,
      deferredTolerance,
    );
    return {
      prepared: res.prepared,
      bgResult: res.bgResult,
      rebuiltBg: true,
    };
  }, [activeItem, deferredBgEnabled, deferredTolerance]);

  const livePrepared3D = livePrepared3DBundle?.prepared ?? null;
  const liveBgRemoval3D = livePrepared3DBundle?.bgResult ?? null;

  const liveHistory3D: Recolor3DHistory | null = useMemo(() => {
    if (!activeItem || activeItem.processingMode !== "3d" || !livePrepared3D) {
      return null;
    }
    if (activeItem.history3D && !livePrepared3DBundle?.rebuiltBg) {
      return activeItem.history3D;
    }
    return create3DHistory(
      createEmpty3DState(livePrepared3D.width, livePrepared3D.height),
    );
  }, [activeItem, livePrepared3D, livePrepared3DBundle?.rebuiltBg]);

  const active3DState: Recolor3DState | null = useMemo(() => {
    if (activeItem && brushDraft && brushDraft.itemId === activeItem.id) {
      return brushDraft.state;
    }
    return liveHistory3D?.present ?? null;
  }, [activeItem, brushDraft, liveHistory3D]);

  // Switch Mode 2D / Mode 3D cleanly (Mode 3D starts clean with empty groups like v2.5)
  const handleSwitchMode = useCallback(
    (nextMode: ProcessingMode) => {
      setWorkspaceMode(nextMode);
      setCanvasTool("select");
      setTempSelection2D(null);
      setTempCandidates3D(null);
      setHighlightedGroupState(null);
      setIsMultiSelectMode(false);
      setIsGlobalColorPickMode(false);
      setIsColorPickerOpen(false);
      brushPreStrokeRef.current = null;
      brushLatestRef.current = null;
      setBrushDraft(null);

      if (!activeItem) return;
      if (activeItem.processingMode === nextMode) return;

      setBatchItems((prev) =>
        prev.map((item) => {
          if (item.id !== activeItem.id) return item;
          if (nextMode === "3d" && !item.prepared3D) {
            const res = prepare3DForImage(
              item.loadedImage,
              item.bgRemovalEnabled,
              item.tolerance,
            );
            return {
              ...item,
              processingMode: "3d",
              prepared3D: res.prepared,
              bgRemoval3DResult: res.bgResult,
              cached3DBgParams: {
                bgRemovalEnabled: item.bgRemovalEnabled,
                tolerance: item.tolerance,
              },
              history3D:
                item.history3D ??
                create3DHistory(
                  createEmpty3DState(res.prepared.width, res.prepared.height),
                ),
            };
          }
          return {
            ...item,
            processingMode: nextMode,
          };
        }),
      );

      if (nextMode === "3d" && mobileTab === "quantize") {
        setMobileTab("groups");
      }
    },
    [activeItem, mobileTab],
  );

  const handleRequestAppendFiles = useCallback(() => {
    filePickModeRef.current = "append";
    fileInputRef.current?.click();
  }, []);

  const handleRequestReplaceFile = useCallback(() => {
    filePickModeRef.current = "replace";
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelect = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      setIsLoading(true);
      setErrorMessage(null);
      setDismissedDownscaleNotice(false);
      setDismissedComplexPhotoNotice(false);
      setTempSelection2D(null);
      setTempCandidates3D(null);
      setHighlightedGroupState(null);
      setIsMultiSelectMode(false);
      setIsColorPickerOpen(false);
      setCanvasTool("select");

      try {
        const mode = filePickModeRef.current;
        const currentCount = batchItems.length;

        if (mode === "replace" && activeItem) {
          const loaded = await loadImageFromFile(files[0], MAX_IMAGE_DIMENSION);
          const replacement = createBatchItem(loaded, activeItem.processingMode);

          setBatchItems((prev) =>
            prev.map((item) =>
              item.id === activeItem.id ? replacement : item,
            ),
          );
          setActiveItemId(replacement.id);
          setCanvasKeyMap((prev) => ({
            ...prev,
            [replacement.id]: (prev[replacement.id] ?? 0) + 1,
          }));
          setPreviewMode("live");
          return;
        }

        const availableSlots = MAX_BATCH_FILES - currentCount;
        if (availableSlots <= 0) {
          setErrorMessage(
            `Antrean batch sudah penuh (maksimal ${MAX_BATCH_FILES} desain). Hapus salah satu untuk menambah baru.`,
          );
          return;
        }

        const slice = files.slice(0, availableSlots);
        const created: BatchItem[] = [];
        const failedNames: string[] = [];

        for (const file of slice) {
          try {
            const loaded = await loadImageFromFile(file, MAX_IMAGE_DIMENSION);
            created.push(createBatchItem(loaded, workspaceMode));
          } catch (err) {
            failedNames.push(
              err instanceof Error ? `${file.name}: ${err.message}` : file.name,
            );
          }
        }

        if (created.length > 0) {
          setBatchItems((prev) => [...prev, ...created]);
          const firstNew = created[0];
          setActiveItemId(firstNew.id);
          setCanvasKeyMap((prev) => {
            const next = { ...prev };
            for (const c of created) {
              next[c.id] = 1;
            }
            return next;
          });
          setPreviewMode("live");
        }

        if (files.length > availableSlots) {
          setErrorMessage(
            `Maksimal ${MAX_BATCH_FILES} desain per batch; ${created.length} file berhasil dimuat.`,
          );
        } else if (failedNames.length > 0) {
          setErrorMessage(failedNames[0]);
        }
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Terjadi kesalahan saat membaca file.",
        );
      } finally {
        setIsLoading(false);
        filePickModeRef.current = "append";
      }
    },
    [activeItem, batchItems.length, createBatchItem, workspaceMode],
  );

  const handleLoadSample = useCallback(() => {
    setErrorMessage(null);
    setDismissedDownscaleNotice(false);
    setDismissedComplexPhotoNotice(false);
    setWorkspaceMode("2d");
    setCanvasTool("select");
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setHighlightedGroupState(null);
    setIsMultiSelectMode(false);
    setIsColorPickerOpen(false);

    try {
      const sample = createSampleStickerImage(960);
      const item = createBatchItem({ ...sample, kind: "raster" }, "2d");
      setBatchItems([item]);
      setActiveItemId(item.id);
      setCanvasKeyMap({ [item.id]: 1 });
      setPreviewMode("live");
      setMobileTab("groups");
      setDesktopDockMode("inspector");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Gagal membuat ilustrasi contoh.",
      );
    }
  }, [createBatchItem]);

  const handleLoadSample3D = useCallback(() => {
    setErrorMessage(null);
    setDismissedDownscaleNotice(false);
    setDismissedComplexPhotoNotice(false);
    setWorkspaceMode("3d");
    setCanvasTool("select");
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setHighlightedGroupState(null);
    setIsMultiSelectMode(false);
    setIsColorPickerOpen(false);

    try {
      const sample = createSample3DRenderImage(840);
      const item = createBatchItem({ ...sample, kind: "raster" }, "3d");
      setBatchItems([item]);
      setActiveItemId(item.id);
      setCanvasKeyMap({ [item.id]: 1 });
      setPreviewMode("live");
      setMobileTab("groups");
      setDesktopDockMode("inspector");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Gagal membuat render 3D contoh.",
      );
    }
  }, [createBatchItem]);

  const handleClearWorkspace = useCallback(() => {
    setBatchItems([]);
    setActiveItemId(null);
    setCanvasKeyMap({});
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setHighlightedGroupState(null);
    setIsMultiSelectMode(false);
    setIsGlobalColorPickMode(false);
    setIsColorPickerOpen(false);
    setCanvasTool("select");
    setErrorMessage(null);
    setDismissedDownscaleNotice(false);
    setDismissedComplexPhotoNotice(false);
  }, []);

  const handleResetView = useCallback(() => {
    setResetTrigger((prev) => prev + 1);
  }, []);

  // Commit any pending deferred 2D/3D pipeline computation onto activeItem
  const syncActivePipelinesIntoBatch = useCallback(
    (items: BatchItem[]): BatchItem[] => {
      if (!activeItem) return items;
      const need2DSync =
        liveSegmentation &&
        liveHistory &&
        liveSegmentation !== activeItem.segmentation;
      const need3DSync =
        activeItem.processingMode === "3d" &&
        livePrepared3D &&
        liveHistory3D &&
        (livePrepared3D !== activeItem.prepared3D ||
          liveHistory3D !== activeItem.history3D);

      if (!need2DSync && !need3DSync) return items;

      return items.map((item) => {
        if (item.id !== activeItem.id) return item;
        return {
          ...item,
          ...(need2DSync && liveSegmentation && liveHistory
            ? {
                cachedParams: {
                  bgRemovalEnabled: item.bgRemovalEnabled,
                  tolerance: item.tolerance,
                  colorCount: item.colorCount,
                },
                segmentation: liveSegmentation,
                history: liveHistory,
              }
            : {}),
          ...(need3DSync && livePrepared3D && liveHistory3D
            ? {
                cached3DBgParams: {
                  bgRemovalEnabled: item.bgRemovalEnabled,
                  tolerance: item.tolerance,
                },
                prepared3D: livePrepared3D,
                bgRemoval3DResult: liveBgRemoval3D,
                history3D: liveHistory3D,
              }
            : {}),
        };
      });
    },
    [
      activeItem,
      liveBgRemoval3D,
      liveHistory,
      liveHistory3D,
      livePrepared3D,
      liveSegmentation,
    ],
  );

  const handleSelectBatchItem = useCallback(
    (id: string) => {
      if (id === activeItem?.id) return;
      const target = batchItems.find((i) => i.id === id);
      setBatchItems((prev) => syncActivePipelinesIntoBatch(prev));
      setActiveItemId(id);
      if (target) {
        setWorkspaceMode(target.processingMode);
      }
      setTempSelection2D(null);
      setTempCandidates3D(null);
      setHighlightedGroupState(null);
      setIsMultiSelectMode(false);
      setIsColorPickerOpen(false);
      setCanvasTool("select");
      setIsGlobalColorPickMode(false);
      setErrorMessage(null);
    },
    [activeItem?.id, batchItems, syncActivePipelinesIntoBatch],
  );

  const handleRemoveBatchItem = useCallback(
    (id: string) => {
      setBatchItems((prev) => {
        const remaining = prev.filter((item) => item.id !== id);
        if (activeItem?.id === id) {
          const next = remaining[0] ?? null;
          setActiveItemId(next?.id ?? null);
          if (next) setWorkspaceMode(next.processingMode);
          setTempSelection2D(null);
          setTempCandidates3D(null);
          setHighlightedGroupState(null);
          setIsColorPickerOpen(false);
        }
        return remaining;
      });
    },
    [activeItem?.id],
  );

  const handleDuplicateActive = useCallback(() => {
    if (!activeItem || !liveSegmentation || !liveHistory) return;
    if (batchItems.length >= MAX_BATCH_FILES) {
      setErrorMessage(
        `Antrean penuh (maksimal ${MAX_BATCH_FILES} desain).`,
      );
      return;
    }

    const newId = `item-${nextBatchSeqRef.current++}`;
    const copyName = buildDuplicateFileName(
      activeItem.loadedImage.fileName,
      batchItems.length + 1,
    );

    const clonedItem: BatchItem = {
      ...activeItem,
      id: newId,
      loadedImage: {
        ...activeItem.loadedImage,
        fileName: copyName,
      },
      cachedParams: {
        bgRemovalEnabled: activeItem.bgRemovalEnabled,
        tolerance: activeItem.tolerance,
        colorCount: activeItem.colorCount,
      },
      segmentation: liveSegmentation,
      history: {
        ...liveHistory,
        past: [...liveHistory.past],
        future: [...liveHistory.future],
      },
      prepared3D: livePrepared3D ?? activeItem.prepared3D,
      bgRemoval3DResult: liveBgRemoval3D ?? activeItem.bgRemoval3DResult,
      cached3DBgParams:
        activeItem.processingMode === "3d"
          ? {
              bgRemovalEnabled: activeItem.bgRemovalEnabled,
              tolerance: activeItem.tolerance,
            }
          : activeItem.cached3DBgParams,
      history3D: liveHistory3D
        ? {
            ...liveHistory3D,
            past: [...liveHistory3D.past],
            future: [...liveHistory3D.future],
          }
        : activeItem.history3D,
    };

    setBatchItems((prev) => {
      const synced = syncActivePipelinesIntoBatch(prev);
      const idx = synced.findIndex((i) => i.id === activeItem.id);
      const next = [...synced];
      next.splice(idx >= 0 ? idx + 1 : next.length, 0, clonedItem);
      return next;
    });
    setActiveItemId(newId);
    setCanvasKeyMap((prev) => ({ ...prev, [newId]: 1 }));
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setHighlightedGroupState(null);
  }, [
    activeItem,
    batchItems.length,
    liveBgRemoval3D,
    liveHistory,
    liveHistory3D,
    livePrepared3D,
    liveSegmentation,
    syncActivePipelinesIntoBatch,
  ]);

  const handleSyncPaletteToAll = useCallback(() => {
    if (!activeItem || batchItems.length <= 1) return;

    let sourceHexes: string[] = [];
    if (activeItem.processingMode === "3d" && active3DState) {
      sourceHexes = [...active3DState.groups]
        .sort((a, b) => b.pixelCount - a.pixelCount)
        .map((g) => g.targetHex);
    } else if (liveHistory) {
      sourceHexes = [...liveHistory.present.groups]
        .sort((a, b) => b.totalPixels - a.totalPixels)
        .map((g) => g.colorHex);
    }

    if (sourceHexes.length === 0) {
      showTransientStatus("Belum ada warna grup untuk disalin.");
      return;
    }

    setBatchItems((prev) =>
      syncActivePipelinesIntoBatch(prev).map((item) => {
        if (item.id === activeItem.id) return item;
        if (item.processingMode === "3d" && item.history3D) {
          const next3D = applyPaletteTo3DState(
            item.history3D.present,
            sourceHexes,
          );
          return {
            ...item,
            history3D: commit3DChange(item.history3D, next3D),
          };
        }
        const nextPresent = applyPaletteToGrouping(
          item.history.present,
          sourceHexes,
        );
        return {
          ...item,
          history: commitGroupingChange(item.history, nextPresent),
        };
      }),
    );

    showTransientStatus(`Palet disalin ke ${batchItems.length - 1} desain`);
  }, [
    active3DState,
    activeItem,
    batchItems.length,
    liveHistory,
    showTransientStatus,
    syncActivePipelinesIntoBatch,
  ]);

  const updateActiveItemFields = useCallback(
    (patch: Partial<BatchItem>) => {
      if (!activeItem) return;
      setBatchItems((prev) =>
        prev.map((item) =>
          item.id === activeItem.id ? { ...item, ...patch } : item,
        ),
      );
    },
    [activeItem],
  );

  const applyActiveHistoryUpdate = useCallback(
    (updater: (current: GroupingHistory) => GroupingHistory) => {
      if (!activeItem || !liveSegmentation || !liveHistory) return;
      const nextHistory = updater(liveHistory);
      const nextParams: PipelineParameters = {
        bgRemovalEnabled: activeItem.bgRemovalEnabled,
        tolerance: activeItem.tolerance,
        colorCount: activeItem.colorCount,
      };

      setBatchItems((prev) =>
        prev.map((item) =>
          item.id === activeItem.id
            ? {
                ...item,
                cachedParams: nextParams,
                segmentation: liveSegmentation,
                history: nextHistory,
              }
            : item,
        ),
      );
    },
    [activeItem, liveHistory, liveSegmentation],
  );

  const applyActive3DHistoryUpdate = useCallback(
    (updater: (current: Recolor3DHistory) => Recolor3DHistory) => {
      if (!activeItem || !livePrepared3D || !liveHistory3D) return;
      const nextHistory3D = updater(liveHistory3D);

      setBatchItems((prev) =>
        prev.map((item) =>
          item.id === activeItem.id
            ? {
                ...item,
                cached3DBgParams: {
                  bgRemovalEnabled: activeItem.bgRemovalEnabled,
                  tolerance: activeItem.tolerance,
                },
                prepared3D: livePrepared3D,
                bgRemoval3DResult: liveBgRemoval3D,
                history3D: nextHistory3D,
              }
            : item,
        ),
      );
    },
    [activeItem, liveBgRemoval3D, liveHistory3D, livePrepared3D],
  );

  // Derived validated temporary selection IDs (Mode 2D regions)
  const resolvedSelectedIds2D: number[] = useMemo(() => {
    if (
      activeMode !== "2d" ||
      !activeItem ||
      !tempSelection2D ||
      tempSelection2D.itemId !== activeItem.id ||
      !liveSegmentation ||
      !groupingState ||
      tempSelection2D.segmentation !== liveSegmentation
    ) {
      return [];
    }
    return tempSelection2D.ids.filter((id) =>
      Boolean(groupingState.regionToGroup[id]),
    );
  }, [activeItem, activeMode, groupingState, liveSegmentation, tempSelection2D]);

  // Derived validated temporary flood-fill/group candidates (Mode 3D Multi-Select)
  const resolvedCandidates3D: CandidateSelection3D[] = useMemo(() => {
    if (
      activeMode !== "3d" ||
      !activeItem ||
      !tempCandidates3D ||
      tempCandidates3D.itemId !== activeItem.id ||
      !livePrepared3D ||
      tempCandidates3D.prepared !== livePrepared3D
    ) {
      return [];
    }
    if (!active3DState) {
      return tempCandidates3D.candidates;
    }
    return tempCandidates3D.candidates.filter((c) => {
      if (c.kind === "flood") return c.pixelIndices.length > 0;
      return (
        c.existingGroupId !== null &&
        Boolean(active3DState.groupToMaskId[c.existingGroupId])
      );
    });
  }, [active3DState, activeItem, activeMode, livePrepared3D, tempCandidates3D]);

  // Derived validated highlighted group from Daftar Grup Warna
  const resolvedHighlightedGroupId: string | null = useMemo(() => {
    if (!activeItem) return null;
    if (
      activeMode === "3d" &&
      brushDraft &&
      brushDraft.itemId === activeItem.id &&
      brushDraft.activeGroupId &&
      active3DState?.groups.some((g) => g.groupId === brushDraft.activeGroupId)
    ) {
      return brushDraft.activeGroupId;
    }

    if (
      !highlightedGroupState ||
      highlightedGroupState.itemId !== activeItem.id ||
      highlightedGroupState.mode !== activeMode ||
      !highlightedGroupState.groupId
    ) {
      return null;
    }

    if (activeMode === "2d") {
      return groupingState?.groups.some(
        (g) => g.groupId === highlightedGroupState.groupId,
      )
        ? highlightedGroupState.groupId
        : null;
    }

    return active3DState?.groups.some(
      (g) => g.groupId === highlightedGroupState.groupId,
    )
      ? highlightedGroupState.groupId
      : null;
  }, [
    active3DState,
    activeItem,
    activeMode,
    brushDraft,
    groupingState,
    highlightedGroupState,
  ]);

  // Single selected region (for Mode 2D companion inspector card)
  const selectedSingleRegion: RegionInfo | null = useMemo(() => {
    if (
      activeMode !== "2d" ||
      !liveSegmentation ||
      resolvedSelectedIds2D.length !== 1
    ) {
      return null;
    }
    return liveSegmentation.regions[resolvedSelectedIds2D[0] - 1] ?? null;
  }, [activeMode, liveSegmentation, resolvedSelectedIds2D]);

  const active2DGroup = useMemo(() => {
    if (activeMode !== "2d" || !groupingState) return null;
    const gid =
      resolvedHighlightedGroupId ??
      (resolvedSelectedIds2D.length === 1
        ? groupingState.regionToGroup[resolvedSelectedIds2D[0]] ?? null
        : null);
    if (!gid) return null;
    return groupingState.groups.find((g) => g.groupId === gid) ?? null;
  }, [activeMode, groupingState, resolvedHighlightedGroupId, resolvedSelectedIds2D]);

  const active3DGroup = useMemo(() => {
    if (activeMode !== "3d" || !active3DState) return null;
    if (resolvedHighlightedGroupId) {
      return (
        active3DState.groups.find(
          (g) => g.groupId === resolvedHighlightedGroupId,
        ) ?? null
      );
    }
    return null;
  }, [active3DState, activeMode, resolvedHighlightedGroupId]);

  // Validation for Merge & Split buttons on Floating Selection Bar
  const selectionCapabilities = useMemo(() => {
    if (activeMode === "2d" && groupingState) {
      if (resolvedSelectedIds2D.length === 0) {
        return { canMerge: false, canSplit: false };
      }

      const distinctGroups = new Set(
        resolvedSelectedIds2D.map((id) => groupingState.regionToGroup[id]),
      );
      const canMerge =
        distinctGroups.size > 1 ||
        (resolvedSelectedIds2D.length === 1 &&
          resolvedHighlightedGroupId !== null &&
          groupingState.regionToGroup[resolvedSelectedIds2D[0]] !==
            resolvedHighlightedGroupId);

      let isAlreadyFullSingleGroup = false;
      if (distinctGroups.size === 1) {
        const onlyGid = Array.from(distinctGroups)[0];
        const grp = groupingState.groups.find((g) => g.groupId === onlyGid);
        if (grp && grp.regionIds.length === resolvedSelectedIds2D.length) {
          isAlreadyFullSingleGroup = true;
        }
      }

      return { canMerge, canSplit: !isAlreadyFullSingleGroup };
    }

    if (activeMode === "3d") {
      if (resolvedCandidates3D.length === 0) {
        return { canMerge: false, canSplit: false };
      }
      const isSingleExistingGroupOnly =
        resolvedCandidates3D.length === 1 &&
        resolvedCandidates3D[0].kind === "group";
      return {
        canMerge: !isSingleExistingGroupOnly,
        canSplit: false,
      };
    }

    return { canMerge: false, canSplit: false };
  }, [
    activeMode,
    groupingState,
    resolvedCandidates3D,
    resolvedHighlightedGroupId,
    resolvedSelectedIds2D,
  ]);

  // Canvas preview ImageData (highlights temporary selection OR highlighted group)
  const activeCanvasImageData: ImageData | null = useMemo(() => {
    if (!activeItem) return null;

    if (activeItem.processingMode === "3d") {
      if (!livePrepared3D || !active3DState) return null;
      return render3DCanvasImageData({
        prepared: livePrepared3D,
        state: active3DState,
        mode: previewMode,
        selectedGroupId: resolvedHighlightedGroupId,
        candidates: resolvedCandidates3D,
      });
    }

    if (!liveSegmentation || !groupingState) return null;
    return renderGroupedCanvasImageData({
      regionMap: liveSegmentation.regionMap,
      width: liveSegmentation.width,
      height: liveSegmentation.height,
      regions: liveSegmentation.regions,
      groupingState,
      mode: previewMode,
      selectedRegionIds: resolvedSelectedIds2D,
      selectedGroupId: resolvedHighlightedGroupId,
    });
  }, [
    active3DState,
    activeItem,
    groupingState,
    livePrepared3D,
    liveSegmentation,
    previewMode,
    resolvedCandidates3D,
    resolvedHighlightedGroupId,
    resolvedSelectedIds2D,
  ]);

  const shouldBuildExport =
    mobileTab === "export" || desktopDockMode === "export";

  const exportResult: CanvaSvgExportResult | null = useMemo(() => {
    if (
      !shouldBuildExport ||
      !activeItem ||
      activeItem.processingMode !== "2d" ||
      !liveSegmentation ||
      !groupingState
    ) {
      return null;
    }

    return buildCanvaSvgExport({
      regionMap: liveSegmentation.regionMap,
      width: liveSegmentation.width,
      height: liveSegmentation.height,
      groupingState,
      baseFileName: activeItem.loadedImage.fileName,
      epsilon: deferredEpsilon,
      smoothCurves: activeItem.smoothCurves,
      nativeSvg: activeItem.loadedImage.nativeSvg,
    });
  }, [
    shouldBuildExport,
    activeItem,
    liveSegmentation,
    groupingState,
    deferredEpsilon,
  ]);

  const handleUndo = useCallback(() => {
    setTempSelection2D(null);
    setTempCandidates3D(null);
    if (activeMode === "3d") {
      applyActive3DHistoryUpdate(undo3D);
    } else {
      applyActiveHistoryUpdate(undoGrouping);
    }
  }, [activeMode, applyActive3DHistoryUpdate, applyActiveHistoryUpdate]);

  const handleRedo = useCallback(() => {
    setTempSelection2D(null);
    setTempCandidates3D(null);
    if (activeMode === "3d") {
      applyActive3DHistoryUpdate(redo3D);
    } else {
      applyActiveHistoryUpdate(redoGrouping);
    }
  }, [activeMode, applyActive3DHistoryUpdate, applyActiveHistoryUpdate]);

  // Stage 1 (Mode 2D): Non-destructive temporary tap/click selection
  const handleSelectRegion = useCallback(
    (regionId: number | null, multiSelectModifier: boolean = false) => {
      if (!activeItem || !liveSegmentation || !groupingState) return;
      const isToggle = isMultiSelectMode || multiSelectModifier;

      if (regionId === null) {
        if (!isToggle) {
          setTempSelection2D(null);
        }
        return;
      }

      if (!groupingState.regionToGroup[regionId]) return;

      setHighlightedGroupState(null);
      setTempSelection2D((prev) => {
        const currentIds =
          prev &&
          prev.itemId === activeItem.id &&
          prev.segmentation === liveSegmentation
            ? prev.ids
            : [];

        const nextIds = isToggle
          ? currentIds.includes(regionId)
            ? currentIds.filter((id) => id !== regionId)
            : [...currentIds, regionId]
          : [regionId];

        return {
          itemId: activeItem.id,
          segmentation: liveSegmentation,
          ids: nextIds,
        };
      });
      setMobileTab("groups");
      setDesktopDockMode("inspector");
    },
    [activeItem, groupingState, isMultiSelectMode, liveSegmentation],
  );

  // Stage 1 (Mode 3D):
  // - Single-tap (default): immediate v2.5 floodFillSelect3D or highlight existing group
  // - Multi-select (Ctrl/Cmd+Click or Pilih Banyak active): collect flood-fill candidates cleanly
  const handleTapCanvasPoint3D = useCallback(
    (x: number, y: number, multiSelectModifier: boolean = false) => {
      if (!activeItem || !livePrepared3D || !liveHistory3D || !active3DState) {
        return;
      }

      if (isGlobalColorPickMode) {
        const res = selectGlobalSimilar3D(
          livePrepared3D,
          x,
          y,
          activeItem.tolerance3D,
          liveHistory3D.present,
        );
        setIsGlobalColorPickMode(false);
        setTempCandidates3D(null);
        if (!res.groupId) {
          showTransientStatus("Ketuk pada bagian objek 3D yang terlihat.");
          return;
        }
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(history3D, res.state),
        );
        setHighlightedGroupState({
          itemId: activeItem.id,
          mode: "3d",
          groupId: res.groupId,
        });
        setIsColorPickerOpen(true);
        setMobileTab("groups");
        setDesktopDockMode("inspector");
        setPreviewMode("live");
        showTransientStatus(
          `Semua warna serupa terpilih (${res.pixelCount.toLocaleString("id-ID")} px)`,
        );
        return;
      }

      const isToggle = isMultiSelectMode || multiSelectModifier;

      if (isToggle) {
        setHighlightedGroupState(null);
        setIsColorPickerOpen(false);
        setTempCandidates3D((prev) => {
          const base =
            prev &&
            prev.itemId === activeItem.id &&
            prev.prepared === livePrepared3D
              ? prev
              : {
                  itemId: activeItem.id,
                  prepared: livePrepared3D,
                  nextCandidateSeq: 1,
                  candidates: [],
                };

          const toggled = toggleCandidatePoint3D({
            state: active3DState,
            prepared: livePrepared3D,
            candidates: base.candidates,
            seedX: x,
            seedY: y,
            tolerance: activeItem.tolerance3D,
            shadowReach: activeItem.shadowReach3D,
            nextCandidateSeq: base.nextCandidateSeq,
          });

          if (toggled.candidates.length === 0) {
            return null;
          }

          return {
            itemId: activeItem.id,
            prepared: livePrepared3D,
            nextCandidateSeq: toggled.nextCandidateSeq,
            candidates: toggled.candidates,
          };
        });
        setMobileTab("groups");
        setDesktopDockMode("inspector");
        return;
      }

      // Default Mode 3D tap (Pilih Banyak OFF): check if hitting existing group or run floodFillSelect3D
      setTempCandidates3D(null);
      const hitGroupId = findGroupAtPixel3D(liveHistory3D.present, x, y);
      if (hitGroupId) {
        const grp = liveHistory3D.present.groups.find(
          (g) => g.groupId === hitGroupId,
        );
        setHighlightedGroupState({
          itemId: activeItem.id,
          mode: "3d",
          groupId: hitGroupId,
        });
        if (grp) {
          updateActiveItemFields({
            tolerance3D: grp.tolerance,
            shadowReach3D: grp.shadowReach,
          });
        }
        setIsColorPickerOpen(true);
        setMobileTab("groups");
        setDesktopDockMode("inspector");
        return;
      }

      const res = floodFillSelect3D({
        state: liveHistory3D.present,
        prepared: livePrepared3D,
        seedX: x,
        seedY: y,
        tolerance: activeItem.tolerance3D,
        shadowReach: activeItem.shadowReach3D,
      });

      if (!res.groupId) {
        setHighlightedGroupState(null);
        setIsColorPickerOpen(false);
        return;
      }

      applyActive3DHistoryUpdate((history3D) =>
        commit3DChange(history3D, res.state),
      );
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "3d",
        groupId: res.groupId,
      });
      setIsColorPickerOpen(true);
      setMobileTab("groups");
      setDesktopDockMode("inspector");
      setPreviewMode("live");
    },
    [
      active3DState,
      activeItem,
      applyActive3DHistoryUpdate,
      isGlobalColorPickMode,
      isMultiSelectMode,
      liveHistory3D,
      livePrepared3D,
      showTransientStatus,
      updateActiveItemFields,
    ],
  );

  // Stage 2 Confirm: Merge temporary selection/candidates into 1 single group (Undoable)
  const handleMergeSelection = useCallback(() => {
    if (!activeItem) return;

    if (
      activeMode === "2d" &&
      resolvedSelectedIds2D.length > 0 &&
      liveHistory &&
      groupingState
    ) {
      const firstGroupId =
        groupingState.regionToGroup[resolvedSelectedIds2D[0]];
      const targetGroupId =
        resolvedHighlightedGroupId &&
        resolvedSelectedIds2D.length === 1 &&
        resolvedHighlightedGroupId !== firstGroupId
          ? resolvedHighlightedGroupId
          : firstGroupId;

      const nextState = mergeSelectedRegions(
        liveHistory.present,
        resolvedSelectedIds2D,
        targetGroupId,
      );
      if (nextState === liveHistory.present) {
        showTransientStatus(
          "Pilih ≥ 2 bagian dari grup berbeda untuk digabung.",
        );
        return;
      }

      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(history, nextState),
      );
      setTempSelection2D(null);
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "2d",
        groupId: targetGroupId,
      });
      setPreviewMode("live");
      showTransientStatus(
        `${resolvedSelectedIds2D.length} bagian digabung ke 1 grup.`,
      );
      return;
    }

    if (
      activeMode === "3d" &&
      resolvedCandidates3D.length > 0 &&
      liveHistory3D &&
      livePrepared3D
    ) {
      const committed = commitCandidateSelection3D({
        state: liveHistory3D.present,
        prepared: livePrepared3D,
        candidates: resolvedCandidates3D,
      });

      if (!committed.groupId || committed.state === liveHistory3D.present) {
        showTransientStatus(
          "Pilih beberapa bagian 3D terlebih dahulu untuk digabung.",
        );
        return;
      }

      applyActive3DHistoryUpdate((history3D) =>
        commit3DChange(history3D, committed.state),
      );
      const countMerged = resolvedCandidates3D.length;
      setTempCandidates3D(null);
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "3d",
        groupId: committed.groupId,
      });
      setIsColorPickerOpen(true);
      setPreviewMode("live");
      showTransientStatus(`${countMerged} bagian 3D digabung menjadi 1 grup.`);
    }
  }, [
    activeItem,
    activeMode,
    applyActive3DHistoryUpdate,
    applyActiveHistoryUpdate,
    groupingState,
    liveHistory,
    liveHistory3D,
    livePrepared3D,
    resolvedCandidates3D,
    resolvedHighlightedGroupId,
    resolvedSelectedIds2D,
    showTransientStatus,
  ]);

  // Stage 2 Confirm (Mode 2D): Split temporary selectedIds out into a brand-new group
  const handleSplitSelection = useCallback(() => {
    if (
      activeMode !== "2d" ||
      !activeItem ||
      resolvedSelectedIds2D.length === 0 ||
      !liveHistory
    ) {
      return;
    }

    const expectedNewGroupId = `group-${liveHistory.present.nextGroupSeq}`;
    const nextState = splitSelectedRegionsToNewGroup(
      liveHistory.present,
      resolvedSelectedIds2D,
    );
    if (nextState === liveHistory.present) {
      showTransientStatus("Bagian terpilih sudah menjadi grup tersendiri.");
      return;
    }

    applyActiveHistoryUpdate((history) =>
      commitGroupingChange(history, nextState),
    );
    setTempSelection2D(null);
    setHighlightedGroupState({
      itemId: activeItem.id,
      mode: "2d",
      groupId: expectedNewGroupId,
    });
    setIsColorPickerOpen(true);
    setPreviewMode("live");
    showTransientStatus(
      `${resolvedSelectedIds2D.length} bagian dipisah menjadi grup baru.`,
    );
  }, [
    activeItem,
    activeMode,
    applyActiveHistoryUpdate,
    liveHistory,
    resolvedSelectedIds2D,
    showTransientStatus,
  ]);

  const handleClearTempSelection = useCallback(() => {
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setIsGlobalColorPickMode(false);
    if (canvasTool === "eyedropper") {
      setCanvasTool("select");
    }
  }, [canvasTool]);

  const hasTempSelectionCount =
    activeMode === "3d"
      ? resolvedCandidates3D.length
      : resolvedSelectedIds2D.length;

  // Global keyboard shortcuts (disabled automatically while typing in inputs/textareas)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const hasMod = event.ctrlKey || event.metaKey;

      if (hasMod && key === "z" && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
        return;
      }
      if ((hasMod && key === "z" && event.shiftKey) || (hasMod && key === "y")) {
        event.preventDefault();
        handleRedo();
        return;
      }

      if (key === "escape") {
        if (
          hasTempSelectionCount > 0 ||
          isGlobalColorPickMode ||
          canvasTool === "eyedropper"
        ) {
          event.preventDefault();
          handleClearTempSelection();
        }
        return;
      }

      if (hasTempSelectionCount > 0) {
        if (hasMod && key === "g") {
          event.preventDefault();
          handleMergeSelection();
          return;
        }
        if (activeMode === "2d" && event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          handleSplitSelection();
          return;
        }
        if (event.key === "Enter" && !hasMod && !event.shiftKey) {
          event.preventDefault();
          handleMergeSelection();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeMode,
    canvasTool,
    handleClearTempSelection,
    handleMergeSelection,
    handleRedo,
    handleSplitSelection,
    handleUndo,
    hasTempSelectionCount,
    isGlobalColorPickMode,
  ]);

  // Tap-to-Select Group Card in Daftar Grup Warna (highlights all members on canvas)
  const handleSelectGroup = useCallback(
    (groupId: string) => {
      if (!activeItem) return;
      setTempSelection2D(null);
      setTempCandidates3D(null);
      setHighlightedGroupState((prev) => {
        const isSame =
          prev?.itemId === activeItem.id &&
          prev.mode === activeMode &&
          prev.groupId === groupId;
        if (isSame) {
          setIsColorPickerOpen(false);
          return { itemId: activeItem.id, mode: activeMode, groupId: null };
        }
        if (activeMode === "3d" && active3DState) {
          const grp = active3DState.groups.find((g) => g.groupId === groupId);
          if (grp) {
            updateActiveItemFields({
              tolerance3D: grp.tolerance,
              shadowReach3D: grp.shadowReach,
            });
          }
        }
        return { itemId: activeItem.id, mode: activeMode, groupId };
      });
    },
    [active3DState, activeItem, activeMode, updateActiveItemFields],
  );

  // Tapping Swatch opens Inline Color Picker directly for that group
  const handleFocusGroupColor = useCallback(
    (groupId: string) => {
      if (!activeItem) return;
      setTempSelection2D(null);
      setTempCandidates3D(null);
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: activeMode,
        groupId,
      });
      if (activeMode === "3d" && active3DState) {
        const grp = active3DState.groups.find((g) => g.groupId === groupId);
        if (grp) {
          updateActiveItemFields({
            tolerance3D: grp.tolerance,
            shadowReach3D: grp.shadowReach,
          });
        }
      }
      setIsColorPickerOpen(true);
      setMobileTab("groups");
      setDesktopDockMode("inspector");
    },
    [active3DState, activeItem, activeMode, updateActiveItemFields],
  );

  const handleRenameActiveModeGroup = useCallback(
    (groupId: string, newName: string) => {
      if (activeMode === "3d") {
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(
            history3D,
            renameGroup3D(history3D.present, groupId, newName),
          ),
        );
      } else {
        applyActiveHistoryUpdate((history) =>
          commitGroupingChange(
            history,
            renameGroup(history.present, groupId, newName),
          ),
        );
      }
    },
    [activeMode, applyActive3DHistoryUpdate, applyActiveHistoryUpdate],
  );

  const handleSplitSingleRegion = useCallback(
    (regionId: number) => {
      if (!activeItem || !liveHistory) return;
      const expectedNewGroupId = `group-${liveHistory.present.nextGroupSeq}`;
      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          splitRegionToNewGroup(history.present, regionId),
        ),
      );
      setTempSelection2D(null);
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "2d",
        groupId: expectedNewGroupId,
      });
      setPreviewMode("live");
    },
    [activeItem, applyActiveHistoryUpdate, liveHistory],
  );

  const handleAssignToGroup = useCallback(
    (regionId: number, targetGroupId: string) => {
      if (!activeItem) return;
      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          assignRegionToGroup(history.present, regionId, targetGroupId),
        ),
      );
      setTempSelection2D(null);
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "2d",
        groupId: targetGroupId,
      });
      setPreviewMode("live");
    },
    [activeItem, applyActiveHistoryUpdate],
  );

  const handleChangeGroupColor = useCallback(
    (groupId: string, newHex: string, coalesce: boolean = false) => {
      if (activeMode === "3d") {
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(
            history3D,
            updateGroupColor3D(history3D.present, groupId, newHex),
            coalesce ? `color3d-${groupId}` : undefined,
          ),
        );
      } else {
        applyActiveHistoryUpdate((history) =>
          commitGroupingChange(
            history,
            updateGroupColor(history.present, groupId, newHex),
            coalesce ? `color-${groupId}` : undefined,
          ),
        );
      }
      setPreviewMode("live");
    },
    [activeMode, applyActive3DHistoryUpdate, applyActiveHistoryUpdate],
  );

  const handleMergeGroups = useCallback(
    (sourceGroupId: string, targetGroupId: string) => {
      if (!activeItem) return;
      setTempSelection2D(null);
      setTempCandidates3D(null);

      if (activeItem.processingMode === "3d") {
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(
            history3D,
            mergeGroups3D(
              history3D.present,
              sourceGroupId,
              targetGroupId,
              livePrepared3D ?? undefined,
            ),
          ),
        );
        setHighlightedGroupState({
          itemId: activeItem.id,
          mode: "3d",
          groupId: targetGroupId,
        });
        setPreviewMode("live");
        return;
      }

      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          mergeGroups(history.present, sourceGroupId, targetGroupId),
        ),
      );
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "2d",
        groupId: targetGroupId,
      });
      setPreviewMode("live");
    },
    [
      activeItem,
      applyActive3DHistoryUpdate,
      applyActiveHistoryUpdate,
      livePrepared3D,
    ],
  );

  const handleDelete3DGroup = useCallback(
    (groupId: string) => {
      if (!activeItem) return;
      applyActive3DHistoryUpdate((history3D) =>
        commit3DChange(history3D, deleteGroup3D(history3D.present, groupId)),
      );
      setTempCandidates3D(null);
      if (resolvedHighlightedGroupId === groupId) {
        setHighlightedGroupState({
          itemId: activeItem.id,
          mode: "3d",
          groupId: null,
        });
        setIsColorPickerOpen(false);
      }
    },
    [activeItem, applyActive3DHistoryUpdate, resolvedHighlightedGroupId],
  );

  const handleResetGrouping = useCallback(() => {
    if (!activeItem) return;
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setHighlightedGroupState(null);
    setIsColorPickerOpen(false);

    if (activeItem.processingMode === "3d" && livePrepared3D) {
      applyActive3DHistoryUpdate((history3D) =>
        commit3DChange(
          history3D,
          createEmpty3DState(livePrepared3D.width, livePrepared3D.height),
        ),
      );
      return;
    }

    applyActiveHistoryUpdate((history) =>
      commitGroupingChange(history, resetGrouping(history.present)),
    );
  }, [
    activeItem,
    applyActive3DHistoryUpdate,
    applyActiveHistoryUpdate,
    livePrepared3D,
  ]);

  const handleAutoCompactToFive = useCallback(() => {
    if (!activeItem) return;
    applyActiveHistoryUpdate((history) =>
      commitGroupingChange(history, autoCompactToFiveColors(history.present)),
    );
    setTempSelection2D(null);
    setHighlightedGroupState(null);
    setPreviewMode("live");
  }, [activeItem, applyActiveHistoryUpdate]);

  // Trigger Global Color Range ("Semua Warna Serupa") in Mode 3D
  const handleTriggerGlobalSimilar = useCallback(() => {
    if (!activeItem || !livePrepared3D || !liveHistory3D) return;

    if (isGlobalColorPickMode) {
      setIsGlobalColorPickMode(false);
      return;
    }

    if (
      active3DGroup &&
      active3DGroup.lastSeedIndex !== null &&
      active3DGroup.selectionKind !== "global"
    ) {
      const sx = active3DGroup.lastSeedIndex % livePrepared3D.width;
      const sy = Math.floor(active3DGroup.lastSeedIndex / livePrepared3D.width);
      const res = selectGlobalSimilar3D(
        livePrepared3D,
        sx,
        sy,
        activeItem.tolerance3D,
        liveHistory3D.present,
        active3DGroup.groupId,
      );
      if (res.pixelCount > 0) {
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(history3D, res.state),
        );
        setTempCandidates3D(null);
        setHighlightedGroupState({
          itemId: activeItem.id,
          mode: "3d",
          groupId: active3DGroup.groupId,
        });
        setPreviewMode("live");
        showTransientStatus(
          `${active3DGroup.name} diperluas ke semua warna serupa (${res.pixelCount.toLocaleString("id-ID")} px)`,
        );
        return;
      }
    }

    setCanvasTool("select");
    setTempCandidates3D(null);
    setIsGlobalColorPickMode(true);
    showTransientStatus(
      "Ketuk warna pada kanvas untuk pilih semua warna serupa.",
    );
  }, [
    active3DGroup,
    activeItem,
    applyActive3DHistoryUpdate,
    isGlobalColorPickMode,
    liveHistory3D,
    livePrepared3D,
    showTransientStatus,
  ]);

  // Mode 3D Hue Tolerance Slider (5-60): adjusts Hue/Chroma bounds on active group only
  const handleChange3DTolerance = useCallback(
    (nextTol: number) => {
      if (!activeItem) return;
      updateActiveItemFields({ tolerance3D: nextTol });

      if (
        activeItem.processingMode !== "3d" ||
        !livePrepared3D ||
        !liveHistory3D ||
        !active3DGroup
      ) {
        return;
      }

      const canRecompute =
        active3DGroup.lastSeedIndex !== null ||
        active3DGroup.seedIndices.length > 0;
      if (!canRecompute) return;

      const recomputed = recomputeGroupTolerance3D(
        liveHistory3D.present,
        livePrepared3D,
        active3DGroup.groupId,
        nextTol,
        active3DGroup.shadowReach,
      );
      if (recomputed !== liveHistory3D.present) {
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(
            history3D,
            recomputed,
            `tol3d-${active3DGroup.groupId}`,
          ),
        );
      }
    },
    [
      active3DGroup,
      activeItem,
      applyActive3DHistoryUpdate,
      liveHistory3D,
      livePrepared3D,
      updateActiveItemFields,
    ],
  );

  // Mode 3D Shadow Reach Slider (0-100): expands darker adjacent shadow folds on active group
  const handleChange3DShadowReach = useCallback(
    (nextShadowReach: number) => {
      if (!activeItem) return;
      updateActiveItemFields({ shadowReach3D: nextShadowReach });

      if (
        activeItem.processingMode !== "3d" ||
        !livePrepared3D ||
        !liveHistory3D ||
        !active3DGroup
      ) {
        return;
      }

      const canRecompute =
        active3DGroup.lastSeedIndex !== null ||
        active3DGroup.seedIndices.length > 0;
      if (!canRecompute) return;

      const recomputed = recomputeGroupTolerance3D(
        liveHistory3D.present,
        livePrepared3D,
        active3DGroup.groupId,
        active3DGroup.tolerance,
        nextShadowReach,
      );
      if (recomputed !== liveHistory3D.present) {
        applyActive3DHistoryUpdate((history3D) =>
          commit3DChange(
            history3D,
            recomputed,
            `shadow3d-${active3DGroup.groupId}`,
          ),
        );
      }
    },
    [
      active3DGroup,
      activeItem,
      applyActive3DHistoryUpdate,
      liveHistory3D,
      livePrepared3D,
      updateActiveItemFields,
    ],
  );

  // Mode 3D Brush & Eraser Continuous Stroke Handlers (1 Undo step per stroke)
  const handleBrushStart3D = useCallback(() => {
    if (!activeItem || !liveHistory3D) return;
    const targetId = active3DGroup?.groupId ?? null;
    brushPreStrokeRef.current = {
      itemId: activeItem.id,
      history: liveHistory3D,
      selectedGroupId: targetId,
    };
    const draft: BrushDraftState = {
      itemId: activeItem.id,
      state: liveHistory3D.present,
      activeGroupId: targetId,
    };
    brushLatestRef.current = draft;
    setBrushDraft(draft);
  }, [active3DGroup?.groupId, activeItem, liveHistory3D]);

  const handleBrushSegment3D = useCallback(
    (points: Point2D[], mode: "brush" | "eraser") => {
      if (!activeItem || !livePrepared3D) return;
      const base =
        brushLatestRef.current && brushLatestRef.current.itemId === activeItem.id
          ? brushLatestRef.current
          : null;
      if (!base) return;

      const applied = applyBrushStroke3D({
        state: base.state,
        prepared: livePrepared3D,
        groupId: base.activeGroupId,
        mode,
        points,
        radius: brushRadius3D,
        brushMode: brushMode3D,
        tolerance: activeItem.tolerance3D,
        shadowReach: activeItem.shadowReach3D,
      });

      const nextDraft: BrushDraftState = {
        itemId: activeItem.id,
        state: applied.state,
        activeGroupId: applied.activeGroupId,
      };
      brushLatestRef.current = nextDraft;
      setBrushDraft(nextDraft);
    },
    [activeItem, brushMode3D, brushRadius3D, livePrepared3D],
  );

  const handleBrushEnd3D = useCallback(() => {
    const pre = brushPreStrokeRef.current;
    const latest = brushLatestRef.current;
    brushPreStrokeRef.current = null;
    brushLatestRef.current = null;
    setBrushDraft(null);

    if (!activeItem || !pre || !latest || pre.itemId !== activeItem.id) {
      return;
    }

    if (latest.state !== pre.history.present) {
      applyActive3DHistoryUpdate(() =>
        commit3DChange(pre.history, latest.state),
      );
      setHighlightedGroupState({
        itemId: activeItem.id,
        mode: "3d",
        groupId: latest.activeGroupId,
      });
    }
  }, [activeItem, applyActive3DHistoryUpdate]);

  // Eyedropper (Pipet) Target Resolution & Pick
  const eyedropperTarget = useMemo(() => {
    if (activeMode === "3d") {
      if (!active3DState || active3DState.groups.length === 0) return null;
      const grp = active3DGroup ?? active3DState.groups[0];
      return { groupId: grp.groupId, name: grp.name };
    }
    if (!groupingState || groupingState.groups.length === 0) return null;
    const grp = active2DGroup ?? groupingState.groups[0];
    return { groupId: grp.groupId, name: grp.name };
  }, [
    active2DGroup,
    active3DGroup,
    active3DState,
    activeMode,
    groupingState,
  ]);

  const handleToggleEyedropper = useCallback(() => {
    if (canvasTool === "eyedropper") {
      setCanvasTool("select");
      return;
    }
    if (
      activeMode === "3d" &&
      (!active3DState || active3DState.groups.length === 0)
    ) {
      showTransientStatus("Belum ada grup 3D aktif untuk diwarnai.");
      return;
    }
    setIsGlobalColorPickMode(false);
    setCanvasTool("eyedropper");
  }, [active3DState, activeMode, canvasTool, showTransientStatus]);

  const handleEyedropperPick = useCallback(
    (hex: string) => {
      if (!eyedropperTarget) {
        setCanvasTool("select");
        showTransientStatus("Pilih grup warna terlebih dahulu.");
        return;
      }

      handleChangeGroupColor(eyedropperTarget.groupId, hex, false);
      if (activeItem) {
        setTempSelection2D(null);
        setTempCandidates3D(null);
        setHighlightedGroupState({
          itemId: activeItem.id,
          mode: activeMode,
          groupId: eyedropperTarget.groupId,
        });
      }
      setCanvasTool("select");
      setIsColorPickerOpen(true);
      showTransientStatus(`Warna ${hex} diterapkan ke ${eyedropperTarget.name}`);
    },
    [
      activeItem,
      activeMode,
      eyedropperTarget,
      handleChangeGroupColor,
      showTransientStatus,
    ],
  );

  const handleOpenExportView = useCallback(() => {
    setTempSelection2D(null);
    setTempCandidates3D(null);
    setHighlightedGroupState(null);
    setIsColorPickerOpen(false);
    setIsGlobalColorPickMode(false);
    setCanvasTool("select");
    setMobileTab("export");
    setDesktopDockMode("export");
  }, []);

  const handleExportActiveHdRaster = useCallback(
    async ({
      format,
      scale,
      jpgBgHex,
    }: {
      format: "png" | "jpg";
      scale: HdScaleFactor;
      jpgBgHex: string;
    }) => {
      if (!activeItem) return;

      if (activeItem.processingMode === "3d") {
        if (!livePrepared3D || !active3DState) return;
        const recolored = render3DExportImageData(livePrepared3D, active3DState);
        const exported = await renderImageDataToHdRasterFile({
          imageData: recolored,
          baseWidth: activeItem.loadedImage.originalWidth,
          baseHeight: activeItem.loadedImage.originalHeight,
          baseFileName: activeItem.loadedImage.fileName,
          scale,
          format,
          jpgBackgroundHex: jpgBgHex,
        });
        triggerBlobDownload(exported.blob, exported.fileName);
        return;
      }

      if (!liveSegmentation || !groupingState) return;
      const vector = buildFullVectorSvgForRender({
        regionMap: liveSegmentation.regionMap,
        width: liveSegmentation.width,
        height: liveSegmentation.height,
        groupingState,
        epsilon: activeItem.rdpEpsilon,
        smoothCurves: activeItem.smoothCurves,
        nativeSvg: activeItem.loadedImage.nativeSvg,
      });

      const exported = await renderSvgToHdRasterFile({
        svgString: vector.svgString,
        baseWidth: activeItem.loadedImage.originalWidth,
        baseHeight: activeItem.loadedImage.originalHeight,
        baseFileName: activeItem.loadedImage.fileName,
        scale,
        format,
        jpgBackgroundHex: jpgBgHex,
      });

      triggerBlobDownload(exported.blob, exported.fileName);
    },
    [
      active3DState,
      activeItem,
      groupingState,
      livePrepared3D,
      liveSegmentation,
    ],
  );

  const handleExportAllZip = useCallback(
    async ({
      format,
      scale,
      jpgBgHex,
    }: {
      format: ExportFormatOption;
      scale: HdScaleFactor;
      jpgBgHex: string;
    }) => {
      const syncedItems = syncActivePipelinesIntoBatch(batchItems);
      const entries: ZipEntryInput[] = [];

      for (const item of syncedItems) {
        if (item.processingMode === "3d" && format !== "svg") {
          const prep =
            item.id === activeItem?.id && livePrepared3D
              ? livePrepared3D
              : item.prepared3D ??
                prepare3DForImage(
                  item.loadedImage,
                  item.bgRemovalEnabled,
                  item.tolerance,
                ).prepared;
          const st3d =
            item.id === activeItem?.id && active3DState
              ? active3DState
              : item.history3D?.present ??
                createEmpty3DState(prep.width, prep.height);

          const recolored = render3DExportImageData(prep, st3d);
          const hdFile = await renderImageDataToHdRasterFile({
            imageData: recolored,
            baseWidth: item.loadedImage.originalWidth,
            baseHeight: item.loadedImage.originalHeight,
            baseFileName: item.loadedImage.fileName,
            scale,
            format,
            jpgBackgroundHex: jpgBgHex,
          });
          entries.push({ fileName: hdFile.fileName, content: hdFile.blob });
          continue;
        }

        const seg =
          item.id === activeItem?.id && liveSegmentation
            ? liveSegmentation
            : item.segmentation;
        const hist =
          item.id === activeItem?.id && liveHistory ? liveHistory : item.history;

        if (format === "svg") {
          const res = buildCanvaSvgExport({
            regionMap: seg.regionMap,
            width: seg.width,
            height: seg.height,
            groupingState: hist.present,
            baseFileName: item.loadedImage.fileName,
            epsilon: item.rdpEpsilon,
            smoothCurves: item.smoothCurves,
            nativeSvg: item.loadedImage.nativeSvg,
          });
          for (const f of res.files) {
            entries.push({ fileName: f.fileName, content: f.svgString });
          }
        } else {
          const vector = buildFullVectorSvgForRender({
            regionMap: seg.regionMap,
            width: seg.width,
            height: seg.height,
            groupingState: hist.present,
            epsilon: item.rdpEpsilon,
            smoothCurves: item.smoothCurves,
            nativeSvg: item.loadedImage.nativeSvg,
          });
          const hdFile = await renderSvgToHdRasterFile({
            svgString: vector.svgString,
            baseWidth: item.loadedImage.originalWidth,
            baseHeight: item.loadedImage.originalHeight,
            baseFileName: item.loadedImage.fileName,
            scale,
            format,
            jpgBackgroundHex: jpgBgHex,
          });
          entries.push({ fileName: hdFile.fileName, content: hdFile.blob });
        }
      }

      if (entries.length === 0) return;

      const zipBlob = await createZipArchiveBlob(entries);
      const zipName =
        syncedItems.length === 1
          ? `${sanitizeExportBaseName(syncedItems[0].loadedImage.fileName)}-canva-parts.zip`
          : `canva-svg-batch-${syncedItems.length}-desain-${format}.zip`;

      triggerBlobDownload(zipBlob, zipName);
    },
    [
      active3DState,
      activeItem?.id,
      batchItems,
      liveHistory,
      livePrepared3D,
      liveSegmentation,
      syncActivePipelinesIntoBatch,
    ],
  );

  // Drag-and-drop extra files onto active workspace
  const handleWorkspaceDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const dropped = Array.from(event.dataTransfer.files ?? []);
      if (dropped.length > 0) {
        filePickModeRef.current = "append";
        void handleFilesSelect(dropped);
      }
    },
    [handleFilesSelect],
  );

  const filmstripItems: BatchFilmstripItem[] = useMemo(
    () =>
      batchItems.map((item) => {
        const isCurrent = item.id === activeItem?.id;
        const groupCount =
          item.processingMode === "3d"
            ? isCurrent && active3DState
              ? active3DState.groups.length
              : item.history3D?.present.groups.length ?? 0
            : isCurrent && groupingState
              ? groupingState.groups.length
              : item.history.present.groups.length;

        return {
          id: item.id,
          fileName: item.loadedImage.fileName,
          thumbnailUrl: item.thumbnailUrl,
          isNativeSvg: item.loadedImage.kind === "native-svg",
          processingMode: item.processingMode,
          groupCount,
        };
      }),
    [active3DState, activeItem?.id, batchItems, groupingState],
  );

  // Unified Group List items for ColorGroupsList
  const inspectorGroups: InspectorGroupView[] = useMemo(() => {
    if (activeMode === "3d") {
      return (active3DState?.groups ?? []).map((g) => ({
        groupId: g.groupId,
        name: g.name,
        colorHex: g.targetHex,
        countLabel: `${g.pixelCount.toLocaleString("id-ID")} px`,
        isNeutral: g.isNeutral,
      }));
    }
    return (groupingState?.groups ?? []).map((g) => ({
      groupId: g.groupId,
      name: g.name,
      colorHex: g.colorHex,
      countLabel: `${g.regionIds.length} bagian`,
    }));
  }, [active3DState, activeMode, groupingState]);

  const canUndo =
    activeMode === "3d"
      ? (liveHistory3D?.past.length ?? 0) > 0
      : (liveHistory?.past.length ?? 0) > 0;
  const canRedo =
    activeMode === "3d"
      ? (liveHistory3D?.future.length ?? 0) > 0
      : (liveHistory?.future.length ?? 0) > 0;

  const activeGroupCount = groupingState?.groups.length ?? 0;
  const isNativeSvg = activeItem?.loadedImage.kind === "native-svg";
  const activeSelectedGroupId =
    activeMode === "3d"
      ? active3DGroup?.groupId ?? null
      : active2DGroup?.groupId ?? null;
  const activeBgResult =
    activeMode === "3d" ? liveBgRemoval3D : liveSegmentation?.bgRemovalResult;
  const activeTolerance3D = activeItem?.tolerance3D ?? DEFAULT_3D_TOLERANCE;
  const activeShadowReach3D =
    activeItem?.shadowReach3D ?? DEFAULT_3D_SHADOW_REACH;
  const mobileExpanded =
    isColorPickerOpen ||
    (activeMode === "2d" && Boolean(selectedSingleRegion));

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[#0F1115] text-slate-100">
      <HiddenFileInput
        inputRef={fileInputRef}
        onFilesSelect={handleFilesSelect}
      />

      {/* Top Workspace Header with Prominent Mode Switcher & Global Undo/Redo */}
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-1.5 border-b border-white/10 bg-[#151820] px-2 sm:h-14 sm:gap-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-400/15 text-teal-300 ring-1 ring-teal-400/30 sm:h-9 sm:w-9">
            <Layers className="h-4 w-4 sm:h-4.5 sm:w-4.5" aria-hidden="true" />
          </div>
          <div className="hidden min-w-0 md:block">
            <h1 className="truncate text-sm font-semibold tracking-tight text-slate-100">
              Canva SVG Splitter
            </h1>
            <p className="truncate text-[11px] text-slate-400">
              v2.5 • 2D Vektor &amp; 3D Luminance
            </p>
          </div>
          {!activeItem && (
            <h1 className="truncate text-sm font-semibold tracking-tight text-slate-100 md:hidden">
              SVG Splitter
            </h1>
          )}
        </div>

        {/* Mode Switcher: Mode 2D (Vektor SVG) | Mode 3D / Gradasi (PNG HD) */}
        <div
          role="tablist"
          aria-label="Pilih mode pemrosesan gambar"
          className="flex shrink-0 items-center gap-0.5 rounded-xl bg-[#0E1117] p-0.5 ring-1 ring-white/15 sm:gap-1 sm:p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === "2d"}
            aria-label="Mode 2D (Vektor SVG)"
            onClick={() => handleSwitchMode("2d")}
            className={`flex min-h-[42px] items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold transition-colors sm:px-3 sm:text-xs ${
              activeMode === "2d"
                ? "bg-teal-400 text-slate-950 shadow-sm"
                : "text-slate-300 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sm:hidden">2D SVG</span>
            <span className="hidden sm:inline lg:hidden">Mode 2D</span>
            <span className="hidden lg:inline">Mode 2D (Vektor SVG)</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeMode === "3d"}
            aria-label="Mode 3D / Gradasi (PNG HD)"
            onClick={() => handleSwitchMode("3d")}
            className={`flex min-h-[42px] items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold transition-colors sm:px-3 sm:text-xs ${
              activeMode === "3d"
                ? "bg-sky-400 text-slate-950 shadow-sm"
                : "text-slate-300 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Box className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sm:hidden">3D PNG</span>
            <span className="hidden sm:inline lg:hidden">Mode 3D</span>
            <span className="hidden lg:inline">
              Mode 3D / Gradasi (PNG HD)
            </span>
          </button>
        </div>

        {/* Workspace Quick Actions (Undo & Redo always visible on mobile & desktop) */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          {activeItem && (
            <>
              {activeMode === "2d" && (
                <div className="hidden xl:block">
                  <CanvaGuardBadge groupCount={activeGroupCount} compact />
                </div>
              )}

              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                aria-label="Urungkan perubahan (Ctrl+Z)"
                title="Undo (Ctrl+Z)"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[#1D222D] text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Undo2 className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                aria-label="Ulangi perubahan (Ctrl+Y atau Ctrl+Shift+Z)"
                title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[#1D222D] text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Redo2 className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={handleResetView}
                aria-label="Reset posisi dan zoom kanvas"
                className="hidden min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-[#1D222D] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39] sm:flex"
              >
                <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="hidden xl:inline">Reset View</span>
              </button>

              <button
                type="button"
                onClick={handleRequestReplaceFile}
                disabled={isLoading}
                aria-label="Ganti gambar aktif"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-[#1D222D] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39] disabled:opacity-60"
              >
                <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">Ganti</span>
              </button>

              <button
                type="button"
                onClick={handleOpenExportView}
                aria-label="Buka panel ekspor"
                className="hidden min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-teal-400 px-3.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-300 active:bg-teal-500 sm:flex"
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Ekspor</span>
              </button>

              <button
                type="button"
                onClick={handleClearWorkspace}
                aria-label="Tutup semua gambar"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[#1D222D] text-slate-300 transition-colors hover:border-rose-400/40 hover:bg-rose-500/15 hover:text-rose-200"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Batch Filmstrip Bar */}
      {activeItem && (
        <BatchFilmstrip
          items={filmstripItems}
          activeItemId={activeItem.id}
          onSelectItem={handleSelectBatchItem}
          onRemoveItem={handleRemoveBatchItem}
          onAddMore={handleRequestAppendFiles}
          onDuplicateActive={handleDuplicateActive}
          onSyncPaletteToAll={handleSyncPaletteToAll}
          paletteSyncMessage={statusMessage}
        />
      )}

      {/* Main Tool-Centric Body */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Interactive Canvas / Dropzone */}
        <section
          onDragOver={(e) => {
            if (activeItem) e.preventDefault();
          }}
          onDrop={activeItem ? handleWorkspaceDrop : undefined}
          className="relative min-h-0 flex-1 overflow-hidden"
        >
          {activeItem && activeCanvasImageData ? (
            <>
              <CanvasWorkspace
                imageData={activeCanvasImageData}
                sourceImageData={activeItem.loadedImage.imageData}
                width={activeCanvasImageData.width}
                height={activeCanvasImageData.height}
                imageKey={canvasKeyMap[activeItem.id] ?? 1}
                resetTrigger={resetTrigger}
                fileName={activeItem.loadedImage.fileName}
                processingMode={activeMode}
                activeTool={canvasTool}
                onChangeTool={(tool) => {
                  setIsGlobalColorPickMode(false);
                  setCanvasTool(tool);
                }}
                isMultiSelectMode={isMultiSelectMode}
                onToggleMultiSelectMode={() =>
                  setIsMultiSelectMode((prev) => !prev)
                }
                selectedCount={hasTempSelectionCount}
                canMergeSelection={selectionCapabilities.canMerge}
                canSplitSelection={selectionCapabilities.canSplit}
                onMergeSelection={handleMergeSelection}
                onSplitSelection={
                  activeMode === "2d" ? handleSplitSelection : undefined
                }
                onClearSelection={handleClearTempSelection}
                isGlobalColorPickMode={isGlobalColorPickMode}
                eyedropperTargetName={eyedropperTarget?.name ?? null}
                onEyedropperPick={handleEyedropperPick}
                regionMap={
                  activeMode === "2d" && liveSegmentation
                    ? liveSegmentation.regionMap
                    : null
                }
                selectedBoundingBox={
                  activeMode === "2d" && resolvedSelectedIds2D.length === 1
                    ? selectedSingleRegion?.boundingBox
                    : null
                }
                onSelectRegion={
                  activeMode === "2d" ? handleSelectRegion : undefined
                }
                onTapCanvasPoint3D={
                  activeMode === "3d" ? handleTapCanvasPoint3D : undefined
                }
                brushRadius={brushRadius3D}
                brushMode={brushMode3D}
                onChangeBrushMode={setBrushMode3D}
                onBrushStart3D={handleBrushStart3D}
                onBrushSegment3D={handleBrushSegment3D}
                onBrushEnd3D={handleBrushEnd3D}
              />

              {/* Floating Preview Mode Switcher */}
              <div
                role="group"
                aria-label="Mode pratinjau kanvas"
                className="no-scrollbar absolute top-3 left-3 z-10 flex max-w-[95vw] items-center gap-1 overflow-x-auto rounded-xl border border-white/10 bg-[#171A21]/92 p-1 shadow-lg backdrop-blur-md"
              >
                <button
                  type="button"
                  onClick={() => setPreviewMode("live")}
                  aria-pressed={previewMode === "live"}
                  className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors sm:px-3 ${
                    previewMode === "live"
                      ? "bg-teal-400 text-slate-950"
                      : "text-slate-200 hover:bg-white/10"
                  }`}
                >
                  <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Live Preview</span>
                </button>

                <button
                  type="button"
                  onClick={() => setPreviewMode("solid")}
                  aria-pressed={previewMode === "solid"}
                  className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors sm:px-3 ${
                    previewMode === "solid"
                      ? "bg-teal-400 text-slate-950"
                      : "text-slate-200 hover:bg-white/10"
                  }`}
                >
                  <Palette className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Asli</span>
                </button>

                <button
                  type="button"
                  onClick={() => setPreviewMode("region-map")}
                  aria-pressed={previewMode === "region-map"}
                  className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors sm:px-3 ${
                    previewMode === "region-map"
                      ? "bg-teal-400 text-slate-950"
                      : "text-slate-200 hover:bg-white/10"
                  }`}
                >
                  <Grid2x2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {activeMode === "3d" ? "Mask Seleksi" : "Peta Region"}
                  </span>
                </button>
              </div>

              {/* Subtle Warning / Info Stack */}
              <div className="pointer-events-none absolute top-17 right-3 left-3 z-10 flex flex-col items-end gap-2 sm:top-3 sm:left-auto sm:max-w-sm">
                {statusMessage && (
                  <div
                    role="status"
                    className="pointer-events-auto rounded-xl border border-emerald-400/40 bg-[#121D1A]/95 px-3 py-2 text-xs font-medium text-emerald-200 shadow-lg backdrop-blur-md"
                  >
                    {statusMessage}
                  </div>
                )}

                {activeMode === "2d" &&
                  liveSegmentation?.isComplexPhoto &&
                  !dismissedComplexPhotoNotice && (
                    <div
                      role="status"
                      className="pointer-events-auto flex w-full items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-[#1C1812]/95 px-3 py-2 text-xs text-amber-100 shadow-lg backdrop-blur-md"
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                          aria-hidden="true"
                        />
                        <div>
                          <p>
                            Terdeteksi {liveSegmentation.dominantClusterCount}{" "}
                            klaster warna (foto/render 3D bergradasi).
                          </p>
                          <button
                            type="button"
                            onClick={() => handleSwitchMode("3d")}
                            className="mt-1 font-semibold text-sky-300 underline underline-offset-2 hover:text-sky-200"
                          >
                            Beralih ke Mode 3D / Gradasi →
                          </button>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDismissedComplexPhotoNotice(true)}
                        aria-label="Tutup peringatan foto realistis"
                        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-amber-200 hover:bg-white/10"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  )}

                {activeItem.loadedImage.wasDownscaled &&
                  !dismissedDownscaleNotice && (
                    <div className="pointer-events-auto flex w-full items-center justify-between gap-2 rounded-xl border border-sky-400/30 bg-[#171A21]/95 px-3 py-2 text-xs text-slate-100 shadow-lg backdrop-blur-md">
                      <div className="flex items-start gap-2">
                        <Info
                          className="mt-0.5 h-4 w-4 shrink-0 text-sky-300"
                          aria-hidden="true"
                        />
                        <span>
                          Ukuran diskalakan dari{" "}
                          {activeItem.loadedImage.originalWidth}×
                          {activeItem.loadedImage.originalHeight} ke{" "}
                          {activeItem.loadedImage.width}×
                          {activeItem.loadedImage.height}px agar cepat di
                          browser.
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDismissedDownscaleNotice(true)}
                        aria-label="Tutup pemberitahuan skala gambar"
                        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  )}

                {errorMessage && (
                  <div
                    role="alert"
                    className="pointer-events-auto flex w-full items-center justify-between gap-2 rounded-xl border border-rose-500/40 bg-[#231419]/95 px-3.5 py-2 text-xs text-rose-100 shadow-lg"
                  >
                    <span>{errorMessage}</span>
                    <button
                      type="button"
                      onClick={() => setErrorMessage(null)}
                      aria-label="Tutup pesan kesalahan"
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-rose-200 hover:bg-white/10"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <ImageUploader
              onFilesSelect={handleFilesSelect}
              onLoadSample={handleLoadSample}
              onLoadSample3D={handleLoadSample3D}
              isLoading={isLoading}
              errorMessage={errorMessage}
              onRequestPickFiles={handleRequestAppendFiles}
            />
          )}
        </section>

        {/* Bottom Control Sheet (Mobile/Tablet) & Desktop Dock */}
        {activeItem && (
          <aside
            className={`shrink-0 overflow-y-auto border-t border-white/10 bg-[#151820] px-3 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:flex lg:max-h-none lg:w-96 lg:flex-col lg:overflow-y-auto lg:border-t-0 lg:border-l lg:p-5 ${
              mobileExpanded ? "max-h-[268px]" : "max-h-[180px]"
            }`}
          >
            {/* Desktop Dock Mode Switcher */}
            <div className="mb-4 hidden items-center gap-1 rounded-xl bg-[#101217] p-1 ring-1 ring-white/10 lg:flex">
              <button
                type="button"
                onClick={() => setDesktopDockMode("inspector")}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors ${
                  desktopDockMode === "inspector"
                    ? "bg-[#222836] text-teal-300"
                    : "text-slate-300 hover:text-slate-100"
                }`}
              >
                <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{activeMode === "3d" ? "Editor 3D" : "Editor Grup"}</span>
              </button>

              <button
                type="button"
                onClick={() => setDesktopDockMode("export")}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors ${
                  desktopDockMode === "export"
                    ? "bg-teal-400 text-slate-950"
                    : "text-slate-300 hover:text-slate-100"
                }`}
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {activeMode === "3d" ? "Ekspor HD" : "Ekspor Multi-Format"}
                </span>
              </button>
            </div>

            {/* Mobile Tab Bar */}
            {!(activeMode === "2d" && selectedSingleRegion) && (
              <div className="mb-1.5 flex items-center justify-between gap-2 lg:hidden">
                <div className="no-scrollbar flex items-center gap-1 overflow-x-auto rounded-xl bg-[#101217] p-1 ring-1 ring-white/5">
                  <button
                    type="button"
                    onClick={() => setMobileTab("groups")}
                    className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                      mobileTab === "groups"
                        ? "bg-[#222836] text-teal-300"
                        : "text-slate-300 hover:text-slate-100"
                    }`}
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Grup</span>
                  </button>

                  {activeMode === "3d" && (
                    <button
                      type="button"
                      onClick={() => setMobileTab("quantize")}
                      className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                        mobileTab === "quantize"
                          ? "bg-[#222836] text-sky-300"
                          : "text-slate-300 hover:text-slate-100"
                      }`}
                    >
                      <Box className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>Toleransi 3D</span>
                    </button>
                  )}

                  {activeMode === "2d" && !isNativeSvg && (
                    <button
                      type="button"
                      onClick={() => setMobileTab("quantize")}
                      className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                        mobileTab === "quantize"
                          ? "bg-[#222836] text-teal-300"
                          : "text-slate-300 hover:text-slate-100"
                      }`}
                    >
                      <Palette
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>Warna</span>
                    </button>
                  )}

                  {!isNativeSvg && (
                    <button
                      type="button"
                      onClick={() => setMobileTab("background")}
                      className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                        mobileTab === "background"
                          ? "bg-[#222836] text-teal-300"
                          : "text-slate-300 hover:text-slate-100"
                      }`}
                    >
                      <Eraser
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>Latar</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleOpenExportView}
                    className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                      mobileTab === "export"
                        ? "bg-teal-400 text-slate-950"
                        : "text-teal-300 hover:bg-teal-400/15"
                    }`}
                  >
                    <Download
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>Ekspor</span>
                  </button>
                </div>

                {activeMode === "2d" && (
                  <div className="hidden sm:block">
                    <CanvaGuardBadge groupCount={activeGroupCount} compact />
                  </div>
                )}
              </div>
            )}

            {/* Export Panel */}
            <div
              className={
                (!(activeMode === "2d" && selectedSingleRegion) &&
                mobileTab === "export"
                  ? "block "
                  : "hidden ") +
                (desktopDockMode === "export" ? "lg:block" : "lg:hidden")
              }
            >
              <ExportPanel
                processingMode={activeMode}
                exportResult={exportResult}
                baseWidth={activeItem.loadedImage.originalWidth}
                baseHeight={activeItem.loadedImage.originalHeight}
                isNativeSvgSource={isNativeSvg}
                epsilon={activeItem.rdpEpsilon}
                smoothCurves={activeItem.smoothCurves}
                onChangeEpsilon={(value) =>
                  updateActiveItemFields({ rdpEpsilon: value })
                }
                onToggleSmoothCurves={() =>
                  updateActiveItemFields({
                    smoothCurves: !activeItem.smoothCurves,
                  })
                }
                onAutoCompactToFive={handleAutoCompactToFive}
                batchItemCount={batchItems.length}
                onExportActiveHdRaster={handleExportActiveHdRaster}
                onExportAllZip={handleExportAllZip}
              />
            </div>

            {/* Editor / Inspector View */}
            <div
              className={
                (mobileTab !== "export" ||
                (activeMode === "2d" && selectedSingleRegion)
                  ? "block "
                  : "hidden ") +
                (desktopDockMode === "inspector" ? "lg:block" : "lg:hidden")
              }
            >
              <div className="space-y-4 lg:space-y-5">
                {/* Desktop Mode-Specific Header Banner */}
                {activeMode === "2d" ? (
                  <div className="hidden lg:block">
                    <CanvaGuardBadge
                      groupCount={activeGroupCount}
                      onAutoCompact={handleAutoCompactToFive}
                    />
                  </div>
                ) : (
                  <div className="hidden rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100 lg:block">
                    <p className="font-semibold">
                      Mode 3D / Gradasi (Luminance-Preserving)
                    </p>
                    <p className="mt-0.5 text-[11px] text-sky-200/85">
                      Ketuk area pada gambar 3D untuk menyeleksi beserta cahaya
                      &amp; bayangannya. Gunakan Pilih Banyak (atau Ctrl+Klik)
                      untuk mengumpulkan beberapa bagian lalu tekan Gabung
                      Grup.
                    </p>
                  </div>
                )}

                {/* Native SVG Passthrough Notice */}
                {activeMode === "2d" && isNativeSvg && (
                  <div className="hidden rounded-xl border border-teal-400/25 bg-teal-400/10 px-3 py-2 text-xs text-teal-100 lg:block">
                    <p className="font-semibold">Mode Vektor SVG Asli</p>
                    <p className="mt-0.5 text-[11px] text-teal-200/85">
                      Geometri SVG asli dipertahankan tanpa re-tracing. Klik atau
                      Ctrl+Klik bagian di kanvas untuk pilih sementara lalu
                      Gabung/Pisah.
                    </p>
                  </div>
                )}

                {/* Mode 2D Quick Action Card when 1 region is selected temporarily */}
                {activeMode === "2d" &&
                  selectedSingleRegion &&
                  active2DGroup &&
                  groupingState && (
                    <SelectedRegionCard
                      region={selectedSingleRegion}
                      group={active2DGroup}
                      allGroups={groupingState.groups}
                      onSplitToNewGroup={handleSplitSingleRegion}
                      onAssignToGroup={handleAssignToGroup}
                      onChangeGroupColor={handleChangeGroupColor}
                      isEyedropperActive={canvasTool === "eyedropper"}
                      onToggleEyedropper={handleToggleEyedropper}
                      onClearSelection={() => {
                        setIsColorPickerOpen(false);
                        setTempSelection2D(null);
                      }}
                    />
                  )}

                {/* Mode 3D Active Group Tolerance + Brush/Eraser + Global Color Range */}
                {activeMode === "3d" && (
                  <div
                    className={
                      mobileTab === "quantize" ? "block" : "hidden lg:block"
                    }
                  >
                    <Mode3DControls
                      activeTool={canvasTool}
                      onSelectTool={(tool) => {
                        setIsGlobalColorPickMode(false);
                        setCanvasTool(tool);
                      }}
                      tolerance={activeTolerance3D}
                      onChangeTolerance={handleChange3DTolerance}
                      shadowReach={activeShadowReach3D}
                      onChangeShadowReach={handleChange3DShadowReach}
                      brushMode={brushMode3D}
                      onChangeBrushMode={setBrushMode3D}
                      brushRadius={brushRadius3D}
                      onChangeBrushRadius={setBrushRadius3D}
                      hasActiveGroup={Boolean(active3DGroup)}
                      activeGroupName={active3DGroup?.name ?? null}
                      canAdjustActiveGroupTolerance={Boolean(
                        active3DGroup &&
                          (active3DGroup.lastSeedIndex !== null ||
                            active3DGroup.seedIndices.length > 0),
                      )}
                      isGlobalColorPickMode={isGlobalColorPickMode}
                      onTriggerGlobalSimilar={handleTriggerGlobalSimilar}
                    />
                  </div>
                )}

                {/* Active Color Groups List (Shared across Mode 2D & Mode 3D) */}
                <div
                  className={
                    !(activeMode === "2d" && selectedSingleRegion) &&
                    mobileTab === "groups"
                      ? "block space-y-2"
                      : "hidden lg:block lg:space-y-3"
                  }
                >
                  {activeMode === "2d" && (
                    <div className="lg:hidden">
                      <CanvaGuardBadge
                        groupCount={activeGroupCount}
                        compact
                        onAutoCompact={handleAutoCompactToFive}
                      />
                    </div>
                  )}

                  <ColorGroupsList
                    groups={inspectorGroups}
                    selectedGroupId={activeSelectedGroupId}
                    onSelectGroup={handleSelectGroup}
                    onFocusGroupColor={handleFocusGroupColor}
                    onRenameGroup={handleRenameActiveModeGroup}
                    onChangeGroupColor={handleChangeGroupColor}
                    onMergeGroups={handleMergeGroups}
                    onDeleteGroup={
                      activeMode === "3d" ? handleDelete3DGroup : undefined
                    }
                    onResetGrouping={handleResetGrouping}
                    isColorPickerOpen={isColorPickerOpen}
                    onCloseColorPicker={() => setIsColorPickerOpen(false)}
                    isEyedropperActive={canvasTool === "eyedropper"}
                    onToggleEyedropper={handleToggleEyedropper}
                    emptyMessage={
                      activeMode === "3d"
                        ? "Ketuk area pada gambar 3D untuk memilih & mewarnai ulang."
                        : "Belum ada grup warna."
                    }
                    resetLabel={activeMode === "3d" ? "Reset 3D" : "Reset Grup"}
                  />
                </div>

                {/* Mode 2D Stage 2 & 3: Initial Color Detail */}
                {activeMode === "2d" && !isNativeSvg && liveSegmentation && (
                  <>
                    <div
                      className="hidden h-px bg-white/10 lg:block"
                      aria-hidden="true"
                    />

                    <div
                      className={
                        !selectedSingleRegion && mobileTab === "quantize"
                          ? "block space-y-2"
                          : "hidden lg:block lg:space-y-3"
                      }
                    >
                      <div className="hidden items-center justify-between lg:flex">
                        <h2 className="text-sm font-semibold text-slate-100">
                          Detail Warna &amp; Region
                        </h2>
                        <span className="text-xs text-slate-400 tabular-nums">
                          {liveSegmentation.regions.length} region •{" "}
                          {liveSegmentation.totalTimeMs} ms
                        </span>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-xs">
                          <label
                            htmlFor="color-count-slider"
                            className="font-medium text-slate-200"
                          >
                            Detail Warna Awal
                          </label>
                          <span className="rounded-md bg-[#202532] px-2 py-0.5 font-semibold text-teal-300 tabular-nums">
                            {activeItem.colorCount} warna
                          </span>
                        </div>

                        <input
                          id="color-count-slider"
                          type="range"
                          min={MIN_COLOR_COUNT}
                          max={MAX_COLOR_COUNT}
                          step={1}
                          value={activeItem.colorCount}
                          onChange={(e) => {
                            setTempSelection2D(null);
                            setTempCandidates3D(null);
                            setHighlightedGroupState(null);
                            updateActiveItemFields({
                              colorCount: Number(e.target.value),
                            });
                          }}
                          aria-label="Detail jumlah warna dasar dari 2 sampai 16"
                          className="studio-slider"
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-xl bg-[#101217] px-3 py-2 text-xs text-slate-300 ring-1 ring-white/5">
                        <span className="tabular-nums">
                          {liveSegmentation.regions.length} region terdeteksi
                        </span>
                        <span className="text-slate-400 tabular-nums">
                          {liveSegmentation.absorbedSpeckleCount} noise diserap
                        </span>
                      </div>
                    </div>
                  </>
                )}

                {/* Stage 1: Auto-Trim Background (Available in both 2D and 3D raster modes) */}
                {!isNativeSvg && (
                  <>
                    <div
                      className="hidden h-px bg-white/10 lg:block"
                      aria-hidden="true"
                    />

                    <div
                      className={
                        !(activeMode === "2d" && selectedSingleRegion) &&
                        mobileTab === "background"
                          ? "block space-y-2"
                          : "hidden lg:block lg:space-y-3"
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#202532] text-teal-300">
                            <Eraser className="h-4 w-4" aria-hidden="true" />
                          </div>
                          <h2 className="truncate text-sm font-semibold text-slate-100">
                            Auto-Trim Background
                          </h2>
                        </div>

                        <button
                          type="button"
                          role="switch"
                          aria-checked={activeItem.bgRemovalEnabled}
                          aria-label="Aktifkan atau nonaktifkan hapus background otomatis"
                          onClick={() => {
                            setTempSelection2D(null);
                            setTempCandidates3D(null);
                            setHighlightedGroupState(null);
                            updateActiveItemFields({
                              bgRemovalEnabled: !activeItem.bgRemovalEnabled,
                            });
                          }}
                          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end"
                        >
                          <span
                            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                              activeItem.bgRemovalEnabled
                                ? "bg-teal-400"
                                : "bg-slate-600"
                            }`}
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-slate-950 shadow transition-transform ${
                                activeItem.bgRemovalEnabled
                                  ? "translate-x-6"
                                  : "translate-x-1"
                              }`}
                            />
                          </span>
                        </button>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-xs">
                          <label
                            htmlFor="bg-tolerance-slider"
                            className="font-medium text-slate-200"
                          >
                            Toleransi Flood-Fill
                          </label>
                          <span className="rounded-md bg-[#202532] px-2 py-0.5 font-semibold text-teal-300 tabular-nums">
                            {activeItem.tolerance}
                          </span>
                        </div>

                        <input
                          id="bg-tolerance-slider"
                          type="range"
                          min={MIN_BG_TOLERANCE}
                          max={MAX_BG_TOLERANCE}
                          step={1}
                          value={activeItem.tolerance}
                          disabled={!activeItem.bgRemovalEnabled}
                          onChange={(e) => {
                            setTempSelection2D(null);
                            setTempCandidates3D(null);
                            setHighlightedGroupState(null);
                            updateActiveItemFields({
                              tolerance: Number(e.target.value),
                            });
                          }}
                          aria-label="Toleransi penghapusan background dari 0 sampai 50"
                          className="studio-slider"
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#101217] px-3 py-2 text-xs text-slate-300 ring-1 ring-white/5">
                        <div className="flex items-center gap-2">
                          {!activeItem.bgRemovalEnabled ? (
                            <span className="text-slate-400">
                              Background asli ditampilkan
                            </span>
                          ) : activeBgResult?.alreadyTransparent ? (
                            <span className="text-teal-300">
                              Sudut gambar sudah transparan
                            </span>
                          ) : activeBgResult?.detectedBackgroundHex ? (
                            <>
                              <span
                                className="h-3.5 w-3.5 shrink-0 rounded border border-white/25"
                                style={{
                                  backgroundColor:
                                    activeBgResult.detectedBackgroundHex,
                                }}
                                aria-hidden="true"
                              />
                              <span>
                                Latar{" "}
                                <span className="font-mono text-slate-100">
                                  {activeBgResult.detectedBackgroundHex}
                                </span>
                              </span>
                              <span aria-hidden="true">•</span>
                              <span className="text-teal-300 tabular-nums">
                                {activeBgResult.removedPercentage}%
                              </span>
                            </>
                          ) : null}
                        </div>

                        <span className="text-slate-400 tabular-nums">
                          {activeItem.loadedImage.width}×
                          {activeItem.loadedImage.height}px
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
