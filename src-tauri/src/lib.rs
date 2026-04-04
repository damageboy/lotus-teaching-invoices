use tauri::Manager;

mod oauth;

struct ConfigPath(Option<String>);

#[tauri::command]
fn get_config_path(state: tauri::State<ConfigPath>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    // Parse --config <path> from CLI args (used by e2e tests for config isolation)
    let config_path: Option<String> = std::env::args()
        .skip_while(|a| a != "--config")
        .nth(1);

    let builder = tauri::Builder::default()
        .manage(ConfigPath(config_path))
        .manage(oauth::OAuthListener(std::sync::Mutex::new(None)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "[{}][{}] {}",
                        record.level(),
                        record
                            .target()
                            .split_once('@')
                            .map(|(t, _)| t)
                            .unwrap_or(record.target()),
                        message
                    ))
                })
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            log::info!("App started. AppData: {}", app_data_dir.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            get_config_path,
            oauth::start_oauth_server,
            oauth::wait_oauth_code
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
