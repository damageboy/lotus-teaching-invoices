use crate::app_storage::{AppStorage, StorageWriteOutcome};
use crate::calendar_store::{CalendarStore, StoredCalendarEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use url::Url;

const DATA_DIR_ARG: &str = "--e2e-data-dir";
const RUN_MARKER_TOKEN_ARG: &str = "--e2e-run-marker-token";
const RUN_ROOT_PREFIX: &str = "lotus-calendar-e2e-";
const RUN_MARKER_FILE: &str = ".lotus-e2e-run";
pub(crate) const WEBDRIVER_READY_MARKER: &str = "LOTUS_E2E_WEBDRIVER_READY http://127.0.0.1:4445";
pub(crate) const RUN_ROOT_ENV: &str = "LOTUS_E2E_RUN_ROOT";
pub(crate) const CALENDAR_API_BASE_ENV: &str = "LOTUS_E2E_CALENDAR_API_BASE";
pub(crate) const SUPPRESS_OPEN_FILE_ENV: &str = "LOTUS_E2E_SUPPRESS_OPEN_FILE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IsolatedStoragePaths {
    pub calendar_cache: PathBuf,
    pub auth_record: PathBuf,
    pub prompt_preference: PathBuf,
    pub pending_edit_journal: PathBuf,
    pub invoice_freshness: PathBuf,
}

impl IsolatedStoragePaths {
    #[cfg(test)]
    pub fn all(&self) -> [&Path; 5] {
        [
            &self.calendar_cache,
            &self.auth_record,
            &self.prompt_preference,
            &self.pending_edit_journal,
            &self.invoice_freshness,
        ]
    }
}

pub(crate) fn isolated_storage_paths(storage: &AppStorage) -> IsolatedStoragePaths {
    IsolatedStoragePaths {
        calendar_cache: storage.calendar_cache_path(),
        auth_record: storage.auth_tokens_path(),
        prompt_preference: storage.prompt_preference_path(),
        pending_edit_journal: storage.root().join("calendar-edit-operations.sqlite"),
        invoice_freshness: storage.root().join("invoice-freshness.sqlite"),
    }
}

pub(crate) fn resolve_isolated_data_root(
    args: &[OsString],
    run_root: &Path,
) -> Result<PathBuf, String> {
    if !run_root.is_absolute() {
        return Err("The E2E run root must be absolute".to_string());
    }
    let run_root_metadata = std::fs::symlink_metadata(run_root)
        .map_err(|_| "The E2E run root must exist".to_string())?;
    if !run_root_metadata.is_dir() || run_root_metadata.file_type().is_symlink() {
        return Err("The E2E run root must be a real directory".to_string());
    }
    let canonical_run_root = run_root
        .canonicalize()
        .map_err(|_| "The E2E run root must exist".to_string())?;
    if canonical_run_root != run_root {
        return Err("The E2E run root must be canonical".to_string());
    }
    let canonical_temp_root = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "The platform temp directory must exist".to_string())?;
    let has_expected_prefix = canonical_run_root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(RUN_ROOT_PREFIX))
        .is_some_and(|suffix| !suffix.is_empty());
    if canonical_run_root.parent() != Some(canonical_temp_root.as_path()) || !has_expected_prefix {
        return Err(
            "The E2E run root must be an immediate prefixed child of the platform temp directory"
                .to_string(),
        );
    }

    let mut selected: Option<&OsString> = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == DATA_DIR_ARG {
            if selected.is_some() {
                return Err("--e2e-data-dir may be supplied only once".to_string());
            }
            let value = args
                .get(index + 1)
                .ok_or("--e2e-data-dir requires a path")?;
            selected = Some(value);
            index += 1;
        }
        index += 1;
    }
    let selected = PathBuf::from(selected.ok_or("--e2e-data-dir is required")?);
    if !selected.is_absolute() {
        return Err("The E2E data directory must be absolute".to_string());
    }
    let selected_metadata = std::fs::symlink_metadata(&selected)
        .map_err(|_| "The E2E data directory must already exist".to_string())?;
    if !selected_metadata.is_dir() || selected_metadata.file_type().is_symlink() {
        return Err("The E2E data directory must be a real directory".to_string());
    }
    let canonical_data = selected
        .canonicalize()
        .map_err(|_| "The E2E data directory must already exist".to_string())?;
    let expected_data = canonical_run_root.join("app-data");
    if selected != expected_data || canonical_data != expected_data {
        return Err("The E2E data directory must be the direct app-data child".to_string());
    }
    Ok(canonical_data)
}

