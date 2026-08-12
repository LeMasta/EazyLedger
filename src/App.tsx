import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AlertTriangle, Archive, ArrowDownAZ, ArrowLeft, ArrowRight, ArrowUp, Bell, CalendarClock, Check, CheckSquare, ChevronDown, ChevronRight,
  ClipboardPaste, Copy, Download, File, FileImage, FilePlus2, FileText, Folder, FolderInput,
  FolderOpen, FolderPlus, HardDrive, Image, Import, Maximize2, MoreHorizontal, PanelRightClose,
  PanelRightOpen, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, Scissors, Search, Star, Tags, Trash2, X, House, Files, Settings, Database, ZoomIn, ZoomOut,
} from "lucide-react";
import { api } from "./api";
import type { AppTab, BootstrapData, DocumentItem, NodeItem, Preview, Tag } from "./types";
import { currentVersion, findUpdate, installPendingUpdate, type AvailableUpdate } from "./updater";

const initialTab: AppTab = { id: "home", title: "主页", view: "home", nodeId: null, tagId: null, query: "" };
const tagColors = ["#4f7cff", "#a855f7", "#f59e0b", "#10b981", "#ef4444", "#06b6d4", "#64748b"];

type ClipboardState = { mode: "copy" | "cut"; ids: string[] } | null;
type ContextMenuState = { x: number; y: number; documentId: string } | null;
type TagMenuState = { x: number; y: number; documentIds: string[]; sourceTagId?: string } | null;
type ExpiryMenuState = { x: number; y: number; documentId: string } | null;
type TagEditorState = { mode: "create" | "edit"; tag?: Tag; documentIds: string[] } | null;
type SortKey = "name" | "modified" | "size";
type UpdateUiState = {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "error";
  info?: AvailableUpdate;
  message?: string;
  percent?: number | null;
};

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [tabs, setTabs] = useState<AppTab[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState("home");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
  const [searchTagIds, setSearchTagIds] = useState<string[]>([]);
  const [batchNodeId, setBatchNodeId] = useState("root");
  const [batchTagId, setBatchTagId] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("modified");
  const [sortAscending, setSortAscending] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("0.4.3");
  const [expiryReminderOpen, setExpiryReminderOpen] = useState(true);
  const [updateUi, setUpdateUi] = useState<UpdateUiState>({ phase: "idle" });
  const lastSelectedIndex = useRef<number | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const selectedDocuments = documents.filter((document) => selectedIds.has(document.id));
  const selected = selectedDocuments.length === 1 ? selectedDocuments[0] : null;
  const sortedDocuments = useMemo(() => [...documents].sort((a, b) => {
    const comparison = sortKey === "name" ? a.name.localeCompare(b.name, "zh-CN") : sortKey === "size" ? a.size - b.size : a.modifiedAt - b.modifiedAt;
    return sortAscending ? comparison : -comparison;
  }), [documents, sortAscending, sortKey]);
  const expiryAlerts = useMemo(() => (data?.documents ?? [])
    .map((document) => ({ document, expiry: expiryState(document.expiresAt) }))
    .filter((item): item is { document: DocumentItem; expiry: ExpiryState } => Boolean(item.expiry && item.expiry.days <= 30))
    .sort((a, b) => a.expiry.days - b.expiry.days), [data]);

  const refreshBootstrap = useCallback(async () => {
    const next = await api.bootstrap();
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
    setUpdateUi({ phase: "checking", message: "正在连接 GitHub 检查新版本…" });
    try {
      const info = await findUpdate();
      if (info) setUpdateUi({ phase: "available", info, message: `发现新版本 ${info.version}` });
      else setUpdateUi({ phase: "current", message: "当前已是最新版本" });
    } catch (reason) {
      if (manual) setUpdateUi({ phase: "error", message: `检查失败：${String(reason)}` });
      else setUpdateUi({ phase: "idle" });
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
      setUpdateUi({ phase: "error", info, message: `安装失败：${String(reason)}` });
    }
  }, [updateUi.info]);

  useEffect(() => {
    void (async () => {
      try { await refreshBootstrap(); await refreshDocuments(initialTab); }
      catch (reason) { setError(String(reason)); }
      finally { setLoading(false); }
    })();
  }, [refreshBootstrap, refreshDocuments]);

  useEffect(() => {
    if (!api.isDesktop) return;
    void currentVersion().then(setAppVersion).catch(() => undefined);
    const timer = window.setTimeout(() => void checkForUpdates(false), 1800);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  useEffect(() => {
    if (!data) return;
    const timer = window.setTimeout(() => void refreshDocuments(activeTab), 120);
    return () => window.clearTimeout(timer);
  }, [activeTab, data, refreshDocuments]);

  useEffect(() => {
    if (!api.isDesktop) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") setExternalDragging(true);
      if (event.payload.type === "leave") setExternalDragging(false);
      if (event.payload.type === "drop") {
        setExternalDragging(false);
        void importPaths(event.payload.paths, activeTab.nodeId ?? "root");
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [activeTab.nodeId]);

  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    setPreview(null);
    void api.getPreview(selected.id).then(setPreview).catch((reason) => setError(String(reason)));
  }, [selected?.id]);

  useEffect(() => { localStorage.setItem("document-ledger.preview-open", String(previewOpen)); }, [previewOpen]);

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
      if (event.ctrlKey && event.key.toLowerCase() === "c" && selectedIds.size) { event.preventDefault(); setClipboard({ mode: "copy", ids: [...selectedIds] }); }
      if (event.ctrlKey && event.key.toLowerCase() === "x" && selectedIds.size) { event.preventDefault(); setClipboard({ mode: "cut", ids: [...selectedIds] }); }
      if (event.ctrlKey && event.key.toLowerCase() === "v" && clipboard) { event.preventDefault(); void pasteClipboard(); }
      if (event.key === "F2" && selectedIds.size === 1) { event.preventDefault(); void renameSelected(); }
      if (event.key === "Delete" && selectedIds.size) { event.preventDefault(); void deleteSelected(); }
      if (event.key === "Escape") { setSelectedIds(new Set()); setContextMenu(null); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [clipboard, documents, selectedIds, activeTab.nodeId]);

  function updateActive(patch: Partial<AppTab>) {
    setTabs((current) => current.map((tab) => tab.id === activeTabId ? { ...tab, ...patch } : tab));
  }

  function selectNode(node: NodeItem) {
    setTagMenu(null);
    setSearchTagIds([]);
    updateActive({ title: node.name, view: "files", nodeId: node.id, tagId: null, query: "" });
    setBatchNodeId(node.id);
    setSelectedIds(new Set());
  }

  function selectTag(tag: Tag) {
    setTagMenu(null);
    setSearchTagIds([]);
    updateActive({ title: `# ${tag.name}`, view: "files", nodeId: null, tagId: tag.id, query: "" });
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
    await runAction(async () => { await api.importPaths(paths, nodeId); await refreshAll(); });
  }

  async function chooseImport() {
    await runAction(async () => { await api.chooseAndImport(activeTab.nodeId ?? "root"); await refreshAll(); });
  }

  async function chooseImportFolder() {
    await runAction(async () => { await api.chooseAndImportFolder(activeTab.nodeId ?? "root"); await refreshAll(); });
  }

  async function addNode(parentId = activeTab.nodeId ?? "root") {
    const name = window.prompt("新节点名称");
    if (!name?.trim()) return;
    await runAction(async () => { await api.createNode(parentId, name.trim()); await refreshBootstrap(); });
  }

  function addTag(documentIds: string[] = [...selectedIds]) {
    setTagEditor({ mode: "create", documentIds });
  }

  function goHome() { updateActive({ ...initialTab, id: activeTabId }); setSearchTagIds([]); setSelectedIds(new Set()); }

  function toggleSearchTag(tagId: string) {
    setSearchTagIds((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]);
    if (activeTab.view !== "files") updateActive({ view: "files", title: "搜索" });
  }

  function openSettings() { updateActive({ title: "设置", view: "settings", nodeId: null, tagId: null, query: "" }); setSelectedIds(new Set()); }

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

  function handleDragStart(event: DragEvent, document: DocumentItem) {
    const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id];
    if (!selectedIds.has(document.id)) setSelectedIds(new Set([document.id]));
    const payload = JSON.stringify(ids);
    event.dataTransfer.setData("application/x-document-ids", payload);
    event.dataTransfer.setData("text/plain", `eazyledger:${payload}`);
    event.dataTransfer.effectAllowed = "move";
  }

  async function moveFiles(ids: string[], nodeId: string) {
    await runAction(async () => { await api.moveDocuments(ids, nodeId); setSelectedIds(new Set()); await refreshAll(); });
  }

  async function copyFiles(ids: string[], nodeId: string) {
    await runAction(async () => { await api.copyDocuments(ids, nodeId); await refreshAll(); });
  }

  async function pasteClipboard() {
    if (!clipboard) return;
    const target = activeTab.nodeId ?? ROOT_FALLBACK(data);
    if (clipboard.mode === "copy") await copyFiles(clipboard.ids, target);
    else { await moveFiles(clipboard.ids, target); setClipboard(null); }
  }

  async function renameSelected() {
    const document = selectedDocuments[0];
    if (selectedDocuments.length !== 1 || !document) return;
    const name = window.prompt("重命名文件", document.name);
    if (!name?.trim() || name === document.name) return;
    await runAction(async () => { await api.renameDocument(document.id, name.trim()); await refreshAll(); });
  }

  async function deleteSelected() {
    if (!selectedIds.size) return;
    if (!window.confirm(`确定将选中的 ${selectedIds.size} 个文件移入应用回收站吗？`)) return;
    await runAction(async () => { await api.deleteDocuments([...selectedIds]); setSelectedIds(new Set()); await refreshAll(); });
  }

  async function applyBatchTag(remove: boolean) {
    if (!batchTagId || !selectedIds.size) return;
    await runAction(async () => {
      if (remove) await api.removeTagsFromDocuments([...selectedIds], [batchTagId]);
      else await api.addTagsToDocuments([...selectedIds], [batchTagId]);
      await refreshAll();
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

  async function renameNode(node: NodeItem) {
    if (node.id === "root") return;
    const name = window.prompt("重命名节点", node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    await runAction(async () => {
      await api.renameNode(node.id, name.trim());
      if (activeTab.nodeId === node.id) updateActive({ title: name.trim() });
      await refreshBootstrap();
    });
  }

  async function copyNode(node: NodeItem) {
    if (node.id === "root") return;
    await runAction(async () => { await api.copyNode(node.id, node.parentId ?? "root"); await refreshBootstrap(); });
  }

  async function deleteNode(node: NodeItem) {
    if (node.id === "root" || !window.confirm(`删除节点“${node.name}”及其全部下级内容？文件会移入应用回收站。`)) return;
    await runAction(async () => {
      await api.deleteNode(node.id);
      if (activeTab.nodeId === node.id) goHome();
      await refreshAll();
    });
  }

  async function renameCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (node) await renameNode(node);
  }

  async function copyCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (node) await copyNode(node);
  }

  async function moveCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (!node || node.id === "root") return;
    const targetName = window.prompt("输入目标上级节点的完整路径，例如：全部资料 / 项目台账", "全部资料");
    const target = data?.nodes.find((item) => nodePath(item.id, data.nodes) === targetName);
    if (!target) { setError("没有找到该目标节点"); return; }
    await runAction(async () => { await api.moveNode(node.id, target.id); await refreshBootstrap(); });
  }

  async function deleteCurrentNode() {
    const node = data?.nodes.find((item) => item.id === activeTab.nodeId);
    if (node) await deleteNode(node);
  }

  function editTag(tag: Tag) { setTagEditor({ mode: "edit", tag, documentIds: [] }); }

  async function removeTag(tag: Tag) {
    if (!window.confirm(`删除标签“${tag.name}”？文件本身不会删除。`)) return;
    await runAction(async () => { await api.deleteTag(tag.id); await refreshAll(); });
  }

  async function updateDocumentExpiry(documentId: string, expiresAt: number | null) {
    await runAction(async () => {
      await api.updateExpiry(documentId, expiresAt);
      setExpiryMenu(null);
      await refreshAll();
    });
  }

  function setSort(next: SortKey) {
    if (next === sortKey) setSortAscending((value) => !value);
    else { setSortKey(next); setSortAscending(true); }
  }

  if (!data) return <div className="splash">{error ? `无法启动：${error}` : "正在打开资料台账…"}</div>;
  const breadcrumb = breadcrumbFor(activeTab.nodeId, data.nodes);

  return <main className="app-shell">
    <header className="titlebar"><div className="brand"><span className="brand-mark"><FileText size={17} /></span>资料台账</div><div className="titlebar-note">{api.isDesktop ? data.vaultPath : "界面预览模式"}</div></header>
    <nav className="tabs" aria-label="标签页">
      {tabs.map((tab) => <button className={`tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id} onClick={() => setActiveTabId(tab.id)}>{tab.view === "home" ? <House size={15} /> : tab.view === "settings" ? <Settings size={15} /> : <Folder size={15} />}<span>{tab.title}</span><X className="tab-close" size={14} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} /></button>)}
      <button className="new-tab" title="新建标签页" onClick={addTab}><Plus size={17} /></button>
    </nav>
    <section className="toolbar">
      <div className="nav-buttons"><button onClick={goHome} disabled={activeTab.view === "home"} title="主页"><ArrowLeft size={18} /></button><button onClick={goUp} disabled={activeTab.view === "home"} title="上一级"><ArrowUp size={18} /></button><button title="刷新" onClick={() => void refreshAll()}><RefreshCw size={17} /></button></div>
      <div className="address-bar"><button className="home-crumb" onClick={goHome}><House size={16} />主页</button>{breadcrumb.map((part) => <span className="crumb" key={part.id} onClick={() => selectNode(part)}><ChevronRight size={14} />{part.name}</span>)}{activeTab.tagId && <span className="crumb"><ChevronRight size={14} />{activeTab.title}</span>}</div>
      <div className="search-box"><Search size={17} /><input disabled={activeTab.view === "settings"} value={activeTab.query} onChange={(event) => updateActive({ view: event.target.value || searchTagIds.length ? "files" : activeTab.view, title: event.target.value ? "搜索" : activeTab.title, query: event.target.value })} placeholder={activeTab.view === "settings" ? "设置页面" : "搜索名称、标签、备注和正文"} />{activeTab.query && <button onClick={() => updateActive({ query: "" })}><X size={15} /></button>}<SearchTagFilter tags={data.tags} selectedIds={searchTagIds} disabled={activeTab.view === "settings"} onToggle={toggleSearchTag} onClear={() => setSearchTagIds([])} /></div>
    </section>
    <section className="commandbar">
      <button className="primary" onClick={() => void chooseImport()}><Import size={16} />导入资料</button>
      <button onClick={() => void chooseImportFolder()}><FolderInput size={16} />导入文件夹</button>
      <button onClick={() => void addNode()}><FolderPlus size={16} />新建节点</button>
      <button onClick={() => void addTag()}><Tags size={16} />新建标签</button>
      <span className="command-separator" />
      <button disabled={!selectedIds.size} onClick={() => setClipboard({ mode: "copy", ids: [...selectedIds] })}><Copy size={16} />复制</button>
      <button disabled={!selectedIds.size} onClick={() => setClipboard({ mode: "cut", ids: [...selectedIds] })}><Scissors size={16} />剪切</button>
      <button disabled={!clipboard} onClick={() => void pasteClipboard()}><ClipboardPaste size={16} />粘贴</button>
      <button disabled={selectedIds.size !== 1} onClick={() => void renameSelected()}><Pencil size={16} />重命名</button>
      <button disabled={!selectedIds.size} onClick={() => void deleteSelected()}><Trash2 size={16} />删除</button>
      <CommandMenu>
        <button onClick={() => void renameCurrentNode()}>重命名当前节点</button><button onClick={() => void copyCurrentNode()}>复制当前节点及内容</button><button onClick={() => void moveCurrentNode()}>移动当前节点</button><button className="danger" onClick={() => void deleteCurrentNode()}>删除当前节点</button>
        <hr /><button onClick={() => void api.exportManifest()}><Download size={14} />导出台账</button><button onClick={() => void api.createBackup()}><Archive size={14} />完整备份</button>
      </CommandMenu>
      <span className="command-spacer" />
      <button className={`notification-button ${expiryAlerts.length ? "has-alerts" : ""}`} title="查看有效期提醒" onClick={() => setExpiryReminderOpen((open) => !open)}><Bell size={16} />通知{expiryAlerts.length > 0 && <span>{expiryAlerts.length > 99 ? "99+" : expiryAlerts.length}</span>}</button>
      <button onClick={openSettings}><Settings size={16} />设置</button>
      <button onClick={() => setPreviewOpen((open) => !open)}>{previewOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}{previewOpen ? "隐藏预览" : "显示预览"}</button>
    </section>
    {activeTab.view === "home" ? <HomeView data={data} expiryAlerts={expiryAlerts} recentDocuments={[...data.documents].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 10)} onOpenNode={selectNode} onOpenTag={selectTag} onOpenDocument={(document) => { const node = data.nodes.find((item) => item.id === document.nodeId); if (node) selectNode(node); setSelectedIds(new Set([document.id])); }} onTagMenu={(event, tag) => { event.stopPropagation(); setTagMenu({ x: event.clientX, y: event.clientY, documentIds: [], sourceTagId: tag.id }); }} /> : activeTab.view === "settings" ? <SettingsView vaultPath={data.vaultPath} previewOpen={previewOpen} notice={settingsNotice} appVersion={appVersion} updateUi={updateUi} onPreviewChange={setPreviewOpen} onCheckUpdate={() => checkForUpdates(true)} onInstallUpdate={installUpdate} onChangeVault={async (migrate) => { const result = await api.changeVaultLocation(migrate); if (result) setSettingsNotice(result); }} /> : <section className={`workspace ${previewOpen ? "with-preview" : ""}`}>
      <aside className="sidebar custom-scrollbar">
        <SidebarSection title="台账架构" action={<FolderPlus size={14} />} onAction={() => void addNode()}>
          <Tree nodes={data.nodes} selectedId={activeTab.nodeId} onSelect={selectNode} onDropFiles={(ids, nodeId) => void moveFiles(ids, nodeId)} onAdd={(node) => void addNode(node.id)} onRename={(node) => void renameNode(node)} onCopy={(node) => void copyNode(node)} onDelete={(node) => void deleteNode(node)} />
        </SidebarSection>
        <SidebarSection title="标签" action={<Plus size={14} />} onAction={() => void addTag()}>
          <div className="tag-list">{data.tags.map((tag) => <div className={`tag-row ${activeTab.tagId === tag.id ? "selected" : ""}`} key={tag.id}>
            <button className="tag-main" onClick={() => selectTag(tag)}><span className="tag-dot" style={{ background: tag.color }} /><span>{tag.name}</span><small>{tag.documentCount}</small></button>
            <button className="mini-action" title="编辑名称和颜色" onClick={() => editTag(tag)}><Pencil size={12} /></button>
            <button className="mini-action danger" title="删除标签" onClick={() => void removeTag(tag)}><Trash2 size={12} /></button>
          </div>)}</div>
        </SidebarSection>
        <div className="sidebar-footer"><Star size={15} />收藏夹 <small>即将推出</small></div>
      </aside>
      <section className="file-pane">
        {selectedIds.size > 0 && <div className="selection-bar">
          <CheckSquare size={16} /><strong>已选 {selectedIds.size} 项</strong>
          <select value={batchNodeId} onChange={(event) => setBatchNodeId(event.target.value)}>{data.nodes.map((node) => <option value={node.id} key={node.id}>{nodePath(node.id, data.nodes)}</option>)}</select>
          <button onClick={() => void moveFiles([...selectedIds], batchNodeId)}><FolderInput size={14} />移动</button>
          <button onClick={() => void copyFiles([...selectedIds], batchNodeId)}><Copy size={14} />复制</button>
          <select value={batchTagId} onChange={(event) => setBatchTagId(event.target.value)}><option value="">选择标签…</option>{data.tags.map((tag) => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select>
          <button disabled={!batchTagId} onClick={() => void applyBatchTag(false)}>+ 标签</button><button disabled={!batchTagId} onClick={() => void applyBatchTag(true)}>− 标签</button>
          <button className="selection-close" onClick={() => setSelectedIds(new Set())}><X size={14} /></button>
        </div>}
        <div className="list-header">
          <input type="checkbox" checked={documents.length > 0 && selectedIds.size === documents.length} onChange={(event) => setSelectedIds(event.target.checked ? new Set(documents.map((item) => item.id)) : new Set())} />
          <button onClick={() => setSort("name")}>名称、标签和有效期 <ArrowDownAZ size={13} /></button><button onClick={() => setSort("modified")}>修改日期</button><button onClick={() => setSort("size")}>大小</button>
        </div>
        <div className="file-list custom-scrollbar">
          {sortedDocuments.map((document, index) => {
            const expiry = expiryState(document.expiresAt);
            return <div
              className={`file-row ${selectedIds.has(document.id) ? "selected" : ""} ${clipboard?.mode === "cut" && clipboard.ids.includes(document.id) ? "cut" : ""} ${expiry?.kind ?? ""}`}
              key={document.id} draggable onDragStart={(event) => handleDragStart(event, document)}
              onClick={(event) => handleRowSelect(event, document, index)} onDoubleClick={() => void api.openDocument(document.id)}
              onContextMenu={(event) => { event.preventDefault(); if (!selectedIds.has(document.id)) setSelectedIds(new Set([document.id])); setContextMenu({ x: event.clientX, y: event.clientY, documentId: document.id }); }}
            >
              <input type="checkbox" checked={selectedIds.has(document.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleDocumentSelection(document.id, index)} aria-label={`选择 ${document.name}`} />
              <span className="file-name"><FileIcon extension={document.extension} /><span><span className="file-title-line"><strong>{document.name}</strong>{document.tags.map((tag) => <button className="tag-chip" style={{ "--tag-color": tag.color } as CSSProperties} key={tag.id} onClick={(event) => { event.stopPropagation(); const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id]; setTagMenu({ x: event.clientX, y: event.clientY, documentIds: ids, sourceTagId: tag.id }); }} onDoubleClick={(event) => { event.stopPropagation(); selectTag(tag); }}>{tag.name}</button>)}<button className="add-tag-chip" title="为文件添加标签" onClick={(event) => { event.stopPropagation(); const ids = selectedIds.has(document.id) ? [...selectedIds] : [document.id]; setTagMenu({ x: event.clientX, y: event.clientY, documentIds: ids }); }}><Plus size={11} />标签</button></span><small>{document.extension.toUpperCase()} 文件{expiry && <button className={`expiry-chip ${expiry.kind}`} title="修改有效期" onClick={(event) => { event.stopPropagation(); setExpiryMenu({ x: event.clientX, y: event.clientY, documentId: document.id }); }}><CalendarClock size={11} />{expiry.label}</button>}</small></span></span>
              <span>{formatDate(document.modifiedAt)}</span>
              <span>{formatSize(document.size)}</span><button className="row-more" title="文件操作" onClick={(event) => { event.stopPropagation(); if (!selectedIds.has(document.id)) setSelectedIds(new Set([document.id])); const rect = event.currentTarget.getBoundingClientRect(); setContextMenu({ x: rect.right - 225, y: rect.bottom + 2, documentId: document.id }); }}><MoreHorizontal size={17} /></button>
            </div>;
          })}
          {!documents.length && !loading && <div className="empty-state"><FilePlus2 size={38} /><h3>这里还没有资料</h3><p>将文件或文件夹拖到窗口中，目录层级会自动保留。</p></div>}
        </div>
        <footer className="statusbar"><span>{documents.length} 个项目</span><span>{selectedIds.size ? `已选择 ${selectedIds.size} 个项目` : "Ctrl+A 全选 · F2 重命名 · Delete 删除"}</span></footer>
      </section>
      {previewOpen && <PreviewPane document={selected} preview={preview} allTags={data.tags} onChanged={refreshAll} />}
    </section>}
    {contextMenu && <FileContextMenu menu={contextMenu} document={documents.find((item) => item.id === contextMenu.documentId)} onOpen={() => void api.openDocument(contextMenu.documentId)} onReveal={() => void api.revealDocument(contextMenu.documentId)} onCopy={() => setClipboard({ mode: "copy", ids: [...selectedIds] })} onCut={() => setClipboard({ mode: "cut", ids: [...selectedIds] })} onRename={() => void renameSelected()} onExpiry={() => { setExpiryMenu({ x: contextMenu.x, y: contextMenu.y, documentId: contextMenu.documentId }); setContextMenu(null); }} onDelete={() => void deleteSelected()} />}
    {tagMenu && <TagBubbleMenu menu={tagMenu} documents={documents} tags={data.tags} onToggle={(tag) => void toggleTagForDocuments(tag, tagMenu.documentIds)} onEdit={(tag) => { setTagMenu(null); editTag(tag); }} onCreate={() => { const ids = tagMenu.documentIds; setTagMenu(null); addTag(ids); }} onOpenTag={(tag) => { setTagMenu(null); selectTag(tag); }} />}
    {tagEditor && <TagEditorModal state={tagEditor} suggestedColor={tagColors[data.tags.length % tagColors.length]} onCancel={() => setTagEditor(null)} onSave={(name, color) => void saveTagEditor(name, color)} />}
    {expiryMenu && <ExpiryBubbleMenu menu={expiryMenu} document={documents.find((item) => item.id === expiryMenu.documentId)} onSave={(expiresAt) => void updateDocumentExpiry(expiryMenu.documentId, expiresAt)} />}
    {externalDragging && <div className="drop-overlay"><Import size={46} /><strong>释放鼠标，导入到“{activeTab.title}”</strong><span>文件夹层级会自动创建为台账树</span></div>}
    {expiryReminderOpen && expiryAlerts.length > 0 && <aside className="expiry-reminder"><header><AlertTriangle size={19} /><div><strong>有效期提醒</strong><small>{expiryAlerts.filter((item) => item.expiry.days < 0).length} 份已过期，{expiryAlerts.filter((item) => item.expiry.days >= 0).length} 份将在 30 天内到期</small></div><button onClick={() => setExpiryReminderOpen(false)} title="关闭提醒"><X size={15} /></button></header><div>{expiryAlerts.slice(0, 8).map(({ document, expiry }) => <button key={document.id} onClick={() => { const node = data.nodes.find((item) => item.id === document.nodeId); if (node) selectNode(node); setSelectedIds(new Set([document.id])); setExpiryReminderOpen(false); }}><span>{document.name}</span><em className={expiry.kind}>{expiry.label}</em></button>)}</div>{expiryAlerts.length > 8 && <footer>另有 {expiryAlerts.length - 8} 份资料需要关注，可在主页查看全部</footer>}</aside>}
    {loading && <div className="progress-line" />}
    {error && <div className="toast" onClick={() => setError(null)}>{error}<X size={14} /></div>}
  </main>;
}

function ROOT_FALLBACK(data: BootstrapData | null) { return data?.nodes.find((node) => node.parentId === null)?.id ?? "root"; }

function CommandMenu({ children }: { children: ReactNode }) {
  return <details className="command-menu"><summary title="更多操作"><MoreHorizontal size={18} /></summary><div>{children}</div></details>;
}

function FileContextMenu({ menu, document, onOpen, onReveal, onCopy, onCut, onRename, onExpiry, onDelete }: { menu: ContextMenuState & {}; document?: DocumentItem; onOpen: () => void; onReveal: () => void; onCopy: () => void; onCut: () => void; onRename: () => void; onExpiry: () => void; onDelete: () => void }) {
  return <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
    <header>{document?.name}</header><button onClick={onOpen}>打开</button><button onClick={onReveal}>在资源管理器中显示</button><hr /><button onClick={onCopy}><Copy size={14} />复制</button><button onClick={onCut}><Scissors size={14} />剪切</button><button onClick={onRename}><Pencil size={14} />重命名</button><button onClick={onExpiry}><CalendarClock size={14} />{document?.expiresAt ? "修改有效期" : "设置有效期"}</button><hr /><button className="danger" onClick={onDelete}><Trash2 size={14} />移入应用回收站</button>
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

function HomeView({ data, expiryAlerts, recentDocuments, onOpenNode, onOpenTag, onOpenDocument, onTagMenu }: { data: BootstrapData; expiryAlerts: { document: DocumentItem; expiry: ExpiryState }[]; recentDocuments: DocumentItem[]; onOpenNode: (node: NodeItem) => void; onOpenTag: (tag: Tag) => void; onOpenDocument: (document: DocumentItem) => void; onTagMenu: (event: ReactMouseEvent, tag: Tag) => void }) {
  const root = data.nodes.find((node) => node.parentId === null);
  const maxDepth = useMemo(() => Math.max(0, ...data.nodes.map((node) => nodeDepth(node, data.nodes))), [data.nodes]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(data.nodes.filter((node) => nodeDepth(node, data.nodes) < 2).map((node) => node.id)));
  const expandToDepth = (depth: number) => setExpandedIds(new Set(data.nodes.filter((node) => nodeDepth(node, data.nodes) < depth).map((node) => node.id)));
  const expired = expiryAlerts.filter((item) => item.expiry.days < 0);
  const dueSoon = expiryAlerts.filter((item) => item.expiry.days >= 0);
  return <section className="home-view custom-scrollbar">
    <div className="home-heading"><div><h1>资料台账</h1><p>从完整台账层级、有效期、标签或最近资料开始</p></div><div className="home-stats"><span><strong>{data.documents.length}</strong> 份资料</span><span><strong>{data.nodes.length - 1}</strong> 个节点</span><span><strong>{data.tags.length}</strong> 个标签</span></div></div>
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

function SettingsView({ vaultPath, previewOpen, notice, appVersion, updateUi, onPreviewChange, onCheckUpdate, onInstallUpdate, onChangeVault }: { vaultPath: string; previewOpen: boolean; notice: string | null; appVersion: string; updateUi: UpdateUiState; onPreviewChange: (value: boolean) => void; onCheckUpdate: () => Promise<void>; onInstallUpdate: () => Promise<void>; onChangeVault: (migrate: boolean) => Promise<void> }) {
  return <section className="settings-view custom-scrollbar"><div className="settings-heading"><Settings size={28} /><div><h1>设置</h1><p>调整资料库、界面和文件管理行为</p></div></div>
    {notice && <div className="settings-notice"><Check size={18} /><span>{notice}</span></div>}
    <section className="settings-group"><header><Database size={19} /><div><h2>资料库存放位置</h2><p>数据库、导入的原文件、备份和应用回收站</p></div></header><div className="setting-row vertical"><div><strong>当前目录</strong><code>{vaultPath}</code></div><div className="setting-actions"><button onClick={() => void onChangeVault(true)}>选择新位置并迁移现有资料</button><button className="secondary" onClick={() => { if (window.confirm("新位置将创建空资料库，现有资料仍保留在旧位置。继续吗？")) void onChangeVault(false); }}>选择新位置并使用空资料库</button></div><small>切换会在重启应用后生效。旧资料库不会自动删除。</small></div></section>
    <section className="settings-group"><header><PanelRightOpen size={19} /><div><h2>界面</h2><p>控制文件浏览视图的默认呈现</p></div></header><label className="setting-row"><div><strong>显示预览面板</strong><small>单选文件时在右侧显示基础预览和属性</small></div><input type="checkbox" checked={previewOpen} onChange={(event) => onPreviewChange(event.target.checked)} /></label></section>
    <section className="settings-group"><header><Files size={19} /><div><h2>文件管理</h2><p>当前版本的安全策略</p></div></header><div className="setting-row"><div><strong>删除方式</strong><small>文件先移入应用资料库的 trash 目录，不立即物理删除</small></div><span className="setting-value">应用回收站</span></div><div className="setting-row"><div><strong>导入方式</strong><small>默认复制进资料库，原文件保留</small></div><span className="setting-value">复制</span></div></section>
    <section className="settings-group"><header><Download size={19} /><div><h2>软件更新</h2><p>从官方 GitHub Release 下载经过签名验证的安装包</p></div></header><div className="setting-row vertical"><div><strong>当前版本 v{appVersion}</strong><small>{updateUi.message ?? "应用启动后会自动检查一次，也可以随时手动检查"}</small>{updateUi.info?.notes && <small className="update-notes">{updateUi.info.notes}</small>}</div>{updateUi.phase === "downloading" && <div className="update-progress"><span style={{ width: `${updateUi.percent ?? 15}%` }} /></div>}<div className="setting-actions"><button disabled={updateUi.phase === "checking" || updateUi.phase === "downloading"} onClick={() => void onCheckUpdate()}><RefreshCw size={14} />{updateUi.phase === "checking" ? "正在检查" : "检查更新"}</button>{updateUi.phase === "available" && <button onClick={() => void onInstallUpdate()}><Download size={14} />下载并安装 v{updateUi.info?.version}</button>}</div><small>安装前请保存正在编辑的文件。资料库和数据库不会随程序更新被覆盖。</small></div></section>
  </section>;
}

function SidebarSection({ title, action, onAction, children }: { title: string; action: ReactNode; onAction: () => void; children: ReactNode }) {
  return <section className="sidebar-section"><header><span>{title}</span><button onClick={onAction}>{action}</button></header>{children}</section>;
}

function Tree({ nodes, selectedId, onSelect, onDropFiles, onAdd, onRename, onCopy, onDelete }: { nodes: NodeItem[]; selectedId: string | null; onSelect: (node: NodeItem) => void; onDropFiles: (ids: string[], nodeId: string) => void; onAdd: (node: NodeItem) => void; onRename: (node: NodeItem) => void; onCopy: (node: NodeItem) => void; onDelete: (node: NodeItem) => void }) {
  return <div className="tree">{nodes.filter((node) => node.parentId === null).map((node) => <TreeNode key={node.id} node={node} nodes={nodes} selectedId={selectedId} onSelect={onSelect} onDropFiles={onDropFiles} onAdd={onAdd} onRename={onRename} onCopy={onCopy} onDelete={onDelete} depth={0} />)}</div>;
}

function TreeNode({ node, nodes, selectedId, onSelect, onDropFiles, onAdd, onRename, onCopy, onDelete, depth }: { node: NodeItem; nodes: NodeItem[]; selectedId: string | null; onSelect: (node: NodeItem) => void; onDropFiles: (ids: string[], nodeId: string) => void; onAdd: (node: NodeItem) => void; onRename: (node: NodeItem) => void; onCopy: (node: NodeItem) => void; onDelete: (node: NodeItem) => void; depth: number }) {
  const children = nodes.filter((candidate) => candidate.parentId === node.id).sort((a, b) => a.sortOrder - b.sortOrder);
  const [open, setOpen] = useState(depth < 2);
  const [dropTarget, setDropTarget] = useState(false);
  const dragExpandTimer = useRef<number | null>(null);
  const hasLedgerPayload = (event: DragEvent) => Array.from(event.dataTransfer.types).some((type) => type === "application/x-document-ids" || type === "text/plain");
  return <>
    <div className={`tree-row ${selectedId === node.id ? "selected" : ""} ${dropTarget ? "drop-target" : ""}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onSelect(node)} onDragEnter={(event) => { if (!hasLedgerPayload(event)) return; event.preventDefault(); setDropTarget(true); if (!open && children.length && dragExpandTimer.current === null) dragExpandTimer.current = window.setTimeout(() => { setOpen(true); dragExpandTimer.current = null; }, 650); }} onDragOver={(event) => { if (hasLedgerPayload(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(true); } }} onDragLeave={(event) => { if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; setDropTarget(false); if (dragExpandTimer.current !== null) { window.clearTimeout(dragExpandTimer.current); dragExpandTimer.current = null; } }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDropTarget(false); if (dragExpandTimer.current !== null) window.clearTimeout(dragExpandTimer.current); dragExpandTimer.current = null; const custom = event.dataTransfer.getData("application/x-document-ids"); const fallback = event.dataTransfer.getData("text/plain"); const raw = custom || (fallback.startsWith("eazyledger:") ? fallback.slice(11) : ""); if (!raw) return; try { const ids = JSON.parse(raw); if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) onDropFiles(ids, node.id); } catch { /* 忽略非台账拖拽数据 */ } }}>
      <button className="tree-toggle" onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>{children.length ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span />}</button>
      {open && children.length ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{node.name}</span><small>{node.documentCount}</small><span className="node-actions"><button title="新建下级节点" onClick={(event) => { event.stopPropagation(); onAdd(node); }}><Plus size={11} /></button>{node.id !== "root" && <><button title="重命名" onClick={(event) => { event.stopPropagation(); onRename(node); }}><Pencil size={11} /></button><button title="复制节点" onClick={(event) => { event.stopPropagation(); onCopy(node); }}><Copy size={11} /></button><button className="danger" title="删除节点" onClick={(event) => { event.stopPropagation(); onDelete(node); }}><Trash2 size={11} /></button></>}</span>
    </div>
    {open && children.map((child) => <TreeNode key={child.id} node={child} nodes={nodes} selectedId={selectedId} onSelect={onSelect} onDropFiles={onDropFiles} onAdd={onAdd} onRename={onRename} onCopy={onCopy} onDelete={onDelete} depth={depth + 1} />)}
  </>;
}

function PreviewPane({ document, preview, allTags, onChanged }: { document: DocumentItem | null; preview: Preview | null; allTags: Tag[]; onChanged: () => Promise<void> }) {
  const [notes, setNotes] = useState(document?.notes ?? "");
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => setNotes(document?.notes ?? ""), [document]);
  useEffect(() => { setRotation(0); setZoom(1); setFullscreen(false); }, [document?.id]);
  useEffect(() => {
    if (!fullscreen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [fullscreen]);
  if (!document) return <aside className="preview-pane preview-empty custom-scrollbar"><Image size={36} /><p>单选文件以查看预览和属性</p></aside>;
  const canTransform = preview?.kind === "image" || preview?.kind === "pdf";
  const transformStyle = { transform: `rotate(${rotation}deg) scale(${zoom})` } as CSSProperties;
  async function toggleTag(tag: Tag) {
    const ids = document!.tags.map((item) => item.id);
    await api.setDocumentTags(document!.id, ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]);
    await onChanged();
  }
  const renderPreviewContent = () => <>{!preview && <span className="preview-loading">正在生成预览…</span>}{preview?.kind === "image" && <div className="preview-media-transform" style={transformStyle}><img src={preview.path} alt={document.name} /></div>}{preview?.kind === "pdf" && <div className="preview-media-transform" style={transformStyle}><iframe src={preview.path} title={document.name} /></div>}{(preview?.kind === "docx" || preview?.kind === "text") && <pre>{preview.text}</pre>}{preview?.kind === "unsupported" && <div className="unsupported"><FileIcon extension={document.extension} /><span>暂不支持此格式预览</span><button onClick={() => void api.openDocument(document.id)}>使用默认程序打开</button></div>}</>;
  const controls = (inFullscreen = false) => <div className="preview-toolbar" aria-label="预览工具"><button disabled={!canTransform} title="向左旋转" onClick={() => setRotation((value) => value - 90)}><RotateCcw size={15} /></button><button disabled={!canTransform} title="向右旋转" onClick={() => setRotation((value) => value + 90)}><RotateCw size={15} /></button><span /><button disabled={!canTransform || zoom <= .5} title="缩小" onClick={() => setZoom((value) => Math.max(.5, Number((value - .25).toFixed(2))))}><ZoomOut size={15} /></button><button disabled={!canTransform} className="zoom-value" title="恢复原始视图" onClick={() => { setRotation(0); setZoom(1); }}>{Math.round(zoom * 100)}%</button><button disabled={!canTransform || zoom >= 3} title="放大" onClick={() => setZoom((value) => Math.min(3, Number((value + .25).toFixed(2))))}><ZoomIn size={15} /></button><span />{inFullscreen ? <button title="退出全屏（Esc）" onClick={() => setFullscreen(false)}><X size={16} /></button> : <button disabled={!preview} title="全屏预览" onClick={() => setFullscreen(true)}><Maximize2 size={15} /></button>}</div>;
  return <aside className="preview-pane custom-scrollbar"><header><FileIcon extension={document.extension} /><div><strong>{document.name}</strong><small>{formatSize(document.size)} · {document.extension.toUpperCase()}</small></div></header>
    <div className="preview-stage">{controls()}<div className="preview-box">{renderPreviewContent()}</div></div>
    <section className="properties"><h3>标签</h3><div className="tag-editor">{allTags.map((tag) => <button className={document.tags.some((item) => item.id === tag.id) ? "active" : ""} key={tag.id} onClick={() => void toggleTag(tag)}><span style={{ background: tag.color }} />{tag.name}</button>)}</div><h3>备注</h3><textarea value={notes} placeholder="添加说明或检索关键词…" onChange={(event) => setNotes(event.target.value)} onBlur={async () => { if (notes !== document.notes) { await api.updateNotes(document.id, notes); await onChanged(); } }} /><dl>{document.expiresAt && <><dt>有效期</dt><dd><span className={`expiry-chip ${expiryState(document.expiresAt)?.kind}`}><CalendarClock size={11} />{expiryState(document.expiresAt)?.label}</span></dd></>}<dt>修改时间</dt><dd>{formatDate(document.modifiedAt, true)}</dd><dt>资料库路径</dt><dd title={document.relativePath}>{document.relativePath}</dd></dl><div className="preview-actions"><button onClick={() => void api.openDocument(document.id)}>打开文件</button><button onClick={() => void api.revealDocument(document.id)}>在资源管理器中显示</button></div></section>
    {fullscreen && <div className="preview-fullscreen" onMouseDown={() => setFullscreen(false)}><div onMouseDown={(event) => event.stopPropagation()}><header><div><FileIcon extension={document.extension} /><span><strong>{document.name}</strong><small>Esc 退出全屏</small></span></div>{controls(true)}</header><main className="preview-box">{renderPreviewContent()}</main></div></div>}
  </aside>;
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
