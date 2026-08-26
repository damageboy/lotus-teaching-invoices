use serde::Serialize;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

const CACHE_DIRECTORY: &str = "invoice-pdfs";
const MAX_TEMP_CREATE_ATTEMPTS: usize = 32;
const MAX_CACHE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum OpenPdfResult {
    Opened,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TempPdfCommandError {
    message: String,
}

impl From<io::Error> for TempPdfCommandError {
    fn from(_: io::Error) -> Self {
        Self {
            message: "The PDF preview could not be prepared safely.".to_string(),
        }
    }
}

fn invalid_input(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(crate) fn validate_pdf_filename(filename: &str) -> io::Result<()> {
    if filename.is_empty()
        || filename == ".pdf"
        || filename.contains("..")
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains(':')
        || !filename.ends_with(".pdf")
    {
        return Err(invalid_input("PDF filename must be a safe .pdf basename"));
    }
    let mut components = Path::new(filename).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(invalid_input("PDF filename must be one path component"));
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_cache_directory_path(cache_root: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(cache_root)?;
    let root_metadata = std::fs::symlink_metadata(cache_root)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(invalid_input("App cache root must be a real directory"));
    }
    let canonical_root = cache_root.canonicalize()?;
    let cache_directory = cache_root.join(CACHE_DIRECTORY);
    match std::fs::create_dir(&cache_directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(&cache_directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid_input("PDF cache must be a real directory"));
    }
    let canonical_cache = cache_directory.canonicalize()?;
    if canonical_cache.parent() != Some(canonical_root.as_path())
        || canonical_cache != canonical_root.join(CACHE_DIRECTORY)
    {
        return Err(invalid_input("PDF cache escaped the app cache root"));
    }
    Ok(canonical_cache)
}

#[cfg(unix)]
struct CacheDirectory {
    _root_fd: std::os::fd::OwnedFd,
    fd: std::os::fd::OwnedFd,
    logical_path: PathBuf,
}

#[cfg(unix)]
fn rustix_error(error: rustix::io::Errno) -> io::Error {
    io::Error::from_raw_os_error(error.raw_os_error())
}

#[cfg(unix)]
fn require_directory(fd: &std::os::fd::OwnedFd, message: &str) -> io::Result<()> {
    let metadata = rustix::fs::fstat(fd).map_err(rustix_error)?;
    if rustix::fs::FileType::from_raw_mode(metadata.st_mode).is_dir() {
        Ok(())
    } else {
        Err(invalid_input(message))
    }
}

#[cfg(unix)]
fn open_cache_directory(
    cache_root: &Path,
    after_root_open: impl FnOnce(),
    after_cache_open: impl FnOnce(),
) -> io::Result<CacheDirectory> {
    use rustix::fs::{Mode, OFlags};

    std::fs::create_dir_all(cache_root)?;
    let root_metadata = std::fs::symlink_metadata(cache_root)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(invalid_input("App cache root must be a real directory"));
    }
    let canonical_root = cache_root.canonicalize()?;
    let root_fd = rustix::fs::open(
        &canonical_root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(rustix_error)?;
    require_directory(&root_fd, "App cache root must be a real directory")?;
    after_root_open();

    let created = match rustix::fs::mkdirat(&root_fd, CACHE_DIRECTORY, Mode::from_raw_mode(0o700)) {
        Ok(()) => true,
        Err(rustix::io::Errno::EXIST) => false,
        Err(error) => return Err(rustix_error(error)),
    };
    let cache_fd = rustix::fs::openat(
        &root_fd,
        CACHE_DIRECTORY,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(rustix_error)?;
    require_directory(&cache_fd, "PDF cache must be a real directory")?;
    if created {
        rustix::fs::fsync(&root_fd).map_err(rustix_error)?;
    }
    after_cache_open();

    Ok(CacheDirectory {
        _root_fd: root_fd,
        fd: cache_fd,
        logical_path: canonical_root.join(CACHE_DIRECTORY),
    })
}

#[cfg(not(unix))]
fn require_regular_or_missing(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(invalid_input(
            "Existing PDF cache entry is not a regular file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn write_pdf_in_directory(
    cache_directory: &CacheDirectory,
    filename: &str,
    bytes: &[u8],
) -> io::Result<()> {
    use rustix::fs::{AtFlags, Mode, OFlags};
    use std::ffi::{CStr, CString};

    fn require_regular_or_missing_at(
        directory_fd: &std::os::fd::OwnedFd,
        name: &CStr,
    ) -> io::Result<()> {
        match rustix::fs::statat(directory_fd, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(metadata) if rustix::fs::FileType::from_raw_mode(metadata.st_mode).is_file() => {
                Ok(())
            }
            Ok(_) => Err(invalid_input(
                "Existing PDF cache entry is not a regular file",
            )),
            Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(rustix_error(error)),
        }
    }

    let destination = CString::new(filename).map_err(|_| invalid_input("Invalid PDF filename"))?;

    require_regular_or_missing_at(&cache_directory.fd, &destination)?;

    for _ in 0..MAX_TEMP_CREATE_ATTEMPTS {
        let nonce = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let temp_name = CString::new(format!(
            ".lotus-pdf-write-{}-{nonce}.tmp",
            std::process::id()
        ))
        .unwrap();
        let temp_fd = match rustix::fs::openat(
            &cache_directory.fd,
            &temp_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::EXIST) => continue,
            Err(error) => return Err(rustix_error(error)),
        };

        let mut temp_file = std::fs::File::from(temp_fd);
        let result = (|| {
            temp_file.write_all(bytes)?;
            temp_file.sync_all()?;
            require_regular_or_missing_at(&cache_directory.fd, &destination)?;
            rustix::fs::renameat(
                &cache_directory.fd,
                &temp_name,
                &cache_directory.fd,
                &destination,
            )
            .map_err(rustix_error)?;
            rustix::fs::fsync(&cache_directory.fd).map_err(rustix_error)?;
            require_regular_or_missing_at(&cache_directory.fd, &destination)
        })();
        if result.is_err() {
            let _ = rustix::fs::unlinkat(&cache_directory.fd, &temp_name, AtFlags::empty());
        }
        return result;
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Could not allocate a unique PDF cache temp file",
    ))
}

#[cfg(not(unix))]
fn write_pdf_in_directory(cache_directory: &Path, filename: &str, bytes: &[u8]) -> io::Result<()> {
    let destination = cache_directory.join(filename);
    require_regular_or_missing(&destination)?;
    for _ in 0..MAX_TEMP_CREATE_ATTEMPTS {
        let nonce = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let temp_path = cache_directory.join(format!(
            ".lotus-pdf-write-{}-{nonce}.tmp",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut temp_file = match options.open(&temp_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let result = (|| {
            temp_file.write_all(bytes)?;
            temp_file.sync_all()?;
            require_regular_or_missing(&destination)?;
            if destination.exists() {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Atomic PDF replacement is unavailable on this platform",
                ));
            }
            std::fs::rename(&temp_path, &destination)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp_path);
        }
        return result;
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Could not allocate a unique PDF cache temp file",
    ))
}

pub(crate) fn write_pdf_atomically(
    cache_root: &Path,
    filename: &str,
    bytes: &[u8],
) -> io::Result<PathBuf> {
    write_pdf_atomically_with_hook(cache_root, filename, bytes, || {})
}

#[cfg(unix)]
fn write_pdf_atomically_with_hook(
    cache_root: &Path,
    filename: &str,
    bytes: &[u8],
    after_open: impl FnOnce(),
) -> io::Result<PathBuf> {
    validate_pdf_filename(filename)?;
    let cache_directory = open_cache_directory(cache_root, after_open, || {})?;
    write_pdf_in_directory(&cache_directory, filename, bytes)?;
    Ok(cache_directory.logical_path.join(filename))
}

#[cfg(not(unix))]
fn write_pdf_atomically_with_hook(
    cache_root: &Path,
    filename: &str,
    bytes: &[u8],
    after_open: impl FnOnce(),
) -> io::Result<PathBuf> {
    validate_pdf_filename(filename)?;
    let cache_directory = secure_cache_directory_path(cache_root)?;
    after_open();
    write_pdf_in_directory(&cache_directory, filename, bytes)?;
    Ok(cache_directory.join(filename))
}

pub(crate) fn cleanup_expired_temp_pdfs(cache_root: &Path, now: SystemTime) -> io::Result<()> {
    cleanup_expired_temp_pdfs_with_hook(cache_root, now, || {})
}

#[cfg(unix)]
fn cleanup_expired_temp_pdfs_with_hook(
    cache_root: &Path,
    now: SystemTime,
    after_open: impl FnOnce(),
) -> io::Result<()> {
    use rustix::fs::{AtFlags, Dir, FileType};
    use std::time::UNIX_EPOCH;

    let cache_directory = open_cache_directory(cache_root, || {}, after_open)?;
    let mut entries = Dir::read_from(&cache_directory.fd).map_err(rustix_error)?;
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(rustix_error)?;
        let name = entry.file_name();
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        let metadata =
            match rustix::fs::statat(&cache_directory.fd, name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(metadata) => metadata,
                Err(rustix::io::Errno::NOENT) => continue,
                Err(error) => return Err(rustix_error(error)),
            };
        if !FileType::from_raw_mode(metadata.st_mode).is_file() {
            continue;
        }
        let Some(modified_seconds) = u64::try_from(metadata.st_mtime).ok() else {
            continue;
        };
        let Some(modified_nanos) = u32::try_from(metadata.st_mtime_nsec).ok() else {
            continue;
        };
        let Some(modified) =
            UNIX_EPOCH.checked_add(Duration::new(modified_seconds, modified_nanos))
        else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age <= MAX_CACHE_AGE {
            continue;
        }
        match rustix::fs::unlinkat(&cache_directory.fd, name, AtFlags::empty()) {
            Ok(()) => {}
            Err(rustix::io::Errno::NOENT) => {}
            Err(error) => return Err(rustix_error(error)),
        }
    }
    rustix::fs::fsync(&cache_directory.fd).map_err(rustix_error)?;
    Ok(())
}

#[cfg(not(unix))]
fn cleanup_expired_temp_pdfs_with_hook(
    cache_root: &Path,
    now: SystemTime,
    after_open: impl FnOnce(),
) -> io::Result<()> {
    let cache_directory = secure_cache_directory_path(cache_root)?;
    after_open();
    for entry in std::fs::read_dir(&cache_directory)? {
        let entry = entry?;
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let Ok(age) = now.duration_since(metadata.modified()?) else {
            continue;
        };
        if age <= MAX_CACHE_AGE {
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

fn launch_external_viewer(
    path: &Path,
    launch_platform: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    #[cfg(feature = "webdriver")]
    {
        let _ = (path, launch_platform);
        return Ok(());
    }

    #[cfg(not(feature = "webdriver"))]
    launch_platform(path)
}

#[cfg(target_os = "macos")]
fn launch_macos_viewer_with(
    path: &Path,
    launch: impl FnOnce(&Path, &Path) -> io::Result<std::process::ExitStatus>,
) -> io::Result<()> {
    let status = launch(Path::new("/usr/bin/open"), path)?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("The PDF viewer exited unsuccessfully"))
    }
}

fn launch_platform_external_viewer(app: &AppHandle, path: &Path) -> io::Result<()> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_lotus_mobile::LotusMobileExt;
        return app
            .lotus_mobile()
            .open_pdf(path)
            .map_err(|_| io::Error::other("No PDF viewer is available"));
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return launch_macos_viewer_with(path, |program, argument| {
            std::process::Command::new(program).arg(argument).status()
        });
    }

    #[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
    {
        let _ = (app, path);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Opening PDF previews is unsupported on this platform",
        ))
    }
}

