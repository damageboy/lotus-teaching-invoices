use tauri::Manager;

mod app_storage;
pub mod calendar_api;
mod calendar_edit;
mod calendar_store;
mod calendar_sync;
pub mod drive_api;
#[cfg(feature = "webdriver")]
mod e2e_support;
mod gmail_api;
mod oauth;
mod temp_pdfs;

struct ConfigPath(Option<String>);

fn application_log_targets() -> Vec<tauri_plugin_log::Target> {
    vec![
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        #[cfg(not(feature = "webdriver"))]
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
    ]
}

fn application_log_level() -> log::LevelFilter {
    #[cfg(feature = "webdriver")]
    {
        log::LevelFilter::Info
    }
    #[cfg(not(feature = "webdriver"))]
    {
        log::LevelFilter::Debug
    }
}

fn application_http_plugin_enabled() -> bool {
    cfg!(not(feature = "webdriver"))
}

#[cfg(feature = "webdriver")]
fn configure_webdriver_windows(windows: &mut [tauri::utils::config::WindowConfig]) {
    for window in windows {
        window.incognito = true;
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEventIdentityDto {
    calendar_id: String,
    event_id: String,
    recurring_event_id: Option<String>,
    original_start_time: Option<String>,
    etag: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEventDto {
    identity: CalendarEventIdentityDto,
    summary: String,
    description: String,
    start: String,
    end: String,
    status: String,
    updated: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarApiCommandError {
    code: calendar_api::CalendarApiErrorCode,
    message: String,
}

impl From<calendar_api::CalendarApiError> for CalendarApiCommandError {
    fn from(error: calendar_api::CalendarApiError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

fn calendar_store(app: &tauri::AppHandle) -> Result<calendar_store::CalendarStore, String> {
    let storage = app
        .try_state::<app_storage::AppStorage>()
        .ok_or("Application storage is not initialized")?;
    calendar_store::CalendarStore::open(storage.calendar_cache_path()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config_path(state: tauri::State<ConfigPath>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(feature = "webdriver")]
    if app
        .try_state::<e2e_support::E2eRuntime>()
        .is_some_and(|runtime| runtime.suppress_open_file())
    {
        return Ok(());
    }
    #[cfg(not(feature = "webdriver"))]
    let _ = app;
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn sync_calendar(
    app: tauri::AppHandle,
    calendar_id: String,
    access_token: String,
) -> Result<calendar_sync::SyncResult, String> {
    let store = calendar_store(&app)?;
    calendar_sync::sync_calendar(&store, &calendar_id, &access_token).await
}

#[tauri::command]
async fn list_calendars(
    access_token: String,
) -> Result<Vec<calendar_api::GoogleCalendarListEntry>, CalendarApiCommandError> {
    let client = calendar_api::GoogleCalendarClient::new();
    calendar_api::CalendarApi::list_calendars(&client, &access_token)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn preflight_calendar_occurrence_studio_edit(
    app: tauri::AppHandle,
    access_token: String,
    request: calendar_edit::OccurrenceStudioEditRequest,
) -> Result<calendar_edit::OccurrenceStudioEditPreflight, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    calendar_edit::preflight_occurrence_studio_edit(&store, &client, &access_token, request).await
}

#[tauri::command]
async fn apply_calendar_occurrence_studio_edit(
    app: tauri::AppHandle,
    access_token: String,
    preflight: calendar_edit::OccurrenceStudioEditPreflight,
) -> Result<calendar_edit::CalendarEditedEvent, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    calendar_edit::apply_occurrence_studio_edit(&store, &client, &access_token, preflight).await
}

#[tauri::command]
async fn preflight_calendar_series_studio_edit(
    app: tauri::AppHandle,
    access_token: String,
    request: calendar_edit::SeriesStudioEditRequest,
) -> Result<calendar_edit::SeriesStudioEditPreflight, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    calendar_edit::preflight_series_studio_edit(&store, &client, &access_token, request).await
}

#[tauri::command]
async fn apply_calendar_series_studio_edit(
    app: tauri::AppHandle,
    access_token: String,
    preflight: calendar_edit::SeriesStudioEditPreflight,
) -> Result<calendar_edit::SeriesStudioEditResult, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    let applied =
        calendar_edit::apply_series_studio_edit(&store, &client, &access_token, preflight).await?;
    let reconciliation_pending =
        calendar_sync::sync_calendar(&store, &applied.calendar_id, &access_token)
            .await
            .is_err();
    Ok(calendar_edit::SeriesStudioEditResult {
        applied,
        reconciliation_pending,
    })
}

#[tauri::command]
async fn preflight_calendar_occurrence_value_edit(
    app: tauri::AppHandle,
    access_token: String,
    request: calendar_edit::OccurrenceValueEditRequest,
) -> Result<calendar_edit::OccurrenceValueEditPreflight, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    calendar_edit::preflight_occurrence_value_edit(&store, &client, &access_token, request).await
}

#[tauri::command]
async fn apply_calendar_occurrence_value_edit(
    app: tauri::AppHandle,
    access_token: String,
    preflight: calendar_edit::OccurrenceValueEditPreflight,
    confirm_unsupported_replacement: bool,
) -> Result<calendar_edit::CalendarEditedEvent, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    calendar_edit::apply_occurrence_value_edit(
        &store,
        &client,
        &access_token,
        preflight,
        confirm_unsupported_replacement,
    )
    .await
}

#[tauri::command]
fn list_calendar_events(
    app: tauri::AppHandle,
    calendar_id: String,
) -> Result<Vec<CalendarEventDto>, String> {
    let store = calendar_store(&app)?;
    let events = store.list_events(&calendar_id).map_err(|e| e.to_string())?;
    Ok(events
        .into_iter()
        .map(|event| CalendarEventDto {
            identity: CalendarEventIdentityDto {
                calendar_id: event.calendar_id,
                event_id: event.event_id,
                recurring_event_id: event.recurring_event_id,
                original_start_time: event.original_start_time,
                etag: event.etag,
            },
            summary: event.summary,
            description: event.description,
            start: event.start_ts,
            end: event.end_ts,
            status: event.status,
            updated: event.updated_ts,
        })
        .collect())
}

#[tauri::command]
fn clear_calendar_cache(app: tauri::AppHandle, calendar_id: String) -> Result<(), String> {
    let store = calendar_store(&app)?;
    store
        .clear_calendar(&calendar_id)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse --config <path> from CLI args (used by e2e tests for config isolation)
    let config_path: Option<String> = std::env::args().skip_while(|a| a != "--config").nth(1);
    #[cfg(feature = "webdriver")]
    let config_path_for_setup = config_path.clone();

    let builder = tauri::Builder::default()
        .manage(ConfigPath(config_path))
        .manage(oauth::OAuthListener::default())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(application_log_level())
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
                .targets(application_log_targets())
                .build(),
        );
    let builder = if application_http_plugin_enabled() {
        builder.plugin(tauri_plugin_http::init())
    } else {
        builder
    };
    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_lotus_mobile::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    let builder = builder.setup(move |app| {
        #[cfg(feature = "webdriver")]
        let (storage_root, e2e_runtime) = {
            let runtime = e2e_support::E2eRuntime::from_process(
                config_path_for_setup.as_deref().map(std::path::Path::new),
            )
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
            (runtime.data_root().to_path_buf(), runtime)
        };
        #[cfg(not(feature = "webdriver"))]
        let storage_root = app.path().app_data_dir()?;
        #[cfg(feature = "webdriver")]
        let drive_client = drive_api::DriveClient::new_for_webdriver(
            e2e_runtime.drive_api_base().clone(),
            e2e_runtime.drive_upload_base().clone(),
        );
        #[cfg(not(feature = "webdriver"))]
        let drive_client = drive_api::DriveClient::new();
        #[cfg(feature = "webdriver")]
        let gmail_client =
            gmail_api::GmailClient::new_for_webdriver(e2e_runtime.gmail_api_base().clone());
        #[cfg(not(feature = "webdriver"))]
        let gmail_client = gmail_api::GmailClient::new();
        temp_pdfs::cleanup_on_startup(app.handle())?;
        let storage = app_storage::AppStorage::new(storage_root)?;
        log::info!("App started. AppData: {}", storage.root().display());
        app.manage(storage);
        app.manage(drive_client);
        app.manage(gmail_client);
        #[cfg(feature = "webdriver")]
        {
            app.manage(e2e_runtime);
            println!("{}", e2e_support::WEBDRIVER_READY_MARKER);
        }
        Ok(())
    });

    #[cfg(not(feature = "webdriver"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_file,
        get_config_path,
        sync_calendar,
        list_calendars,
        preflight_calendar_occurrence_studio_edit,
        apply_calendar_occurrence_studio_edit,
        preflight_calendar_series_studio_edit,
        apply_calendar_series_studio_edit,
        preflight_calendar_occurrence_value_edit,
        apply_calendar_occurrence_value_edit,
        list_calendar_events,
        clear_calendar_cache,
        app_storage::read_auth_tokens,
        app_storage::write_auth_tokens,
        app_storage::read_calendar_edit_prompt_preference,
        app_storage::write_calendar_edit_prompt_preference,
        oauth::start_oauth_server,
        oauth::cancel_oauth_server,
        oauth::wait_oauth_code,
        drive_api::commands::list_shared_drives,
        drive_api::commands::list_files,
        drive_api::commands::get_file,
        drive_api::commands::download_file,
        drive_api::commands::generate_file_ids,
        drive_api::commands::create_folder,
        drive_api::commands::create_file,
        drive_api::commands::update_file,
        drive_api::commands::patch_metadata,
        gmail_api::gmail_create_draft,
        temp_pdfs::write_and_open_temp_pdf
    ]);

    #[cfg(feature = "webdriver")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_file,
        get_config_path,
        sync_calendar,
        list_calendars,
        preflight_calendar_occurrence_studio_edit,
        apply_calendar_occurrence_studio_edit,
        preflight_calendar_series_studio_edit,
        apply_calendar_series_studio_edit,
        preflight_calendar_occurrence_value_edit,
        apply_calendar_occurrence_value_edit,
        list_calendar_events,
        clear_calendar_cache,
        app_storage::read_auth_tokens,
        app_storage::write_auth_tokens,
        app_storage::read_calendar_edit_prompt_preference,
        app_storage::write_calendar_edit_prompt_preference,
        oauth::start_oauth_server,
        oauth::cancel_oauth_server,
        oauth::wait_oauth_code,
        drive_api::commands::list_shared_drives,
        drive_api::commands::list_files,
        drive_api::commands::get_file,
        drive_api::commands::download_file,
        drive_api::commands::generate_file_ids,
        drive_api::commands::create_folder,
        drive_api::commands::create_file,
        drive_api::commands::update_file,
        drive_api::commands::patch_metadata,
        gmail_api::gmail_create_draft,
        temp_pdfs::write_and_open_temp_pdf,
        e2e_support::e2e_seed_runtime,
        e2e_support::e2e_runtime_status,
        e2e_support::e2e_arm_failpoint,
        e2e_support::e2e_read_cached_pdf,
        e2e_support::e2e_confirm_invoice
    ]);

    let context = tauri::generate_context!();
    #[cfg(feature = "webdriver")]
    let context = {
        let mut context = context;
        configure_webdriver_windows(&mut context.config_mut().app.windows);
        context
    };
    builder
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{CalendarApiCommandError, CalendarEventDto, CalendarEventIdentityDto};
    use crate::calendar_api::CalendarApiErrorCode;
    use serde_json::json;

    #[cfg(not(feature = "webdriver"))]
    #[test]
    fn production_context_keeps_the_persistent_webview_data_store() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert!(!windows.is_empty());
        assert!(windows.iter().all(|window| {
            window
                .get("incognito")
                .and_then(serde_json::Value::as_bool)
                .is_none_or(|incognito| !incognito)
        }));
    }

    #[test]
    fn calendar_event_dto_serializes_one_nested_identity_authority() {
        let dto = CalendarEventDto {
            identity: CalendarEventIdentityDto {
                calendar_id: "calendar-1".to_string(),
                event_id: "event-1".to_string(),
                recurring_event_id: Some("series-1".to_string()),
                original_start_time: Some("2026-01-10T09:00:00+01:00".to_string()),
                etag: Some("etag-1".to_string()),
            },
            summary: "Studio / Flow".to_string(),
            description: "8".to_string(),
            start: "2026-01-10T09:00:00+01:00".to_string(),
            end: "2026-01-10T10:00:00+01:00".to_string(),
            status: "confirmed".to_string(),
            updated: Some("2026-01-09T12:00:00Z".to_string()),
        };

        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({
                "identity": {
                    "calendarId": "calendar-1",
                    "eventId": "event-1",
                    "recurringEventId": "series-1",
                    "originalStartTime": "2026-01-10T09:00:00+01:00",
                    "etag": "etag-1"
                },
                "summary": "Studio / Flow",
                "description": "8",
                "start": "2026-01-10T09:00:00+01:00",
                "end": "2026-01-10T10:00:00+01:00",
                "status": "confirmed",
                "updated": "2026-01-09T12:00:00Z"
            })
        );
    }

    #[test]
    fn calendar_api_command_error_preserves_the_shared_typed_code() {
        let error = CalendarApiCommandError {
            code: CalendarApiErrorCode::RateLimited,
            message: "Calendar quota exceeded".to_string(),
        };

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({
                "code": "rateLimited",
                "message": "Calendar quota exceeded"
            })
        );
    }
}
