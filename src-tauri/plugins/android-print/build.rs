// No commands are exposed to the webview: the app's own Rust code calls the plugin, so no
// permission files are needed. `android_path` tells tauri-plugin where the Gradle project is.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
