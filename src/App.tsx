import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderAsync } from "docx-preview";
import {
  AlertTriangle, Archive, ArrowDownAZ, ArrowLeft, ArrowRight, ArrowUp, Bell, CalendarClock, Check, CheckSquare, ChevronDown, ChevronRight, History,
  ClipboardPaste, Copy, Download, File, FileImage, FilePlus2, FileText, Folder, FolderInput,
  FolderOpen, FolderPlus, HardDrive, Image, Import, Info, Maximize2, MoreHorizontal, PanelRightClose, Star,
  PanelRightOpen, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, Scissors, Search, Tags, Trash2, X, House, Files, Settings, Database, ZoomIn, ZoomOut,
} from "lucide-react";
import { api } from "./api";
import type { AppTab, AppTabHistoryEntry, BootstrapData, DeleteMode, DocumentItem, NodeItem, Preview, Tag, TrashItem } from "./types";
import { currentVersion, describeUpdateFailure, findUpdate, installPendingUpdate, previousInstallIssue, type AvailableUpdate, type UpdateFailure } from "./updater";

const initialTab: AppTab = { id: "home", title: "主页", view: "home", nodeId: null, tagId: null, query: "", history: [] };
const tagColors = [
  "#2563eb", "#4f46e5", "#7c3aed", "#a855f7", "#db2777",
  "#e11d48", "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#14b8a6", "#06b6d4",
  "#0ea5e9", "#64748b", "#78716c", "#8b5cf6", "#ec4899",
];

