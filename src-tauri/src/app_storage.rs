use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const AUTH_TOKENS_FILE: &str = "google-tokens.json";
const LEGACY_AUTH_TOKENS_FILE: &str = "gmail-tokens.json";
const DRIVE_CONFIG_POINTER_FILE: &str = "drive-config-pointer.json";
const PROMPT_PREFERENCE_FILE: &str = "calendar-edit-prompt-preference.json";
const CALENDAR_CACHE_FILE: &str = "calendar-cache.sqlite";
const AUTH_LOCK_FILE: &str = ".google-tokens.lock";
const LEGACY_AUTH_LOCK_FILE: &str = ".gmail-tokens.lock";
const DRIVE_CONFIG_POINTER_LOCK_FILE: &str = ".drive-config-pointer.lock";
const LEGACY_CONFIG_FILE: &str = "config.yaml";
const TEMP_FILE_MARKER: &str = "lotus-write-v1";
const MAX_TEMP_CREATE_ATTEMPTS: usize = 32;
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);
static AUTH_WRITE_MUTEX: Mutex<()> = Mutex::new(());
static DRIVE_CONFIG_POINTER_WRITE_MUTEX: Mutex<()> = Mutex::new(());
static CONFIG_DELETE_MUTEX: Mutex<()> = Mutex::new(());

fn migrate_auth_storage(root: &Path) -> io::Result<()> {
    let current = root.join(AUTH_TOKENS_FILE);
    let legacy = root.join(LEGACY_AUTH_TOKENS_FILE);
    if current.exists() && legacy.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Both google-tokens.json and gmail-tokens.json exist",
        ));
    }

    let current_lock = root.join(AUTH_LOCK_FILE);
    let legacy_lock = root.join(LEGACY_AUTH_LOCK_FILE);
    if legacy_lock.exists() {
        if current_lock.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Both Google token lock files exist",
            ));
        }
        std::fs::rename(&legacy_lock, &current_lock)?;
    }

    if legacy.exists() {
        let _lock = AuthFileLock::acquire(&current_lock)?;
        if current.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Both google-tokens.json and gmail-tokens.json exist",
            ));
        }
        std::fs::rename(&legacy, &current)?;
        sync_parent_directory(root)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StorageWriteOutcome {
    Durable,
    CommittedButDurabilityUncertain,
    Conflict,
}

struct AuthFileLock {
    file: std::fs::File,
}

impl AuthFileLock {
    fn acquire(path: &Path) -> io::Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            loop {
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
        Ok(Self { file })
    }
}

impl Drop for AuthFileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

struct StagedWrite {
    temp_path: PathBuf,
    destination: PathBuf,
    committed: bool,
}

impl Drop for StagedWrite {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

fn stage_atomic_write_with(
    destination: &Path,
    raw: &str,
    mut next_temp_path: impl FnMut() -> PathBuf,
) -> io::Result<StagedWrite> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Missing storage parent directory",
        )
    })?;

    for _ in 0..MAX_TEMP_CREATE_ATTEMPTS {
        let temp_path = next_temp_path();
        if temp_path.parent() != Some(parent) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Storage temp file must be beside its destination",
            ));
        }

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }

        let mut temp_file = match options.open(&temp_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let staged = StagedWrite {
            temp_path,
            destination: destination.to_path_buf(),
            committed: false,
        };

        let write_result = (|| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temp_file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            temp_file.write_all(raw.as_bytes())?;
            temp_file.sync_all()
        })();
        drop(temp_file);
        if let Err(error) = write_result {
            drop(staged);
            return Err(error);
        }
        return Ok(staged);
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Could not allocate a unique storage temp file",
    ))
}

fn stage_atomic_write(destination: &Path, raw: &str) -> io::Result<StagedWrite> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Missing storage parent directory",
        )
    })?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing storage filename"))?
        .to_string_lossy()
        .into_owned();

    stage_atomic_write_with(destination, raw, || {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let nonce = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        parent.join(format!(
            ".{file_name}.{TEMP_FILE_MARKER}.{timestamp}.{}.{nonce}.tmp",
            std::process::id()
        ))
    })
}

