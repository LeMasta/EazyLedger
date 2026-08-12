# 资料台账

一个面向 Windows 11 的本地资料管理工具。文件导入后由应用统一保存，树状台账负责主归档位置，标签负责跨目录分类，搜索覆盖名称、标签、备注和可提取的正文。

## 已实现功能（v0.4.4）

- Windows 资源管理器风格的三栏界面与多标签页
- 任意层级台账树，文件夹导入时自动保留原目录层级
- 台账树节点支持右键新建子节点、升级、降级、重命名、复制和安全删除；可拖拽节点直接调整父子层级
- 文件列表支持拖动单个或多选文件到左侧任意台账节点，松开后快速移动
- 自定义彩色标签、文件名后标签胶囊、标签筛选和批量标签编辑
- 文件名、备注、标签及 DOCX/TXT 正文搜索
- 文件和文件夹拖拽导入，默认复制进内部资料库
- 文件单选、多选、全选和始终可见的滚动条
- 复制、剪切、粘贴、创建副本、重命名和应用回收站删除
- 文件拖到左侧树节点移动，或通过批量操作栏移动/复制
- 文件右键菜单和 `Ctrl+A/C/X/V`、`F2`、`Delete` 快捷键
- 文件、树节点和标签的新增、查询、修改、移动、复制、删除
- 默认主页：以图标卡片展示顶层台账、下级节点、彩色标签和最近资料
- 上一级导航：节点逐级返回，根节点和标签视图返回主页
- 标签气泡单击操作菜单、双击进入标签分类；文件行提供显式操作按钮
- 新建/编辑标签面板支持名称、颜色、预览及创建后立即赋给文件
- 树节点悬停显示添加下级、重命名、复制和删除按钮
- 设置页面：预览栏偏好及资料库存放位置迁移
- 行内复选框可独立勾选和取消，不依赖批量栏关闭按钮
- 双击使用 Windows 默认程序打开文件
- 在资源管理器中定位内部文件
- 图片、PDF、DOCX、文本基础预览
- DOCX/TXT 文件保存后自动更新大小、日期和正文索引
- JSON 台账清单导出及完整资料库备份
- NSIS Windows `.exe` 安装程序构建
- GitHub Actions 云端 Windows 构建、签名更新包和草稿 Release
- 启动时静默检查更新，以及“设置 → 软件更新”手动检查、下载、验证、安装和重启
- 主页有效期中心集中展示已过期和 30 天内到期资料，右上角通知按钮可随时重新打开告警
- 图片/PDF 预览支持左右旋转、缩放、复位和全屏，文本与 DOCX 预览支持全屏查看
- 主页树支持逐节点展开，并在树卡片右上角提供彩色的全部展开、全部收起和指定层级控制
- 搜索支持关键字与多个标签组合筛选；多个标签采用 AND 逻辑

浏览器运行 `npm run dev` 时会显示内置示例数据，便于只调整界面；使用 `npm run tauri dev` 时才会操作真实的本地资料库。

## Windows 11 开发运行

首次开发需要：

