import type { BootstrapData, DocumentItem, Preview } from "./types";

const now = Date.now();
export const demoData: BootstrapData = {
  vaultPath: "D:\\资料台账",
  nodes: [
    { id: "root", parentId: null, name: "全部资料", sortOrder: 0, documentCount: 6 },
    { id: "bid", parentId: "root", name: "投标台账", sortOrder: 0, documentCount: 4 },
    { id: "a", parentId: "bid", name: "A 项目", sortOrder: 0, documentCount: 3 },
    { id: "a1", parentId: "a", name: "招标文件", sortOrder: 0, documentCount: 1 },
    { id: "a2", parentId: "a", name: "投标文件", sortOrder: 1, documentCount: 1 },
    { id: "a3", parentId: "a", name: "过程材料", sortOrder: 2, documentCount: 1 },
    { id: "b", parentId: "bid", name: "B 项目", sortOrder: 1, documentCount: 1 },
    { id: "contracts", parentId: "root", name: "合同台账", sortOrder: 1, documentCount: 2 },
  ],
  tags: [
    { id: "t1", name: "投标材料", color: "#4f7cff", documentCount: 3 },
    { id: "t2", name: "投标截图", color: "#a855f7", documentCount: 1 },
    { id: "t3", name: "待复核", color: "#f59e0b", documentCount: 2 },
    { id: "t4", name: "2026年", color: "#10b981", documentCount: 4 },
  ],
  documents: [],
};

const tags = demoData.tags;
demoData.documents = [
  { id: "d1", nodeId: "a1", name: "A项目招标文件.pdf", extension: "pdf", size: 4_823_192, modifiedAt: now - 3_600_000, relativePath: "files/d1/A项目招标文件.pdf", notes: "正式招标文件", expiresAt: null, tags: [tags[0], tags[3]] },
  { id: "d2", nodeId: "a2", name: "技术标最终稿.docx", extension: "docx", size: 1_238_120, modifiedAt: now - 86_400_000, relativePath: "files/d2/技术标最终稿.docx", notes: "提交前需要再次复核", expiresAt: null, tags: [tags[0], tags[2], tags[3]] },
  { id: "d3", nodeId: "a3", name: "投标系统提交截图.png", extension: "png", size: 823_010, modifiedAt: now - 172_800_000, relativePath: "files/d3/投标系统提交截图.png", notes: "系统提交成功页面", expiresAt: null, tags: [tags[1], tags[3]] },
  { id: "d4", nodeId: "b", name: "B项目商务标.docx", extension: "docx", size: 2_583_921, modifiedAt: now - 260_000_000, relativePath: "files/d4/B项目商务标.docx", notes: "", expiresAt: null, tags: [tags[0], tags[2]] },
  { id: "d5", nodeId: "contracts", name: "设备采购合同.pdf", extension: "pdf", size: 3_993_820, modifiedAt: now - 500_000_000, relativePath: "files/d5/设备采购合同.pdf", notes: "已签署", expiresAt: null, tags: [tags[3]] },
  { id: "d6", nodeId: "contracts", name: "补充协议.docx", extension: "docx", size: 458_219, modifiedAt: now - 900_000_000, relativePath: "files/d6/补充协议.docx", notes: "", expiresAt: null, tags: [] },
];

export function demoPreview(document: DocumentItem): Preview {
  if (document.extension === "docx") {
    return { kind: "docx", text: `${document.name}\n\n这是 DOCX 基础预览示例。桌面版会读取文档正文、段落和表格文字。\n\n${document.notes || "暂无备注。"}` };
  }
  return { kind: "unsupported" };
}

