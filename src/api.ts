import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { demoData, demoPreview } from "./demo";
import type { BootstrapData, DocumentItem, Preview, Tag } from "./types";

const desktop = isTauri();
let demo = structuredClone(demoData);

export const api = {
  isDesktop: desktop,
  async bootstrap(): Promise<BootstrapData> {
    return desktop ? invoke("bootstrap") : structuredClone(demo);
  },
  async search(query: string, nodeId?: string | null, tagId?: string | null): Promise<DocumentItem[]> {
    if (desktop) return invoke("search_documents", { query, nodeId, tagId });
    const q = query.trim().toLocaleLowerCase();
    return demo.documents.filter((d) => {
      const inNode = !nodeId || nodeId === "root" || d.nodeId === nodeId || isDemoDescendant(d.nodeId, nodeId);
      const hasTag = !tagId || d.tags.some((tag) => tag.id === tagId);
      const matches = !q || [d.name, d.notes, ...d.tags.map((tag) => tag.name)].join(" ").toLocaleLowerCase().includes(q);
      return inNode && hasTag && matches;
    });
  },
  async chooseAndImport(nodeId: string, mode: "copy" | "move" = "copy"): Promise<DocumentItem[]> {
    if (!desktop) return [];
    const selected = await open({ multiple: true, directory: false, title: "选择要导入的资料" });
    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected];
    return invoke("import_paths", { paths, nodeId, mode });
  },
  async chooseAndImportFolder(nodeId: string, mode: "copy" | "move" = "copy"): Promise<DocumentItem[]> {
    if (!desktop) return [];
    const selected = await open({ multiple: true, directory: true, title: "选择要导入的文件夹" });
    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected];
    return invoke("import_paths", { paths, nodeId, mode });
  },
  async importPaths(paths: string[], nodeId: string, mode: "copy" | "move" = "copy"): Promise<DocumentItem[]> {
    return desktop ? invoke("import_paths", { paths, nodeId, mode }) : [];
  },
  async openDocument(id: string): Promise<void> {
    if (desktop) await invoke("open_document", { id });
  },
  async revealDocument(id: string): Promise<void> {
    if (desktop) await invoke("reveal_document", { id });
  },
  async getPreview(id: string): Promise<Preview> {
    if (desktop) {
      const result = await invoke<Preview>("get_preview", { id });
      if ("path" in result && result.path) return { ...result, path: convertFileSrc(result.path) } as Preview;
      return result;
    }
    return demoPreview(demo.documents.find((d) => d.id === id)!);
  },
  async createNode(parentId: string, name: string): Promise<void> {
    if (desktop) await invoke("create_node", { parentId, name });
    else demo.nodes.push({ id: crypto.randomUUID(), parentId, name, sortOrder: 99, documentCount: 0 });
  },
  async renameNode(id: string, name: string): Promise<void> {
    if (desktop) await invoke("rename_node", { id, name });
    else demo.nodes.find((n) => n.id === id)!.name = name;
  },
  async moveNode(id: string, parentId: string): Promise<void> {
    if (desktop) await invoke("move_node", { id, parentId });
    else demo.nodes.find((node) => node.id === id)!.parentId = parentId;
  },
  async copyNode(id: string, parentId: string): Promise<void> {
    if (desktop) await invoke("copy_node", { id, parentId });
  },
  async deleteNode(id: string): Promise<void> {
    if (desktop) await invoke("delete_node", { id });
    else demo.nodes = demo.nodes.filter((node) => node.id !== id);
  },
  async createTag(name: string, color: string): Promise<Tag> {
    if (desktop) return invoke("create_tag", { name, color });
    const tag = { id: crypto.randomUUID(), name, color, documentCount: 0 };
    demo.tags.push(tag);
    return tag;
  },
  async renameTag(id: string, name: string): Promise<void> {
    if (desktop) await invoke("rename_tag", { id, name });
    else demo.tags.find((tag) => tag.id === id)!.name = name;
  },
  async updateTagColor(id: string, color: string): Promise<void> {
    if (desktop) await invoke("update_tag_color", { id, color });
    else demo.tags.find((tag) => tag.id === id)!.color = color;
  },
  async deleteTag(id: string): Promise<void> {
    if (desktop) await invoke("delete_tag", { id });
    else {
      demo.tags = demo.tags.filter((tag) => tag.id !== id);
      demo.documents.forEach((document) => document.tags = document.tags.filter((tag) => tag.id !== id));
    }
  },
  async setDocumentTags(documentId: string, tagIds: string[]): Promise<void> {
    if (desktop) await invoke("set_document_tags", { documentId, tagIds });
    else demo.documents.find((d) => d.id === documentId)!.tags = demo.tags.filter((t) => tagIds.includes(t.id));
  },
  async addTagsToDocuments(documentIds: string[], tagIds: string[]): Promise<void> {
    if (desktop) await invoke("add_tags_to_documents", { documentIds, tagIds });
  },
  async removeTagsFromDocuments(documentIds: string[], tagIds: string[]): Promise<void> {
    if (desktop) await invoke("remove_tags_from_documents", { documentIds, tagIds });
  },
  async updateNotes(documentId: string, notes: string): Promise<void> {
    if (desktop) await invoke("update_notes", { documentId, notes });
    else demo.documents.find((d) => d.id === documentId)!.notes = notes;
  },
  async updateExpiry(documentId: string, expiresAt: number | null): Promise<void> {
    if (desktop) await invoke("update_expiry", { documentId, expiresAt });
    else demo.documents.find((d) => d.id === documentId)!.expiresAt = expiresAt;
  },
  async renameDocument(id: string, name: string): Promise<void> {
    if (desktop) await invoke("rename_document", { id, name });
    else demo.documents.find((document) => document.id === id)!.name = name;
  },
  async moveDocuments(ids: string[], nodeId: string): Promise<void> {
    if (desktop) await invoke("move_documents", { ids, nodeId });
    else demo.documents.filter((document) => ids.includes(document.id)).forEach((document) => document.nodeId = nodeId);
  },
  async copyDocuments(ids: string[], nodeId: string): Promise<void> {
    if (desktop) await invoke("copy_documents", { ids, nodeId });
  },
  async deleteDocuments(ids: string[]): Promise<void> {
    if (desktop) await invoke("delete_documents", { ids });
    else demo.documents = demo.documents.filter((document) => !ids.includes(document.id));
  },
  async exportManifest(): Promise<boolean> {
    if (!desktop) return false;
    const destination = await save({ title: "导出台账清单", defaultPath: "资料台账清单.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!destination) return false;
    await invoke("export_manifest", { destination });
    return true;
  },
  async createBackup(): Promise<boolean> {
    if (!desktop) return false;
    const destination = await open({ title: "选择备份保存位置", directory: true, multiple: false });
    if (!destination || Array.isArray(destination)) return false;
    await invoke("create_backup", { destination });
    return true;
  },
  async changeVaultLocation(migrate: boolean): Promise<string | null> {
    if (!desktop) return null;
    const destination = await open({ title: "选择新的资料库存放目录", directory: true, multiple: false });
    if (!destination || Array.isArray(destination)) return null;
    return invoke("change_vault_location", { destination, migrate });
  },
};

function isDemoDescendant(nodeId: string, ancestorId: string): boolean {
  let node = demo.nodes.find((n) => n.id === nodeId);
  while (node?.parentId) {
    if (node.parentId === ancestorId) return true;
    node = demo.nodes.find((n) => n.id === node!.parentId);
  }
  return false;
}