1. 安装 [Node.js LTS](https://nodejs.org/)；
2. 安装 [Rust](https://rustup.rs/)；
3. 安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选“使用 C++ 的桌面开发”；
4. 双击 `run-dev-windows.cmd`。

Windows 11 通常已包含 WebView2。Tauri 的官方 Windows 前置条件说明也列出了 C++ Build Tools、WebView2 和 Rust：[Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)。

`.cmd` 启动器会仅为本次运行设置 PowerShell 执行策略，不会修改系统的永久配置。如需直接运行 `.ps1`，可在项目目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-dev-windows.ps1
```

## 生成 EXE 安装程序

日常修改界面和功能时直接运行 `run-dev-windows.cmd`，它使用增量开发编译，不需要反复生成安装包。

需要快速测试安装流程时运行 `build-fast.cmd`，生成调试安装包：

```text
release\document-ledger-debug-setup.exe
```

最终交付时再运行 `build-windows.cmd`，生成优化后的正式安装包：

```powershell
.\build-windows.cmd
```

也可以绕过当前执行策略直接调用 PowerShell：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1 -OpenOutput
```

脚本会检查构建环境、安装锁定依赖、生成 NSIS 安装程序，并复制为：

```text
release\document-ledger-setup.exe
```

脚本现在会复用已有的 `node_modules` 和 Rust 增量编译缓存。第一次 Rust 编译仍然会较慢，后续构建会明显加快；只有 `package.json` 或 `package-lock.json` 改动后才需要手动执行一次 `npm ci`。

已经安装过应用时，无需卸载。关闭正在运行的“资料台账”，双击 `update-installed.cmd`，脚本会执行 Release 增量构建并静默原位升级。应用数据库和资料库存放在 `%APPDATA%`，不会被安装程序覆盖。

日常测试源码修改只需运行 `run-dev-windows.cmd`，不需要安装。确认版本稳定后再运行 `update-installed.cmd` 完成原位升级。

从 v0.4.0 开始，正式版还支持应用内更新。v0.3.x 及更早版本需要最后手动安装一次 v0.4.0；以后可直接在“设置 → 软件更新”中完成升级，无需卸载旧版本。

## GitHub 自动发布与在线更新

仓库的 `.github/workflows/release.yml` 会在手动运行或推送 `v*` 标签时使用 GitHub 的 Windows 构建机生成 NSIS 安装包、更新签名和 `latest.json`，并创建草稿 Release。

首次发布前，在仓库 `Settings → Secrets and variables → Actions` 中添加：

- `TAURI_SIGNING_PRIVATE_KEY`：本机 `eazyledger.key` 的完整内容；
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成签名密钥时设置的密码。

私钥、密码和 `.key` 文件不得提交到仓库。发布新版时需要同时修改 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本号，然后运行该工作流。Release 默认为草稿，确认安装测试正常后再公开发布，公开后的 `latest.json` 才会被已安装应用发现。

Tauri 对 NSIS 与 WebView2 打包模式的说明见 [Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。

## 资料存放位置

默认资料库位于 Windows 应用数据目录：

```text
%APPDATA%\com.local.documentledger\vault
```

其内部包含：

```text
vault
├─ database\ledger.db
├─ files\<文件唯一ID>\原文件名
└─ backups
```

应用打开的是 `files` 中的正式副本。在 Word 等程序中保存后，后台文件监视器会更新检索正文，因此标签和树状位置不会失效。

## 项目结构

```text
src/                    React 界面
src-tauri/src/lib.rs    SQLite、文件操作、搜索和预览后端
src-tauri/tauri.conf.json
build-windows.ps1       Windows 一键打包
build-windows.cmd       无需修改执行策略的构建入口
build-fast.cmd          较快的调试安装包构建入口
update-installed.cmd    Release 构建并原位升级已安装应用
run-dev-windows.ps1     Windows 开发运行
run-dev-windows.cmd     无需修改执行策略的开发入口
```

## 当前边界

- DOCX 预览以正文可读为目标，不追求与 Word 完全相同的版式；旧版 `.doc` 只支持外部打开。
- PDF 第一版支持预览和名称/标签搜索，尚未抽取 PDF 正文。
- 台账导出目前是 JSON；后续可增加 Excel/CSV。
- 资料库位置目前使用应用默认目录；后续可增加首次启动选择磁盘位置和迁移向导。
- 应用回收站目前保留在资料库的 `trash` 目录，尚未提供图形化恢复界面。
- 资料库迁移要求选择空目录，切换在重启后生效；旧资料库不会自动删除。

## 常见构建问题

### `cargo metadata ... program not found`

表示尚未安装 Rust，或安装后终端还没有刷新 `PATH`。从 [Rust 官方安装页](https://www.rust-lang.org/tools/install) 下载并运行 `rustup-init.exe`，选择默认安装；完成后彻底关闭并重新打开 PowerShell、CMD 和 VS Code，再执行：

```powershell
cargo --version
rustc --version
```

两个命令都显示版本后，再运行 `run-dev-windows.cmd`。Rustup 会同时安装 Rust 编译器和 Cargo。

### PowerShell 禁止运行脚本

使用 `build-windows.cmd` 或 `run-dev-windows.cmd`，不要直接双击 `.ps1`。两个 CMD 入口只为当前进程启用 `ExecutionPolicy Bypass`，不会永久修改系统策略。
