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
  tags: Tag[];
};

export type BootstrapData = {
  vaultPath: string;
  nodes: NodeItem[];
  tags: Tag[];
  documents: DocumentItem[];
};

export type Preview =
  | { kind: "image" | "pdf" | "docx"; path: string; text?: never; reason?: never }
  | { kind: "text"; text: string; path?: never; reason?: never }
  | { kind: "unsupported"; reason?: string; text?: never; path?: never };

export type AppTab = {
  id: string;
  title: string;
  view: "home" | "files" | "settings";
  nodeId: string | null;
  tagId: string | null;
  query: string;
};
