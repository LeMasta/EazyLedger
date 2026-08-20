export type NodeItem = {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  documentCount: number;
};

export type Tag = {
  id: string;
  name: string;
  color: string;
  documentCount: number;
};

export type DocumentItem = {
  id: string;
  nodeId: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: number;
  relativePath: string;
  notes: string;
  expiresAt: number | null;
  starred: boolean;
  tags: Tag[];
};

export type DeleteMode = "app" | "system" | "permanent";

export type AppSettings = {
  deleteMode: DeleteMode;
  trashPath: string;
  tagDisplayLimit: number;
  trashCount: number;
};

export type TrashItem = {
  trashId: string;
  id: string;
  name: string;
  extension: string;
  size: number;
  deletedAt: number;
  originalNodeName: string | null;
};

export type BootstrapData = {
  vaultPath: string;
  nodes: NodeItem[];
  tags: Tag[];
  documents: DocumentItem[];
  settings: AppSettings;
};

export type Preview =
  | { kind: "image" | "pdf" | "docx"; path: string; text?: never; reason?: never; message?: never }
  | { kind: "text"; text: string; path?: never; reason?: never; message?: never }
  | { kind: "loading"; message: string; text?: never; path?: never; reason?: never }
  | { kind: "unsupported"; reason?: string; text?: never; path?: never; message?: never };

export type AppTabHistoryEntry = {
  title: string;
  view: "home" | "files" | "settings";
  nodeId: string | null;
  tagId: string | null;
  query: string;
};

export type AppTab = AppTabHistoryEntry & {
  id: string;
  history: AppTabHistoryEntry[];
};
