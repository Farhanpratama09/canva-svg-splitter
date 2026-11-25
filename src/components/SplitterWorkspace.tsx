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
  redoGrouping,
  renderGroupedCanvasImageData,
  resetGrouping,
  splitRegionToNewGroup,
  undoGrouping,
  updateGroupColor,
  type CanvasPreviewMode,
  type GroupingHistory,
} from "@/lib/image-processor/region-grouper";
import {
  createThumbnailDataUrl,
  runUnifiedSegmentationPipeline,
  type PipelineParameters,
  type UnifiedSegmentationResult,
} from "@/lib/image-processor/pipeline";
import { createSampleStickerImage } from "@/lib/image-processor/sample-illustration";
import { DEFAULT_RDP_EPSILON } from "@/lib/svg-exporter/contour-tracer";
import {
  buildCanvaSvgExport,
  buildFullVectorSvgForRender,
  sanitizeExportBaseName,
  type CanvaSvgExportResult,
} from "@/lib/svg-exporter/canva-svg-exporter";
import {
  createZipArchiveBlob,
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
  SelectedRegionCard,
} from "@/components/RegionInspectorPanel";

type MobilePanelTab = "groups" | "quantize" | "background" | "export";
type DesktopDockMode = "inspector" | "export";

interface BatchItem {
  id: string;
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
}

interface SelectionState {
  itemId: string;
  source: UnifiedSegmentationResult;
  regionId: number | null;
  groupId: string | null;
}

function buildDuplicateFileName(originalName: string, copyNumber: number): string {
  const dotIdx = originalName.lastIndexOf(".");
  if (dotIdx > 0) {
    return `${originalName.slice(0, dotIdx)}-v${copyNumber}${originalName.slice(dotIdx)}`;
  }
  return `${originalName}-v${copyNumber}`;
}

