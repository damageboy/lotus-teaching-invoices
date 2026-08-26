const COMMANDS: &[&str] = &["authorize", "clearAccessToken", "openPdf"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