fn write_and_open_temp_pdf_with(
    cache_root: &Path,
    filename: &str,
    pdf_bytes: &[u8],
    launch_platform: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<OpenPdfResult, TempPdfCommandError> {
    let path = write_pdf_atomically(cache_root, filename, pdf_bytes)?;
    launch_external_viewer(&path, launch_platform).map_err(|_| TempPdfCommandError {
        message: "The PDF was prepared, but no PDF viewer could open it.".to_string(),
    })?;
    Ok(OpenPdfResult::Opened)
}

pub(crate) fn cleanup_on_startup(app: &AppHandle) -> io::Result<()> {
    let cache_root = app.path().app_cache_dir().map_err(io::Error::other)?;
    cleanup_expired_temp_pdfs(&cache_root, SystemTime::now())
}

#[tauri::command]
pub(crate) fn write_and_open_temp_pdf(
    app: AppHandle,
    filename: String,
    pdf_bytes: Vec<u8>,
) -> Result<OpenPdfResult, TempPdfCommandError> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|_| TempPdfCommandError {
            message: "The application cache is unavailable.".to_string(),
        })?;
    write_and_open_temp_pdf_with(&cache_root, &filename, &pdf_bytes, |path| {
        launch_platform_external_viewer(&app, path)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_expired_temp_pdfs, validate_pdf_filename, write_and_open_temp_pdf_with,
        write_pdf_atomically,
    };
    use std::cell::Cell;
    use std::fs::FileTimes;
    use std::time::{Duration, SystemTime};

    const PDF_BYTES: &[u8] = b"%PDF-1.7\0binary";

    #[test]
    fn accepts_only_a_single_pdf_basename() {
        assert!(validate_pdf_filename("studio-a-2026-08.pdf").is_ok());
        for rejected in [
            "",
            ".pdf",
            "../invoice.pdf",
            "invoice..pdf",
            "nested/invoice.pdf",
            r"nested\invoice.pdf",
            "/invoice.pdf",
            r"C:\invoice.pdf",
            "C:invoice.pdf",
            "invoice.PDF",
            "invoice.pdf.exe",
        ] {
            assert!(
                validate_pdf_filename(rejected).is_err(),
                "accepted {rejected:?}"
            );
        }
    }

    #[test]
    fn writes_only_to_the_exact_invoice_pdf_cache_and_replaces_regular_files() {
        let cache_root = tempfile::tempdir().unwrap();

        let first = write_pdf_atomically(cache_root.path(), "invoice.pdf", b"old").unwrap();
        let second = write_pdf_atomically(cache_root.path(), "invoice.pdf", PDF_BYTES).unwrap();

        assert_eq!(
            first,
            cache_root
                .path()
                .canonicalize()
                .unwrap()
                .join("invoice-pdfs/invoice.pdf")
        );
        assert_eq!(second, first);
        assert_eq!(std::fs::read(first).unwrap(), PDF_BYTES);
        assert_eq!(
            std::fs::read_dir(cache_root.path().join("invoice-pdfs"))
                .unwrap()
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_targets_and_a_symlinked_cache_directory() {
        let cache_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(cache_root.path().join("invoice-pdfs")).unwrap();
        std::fs::write(outside.path().join("outside.pdf"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.pdf"),
            cache_root.path().join("invoice-pdfs/invoice.pdf"),
        )
        .unwrap();

        assert!(write_pdf_atomically(cache_root.path(), "invoice.pdf", PDF_BYTES).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("outside.pdf")).unwrap(),
            b"outside"
        );

        let linked_root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), linked_root.path().join("invoice-pdfs"))
            .unwrap();
        assert!(write_pdf_atomically(linked_root.path(), "invoice.pdf", PDF_BYTES).is_err());
    }

    #[test]
    fn startup_cleanup_removes_only_regular_cache_files_older_than_twenty_four_hours() {
        let cache_root = tempfile::tempdir().unwrap();
        let cache_dir = cache_root.path().join("invoice-pdfs");
        let legacy_dir = cache_root.path().join("legacy-user-invoices");
        std::fs::create_dir(&cache_dir).unwrap();
        std::fs::create_dir(&legacy_dir).unwrap();
        let old = cache_dir.join("old.pdf");
        let fresh = cache_dir.join("fresh.pdf");
        let nested = cache_dir.join("nested");
        let legacy = legacy_dir.join("old.pdf");
        std::fs::write(&old, PDF_BYTES).unwrap();
        std::fs::write(&fresh, PDF_BYTES).unwrap();
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("old.pdf"), PDF_BYTES).unwrap();
        std::fs::write(&legacy, PDF_BYTES).unwrap();
        let now = SystemTime::now();
        let old_time = now - Duration::from_secs(25 * 60 * 60);
        for path in [&old, &legacy, &nested.join("old.pdf")] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(FileTimes::new().set_modified(old_time))
                .unwrap();
        }

        #[cfg(unix)]
        let link = {
            let link = cache_dir.join("old-link.pdf");
            std::os::unix::fs::symlink(&legacy, &link).unwrap();
            Some(link)
        };
        #[cfg(not(unix))]
        let link: Option<std::path::PathBuf> = None;

        cleanup_expired_temp_pdfs(cache_root.path(), now).unwrap();

        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(nested.join("old.pdf").exists());
        assert!(legacy.exists());
        if let Some(link) = link {
            assert!(link.symlink_metadata().is_ok());
        }
    }

    #[cfg(not(feature = "webdriver"))]
    #[test]
    fn launcher_failure_maps_to_a_visible_command_error() {
        let called = Cell::new(false);
        let cache_root = tempfile::tempdir().unwrap();

        let error =
            write_and_open_temp_pdf_with(cache_root.path(), "invoice.pdf", PDF_BYTES, |_| {
                called.set(true);
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no viewer",
                ))
            })
            .unwrap_err();

        assert!(called.get());
        assert_eq!(
            error.message,
            "The PDF was prepared, but no PDF viewer could open it."
        );
    }

    #[cfg(feature = "webdriver")]
    #[test]
    fn webdriver_command_helper_uses_the_production_suppression_branch() {
        let called = Cell::new(false);
        let cache_root = tempfile::tempdir().unwrap();

        write_and_open_temp_pdf_with(cache_root.path(), "invoice.pdf", PDF_BYTES, |_| {
            called.set(true);
            Err(std::io::Error::other(
                "external viewer must stay suppressed",
            ))
        })
        .unwrap();

        assert!(!called.get());
        assert_eq!(
            std::fs::read(cache_root.path().join("invoice-pdfs/invoice.pdf")).unwrap(),
            PDF_BYTES
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_launcher_uses_fixed_binary_waits_and_rejects_nonzero_exit() {
        use super::launch_macos_viewer_with;
        use std::os::unix::process::ExitStatusExt;
        use std::process::ExitStatus;

        let pdf = std::path::Path::new("/cache/invoice.pdf");
        launch_macos_viewer_with(pdf, |program, argument| {
            assert_eq!(program, std::path::Path::new("/usr/bin/open"));
            assert_eq!(argument, pdf);
            Ok(ExitStatus::from_raw(0))
        })
        .unwrap();

        let error = launch_macos_viewer_with(pdf, |program, argument| {
            assert_eq!(program, std::path::Path::new("/usr/bin/open"));
            assert_eq!(argument, pdf);
            Ok(ExitStatus::from_raw(7 << 8))
        })
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
    }

    #[cfg(unix)]
    #[test]
    fn held_cache_directory_fd_prevents_path_swap_write_escape() {
        use super::write_pdf_atomically_with_hook;

        let parent = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let cache_root = parent.path().join("app-cache");
        let held_root = parent.path().join("held-app-cache");
        let outside_cache = outside.path().join("invoice-pdfs");
        let outside_pdf = outside_cache.join("invoice.pdf");
        std::fs::create_dir(&cache_root).unwrap();
        std::fs::create_dir(&outside_cache).unwrap();
        std::fs::write(&outside_pdf, b"outside").unwrap();

        write_pdf_atomically_with_hook(&cache_root, "invoice.pdf", PDF_BYTES, || {
            assert!(!cache_root.join("invoice-pdfs").exists());
            std::fs::rename(&cache_root, &held_root).unwrap();
            std::os::unix::fs::symlink(outside.path(), &cache_root).unwrap();
        })
        .unwrap();

        assert_eq!(
            std::fs::read(held_root.join("invoice-pdfs/invoice.pdf")).unwrap(),
            PDF_BYTES
        );
        assert_eq!(std::fs::read(outside_pdf).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn held_cache_directory_fd_prevents_path_swap_cleanup_escape() {
        use super::cleanup_expired_temp_pdfs_with_hook;

        let cache_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let cache_path = cache_root.path().join("invoice-pdfs");
        let held_path = cache_root.path().join("held-cache");
        let held_old = cache_path.join("old.pdf");
        let outside_old = outside.path().join("old.pdf");
        std::fs::create_dir(&cache_path).unwrap();
        std::fs::write(&held_old, PDF_BYTES).unwrap();
        std::fs::write(&outside_old, b"outside").unwrap();
        let now = SystemTime::now();
        let old_time = now - Duration::from_secs(25 * 60 * 60);
        for path in [&held_old, &outside_old] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(FileTimes::new().set_modified(old_time))
                .unwrap();
        }

        cleanup_expired_temp_pdfs_with_hook(cache_root.path(), now, || {
            std::fs::rename(&cache_path, &held_path).unwrap();
            std::os::unix::fs::symlink(outside.path(), &cache_path).unwrap();
        })
        .unwrap();

        assert!(!held_path.join("old.pdf").exists());
        assert_eq!(std::fs::read(outside_old).unwrap(), b"outside");
    }
}
