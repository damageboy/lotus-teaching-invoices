use serde::{Deserialize, Serialize};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const OUTPUT_UNREADABLE: &str = "The invoice output folder could not be read.";
const FINAL_UNREADABLE: &str = "The finalized invoice folder could not be read.";
const ENTRY_UNREADABLE: &str = "A finalized invoice folder entry could not be read.";
const FILE_UNREADABLE: &str = "The finalized invoice file metadata could not be read.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub size_bytes: String,
    pub modified_unix_nanos: String,
    pub device_id: Option<String>,
    pub file_id: Option<String>,
    pub changed_unix_nanos: Option<String>,
    pub final_directory_device_id: Option<String>,
    pub final_directory_file_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FinalizedInvoiceLookup {
    NotFound,
    OneMatch {
        canonical_output_dir: String,
        final_filename: String,
        invoice_number: String,
        pdf_path: String,
        file_revision: FileRevision,
    },
    Ambiguous {
        filenames: Vec<String>,
    },
    Unreadable {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VerifiedFinalizedInvoiceError {
    NotFound,
    Ambiguous { filenames: Vec<String> },
    Unreadable,
    Conflict,
}

struct DirectoryEntrySnapshot {
    filename: String,
    path: PathBuf,
    is_file: bool,
}

fn unreadable(message: &str) -> FinalizedInvoiceLookup {
    FinalizedInvoiceLookup::Unreadable {
        message: message.to_string(),
    }
}

pub(crate) fn studio_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in name.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            if pending_separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character);
            pending_separator = false;
        } else {
            pending_separator = true;
        }
    }
    slug
}

pub(crate) fn invoice_number_for_filename(
    filename: &str,
    slug: &str,
    period_year: &str,
    period_month: &str,
) -> Option<String> {
    let suffix = format!("-{slug}-{period_year}-{period_month}.pdf");
    let prefix = filename.strip_suffix(&suffix)?;
    let (number, year) = prefix.split_once('-')?;
    if number.is_empty()
        || !number.bytes().all(|byte| byte.is_ascii_digit())
        || year.len() != 4
        || !year.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(format!("{number}/{year}"))
}

fn file_revision_from_metadata(metadata: &std::fs::Metadata) -> io::Result<FileRevision> {
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "finalized invoice is not a regular file",
        ));
    }
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid modification time"))?;
    let modified_unix_nanos = modified.as_nanos().to_string();

    #[cfg(unix)]
    let (device_id, file_id, changed_unix_nanos) = {
        use std::os::unix::fs::MetadataExt;
        (
            Some(metadata.dev().to_string()),
            Some(metadata.ino().to_string()),
            Some(
                (metadata.ctime() as i128 * 1_000_000_000_i128 + metadata.ctime_nsec() as i128)
                    .to_string(),
            ),
        )
    };
    #[cfg(not(unix))]
    let (device_id, file_id, changed_unix_nanos) = (None, None, None);

    Ok(FileRevision {
        size_bytes: metadata.len().to_string(),
        modified_unix_nanos,
        device_id,
        file_id,
        changed_unix_nanos,
        final_directory_device_id: None,
        final_directory_file_id: None,
    })
}

fn file_revision(path: &Path) -> io::Result<FileRevision> {
    let revision = file_revision_from_metadata(&std::fs::symlink_metadata(path)?)?;
    let final_directory = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing parent directory"))?;
    attach_final_directory_identity(revision, &std::fs::symlink_metadata(final_directory)?)
}

fn attach_final_directory_identity(
    mut revision: FileRevision,
    directory_metadata: &std::fs::Metadata,
) -> io::Result<FileRevision> {
    if !directory_metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "finalized invoice parent is not a directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        revision.final_directory_device_id = Some(directory_metadata.dev().to_string());
        revision.final_directory_file_id = Some(directory_metadata.ino().to_string());
    }
    Ok(revision)
}

#[cfg(unix)]
fn filename_c_string(filename: &str) -> io::Result<std::ffi::CString> {
    use std::path::Component;

    let mut components = Path::new(filename).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "finalized invoice filename is not a single path component",
        ));
    }
    std::ffi::CString::new(filename)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid filename"))
}