export function SplitterWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filePickModeRef = useRef<"append" | "replace">("append");
  const nextBatchSeqRef = useRef(1);

  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [canvasKeyMap, setCanvasKeyMap] = useState<Record<string, number>>({});
  const [resetTrigger, setResetTrigger] = useState(0);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paletteSyncMessage, setPaletteSyncMessage] = useState<string | null>(
    null,
  );
  const [dismissedDownscaleNotice, setDismissedDownscaleNotice] =
    useState(false);
  const [dismissedComplexPhotoNotice, setDismissedComplexPhotoNotice] =
    useState(false);

  const [previewMode, setPreviewMode] = useState<CanvasPreviewMode>("live");
  const [mobileTab, setMobileTab] = useState<MobilePanelTab>("groups");
  const [desktopDockMode, setDesktopDockMode] =
    useState<DesktopDockMode>("inspector");
  const [selectionState, setSelectionState] = useState<SelectionState | null>(
    null,
  );

  const createBatchItem = useCallback((loaded: LoadedImageResult): BatchItem => {
    const id = `item-${nextBatchSeqRef.current++}`;
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

    return {
      id,
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
    };
  }, []);

  const activeItem = useMemo(
    () => batchItems.find((item) => item.id === activeItemId) ?? batchItems[0] ?? null,
    [batchItems, activeItemId],
  );

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

  // Active segmentation (0 ms cache hit for Native SVG or unchanged raster params)
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

  // Active grouping history (synced cleanly if deferred segmentation updated)
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

      try {
        const mode = filePickModeRef.current;
        const currentCount = batchItems.length;

        if (mode === "replace" && activeItem) {
          const loaded = await loadImageFromFile(files[0], MAX_IMAGE_DIMENSION);
          const replacement = createBatchItem(loaded);

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
          setSelectionState(null);
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
            created.push(createBatchItem(loaded));
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
          setSelectionState(null);
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
    [activeItem, batchItems.length, createBatchItem],
  );

  const handleLoadSample = useCallback(() => {
    setErrorMessage(null);
    setDismissedDownscaleNotice(false);
    setDismissedComplexPhotoNotice(false);

    try {
      const sample = createSampleStickerImage(960);
      const item = createBatchItem({
        ...sample,
        kind: "raster",
      });
      setBatchItems([item]);
      setActiveItemId(item.id);
      setCanvasKeyMap({ [item.id]: 1 });
      setSelectionState(null);
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

  const handleClearWorkspace = useCallback(() => {
    setBatchItems([]);
    setActiveItemId(null);
    setCanvasKeyMap({});
    setSelectionState(null);
    setErrorMessage(null);
    setDismissedDownscaleNotice(false);
    setDismissedComplexPhotoNotice(false);
  }, []);

  const handleResetView = useCallback(() => {
    setResetTrigger((prev) => prev + 1);
  }, []);

  // Commit any pending deferred segmentation onto activeItem before mutations/switches
  const syncActiveSegmentationIntoBatch = useCallback(
    (items: BatchItem[]): BatchItem[] => {
      if (!activeItem || !liveSegmentation || !liveHistory) return items;
      if (liveSegmentation === activeItem.segmentation) return items;

      return items.map((item) =>
        item.id === activeItem.id
          ? {
              ...item,
              cachedParams: {
                bgRemovalEnabled: item.bgRemovalEnabled,
                tolerance: item.tolerance,
                colorCount: item.colorCount,
              },
              segmentation: liveSegmentation,
              history: liveHistory,
            }
          : item,
      );
    },
    [activeItem, liveSegmentation, liveHistory],
  );

  const handleSelectBatchItem = useCallback(
    (id: string) => {
      if (id === activeItem?.id) return;
      setBatchItems((prev) => syncActiveSegmentationIntoBatch(prev));
      setActiveItemId(id);
      setSelectionState(null);
      setErrorMessage(null);
    },
    [activeItem?.id, syncActiveSegmentationIntoBatch],
  );

  const handleRemoveBatchItem = useCallback(
    (id: string) => {
      setBatchItems((prev) => {
        const remaining = prev.filter((item) => item.id !== id);
        if (activeItem?.id === id) {
          setActiveItemId(remaining[0]?.id ?? null);
          setSelectionState(null);
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
    };

    setBatchItems((prev) => {
      const synced = syncActiveSegmentationIntoBatch(prev);
      const idx = synced.findIndex((i) => i.id === activeItem.id);
      const next = [...synced];
      next.splice(idx >= 0 ? idx + 1 : next.length, 0, clonedItem);
      return next;
    });
    setActiveItemId(newId);
    setCanvasKeyMap((prev) => ({ ...prev, [newId]: 1 }));
    setSelectionState(null);
  }, [
    activeItem,
    batchItems.length,
    liveHistory,
    liveSegmentation,
    syncActiveSegmentationIntoBatch,
  ]);

  const handleSyncPaletteToAll = useCallback(() => {
    if (!activeItem || !liveHistory || batchItems.length <= 1) return;

    const sourceHexes = [...liveHistory.present.groups]
      .sort((a, b) => b.totalPixels - a.totalPixels)
      .map((g) => g.colorHex);

    setBatchItems((prev) =>
      syncActiveSegmentationIntoBatch(prev).map((item) => {
        if (item.id === activeItem.id) return item;
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

    setPaletteSyncMessage(`Palet disalin ke ${batchItems.length - 1} desain`);
    setTimeout(() => setPaletteSyncMessage(null), 2500);
  }, [
    activeItem,
    batchItems.length,
    liveHistory,
    syncActiveSegmentationIntoBatch,
  ]);

  // Update active raster/export parameters
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

  // Derived validated region/group selection
  const resolvedSelection = useMemo(() => {
    if (
      !activeItem ||
      !liveSegmentation ||
      !groupingState ||
      !selectionState ||
      selectionState.itemId !== activeItem.id ||
      selectionState.source !== liveSegmentation
    ) {
      return { regionId: null, groupId: null };
    }

    const validRegionId =
      selectionState.regionId !== null &&
      groupingState.regionToGroup[selectionState.regionId]
        ? selectionState.regionId
        : null;

    let validGroupId: string | null = null;
    if (validRegionId !== null) {
      validGroupId = groupingState.regionToGroup[validRegionId] ?? null;
    } else if (
      selectionState.groupId !== null &&
      groupingState.groups.some((g) => g.groupId === selectionState.groupId)
    ) {
      validGroupId = selectionState.groupId;
    }

    return { regionId: validRegionId, groupId: validGroupId };
  }, [activeItem, liveSegmentation, groupingState, selectionState]);

  const selectedRegion: RegionInfo | null = useMemo(() => {
    if (!liveSegmentation || resolvedSelection.regionId === null) return null;
    return liveSegmentation.regions[resolvedSelection.regionId - 1] ?? null;
  }, [liveSegmentation, resolvedSelection.regionId]);

  const selectedGroup = useMemo(() => {
    if (!groupingState || resolvedSelection.groupId === null) return null;
    return (
      groupingState.groups.find(
        (g) => g.groupId === resolvedSelection.groupId,
      ) ?? null
    );
  }, [groupingState, resolvedSelection.groupId]);

  const activeCanvasImageData: ImageData | null = useMemo(() => {
    if (!liveSegmentation || !groupingState) return null;
    return renderGroupedCanvasImageData({
      regionMap: liveSegmentation.regionMap,
      width: liveSegmentation.width,
      height: liveSegmentation.height,
      regions: liveSegmentation.regions,
      groupingState,
      mode: previewMode,
      selectedRegionId: resolvedSelection.regionId,
      selectedGroupId: resolvedSelection.groupId,
    });
  }, [
    liveSegmentation,
    groupingState,
    previewMode,
    resolvedSelection.regionId,
    resolvedSelection.groupId,
  ]);

  const shouldBuildExport =
    mobileTab === "export" || desktopDockMode === "export";

  const exportResult: CanvaSvgExportResult | null = useMemo(() => {
    if (
      !shouldBuildExport ||
      !activeItem ||
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
    applyActiveHistoryUpdate(undoGrouping);
  }, [applyActiveHistoryUpdate]);

  const handleRedo = useCallback(() => {
    applyActiveHistoryUpdate(redoGrouping);
  }, [applyActiveHistoryUpdate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA")
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  const handleSelectRegion = useCallback(
    (regionId: number | null) => {
      if (!activeItem || !liveSegmentation || !groupingState) return;
      if (regionId === null) {
        setSelectionState({
          itemId: activeItem.id,
          source: liveSegmentation,
          regionId: null,
          groupId: null,
        });
        return;
      }
      const gid = groupingState.regionToGroup[regionId] ?? null;
      setSelectionState({
        itemId: activeItem.id,
        source: liveSegmentation,
        regionId,
        groupId: gid,
      });
      setMobileTab("groups");
      setDesktopDockMode("inspector");
    },
    [activeItem, liveSegmentation, groupingState],
  );

  const handleSelectGroup = useCallback(
    (groupId: string) => {
      if (!activeItem || !liveSegmentation) return;
      setSelectionState((prev) => {
        const isSameGroupOnly =
          prev?.itemId === activeItem.id &&
          prev?.source === liveSegmentation &&
          prev.regionId === null &&
          prev.groupId === groupId;
        return {
          itemId: activeItem.id,
          source: liveSegmentation,
          regionId: null,
          groupId: isSameGroupOnly ? null : groupId,
        };
      });
    },
    [activeItem, liveSegmentation],
  );

  const handleSplitRegion = useCallback(
    (regionId: number) => {
      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          splitRegionToNewGroup(history.present, regionId),
        ),
      );
      setPreviewMode("live");
    },
    [applyActiveHistoryUpdate],
  );

  const handleAssignToGroup = useCallback(
    (regionId: number, targetGroupId: string) => {
      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          assignRegionToGroup(history.present, regionId, targetGroupId),
        ),
      );
      setPreviewMode("live");
    },
    [applyActiveHistoryUpdate],
  );

  const handleChangeGroupColor = useCallback(
    (groupId: string, newHex: string, coalesce: boolean = false) => {
      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          updateGroupColor(history.present, groupId, newHex),
          coalesce ? `color-${groupId}` : undefined,
        ),
      );
      setPreviewMode("live");
    },
    [applyActiveHistoryUpdate],
  );

  const handleMergeGroups = useCallback(
    (sourceGroupId: string, targetGroupId: string) => {
      if (!activeItem || !liveSegmentation) return;
      applyActiveHistoryUpdate((history) =>
        commitGroupingChange(
          history,
          mergeGroups(history.present, sourceGroupId, targetGroupId),
        ),
      );
      setSelectionState({
        itemId: activeItem.id,
        source: liveSegmentation,
        regionId: null,
        groupId: targetGroupId,
      });
      setPreviewMode("live");
    },
    [activeItem, applyActiveHistoryUpdate, liveSegmentation],
  );

  const handleResetGrouping = useCallback(() => {
    if (!activeItem || !liveSegmentation) return;
    applyActiveHistoryUpdate((history) =>
      commitGroupingChange(history, resetGrouping(history.present)),
    );
    setSelectionState({
      itemId: activeItem.id,
      source: liveSegmentation,
      regionId: null,
      groupId: null,
    });
  }, [activeItem, applyActiveHistoryUpdate, liveSegmentation]);

  const handleAutoCompactToFive = useCallback(() => {
    if (!activeItem || !liveSegmentation) return;
    applyActiveHistoryUpdate((history) =>
      commitGroupingChange(history, autoCompactToFiveColors(history.present)),
    );
    setSelectionState({
      itemId: activeItem.id,
      source: liveSegmentation,
      regionId: null,
      groupId: null,
    });
    setPreviewMode("live");
  }, [activeItem, applyActiveHistoryUpdate, liveSegmentation]);

  const handleOpenExportView = useCallback(() => {
    if (activeItem && liveSegmentation) {
      setSelectionState({
        itemId: activeItem.id,
        source: liveSegmentation,
        regionId: null,
        groupId: null,
      });
    }
    setMobileTab("export");
    setDesktopDockMode("export");
  }, [activeItem, liveSegmentation]);

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
      if (!activeItem || !liveSegmentation || !groupingState) return;
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
    [activeItem, groupingState, liveSegmentation],
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
      const syncedItems = syncActiveSegmentationIntoBatch(batchItems);
      const entries: ZipEntryInput[] = [];

      for (const item of syncedItems) {
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
      activeItem?.id,
      batchItems,
      liveHistory,
      liveSegmentation,
      syncActiveSegmentationIntoBatch,
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
      batchItems.map((item) => ({
        id: item.id,
        fileName: item.loadedImage.fileName,
        thumbnailUrl: item.thumbnailUrl,
        isNativeSvg: item.loadedImage.kind === "native-svg",
        groupCount:
          item.id === activeItem?.id && groupingState
            ? groupingState.groups.length
            : item.history.present.groups.length,
      })),
    [activeItem?.id, batchItems, groupingState],
  );

  const canUndo = (liveHistory?.past.length ?? 0) > 0;
  const canRedo = (liveHistory?.future.length ?? 0) > 0;
  const activeGroupCount = groupingState?.groups.length ?? 0;
  const isNativeSvg = activeItem?.loadedImage.kind === "native-svg";

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[#0F1115] text-slate-100">
      <HiddenFileInput
        inputRef={fileInputRef}
        onFilesSelect={handleFilesSelect}
      />

      {/* Compact Top Workspace Header */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#151820] px-2.5 sm:h-14 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-400/15 text-teal-300 ring-1 ring-teal-400/30 sm:h-9 sm:w-9">
            <Layers className="h-4 w-4 sm:h-4.5 sm:w-4.5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-slate-100 sm:text-base">
              Canva SVG Splitter
            </h1>
            <p className="hidden truncate text-xs text-slate-400 sm:block">
              v2.0 • Dual-Pipeline SVG &amp; Batch HD
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          {activeItem && (
            <>
              <div className="hidden md:block">
                <CanvaGuardBadge groupCount={activeGroupCount} compact />
              </div>

              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                aria-label="Urungkan perubahan grup atau warna"
                title="Undo (Ctrl+Z)"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[#1D222D] text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Undo2 className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                aria-label="Ulangi perubahan grup atau warna"
                title="Redo (Ctrl+Shift+Z)"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-[#1D222D] text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Redo2 className="h-4 w-4" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={handleResetView}
                aria-label="Reset posisi dan zoom kanvas"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-[#1D222D] px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/20 hover:bg-[#252B39]"
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
                aria-label="Buka panel ekspor SVG dan HD"
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
          paletteSyncMessage={paletteSyncMessage}
        />
      )}

      {/* Main Tool-Centric Body */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Interactive Canvas / Dropzone (dominates >= 65% of mobile viewport) */}
        <section
          onDragOver={(e) => {
            if (activeItem) e.preventDefault();
          }}
          onDrop={activeItem ? handleWorkspaceDrop : undefined}
          className="relative min-h-0 flex-1 overflow-hidden"
        >
          {activeItem && activeCanvasImageData && liveSegmentation ? (
            <>
              <CanvasWorkspace
                imageData={activeCanvasImageData}
                width={liveSegmentation.width}
                height={liveSegmentation.height}
                imageKey={canvasKeyMap[activeItem.id] ?? 1}
                resetTrigger={resetTrigger}
                fileName={activeItem.loadedImage.fileName}
                regionMap={liveSegmentation.regionMap}
                selectedBoundingBox={selectedRegion?.boundingBox}
                onSelectRegion={handleSelectRegion}
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
                  <span>Peta Region</span>
                </button>
              </div>

              {/* Subtle Warning / Info Stack */}
              <div className="pointer-events-none absolute top-17 right-3 left-3 z-10 flex flex-col items-end gap-2 sm:top-3 sm:left-auto sm:max-w-sm">
                {liveSegmentation.isComplexPhoto &&
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
                        <span>
                          Terdeteksi {liveSegmentation.dominantClusterCount}{" "}
                          klaster warna (indikasi foto realistis). Hasil paling
                          optimal untuk ilustrasi 2D bergaris tegas.
                        </span>
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
              isLoading={isLoading}
              errorMessage={errorMessage}
              onRequestPickFiles={handleRequestAppendFiles}
            />
          )}
        </section>

        {/* Ergonomic Bottom Control Sheet (Mobile/Tablet <= 180px max-h so canvas >= 65%) & Desktop Dock */}
        {activeItem && groupingState && liveSegmentation && (
          <aside className="max-h-[180px] shrink-0 overflow-y-auto border-t border-white/10 bg-[#151820] px-3 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:flex lg:max-h-none lg:w-96 lg:flex-col lg:overflow-y-auto lg:border-t-0 lg:border-l lg:p-5">
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
                <span>Editor Grup</span>
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
                <span>Ekspor Multi-Format</span>
              </button>
            </div>

            {/* Mobile Tab Bar */}
            {!selectedRegion && (
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

                  {!isNativeSvg && (
                    <>
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
                    </>
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

                <div className="hidden sm:block">
                  <CanvaGuardBadge groupCount={activeGroupCount} compact />
                </div>
              </div>
            )}

            {/* Export Panel */}
            <div
              className={
                (!selectedRegion && mobileTab === "export"
                  ? "block "
                  : "hidden ") +
                (desktopDockMode === "export" ? "lg:block" : "lg:hidden")
              }
            >
              <ExportPanel
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
                (mobileTab !== "export" || selectedRegion ? "block " : "hidden ") +
                (desktopDockMode === "inspector" ? "lg:block" : "lg:hidden")
              }
            >
              <div className="space-y-4 lg:space-y-5">
                {/* Desktop Canva 5-Color Guard Card with Auto-Compact Button */}
                <div className="hidden lg:block">
                  <CanvaGuardBadge
                    groupCount={activeGroupCount}
                    onAutoCompact={handleAutoCompactToFive}
                  />
                </div>

                {/* Native SVG Passthrough Notice */}
                {isNativeSvg && (
                  <div className="hidden rounded-xl border border-teal-400/25 bg-teal-400/10 px-3 py-2 text-xs text-teal-100 lg:block">
                    <p className="font-semibold">Mode Vektor SVG Asli</p>
                    <p className="mt-0.5 text-[11px] text-teal-200/85">
                      Geometri SVG asli dipertahankan tanpa re-tracing. Ketuk
                      bagian di kanvas untuk pisah/ganti warna.
                    </p>
                  </div>
                )}

                {/* Quick Action Card when a region is tapped on canvas */}
                {selectedRegion && selectedGroup && (
                  <SelectedRegionCard
                    region={selectedRegion}
                    group={selectedGroup}
                    allGroups={groupingState.groups}
                    onSplitToNewGroup={handleSplitRegion}
                    onAssignToGroup={handleAssignToGroup}
                    onChangeGroupColor={handleChangeGroupColor}
                    onClearSelection={() => handleSelectRegion(null)}
                  />
                )}

                {/* Active Color Groups List */}
                <div
                  className={
                    !selectedRegion && mobileTab === "groups"
                      ? "block space-y-2"
                      : "hidden lg:block lg:space-y-3"
                  }
                >
                  <div className="lg:hidden">
                    <CanvaGuardBadge
                      groupCount={activeGroupCount}
                      compact
                      onAutoCompact={handleAutoCompactToFive}
                    />
                  </div>

                  <ColorGroupsList
                    groupingState={groupingState}
                    selectedGroupId={resolvedSelection.groupId}
                    onSelectGroup={handleSelectGroup}
                    onChangeGroupColor={handleChangeGroupColor}
                    onMergeGroups={handleMergeGroups}
                    onResetGrouping={handleResetGrouping}
                  />
                </div>

                {!isNativeSvg && (
                  <>
                    <div
                      className="hidden h-px bg-white/10 lg:block"
                      aria-hidden="true"
                    />

                    {/* Stage 2 & 3: Initial Color Detail */}
                    <div
                      className={
                        !selectedRegion && mobileTab === "quantize"
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
                          onChange={(e) =>
                            updateActiveItemFields({
                              colorCount: Number(e.target.value),
                            })
                          }
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

                    <div
                      className="hidden h-px bg-white/10 lg:block"
                      aria-hidden="true"
                    />

                    {/* Stage 1: Auto-Trim Background */}
                    <div
                      className={
                        !selectedRegion && mobileTab === "background"
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
                          onClick={() =>
                            updateActiveItemFields({
                              bgRemovalEnabled: !activeItem.bgRemovalEnabled,
                            })
                          }
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
                          onChange={(e) =>
                            updateActiveItemFields({
                              tolerance: Number(e.target.value),
                            })
                          }
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
                          ) : liveSegmentation.bgRemovalResult
                              ?.alreadyTransparent ? (
                            <span className="text-teal-300">
                              Sudut gambar sudah transparan
                            </span>
                          ) : liveSegmentation.bgRemovalResult
                              ?.detectedBackgroundHex ? (
                            <>
                              <span
                                className="h-3.5 w-3.5 shrink-0 rounded border border-white/25"
                                style={{
                                  backgroundColor:
                                    liveSegmentation.bgRemovalResult
                                      .detectedBackgroundHex,
                                }}
                                aria-hidden="true"
                              />
                              <span>
                                Latar{" "}
                                <span className="font-mono text-slate-100">
                                  {
                                    liveSegmentation.bgRemovalResult
                                      .detectedBackgroundHex
                                  }
                                </span>
                              </span>
                              <span aria-hidden="true">•</span>
                              <span className="text-teal-300 tabular-nums">
                                {
                                  liveSegmentation.bgRemovalResult
                                    .removedPercentage
                                }
                                %
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