fn commit_staged_with(
    mut staged: StagedWrite,
    sync_parent: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<StorageWriteOutcome> {
    let parent = staged.destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Missing storage parent directory",
        )
    })?;
    std::fs::rename(&staged.temp_path, &staged.destination)?;
    staged.committed = true;
    Ok(match sync_parent(parent) {
        Ok(()) => StorageWriteOutcome::Durable,
        Err(_) => StorageWriteOutcome::CommittedButDurabilityUncertain,
    })
}

fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(parent)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
        Ok(())
    }
}

fn parse_canonical_u32(value: &str) -> Option<u32> {
    let parsed = value.parse::<u32>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn parse_canonical_u64(value: &str) -> Option<u64> {
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn parse_canonical_u128(value: &str) -> Option<u128> {
    let parsed = value.parse::<u128>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn owned_temp_writer_pid(file_name: &str) -> Option<u32> {
    for managed_file in [
        AUTH_TOKENS_FILE,
        LEGACY_AUTH_TOKENS_FILE,
        DRIVE_CONFIG_POINTER_FILE,
        PROMPT_PREFERENCE_FILE,
    ] {
        let prefix = format!(".{managed_file}.");
        let Some(body) = file_name
            .strip_prefix(&prefix)
            .and_then(|value| value.strip_suffix(".tmp"))
        else {
            continue;
        };
        let parts: Vec<&str> = body.split('.').collect();
        let pid = match parts.as_slice() {
            [TEMP_FILE_MARKER, timestamp, pid, nonce]
                if parse_canonical_u128(timestamp).is_some()
                    && parse_canonical_u64(nonce).is_some() =>
            {
                parse_canonical_u32(pid)
            }
            [pid, nonce] if parse_canonical_u64(nonce).is_some() => parse_canonical_u32(pid),
            _ => None,
        };
        return pid.filter(|pid| *pid > 0);
    }
    None
}

fn cleanup_owned_temp_files_with(
    root: &Path,
    is_process_active: impl Fn(u32) -> bool,
) -> io::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let Some(pid) = file_name.to_str().and_then(owned_temp_writer_pid) else {
            continue;
        };
        if is_process_active(pid) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_is_active(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return true;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_is_active(_pid: u32) -> bool {
    true
}

fn cleanup_owned_temp_files(root: &Path) -> io::Result<()> {
    cleanup_owned_temp_files_with(root, process_is_active)
}

pub struct AppStorage {
    root: PathBuf,
}

impl AppStorage {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        migrate_auth_storage(&root)?;
        cleanup_owned_temp_files(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn auth_tokens_path(&self) -> PathBuf {
        self.root.join(AUTH_TOKENS_FILE)
    }

    pub fn drive_config_pointer_path(&self) -> PathBuf {
        self.root.join(DRIVE_CONFIG_POINTER_FILE)
    }

    pub fn prompt_preference_path(&self) -> PathBuf {
        self.root.join(PROMPT_PREFERENCE_FILE)
    }

    fn auth_lock_path(&self) -> PathBuf {
        self.root.join(AUTH_LOCK_FILE)
    }

    fn drive_config_pointer_lock_path(&self) -> PathBuf {
        self.root.join(DRIVE_CONFIG_POINTER_LOCK_FILE)
    }

    pub fn calendar_cache_path(&self) -> PathBuf {
        self.root.join(CALENDAR_CACHE_FILE)
    }

    fn legacy_config_path(&self, explicit_path: Option<&str>) -> PathBuf {
        explicit_path.map_or_else(|| self.root.join(LEGACY_CONFIG_FILE), PathBuf::from)
    }

    fn read_optional(path: PathBuf) -> io::Result<Option<String>> {
        match std::fs::read_to_string(path) {
            Ok(raw) => Ok(Some(raw)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn write_atomic(&self, path: PathBuf, raw: &str) -> io::Result<StorageWriteOutcome> {
        let staged = stage_atomic_write(&path, raw)?;
        commit_staged_with(staged, sync_parent_directory)
    }

    pub fn read_auth_tokens(&self) -> io::Result<Option<String>> {
        Self::read_optional(self.auth_tokens_path())
    }

    pub fn compare_and_write_auth_tokens(
        &self,
        raw: &str,
        expected_raw: Option<&str>,
    ) -> io::Result<StorageWriteOutcome> {
        let _process_guard = AUTH_WRITE_MUTEX
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _file_lock = AuthFileLock::acquire(&self.auth_lock_path())?;
        let current = self.read_auth_tokens()?;
        if current.as_deref() != expected_raw {
            return Ok(StorageWriteOutcome::Conflict);
        }
        self.write_atomic(self.auth_tokens_path(), raw)
    }

    pub fn read_drive_config_pointer(&self) -> io::Result<Option<String>> {
        Self::read_optional(self.drive_config_pointer_path())
    }

    pub fn compare_and_write_drive_config_pointer(
        &self,
        raw: &str,
        expected_raw: Option<&str>,
    ) -> io::Result<StorageWriteOutcome> {
        let _process_guard = DRIVE_CONFIG_POINTER_WRITE_MUTEX
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _file_lock = AuthFileLock::acquire(&self.drive_config_pointer_lock_path())?;
        let current = self.read_drive_config_pointer()?;
        if current.as_deref() != expected_raw {
            return Ok(StorageWriteOutcome::Conflict);
        }
        self.write_atomic(self.drive_config_pointer_path(), raw)
    }

    pub fn read_prompt_preference(&self) -> io::Result<Option<String>> {
        Self::read_optional(self.prompt_preference_path())
    }

    pub fn write_prompt_preference(&self, raw: &str) -> io::Result<StorageWriteOutcome> {
        self.write_atomic(self.prompt_preference_path(), raw)
    }

    pub fn read_legacy_config(&self, explicit_path: Option<&str>) -> io::Result<Option<String>> {
        Self::read_optional(self.legacy_config_path(explicit_path))
    }

    pub fn remove_verified_legacy_config(
        &self,
        explicit_path: Option<&str>,
        expected_raw: &str,
    ) -> io::Result<StorageWriteOutcome> {
        let _guard = CONFIG_DELETE_MUTEX
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let path = self.legacy_config_path(explicit_path);
        if Self::read_optional(path.clone())?.as_deref() != Some(expected_raw) {
            return Ok(StorageWriteOutcome::Conflict);
        }
        std::fs::remove_file(&path)?;
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Missing configuration parent directory",
            )
        })?;
        Ok(match sync_parent_directory(parent) {
            Ok(()) => StorageWriteOutcome::Durable,
            Err(_) => StorageWriteOutcome::CommittedButDurabilityUncertain,
        })
    }
}

#[tauri::command]
pub fn read_auth_tokens(storage: State<'_, AppStorage>) -> Result<Option<String>, String> {
    storage
        .read_auth_tokens()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_auth_tokens(
    storage: State<'_, AppStorage>,
    raw: String,
    expected_raw: Option<String>,
) -> Result<StorageWriteOutcome, String> {
    storage
        .compare_and_write_auth_tokens(&raw, expected_raw.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_drive_config_pointer(storage: State<'_, AppStorage>) -> Result<Option<String>, String> {
    storage
        .read_drive_config_pointer()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_drive_config_pointer(
    storage: State<'_, AppStorage>,
    raw: String,
    expected_raw: Option<String>,
) -> Result<StorageWriteOutcome, String> {
    storage
        .compare_and_write_drive_config_pointer(&raw, expected_raw.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_legacy_config(
    storage: State<'_, AppStorage>,
    config_path: State<'_, crate::ConfigPath>,
) -> Result<Option<String>, String> {
    storage
        .read_legacy_config(config_path.0.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remove_verified_legacy_config(
    storage: State<'_, AppStorage>,
    config_path: State<'_, crate::ConfigPath>,
    expected_raw: String,
) -> Result<StorageWriteOutcome, String> {
    storage
        .remove_verified_legacy_config(config_path.0.as_deref(), &expected_raw)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_calendar_edit_prompt_preference(
    storage: State<'_, AppStorage>,
) -> Result<Option<String>, String> {
    storage
        .read_prompt_preference()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn write_calendar_edit_prompt_preference(
    storage: State<'_, AppStorage>,
    raw: String,
) -> Result<StorageWriteOutcome, String> {
    storage
        .write_prompt_preference(&raw)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_owned_temp_files_with, commit_staged_with, stage_atomic_write_with, AppStorage,
        StorageWriteOutcome, AUTH_LOCK_FILE, AUTH_TOKENS_FILE, DRIVE_CONFIG_POINTER_FILE,
        LEGACY_AUTH_LOCK_FILE, LEGACY_AUTH_TOKENS_FILE,
    };
    use std::cell::Cell;
    use std::io;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn owned_temp_name(file_name: &str, timestamp: u128, pid: u32, nonce: u64) -> String {
        format!(".{file_name}.lotus-write-v1.{timestamp}.{pid}.{nonce}.tmp")
    }

    #[test]
    fn missing_records_are_absent() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();

        assert_eq!(storage.read_auth_tokens().unwrap(), None);
        assert_eq!(storage.read_prompt_preference().unwrap(), None);
    }

    #[test]
    fn drive_config_pointer_round_trips_exact_bytes_with_private_permissions() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let raw = "{\n  \"version\": 1,\n  \"configFileId\": \"file-1\"\n}";

        assert_eq!(storage.read_drive_config_pointer().unwrap(), None);
        assert_eq!(
            storage
                .compare_and_write_drive_config_pointer(raw, None)
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert_eq!(
            storage.read_drive_config_pointer().unwrap().as_deref(),
            Some(raw)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(storage.drive_config_pointer_path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn drive_config_pointer_compare_and_swap_preserves_newer_bytes() {
        let root = tempfile::tempdir().unwrap();
        let first = AppStorage::new(root.path().to_path_buf()).unwrap();
        let second = AppStorage::new(root.path().to_path_buf()).unwrap();
        std::fs::write(first.drive_config_pointer_path(), "old").unwrap();

        assert_eq!(
            first
                .compare_and_write_drive_config_pointer("new", Some("old"))
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert_eq!(
            second
                .compare_and_write_drive_config_pointer("stale", Some("old"))
                .unwrap(),
            StorageWriteOutcome::Conflict
        );
        assert_eq!(
            first.read_drive_config_pointer().unwrap().as_deref(),
            Some("new")
        );
    }

    #[test]
    fn drive_config_pointer_storage_is_independent_from_auth_storage() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();

        storage.compare_and_write_auth_tokens("auth", None).unwrap();
        storage
            .compare_and_write_drive_config_pointer("pointer", None)
            .unwrap();

        assert_eq!(storage.read_auth_tokens().unwrap().as_deref(), Some("auth"));
        assert_eq!(
            storage.read_drive_config_pointer().unwrap().as_deref(),
            Some("pointer")
        );
    }

    #[test]
    fn startup_cleanup_removes_a_dead_owned_drive_pointer_temp() {
        let root = tempfile::tempdir().unwrap();
        let dead_pid = 41_111;
        let temp = root
            .path()
            .join(owned_temp_name(DRIVE_CONFIG_POINTER_FILE, 100, dead_pid, 1));
        std::fs::write(&temp, "temp").unwrap();

        cleanup_owned_temp_files_with(root.path(), |_| false).unwrap();

        assert!(!temp.exists());
    }

    #[test]
    fn startup_renames_the_legacy_auth_record_byte_for_byte() {
        let root = tempfile::tempdir().unwrap();
        let raw = b"{\n  \"refresh_token\": \"keep exact bytes\"\n}\n";
        std::fs::write(root.path().join(LEGACY_AUTH_TOKENS_FILE), raw).unwrap();

        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();

        assert_eq!(std::fs::read(storage.auth_tokens_path()).unwrap(), raw);
        assert!(!root.path().join(LEGACY_AUTH_TOKENS_FILE).exists());
    }

    #[test]
    fn startup_renames_the_legacy_auth_lock() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(LEGACY_AUTH_LOCK_FILE), b"").unwrap();

        AppStorage::new(root.path().to_path_buf()).unwrap();

        assert!(root.path().join(AUTH_LOCK_FILE).exists());
        assert!(!root.path().join(LEGACY_AUTH_LOCK_FILE).exists());
    }

    #[test]
    fn startup_rejects_both_auth_records() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(AUTH_TOKENS_FILE), "new").unwrap();
        std::fs::write(root.path().join(LEGACY_AUTH_TOKENS_FILE), "old").unwrap();

        let error = match AppStorage::new(root.path().to_path_buf()) {
            Ok(_) => panic!("dual token records must be rejected"),
            Err(error) => error,
        };

        assert!(error
            .to_string()
            .contains("Both google-tokens.json and gmail-tokens.json"));
        assert_eq!(
            std::fs::read_to_string(root.path().join(AUTH_TOKENS_FILE)).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(LEGACY_AUTH_TOKENS_FILE)).unwrap(),
            "old"
        );
    }

    #[test]
    fn verified_legacy_config_removal_requires_exact_unchanged_bytes() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let path = root.path().join("config.yaml");
        std::fs::write(&path, "teacher: old\n").unwrap();

        assert_eq!(
            storage
                .remove_verified_legacy_config(None, "teacher: different\n")
                .unwrap(),
            StorageWriteOutcome::Conflict
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "teacher: old\n");
        assert_eq!(
            storage
                .remove_verified_legacy_config(None, "teacher: old\n")
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert!(!path.exists());
    }

    #[test]
    fn legacy_config_uses_the_explicit_path_when_supplied() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().join("app-data")).unwrap();
        let explicit = root.path().join("profile.yaml");
        std::fs::write(&explicit, "studios: {}\n").unwrap();

        assert_eq!(
            storage
                .read_legacy_config(explicit.to_str())
                .unwrap()
                .as_deref(),
            Some("studios: {}\n")
        );
        assert_eq!(
            storage
                .remove_verified_legacy_config(explicit.to_str(), "studios: {}\n")
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert!(!explicit.exists());
    }

    #[test]
    fn auth_record_round_trips_byte_for_byte() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let raw = "{\n    \"access_token\": \"old\",\n    \"refresh_token\": \"keep\"\n}\n";

        storage.compare_and_write_auth_tokens(raw, None).unwrap();

        assert_eq!(storage.read_auth_tokens().unwrap().as_deref(), Some(raw));
    }

    #[test]
    fn storage_write_outcomes_serialize_as_typed_statuses() {
        assert_eq!(
            serde_json::to_value(StorageWriteOutcome::Durable).unwrap(),
            serde_json::json!({ "status": "durable" })
        );
        assert_eq!(
            serde_json::to_value(StorageWriteOutcome::CommittedButDurabilityUncertain).unwrap(),
            serde_json::json!({ "status": "committedButDurabilityUncertain" })
        );
        assert_eq!(
            serde_json::to_value(StorageWriteOutcome::Conflict).unwrap(),
            serde_json::json!({ "status": "conflict" })
        );
    }

    #[test]
    fn stale_auth_compare_and_swap_cannot_mutate_a_newer_record() {
        let root = tempfile::tempdir().unwrap();
        let first = AppStorage::new(root.path().to_path_buf()).unwrap();
        let second = AppStorage::new(root.path().to_path_buf()).unwrap();
        std::fs::write(first.auth_tokens_path(), "old record").unwrap();

        assert_eq!(
            first
                .compare_and_write_auth_tokens("upgraded record", Some("old record"))
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert_eq!(
            second
                .compare_and_write_auth_tokens("late stale refresh", Some("old record"))
                .unwrap(),
            StorageWriteOutcome::Conflict
        );
        assert_eq!(
            first.read_auth_tokens().unwrap().as_deref(),
            Some("upgraded record")
        );
    }

    #[test]
    fn auth_compare_and_swap_distinguishes_no_file_from_an_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();

        assert_eq!(
            storage
                .compare_and_write_auth_tokens("first record", None)
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert_eq!(
            storage
                .compare_and_write_auth_tokens("must not replace", None)
                .unwrap(),
            StorageWriteOutcome::Conflict
        );
        assert_eq!(
            storage.read_auth_tokens().unwrap().as_deref(),
            Some("first record")
        );
    }

    #[test]
    fn auth_compare_and_swap_compares_malformed_existing_bytes_exactly() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let malformed = "{not valid json";
        std::fs::write(storage.auth_tokens_path(), malformed).unwrap();

        assert_eq!(
            storage
                .compare_and_write_auth_tokens("valid replacement", Some(malformed))
                .unwrap(),
            StorageWriteOutcome::Durable
        );
        assert_eq!(
            storage.read_auth_tokens().unwrap().as_deref(),
            Some("valid replacement")
        );
    }

    #[test]
    fn concurrent_auth_compare_and_swap_allows_exactly_one_stale_snapshot() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(AUTH_TOKENS_FILE), "old record").unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = ["replacement a", "replacement b"]
            .into_iter()
            .map(|replacement| {
                let root_path = root.path().to_path_buf();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let storage = AppStorage::new(root_path).unwrap();
                    barrier.wait();
                    storage
                        .compare_and_write_auth_tokens(replacement, Some("old record"))
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();

        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == StorageWriteOutcome::Durable)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == StorageWriteOutcome::Conflict)
                .count(),
            1
        );
        let final_raw = std::fs::read_to_string(root.path().join(AUTH_TOKENS_FILE)).unwrap();
        assert!(["replacement a", "replacement b"].contains(&final_raw.as_str()));
    }

    #[test]
    fn auth_lock_is_released_after_a_read_error() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        std::fs::create_dir(storage.auth_tokens_path()).unwrap();

        assert!(storage
            .compare_and_write_auth_tokens("replacement", None)
            .is_err());
        std::fs::remove_dir(storage.auth_tokens_path()).unwrap();
        assert_eq!(
            storage
                .compare_and_write_auth_tokens("replacement", None)
                .unwrap(),
            StorageWriteOutcome::Durable
        );
    }

    #[test]
    fn interruption_after_sync_before_rename_preserves_the_destination() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("gmail-tokens.json");
        let temp_path = root.path().join(owned_temp_name(
            "gmail-tokens.json",
            100,
            std::process::id(),
            1,
        ));
        std::fs::write(&destination, "old record").unwrap();

        let staged =
            stage_atomic_write_with(&destination, "new record", || temp_path.clone()).unwrap();

        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "old record");
        assert_eq!(std::fs::read_to_string(&temp_path).unwrap(), "new record");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&temp_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(staged);
        assert!(!temp_path.exists());
    }

    #[test]
    fn temp_name_collision_never_deletes_another_writers_file() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("gmail-tokens.json");
        let pid = 41_111;
        let collision = root
            .path()
            .join(owned_temp_name("gmail-tokens.json", 100, pid, 0));
        let retry = root
            .path()
            .join(owned_temp_name("gmail-tokens.json", 101, pid, 0));
        std::fs::write(&collision, "another writer").unwrap();
        let candidates = [collision.clone(), retry.clone()];
        let mut index = 0;

        let staged = stage_atomic_write_with(&destination, "ours", || {
            let candidate = candidates[index].clone();
            index += 1;
            candidate
        })
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&collision).unwrap(),
            "another writer"
        );
        assert_eq!(std::fs::read_to_string(&retry).unwrap(), "ours");
        drop(staged);
        assert_eq!(
            std::fs::read_to_string(&collision).unwrap(),
            "another writer"
        );
    }

    #[test]
    fn startup_cleanup_removes_only_dead_owned_auth_and_prompt_temps() {
        let root = tempfile::tempdir().unwrap();
        let dead_pid = 41_111;
        let active_pid = 42_222;
        let dead_auth = root
            .path()
            .join(owned_temp_name("gmail-tokens.json", 100, dead_pid, 1));
        let dead_prompt = root.path().join(owned_temp_name(
            "calendar-edit-prompt-preference.json",
            100,
            dead_pid,
            2,
        ));
        let legacy_dead_auth = root
            .path()
            .join(format!(".gmail-tokens.json.{dead_pid}.3.tmp"));
        let active_auth =
            root.path()
                .join(owned_temp_name("gmail-tokens.json", 100, active_pid, 4));
        let unrelated = root.path().join(".calendar-cache.sqlite.100.41111.5.tmp");
        let malformed = root
            .path()
            .join(".gmail-tokens.json.lotus-write-v1.bad.41111.6.tmp");
        let noncanonical = root
            .path()
            .join(".gmail-tokens.json.lotus-write-v1.0100.41111.7.tmp");
        let owned_looking_directory =
            root.path()
                .join(owned_temp_name("gmail-tokens.json", 100, dead_pid, 8));
        for path in [
            &dead_auth,
            &dead_prompt,
            &legacy_dead_auth,
            &active_auth,
            &unrelated,
            &malformed,
            &noncanonical,
        ] {
            std::fs::write(path, "temp").unwrap();
        }
        std::fs::create_dir(&owned_looking_directory).unwrap();

        cleanup_owned_temp_files_with(root.path(), |pid| pid == active_pid).unwrap();

        assert!(!dead_auth.exists());
        assert!(!dead_prompt.exists());
        assert!(!legacy_dead_auth.exists());
        assert!(active_auth.exists());
        assert!(unrelated.exists());
        assert!(malformed.exists());
        assert!(noncanonical.exists());
        assert!(owned_looking_directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_preserves_an_owned_looking_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let link = root
            .path()
            .join(owned_temp_name("gmail-tokens.json", 100, 41_111, 1));
        std::fs::write(&target, "keep").unwrap();
        symlink(&target, &link).unwrap();

        cleanup_owned_temp_files_with(root.path(), |_| false).unwrap();

        assert!(link.symlink_metadata().is_ok());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn app_storage_startup_preserves_a_temp_with_an_unprobeable_pid() {
        let root = tempfile::tempdir().unwrap();
        let stale = root
            .path()
            .join(owned_temp_name("gmail-tokens.json", 100, u32::MAX, 1));
        std::fs::write(&stale, "stale").unwrap();

        AppStorage::new(root.path().to_path_buf()).unwrap();

        assert!(stale.exists());
    }

    #[cfg(unix)]
    #[test]
    fn app_storage_startup_preserves_a_live_process_temp() {
        let root = tempfile::tempdir().unwrap();
        let active = root.path().join(owned_temp_name(
            "gmail-tokens.json",
            100,
            std::process::id(),
            1,
        ));
        std::fs::write(&active, "active").unwrap();

        AppStorage::new(root.path().to_path_buf()).unwrap();

        assert!(active.exists());
    }

    #[test]
    fn commit_renames_before_syncing_the_parent_directory() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("gmail-tokens.json");
        let temp_path = root.path().join(owned_temp_name(
            "gmail-tokens.json",
            100,
            std::process::id(),
            1,
        ));
        std::fs::write(&destination, "old record").unwrap();
        let staged =
            stage_atomic_write_with(&destination, "new record", || temp_path.clone()).unwrap();
        let sync_calls = Cell::new(0);

        let outcome = commit_staged_with(staged, |parent| {
            assert_eq!(parent, root.path());
            assert_eq!(std::fs::read_to_string(&destination).unwrap(), "new record");
            sync_calls.set(sync_calls.get() + 1);
            Ok(())
        })
        .unwrap();

        assert_eq!(outcome, StorageWriteOutcome::Durable);
        assert_eq!(sync_calls.get(), 1);
    }

    #[test]
    fn parent_sync_failure_reports_that_new_bytes_were_committed() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("gmail-tokens.json");
        let temp_path = root.path().join(owned_temp_name(
            "gmail-tokens.json",
            100,
            std::process::id(),
            1,
        ));
        std::fs::write(&destination, "old record").unwrap();
        let staged =
            stage_atomic_write_with(&destination, "new record", || temp_path.clone()).unwrap();

        let outcome = commit_staged_with(staged, |_| {
            Err(io::Error::other("injected parent sync failure"))
        })
        .unwrap();

        assert_eq!(
            outcome,
            StorageWriteOutcome::CommittedButDurabilityUncertain
        );
        assert_eq!(std::fs::read_to_string(destination).unwrap(), "new record");
        assert!(!temp_path.exists());
    }

    #[test]
    fn pre_rename_failure_returns_an_error_and_preserves_old_bytes() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("gmail-tokens.json");
        let temp_path = root.path().join(owned_temp_name(
            "gmail-tokens.json",
            100,
            std::process::id(),
            1,
        ));
        std::fs::write(&destination, "old record").unwrap();
        let staged =
            stage_atomic_write_with(&destination, "new record", || temp_path.clone()).unwrap();
        std::fs::remove_file(&temp_path).unwrap();

        assert!(commit_staged_with(staged, |_| Ok(())).is_err());
        assert_eq!(std::fs::read_to_string(destination).unwrap(), "old record");
    }

    #[cfg(unix)]
    #[test]
    fn failed_auth_write_preserves_the_previous_record_byte_for_byte() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let original = "{\n  \"access_token\": \"keep\"\n}\n";
        storage
            .compare_and_write_auth_tokens(original, None)
            .unwrap();

        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let write_result = storage.compare_and_write_auth_tokens("replacement", Some(original));
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(write_result.is_err());
        assert_eq!(
            storage.read_auth_tokens().unwrap().as_deref(),
            Some(original)
        );
    }

    #[test]
    fn prompt_preference_is_separate_from_credentials() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().to_path_buf()).unwrap();
        let auth = "{\"access_token\":\"keep-byte-for-byte\"}";
        storage.compare_and_write_auth_tokens(auth, None).unwrap();

        storage
            .write_prompt_preference("{\"dismissed_authorization_version\":1}")
            .unwrap();

        assert_eq!(storage.read_auth_tokens().unwrap().as_deref(), Some(auth));
        assert_eq!(
            storage.read_prompt_preference().unwrap().as_deref(),
            Some("{\"dismissed_authorization_version\":1}")
        );
    }

    #[test]
    fn every_managed_path_is_below_the_selected_root() {
        let root = tempfile::tempdir().unwrap();
        let storage = AppStorage::new(root.path().join("managed")).unwrap();

        assert!(storage.auth_tokens_path().starts_with(storage.root()));
        assert!(storage.prompt_preference_path().starts_with(storage.root()));
        assert!(storage.calendar_cache_path().starts_with(storage.root()));
    }
}