#[cfg(unix)]
fn open_verified_finalized_invoice(
    canonical_output_dir: &str,
    final_filename: &str,
    expected_revision: &FileRevision,
) -> Result<(std::os::fd::OwnedFd, std::fs::File), VerifiedFinalizedInvoiceError> {
    open_verified_finalized_invoice_with_access(
        canonical_output_dir,
        final_filename,
        expected_revision,
        libc::O_RDONLY,
    )
}

#[cfg(unix)]
fn open_verified_finalized_invoice_with_access(
    canonical_output_dir: &str,
    final_filename: &str,
    expected_revision: &FileRevision,
    access_mode: libc::c_int,
) -> Result<(std::os::fd::OwnedFd, std::fs::File), VerifiedFinalizedInvoiceError> {
    use std::ffi::CString;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let output = CString::new(Path::new(canonical_output_dir).as_os_str().as_bytes())
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    let final_component = CString::new("Final").unwrap();
    let filename =
        filename_c_string(final_filename).map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;

    let output_fd = unsafe {
        libc::open(
            output.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if output_fd < 0 {
        return Err(VerifiedFinalizedInvoiceError::Unreadable);
    }
    let output_fd = unsafe { OwnedFd::from_raw_fd(output_fd) };
    let final_fd = unsafe {
        libc::openat(
            std::os::fd::AsRawFd::as_raw_fd(&output_fd),
            final_component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if final_fd < 0 {
        return Err(VerifiedFinalizedInvoiceError::Unreadable);
    }
    let final_fd = unsafe { OwnedFd::from_raw_fd(final_fd) };
    let file_fd = unsafe {
        libc::openat(
            std::os::fd::AsRawFd::as_raw_fd(&final_fd),
            filename.as_ptr(),
            access_mode | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if file_fd < 0 {
        return Err(VerifiedFinalizedInvoiceError::Unreadable);
    }
    let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(file_fd) });
    let actual_revision = revision_for_open_file(&final_fd, &file)?;
    if &actual_revision != expected_revision {
        return Err(VerifiedFinalizedInvoiceError::Conflict);
    }
    Ok((final_fd, file))
}

#[cfg(unix)]
fn same_open_identity(left: &FileRevision, right: &FileRevision) -> bool {
    left.device_id == right.device_id
        && left.file_id == right.file_id
        && left.final_directory_device_id == right.final_directory_device_id
        && left.final_directory_file_id == right.final_directory_file_id
}

#[cfg(unix)]
fn revision_for_open_file(
    final_fd: &std::os::fd::OwnedFd,
    file: &std::fs::File,
) -> Result<FileRevision, VerifiedFinalizedInvoiceError> {
    let file_revision = file
        .metadata()
        .and_then(|metadata| file_revision_from_metadata(&metadata))
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    let final_directory = std::fs::File::from(
        final_fd
            .try_clone()
            .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?,
    );
    let final_directory_metadata = final_directory
        .metadata()
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    attach_final_directory_identity(file_revision, &final_directory_metadata)
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)
}

#[cfg(unix)]
fn read_verified_file(
    canonical_output_dir: &str,
    final_filename: &str,
    expected_revision: &FileRevision,
) -> Result<Vec<u8>, VerifiedFinalizedInvoiceError> {
    let (final_fd, mut file) =
        open_verified_finalized_invoice(canonical_output_dir, final_filename, expected_revision)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    let revision_after_read = revision_for_open_file(&final_fd, &file)?;
    if &revision_after_read != expected_revision {
        return Err(VerifiedFinalizedInvoiceError::Conflict);
    }
    Ok(bytes)
}

#[cfg(unix)]
pub(crate) fn consume_verified_finalized_invoice(
    canonical_output_dir: &str,
    studio_name: &str,
    period_year: &str,
    period_month: &str,
    final_filename: &str,
    invoice_number: &str,
    expected_revision: &FileRevision,
) -> Result<Vec<u8>, VerifiedFinalizedInvoiceError> {
    revalidate_exact_match(
        canonical_output_dir,
        studio_name,
        period_year,
        period_month,
        final_filename,
        invoice_number,
        expected_revision,
    )?;
    let bytes = read_verified_file(canonical_output_dir, final_filename, expected_revision)?;
    revalidate_exact_match(
        canonical_output_dir,
        studio_name,
        period_year,
        period_month,
        final_filename,
        invoice_number,
        expected_revision,
    )?;
    Ok(bytes)
}

#[cfg(unix)]
pub(crate) fn write_verified_finalized_invoice(
    canonical_output_dir: &str,
    studio_name: &str,
    period_year: &str,
    period_month: &str,
    final_filename: &str,
    invoice_number: &str,
    expected_revision: &FileRevision,
    pdf_bytes: &[u8],
) -> Result<FileRevision, VerifiedFinalizedInvoiceError> {
    write_verified_finalized_invoice_with_hook(
        canonical_output_dir,
        studio_name,
        period_year,
        period_month,
        final_filename,
        invoice_number,
        expected_revision,
        pdf_bytes,
        || {},
    )
}

#[cfg(unix)]
fn write_verified_finalized_invoice_with_hook<F>(
    canonical_output_dir: &str,
    studio_name: &str,
    period_year: &str,
    period_month: &str,
    final_filename: &str,
    invoice_number: &str,
    expected_revision: &FileRevision,
    pdf_bytes: &[u8],
    after_open: F,
) -> Result<FileRevision, VerifiedFinalizedInvoiceError>
where
    F: FnOnce(),
{
    revalidate_exact_match(
        canonical_output_dir,
        studio_name,
        period_year,
        period_month,
        final_filename,
        invoice_number,
        expected_revision,
    )?;
    let (final_fd, mut file) = open_verified_finalized_invoice_with_access(
        canonical_output_dir,
        final_filename,
        expected_revision,
        libc::O_WRONLY,
    )?;
    after_open();
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    file.set_len(0)
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    file.write_all(pdf_bytes)
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    file.sync_all()
        .map_err(|_| VerifiedFinalizedInvoiceError::Unreadable)?;
    let written_revision = revision_for_open_file(&final_fd, &file)?;
    if !same_open_identity(expected_revision, &written_revision) {
        return Err(VerifiedFinalizedInvoiceError::Conflict);
    }
    revalidate_exact_match(
        canonical_output_dir,
        studio_name,
        period_year,
        period_month,
        final_filename,
        invoice_number,
        &written_revision,
    )?;
    Ok(written_revision)
}

fn revalidate_exact_match(
    canonical_output_dir: &str,
    studio_name: &str,
    period_year: &str,
    period_month: &str,
    final_filename: &str,
    invoice_number: &str,
    expected_revision: &FileRevision,
) -> Result<(), VerifiedFinalizedInvoiceError> {
    match lookup_finalized_invoice(canonical_output_dir, studio_name, period_year, period_month) {
        FinalizedInvoiceLookup::NotFound => Err(VerifiedFinalizedInvoiceError::NotFound),
        FinalizedInvoiceLookup::Ambiguous { filenames } => {
            Err(VerifiedFinalizedInvoiceError::Ambiguous { filenames })
        }
        FinalizedInvoiceLookup::Unreadable { .. } => Err(VerifiedFinalizedInvoiceError::Unreadable),
        FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir: actual_output_dir,
            final_filename: actual_filename,
            invoice_number: actual_invoice_number,
            pdf_path,
            file_revision: actual_revision,
        } => {
            let expected_path = Path::new(canonical_output_dir)
                .join("Final")
                .join(final_filename);
            if actual_output_dir == canonical_output_dir
                && actual_filename == final_filename
                && actual_invoice_number == invoice_number
                && Path::new(&pdf_path) == expected_path
                && &actual_revision == expected_revision
            {
                Ok(())
            } else {
                Err(VerifiedFinalizedInvoiceError::Conflict)
            }
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn consume_verified_finalized_invoice(
    _canonical_output_dir: &str,
    _studio_name: &str,
    _period_year: &str,
    _period_month: &str,
    _final_filename: &str,
    _invoice_number: &str,
    _expected_revision: &FileRevision,
) -> Result<Vec<u8>, VerifiedFinalizedInvoiceError> {
    Err(VerifiedFinalizedInvoiceError::Unreadable)
}

#[cfg(not(unix))]
pub(crate) fn write_verified_finalized_invoice(
    _canonical_output_dir: &str,
    _studio_name: &str,
    _period_year: &str,
    _period_month: &str,
    _final_filename: &str,
    _invoice_number: &str,
    _expected_revision: &FileRevision,
    _pdf_bytes: &[u8],
) -> Result<FileRevision, VerifiedFinalizedInvoiceError> {
    Err(VerifiedFinalizedInvoiceError::Unreadable)
}

fn read_directory(path: &Path) -> io::Result<Vec<io::Result<DirectoryEntrySnapshot>>> {
    let entries = std::fs::read_dir(path)?;
    Ok(entries
        .map(|entry| {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let filename = entry.file_name().into_string().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 directory entry")
            })?;
            Ok(DirectoryEntrySnapshot {
                filename,
                path: entry.path(),
                is_file: file_type.is_file(),
            })
        })
        .collect())
}

pub fn lookup_finalized_invoice(
    output_dir: &str,
    studio_name: &str,
    period_year: &str,
    period_month: &str,
) -> FinalizedInvoiceLookup {
    lookup_finalized_invoice_with_reader(
        output_dir,
        studio_name,
        period_year,
        period_month,
        read_directory,
    )
}

fn lookup_finalized_invoice_with_reader<F>(
    output_dir: &str,
    studio_name: &str,
    period_year: &str,
    period_month: &str,
    reader: F,
) -> FinalizedInvoiceLookup
where
    F: FnOnce(&Path) -> io::Result<Vec<io::Result<DirectoryEntrySnapshot>>>,
{
    if output_dir.is_empty() {
        return FinalizedInvoiceLookup::NotFound;
    }
    let output_path = Path::new(output_dir);
    let canonical_output = match std::fs::canonicalize(output_path) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return FinalizedInvoiceLookup::NotFound
        }
        Err(_) => return unreadable(OUTPUT_UNREADABLE),
    };
    if !canonical_output.is_dir() {
        return unreadable(OUTPUT_UNREADABLE);
    }
    let Some(canonical_output_string) = canonical_output.to_str().map(str::to_string) else {
        return unreadable(OUTPUT_UNREADABLE);
    };

    let final_path = canonical_output.join("Final");
    let final_metadata = match std::fs::symlink_metadata(&final_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return FinalizedInvoiceLookup::NotFound
        }
        Err(_) => return unreadable(FINAL_UNREADABLE),
    };
    if !final_metadata.file_type().is_dir() {
        return unreadable(FINAL_UNREADABLE);
    }
    let canonical_final = match std::fs::canonicalize(&final_path) {
        Ok(path)
            if path.parent() == Some(canonical_output.as_path())
                && path.file_name().is_some_and(|name| name == "Final") =>
        {
            path
        }
        _ => return unreadable(FINAL_UNREADABLE),
    };

    let entries = match reader(&canonical_final) {
        Ok(entries) => entries,
        Err(_) => return unreadable(FINAL_UNREADABLE),
    };
    let slug = studio_slug(studio_name);
    let mut matches = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return unreadable(ENTRY_UNREADABLE),
        };
        if !entry.is_file {
            continue;
        }
        if let Some(invoice_number) =
            invoice_number_for_filename(&entry.filename, &slug, period_year, period_month)
        {
            matches.push((entry.filename, entry.path, invoice_number));
        }
    }
    matches.sort_by(|left, right| left.0.cmp(&right.0));

    match matches.len() {
        0 => FinalizedInvoiceLookup::NotFound,
        1 => {
            let (final_filename, pdf_path, invoice_number) = matches.pop().unwrap();
            if pdf_path.parent() != Some(canonical_final.as_path()) {
                return unreadable(FILE_UNREADABLE);
            }
            let revision = match file_revision(&pdf_path) {
                Ok(revision) => revision,
                Err(_) => return unreadable(FILE_UNREADABLE),
            };
            let Some(pdf_path) = pdf_path.to_str().map(str::to_string) else {
                return unreadable(FILE_UNREADABLE);
            };
            FinalizedInvoiceLookup::OneMatch {
                canonical_output_dir: canonical_output_string,
                final_filename,
                invoice_number,
                pdf_path,
                file_revision: revision,
            }
        }
        _ => FinalizedInvoiceLookup::Ambiguous {
            filenames: matches
                .into_iter()
                .map(|(filename, _, _)| filename)
                .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        consume_verified_finalized_invoice, lookup_finalized_invoice,
        lookup_finalized_invoice_with_reader, studio_slug, write_verified_finalized_invoice,
        write_verified_finalized_invoice_with_hook, FinalizedInvoiceLookup,
        VerifiedFinalizedInvoiceError,
    };
    use std::io;

    fn write_pdf(output: &std::path::Path, filename: &str) {
        let final_dir = output.join("Final");
        std::fs::create_dir_all(&final_dir).unwrap();
        std::fs::write(final_dir.join(filename), b"pdf").unwrap();
    }

    #[test]
    fn missing_or_empty_output_and_missing_final_are_not_found() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        let output_without_final = root.path().join("output");
        std::fs::create_dir(&output_without_final).unwrap();

        for output in [
            "",
            missing.to_str().unwrap(),
            output_without_final.to_str().unwrap(),
        ] {
            assert_eq!(
                lookup_finalized_invoice(output, "Yoga", "2026", "01"),
                FinalizedInvoiceLookup::NotFound
            );
        }
    }

    #[test]
    fn exactly_one_regular_exact_match_returns_canonical_paths_number_and_revision() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("parent").join("..").join("output");
        std::fs::create_dir_all(&output).unwrap();
        write_pdf(&output, "8-2026-yoga-studio-2026-01.pdf");

        let result =
            lookup_finalized_invoice(output.to_str().unwrap(), "Yoga Studio", "2026", "01");
        let FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir,
            final_filename,
            invoice_number,
            pdf_path,
            file_revision,
        } = result
        else {
            panic!("expected one match, got {result:?}");
        };

        let canonical = output.canonicalize().unwrap();
        assert_eq!(canonical_output_dir, canonical.to_str().unwrap());
        assert_eq!(final_filename, "8-2026-yoga-studio-2026-01.pdf");
        assert_eq!(invoice_number, "8/2026");
        assert_eq!(
            pdf_path,
            canonical
                .join("Final/8-2026-yoga-studio-2026-01.pdf")
                .to_str()
                .unwrap()
        );
        assert_eq!(file_revision.size_bytes, "3");
        assert!(!file_revision.modified_unix_nanos.is_empty());
        #[cfg(unix)]
        {
            assert!(file_revision.device_id.is_some());
            assert!(file_revision.file_id.is_some());
            assert!(file_revision.changed_unix_nanos.is_some());
            assert!(file_revision.final_directory_device_id.is_some());
            assert!(file_revision.final_directory_file_id.is_some());
        }
    }

    #[test]
    fn multiple_matches_are_ambiguous_and_sorted_deterministically() {
        let root = tempfile::tempdir().unwrap();
        write_pdf(root.path(), "12-2026-yoga-2026-01.pdf");
        write_pdf(root.path(), "2-2025-yoga-2026-01.pdf");
        write_pdf(root.path(), "9-2026-yoga-2026-02.pdf");

        assert_eq!(
            lookup_finalized_invoice(root.path().to_str().unwrap(), "Yoga", "2026", "01"),
            FinalizedInvoiceLookup::Ambiguous {
                filenames: vec![
                    "12-2026-yoga-2026-01.pdf".to_string(),
                    "2-2025-yoga-2026-01.pdf".to_string(),
                ],
            }
        );
    }

    #[test]
    fn matching_directory_malformed_filename_and_slug_suffix_collision_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        let final_dir = root.path().join("Final");
        std::fs::create_dir_all(final_dir.join("8-2026-yoga-2026-01.pdf")).unwrap();
        for filename in [
            "8-26-yoga-2026-01.pdf",
            "8-2026-yoga-2026-1.pdf",
            "8-2026-yoga-2026-01.pdf.bak",
            "8-2026-bikram-yoga-2026-01.pdf",
        ] {
            std::fs::write(final_dir.join(filename), b"not a match").unwrap();
        }

        assert_eq!(
            lookup_finalized_invoice(root.path().to_str().unwrap(), "Yoga", "2026", "01"),
            FinalizedInvoiceLookup::NotFound
        );
    }

    #[test]
    fn unreadable_existing_enumeration_or_entry_is_never_not_found() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("Final")).unwrap();

        let enumeration = lookup_finalized_invoice_with_reader(
            root.path().to_str().unwrap(),
            "Yoga",
            "2026",
            "01",
            |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "secret path",
                ))
            },
        );
        assert!(matches!(
            enumeration,
            FinalizedInvoiceLookup::Unreadable { ref message }
                if message == "The finalized invoice folder could not be read."
                    && !message.contains("secret")
        ));

        let entry = lookup_finalized_invoice_with_reader(
            root.path().to_str().unwrap(),
            "Yoga",
            "2026",
            "01",
            |_| {
                Ok(vec![Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "secret entry",
                ))])
            },
        );
        assert!(matches!(
            entry,
            FinalizedInvoiceLookup::Unreadable { ref message }
                if message == "A finalized invoice folder entry could not be read."
                    && !message.contains("secret")
        ));
    }

    #[test]
    fn existing_non_directory_output_or_final_is_unreadable() {
        let root = tempfile::tempdir().unwrap();
        let output_file = root.path().join("output.pdf");
        std::fs::write(&output_file, b"pdf").unwrap();
        let output_with_final_file = root.path().join("output");
        std::fs::create_dir(&output_with_final_file).unwrap();
        std::fs::write(output_with_final_file.join("Final"), b"pdf").unwrap();

        for output in [output_file, output_with_final_file] {
            assert!(matches!(
                lookup_finalized_invoice(output.to_str().unwrap(), "Yoga", "2026", "01"),
                FinalizedInvoiceLookup::Unreadable { .. }
            ));
        }
    }

    #[test]
    fn studio_slug_matches_typescript_cross_language_fixtures() {
        for (studio, expected) in [
            ("Yoga Studio GmbH", "yoga-studio-gmbh"),
            ("--Test--", "test"),
            ("Bikram Yoga", "bikram-yoga"),
            ("İ Yoga", "i-yoga"),
            ("Crème & Co.", "cr-me-co"),
        ] {
            assert_eq!(studio_slug(studio), expected, "fixture {studio:?}");
        }
    }

    #[test]
    fn refinalization_uses_guarded_descriptor_writes_without_rename_overwrite() {
        let write_helper = concat!("write_", "verified_finalized_invoice");
        let rename_at = concat!("rename", "at(");
        let write_only = concat!("libc::O_", "WRONLY");
        let invoice_files_source = include_str!("invoice_files.rs");

        assert!(invoice_files_source.contains(write_helper));
        assert!(!invoice_files_source.contains(rename_at));
        assert!(invoice_files_source.contains(write_only));
    }

    #[cfg(unix)]
    #[test]
    fn guarded_writer_updates_the_verified_inode_and_returns_its_new_revision() {
        use std::os::unix::fs::MetadataExt;

        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let filename = "8-2026-yoga-2026-01.pdf";
        write_pdf(&output, filename);
        let path = output.join("Final").join(filename);
        let inode_before = std::fs::metadata(&path).unwrap().ino();
        let lookup = lookup_finalized_invoice(output.to_str().unwrap(), "Yoga", "2026", "01");
        let FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir,
            file_revision,
            ..
        } = lookup
        else {
            panic!("expected one match");
        };

        let written_revision = write_verified_finalized_invoice(
            &canonical_output_dir,
            "Yoga",
            "2026",
            "01",
            filename,
            "8/2026",
            &file_revision,
            b"replacement-pdf",
        )
        .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"replacement-pdf");
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode_before);
        assert_eq!(written_revision.file_id, file_revision.file_id);
        assert_eq!(
            written_revision.final_directory_file_id,
            file_revision.final_directory_file_id
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_writer_detects_a_name_and_directory_race_after_opening_the_target() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let filename = "8-2026-yoga-2026-01.pdf";
        write_pdf(&output, filename);
        let lookup = lookup_finalized_invoice(output.to_str().unwrap(), "Yoga", "2026", "01");
        let FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir,
            file_revision,
            ..
        } = lookup
        else {
            panic!("expected one match");
        };

        let result = write_verified_finalized_invoice_with_hook(
            &canonical_output_dir,
            "Yoga",
            "2026",
            "01",
            filename,
            "8/2026",
            &file_revision,
            b"replacement-pdf",
            || {
                std::fs::rename(output.join("Final"), output.join("Final-detached")).unwrap();
                std::fs::create_dir(output.join("Final")).unwrap();
                std::fs::write(output.join("Final").join(filename), b"visible-racer").unwrap();
            },
        );

        assert!(matches!(
            result,
            Err(VerifiedFinalizedInvoiceError::Conflict)
        ));
        assert_eq!(
            std::fs::read(output.join("Final").join(filename)).unwrap(),
            b"visible-racer"
        );
        assert_eq!(
            std::fs::read(output.join("Final-detached").join(filename)).unwrap(),
            b"replacement-pdf"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verified_consumer_rejects_a_replaced_final_symlink_without_reading_outside() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let filename = "8-2026-yoga-2026-01.pdf";
        write_pdf(&output, filename);
        std::fs::write(outside.join(filename), b"outside-pdf").unwrap();

        let lookup = lookup_finalized_invoice(output.to_str().unwrap(), "Yoga", "2026", "01");
        let FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir,
            final_filename,
            file_revision,
            ..
        } = lookup
        else {
            panic!("expected one match");
        };

        let original_final = output.join("Final-original");
        std::fs::rename(output.join("Final"), &original_final).unwrap();
        symlink(&outside, output.join("Final")).unwrap();

        assert!(consume_verified_finalized_invoice(
            &canonical_output_dir,
            "Yoga",
            "2026",
            "01",
            &final_filename,
            "8/2026",
            &file_revision
        )
        .is_err());
        assert_eq!(
            std::fs::read(original_final.join(filename)).unwrap(),
            b"pdf"
        );
        assert_eq!(
            std::fs::read(outside.join(filename)).unwrap(),
            b"outside-pdf"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verified_consumer_rejects_a_real_directory_swap_even_with_the_same_file_inode() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let replacement_final = root.path().join("replacement-final");
        std::fs::create_dir_all(&replacement_final).unwrap();
        let filename = "8-2026-yoga-2026-01.pdf";
        write_pdf(&output, filename);
        std::fs::hard_link(
            output.join("Final").join(filename),
            replacement_final.join(filename),
        )
        .unwrap();

        let lookup = lookup_finalized_invoice(output.to_str().unwrap(), "Yoga", "2026", "01");
        let FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir,
            final_filename,
            file_revision,
            ..
        } = lookup
        else {
            panic!("expected one match");
        };
        let original_final = output.join("Final-original");
        std::fs::rename(output.join("Final"), &original_final).unwrap();
        std::fs::rename(&replacement_final, output.join("Final")).unwrap();

        let read_result = consume_verified_finalized_invoice(
            &canonical_output_dir,
            "Yoga",
            "2026",
            "01",
            &final_filename,
            "8/2026",
            &file_revision,
        );

        assert!(read_result.is_err());
        assert_eq!(
            std::fs::read(original_final.join(filename)).unwrap(),
            b"pdf"
        );
        assert_eq!(
            std::fs::read(output.join("Final").join(filename)).unwrap(),
            b"pdf"
        );
    }
}