pub(crate) fn validate_calendar_api_base(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| "Invalid E2E Calendar API base URL".to_string())?;
    let accepted = parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed.port().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == "/calendar/v3"
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    if !accepted {
        return Err(
            "E2E Calendar API base must be loopback HTTP at /calendar/v3 without credentials"
                .to_string(),
        );
    }
    Ok(parsed)
}

pub(crate) fn open_file_is_suppressed(raw: Option<&str>) -> bool {
    raw == Some("1")
}

fn resolve_run_marker_token(args: &[OsString]) -> Result<&str, String> {
    let mut selected: Option<&OsString> = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == RUN_MARKER_TOKEN_ARG {
            if selected.is_some() {
                return Err("--e2e-run-marker-token may be supplied only once".to_string());
            }
            selected = Some(
                args.get(index + 1)
                    .ok_or("--e2e-run-marker-token requires a value")?,
            );
            index += 1;
        }
        index += 1;
    }
    let token = selected
        .ok_or("--e2e-run-marker-token is required")?
        .to_str()
        .ok_or("The E2E run marker token must be UTF-8")?;
    let is_high_entropy_hex = token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !is_high_entropy_hex {
        return Err("The E2E run marker token must be 32 bytes of lowercase hex".to_string());
    }
    Ok(token)
}