type ClipboardState = { mode: "copy" | "cut"; ids: string[] } | null;
type ContextMenuState = { x: number; y: number; documentId: string } | null;
type TagMenuState = { x: number; y: number; documentIds: string[]; sourceTagId?: string } | null;
type ExpiryMenuState = { x: number; y: number; documentId: string } | null;
type NodeMenuState = { x: number; y: number; node: NodeItem } | null;
type TagEditorState = { mode: "create" | "edit"; tag?: Tag; documentIds: string[] } | null;
type PointerDragPayload = { kind: "files"; ids: string[]; label: string } | { kind: "node"; nodeId: string; label: string };
type PointerDragState = PointerDragPayload & { x: number; y: number };
type PointerDragCandidate = PointerDragPayload & { pointerId: number; startX: number; startY: number; nativePaths?: Promise<string[]> };
type NodeDropPosition = "before" | "inside" | "after";
type PointerDropTarget = { nodeId: string; position: NodeDropPosition };
type SortKey = "modified" | "name" | "extension" | "size" | "expiry";
type LedgerNotification = {
  id: string;
  documentId: string;
  title: string;
  message: string;
  tone: "expired" | "today" | "due-soon";
  createdAt: number;
  read: boolean;
};
type UpdateUiState = {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "error";
  info?: AvailableUpdate;
  message?: string;
  percent?: number | null;
  failure?: UpdateFailure;
  lastCheckedAt?: number;
};
type AppDialogState =
  | { kind: "input"; title: string; description: string; initialValue?: string; placeholder?: string; confirmLabel: string; onConfirm: (value: string) => void }
  | { kind: "confirm"; title: string; description: string; confirmLabel: string; tone?: "danger" | "default"; onConfirm: () => void }
  | { kind: "node-picker"; title: string; description: string; excludedIds: string[]; onConfirm: (node: NodeItem) => void }
  | null;

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [tabs, setTabs] = useState<AppTab[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState("home");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const [pointerDropTarget, setPointerDropTarget] = useState<PointerDropTarget | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(() => localStorage.getItem("document-ledger.preview-open") !== "false");
  const [loading, setLoading] = useState(true);
  const [externalDragging, setExternalDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [tagMenu, setTagMenu] = useState<TagMenuState>(null);
  const [expiryMenu, setExpiryMenu] = useState<ExpiryMenuState>(null);
  const [tagEditor, setTagEditor] = useState<TagEditorState>(null);
  const [dialog, setDialog] = useState<AppDialogState>(null);
  const [searchTagIds, setSearchTagIds] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>(() => readSortPreference().key);
  const [sortAscending, setSortAscending] = useState(() => readSortPreference().ascending);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("0.5.1");
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [notifications, setNotifications] = useState<LedgerNotification[]>(readNotifications);
  const [updateUi, setUpdateUi] = useState<UpdateUiState>({ phase: "idle" });
  const lastSelectedIndex = useRef<number | null>(null);
  const pointerCandidateRef = useRef<PointerDragCandidate | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const nativeDraggedIdsRef = useRef<string[] | null>(null);
  const suppressPointerClickRef = useRef(false);

  useEffect(() => {
    const preventBrowserZoom = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    window.addEventListener("wheel", preventBrowserZoom, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", preventBrowserZoom, true);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const selectedDocuments = documents.filter((document) => selectedIds.has(document.id));
  const selected = selectedDocuments.length === 1 ? selectedDocuments[0] : null;
  const sortedDocuments = useMemo(() => [...documents].sort((a, b) => compareDocuments(a, b, sortKey, sortAscending)), [documents, sortAscending, sortKey]);
  const expiryAlerts = useMemo(() => (data?.documents ?? [])
    .map((document) => ({ document, expiry: expiryState(document.expiresAt) }))
    .filter((item): item is { document: DocumentItem; expiry: ExpiryState } => Boolean(item.expiry && item.expiry.days <= 30))
    .sort((a, b) => a.expiry.days - b.expiry.days), [data]);
  const unreadNotificationCount = notifications.filter((item) => !item.read).length;

  const refreshBootstrap = useCallback(async () => {
    const next = await api.bootstrap();
    next.nodes = applyStoredNodeOrder(next.nodes);
    setData(next);
    return next;
  }, []);

  const refreshDocuments = useCallback(async (tab: AppTab) => {
    const next = await api.search(tab.query, tab.nodeId, tab.tagId);
    const filtered = searchTagIds.length ? next.filter((document) => searchTagIds.every((tagId) => document.tags.some((tag) => tag.id === tagId))) : next;
    setDocuments(filtered);
    setSelectedIds((current) => new Set([...current].filter((id) => filtered.some((item) => item.id === id))));
  }, [searchTagIds]);

  const refreshAll = useCallback(async () => {
    await refreshBootstrap();
    await refreshDocuments(activeTab);
  }, [activeTab, refreshBootstrap, refreshDocuments]);

  const checkForUpdates = useCallback(async (manual = true) => {
    if (!api.isDesktop) {
      setUpdateUi({ phase: "current", message: "浏览器预览模式不检查桌面更新" });
      return;
    }
    const startedAt = performance.now();
    setUpdateUi({ phase: "checking", message: "正在连接 GitHub 更新服务…" });
    const slowTimer = window.setTimeout(() => setUpdateUi((current) => current.phase === "checking"
      ? { ...current, message: "主更新地址响应较慢，正在尝试备用地址…" }
      : current), 1_500);
    try {
      const info = await findUpdate();
      const lastCheckedAt = Date.now();
      const elapsed = formatElapsed(performance.now() - startedAt);
      if (info) setUpdateUi({ phase: "available", info, lastCheckedAt, message: `已连接 GitHub（${elapsed}），发现新版本 ${info.version}` });
      else setUpdateUi({ phase: "current", lastCheckedAt, message: `已连接 GitHub（${elapsed}）；当前已是最新版本` });
    } catch (reason) {
      const failure = describeUpdateFailure(reason);
      const elapsed = formatElapsed(performance.now() - startedAt);
      setUpdateUi({ phase: "error", failure, lastCheckedAt: Date.now(), message: `${failure.message}（耗时 ${elapsed}）` });
      if (!manual) console.info("EazyLedger automatic update check failed", failure.detail);
    } finally {
      window.clearTimeout(slowTimer);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!updateUi.info) return;
    const info = updateUi.info;
    setUpdateUi({ phase: "downloading", info, percent: 0, message: "正在下载并验证更新…" });
    try {
      await installPendingUpdate((progress) => {
        setUpdateUi({ phase: "downloading", info, percent: progress.percent, message: progress.percent === null ? "正在下载更新…" : `正在下载更新… ${progress.percent}%` });
      });
    } catch (reason) {
      const failure = describeUpdateFailure(reason);
      setUpdateUi({ phase: "error", info, failure, message: `安装未完成：${failure.message}` });
    }
  }, [updateUi.info]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshBootstrap();
        await refreshDocuments(initialTab);
        if (api.isDesktop) void api.warmDocPreviews().catch((reason) => console.info("DOC preview warmup skipped", reason));
      }
      catch (reason) { setError(String(reason)); }
      finally { setLoading(false); }
    })();
  }, [refreshBootstrap, refreshDocuments]);

  useEffect(() => {
    if (!api.isDesktop) return;
    void (async () => {
      try {
        const version = await currentVersion();
        setAppVersion(version);
        const issue = previousInstallIssue(version);
        if (issue) setSettingsNotice(issue);
      } catch { /* 版本读取失败不影响资料库使用 */ }
      await checkForUpdates(false);
    })();
  }, [checkForUpdates]);

  useEffect(() => {
    if (!data) return;
    const timer = window.setTimeout(() => void refreshDocuments(activeTab), 120);
    return () => window.clearTimeout(timer);
  }, [activeTab, data, refreshDocuments]);

  useEffect(() => {
    if (!api.isDesktop) return;
    const nodes = data?.nodes ?? [];
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setExternalDragging(!nativeDraggedIdsRef.current?.length);
      }
      if (event.payload.type === "leave") setExternalDragging(false);
      if (event.payload.type === "drop") {
        setExternalDragging(false);
        const payload = event.payload;
        void (async () => {
          const scaleFactor = await getCurrentWindow().scaleFactor();
          const x = payload.position.x / scaleFactor;
          const y = payload.position.y / scaleFactor;
          const fileDrag: PointerDragState = { kind: "files", ids: [], label: "", x, y };
          const targetNodeId = resolvePointerTarget(x, y, fileDrag, nodes)?.nodeId;
          const internalIds = nativeDraggedIdsRef.current;
          nativeDraggedIdsRef.current = null;
          if (internalIds?.length) {
            if (targetNodeId) await moveFiles(internalIds, targetNodeId);
            return;
          }
          await importPaths(payload.paths, targetNodeId ?? activeTab.nodeId ?? "root");
        })();
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [activeTab.nodeId, data?.nodes]);

  useEffect(() => {
    const nodes = data?.nodes ?? [];
    const clearPointerDrag = () => {
      pointerCandidateRef.current = null;
      pointerDragRef.current = null;
      setPointerDrag(null);
      setPointerDropTarget(null);
      document.body.classList.remove("internal-pointer-dragging");
    };
    const handlePointerMove = (event: PointerEvent) => {
      const candidate = pointerCandidateRef.current;
      if (!candidate || candidate.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { clearPointerDrag(); return; }
      let active = pointerDragRef.current;
      if (!active) {
        if (Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) < 6) return;
        if (candidate.kind === "files") {
          const paths = candidate.nativePaths;
          const dragIds = candidate.ids;
          nativeDraggedIdsRef.current = dragIds;
          clearPointerDrag();
          suppressPointerClickRef.current = true;
          window.setTimeout(() => { suppressPointerClickRef.current = false; }, 0);
          event.preventDefault();
          if (!paths) return;
          void paths
            .then((resolved) => api.startNativeFileDrag(resolved))
            .catch((reason) => {
              nativeDraggedIdsRef.current = null;
              setError(`无法拖出文件：${String(reason)}`);
            })
            .finally(() => window.setTimeout(() => {
              if (nativeDraggedIdsRef.current === dragIds) nativeDraggedIdsRef.current = null;
            }, 1_200));
          return;
        }
        active = { kind: "node", nodeId: candidate.nodeId, label: candidate.label, x: event.clientX, y: event.clientY };
        pointerDragRef.current = active;
        document.body.classList.add("internal-pointer-dragging");
      } else active = { ...active, x: event.clientX, y: event.clientY };
      event.preventDefault();
      setPointerDrag(active);
      setPointerDropTarget(resolvePointerTarget(event.clientX, event.clientY, active, nodes));
    };
    const handlePointerEnd = (event: PointerEvent) => {
      const candidate = pointerCandidateRef.current;
      if (!candidate || candidate.pointerId !== event.pointerId) return;
      const active = pointerDragRef.current;
      if (active) {
        event.preventDefault();
        const dropTarget = resolvePointerTarget(event.clientX, event.clientY, active, nodes);
        if (dropTarget && active.kind === "node") {
          const source = nodes.find((node) => node.id === active.nodeId);
          const target = nodes.find((node) => node.id === dropTarget.nodeId);
          if (source && target) void moveNodeByDrop(source, target, dropTarget.position);
        }
        suppressPointerClickRef.current = true;
        window.setTimeout(() => { suppressPointerClickRef.current = false; }, 0);
      }
      clearPointerDrag();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd, { passive: false });
    window.addEventListener("pointercancel", handlePointerEnd, { passive: false });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.classList.remove("internal-pointer-dragging");
    };
  }, [data?.nodes]);

  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    let cancelled = false;
    let retryTimer: number | undefined;
    setPreview(null);

    const loadPreview = async () => {
      try {
        const next = await api.getPreview(selected.id);
        if (cancelled) return;
        setPreview(next);
        if (next.kind === "loading") retryTimer = window.setTimeout(() => void loadPreview(), 350);
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      }
    };

    void loadPreview();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [selected?.id]);

  useEffect(() => { localStorage.setItem("document-ledger.preview-open", String(previewOpen)); }, [previewOpen]);

  useEffect(() => {
    localStorage.setItem("document-ledger.file-sort", JSON.stringify({ key: sortKey, ascending: sortAscending }));
  }, [sortAscending, sortKey]);

  useEffect(() => {
    if (!data) return;
    setNotifications((current) => {
      const known = new Set(current.map((item) => item.id));
      const additions = expiryAlerts.flatMap(({ document, expiry }) => {
        const tone: LedgerNotification["tone"] = expiry.kind === "expired" ? "expired" : expiry.kind === "today" ? "today" : "due-soon";
        const id = `${document.id}:${document.expiresAt}:${tone}`;
        if (known.has(id)) return [];
        return [{ id, documentId: document.id, title: document.name, message: expiry.label, tone, createdAt: Date.now(), read: false } satisfies LedgerNotification];
      });
      if (!additions.length) return current;
      const next = [...additions, ...current].slice(0, 200);
      writeNotifications(next);
      return next;
    });
  }, [data, expiryAlerts]);

  useEffect(() => {
    const close = () => { setContextMenu(null); setTagMenu(null); setExpiryMenu(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.ctrlKey && event.key.toLowerCase() === "a") { event.preventDefault(); setSelectedIds(new Set(documents.map((item) => item.id))); }
      if (event.ctrlKey && event.key.toLowerCase() === "c" && selectedIds.size) { event.preventDefault(); void copyFilesToClipboard([...selectedIds]); }
      if (event.ctrlKey && event.key.toLowerCase() === "x" && selectedIds.size) { event.preventDefault(); setClipboard({ mode: "cut", ids: [...selectedIds] }); }
      if (event.ctrlKey && event.key.toLowerCase() === "v") { event.preventDefault(); void pasteAvailableClipboard(); }
      if (event.key === "F2" && selectedIds.size === 1) { event.preventDefault(); void renameSelected(); }
      if (event.key === "Delete" && selectedIds.size) { event.preventDefault(); void deleteSelected(); }
      if (event.key === "Escape") { setSelectedIds(new Set()); setContextMenu(null); setDialog(null); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [clipboard, documents, selectedIds, activeTab.nodeId, activeTab.view, data]);

  function updateActive(patch: Partial<AppTab>) {
    setTabs((current) => current.map((tab) => tab.id === activeTabId ? { ...tab, ...patch } : tab));
  }

  function locationOf(tab: AppTab): AppTabHistoryEntry {
    return { title: tab.title, view: tab.view, nodeId: tab.nodeId, tagId: tab.tagId, query: tab.query };
  }

  function navigateActive(patch: Partial<AppTab>) {
    setTabs((current) => current.map((tab) => {
      if (tab.id !== activeTabId) return tab;
      const next = { ...tab, ...patch };
      const before = locationOf(tab);
      const after = locationOf(next);
      const changed = before.title !== after.title || before.view !== after.view || before.nodeId !== after.nodeId || before.tagId !== after.tagId || before.query !== after.query;
      return changed ? { ...next, history: [...tab.history, before].slice(-50) } : next;
    }));
  }

  function goBack() {
    setTabs((current) => current.map((tab) => {
      if (tab.id !== activeTabId || !tab.history.length) return tab;
      const previous = tab.history[tab.history.length - 1];
      return { ...tab, ...previous, history: tab.history.slice(0, -1) };
    }));
    setSearchTagIds([]);
    setSelectedIds(new Set());
  }

  function selectNode(node: NodeItem) {
    setTagMenu(null);
    setSearchTagIds([]);
    navigateActive({ title: node.name, view: "files", nodeId: node.id, tagId: null, query: "" });
    setSelectedIds(new Set());
  }

  function selectTag(tag: Tag) {
    setTagMenu(null);
    setSearchTagIds([]);
    navigateActive({ title: `# ${tag.name}`, view: "files", nodeId: null, tagId: tag.id, query: "" });
    setSelectedIds(new Set());
  }

  function addTab() {
    const id = crypto.randomUUID();
    setTabs((current) => [...current, { ...initialTab, id }]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    if (tabs.length === 1) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (id === activeTabId) setActiveTabId(next[Math.max(0, index - 1)].id);
  }

  async function runAction(action: () => Promise<void>) {
    try { setLoading(true); await action(); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }

  async function importPaths(paths: string[], nodeId: string) {
    await runAction(async () => { await api.importPaths(paths, nodeId); await refreshAll(); await api.warmDocPreviews(); });
  }

  async function chooseImport() {
    await runAction(async () => { await api.chooseAndImport(activeTab.nodeId ?? "root"); await refreshAll(); await api.warmDocPreviews(); });
  }

  async function chooseImportFolder() {
    await runAction(async () => { await api.chooseAndImportFolder(activeTab.nodeId ?? "root"); await refreshAll(); await api.warmDocPreviews(); });
  }

  function addNode(parentId = activeTab.nodeId ?? "root") {
    setDialog({
      kind: "input", title: "新建节点", description: "节点将创建在当前台账层级下。", placeholder: "请输入节点名称", confirmLabel: "创建节点",
      onConfirm: (name) => void runAction(async () => { await api.createNode(parentId, name); await refreshBootstrap(); }),
    });
  }

  function addTag(documentIds: string[] = [...selectedIds]) {
    setTagEditor({ mode: "create", documentIds });
  }

  function goHome() {
    navigateActive({ title: "主页", view: "home", nodeId: null, tagId: null, query: "" });
    setSearchTagIds([]);
    setSelectedIds(new Set());
  }

  function toggleSearchTag(tagId: string) {
    setSearchTagIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]);
    if (activeTab.view !== "files") navigateActive({ view: "files", title: "搜索" });
  }

  function updateSearchQuery(query: string) {
    const patch: Partial<AppTab> = { view: query || searchTagIds.length ? "files" : activeTab.view, title: query ? "搜索" : activeTab.title, query };
    if (query && activeTab.view !== "files") navigateActive(patch);
    else updateActive(patch);
  }

  function openSettings() {
    navigateActive({ title: "设置", view: "settings", nodeId: null, tagId: null, query: "" });
    setSelectedIds(new Set());
  }

  function goUp() {
    if (activeTab.view === "home") return;
    if (activeTab.tagId || !activeTab.nodeId) { goHome(); return; }
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (!node?.parentId) goHome();
    else { const parent = data?.nodes.find((item) => item.id === node.parentId); if (parent) selectNode(parent); else goHome(); }
  }

  function handleRowSelect(event: ReactMouseEvent, document: DocumentItem, index: number) {
    if (event.shiftKey && lastSelectedIndex.current !== null) {
      const [start, end] = [lastSelectedIndex.current, index].sort((a, b) => a - b);
      setSelectedIds(new Set(sortedDocuments.slice(start, end + 1).map((item) => item.id)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedIds((current) => { const next = new Set(current); next.has(document.id) ? next.delete(document.id) : next.add(document.id); return next; });
      lastSelectedIndex.current = index;
    } else {
      setSelectedIds(new Set([document.id]));
      lastSelectedIndex.current = index;
    }
  }

  function toggleDocumentSelection(documentId: string, index: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
    lastSelectedIndex.current = index;
  }

  function beginFilePointerDrag(event: ReactPointerEvent, document: DocumentItem) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, a, select, textarea")) return;
    const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id];
    if (!selectedIds.has(document.id)) setSelectedIds(new Set([document.id]));
    pointerCandidateRef.current = {
      kind: "files", ids, label: ids.length > 1 ? `${ids.length} 个文件` : document.name,
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      nativePaths: api.documentPaths(ids),
    };
  }

  function beginNodePointerDrag(event: ReactPointerEvent, node: NodeItem) {
    if (node.id === "root" || event.button !== 0 || (event.target as HTMLElement).closest("button, input, a, select, textarea")) return;
    event.stopPropagation();
    pointerCandidateRef.current = {
      kind: "node", nodeId: node.id, label: node.name,
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    };
  }

  async function moveFiles(ids: string[], nodeId: string) {
    await runAction(async () => { await api.moveDocuments(ids, nodeId); setSelectedIds(new Set()); await refreshAll(); });
  }

  async function copyFiles(ids: string[], nodeId: string) {
    await runAction(async () => { await api.copyDocuments(ids, nodeId); await refreshAll(); });
  }

  async function copyFilesToClipboard(ids: string[]) {
    setClipboard({ mode: "copy", ids });
    if (!api.isDesktop) return;
    try {
      const count = await api.copyDocumentsToClipboard(ids);
      if (!count) setError("没有可复制的资料");
    } catch (reason) {
      setError(`无法复制到 Windows 文件剪贴板：${String(reason)}`);
    }
  }

  async function pasteAvailableClipboard() {
    if (activeTab.view === "settings") return;
    const target = activeTab.nodeId ?? ROOT_FALLBACK(data);
    let imported = 0;
    await runAction(async () => {
      imported = await api.importClipboardFiles(target);
      if (imported) {
        setClipboard(null);
        await refreshAll();
        await api.warmDocPreviews();
      }
    });
    if (imported) return;
    if (clipboard) {
      if (clipboard.mode === "copy") await copyFiles(clipboard.ids, target);
      else { await moveFiles(clipboard.ids, target); setClipboard(null); }
      return;
    }
    setError("剪贴板中没有可导入的文件或文件夹");
  }

  async function openTrashCenter() {
    await runAction(async () => {
      setTrashItems(await api.listTrash());
      setTrashOpen(true);
    });
  }

  async function restoreTrashItem(trashId: string) {
    await runAction(async () => {
      await api.restoreTrashItem(trashId);
      setTrashItems(await api.listTrash());
      await refreshAll();
    });
  }

  function requestEmptyTrash() {
    if (!trashItems.length) return;
    setDialog({
      kind: "confirm", tone: "danger", title: "清空应用回收站？", description: `将永久删除回收站中的 ${trashItems.length} 个文件，无法恢复。`, confirmLabel: "永久清空",
      onConfirm: () => void runAction(async () => {
        await api.emptyTrash();
        setTrashItems([]);
        await refreshBootstrap();
      }),
    });
  }

  async function savePreferences(deleteMode: DeleteMode, tagDisplayLimit: number) {
    await runAction(async () => {
      await api.updatePreferences(deleteMode, tagDisplayLimit);
      await refreshBootstrap();
      setSettingsNotice("文件管理设置已保存");
    });
  }

  function renameSelected() {
    const document = selectedDocuments[0];
    if (selectedDocuments.length !== 1 || !document) return;
    setDialog({
      kind: "input", title: "重命名文件", description: "扩展名留空时将自动保留原文件类型。", initialValue: document.name, confirmLabel: "保存名称",
      onConfirm: (name) => { if (name !== document.name) void runAction(async () => { await api.renameDocument(document.id, name); await refreshAll(); }); },
    });
  }

  function deleteSelected() {
    if (!selectedIds.size || !data) return;
    const ids = [...selectedIds];
    const copy = deletionCopy(data.settings.deleteMode, ids.length, "文件");
    setDialog({
      kind: "confirm", tone: "danger", title: copy.title, description: copy.description, confirmLabel: copy.confirmLabel,
      onConfirm: () => void runAction(async () => { await api.deleteDocuments(ids); setSelectedIds(new Set()); await refreshAll(); }),
    });
  }

  async function toggleTagForDocuments(tag: Tag, documentIds: string[]) {
    const targetDocuments = documents.filter((document) => documentIds.includes(document.id));
    const appliedToAll = targetDocuments.length > 0 && targetDocuments.every((document) => document.tags.some((item) => item.id === tag.id));
    await runAction(async () => {
      if (appliedToAll) await api.removeTagsFromDocuments(documentIds, [tag.id]);
      else await api.addTagsToDocuments(documentIds, [tag.id]);
      await refreshAll();
    });
  }

  async function saveTagEditor(name: string, color: string) {
    if (!tagEditor) return;
    await runAction(async () => {
      if (tagEditor.mode === "create") {
        const tag = await api.createTag(name, color);
        if (tagEditor.documentIds.length) await api.addTagsToDocuments(tagEditor.documentIds, [tag.id]);
      } else if (tagEditor.tag) {
        if (name !== tagEditor.tag.name) await api.renameTag(tagEditor.tag.id, name);
        if (color !== tagEditor.tag.color) await api.updateTagColor(tagEditor.tag.id, color);
      }
      setTagEditor(null);
      await refreshAll();
    });
  }

  function renameNode(node: NodeItem) {
    if (node.id === "root") return;
    setDialog({
      kind: "input", title: "重命名节点", description: "节点内的文件和下级结构不会改变。", initialValue: node.name, confirmLabel: "保存名称",
      onConfirm: (name) => { if (name !== node.name) void runAction(async () => {
        await api.renameNode(node.id, name);
        if (activeTab.nodeId === node.id) updateActive({ title: name });
        await refreshBootstrap();
      }); },
    });
  }

  async function copyNode(node: NodeItem) {
    if (node.id === "root") return;
    await runAction(async () => { await api.copyNode(node.id, node.parentId ?? "root"); await refreshBootstrap(); });
  }

  function deleteNode(node: NodeItem) {
    if (node.id === "root" || !data) return;
    const copy = deletionCopy(data.settings.deleteMode, 1, "节点及其中资料");
    setDialog({
      kind: "confirm", tone: "danger", title: `删除“${node.name}”？`, description: copy.description, confirmLabel: copy.confirmLabel,
      onConfirm: () => void runAction(async () => {
        await api.deleteNode(node.id);
        if (activeTab.nodeId === node.id) goHome();
        await refreshAll();
      }),
    });
  }

  async function moveNodeTo(node: NodeItem, target: NodeItem) {
    await moveNodeByDrop(node, target, "inside");
  }

  async function moveNodeByDrop(node: NodeItem, target: NodeItem, position: NodeDropPosition) {
    if (node.id === "root" || node.id === target.id) return;
    const descendants = new Set(descendantNodeIds(node.id, data?.nodes ?? []));
    if (descendants.has(target.id)) { setError("不能将节点移动到自身或其下级节点"); return; }
    const parentId = position === "inside" ? target.id : target.parentId;
    if (!parentId) return;
    await runAction(async () => {
      if (node.parentId !== parentId) await api.moveNode(node.id, parentId);
      persistNodeOrderAfterDrop(data?.nodes ?? [], node.id, target.id, parentId, position);
      await refreshAll();
    });
  }

  async function promoteNode(node: NodeItem) {
    if (!data || node.id === "root" || !node.parentId) return;
    const parent = data.nodes.find((item) => item.id === node.parentId);
    const grandparent = parent?.parentId ? data.nodes.find((item) => item.id === parent.parentId) : undefined;
    if (grandparent) await moveNodeTo(node, grandparent);
  }

  async function demoteNode(node: NodeItem) {
    if (!data || node.id === "root" || !node.parentId) return;
    const siblings = data.nodes.filter((item) => item.parentId === node.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
    const index = siblings.findIndex((item) => item.id === node.id);
    if (index > 0) await moveNodeTo(node, siblings[index - 1]);
  }

  async function renameCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (node) await renameNode(node);
  }

  async function copyCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (node) await copyNode(node);
  }

  function moveCurrentNode() {
    if (!data) return;
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (!node || node.id === "root") return;
    setDialog({
      kind: "node-picker", title: `移动“${node.name}”`, description: "选择新的上级节点。自身及其下级节点不可选。", excludedIds: [node.id, ...descendantNodeIds(node.id, data.nodes)],
      onConfirm: (target) => void runAction(async () => { await api.moveNode(node.id, target.id); await refreshBootstrap(); }),
    });
  }

  async function deleteCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (node) await deleteNode(node);
  }

  function editTag(tag: Tag) { setTagEditor({ mode: "edit", tag, documentIds: [] }); }

  function removeTag(tag: Tag) {
    setDialog({
      kind: "confirm", tone: "danger", title: `删除标签“${tag.name}”？`, description: "标签会从所有资料中移除，但文件本身不会删除。", confirmLabel: "删除标签",
      onConfirm: () => void runAction(async () => { await api.deleteTag(tag.id); await refreshAll(); }),
    });
  }

  async function updateDocumentExpiry(documentId: string, expiresAt: number | null) {
    await runAction(async () => {
      await api.updateExpiry(documentId, expiresAt);
      setExpiryMenu(null);
      await refreshAll();
    });
  }

  async function toggleDocumentStar(document: DocumentItem) {
    await runAction(async () => {
      await api.setDocumentStarred(document.id, !document.starred);
      await refreshAll();
    });
  }

  function setSort(next: SortKey) {
    if (next === sortKey) setSortAscending((value) => !value);
    else { setSortKey(next); setSortAscending(next !== "modified"); }
  }

  function markAllNotificationsRead() {
    setNotifications((current) => {
      const next = current.map((item) => ({ ...item, read: true }));
      writeNotifications(next);
      return next;
    });
  }

  function openNotification(item: LedgerNotification) {
    setNotifications((current) => {
      const next = current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry);
      writeNotifications(next);
      return next;
    });
    const document = data?.documents.find((entry) => entry.id === item.documentId);
    const node = document && data?.nodes.find((entry) => entry.id === document.nodeId);
    if (node && document) {
      selectNode(node);
      setSelectedIds(new Set([document.id]));
      setNotificationCenterOpen(false);
    }
  }

  if (!data) return <div className="splash">{error ? `无法启动：${error}` : "正在打开 EazyLedger…"}</div>;
  const breadcrumb = breadcrumbFor(activeTab.nodeId, data.nodes);

  return <main className="app-shell">
    <nav className="tabs" aria-label="标签页">
      {tabs.map((tab) => <button className={`tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id} onClick={() => setActiveTabId(tab.id)}>{tab.view === "home" ? <House size={15} /> : tab.view === "settings" ? <Settings size={15} /> : <Folder size={15} />}<span>{tab.title}</span><X className="tab-close" size={14} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} /></button>)}
      <button className="new-tab" title="新建标签页" onClick={addTab}><Plus size={17} /></button>
    </nav>
    <section className="toolbar">
      <div className="nav-buttons"><button onClick={goBack} disabled={!activeTab.history.length} title="返回"><ArrowLeft size={18} /></button><button onClick={goUp} disabled={activeTab.view === "home"} title="上一级"><ArrowUp size={18} /></button></div>
      <div className="address-bar"><button className="home-crumb" onClick={goHome}><House size={16} />主页</button>{breadcrumb.map((part) => <span className="crumb" key={part.id} onClick={() => selectNode(part)}><ChevronRight size={14} />{part.name}</span>)}{activeTab.tagId && <span className="crumb"><ChevronRight size={14} />{activeTab.title}</span>}</div>
      <div className="search-box"><Search size={17} /><input disabled={activeTab.view === "settings"} value={activeTab.query} onChange={(event) => updateSearchQuery(event.target.value)} placeholder={activeTab.view === "settings" ? "设置页面" : "搜索名称、标签、备注和正文"} />{activeTab.query && <button onClick={() => updateActive({ query: "" })}><X size={15} /></button>}<SearchTagFilter tags={data.tags} selectedIds={searchTagIds} disabled={activeTab.view === "settings"} onToggle={toggleSearchTag} onClear={() => setSearchTagIds([])} /></div>
    </section>
    <section className="commandbar">
      <button className="primary" onClick={() => void chooseImport()}><Import size={16} />导入资料</button>
      <button onClick={() => void chooseImportFolder()}><FolderInput size={16} />导入文件夹</button>
      <button onClick={() => void addNode()}><FolderPlus size={16} />新建节点</button>
      <button onClick={() => void addTag()}><Tags size={16} />新建标签</button>
      <button disabled={activeTab.view === "settings"} onClick={() => void pasteAvailableClipboard()} title="支持应用内复制及资源管理器复制的文件"><ClipboardPaste size={16} />粘贴</button>
      <CommandMenu>
        <button onClick={() => void renameCurrentNode()}>重命名当前节点</button><button onClick={() => void copyCurrentNode()}>复制当前节点及内容</button><button onClick={() => void moveCurrentNode()}>移动当前节点</button><button className="danger" onClick={() => void deleteCurrentNode()}>删除当前节点</button>
        <hr /><button onClick={() => void api.exportManifest()}><Download size={14} />导出台账</button><button onClick={() => void api.createBackup()}><Archive size={14} />完整备份</button>
      </CommandMenu>
      <span className="command-spacer" />
      <button className="trash-button" title="打开应用回收站" onClick={() => void openTrashCenter()}><Trash2 size={16} />回收站{data.settings.trashCount > 0 && <span>{data.settings.trashCount > 99 ? "99+" : data.settings.trashCount}</span>}</button>
      <button className={`notification-button ${unreadNotificationCount ? "has-alerts" : ""}`} title="打开通知中心" onClick={() => setNotificationCenterOpen(true)}><Bell size={16} />通知{unreadNotificationCount > 0 && <span>{unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}</span>}</button>
      <button onClick={openSettings}><Settings size={16} />设置</button>
      <button onClick={() => setPreviewOpen((open) => !open)}>{previewOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}{previewOpen ? "隐藏预览" : "显示预览"}</button>
    </section>
    {activeTab.view === "home" ? <HomeView data={data} expiryAlerts={expiryAlerts} recentDocuments={[...data.documents].sort((a, b) => Number(b.starred) - Number(a.starred) || b.modifiedAt - a.modifiedAt).slice(0, 10)} onOpenNode={selectNode} onOpenTag={selectTag} onOpenDocument={(document) => { const node = data.nodes.find((item) => item.id === document.nodeId); if (node) selectNode(node); setSelectedIds(new Set([document.id])); }} onTagMenu={(event, tag) => { event.stopPropagation(); setTagMenu({ x: event.clientX, y: event.clientY, documentIds: [], sourceTagId: tag.id }); }} /> : activeTab.view === "settings" ? <SettingsView vaultPath={data.vaultPath} settings={data.settings} previewOpen={previewOpen} notice={settingsNotice} appVersion={appVersion} updateUi={updateUi} onPreviewChange={setPreviewOpen} onCheckUpdate={() => checkForUpdates(true)} onInstallUpdate={installUpdate} onRevealVault={() => runAction(() => api.revealVault())} onBackup={() => runAction(async () => { await api.createBackup(); })} onSavePreferences={savePreferences} onRevealTrash={() => runAction(() => api.revealTrash())} onChangeTrash={() => runAction(async () => { const result = await api.changeTrashLocation(); if (result) { setSettingsNotice(result); await refreshBootstrap(); } })} onOpenTrash={() => void openTrashCenter()} onRequestEmptyVault={() => setDialog({ kind: "confirm", title: "使用空资料库？", description: "新位置将创建空资料库，现有资料仍完整保留在旧位置。切换将在重启后生效。", confirmLabel: "继续选择位置", onConfirm: () => void runAction(async () => { const result = await api.changeVaultLocation(false); if (result) setSettingsNotice(result); }) })} onChangeVault={() => runAction(async () => { const result = await api.changeVaultLocation(true); if (result) setSettingsNotice(result); })} /> : <section className={`workspace ${previewOpen ? "with-preview" : ""}`}>
      <aside className="sidebar custom-scrollbar">
        <SidebarSection storageKey="ledger-tree" title="台账架构" action={<FolderPlus size={14} />} onAction={() => void addNode()}>
          <Tree nodes={data.nodes} selectedId={activeTab.nodeId} pointerDrag={pointerDrag} dropTarget={pointerDropTarget} onSelect={(node) => { if (!suppressPointerClickRef.current) selectNode(node); }} onNodePointerDown={beginNodePointerDrag} onPromote={(node) => void promoteNode(node)} onDemote={(node) => void demoteNode(node)} onAdd={(node) => void addNode(node.id)} onRename={(node) => void renameNode(node)} onCopy={(node) => void copyNode(node)} onDelete={(node) => void deleteNode(node)} />
        </SidebarSection>
        <SidebarSection storageKey="tags" title="标签" action={<Plus size={14} />} onAction={() => void addTag()}>
          <div className="tag-list">{data.tags.map((tag) => <div className={`tag-row ${activeTab.tagId === tag.id ? "selected" : ""}`} key={tag.id}>
            <button className="tag-main" onClick={() => selectTag(tag)}><span className="tag-dot" style={{ background: tag.color }} /><span>{tag.name}</span><small>{tag.documentCount}</small></button>
            <button className="mini-action" title="编辑名称和颜色" onClick={() => editTag(tag)}><Pencil size={12} /></button>
            <button className="mini-action danger" title="删除标签" onClick={() => void removeTag(tag)}><Trash2 size={12} /></button>
          </div>)}</div>
        </SidebarSection>
      </aside>
      <section className="file-pane">
        {selectedIds.size > 1 && <div className="selection-bar">
          <CheckSquare size={16} /><strong>已选 {selectedIds.size} 项</strong>
          <button onClick={() => void copyFilesToClipboard([...selectedIds])}><Copy size={14} />复制</button>
          <button onClick={() => setClipboard({ mode: "cut", ids: [...selectedIds] })}><Scissors size={14} />剪切</button>
          <button onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setTagMenu({ x: rect.left, y: rect.bottom, documentIds: [...selectedIds] }); }}><Tags size={14} />标签</button>
          <button className="danger" onClick={() => deleteSelected()}><Trash2 size={14} />删除</button>
          <button className="selection-close" onClick={() => setSelectedIds(new Set())}><X size={14} /></button>
        </div>}
        <div className="list-header">
          <input type="checkbox" checked={documents.length > 0 && selectedIds.size === documents.length} onChange={(event) => setSelectedIds(event.target.checked ? new Set(documents.map((item) => item.id)) : new Set())} />
          <span className="sort-heading"><button onClick={() => setSort("name")}>文件 <ArrowDownAZ size={13} /></button><select value={sortKey} aria-label="文件排序方式" onChange={(event) => setSort(event.target.value as SortKey)}><option value="modified">修改时间</option><option value="name">名称</option><option value="extension">文件类型</option><option value="size">大小</option><option value="expiry">有效期</option></select><button className="sort-direction" title={sortAscending ? "当前升序，点击切换降序" : "当前降序，点击切换升序"} onClick={() => setSortAscending((value) => !value)}>{sortAscending ? "↑" : "↓"}</button></span><button onClick={() => setSort("modified")}>修改日期</button><button onClick={() => setSort("size")}>大小</button><span className="star-column" title="星标文件始终置顶"><Star size={13} /></span>
        </div>
        <div className="file-list custom-scrollbar">
          {sortedDocuments.map((document, index) => {
            const expiry = expiryState(document.expiresAt);
            const visibleTags = document.tags.slice(0, data.settings.tagDisplayLimit);
            const hiddenTagCount = Math.max(0, document.tags.length - visibleTags.length);
            return <div
              className={`file-row ${document.starred ? "starred" : ""} ${selectedIds.has(document.id) ? "selected" : ""} ${pointerDrag?.kind === "files" && pointerDrag.ids.includes(document.id) ? "dragging" : ""} ${clipboard?.mode === "cut" && clipboard.ids.includes(document.id) ? "cut" : ""} ${expiry?.kind ?? ""}`}
              key={document.id} onPointerDown={(event) => beginFilePointerDrag(event, document)}
              onClick={(event) => { if (!suppressPointerClickRef.current) handleRowSelect(event, document, index); }} onDoubleClick={() => { if (!suppressPointerClickRef.current) void api.openDocument(document.id); }}
              onContextMenu={(event) => { event.preventDefault(); if (!selectedIds.has(document.id)) setSelectedIds(new Set([document.id])); setContextMenu({ x: event.clientX, y: event.clientY, documentId: document.id }); }}
            >
              <input type="checkbox" checked={selectedIds.has(document.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleDocumentSelection(document.id, index)} aria-label={`选择 ${document.name}`} />
              <span className="file-name"><span className="file-icon-wrap"><FileIcon extension={document.extension} />{document.starred && <Star className="star-corner" size={10} fill="currentColor" />}</span><span><span className="file-title-line"><strong title={document.name}>{document.name}</strong></span><small className="file-subtitle"><span className="file-kind">{document.extension.toUpperCase()} 文件</span>{expiry && <button className={`expiry-chip ${expiry.kind}`} title="修改有效期" onClick={(event) => { event.stopPropagation(); setExpiryMenu({ x: event.clientX, y: event.clientY, documentId: document.id }); }}><CalendarClock size={11} />{expiry.label}</button>}<span className="row-tags">{visibleTags.map((tag) => <button className="tag-chip compact" style={{ "--tag-color": tag.color } as CSSProperties} key={tag.id} onClick={(event) => { event.stopPropagation(); const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id]; setTagMenu({ x: event.clientX, y: event.clientY, documentIds: ids, sourceTagId: tag.id }); }} onDoubleClick={(event) => { event.stopPropagation(); selectTag(tag); }}>{tag.name}</button>)}{hiddenTagCount > 0 && <button className="tag-overflow" title={`还有 ${hiddenTagCount} 个标签`} onClick={(event) => { event.stopPropagation(); const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id]; setTagMenu({ x: event.clientX, y: event.clientY, documentIds: ids }); }}>+{hiddenTagCount}</button>}<button className="add-tag-chip compact" title="为文件添加标签" onClick={(event) => { event.stopPropagation(); const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id]; setTagMenu({ x: event.clientX, y: event.clientY, documentIds: ids }); }}><Plus size={9} /></button></span></small></span></span>
              <span>{formatDate(document.modifiedAt)}</span>
              <span>{formatSize(document.size)}</span>
              <button className={`row-star ${document.starred ? "active" : ""}`} title={document.starred ? "取消星标" : "设为星标并置顶"} aria-label={document.starred ? `取消 ${document.name} 的星标` : `为 ${document.name} 设置星标`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void toggleDocumentStar(document); }} onDoubleClick={(event) => event.stopPropagation()}><Star size={17} fill={document.starred ? "currentColor" : "none"} /></button>
            </div>;
          })}
          {!documents.length && !loading && <div className="empty-state"><FilePlus2 size={38} /><h3>这里还没有资料</h3><p>将文件或文件夹拖到窗口中，目录层级会自动保留。</p></div>}
        </div>
        <footer className="statusbar"><span>{documents.length} 个项目</span><span>{selectedIds.size ? `已选择 ${selectedIds.size} 个项目` : "Ctrl+A 全选 · F2 重命名 · Delete 删除"}</span></footer>
      </section>
      {previewOpen && <PreviewPane document={selected} preview={preview} allTags={data.tags} onChanged={refreshAll} />}
    </section>}
    {contextMenu && <FileContextMenu deleteMode={data.settings.deleteMode} menu={contextMenu} document={documents.find((item) => item.id === contextMenu.documentId)} onOpen={() => { setContextMenu(null); void api.openDocument(contextMenu.documentId); }} onReveal={() => { setContextMenu(null); void api.revealDocument(contextMenu.documentId); }} onCopy={() => { void copyFilesToClipboard([...selectedIds]); setContextMenu(null); }} onCut={() => { setClipboard({ mode: "cut", ids: [...selectedIds] }); setContextMenu(null); }} onRename={() => { setContextMenu(null); renameSelected(); }} onExpiry={() => { setExpiryMenu({ x: contextMenu.x, y: contextMenu.y, documentId: contextMenu.documentId }); setContextMenu(null); }} onStar={() => { const target = documents.find((item) => item.id === contextMenu.documentId); setContextMenu(null); if (target) void toggleDocumentStar(target); }} onDelete={() => { setContextMenu(null); deleteSelected(); }} />}
    {tagMenu && <TagBubbleMenu menu={tagMenu} documents={documents} tags={data.tags} onToggle={(tag) => void toggleTagForDocuments(tag, tagMenu.documentIds)} onEdit={(tag) => { setTagMenu(null); editTag(tag); }} onCreate={() => { const ids = tagMenu.documentIds; setTagMenu(null); addTag(ids); }} onOpenTag={(tag) => { setTagMenu(null); selectTag(tag); }} />}
    {tagEditor && <TagEditorModal state={tagEditor} suggestedColor={tagColors[data.tags.length % tagColors.length]} onCancel={() => setTagEditor(null)} onSave={(name, color) => void saveTagEditor(name, color)} />}
    {dialog && <AppDialogModal state={dialog} nodes={data.nodes} onCancel={() => setDialog(null)} />}
    {expiryMenu && <ExpiryBubbleMenu menu={expiryMenu} document={documents.find((item) => item.id === expiryMenu.documentId)} onSave={(expiresAt) => void updateDocumentExpiry(expiryMenu.documentId, expiresAt)} />}
    {externalDragging && <div className="drop-overlay"><Import size={46} /><strong>释放鼠标，导入到“{activeTab.title}”</strong><span>文件夹层级会自动创建为台账树</span></div>}
    {pointerDrag && <div className={`pointer-drag-ghost ${pointerDropTarget ? "can-drop" : ""}`} style={{ left: pointerDrag.x + 14, top: pointerDrag.y + 14 }}>
      {pointerDrag.kind === "files" ? <Files size={17} /> : <FolderInput size={17} />}<span><strong>{pointerDrag.label}</strong><small>{pointerDropTarget ? pointerDrag.kind === "files" ? "松开即可移动文件" : pointerDropTarget.position === "inside" ? "松开设为子节点" : pointerDropTarget.position === "before" ? "松开插到节点前" : "松开插到节点后" : "拖到左侧台账节点"}</small></span>
    </div>}
    {trashOpen && <TrashCenter items={trashItems} path={data.settings.trashPath} onClose={() => setTrashOpen(false)} onReveal={() => void runAction(() => api.revealTrash())} onRestore={(trashId) => void restoreTrashItem(trashId)} onEmpty={requestEmptyTrash} />}
    {notificationCenterOpen && <><button className="notification-scrim" aria-label="关闭通知中心" onClick={() => setNotificationCenterOpen(false)} /><aside className="notification-center"><header><div><Bell size={20} /><span><strong>通知中心</strong><small>有效期告警与历史通知</small></span></div><button title="关闭" onClick={() => setNotificationCenterOpen(false)}><X size={17} /></button></header><section className="notification-summary"><span><AlertTriangle size={16} />当前需关注 <strong>{expiryAlerts.length}</strong> 份</span>{unreadNotificationCount > 0 && <button onClick={markAllNotificationsRead}><Check size={14} />全部已读</button>}</section><div className="notification-history custom-scrollbar">{notifications.length ? notifications.map((item) => <button className={`${item.read ? "read" : "unread"} ${item.tone}`} key={item.id} onClick={() => openNotification(item)}><span className="notification-status" /><span><strong>{item.title}</strong><small>{item.message} · {formatDate(item.createdAt, true)}</small></span>{!item.read && <i>新</i>}</button>) : <div className="notification-empty"><History size={30} /><strong>暂无历史通知</strong><span>临期或过期状态出现后会记录在这里</span></div>}</div><footer>最多保留最近 200 条记录</footer></aside></>}
    {loading && <div className="progress-line" />}
    {error && <div className="toast" onClick={() => setError(null)}>{error}<X size={14} /></div>}
  </main>;
}

function ROOT_FALLBACK(data: BootstrapData | null) { return data?.nodes.find((node) => node.parentId === null)?.id ?? "root"; }

function deletionCopy(mode: DeleteMode, count: number, noun: string) {
  if (mode === "system") return { title: `移入系统回收站？`, description: `将把选中的 ${count} 个${noun}移入 Windows 回收站，可从系统回收站恢复。`, confirmLabel: "移入系统回收站" };
  if (mode === "permanent") return { title: "永久删除？", description: `将永久删除选中的 ${count} 个${noun}，此操作无法撤销。`, confirmLabel: "永久删除" };
  return { title: "移入应用回收站？", description: `将把选中的 ${count} 个${noun}移入 EazyLedger 回收站，可在应用内恢复。`, confirmLabel: "移入应用回收站" };
}

function resolvePointerTarget(x: number, y: number, drag: PointerDragState, nodes: NodeItem[]) {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-ledger-node-id]");
  const targetId = row?.dataset.ledgerNodeId;
  if (!targetId || !nodes.some((node) => node.id === targetId)) return null;
  if (drag.kind === "node" && (drag.nodeId === targetId || descendantNodeIds(drag.nodeId, nodes).includes(targetId))) return null;
  if (drag.kind === "files" || nodes.find((node) => node.id === targetId)?.parentId === null || !row) return { nodeId: targetId, position: "inside" } satisfies PointerDropTarget;
  const rect = row.getBoundingClientRect();
  const ratio = (y - rect.top) / Math.max(rect.height, 1);
  const position: NodeDropPosition = ratio < .28 ? "before" : ratio > .72 ? "after" : "inside";
  return { nodeId: targetId, position } satisfies PointerDropTarget;
}

function CommandMenu({ children }: { children: ReactNode }) {
  return <details className="command-menu"><summary title="更多操作"><MoreHorizontal size={18} /></summary><div>{children}</div></details>;
}

function FileContextMenu({ menu, document, deleteMode, onOpen, onReveal, onCopy, onCut, onRename, onExpiry, onStar, onDelete }: { menu: ContextMenuState & {}; document?: DocumentItem; deleteMode: DeleteMode; onOpen: () => void; onReveal: () => void; onCopy: () => void; onCut: () => void; onRename: () => void; onExpiry: () => void; onStar: () => void; onDelete: () => void }) {
  return <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
    <header>{document?.name}</header><button onClick={onOpen}>打开</button><button onClick={onReveal}>在资源管理器中显示</button><button onClick={onStar}><Star size={14} fill={document?.starred ? "currentColor" : "none"} />{document?.starred ? "取消星标" : "设为星标并置顶"}</button><hr /><button onClick={onCopy}><Copy size={14} />复制</button><button onClick={onCut}><Scissors size={14} />剪切</button><button onClick={onRename}><Pencil size={14} />重命名</button><button onClick={onExpiry}><CalendarClock size={14} />{document?.expiresAt ? "修改有效期" : "设置有效期"}</button><hr /><button className="danger" onClick={onDelete}><Trash2 size={14} />{deleteMode === "app" ? "移入应用回收站" : deleteMode === "system" ? "移入系统回收站" : "永久删除"}</button>
  </div>;
}

function SearchTagFilter({ tags, selectedIds, disabled, onToggle, onClear }: { tags: Tag[]; selectedIds: string[]; disabled: boolean; onToggle: (tagId: string) => void; onClear: () => void }) {
  return <details className="search-tag-filter">
    <summary className={selectedIds.length ? "active" : ""} aria-label="按标签筛选" onClick={(event) => disabled && event.preventDefault()}><Tags size={14} /><span>{selectedIds.length ? `${selectedIds.length} 个标签` : "标签"}</span><ChevronDown size={12} /></summary>
    <div className="search-tag-popover" onClick={(event) => event.stopPropagation()}><header><strong>同时包含以下标签</strong>{selectedIds.length > 0 && <button onClick={onClear}>清除</button>}</header><div>{tags.map((tag) => <label className={selectedIds.includes(tag.id) ? "selected" : ""} key={tag.id}><input type="checkbox" checked={selectedIds.includes(tag.id)} onChange={() => onToggle(tag.id)} /><span className="tag-dot" style={{ background: tag.color }} /><span>{tag.name}</span><small>{tag.documentCount}</small></label>)}{tags.length === 0 && <p>还没有标签</p>}</div><footer>标签之间为“且”，并与关键字共同筛选</footer></div>
  </details>;
}

function ExpiryBubbleMenu({ menu, document, onSave }: { menu: ExpiryMenuState & {}; document?: DocumentItem; onSave: (expiresAt: number | null) => void }) {
  const [value, setValue] = useState(formatDateInput(document?.expiresAt ?? null));
  const state = expiryState(document?.expiresAt ?? null);
  const applyDays = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); date.setHours(23, 59, 59, 999); onSave(date.getTime()); };
  return <div className="context-menu expiry-bubble-menu" style={{ left: Math.min(menu.x, window.innerWidth - 290), top: Math.min(menu.y + 8, window.innerHeight - 300) }} onClick={(event) => event.stopPropagation()}>
    <header>{document?.name ?? "设置有效期"}</header>{state && <div className={`expiry-menu-current ${state.kind}`}><CalendarClock size={15} /><strong>{state.label}</strong></div>}
    <label>到期日期<input autoFocus type="date" value={value} onChange={(event) => setValue(event.target.value)} /></label>
    <div className="expiry-quick"><button onClick={() => applyDays(7)}>7 天后</button><button onClick={() => applyDays(30)}>30 天后</button><button onClick={() => applyDays(90)}>90 天后</button></div>
    <button className="expiry-apply" disabled={!value} onClick={() => value && onSave(new Date(`${value}T23:59:59`).getTime())}><Check size={14} />应用日期</button>
    {document?.expiresAt && <><hr /><button className="danger" onClick={() => onSave(null)}><X size={14} />清除有效期</button></>}
  </div>;
}

function TagBubbleMenu({ menu, documents, tags, onToggle, onEdit, onCreate, onOpenTag }: { menu: TagMenuState & {}; documents: DocumentItem[]; tags: Tag[]; onToggle: (tag: Tag) => void; onEdit: (tag: Tag) => void; onCreate: () => void; onOpenTag: (tag: Tag) => void }) {
  const selected = documents.filter((document) => menu.documentIds.includes(document.id));
  const sourceTag = tags.find((tag) => tag.id === menu.sourceTagId);
  return <div className="context-menu tag-bubble-menu custom-scrollbar" style={{ left: Math.min(menu.x, window.innerWidth - 270), top: Math.min(menu.y + 8, window.innerHeight - 410) }} onClick={(event) => event.stopPropagation()}>
    <header>{menu.documentIds.length ? `更改 ${menu.documentIds.length} 个文件的标签` : sourceTag?.name ?? "标签"}</header>
    {menu.documentIds.length > 0 && <div className="tag-toggle-list">{tags.map((tag) => {
      const applied = selected.length > 0 && selected.every((document) => document.tags.some((item) => item.id === tag.id));
      return <button key={tag.id} onClick={() => onToggle(tag)}><span className="tag-dot" style={{ background: tag.color }} />{tag.name}<span className="menu-check">{applied && <Check size={14} />}</span></button>;
    })}</div>}
    {menu.documentIds.length > 0 && <button onClick={onCreate}><Plus size={14} />新建并添加标签</button>}
    {sourceTag && <><hr /><button onClick={() => onOpenTag(sourceTag)}><Tags size={14} />进入“{sourceTag.name}”分类</button><button onClick={() => onEdit(sourceTag)}><Pencil size={14} />编辑名称和颜色</button>{menu.documentIds.length > 0 && <button className="danger" onClick={() => onToggle(sourceTag)}><X size={14} />从所选文件移除</button>}</>}
  </div>;
}

function TagEditorModal({ state, suggestedColor, onCancel, onSave }: { state: TagEditorState & {}; suggestedColor: string; onCancel: () => void; onSave: (name: string, color: string) => void }) {
  const [name, setName] = useState(state.tag?.name ?? "");
  const [color, setColor] = useState(state.tag?.color ?? suggestedColor);
  return <div className="modal-backdrop" onMouseDown={onCancel}><form className="tag-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSave(name.trim(), color); }}>
    <header><div><h2>{state.mode === "create" ? "新建标签" : "编辑标签"}</h2><p>{state.mode === "create" && state.documentIds.length ? `保存后将添加到 ${state.documentIds.length} 个文件` : "名称和颜色会同步到所有已标记文件"}</p></div><button type="button" onClick={onCancel}><X size={17} /></button></header>
    <label>标签名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：投标材料" /></label>
    <label>标签颜色<div className="color-picker"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><code>{color.toUpperCase()}</code></div></label>
    <div className="color-swatches">{tagColors.map((candidate) => <button type="button" className={candidate === color ? "active" : ""} style={{ background: candidate }} key={candidate} onClick={() => setColor(candidate)} />)}</div>
    <div className="tag-preview"><span>预览</span><i className="tag-chip" style={{ "--tag-color": color } as CSSProperties}>{name || "标签名称"}</i></div>
    <footer><button type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" disabled={!name.trim()}>保存</button></footer>
  </form></div>;
}

function AppDialogModal({ state, nodes, onCancel }: { state: Exclude<AppDialogState, null>; nodes: NodeItem[]; onCancel: () => void }) {
  const [value, setValue] = useState(state.kind === "input" ? state.initialValue ?? "" : "");
  const selectableNodes = state.kind === "node-picker" ? nodes.filter((node) => !state.excludedIds.includes(node.id)) : [];
  const [nodeId, setNodeId] = useState(selectableNodes[0]?.id ?? "");
  const submit = () => {
    if (state.kind === "input") {
      const trimmed = value.trim();
      if (!trimmed) return;
      onCancel();
      state.onConfirm(trimmed);
    } else if (state.kind === "confirm") {
      onCancel();
      state.onConfirm();
    } else {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      onCancel();
      state.onConfirm(node);
    }
  };
  return <div className="modal-backdrop" onMouseDown={onCancel}><form className={`app-dialog ${state.kind === "confirm" && state.tone === "danger" ? "danger-dialog" : ""}`} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <header><span className="dialog-icon">{state.kind === "confirm" && state.tone === "danger" ? <AlertTriangle size={21} /> : state.kind === "node-picker" ? <FolderInput size={21} /> : <Pencil size={21} />}</span><div><h2>{state.title}</h2><p>{state.description}</p></div><button type="button" title="关闭" onClick={onCancel}><X size={17} /></button></header>
    {state.kind === "input" && <label className="dialog-field"><span>名称</span><input autoFocus value={value} placeholder={state.placeholder} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} /><small>{value.trim() ? `${value.trim().length} 个字符` : "名称不能为空"}</small></label>}
    {state.kind === "node-picker" && <label className="dialog-field"><span>新的上级节点</span><select autoFocus value={nodeId} onChange={(event) => setNodeId(event.target.value)}>{selectableNodes.map((node) => <option value={node.id} key={node.id}>{nodePath(node.id, nodes)}</option>)}</select><small>{selectableNodes.length ? "移动后，节点内文件和下级结构保持不变" : "没有可用的目标节点"}</small></label>}
    {state.kind === "confirm" && <div className="dialog-note"><Info size={16} /><span>此操作将在确认后立即执行。</span></div>}
    <footer><button type="button" onClick={onCancel}>取消</button><button className={state.kind === "confirm" && state.tone === "danger" ? "danger-primary" : "primary"} type="submit" disabled={(state.kind === "input" && !value.trim()) || (state.kind === "node-picker" && !nodeId)}>{state.kind === "input" ? state.confirmLabel : state.kind === "confirm" ? state.confirmLabel : "移动节点"}</button></footer>
  </form></div>;
}

function HomeView({ data, expiryAlerts, recentDocuments, onOpenNode, onOpenTag, onOpenDocument, onTagMenu }: { data: BootstrapData; expiryAlerts: { document: DocumentItem; expiry: ExpiryState }[]; recentDocuments: DocumentItem[]; onOpenNode: (node: NodeItem) => void; onOpenTag: (tag: Tag) => void; onOpenDocument: (document: DocumentItem) => void; onTagMenu: (event: ReactMouseEvent, tag: Tag) => void }) {
  const root = data.nodes.find((node) => node.parentId === null);
  const maxDepth = useMemo(() => Math.max(0, ...data.nodes.map((node) => nodeDepth(node, data.nodes))), [data.nodes]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(data.nodes.filter((node) => nodeDepth(node, data.nodes) < 2).map((node) => node.id)));
  const expandToDepth = (depth: number) => setExpandedIds(new Set(data.nodes.filter((node) => nodeDepth(node, data.nodes) < depth).map((node) => node.id)));
  const expired = expiryAlerts.filter((item) => item.expiry.days < 0);
  const dueSoon = expiryAlerts.filter((item) => item.expiry.days >= 0);
  return <section className="home-view custom-scrollbar">
    <div className="home-heading"><div><h1>EazyLedger</h1><p>从完整台账层级、有效期、标签或最近资料开始</p></div><div className="home-stats"><span><strong>{data.documents.length}</strong> 份资料</span><span><strong>{data.nodes.length - 1}</strong> 个节点</span><span><strong>{data.tags.length}</strong> 个标签</span></div></div>
    <section className="home-section"><header><h2>台账架构</h2><span>按层级浏览全部节点</span></header><div className="home-ledger-tree">
      <div className="home-tree-controls"><button className="expand" onClick={() => setExpandedIds(new Set(data.nodes.map((node) => node.id)))}><ChevronDown size={15} /><span><strong>全部展开</strong><small>显示所有层级</small></span></button><button className="collapse" onClick={() => setExpandedIds(new Set())}><ChevronRight size={15} /><span><strong>全部收起</strong><small>仅保留根节点</small></span></button><label className="depth"><span><strong>展开层级</strong><small>指定可见深度</small></span><select value="" aria-label="展开至指定层级" onChange={(event) => { if (event.target.value) expandToDepth(Number(event.target.value)); }}><option value="" disabled>选择</option>{Array.from({ length: maxDepth + 1 }, (_, index) => <option value={index + 1} key={index + 1}>第 {index + 1} 层</option>)}</select></label></div>
      {root ? <HomeTreeNode node={root} nodes={data.nodes} onOpen={onOpenNode} expandedIds={expandedIds} onToggle={(nodeId) => setExpandedIds((current) => { const next = new Set(current); next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId); return next; })} /> : <div className="home-tree-empty"><FolderPlus size={28} /><span>尚未创建台账根节点</span></div>}
    </div></section>
    <section className="home-section expiry-overview-section"><header><h2>有效期关注</h2><span>集中查看已过期及 30 天内到期的资料</span></header><div className="expiry-overview-grid">
      <ExpiryOverviewCard title="已过期" tone="expired" items={expired} onOpenDocument={onOpenDocument} />
      <ExpiryOverviewCard title="即将到期" tone="due-soon" items={dueSoon} onOpenDocument={onOpenDocument} />
    </div></section>
    <section className="home-section"><header><h2>标签</h2><span>单击筛选，右侧按钮管理</span></header><div className="home-tags">{data.tags.map((tag) => <span className="home-tag-wrap" key={tag.id}><button className="home-tag" style={{ "--tag-color": tag.color } as CSSProperties} onClick={() => onOpenTag(tag)}><span className="tag-dot" style={{ background: tag.color }} />{tag.name}<small>{tag.documentCount}</small></button><button className="home-tag-menu" onClick={(event) => onTagMenu(event, tag)}><MoreHorizontal size={14} /></button></span>)}</div></section>
    <section className="home-section"><header><h2>最近资料</h2><span>按修改时间排序</span></header><div className="recent-grid">{recentDocuments.map((document) => { const expiry = expiryState(document.expiresAt); return <button key={document.id} className={`recent-card ${expiry?.kind ?? ""}`} onClick={() => onOpenDocument(document)}><FileIcon extension={document.extension} /><span><strong>{document.name}</strong><small>{formatDate(document.modifiedAt, true)} · {formatSize(document.size)}</small><span className="recent-tags">{document.tags.slice(0, 4).map((tag) => <i className="tag-chip" style={{ "--tag-color": tag.color } as CSSProperties} key={tag.id}>{tag.name}</i>)}{expiry && <i className={`expiry-badge ${expiry.kind}`}>{expiry.label}</i>}</span></span></button>; })}</div></section>
  </section>;
}

function ExpiryOverviewCard({ title, tone, items, onOpenDocument }: { title: string; tone: "expired" | "due-soon"; items: { document: DocumentItem; expiry: ExpiryState }[]; onOpenDocument: (document: DocumentItem) => void }) {
  return <article className={`expiry-overview-card ${tone}`}><header><span><CalendarClock size={17} /><strong>{title}</strong></span><b>{items.length}</b></header><div>{items.length ? items.map(({ document, expiry }) => <button key={document.id} onClick={() => onOpenDocument(document)} title={document.name}><FileIcon extension={document.extension} /><span><strong>{document.name}</strong><small>{expiry.label} · 到期日 {formatDate(document.expiresAt!)}</small></span><ChevronRight size={15} /></button>) : <p>暂无{title}资料</p>}</div></article>;
}

function HomeTreeNode({ node, nodes, onOpen, expandedIds, onToggle }: { node: NodeItem; nodes: NodeItem[]; onOpen: (node: NodeItem) => void; expandedIds: Set<string>; onToggle: (nodeId: string) => void }) {
  const children = nodes.filter((candidate) => candidate.parentId === node.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const expanded = expandedIds.has(node.id);
  return <div className="home-tree-node">
    <div className="home-tree-row"><button className="home-tree-toggle" disabled={!children.length} onClick={() => onToggle(node.id)}>{children.length ? (expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : <span />}</button><button className="home-tree-main" onClick={() => onOpen(node)}><span className="home-tree-icon"><FolderOpen size={19} /></span><span><strong>{node.name}</strong><small>{node.documentCount} 份资料</small></span><ChevronRight size={16} /></button></div>
    {children.length > 0 && expanded && <div className="home-tree-children">{children.map((child) => <HomeTreeNode key={child.id} node={child} nodes={nodes} onOpen={onOpen} expandedIds={expandedIds} onToggle={onToggle} />)}</div>}
  </div>;
}

function TrashCenter({ items, path, onClose, onReveal, onRestore, onEmpty }: { items: TrashItem[]; path: string; onClose: () => void; onReveal: () => void; onRestore: (trashId: string) => void; onEmpty: () => void }) {
  return <><button className="trash-scrim" aria-label="关闭回收站" onClick={onClose} /><aside className="trash-center">
    <header><div><Trash2 size={20} /><span><strong>应用回收站</strong><small>{items.length} 个可恢复文件</small></span></div><button title="关闭" onClick={onClose}><X size={17} /></button></header>
    <section className="trash-location"><code title={path}>{path}</code><button title="打开回收站文件夹" onClick={onReveal}><FolderOpen size={15} /></button></section>
    <div className="trash-list custom-scrollbar">{items.length ? items.map((item) => <article className="trash-row" key={item.trashId}>
      <FileIcon extension={item.extension} /><span><strong title={item.name}>{item.name}</strong><small>{item.originalNodeName ? `原位置：${item.originalNodeName} · ` : ""}{formatDate(item.deletedAt, true)} · {formatSize(item.size)}</small></span>
      <button title="恢复到原节点" onClick={() => onRestore(item.trashId)}><RotateCcw size={15} />恢复</button>
    </article>) : <div className="trash-empty"><Trash2 size={32} /><strong>回收站是空的</strong><span>选择“应用回收站”删除方式后，可在这里恢复文件</span></div>}</div>
    <footer><span>应用回收站中的文件不会自动清理</span><button className="danger" disabled={!items.length} onClick={onEmpty}><Trash2 size={14} />清空回收站</button></footer>
  </aside></>;
}

function SettingsView({ vaultPath, settings, previewOpen, notice, appVersion, updateUi, onPreviewChange, onCheckUpdate, onInstallUpdate, onRevealVault, onBackup, onSavePreferences, onRevealTrash, onChangeTrash, onOpenTrash, onRequestEmptyVault, onChangeVault }: { vaultPath: string; settings: BootstrapData["settings"]; previewOpen: boolean; notice: string | null; appVersion: string; updateUi: UpdateUiState; onPreviewChange: (value: boolean) => void; onCheckUpdate: () => Promise<void>; onInstallUpdate: () => Promise<void>; onRevealVault: () => Promise<void>; onBackup: () => Promise<void>; onSavePreferences: (mode: DeleteMode, limit: number) => Promise<void>; onRevealTrash: () => Promise<void>; onChangeTrash: () => Promise<void>; onOpenTrash: () => void; onRequestEmptyVault: () => void; onChangeVault: () => Promise<void> }) {
  return <section className="settings-view custom-scrollbar"><div className="settings-heading"><Settings size={28} /><div><h1>设置</h1><p>调整资料库、界面和文件管理行为</p></div></div>
    {notice && <div className="settings-notice"><Check size={18} /><span>{notice}</span></div>}
    <section className="settings-group"><header><Database size={19} /><div><h2>资料库存放位置</h2><p>数据库、导入副本和预览缓存</p></div></header><div className="setting-row vertical"><div><strong>当前资料库</strong><code title={vaultPath}>{vaultPath}</code></div><div className="setting-actions"><button onClick={() => void onRevealVault()}><FolderOpen size={14} />打开资料库文件夹</button><button className="secondary" onClick={() => void onBackup()}><Archive size={14} />创建完整备份</button><button className="secondary" onClick={() => void onChangeVault()}>迁移到新位置</button><button className="secondary" onClick={onRequestEmptyVault}>使用空资料库</button></div><small>切换会在重启应用后生效；旧资料库不会自动删除。</small></div></section>
    <section className="settings-group"><header><PanelRightOpen size={19} /><div><h2>界面</h2><p>控制文件浏览视图的默认呈现</p></div></header><label className="setting-row"><div><strong>显示预览面板</strong><small>单选文件时在右侧显示基础预览和属性</small></div><input type="checkbox" checked={previewOpen} onChange={(event) => onPreviewChange(event.target.checked)} /></label><label className="setting-row"><div><strong>每行显示标签数</strong><small>超出上限的标签折叠为“+N”，文件名始终优先显示</small></div><select value={settings.tagDisplayLimit} onChange={(event) => void onSavePreferences(settings.deleteMode, Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => <option value={index + 1} key={index + 1}>{index + 1} 个</option>)}</select></label></section>
    <section className="settings-group"><header><Files size={19} /><div><h2>文件管理</h2><p>选择删除行为并管理应用回收站</p></div></header><label className="setting-row"><div><strong>删除方式</strong><small>{settings.deleteMode === "app" ? "可在 EazyLedger 内恢复，默认且最安全" : settings.deleteMode === "system" ? "交由 Windows 回收站管理" : "立即物理删除，无法恢复"}</small></div><select value={settings.deleteMode} onChange={(event) => void onSavePreferences(event.target.value as DeleteMode, settings.tagDisplayLimit)}><option value="app">应用回收站（推荐）</option><option value="system">系统回收站</option><option value="permanent">直接永久删除</option></select></label><div className="setting-row vertical"><div><strong>应用回收站位置</strong><code title={settings.trashPath}>{settings.trashPath}</code></div><div className="setting-actions"><button onClick={onOpenTrash}><Trash2 size={14} />查看回收站（{settings.trashCount}）</button><button className="secondary" onClick={() => void onRevealTrash()}><FolderOpen size={14} />打开文件夹</button><button className="secondary" onClick={() => void onChangeTrash()}>更改位置</button></div><small>默认位于资料库的 database/trash；更改位置时会迁移现有回收站内容。</small></div><div className="setting-row"><div><strong>从资源管理器粘贴</strong><small>复制文件或文件夹后，在文件视图按 Ctrl+V 即可导入</small></div><span className="setting-value">已启用</span></div></section>
    <section className="settings-group"><header><Download size={19} /><div><h2>软件更新</h2><p>从官方 GitHub Release 下载经过签名验证的安装包</p></div></header><div className="setting-row vertical"><div><strong>当前版本 v{appVersion}</strong><small>应用启动后会自动检查一次，也可以随时手动检查</small></div><div className={`update-status ${updateUi.phase}`}><span className="update-status-icon">{updateUi.phase === "checking" || updateUi.phase === "downloading" ? <RefreshCw className="spinning" size={17} /> : updateUi.phase === "available" ? <Download size={17} /> : updateUi.phase === "current" ? <Check size={17} /> : updateUi.phase === "error" ? <AlertTriangle size={17} /> : <Info size={17} />}</span><div className="update-status-copy"><strong>{updateUi.phase === "checking" ? "正在检查更新" : updateUi.phase === "available" ? `发现 v${updateUi.info?.version ?? ""}` : updateUi.phase === "downloading" ? "正在安装更新" : updateUi.phase === "current" ? "当前已是最新版本" : updateUi.phase === "error" ? updateUi.failure?.title ?? "检查更新失败" : "尚未检查"}</strong><small>{updateUi.message ?? (updateUi.phase === "idle" ? "点击下方按钮连接 GitHub 更新服务" : "")}</small>{updateUi.failure?.detail && <details><summary>查看技术信息</summary><code>{updateUi.failure.detail}</code></details>}</div></div><div className="setting-actions"><button disabled={updateUi.phase === "checking" || updateUi.phase === "downloading"} onClick={() => void onCheckUpdate()}><RefreshCw size={14} />检查更新</button>{updateUi.phase === "available" && <button className="primary" onClick={() => void onInstallUpdate()}><Download size={14} />下载、安装并重启</button>}</div></div></section>
  </section>;
}

function SidebarSection({ storageKey, title, action, onAction, children }: { storageKey: string; title: string; action: ReactNode; onAction: () => void; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(`document-ledger.sidebar.${storageKey}`) === "collapsed");
  const toggle = () => setCollapsed((value) => {
    localStorage.setItem(`document-ledger.sidebar.${storageKey}`, value ? "expanded" : "collapsed");
    return !value;
  });
  return <section className={`sidebar-section ${collapsed ? "collapsed" : ""}`}><header><button className="sidebar-section-toggle" onClick={toggle}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{title}</span></button><button title={`新建${title === "标签" ? "标签" : "节点"}`} onClick={onAction}>{action}</button></header>{!collapsed && children}</section>;
}

function Tree({ nodes, selectedId, pointerDrag, dropTarget, onSelect, onNodePointerDown, onPromote, onDemote, onAdd, onRename, onCopy, onDelete }: { nodes: NodeItem[]; selectedId: string | null; pointerDrag: PointerDragState | null; dropTarget: PointerDropTarget | null; onSelect: (node: NodeItem) => void; onNodePointerDown: (event: ReactPointerEvent, node: NodeItem) => void; onPromote: (node: NodeItem) => void; onDemote: (node: NodeItem) => void; onAdd: (node: NodeItem) => void; onRename: (node: NodeItem) => void; onCopy: (node: NodeItem) => void; onDelete: (node: NodeItem) => void }) {
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState>(null);
  useEffect(() => {
    const close = () => setNodeMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, []);
  const rootProps = { nodes, selectedId, pointerDrag, dropTarget, onSelect, onNodePointerDown, onContextMenu: setNodeMenu, depth: 0 };
  const menuNode = nodeMenu?.node;
  const parent = menuNode?.parentId ? nodes.find((item) => item.id === menuNode.parentId) : undefined;
  const siblings = menuNode?.parentId ? nodes.filter((item) => item.parentId === menuNode.parentId).sort((a, b) => a.sortOrder - b.sortOrder) : [];
  const siblingIndex = menuNode ? siblings.findIndex((item) => item.id === menuNode.id) : -1;
  return <div className="tree">
    {nodes.filter((node) => node.parentId === null).map((node) => <TreeNode key={node.id} node={node} {...rootProps} />)}
    {nodeMenu && menuNode && <div className="context-menu node-context-menu" style={{ left: Math.min(nodeMenu.x, window.innerWidth - 245), top: Math.min(nodeMenu.y, window.innerHeight - 285) }} onClick={(event) => event.stopPropagation()}>
      <header>{menuNode.name}</header>
      <button onClick={() => { setNodeMenu(null); onAdd(menuNode); }}><FolderPlus size={14} />新建子节点</button>
      {menuNode.id !== "root" && <><button onClick={() => { setNodeMenu(null); onRename(menuNode); }}><Pencil size={14} />重命名</button>
        <button disabled={!parent?.parentId} title={!parent?.parentId ? "当前已是最高可升级层级" : undefined} onClick={() => { setNodeMenu(null); onPromote(menuNode); }}><ArrowUp size={14} />升级一级</button>
        <button disabled={siblingIndex <= 0} title={siblingIndex <= 0 ? "前面没有可作为上级的同级节点" : undefined} onClick={() => { setNodeMenu(null); onDemote(menuNode); }}><ChevronRight size={14} />降级到上一个同级节点</button>
        <hr /><button onClick={() => { setNodeMenu(null); onCopy(menuNode); }}><Copy size={14} />复制节点及内容</button>
        <button className="danger" onClick={() => { setNodeMenu(null); onDelete(menuNode); }}><Trash2 size={14} />删除节点及下级内容</button></>}
    </div>}
  </div>;
}

function TreeNode({ node, nodes, selectedId, pointerDrag, dropTarget, onSelect, onNodePointerDown, onContextMenu, depth }: { node: NodeItem; nodes: NodeItem[]; selectedId: string | null; pointerDrag: PointerDragState | null; dropTarget: PointerDropTarget | null; onSelect: (node: NodeItem) => void; onNodePointerDown: (event: ReactPointerEvent, node: NodeItem) => void; onContextMenu: (menu: NodeMenuState) => void; depth: number }) {
  const children = nodes.filter((candidate) => candidate.parentId === node.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const [open, setOpen] = useState(depth < 2);
  const isDropTarget = Boolean(pointerDrag && dropTarget?.nodeId === node.id);
  const isDraggedNode = pointerDrag?.kind === "node" && pointerDrag.nodeId === node.id;
  useEffect(() => {
    if (!isDropTarget || dropTarget?.position !== "inside" || open || !children.length) return;
    const timer = window.setTimeout(() => setOpen(true), 650);
    return () => window.clearTimeout(timer);
  }, [children.length, dropTarget?.position, isDropTarget, open]);
  return <>
    <div data-ledger-node-id={node.id} className={`tree-row ${selectedId === node.id ? "selected" : ""} ${isDraggedNode ? "node-dragging" : ""} ${isDropTarget ? `drop-target ${pointerDrag?.kind === "node" ? "node" : "files"}-target drop-${dropTarget?.position}` : ""}`} style={{ paddingLeft: 8 + depth * 16 }}
      onPointerDown={(event) => onNodePointerDown(event, node)}
      onClick={() => onSelect(node)}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ x: event.clientX, y: event.clientY, node }); }}>
      <button className="tree-toggle" onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>{children.length ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span />}</button>
      {open && children.length ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{node.name}</span><small>{node.documentCount}</small><span className="node-drag-hint">{node.id === "root" ? "右键管理" : "拖拽调整 · 右键管理"}</span>
    </div>
    {open && children.map((child) => <TreeNode key={child.id} node={child} nodes={nodes} selectedId={selectedId} pointerDrag={pointerDrag} dropTarget={dropTarget} onSelect={onSelect} onNodePointerDown={onNodePointerDown} onContextMenu={onContextMenu} depth={depth + 1} />)}
  </>;
}

function PreviewPane({ document, preview, allTags, onChanged }: { document: DocumentItem | null; preview: Preview | null; allTags: Tag[]; onChanged: () => Promise<void> }) {
  const [notes, setNotes] = useState(document?.notes ?? "");
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlPressed, setControlPressed] = useState(false);
  useEffect(() => setNotes(document?.notes ?? ""), [document]);
  useEffect(() => { setRotation(0); setZoom(1); setFullscreen(false); }, [document?.id]);
  useEffect(() => {
    if (!fullscreen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [fullscreen]);
  useEffect(() => {
    const updateControlState = (event: KeyboardEvent) => {
      if (event.key === "Control") setControlPressed(event.type === "keydown");
    };
    const clearControlState = () => setControlPressed(false);
    window.addEventListener("keydown", updateControlState);
    window.addEventListener("keyup", updateControlState);
    window.addEventListener("blur", clearControlState);
    return () => {
      window.removeEventListener("keydown", updateControlState);
      window.removeEventListener("keyup", updateControlState);
      window.removeEventListener("blur", clearControlState);
    };
  }, []);
  if (!document) return <aside className="preview-pane preview-empty custom-scrollbar"><Image size={36} /><p>单选文件以查看预览和属性</p></aside>;
  const canTransform = preview?.kind === "image" || preview?.kind === "pdf";
  const transformStyle = { transform: `rotate(${rotation}deg) scale(${zoom})` } as CSSProperties;
  const changeZoom = (step: number) => setZoom((value) => Math.min(3, Math.max(.5, Number((value + step).toFixed(2)))));
  const handlePreviewWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || !canTransform) return;
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? .25 : -.25);
  };
  async function toggleTag(tag: Tag) {
    const ids = document!.tags.map((item) => item.id);
    await api.setDocumentTags(document!.id, ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]);
    await onChanged();
  }
  const renderPreviewContent = () => <>{!preview && <span className="preview-loading">正在读取预览…</span>}{preview?.kind === "loading" && <span className="preview-loading">{preview.message}</span>}{preview?.kind === "image" && <div className="preview-media-transform" style={transformStyle}><img src={preview.path} alt={document.name} /></div>}{preview?.kind === "pdf" && <div className="preview-media-transform" style={transformStyle}><iframe src={preview.path} title={document.name} /></div>}{preview?.kind === "docx" && <DocxPreview path={preview.path} />}{preview?.kind === "text" && <pre>{preview.text}</pre>}{preview?.kind === "unsupported" && <div className="unsupported"><FileIcon extension={document.extension} /><strong>暂时无法预览此文件</strong><span>{preview.reason ?? "该格式尚未接入内置预览器"}</span><button onClick={() => void api.openDocument(document.id)}>使用默认程序打开</button></div>}</>;
  const controls = (inFullscreen = false) => <div className="preview-toolbar" aria-label="预览工具"><button disabled={!canTransform} title="向左旋转" onClick={() => setRotation((value) => value - 90)}><RotateCcw size={15} /></button><button disabled={!canTransform} title="向右旋转" onClick={() => setRotation((value) => value + 90)}><RotateCw size={15} /></button><span /><button disabled={!canTransform || zoom <= .5} title="缩小" onClick={() => changeZoom(-.25)}><ZoomOut size={15} /></button><button disabled={!canTransform} className="zoom-value" title="恢复原始视图" onClick={() => { setRotation(0); setZoom(1); }}>{Math.round(zoom * 100)}%</button><button disabled={!canTransform || zoom >= 3} title="放大" onClick={() => changeZoom(.25)}><ZoomIn size={15} /></button><span />{inFullscreen ? <button title="退出全屏（Esc）" onClick={() => setFullscreen(false)}><X size={16} /></button> : <button disabled={!preview || preview.kind === "loading"} title="全屏预览" onClick={() => setFullscreen(true)}><Maximize2 size={15} /></button>}</div>;
  const zoomCapture = controlPressed && canTransform ? <div className="preview-zoom-capture" title="Ctrl + 滚轮缩放预览" onWheel={handlePreviewWheel} /> : null;
  return <aside className="preview-pane custom-scrollbar"><header><FileIcon extension={document.extension} /><div><strong>{document.name}</strong><small>{formatSize(document.size)} · {document.extension.toUpperCase()}</small></div></header>
    <div className="preview-stage">{controls()}<div className="preview-box">{renderPreviewContent()}{zoomCapture}</div></div>
    <section className="properties"><h3>标签</h3><div className="tag-editor">{allTags.map((tag) => <button className={document.tags.some((item) => item.id === tag.id) ? "active" : ""} key={tag.id} onClick={() => void toggleTag(tag)}><span style={{ background: tag.color }} />{tag.name}</button>)}</div><h3>备注</h3><textarea value={notes} placeholder="添加说明或检索关键词…" onChange={(event) => setNotes(event.target.value)} onBlur={async () => { if (notes !== document.notes) { await api.updateNotes(document.id, notes); await onChanged(); } }} /><dl>{document.expiresAt && <><dt>有效期</dt><dd><span className={`expiry-chip ${expiryState(document.expiresAt)?.kind}`}><CalendarClock size={11} />{expiryState(document.expiresAt)?.label}</span></dd></>}<dt>修改时间</dt><dd>{formatDate(document.modifiedAt, true)}</dd><dt>资料库路径</dt><dd title={document.relativePath}>{document.relativePath}</dd></dl><div className="preview-actions"><button onClick={() => void api.openDocument(document.id)}>打开文件</button><button onClick={() => void api.revealDocument(document.id)}>在资源管理器中显示</button></div></section>
    {fullscreen && <div className="preview-fullscreen" onMouseDown={() => setFullscreen(false)}><div onMouseDown={(event) => event.stopPropagation()}><header><div><FileIcon extension={document.extension} /><span><strong>{document.name}</strong><small>Esc 退出全屏</small></span></div>{controls(true)}</header><main className="preview-box">{renderPreviewContent()}{zoomCapture}</main></div></div>}
  </aside>;
}

function DocxPreview({ path }: { path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("正在排版 Word 文档…");
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    setMessage("正在排版 Word 文档…");
    void fetch(path).then((response) => {
      if (!response.ok) throw new Error(`读取文件失败（${response.status}）`);
      return response.arrayBuffer();
    }).then(async (buffer) => {
      if (cancelled || !containerRef.current) return;
      await renderAsync(buffer, containerRef.current, containerRef.current, { breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true });
      if (!cancelled) setMessage("");
    }).catch((reason) => { if (!cancelled) setMessage(`Word 预览失败：${String(reason)}`); });
    return () => { cancelled = true; container.replaceChildren(); };
  }, [path]);
  return <div className="docx-preview custom-scrollbar">{message && <span className="preview-loading">{message}</span>}<div ref={containerRef} /></div>;
}

function FileIcon({ extension }: { extension: string }) {
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)) return <FileImage className="file-icon image" size={30} />;
  if (extension === "pdf") return <FileText className="file-icon pdf" size={30} />;
  if (["doc", "docx"].includes(extension)) return <FileText className="file-icon word" size={30} />;
  return <File className="file-icon" size={30} />;
}

function breadcrumbFor(nodeId: string | null, nodes: NodeItem[]) { if (!nodeId) return []; const parts: NodeItem[] = []; let current = nodes.find((node) => node.id === nodeId); while (current) { parts.unshift(current); current = current.parentId ? nodes.find((node) => node.id === current!.parentId) : undefined; } return parts; }
function nodePath(nodeId: string, nodes: NodeItem[]) { return breadcrumbFor(nodeId, nodes).map((node) => node.name).join(" / "); }
function nodeDepth(node: NodeItem, nodes: NodeItem[]) { let depth = 0; let current = node; while (current.parentId) { depth += 1; const parent = nodes.find((candidate) => candidate.id === current.parentId); if (!parent) break; current = parent; } return depth; }
function descendantNodeIds(nodeId: string, nodes: NodeItem[]) { const ids: string[] = []; const visit = (id: string) => nodes.filter((node) => node.parentId === id).forEach((child) => { ids.push(child.id); visit(child.id); }); visit(nodeId); return ids; }
function nodeOrderKey(parentId: string | null) { return parentId ?? "__root__"; }
function readNodeOrder(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem("document-ledger.node-order") ?? "{}"); }
  catch { return {}; }
}
function applyStoredNodeOrder(nodes: NodeItem[]) {
  const stored = readNodeOrder();
  const grouped = new Map<string, NodeItem[]>();
  nodes.forEach((node) => { const key = nodeOrderKey(node.parentId); grouped.set(key, [...(grouped.get(key) ?? []), node]); });
  const result: NodeItem[] = [];
  grouped.forEach((items, key) => {
    const preferred = stored[key] ?? [];
    const rank = new Map(preferred.map((id, index) => [id, index]));
    items.sort((a, b) => {
      const aRank = rank.get(a.id); const bRank = rank.get(b.id);
      if (aRank !== undefined || bRank !== undefined) return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
      return a.sortOrder - b.sortOrder;
    }).forEach((node, index) => result.push({ ...node, sortOrder: index }));
  });
  return result;
}
function persistNodeOrderAfterDrop(nodes: NodeItem[], sourceId: string, targetId: string, destinationParentId: string, position: NodeDropPosition) {
  const order = readNodeOrder();
  const parentIds = new Set(nodes.map((node) => node.parentId));
  parentIds.forEach((parentId) => {
    const key = nodeOrderKey(parentId);
    const current = nodes.filter((node) => node.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder).map((node) => node.id);
    order[key] = (order[key]?.filter((id) => current.includes(id)) ?? current).filter((id) => id !== sourceId);
    current.forEach((id) => { if (!order[key].includes(id) && id !== sourceId) order[key].push(id); });
  });
  const key = nodeOrderKey(destinationParentId);
  const destination = order[key] ?? [];
  if (position === "inside") destination.push(sourceId);
  else {
    const targetIndex = destination.indexOf(targetId);
    destination.splice(targetIndex < 0 ? destination.length : targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
  }
  order[key] = destination;
  localStorage.setItem("document-ledger.node-order", JSON.stringify(order));
}
function readSortPreference(): { key: SortKey; ascending: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem("document-ledger.file-sort") ?? "null");
    if (["modified", "name", "extension", "size", "expiry"].includes(value?.key) && typeof value?.ascending === "boolean") return value;
  } catch { /* use defaults */ }
  return { key: "modified", ascending: false };
}
function compareDocuments(a: DocumentItem, b: DocumentItem, key: SortKey, ascending: boolean) {
  if (a.starred !== b.starred) return a.starred ? -1 : 1;
  if (key === "expiry" && (a.expiresAt === null || b.expiresAt === null)) {
    if (a.expiresAt === b.expiresAt) return a.name.localeCompare(b.name, "zh-CN");
    return a.expiresAt === null ? 1 : -1;
  }
  const comparison = key === "name" ? a.name.localeCompare(b.name, "zh-CN")
    : key === "extension" ? a.extension.localeCompare(b.extension, "zh-CN") || a.name.localeCompare(b.name, "zh-CN")
      : key === "size" ? a.size - b.size
        : key === "expiry" ? (a.expiresAt ?? 0) - (b.expiresAt ?? 0)
          : a.modifiedAt - b.modifiedAt;
  return (ascending ? comparison : -comparison) || a.name.localeCompare(b.name, "zh-CN");
}
function readNotifications(): LedgerNotification[] {
  try {
    const value = JSON.parse(localStorage.getItem("document-ledger.notifications") ?? "[]");
    return Array.isArray(value) ? value.slice(0, 200) : [];
  } catch { return []; }
}
function writeNotifications(items: LedgerNotification[]) { localStorage.setItem("document-ledger.notifications", JSON.stringify(items.slice(0, 200))); }
function formatElapsed(milliseconds: number) { return `${Math.max(.1, milliseconds / 1000).toFixed(1)} 秒`; }
function formatSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
type ExpiryState = { days: number; kind: "expired" | "today" | "due-soon" | "active" | "safe"; label: string };
function expiryState(expiresAt: number | null): ExpiryState | null {
  if (!expiresAt) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiresAt); expiry.setHours(0, 0, 0, 0);
  const days = Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { days, kind: "expired", label: `已过期 ${Math.abs(days)} 天` };
  if (days === 0) return { days, kind: "today", label: "今日到期" };
  if (days <= 30) return { days, kind: "due-soon", label: `剩余 ${days} 天` };
  return { days, kind: days <= 90 ? "active" : "safe", label: `剩余 ${days} 天` };
}
function formatDateInput(timestamp: number | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
function formatDate(timestamp: number, withTime = false) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(timestamp)); }
