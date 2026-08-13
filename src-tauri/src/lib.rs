use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{Manager, State};
use uuid::Uuid;
use walkdir::WalkDir;

const ROOT_NODE_ID: &str = "root";

struct AppState {
    vault_path: PathBuf,
    config_path: PathBuf,
}

struct WatcherState(Mutex<Option<RecommendedWatcher>>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    vault_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeItem {
    id: String,
    parent_id: Option<String>,
    name: String,
    sort_order: i64,
    document_count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TagItem {
    id: String,
    name: String,
    color: String,
    document_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentItem {
    id: String,
    node_id: String,
    name: String,
    extension: String,
    size: i64,
    modified_at: i64,
    relative_path: String,
    notes: String,
    tags: Vec<TagItem>,
    expires_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapData {
    vault_path: String,
    nodes: Vec<NodeItem>,
    tags: Vec<TagItem>,
    documents: Vec<DocumentItem>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Preview {
    Image { path: String },
    Pdf { path: String },
    Text { text: String },
    Docx { path: String },
    Unsupported { reason: String },
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WatcherState(Mutex::new(None)))
        .setup(|app| {
            let app_data_path = app
                .path()
                .app_data_dir()
                ?;
            fs::create_dir_all(&app_data_path)?;
            let config_path = app_data_path.join("settings.json");
            let default_vault_path = app_data_path.join("vault");
            let vault_path = read_configured_vault(&config_path).unwrap_or(default_vault_path);
            initialize_vault(&vault_path).map_err(std::io::Error::other)?;
            app.asset_protocol_scope()
                .allow_directory(&vault_path, true)
                .map_err(std::io::Error::other)?;
            let watcher = start_watcher(vault_path.clone()).map_err(std::io::Error::other)?;
            app.manage(AppState { vault_path, config_path });
            let watcher_state = app.state::<WatcherState>();
            *watcher_state.0.lock().map_err(|_| std::io::Error::other("监视器锁异常"))? = Some(watcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            search_documents,
            import_paths,
            open_document,
            reveal_document,
            reveal_vault,
            get_preview,
            create_node,
            rename_node,
            move_node,
            copy_node,
            delete_node,
            create_tag,
            rename_tag,
            update_tag_color,
            delete_tag,
            set_document_tags,
            add_tags_to_documents,
            remove_tags_from_documents,
            update_notes,
            update_expiry,
            rename_document,
            move_documents,
            copy_documents,
            delete_documents,
            export_manifest,
            create_backup,
            change_vault_location
        ])
        .run(tauri::generate_context!())
        .expect("EazyLedger 启动失败");
}

fn read_configured_vault(config_path: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(config_path).ok()?;
    let config: AppConfig = serde_json::from_str(&content).ok()?;
    let path = PathBuf::from(config.vault_path);
    if path.as_os_str().is_empty() { None } else { Some(path) }
}

fn db_path(vault_path: &Path) -> PathBuf {
    vault_path.join("database").join("ledger.db")
}

fn open_db(vault_path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(db_path(vault_path)).map_err(|error| error.to_string())?;
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn initialize_vault(vault_path: &Path) -> Result<(), String> {
    fs::create_dir_all(vault_path.join("database")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault_path.join("files")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault_path.join("backups")).map_err(|error| error.to_string())?;
    fs::create_dir_all(vault_path.join("trash")).map_err(|error| error.to_string())?;
    let connection = open_db(vault_path)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            parent_id TEXT REFERENCES nodes(id),
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL REFERENCES nodes(id),
            display_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            size INTEGER NOT NULL,
            modified_at INTEGER NOT NULL,
            content_text TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            imported_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            color TEXT NOT NULL DEFAULT '#4f7cff'
        );
        CREATE TABLE IF NOT EXISTS document_tags (
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY(document_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_documents_node ON documents(node_id);
        CREATE INDEX IF NOT EXISTS idx_documents_name ON documents(display_name);
        CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified_at DESC);"
    ).map_err(|error| error.to_string())?;
    ensure_document_expiry_column(&connection)?;
    connection.execute(
        "INSERT OR IGNORE INTO nodes(id, parent_id, name, sort_order, created_at) VALUES(?1, NULL, '全部资料', 0, ?2)",
        params![ROOT_NODE_ID, now_ms()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_document_expiry_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection.prepare("PRAGMA table_info(documents)").map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|column| column == "expires_at") {
        connection.execute("ALTER TABLE documents ADD COLUMN expires_at INTEGER", []).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn bootstrap(state: State<AppState>) -> Result<BootstrapData, String> {
    let connection = open_db(&state.vault_path)?;
    let nodes = load_nodes(&connection)?;
    let tags = load_tags(&connection)?;
    let documents = load_documents(&connection)?;
    Ok(BootstrapData {
        vault_path: state.vault_path.to_string_lossy().to_string(),
        nodes,
        tags,
        documents,
    })
}

#[tauri::command]
fn search_documents(
    query: String,
    node_id: Option<String>,
    tag_id: Option<String>,
    state: State<AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let connection = open_db(&state.vault_path)?;
    let nodes = load_nodes(&connection)?;
    let descendants = node_id.as_ref().map(|id| descendant_ids(id, &nodes));
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .collect();
    let mut documents = load_documents(&connection)?;
    documents.retain(|document| {
        let node_match = descendants
            .as_ref()
            .map(|ids| ids.contains(&document.node_id))
            .unwrap_or(true);
        let tag_match = tag_id
            .as_ref()
            .map(|id| document.tags.iter().any(|tag| &tag.id == id))
            .unwrap_or(true);
        if !node_match || !tag_match {
            return false;
        }
        if terms.is_empty() {
            return true;
        }
        let content: String = connection
            .query_row("SELECT content_text FROM documents WHERE id=?1", [&document.id], |row| row.get(0))
            .unwrap_or_default();
        let haystack = format!(
            "{} {} {} {}",
            document.name,
            document.notes,
            content,
            document.tags.iter().map(|tag| tag.name.as_str()).collect::<Vec<_>>().join(" ")
        ).to_lowercase();
        terms.iter().all(|term| haystack.contains(term))
    });
    Ok(documents)
}

#[tauri::command]
fn import_paths(
    paths: Vec<String>,
    node_id: String,
    mode: String,
    state: State<AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let connection = open_db(&state.vault_path)?;
    let node_exists: bool = connection
        .query_row("SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?1)", [&node_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !node_exists {
        return Err("目标台账节点不存在".into());
    }
    for raw in paths {
        let path = PathBuf::from(raw);
        if path.is_dir() {
            import_directory_tree(&connection, &state.vault_path, &path, &node_id, &mode)?;
        } else if path.is_file() {
            if !path.starts_with(state.vault_path.join("files")) {
                import_one(&connection, &state.vault_path, &path, &node_id, &mode)?;
            }
        }
    }
    drop(connection);
    let connection = open_db(&state.vault_path)?;
    load_documents(&connection)
}

fn import_directory_tree(
    connection: &Connection,
    vault: &Path,
    source_root: &Path,
    target_parent_id: &str,
    mode: &str,
) -> Result<(), String> {
    if source_root.starts_with(vault.join("files")) {
        return Ok(());
    }
    let root_name = source_root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("文件夹名称无法识别")?;
    let root_node_id = insert_child_node(connection, target_parent_id, root_name, true)?;
    let mut node_by_path: HashMap<PathBuf, String> = HashMap::new();
    node_by_path.insert(source_root.to_path_buf(), root_node_id);

    for entry in WalkDir::new(source_root).min_depth(1).into_iter().filter_map(Result::ok) {
        let path = entry.path().to_path_buf();
        let parent_path = path.parent().ok_or("无法识别上级目录")?;
        let parent_node_id = node_by_path
            .get(parent_path)
            .cloned()
            .ok_or("导入目录映射异常")?;
        if entry.file_type().is_dir() {
            let name = entry.file_name().to_str().ok_or("目录名称无法识别")?;
            let child_id = insert_child_node(connection, &parent_node_id, name, false)?;
            node_by_path.insert(path, child_id);
        } else if entry.file_type().is_file() {
            import_one(connection, vault, &path, &parent_node_id, mode)?;
        }
    }
    Ok(())
}

fn insert_child_node(connection: &Connection, parent_id: &str, requested_name: &str, unique: bool) -> Result<String, String> {
    let name = if unique { unique_node_name(connection, parent_id, requested_name)? } else { requested_name.to_string() };
    let id = Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO nodes(id, parent_id, name, sort_order, created_at) VALUES(?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM nodes WHERE parent_id=?2), ?4)",
        params![&id, parent_id, name, now_ms()],
    ).map_err(|error| error.to_string())?;
    Ok(id)
}

fn unique_node_name(connection: &Connection, parent_id: &str, requested_name: &str) -> Result<String, String> {
    let exists = |name: &str| -> Result<bool, String> {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE parent_id=?1 AND name=?2 COLLATE NOCASE)",
            params![parent_id, name],
            |row| row.get(0),
        ).map_err(|error| error.to_string())
    };
    if !exists(requested_name)? { return Ok(requested_name.to_string()); }
    for index in 2..10_000 {
        let candidate = format!("{} ({})", requested_name, index);
        if !exists(&candidate)? { return Ok(candidate); }
    }
    Err("无法生成唯一节点名称".into())
}

fn import_one(connection: &Connection, vault: &Path, source: &Path, node_id: &str, mode: &str) -> Result<(), String> {
    let name = source.file_name().and_then(|value| value.to_str()).ok_or("文件名无法识别")?.to_string();
    let id = Uuid::new_v4().to_string();
    let directory = vault.join("files").join(&id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(&name);
    if mode == "move" {
        if fs::rename(source, &destination).is_err() {
            fs::copy(source, &destination).map_err(|error| error.to_string())?;
            fs::remove_file(source).map_err(|error| error.to_string())?;
        }
    } else {
        fs::copy(source, &destination).map_err(|error| error.to_string())?;
    }
    let metadata = fs::metadata(&destination).map_err(|error| error.to_string())?;
    let relative_path = destination.strip_prefix(vault).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
    let extension = destination.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
    let modified_at = modified_ms(&metadata);
    let content_text = extract_text(&destination, &extension);
    connection.execute(
        "INSERT INTO documents(id, node_id, display_name, extension, relative_path, size, modified_at, content_text, notes, imported_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9)",
        params![id, node_id, name, extension, relative_path, metadata.len() as i64, modified_at, content_text, now_ms()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_document(id: String, state: State<AppState>) -> Result<(), String> {
    let path = document_path(&id, &state.vault_path)?;
    open::that(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn reveal_document(id: String, state: State<AppState>) -> Result<(), String> {
    let path = document_path(&id, &state.vault_path)?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    open::that(path.parent().unwrap_or(&path)).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn reveal_vault(state: State<AppState>) -> Result<(), String> {
    open::that(&state.vault_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_preview(id: String, state: State<AppState>) -> Result<Preview, String> {
    let connection = open_db(&state.vault_path)?;
    let (extension, relative_path, text): (String, String, String) = connection
        .query_row("SELECT extension, relative_path, content_text FROM documents WHERE id=?1", [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|error| error.to_string())?;
    let path = state.vault_path.join(relative_path).to_string_lossy().to_string();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => Ok(Preview::Image { path }),
        "pdf" => Ok(Preview::Pdf { path }),
        "docx" => Ok(Preview::Docx { path }),
        "doc" => match convert_legacy_doc_preview(&id, Path::new(&path), &state.vault_path) {
            Ok(preview_path) => Ok(Preview::Pdf { path: preview_path.to_string_lossy().to_string() }),
            Err(reason) => Ok(Preview::Unsupported { reason }),
        },
        "txt" | "md" | "csv" | "json" | "xml" | "log" => Ok(Preview::Text { text }),
        _ => Ok(Preview::Unsupported { reason: "该格式尚未接入内置预览器".into() }),
    }
}

fn convert_legacy_doc_preview(id: &str, source: &Path, vault: &Path) -> Result<PathBuf, String> {
    let cache_dir = vault.join("preview-cache").join(id);
    let cached_pdf = cache_dir.join("preview.pdf");
    if preview_is_fresh(source, &cached_pdf) { return Ok(cached_pdf); }
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;

    let mut candidates = Vec::<PathBuf>::new();
    for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Some(directory) = env::var_os(variable) {
            candidates.push(PathBuf::from(directory).join("LibreOffice").join("program").join("soffice.exe"));
        }
    }
    candidates.push(PathBuf::from("soffice"));
    candidates.push(PathBuf::from("libreoffice"));

    for executable in candidates {
        if executable.is_absolute() && !executable.exists() { continue; }
        let status = Command::new(&executable)
            .args(["--headless", "--convert-to", "pdf", "--outdir"])
            .arg(&cache_dir)
            .arg(source)
            .status();
        if !matches!(status, Ok(value) if value.success()) { continue; }
        let generated = cache_dir
            .join(source.file_stem().and_then(|value| value.to_str()).unwrap_or("document"))
            .with_extension("pdf");
        if !generated.exists() { continue; }
        if generated != cached_pdf {
            fs::copy(&generated, &cached_pdf).map_err(|error| error.to_string())?;
            let _ = fs::remove_file(generated);
        }
        return Ok(cached_pdf);
    }
    Err("旧版 DOC 需要 LibreOffice 才能生成预览。安装 LibreOffice 后重新选择文件，或使用默认程序打开。".into())
}

fn preview_is_fresh(source: &Path, preview: &Path) -> bool {
    let Ok(source_modified) = fs::metadata(source).and_then(|value| value.modified()) else { return false; };
    let Ok(preview_modified) = fs::metadata(preview).and_then(|value| value.modified()) else { return false; };
    preview_modified >= source_modified
}

#[tauri::command]
fn create_node(parent_id: String, name: String, state: State<AppState>) -> Result<(), String> {
    let connection = open_db(&state.vault_path)?;
    connection.execute(
        "INSERT INTO nodes(id, parent_id, name, sort_order, created_at) VALUES(?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM nodes WHERE parent_id=?2), ?4)",
        params![Uuid::new_v4().to_string(), parent_id, name.trim(), now_ms()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_node(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    if id == ROOT_NODE_ID { return Err("根节点不能重命名".into()); }
    open_db(&state.vault_path)?.execute("UPDATE nodes SET name=?1 WHERE id=?2", params![name.trim(), id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_node(id: String, parent_id: String, state: State<AppState>) -> Result<(), String> {
    if id == ROOT_NODE_ID { return Err("根节点不能移动".into()); }
    let connection = open_db(&state.vault_path)?;
    let nodes = load_nodes(&connection)?;
    let descendants = descendant_ids(&id, &nodes);
    if descendants.contains(&parent_id) { return Err("不能将节点移动到自身或其下级节点".into()); }
    connection.execute("UPDATE nodes SET parent_id=?1 WHERE id=?2", params![parent_id, id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_node(id: String, parent_id: String, state: State<AppState>) -> Result<(), String> {
    if id == ROOT_NODE_ID { return Err("根节点不能复制".into()); }
    let connection = open_db(&state.vault_path)?;
    copy_node_recursive(&connection, &state.vault_path, &id, &parent_id, true)?;
    Ok(())
}

fn copy_node_recursive(connection: &Connection, vault: &Path, source_id: &str, target_parent_id: &str, root_copy: bool) -> Result<String, String> {
    let source_name: String = connection.query_row("SELECT name FROM nodes WHERE id=?1", [source_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let requested_name = if root_copy { format!("{} - 副本", source_name) } else { source_name };
    let new_id = insert_child_node(connection, target_parent_id, &requested_name, root_copy)?;

    let document_ids = {
        let mut statement = connection.prepare("SELECT id FROM documents WHERE node_id=?1 ORDER BY imported_at").map_err(|error| error.to_string())?;
        let rows = statement.query_map([source_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    for document_id in document_ids {
        copy_document_internal(connection, vault, &document_id, &new_id)?;
    }

    let child_ids = {
        let mut statement = connection.prepare("SELECT id FROM nodes WHERE parent_id=?1 ORDER BY sort_order").map_err(|error| error.to_string())?;
        let rows = statement.query_map([source_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    for child_id in child_ids {
        copy_node_recursive(connection, vault, &child_id, &new_id, false)?;
    }
    Ok(new_id)
}

#[tauri::command]
fn delete_node(id: String, state: State<AppState>) -> Result<(), String> {
    if id == ROOT_NODE_ID { return Err("根节点不能删除".into()); }
    let connection = open_db(&state.vault_path)?;
    let nodes = load_nodes(&connection)?;
    let descendants = descendant_ids(&id, &nodes);
    let documents = load_documents(&connection)?;
    let document_ids: Vec<String> = documents.into_iter().filter(|document| descendants.contains(&document.node_id)).map(|document| document.id).collect();
    trash_documents_internal(&connection, &state.vault_path, &document_ids)?;
    let mut node_ids: Vec<String> = descendants.into_iter().collect();
    node_ids.sort_by_key(|node_id| std::cmp::Reverse(node_depth(node_id, &nodes)));
    for node_id in node_ids {
        connection.execute("DELETE FROM nodes WHERE id=?1", [&node_id]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn node_depth(id: &str, nodes: &[NodeItem]) -> usize {
    let mut depth = 0;
    let mut current = nodes.iter().find(|node| node.id == id);
    while let Some(node) = current {
        if let Some(parent) = &node.parent_id {
            depth += 1;
            current = nodes.iter().find(|candidate| &candidate.id == parent);
        } else { break; }
    }
    depth
}

#[tauri::command]
fn create_tag(name: String, color: String, state: State<AppState>) -> Result<TagItem, String> {
    let id = Uuid::new_v4().to_string();
    let connection = open_db(&state.vault_path)?;
    connection.execute("INSERT INTO tags(id, name, color) VALUES(?1, ?2, ?3)", params![id, name.trim(), color]).map_err(|error| error.to_string())?;
    Ok(TagItem { id, name: name.trim().to_string(), color, document_count: 0 })
}

#[tauri::command]
fn rename_tag(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    if name.trim().is_empty() { return Err("标签名不能为空".into()); }
    open_db(&state.vault_path)?.execute("UPDATE tags SET name=?1 WHERE id=?2", params![name.trim(), id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_tag_color(id: String, color: String, state: State<AppState>) -> Result<(), String> {
    open_db(&state.vault_path)?.execute("UPDATE tags SET color=?1 WHERE id=?2", params![color, id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_tag(id: String, state: State<AppState>) -> Result<(), String> {
    open_db(&state.vault_path)?.execute("DELETE FROM tags WHERE id=?1", [id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_document_tags(document_id: String, tag_ids: Vec<String>, state: State<AppState>) -> Result<(), String> {
    let mut connection = open_db(&state.vault_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM document_tags WHERE document_id=?1", [&document_id]).map_err(|error| error.to_string())?;
    for tag_id in tag_ids {
        transaction.execute("INSERT OR IGNORE INTO document_tags(document_id, tag_id) VALUES(?1, ?2)", params![&document_id, &tag_id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn add_tags_to_documents(document_ids: Vec<String>, tag_ids: Vec<String>, state: State<AppState>) -> Result<(), String> {
    let mut connection = open_db(&state.vault_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for document_id in &document_ids {
        for tag_id in &tag_ids {
            transaction.execute("INSERT OR IGNORE INTO document_tags(document_id, tag_id) VALUES(?1, ?2)", params![document_id, tag_id]).map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_tags_from_documents(document_ids: Vec<String>, tag_ids: Vec<String>, state: State<AppState>) -> Result<(), String> {
    let mut connection = open_db(&state.vault_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for document_id in &document_ids {
        for tag_id in &tag_ids {
            transaction.execute("DELETE FROM document_tags WHERE document_id=?1 AND tag_id=?2", params![document_id, tag_id]).map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn update_notes(document_id: String, notes: String, state: State<AppState>) -> Result<(), String> {
    open_db(&state.vault_path)?.execute("UPDATE documents SET notes=?1 WHERE id=?2", params![notes, document_id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_expiry(document_id: String, expires_at: Option<i64>, state: State<AppState>) -> Result<(), String> {
    open_db(&state.vault_path)?
        .execute("UPDATE documents SET expires_at=?1 WHERE id=?2", params![expires_at, document_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_document(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    validate_file_name(&name)?;
    let connection = open_db(&state.vault_path)?;
    let (relative, extension): (String, String) = connection.query_row(
        "SELECT relative_path, extension FROM documents WHERE id=?1", [&id], |row| Ok((row.get(0)?, row.get(1)?))
    ).map_err(|error| error.to_string())?;
    let mut final_name = name.trim().to_string();
    if Path::new(&final_name).extension().is_none() && !extension.is_empty() {
        final_name = format!("{}.{}", final_name, extension);
    }
    validate_file_name(&final_name)?;
    let old_path = state.vault_path.join(&relative);
    let new_path = old_path.parent().ok_or("文件路径异常")?.join(&final_name);
    fs::rename(&old_path, &new_path).map_err(|error| error.to_string())?;
    let new_relative = new_path.strip_prefix(&state.vault_path).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
    connection.execute("UPDATE documents SET display_name=?1, relative_path=?2 WHERE id=?3", params![final_name, new_relative, id]).map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_file_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() { return Err("文件名不能为空".into()); }
    if name.chars().any(|character| "<>:\"/\\|?*".contains(character)) { return Err("文件名包含 Windows 不允许的字符".into()); }
    Ok(())
}

#[tauri::command]
fn move_documents(ids: Vec<String>, node_id: String, state: State<AppState>) -> Result<(), String> {
    let mut connection = open_db(&state.vault_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for id in ids {
        transaction.execute("UPDATE documents SET node_id=?1 WHERE id=?2", params![node_id, id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn copy_documents(ids: Vec<String>, node_id: String, state: State<AppState>) -> Result<(), String> {
    let connection = open_db(&state.vault_path)?;
    for id in ids { copy_document_internal(&connection, &state.vault_path, &id, &node_id)?; }
    Ok(())
}

fn copy_document_internal(connection: &Connection, vault: &Path, source_id: &str, target_node_id: &str) -> Result<String, String> {
    let (name, extension, relative, size, modified, content, notes, expires_at): (String, String, String, i64, i64, String, String, Option<i64>) = connection.query_row(
        "SELECT display_name, extension, relative_path, size, modified_at, content_text, notes, expires_at FROM documents WHERE id=?1",
        [source_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
    ).map_err(|error| error.to_string())?;
    let new_id = Uuid::new_v4().to_string();
    let new_name = copy_name(&name);
    let directory = vault.join("files").join(&new_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(&new_name);
    fs::copy(vault.join(&relative), &destination).map_err(|error| error.to_string())?;
    let new_relative = destination.strip_prefix(vault).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
    connection.execute(
        "INSERT INTO documents(id, node_id, display_name, extension, relative_path, size, modified_at, content_text, notes, imported_at, expires_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![&new_id, target_node_id, new_name, extension, new_relative, size, modified, content, notes, now_ms(), expires_at],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO document_tags(document_id, tag_id) SELECT ?1, tag_id FROM document_tags WHERE document_id=?2",
        params![&new_id, source_id],
    ).map_err(|error| error.to_string())?;
    Ok(new_id)
}

fn copy_name(name: &str) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or(name);
    match path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("{} - 副本.{}", stem, extension),
        None => format!("{} - 副本", stem),
    }
}

#[tauri::command]
fn delete_documents(ids: Vec<String>, state: State<AppState>) -> Result<(), String> {
    let connection = open_db(&state.vault_path)?;
    trash_documents_internal(&connection, &state.vault_path, &ids)
}

fn trash_documents_internal(connection: &Connection, vault: &Path, ids: &[String]) -> Result<(), String> {
    for id in ids {
        let directory = vault.join("files").join(id);
        if directory.exists() {
            let destination = vault.join("trash").join(format!("{}-{}", id, now_ms()));
            fs::rename(&directory, &destination).map_err(|error| error.to_string())?;
        }
        connection.execute("DELETE FROM documents WHERE id=?1", [id]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn export_manifest(destination: String, state: State<AppState>) -> Result<(), String> {
    let connection = open_db(&state.vault_path)?;
    let documents = load_documents(&connection)?;
    let json = serde_json::to_string_pretty(&documents).map_err(|error| error.to_string())?;
    fs::write(destination, json).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_backup(destination: String, state: State<AppState>) -> Result<(), String> {
    let target = PathBuf::from(destination);
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    copy_directory(&state.vault_path, &target.join("vault"))
}

#[tauri::command]
fn change_vault_location(destination: String, migrate: bool, state: State<AppState>) -> Result<String, String> {
    let destination = PathBuf::from(destination);
    if destination == state.vault_path {
        return Err("所选目录已经是当前资料库位置".into());
    }
    if destination.starts_with(&state.vault_path) || state.vault_path.starts_with(&destination) {
        return Err("新位置不能位于当前资料库内部，也不能是当前资料库的上级目录".into());
    }
    fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    let destination_not_empty = fs::read_dir(&destination).map_err(|error| error.to_string())?.next().is_some();
    if migrate {
        if destination_not_empty {
            return Err("为避免覆盖其他文件，迁移目标必须是空目录".into());
        }
        let connection = open_db(&state.vault_path)?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|error| error.to_string())?;
        drop(connection);
        copy_directory(&state.vault_path, &destination)?;
    } else {
        if destination_not_empty {
            return Err("为避免覆盖其他文件，新资料库位置必须是空目录".into());
        }
        initialize_vault(&destination)?;
    }
    let config = AppConfig { vault_path: destination.to_string_lossy().to_string() };
    let serialized = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&state.config_path, serialized).map_err(|error| error.to_string())?;
    Ok(format!("新的资料库位置已设置为 {}。请关闭并重新打开应用以完成切换。旧资料库仍保留在原位置。", destination.to_string_lossy()))
}

fn load_nodes(connection: &Connection) -> Result<Vec<NodeItem>, String> {
    let mut statement = connection.prepare(
        "SELECT n.id, n.parent_id, n.name, n.sort_order, COUNT(d.id)
         FROM nodes n LEFT JOIN documents d ON d.node_id=n.id
         GROUP BY n.id ORDER BY n.sort_order, n.name"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(NodeItem { id: row.get(0)?, parent_id: row.get(1)?, name: row.get(2)?, sort_order: row.get(3)?, document_count: row.get(4)? })).map_err(|error| error.to_string())?;
    let mut nodes = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let snapshot = nodes.clone();
    let direct_counts: HashMap<String, i64> = snapshot.iter().map(|node| (node.id.clone(), node.document_count)).collect();
    for node in &mut nodes {
        node.document_count = descendant_ids(&node.id, &snapshot).iter().map(|id| direct_counts.get(id).copied().unwrap_or(0)).sum();
    }
    Ok(nodes)
}

fn load_tags(connection: &Connection) -> Result<Vec<TagItem>, String> {
    let mut statement = connection.prepare(
        "SELECT t.id, t.name, t.color, COUNT(dt.document_id) FROM tags t LEFT JOIN document_tags dt ON dt.tag_id=t.id GROUP BY t.id ORDER BY t.name"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(TagItem { id: row.get(0)?, name: row.get(1)?, color: row.get(2)?, document_count: row.get(3)? })).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

fn load_documents(connection: &Connection) -> Result<Vec<DocumentItem>, String> {
    let mut statement = connection.prepare(
        "SELECT id, node_id, display_name, extension, size, modified_at, relative_path, notes, expires_at FROM documents ORDER BY modified_at DESC"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<i64>>(8)?))).map_err(|error| error.to_string())?;
    let raw = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    raw.into_iter().map(|(id, node_id, name, extension, size, modified_at, relative_path, notes, expires_at)| {
        Ok(DocumentItem { tags: tags_for_document(connection, &id)?, id, node_id, name, extension, size, modified_at, relative_path, notes, expires_at })
    }).collect()
}

fn tags_for_document(connection: &Connection, document_id: &str) -> Result<Vec<TagItem>, String> {
    let mut statement = connection.prepare(
        "SELECT t.id, t.name, t.color FROM tags t JOIN document_tags dt ON dt.tag_id=t.id WHERE dt.document_id=?1 ORDER BY t.name"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([document_id], |row| Ok(TagItem { id: row.get(0)?, name: row.get(1)?, color: row.get(2)?, document_count: 0 })).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

fn descendant_ids(node_id: &str, nodes: &[NodeItem]) -> HashSet<String> {
    let mut ids = HashSet::from([node_id.to_string()]);
    loop {
        let before = ids.len();
        for node in nodes {
            if node.parent_id.as_ref().map(|parent| ids.contains(parent)).unwrap_or(false) {
                ids.insert(node.id.clone());
            }
        }
        if ids.len() == before { break; }
    }
    ids
}

fn document_path(id: &str, vault: &Path) -> Result<PathBuf, String> {
    let connection = open_db(vault)?;
    let relative: String = connection.query_row("SELECT relative_path FROM documents WHERE id=?1", [id], |row| row.get(0)).map_err(|_| "文件记录不存在".to_string())?;
    let path = vault.join(relative);
    if !path.exists() { return Err("资料文件已丢失，请检查资料库".into()); }
    Ok(path)
}

fn extract_text(path: &Path, extension: &str) -> String {
    match extension {
        "txt" | "md" | "csv" | "json" | "xml" | "log" => fs::read_to_string(path).unwrap_or_default(),
        "docx" => extract_docx(path).unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_docx(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut document = archive.by_name("word/document.xml").map_err(|error| error.to_string())?;
    let mut xml = String::new();
    document.read_to_string(&mut xml).map_err(|error| error.to_string())?;
    let paragraph = Regex::new(r"</w:p>").map_err(|error| error.to_string())?;
    let tab = Regex::new(r"<w:tab[^>]*/>").map_err(|error| error.to_string())?;
    let tags = Regex::new(r"<[^>]+>").map_err(|error| error.to_string())?;
    let text = paragraph.replace_all(&xml, "\n");
    let text = tab.replace_all(&text, "\t");
    let text = tags.replace_all(&text, "");
    Ok(text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'"))
}

fn start_watcher(vault: PathBuf) -> Result<RecommendedWatcher, String> {
    let watched_vault = vault.clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        if let Ok(event) = result {
            for path in event.paths {
                if path.is_file() {
                    let _ = refresh_changed_file(&watched_vault, &path);
                }
            }
        }
    }).map_err(|error| error.to_string())?;
    watcher.watch(&vault.join("files"), RecursiveMode::Recursive).map_err(|error| error.to_string())?;
    Ok(watcher)
}

fn refresh_changed_file(vault: &Path, path: &Path) -> Result<(), String> {
    let relative = path.strip_prefix(vault).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
    let connection = open_db(vault)?;
    let record: Result<(String, String), _> = connection.query_row("SELECT id, extension FROM documents WHERE relative_path=?1", [&relative], |row| Ok((row.get(0)?, row.get(1)?)));
    let (id, extension) = match record { Ok(value) => value, Err(_) => return Ok(()) };
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE documents SET size=?1, modified_at=?2, content_text=?3 WHERE id=?4",
        params![metadata.len() as i64, modified_ms(&metadata), extract_text(path, &extension), id],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in WalkDir::new(source).into_iter().filter_map(Result::ok) {
        let relative = entry.path().strip_prefix(source).map_err(|error| error.to_string())?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() { fs::create_dir_all(&target).map_err(|error| error.to_string())?; }
        else { fs::copy(entry.path(), target).map_err(|error| error.to_string())?; }
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration| duration.as_millis() as i64).unwrap_or_else(now_ms)
}