fn validate_run_marker(args: &[OsString], run_root: &Path) -> Result<(), String> {
    let expected_token = resolve_run_marker_token(args)?;
    let marker_path = run_root.join(RUN_MARKER_FILE);
    let metadata = std::fs::symlink_metadata(&marker_path)
        .map_err(|_| "The E2E run marker must exist".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("The E2E run marker must be a regular non-symlink file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err("The E2E run marker must have mode 0600".to_string());
        }
    }
    let installed_token = std::fs::read_to_string(marker_path)
        .map_err(|_| "The E2E run marker must be readable".to_string())?;
    if installed_token != expected_token {
        return Err("The E2E run marker does not match this process".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum E2eFailpoint {
    FreshnessAfterRemote,
    CacheReconcileAfterRemote,
}

#[derive(Default)]
pub(crate) struct E2eFailpoints {
    freshness_after_remote: AtomicBool,
    cache_reconcile_after_remote: AtomicBool,
}

impl E2eFailpoints {
    fn flag(&self, point: E2eFailpoint) -> &AtomicBool {
        match point {
            E2eFailpoint::FreshnessAfterRemote => &self.freshness_after_remote,
            E2eFailpoint::CacheReconcileAfterRemote => &self.cache_reconcile_after_remote,
        }
    }

    pub(crate) fn arm(&self, point: E2eFailpoint) {
        self.flag(point).store(true, Ordering::SeqCst);
    }

    pub(crate) fn consume(&self, point: E2eFailpoint) -> bool {
        self.flag(point).swap(false, Ordering::SeqCst)
    }
}

pub(crate) struct E2eRuntime {
    data_root: PathBuf,
    config_path: PathBuf,
    suppress_open_file: bool,
    failpoints: E2eFailpoints,
}

impl E2eRuntime {
    pub(crate) fn resolve(
        args: &[OsString],
        run_root: Option<&Path>,
        calendar_api_base: Option<&str>,
        suppress_open_file: Option<&str>,
        config_path: Option<&Path>,
    ) -> Result<Self, String> {
        let run_root = run_root.ok_or("LOTUS_E2E_RUN_ROOT is required")?;
        let data_root = resolve_isolated_data_root(args, run_root)?;
        let canonical_run_root = run_root.to_path_buf();
        let config_path = config_path.ok_or("An isolated --config path is required")?;
        if !config_path.is_absolute() {
            return Err("The E2E config path must be absolute".to_string());
        }
        let config_metadata = std::fs::symlink_metadata(config_path)
            .map_err(|_| "The E2E config path must already exist".to_string())?;
        if !config_metadata.is_file() || config_metadata.file_type().is_symlink() {
            return Err("The E2E config path must be a real file".to_string());
        }
        let canonical_config = config_path
            .canonicalize()
            .map_err(|_| "The E2E config path must already exist".to_string())?;
        let expected_config = canonical_run_root.join("config.yaml");
        if config_path != expected_config || canonical_config != expected_config {
            return Err("The E2E config path must be the direct config.yaml child".to_string());
        }
        validate_run_marker(args, &canonical_run_root)?;
        validate_calendar_api_base(
            calendar_api_base.ok_or("LOTUS_E2E_CALENDAR_API_BASE is required")?,
        )?;
        Ok(Self {
            data_root,
            config_path: canonical_config,
            suppress_open_file: open_file_is_suppressed(suppress_open_file),
            failpoints: E2eFailpoints::default(),
        })
    }

    pub(crate) fn from_process(config_path: Option<&Path>) -> Result<Self, String> {
        let args: Vec<OsString> = std::env::args_os().collect();
        let run_root = std::env::var_os(RUN_ROOT_ENV)
            .ok_or("LOTUS_E2E_RUN_ROOT is required")
            .map(PathBuf::from)?;
        let calendar_api_base = std::env::var(CALENDAR_API_BASE_ENV)
            .map_err(|_| "LOTUS_E2E_CALENDAR_API_BASE is required")?;
        let suppress_open_file = std::env::var(SUPPRESS_OPEN_FILE_ENV).ok();
        Self::resolve(
            &args,
            Some(&run_root),
            Some(&calendar_api_base),
            suppress_open_file.as_deref(),
            config_path,
        )
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub(crate) fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub(crate) fn suppress_open_file(&self) -> bool {
        self.suppress_open_file
    }

    pub(crate) fn failpoints(&self) -> &E2eFailpoints {
        &self.failpoints
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct E2eAuthorizationSeed {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    authorization_version: i64,
    granted_scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct E2eEventSeed {
    event_id: String,
    recurring_event_id: Option<String>,
    original_start_time: Option<String>,
    etag: Option<String>,
    summary: String,
    description: String,
    start: String,
    end: String,
    updated: Option<String>,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct E2eSeedRequest {
    config_yaml: String,
    calendar_id: String,
    authorization: E2eAuthorizationSeed,
    events: Vec<E2eEventSeed>,
    sync_token: String,
    synced_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct E2eRuntimeStatus {
    pub data_root: PathBuf,
    pub config_path: PathBuf,
    pub auth_record_present: bool,
    pub cached_event_count: usize,
    pub sync_state_present: bool,
    pub write_capable: bool,
    pub pending_edit_journal_path: PathBuf,
    pub invoice_freshness_path: PathBuf,
}

fn validate_nonempty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("E2E seed {label} must not be empty"))
    } else {
        Ok(())
    }
}

pub(crate) fn runtime_status(
    runtime: &E2eRuntime,
    storage: &AppStorage,
    store: &CalendarStore,
    calendar_id: &str,
) -> Result<E2eRuntimeStatus, String> {
    let auth_raw = storage
        .read_auth_tokens()
        .map_err(|error| error.to_string())?;
    let auth: Option<serde_json::Value> = auth_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    let write_capable = auth
        .as_ref()
        .and_then(|record| record.get("granted_scopes"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|scopes| {
            scopes.iter().any(|scope| {
                scope.as_str() == Some("https://www.googleapis.com/auth/calendar.events")
            })
        });
    let paths = isolated_storage_paths(storage);
    Ok(E2eRuntimeStatus {
        data_root: runtime.data_root.clone(),
        config_path: runtime.config_path.clone(),
        auth_record_present: auth_raw.is_some(),
        cached_event_count: store
            .list_events(calendar_id)
            .map_err(|error| error.to_string())?
            .len(),
        sync_state_present: store
            .sync_state(calendar_id)
            .map_err(|error| error.to_string())?
            .is_some(),
        write_capable,
        pending_edit_journal_path: paths.pending_edit_journal,
        invoice_freshness_path: paths.invoice_freshness,
    })
}

pub(crate) fn seed_runtime(
    runtime: &E2eRuntime,
    storage: &AppStorage,
    store: &CalendarStore,
    seed: E2eSeedRequest,
) -> Result<E2eRuntimeStatus, String> {
    validate_nonempty(&seed.config_yaml, "config YAML")?;
    validate_nonempty(&seed.calendar_id, "calendar ID")?;
    validate_nonempty(&seed.authorization.access_token, "access token")?;
    validate_nonempty(&seed.authorization.refresh_token, "refresh token")?;
    validate_nonempty(&seed.sync_token, "sync token")?;
    validate_nonempty(&seed.synced_at, "sync timestamp")?;
    if seed.authorization.expires_at <= 0 || seed.authorization.authorization_version <= 0 {
        return Err("E2E seed authorization metadata must be positive".to_string());
    }
    let mut scopes = HashSet::new();
    for scope in &seed.authorization.granted_scopes {
        validate_nonempty(scope, "granted scope")?;
        if !scopes.insert(scope) {
            return Err("E2E seed granted scopes must be unique".to_string());
        }
    }
    let mut event_ids = HashSet::new();
    for event in &seed.events {
        validate_nonempty(&event.event_id, "event ID")?;
        validate_nonempty(&event.start, "event start")?;
        validate_nonempty(&event.end, "event end")?;
        validate_nonempty(&event.status, "event status")?;
        if !event_ids.insert(event.event_id.as_str()) {
            return Err("E2E seed event IDs must be unique".to_string());
        }
    }

    std::fs::write(runtime.config_path(), seed.config_yaml.as_bytes())
        .map_err(|error| error.to_string())?;
    let auth_raw = serde_json::to_string_pretty(&serde_json::json!({
        "access_token": seed.authorization.access_token,
        "refresh_token": seed.authorization.refresh_token,
        "expires_at": seed.authorization.expires_at,
        "authorization_version": seed.authorization.authorization_version,
        "granted_scopes": seed.authorization.granted_scopes,
    }))
    .map_err(|error| error.to_string())?;
    let expected = storage
        .read_auth_tokens()
        .map_err(|error| error.to_string())?;
    match storage
        .compare_and_write_auth_tokens(&auth_raw, expected.as_deref())
        .map_err(|error| error.to_string())?
    {
        StorageWriteOutcome::Durable | StorageWriteOutcome::CommittedButDurabilityUncertain => {}
        StorageWriteOutcome::Conflict => {
            return Err("E2E authorization seed conflicted with another writer".to_string())
        }
    }

    store
        .clear_calendar(&seed.calendar_id)
        .map_err(|error| error.to_string())?;
    let stage_id = store
        .begin_staged_full_sync(&seed.calendar_id)
        .map_err(|error| error.to_string())?;
    for event in seed.events {
        store
            .stage_event(
                stage_id,
                &StoredCalendarEvent {
                    calendar_id: seed.calendar_id.clone(),
                    event_id: event.event_id,
                    recurring_event_id: event.recurring_event_id,
                    original_start_time: event.original_start_time,
                    etag: event.etag,
                    summary: event.summary,
                    description: event.description,
                    start_ts: event.start,
                    end_ts: event.end,
                    updated_ts: event.updated,
                    status: event.status,
                },
            )
            .map_err(|error| error.to_string())?;
    }
    store
        .commit_staged_full_sync(
            stage_id,
            &seed.calendar_id,
            &seed.sync_token,
            &seed.synced_at,
        )
        .map_err(|error| error.to_string())?;
    runtime_status(runtime, storage, store, &seed.calendar_id)
}

fn open_store(storage: &AppStorage) -> Result<CalendarStore, String> {
    CalendarStore::open(storage.calendar_cache_path()).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn e2e_seed_runtime(
    runtime: tauri::State<'_, E2eRuntime>,
    storage: tauri::State<'_, AppStorage>,
    seed: E2eSeedRequest,
) -> Result<E2eRuntimeStatus, String> {
    let store = open_store(&storage)?;
    seed_runtime(&runtime, &storage, &store, seed)
}

#[tauri::command]
pub(crate) fn e2e_runtime_status(
    runtime: tauri::State<'_, E2eRuntime>,
    storage: tauri::State<'_, AppStorage>,
    calendar_id: String,
) -> Result<E2eRuntimeStatus, String> {
    let store = open_store(&storage)?;
    runtime_status(&runtime, &storage, &store, &calendar_id)
}

#[tauri::command]
pub(crate) fn e2e_arm_failpoint(runtime: tauri::State<'_, E2eRuntime>, failpoint: E2eFailpoint) {
    runtime.failpoints().arm(failpoint);
}

#[allow(dead_code)] // Reserved for the Task 10 edit phases that consume these webdriver seams.
pub(crate) fn consume_failpoint(runtime: &E2eRuntime, failpoint: E2eFailpoint) -> bool {
    runtime.failpoints().consume(failpoint)
}

#[cfg(test)]
mod tests {
    use super::{
        isolated_storage_paths, open_file_is_suppressed, resolve_isolated_data_root, seed_runtime,
        validate_calendar_api_base, E2eAuthorizationSeed, E2eEventSeed, E2eFailpoint,
        E2eFailpoints, E2eRuntime, E2eSeedRequest, WEBDRIVER_READY_MARKER,
    };
    use crate::app_storage::AppStorage;
    use crate::calendar_store::CalendarStore;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn args(data_dir: &Path) -> Vec<OsString> {
        vec![
            OsString::from("app"),
            OsString::from("--e2e-data-dir"),
            data_dir.as_os_str().to_owned(),
        ]
    }

    fn runtime_args(data_dir: &Path, marker_token: &str) -> Vec<OsString> {
        let mut args = args(data_dir);
        args.push(OsString::from("--e2e-run-marker-token"));
        args.push(OsString::from(marker_token));
        args
    }

    const VALID_MARKER_TOKEN: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn prefixed_temp_run_root() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("lotus-calendar-e2e-")
            .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
            .unwrap()
    }

    fn write_marker(run_root: &Path, token: &str) {
        let marker = run_root.join(".lotus-e2e-run");
        std::fs::write(&marker, token).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn accepts_only_a_canonical_child_of_the_explicit_run_root() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        std::fs::create_dir(&data_dir).unwrap();

        let resolved = resolve_isolated_data_root(&args(&data_dir), run_root.path()).unwrap();

        assert_eq!(resolved, data_dir.canonicalize().unwrap());
    }

    #[test]
    fn rejects_a_run_root_without_the_exact_e2e_prefix() {
        let run_root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let data_dir = run_root.path().join("app-data");
        std::fs::create_dir(&data_dir).unwrap();

        assert!(resolve_isolated_data_root(&args(&data_dir), run_root.path()).is_err());
    }

    #[test]
    fn rejects_the_temp_parent_home_and_nested_prefixed_roots() {
        let temp_root = std::env::temp_dir().canonicalize().unwrap();
        assert!(
            resolve_isolated_data_root(&args(&temp_root.join("app-data")), &temp_root).is_err()
        );

        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home).canonicalize().unwrap();
            assert!(resolve_isolated_data_root(&args(&home.join("app-data")), &home).is_err());
        }

        let outer = prefixed_temp_run_root();
        let nested = outer.path().join("lotus-calendar-e2e-nested");
        let data_dir = nested.join("app-data");
        std::fs::create_dir_all(&data_dir).unwrap();
        assert!(resolve_isolated_data_root(&args(&data_dir), &nested).is_err());
    }

    #[test]
    fn rejects_a_nested_data_directory() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("nested").join("app-data");
        std::fs::create_dir_all(&data_dir).unwrap();

        assert!(resolve_isolated_data_root(&args(&data_dir), run_root.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_run_root() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        std::fs::create_dir(&data_dir).unwrap();
        let link = run_root.path().with_extension("symlink");
        std::os::unix::fs::symlink(run_root.path(), &link).unwrap();

        let result = resolve_isolated_data_root(&args(&link.join("app-data")), &link);
        std::fs::remove_file(&link).unwrap();

        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_nested_config_file() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let config_path = run_root.path().join("nested").join("config.yaml");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::create_dir(run_root.path().join("nested")).unwrap();
        std::fs::write(&config_path, "studios: {}\n").unwrap();

        assert!(E2eRuntime::resolve(
            &args(&data_dir),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_config_file() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let real_config = run_root.path().join("real-config.yaml");
        let config_path = run_root.path().join("config.yaml");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::write(&real_config, "studios: {}\n").unwrap();
        std::os::unix::fs::symlink(&real_config, &config_path).unwrap();

        assert!(E2eRuntime::resolve(
            &args(&data_dir),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .is_err());
    }

    #[test]
    fn rejects_a_missing_or_forged_run_marker() {
        for installed_marker in [
            None,
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        ] {
            let run_root = prefixed_temp_run_root();
            let data_dir = run_root.path().join("app-data");
            let config_path = run_root.path().join("config.yaml");
            std::fs::create_dir(&data_dir).unwrap();
            std::fs::write(&config_path, "studios: {}\n").unwrap();
            if let Some(marker) = installed_marker {
                write_marker(run_root.path(), marker);
            }

            assert!(E2eRuntime::resolve(
                &runtime_args(&data_dir, VALID_MARKER_TOKEN),
                Some(run_root.path()),
                Some("http://127.0.0.1:43127/calendar/v3"),
                Some("1"),
                Some(&config_path),
            )
            .is_err());
        }
    }

    #[test]
    fn rejects_a_directory_in_place_of_the_run_marker() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let config_path = run_root.path().join("config.yaml");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::write(&config_path, "studios: {}\n").unwrap();
        std::fs::create_dir(run_root.path().join(".lotus-e2e-run")).unwrap();

        assert!(E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .is_err());
    }

    #[test]
    fn rejects_a_low_entropy_marker_token() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let config_path = run_root.path().join("config.yaml");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::write(&config_path, "studios: {}\n").unwrap();
        std::fs::write(run_root.path().join(".lotus-e2e-run"), "short").unwrap();

        assert!(E2eRuntime::resolve(
            &runtime_args(&data_dir, "short"),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_run_marker() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let config_path = run_root.path().join("config.yaml");
        let real_marker = run_root.path().join("real-marker");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::write(&config_path, "studios: {}\n").unwrap();
        std::fs::write(&real_marker, VALID_MARKER_TOKEN).unwrap();
        std::os::unix::fs::symlink(&real_marker, run_root.path().join(".lotus-e2e-run")).unwrap();

        assert!(E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .is_err());
    }

    #[test]
    fn rejects_relative_outside_equal_duplicate_and_symlink_escape_paths() {
        let run_root = prefixed_temp_run_root();
        let outside = tempfile::tempdir().unwrap();
        let child = run_root.path().join("app-data");
        std::fs::create_dir(&child).unwrap();

        assert!(resolve_isolated_data_root(
            &[
                OsString::from("app"),
                OsString::from("--e2e-data-dir"),
                OsString::from("data")
            ],
            run_root.path(),
        )
        .is_err());
        assert!(resolve_isolated_data_root(&args(outside.path()), run_root.path()).is_err());
        assert!(resolve_isolated_data_root(&args(run_root.path()), run_root.path()).is_err());
        let duplicate = vec![
            OsString::from("app"),
            OsString::from("--e2e-data-dir"),
            child.as_os_str().to_owned(),
            OsString::from("--e2e-data-dir"),
            child.as_os_str().to_owned(),
        ];
        assert!(resolve_isolated_data_root(&duplicate, run_root.path()).is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), run_root.path().join("escape")).unwrap();
            assert!(resolve_isolated_data_root(
                &args(&run_root.path().join("escape")),
                run_root.path(),
            )
            .is_err());
        }
    }

    #[test]
    fn every_current_and_reserved_storage_path_stays_below_the_isolated_root() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let paths = isolated_storage_paths(&storage);

        assert_eq!(
            paths.calendar_cache,
            root.path().join("calendar-cache.sqlite")
        );
        assert_eq!(paths.auth_record, root.path().join("gmail-tokens.json"));
        assert_eq!(
            paths.prompt_preference,
            root.path().join("calendar-edit-prompt-preference.json")
        );
        assert_eq!(
            paths.pending_edit_journal,
            root.path().join("calendar-edit-operations.sqlite")
        );
        assert_eq!(
            paths.invoice_freshness,
            root.path().join("invoice-freshness.sqlite")
        );
        for path in paths.all() {
            assert_eq!(path.parent(), Some(root.path()));
        }
    }

    #[test]
    fn accepts_only_a_token_free_loopback_http_calendar_v3_base() {
        let accepted = validate_calendar_api_base("http://127.0.0.1:43127/calendar/v3").unwrap();
        assert_eq!(accepted.as_str(), "http://127.0.0.1:43127/calendar/v3");

        for rejected in [
            "https://127.0.0.1:43127/calendar/v3",
            "http://localhost:43127/calendar/v3",
            "http://127.0.0.2:43127/calendar/v3",
            "http://user:secret@127.0.0.1:43127/calendar/v3",
            "http://127.0.0.1/calendar/v3",
            "http://127.0.0.1:43127/calendar/v3/",
            "http://127.0.0.1:43127/other",
            "http://127.0.0.1:43127/calendar/v3?access_token=secret",
            "http://127.0.0.1:43127/calendar/v3#secret",
        ] {
            assert!(
                validate_calendar_api_base(rejected).is_err(),
                "accepted {rejected}"
            );
        }
    }

    #[test]
    fn open_file_suppression_requires_the_exact_opt_in_value() {
        assert!(open_file_is_suppressed(Some("1")));
        assert!(!open_file_is_suppressed(None));
        assert!(!open_file_is_suppressed(Some("true")));
        assert!(!open_file_is_suppressed(Some("0")));
        assert!(!open_file_is_suppressed(Some(" 1")));
    }

    #[test]
    fn webdriver_logging_stays_in_process_and_avoids_debug_url_output() {
        assert_eq!(crate::application_log_targets().len(), 2);
        assert_eq!(crate::application_log_level(), log::LevelFilter::Info);
        assert_eq!(
            WEBDRIVER_READY_MARKER,
            "LOTUS_E2E_WEBDRIVER_READY http://127.0.0.1:4445"
        );
    }

    #[test]
    fn webdriver_does_not_install_the_persistent_http_cookie_store() {
        assert!(!crate::application_http_plugin_enabled());
    }

    #[test]
    fn webdriver_context_uses_only_ephemeral_webview_data_stores() {
        let mut windows = vec![
            tauri::utils::config::WindowConfig::default(),
            tauri::utils::config::WindowConfig::default(),
        ];
        assert!(windows.iter().all(|window| !window.incognito));

        crate::configure_webdriver_windows(&mut windows);

        assert!(windows.iter().all(|window| window.incognito));
    }

    #[test]
    fn failpoints_are_named_and_consumed_exactly_once() {
        let failpoints = E2eFailpoints::default();
        for point in [
            E2eFailpoint::FreshnessAfterRemote,
            E2eFailpoint::CacheReconcileAfterRemote,
        ] {
            assert!(!failpoints.consume(point));
            failpoints.arm(point);
            assert!(failpoints.consume(point));
            assert!(!failpoints.consume(point));
        }
    }

    #[test]
    fn runtime_requires_isolated_data_config_and_calendar_base_under_one_run_root() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let config_path = run_root.path().join("config.yaml");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::write(&config_path, "studios: {}\n").unwrap();
        write_marker(run_root.path(), VALID_MARKER_TOKEN);

        let runtime = E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .unwrap();

        assert_eq!(runtime.data_root(), data_dir.canonicalize().unwrap());
        assert_eq!(runtime.config_path(), config_path.canonicalize().unwrap());
        assert!(runtime.suppress_open_file());

        assert!(E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            None,
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .is_err());
        assert!(E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            Some(run_root.path()),
            None,
            Some("1"),
            Some(&config_path),
        )
        .is_err());
        assert!(E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&outside_path()),
        )
        .is_err());
    }

    fn outside_path() -> std::path::PathBuf {
        std::env::temp_dir().join("lotus-e2e-outside-config-does-not-exist.yaml")
    }

    #[test]
    fn seed_writes_only_the_isolated_config_auth_cache_and_sync_state() {
        let run_root = prefixed_temp_run_root();
        let data_dir = run_root.path().join("app-data");
        let config_path = run_root.path().join("config.yaml");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::write(&config_path, "old config\n").unwrap();
        write_marker(run_root.path(), VALID_MARKER_TOKEN);
        let runtime = E2eRuntime::resolve(
            &runtime_args(&data_dir, VALID_MARKER_TOKEN),
            Some(run_root.path()),
            Some("http://127.0.0.1:43127/calendar/v3"),
            Some("1"),
            Some(&config_path),
        )
        .unwrap();
        let storage = AppStorage::new(runtime.data_root().to_path_buf()).unwrap();
        let store = CalendarStore::open(storage.calendar_cache_path()).unwrap();
        let config_yaml = "calendarId: teaching@example.test\ncalendarName: Teaching Calendar\ncalendarAccessRole: owner\nstudios: {}\n";
        let seed = E2eSeedRequest {
            config_yaml: config_yaml.to_string(),
            calendar_id: "teaching@example.test".to_string(),
            authorization: E2eAuthorizationSeed {
                access_token: "e2e-access-token".to_string(),
                refresh_token: "e2e-refresh-token".to_string(),
                expires_at: 4_102_444_800_000,
                authorization_version: 1,
                granted_scopes: vec![
                    "https://www.googleapis.com/auth/gmail.compose".to_string(),
                    "https://www.googleapis.com/auth/calendar.readonly".to_string(),
                    "https://www.googleapis.com/auth/calendar.events".to_string(),
                ],
            },
            events: vec![E2eEventSeed {
                event_id: "lesson-1".to_string(),
                recurring_event_id: None,
                original_start_time: None,
                etag: Some("\"lesson-v1\"".to_string()),
                summary: "Test Studio / Yoga".to_string(),
                description: "8".to_string(),
                start: "2026-08-17T17:00:00+02:00".to_string(),
                end: "2026-08-17T18:00:00+02:00".to_string(),
                updated: Some("2026-08-01T10:00:00.000Z".to_string()),
                status: "confirmed".to_string(),
            }],
            sync_token: "sync-0".to_string(),
            synced_at: "2026-08-15T10:00:00.000Z".to_string(),
        };

        let status = seed_runtime(&runtime, &storage, &store, seed).unwrap();

        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), config_yaml);
        let auth_raw = storage.read_auth_tokens().unwrap().unwrap();
        let auth: serde_json::Value = serde_json::from_str(&auth_raw).unwrap();
        assert_eq!(auth["authorization_version"], 1);
        assert_eq!(auth["access_token"], "e2e-access-token");
        assert_eq!(store.list_events("teaching@example.test").unwrap().len(), 1);
        assert_eq!(
            store
                .sync_state("teaching@example.test")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("sync-0")
        );
        assert_eq!(status.data_root, data_dir.canonicalize().unwrap());
        assert!(status.auth_record_present);
        assert_eq!(status.cached_event_count, 1);
        assert!(status.write_capable);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("e2e-access-token"));
        assert!(!serialized.contains("e2e-refresh-token"));
    }
}
