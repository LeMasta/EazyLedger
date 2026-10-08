fn main() {
    // Tauri embeds the configured Windows icon through its generated resources.
    // Track these files explicitly so incremental builds relink the executable
    // when the source icon is regenerated without a config change.
    for icon in ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}

