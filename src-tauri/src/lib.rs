use tauri::Manager;

mod app_storage;
pub mod calendar_api;
mod calendar_edit;
mod calendar_store;
mod calendar_sync;
#[cfg(feature = "webdriver")]
mod e2e_support;
mod invoice_files;
mod invoice_freshness;
mod oauth;

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

fn calendar_edit_invoice_impacts(
    events: &[(&str, &str)],
    proposed_studio: Option<&str>,
) -> Vec<(String, String)> {
    let proposed_studio = proposed_studio
        .map(str::trim)
        .filter(|studio| !studio.is_empty());
    let mut impacts = std::collections::BTreeSet::new();
    for (summary, start) in events {
        let Some(month_key) = start.get(..7).filter(|month| {
            let bytes = month.as_bytes();
            bytes.len() == 7
                && bytes[4] == b'-'
                && bytes[..4].iter().all(u8::is_ascii_digit)
                && bytes[5..].iter().all(u8::is_ascii_digit)
        }) else {
            continue;
        };
        if let Some(studio) = summary
            .split('/')
            .next()
            .map(str::trim)
            .filter(|studio| !studio.is_empty())
        {
            impacts.insert((studio.to_string(), month_key.to_string()));
        }
        if let Some(studio) = proposed_studio {
            impacts.insert((studio.to_string(), month_key.to_string()));
        }
    }
    impacts.into_iter().collect()
}

fn mark_calendar_edit_invoice_impacts(
    service: &invoice_freshness::InvoiceFreshnessService,
    calendar_id: &str,
    output_dir: Option<&str>,
    impacts: Vec<(String, String)>,
    operation_id: &str,
) -> Result<(), calendar_edit::CalendarEditCommandError> {
    let Some(output_dir) = output_dir.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    for (studio_name, month_key) in impacts {
        service
            .mark_finalized_invoice_stale(
                &invoice_freshness::InvoiceFreshnessKey {
                    calendar_id: calendar_id.to_string(),
                    output_dir: output_dir.to_string(),
                    studio_name,
                    month_key,
                },
                "Calendar lesson changed",
                operation_id,
            )
            .map_err(|error| calendar_edit::CalendarEditCommandError {
                code: calendar_edit::CalendarEditErrorCode::LocalError,
                message: format!(
                    "Google Calendar was updated, but invoice status could not be updated: {}",
                    error.message
                ),
                retryable: true,
            })?;
    }
    Ok(())
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
    freshness: tauri::State<'_, invoice_freshness::InvoiceFreshnessService>,
    access_token: String,
    preflight: calendar_edit::OccurrenceStudioEditPreflight,
    output_dir: Option<String>,
) -> Result<calendar_edit::CalendarEditedEvent, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    let current_summary = preflight.current_summary.clone();
    let result =
        calendar_edit::apply_occurrence_studio_edit(&store, &client, &access_token, preflight)
            .await?;
    let events = [(current_summary.as_str(), result.start.as_str())];
    let proposed_studio = result.summary.split('/').next();
    let operation_id = format!(
        "calendar-edit:{}:{}",
        result.identity.event_id,
        result.identity.etag.as_deref().unwrap_or("missing-etag")
    );
    mark_calendar_edit_invoice_impacts(
        &freshness,
        &result.identity.calendar_id,
        output_dir.as_deref(),
        calendar_edit_invoice_impacts(&events, proposed_studio),
        &operation_id,
    )?;
    Ok(result)
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
    freshness: tauri::State<'_, invoice_freshness::InvoiceFreshnessService>,
    access_token: String,
    preflight: calendar_edit::SeriesStudioEditPreflight,
    output_dir: Option<String>,
) -> Result<calendar_edit::SeriesStudioEditResult, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    let instances = store
        .list_series_instances(&preflight.calendar_id, &preflight.master_event_id)
        .map_err(|error| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message: error.to_string(),
            retryable: true,
        })?;
    let proposed_studio = preflight
        .proposed_summary
        .split('/')
        .next()
        .map(str::to_string);
    let operation_id = format!(
        "calendar-series:{}:{}:{}",
        preflight.master_event_id, preflight.master_etag, preflight.proposed_summary
    );
    let applied =
        calendar_edit::apply_series_studio_edit(&store, &client, &access_token, preflight).await?;
    let events = instances
        .iter()
        .map(|instance| (instance.summary.as_str(), instance.start_ts.as_str()))
        .collect::<Vec<_>>();
    let freshness_result = mark_calendar_edit_invoice_impacts(
        &freshness,
        &applied.calendar_id,
        output_dir.as_deref(),
        calendar_edit_invoice_impacts(&events, proposed_studio.as_deref()),
        &operation_id,
    );
    let reconciliation_pending =
        calendar_sync::sync_calendar(&store, &applied.calendar_id, &access_token)
            .await
            .is_err();
    freshness_result?;
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
    freshness: tauri::State<'_, invoice_freshness::InvoiceFreshnessService>,
    access_token: String,
    preflight: calendar_edit::OccurrenceValueEditPreflight,
    confirm_unsupported_replacement: bool,
    output_dir: Option<String>,
) -> Result<calendar_edit::CalendarEditedEvent, calendar_edit::CalendarEditCommandError> {
    let store =
        calendar_store(&app).map_err(|message| calendar_edit::CalendarEditCommandError {
            code: calendar_edit::CalendarEditErrorCode::LocalError,
            message,
            retryable: true,
        })?;
    let client = calendar_api::GoogleCalendarClient::new();
    let result = calendar_edit::apply_occurrence_value_edit(
        &store,
        &client,
        &access_token,
        preflight,
        confirm_unsupported_replacement,
    )
    .await?;
    let events = [(result.summary.as_str(), result.start.as_str())];
    let operation_id = format!(
        "calendar-edit:{}:{}",
        result.identity.event_id,
        result.identity.etag.as_deref().unwrap_or("missing-etag")
    );
    mark_calendar_edit_invoice_impacts(
        &freshness,
        &result.identity.calendar_id,
        output_dir.as_deref(),
        calendar_edit_invoice_impacts(&events, None),
        &operation_id,
    )?;
    Ok(result)
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

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
        let storage = app_storage::AppStorage::new(storage_root)?;
        let invoice_freshness =
            invoice_freshness::InvoiceFreshnessService::for_app_storage_root(storage.root())
                .map_err(|_| std::io::Error::other("Could not initialize invoice freshness"))?;
        log::info!("App started. AppData: {}", storage.root().display());
        app.manage(storage);
        app.manage(invoice_freshness);
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
        invoice_freshness::list_active_invoice_freshness,
        invoice_freshness::prepare_re_finalization,
        invoice_freshness::prepare_invoice_email,
        invoice_freshness::write_re_finalized_invoice,
        invoice_freshness::mark_invoice_freshness,
        invoice_freshness::clear_invoice_freshness,
        app_storage::read_auth_tokens,
        app_storage::write_auth_tokens,
        app_storage::read_calendar_edit_prompt_preference,
        app_storage::write_calendar_edit_prompt_preference,
        oauth::start_oauth_server,
        oauth::cancel_oauth_server,
        oauth::wait_oauth_code
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
        invoice_freshness::list_active_invoice_freshness,
        invoice_freshness::prepare_re_finalization,
        invoice_freshness::prepare_invoice_email,
        invoice_freshness::write_re_finalized_invoice,
        invoice_freshness::mark_invoice_freshness,
        invoice_freshness::clear_invoice_freshness,
        app_storage::read_auth_tokens,
        app_storage::write_auth_tokens,
        app_storage::read_calendar_edit_prompt_preference,
        app_storage::write_calendar_edit_prompt_preference,
        oauth::start_oauth_server,
        oauth::cancel_oauth_server,
        oauth::wait_oauth_code,
        e2e_support::e2e_seed_runtime,
        e2e_support::e2e_runtime_status,
        e2e_support::e2e_arm_failpoint
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
    use super::{
        calendar_edit_invoice_impacts, CalendarApiCommandError, CalendarEventDto,
        CalendarEventIdentityDto,
    };
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

    #[test]
    fn calendar_edit_impacts_cover_old_and_new_studios_once_per_month() {
        let impacts = calendar_edit_invoice_impacts(
            &[
                ("Old Studio / Flow", "2026-01-03T09:00:00+01:00"),
                ("Old Studio / Yin", "2026-01-10T09:00:00+01:00"),
                ("Exception Studio / Flow", "2026-02-07T09:00:00+01:00"),
            ],
            Some("New Studio"),
        );

        assert_eq!(
            impacts,
            vec![
                ("Exception Studio".to_string(), "2026-02".to_string()),
                ("New Studio".to_string(), "2026-01".to_string()),
                ("New Studio".to_string(), "2026-02".to_string()),
                ("Old Studio".to_string(), "2026-01".to_string()),
            ]
        );
    }
}
