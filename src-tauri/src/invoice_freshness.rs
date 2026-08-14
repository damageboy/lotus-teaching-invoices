use crate::invoice_files::{
    consume_verified_finalized_invoice, invoice_number_for_filename, lookup_finalized_invoice,
    write_verified_finalized_invoice, FileRevision, FinalizedInvoiceLookup,
    VerifiedFinalizedInvoiceError,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const STORAGE_ERROR: &str = "Invoice freshness storage failed.";
const INVALID_INPUT: &str = "The invoice freshness request is invalid.";
const FRESHNESS_DB_FILE: &str = "invoice-freshness.sqlite";
static LAST_TIMESTAMP_NANOS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceFreshnessKey {
    pub calendar_id: String,
    pub output_dir: String,
    pub studio_name: String,
    pub month_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceFreshnessRow {
    pub key: InvoiceFreshnessKey,
    pub invoice_number: String,
    pub final_filename: String,
    pub stale_at: String,
    pub reason: String,
    pub cleared_at: Option<String>,
    pub revision: i64,
    pub last_operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceFreshnessMark {
    pub key: InvoiceFreshnessKey,
    pub invoice_number: String,
    pub final_filename: String,
    pub reason: String,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvoiceFreshnessErrorCode {
    InvalidInput,
    NotFound,
    Ambiguous,
    Unreadable,
    Stale,
    Conflict,
    Storage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceFreshnessError {
    pub code: InvoiceFreshnessErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filenames: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "currentRevision")]
    pub current_revision: Option<i64>,
}

impl InvoiceFreshnessError {
    fn new(code: InvoiceFreshnessErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_string(),
            filenames: None,
            current_revision: None,
        }
    }

    fn invalid_input() -> Self {
        Self::new(InvoiceFreshnessErrorCode::InvalidInput, INVALID_INPUT)
    }

    fn storage() -> Self {
        Self::new(InvoiceFreshnessErrorCode::Storage, STORAGE_ERROR)
    }

    fn conflict(current_revision: Option<i64>) -> Self {
        Self {
            current_revision,
            ..Self::new(
                InvoiceFreshnessErrorCode::Conflict,
                "The invoice freshness record changed. Reload and try again.",
            )
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ClearInvoiceFreshnessResult {
    Cleared {
        row: InvoiceFreshnessRow,
    },
    NotFound,
    Conflict {
        #[serde(rename = "currentRevision")]
        current_revision: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedReFinalization {
    pub key: InvoiceFreshnessKey,
    pub final_filename: String,
    pub invoice_number: String,
    pub file_revision: FileRevision,
    pub freshness_revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInvoiceEmail {
    pub key: InvoiceFreshnessKey,
    pub final_filename: String,
    pub invoice_number: String,
    pub file_revision: FileRevision,
    pub pdf_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReFinalizedInvoiceRequest {
    pub key: InvoiceFreshnessKey,
    pub final_filename: String,
    pub invoice_number: String,
    pub expected_freshness_revision: i64,
    pub expected_file_revision: FileRevision,
    pub pdf_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WriteReFinalizedInvoiceResult {
    Written {
        output_path: String,
        filename: String,
    },
}

struct MatchedInvoice {
    canonical_output_dir: String,
    final_filename: String,
    invoice_number: String,
    file_revision: FileRevision,
}

pub struct InvoiceFreshnessStore {
    path: PathBuf,
}

impl InvoiceFreshnessStore {
    pub fn open(path: PathBuf) -> Result<Self, InvoiceFreshnessError> {
        let store = Self { path };
        store.migrate()?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, InvoiceFreshnessError> {
        let connection =
            Connection::open(&self.path).map_err(|_| InvoiceFreshnessError::storage())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| InvoiceFreshnessError::storage())?;
        Ok(connection)
    }

    fn migrate(&self) -> Result<(), InvoiceFreshnessError> {
        self.connect()?
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS invoice_freshness (
                    calendar_id TEXT NOT NULL,
                    output_dir TEXT NOT NULL,
                    studio_name TEXT NOT NULL,
                    month_key TEXT NOT NULL,
                    invoice_number TEXT NOT NULL,
                    final_filename TEXT NOT NULL,
                    stale_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    cleared_at TEXT,
                    revision INTEGER NOT NULL,
                    last_operation_id TEXT,
                    PRIMARY KEY (calendar_id, output_dir, studio_name, month_key)
                );
                CREATE TABLE IF NOT EXISTS invoice_freshness_operations (
                    calendar_id TEXT NOT NULL,
                    output_dir TEXT NOT NULL,
                    studio_name TEXT NOT NULL,
                    month_key TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    PRIMARY KEY (calendar_id, output_dir, studio_name, month_key, operation_id)
                );
                INSERT OR IGNORE INTO invoice_freshness_operations (
                    calendar_id, output_dir, studio_name, month_key, operation_id
                )
                SELECT calendar_id, output_dir, studio_name, month_key, last_operation_id
                FROM invoice_freshness
                WHERE last_operation_id IS NOT NULL;",
            )
            .map_err(|_| InvoiceFreshnessError::storage())
    }

    fn canonical_key(
        &self,
        key: &InvoiceFreshnessKey,
    ) -> Result<InvoiceFreshnessKey, InvoiceFreshnessError> {
        validate_key_fields(key)?;
        let output_dir = canonical_output_dir(&key.output_dir)?
            .ok_or_else(InvoiceFreshnessError::invalid_input)?;
        Ok(InvoiceFreshnessKey {
            calendar_id: key.calendar_id.clone(),
            output_dir,
            studio_name: key.studio_name.clone(),
            month_key: key.month_key.clone(),
        })
    }

    pub fn list_active(
        &self,
        calendar_id: &str,
        output_dir: &str,
    ) -> Result<Vec<InvoiceFreshnessRow>, InvoiceFreshnessError> {
        if calendar_id.trim().is_empty() {
            return Err(InvoiceFreshnessError::invalid_input());
        }
        let Some(output_dir) = canonical_output_dir(output_dir)? else {
            return Ok(Vec::new());
        };
        let connection = self.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT calendar_id, output_dir, studio_name, month_key, invoice_number,
                        final_filename, stale_at, reason, cleared_at, revision, last_operation_id
                 FROM invoice_freshness
                 WHERE calendar_id = ?1 AND output_dir = ?2 AND cleared_at IS NULL
                 ORDER BY studio_name, month_key",
            )
            .map_err(|_| InvoiceFreshnessError::storage())?;
        let rows = statement
            .query_map(params![calendar_id, output_dir], invoice_freshness_row)
            .map_err(|_| InvoiceFreshnessError::storage())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| InvoiceFreshnessError::storage())?;
        Ok(rows)
    }

    pub fn mark_stale(
        &self,
        request: &InvoiceFreshnessMark,
    ) -> Result<InvoiceFreshnessRow, InvoiceFreshnessError> {
        let key = self.canonical_key(&request.key)?;
        validate_mark(request, &key)?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| InvoiceFreshnessError::storage())?;
        let current = select_row(&transaction, &key)?;
        if let Some(operation_id) = request.operation_id.as_ref() {
            if operation_was_recorded(&transaction, &key, operation_id)? {
                let replayed = current.ok_or_else(InvoiceFreshnessError::storage)?;
                transaction
                    .commit()
                    .map_err(|_| InvoiceFreshnessError::storage())?;
                return Ok(replayed);
            }
        }

        let timestamp = timestamp_now();
        let revision = current.as_ref().map_or(1, |row| row.revision + 1);
        transaction
            .execute(
                "INSERT INTO invoice_freshness (
                    calendar_id, output_dir, studio_name, month_key, invoice_number,
                    final_filename, stale_at, reason, cleared_at, revision, last_operation_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10)
                 ON CONFLICT(calendar_id, output_dir, studio_name, month_key) DO UPDATE SET
                    invoice_number = excluded.invoice_number,
                    final_filename = excluded.final_filename,
                    stale_at = excluded.stale_at,
                    reason = excluded.reason,
                    cleared_at = NULL,
                    revision = excluded.revision,
                    last_operation_id = excluded.last_operation_id",
                params![
                    key.calendar_id,
                    key.output_dir,
                    key.studio_name,
                    key.month_key,
                    request.invoice_number,
                    request.final_filename,
                    timestamp,
                    request.reason,
                    revision,
                    request.operation_id,
                ],
            )
            .map_err(|_| InvoiceFreshnessError::storage())?;
        if let Some(operation_id) = request.operation_id.as_ref() {
            transaction
                .execute(
                    "INSERT INTO invoice_freshness_operations (
                        calendar_id, output_dir, studio_name, month_key, operation_id
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        key.calendar_id,
                        key.output_dir,
                        key.studio_name,
                        key.month_key,
                        operation_id,
                    ],
                )
                .map_err(|_| InvoiceFreshnessError::storage())?;
        }
        transaction
            .commit()
            .map_err(|_| InvoiceFreshnessError::storage())?;
        Ok(InvoiceFreshnessRow {
            key,
            invoice_number: request.invoice_number.clone(),
            final_filename: request.final_filename.clone(),
            stale_at: timestamp,
            reason: request.reason.clone(),
            cleared_at: None,
            revision,
            last_operation_id: request.operation_id.clone(),
        })
    }

    pub fn clear(
        &self,
        key: &InvoiceFreshnessKey,
        expected_revision: i64,
    ) -> Result<ClearInvoiceFreshnessResult, InvoiceFreshnessError> {
        if expected_revision < 1 {
            return Err(InvoiceFreshnessError::invalid_input());
        }
        let key = self.canonical_key(key)?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| InvoiceFreshnessError::storage())?;
        let Some(mut current) = select_row(&transaction, &key)? else {
            transaction
                .commit()
                .map_err(|_| InvoiceFreshnessError::storage())?;
            return Ok(ClearInvoiceFreshnessResult::NotFound);
        };
        if current.revision != expected_revision {
            let current_revision = current.revision;
            transaction
                .commit()
                .map_err(|_| InvoiceFreshnessError::storage())?;
            return Ok(ClearInvoiceFreshnessResult::Conflict { current_revision });
        }
        if current.cleared_at.is_some() {
            transaction
                .commit()
                .map_err(|_| InvoiceFreshnessError::storage())?;
            return Ok(ClearInvoiceFreshnessResult::NotFound);
        }

        let cleared_at = timestamp_now();
        let revision = current.revision + 1;
        let changed = transaction
            .execute(
                "UPDATE invoice_freshness
                 SET cleared_at = ?1, revision = ?2
                 WHERE calendar_id = ?3 AND output_dir = ?4 AND studio_name = ?5
                   AND month_key = ?6 AND revision = ?7 AND cleared_at IS NULL",
                params![
                    cleared_at,
                    revision,
                    key.calendar_id,
                    key.output_dir,
                    key.studio_name,
                    key.month_key,
                    expected_revision,
                ],
            )
            .map_err(|_| InvoiceFreshnessError::storage())?;
        if changed != 1 {
            return Err(InvoiceFreshnessError::storage());
        }
        transaction
            .commit()
            .map_err(|_| InvoiceFreshnessError::storage())?;
        current.cleared_at = Some(cleared_at);
        current.revision = revision;
        Ok(ClearInvoiceFreshnessResult::Cleared { row: current })
    }
}

pub struct InvoiceFreshnessService {
    store: InvoiceFreshnessStore,
    gate: Mutex<()>,
}

impl InvoiceFreshnessService {
    pub fn open(path: PathBuf) -> Result<Self, InvoiceFreshnessError> {
        Ok(Self {
            store: InvoiceFreshnessStore::open(path)?,
            gate: Mutex::new(()),
        })
    }

    pub fn for_app_storage_root(root: &Path) -> Result<Self, InvoiceFreshnessError> {
        Self::open(root.join(FRESHNESS_DB_FILE))
    }

    pub fn list_active(
        &self,
        calendar_id: &str,
        output_dir: &str,
    ) -> Result<Vec<InvoiceFreshnessRow>, InvoiceFreshnessError> {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        self.store.list_active(calendar_id, output_dir)
    }

    pub fn mark_stale(
        &self,
        request: &InvoiceFreshnessMark,
    ) -> Result<InvoiceFreshnessRow, InvoiceFreshnessError> {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        self.store.mark_stale(request)
    }

    pub fn mark_finalized_invoice_stale(
        &self,
        key: &InvoiceFreshnessKey,
        reason: &str,
        operation_id: &str,
    ) -> Result<Option<InvoiceFreshnessRow>, InvoiceFreshnessError> {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        validate_key_fields(key)?;
        let (period_year, period_month) =
            month_parts(&key.month_key).ok_or_else(InvoiceFreshnessError::invalid_input)?;
        let lookup =
            lookup_finalized_invoice(&key.output_dir, &key.studio_name, period_year, period_month);
        let matched = match lookup {
            FinalizedInvoiceLookup::NotFound => return Ok(None),
            other => matched_from_lookup(other)?,
        };
        let canonical_key = self.store.canonical_key(&InvoiceFreshnessKey {
            output_dir: matched.canonical_output_dir,
            ..key.clone()
        })?;
        let request = InvoiceFreshnessMark {
            key: canonical_key,
            invoice_number: matched.invoice_number,
            final_filename: matched.final_filename,
            reason: reason.to_string(),
            operation_id: Some(operation_id.to_string()),
        };
        self.store.mark_stale(&request).map(Some)
    }

    pub fn clear(
        &self,
        key: &InvoiceFreshnessKey,
        expected_revision: i64,
    ) -> Result<ClearInvoiceFreshnessResult, InvoiceFreshnessError> {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        self.store.clear(key, expected_revision)
    }

    pub fn prepare_re_finalization(
        &self,
        key: &InvoiceFreshnessKey,
        expected_revision: i64,
    ) -> Result<PreparedReFinalization, InvoiceFreshnessError> {
        if expected_revision < 1 {
            return Err(InvoiceFreshnessError::conflict(None));
        }
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        let canonical_key = self.store.canonical_key(key)?;
        let mut connection = self.store.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| InvoiceFreshnessError::storage())?;
        let Some(row) = select_active_row(&transaction, &canonical_key)? else {
            return Err(InvoiceFreshnessError::conflict(None));
        };
        if row.revision != expected_revision {
            return Err(InvoiceFreshnessError::conflict(Some(row.revision)));
        }
        let (period_year, period_month) = month_parts(&canonical_key.month_key)
            .ok_or_else(InvoiceFreshnessError::invalid_input)?;
        let lookup = lookup_finalized_invoice(
            &canonical_key.output_dir,
            &canonical_key.studio_name,
            period_year,
            period_month,
        );
        let matched = matched_from_lookup(lookup)?;
        if matched.final_filename != row.final_filename
            || matched.invoice_number != row.invoice_number
        {
            return Err(InvoiceFreshnessError::conflict(Some(row.revision)));
        }
        transaction
            .commit()
            .map_err(|_| InvoiceFreshnessError::storage())?;
        Ok(PreparedReFinalization {
            key: InvoiceFreshnessKey {
                output_dir: matched.canonical_output_dir,
                ..canonical_key
            },
            final_filename: matched.final_filename,
            invoice_number: matched.invoice_number,
            file_revision: matched.file_revision,
            freshness_revision: row.revision,
        })
    }

    pub fn prepare_invoice_email(
        &self,
        key: &InvoiceFreshnessKey,
    ) -> Result<PreparedInvoiceEmail, InvoiceFreshnessError> {
        let canonical_key = self.store.canonical_key(key)?;
        let (period_year, period_month) = month_parts(&canonical_key.month_key)
            .ok_or_else(InvoiceFreshnessError::invalid_input)?;
        self.prepare_invoice_email_with(&canonical_key, || {
            lookup_finalized_invoice(
                &canonical_key.output_dir,
                &canonical_key.studio_name,
                period_year,
                period_month,
            )
        })
    }

    pub fn write_re_finalized_invoice(
        &self,
        request: &WriteReFinalizedInvoiceRequest,
    ) -> Result<WriteReFinalizedInvoiceResult, InvoiceFreshnessError> {
        if request.expected_freshness_revision < 1 || request.pdf_bytes.is_empty() {
            return Err(InvoiceFreshnessError::invalid_input());
        }
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        let canonical_key = self.store.canonical_key(&request.key)?;
        let (period_year, period_month) = month_parts(&canonical_key.month_key)
            .ok_or_else(InvoiceFreshnessError::invalid_input)?;
        let expected_number = invoice_number_for_filename(
            &request.final_filename,
            &crate::invoice_files::studio_slug(&canonical_key.studio_name),
            period_year,
            period_month,
        );
        if expected_number.as_deref() != Some(request.invoice_number.as_str()) {
            return Err(InvoiceFreshnessError::invalid_input());
        }

        let mut connection = self.store.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| InvoiceFreshnessError::storage())?;
        let Some(row) = select_active_row(&transaction, &canonical_key)? else {
            return Err(InvoiceFreshnessError::conflict(None));
        };
        if row.revision != request.expected_freshness_revision
            || row.final_filename != request.final_filename
            || row.invoice_number != request.invoice_number
        {
            return Err(InvoiceFreshnessError::conflict(Some(row.revision)));
        }

        let matched = matched_from_lookup(lookup_finalized_invoice(
            &canonical_key.output_dir,
            &canonical_key.studio_name,
            period_year,
            period_month,
        ))?;
        if matched.canonical_output_dir != canonical_key.output_dir
            || matched.final_filename != request.final_filename
            || matched.invoice_number != request.invoice_number
            || matched.file_revision != request.expected_file_revision
        {
            return Err(InvoiceFreshnessError::conflict(Some(row.revision)));
        }

        write_verified_finalized_invoice(
            &matched.canonical_output_dir,
            &canonical_key.studio_name,
            period_year,
            period_month,
            &matched.final_filename,
            &matched.invoice_number,
            &request.expected_file_revision,
            &request.pdf_bytes,
        )
        .map_err(verified_file_error)?;

        let cleared_at = timestamp_now();
        let changed = transaction
            .execute(
                "UPDATE invoice_freshness
                 SET cleared_at = ?1, revision = revision + 1
                 WHERE calendar_id = ?2 AND output_dir = ?3 AND studio_name = ?4
                   AND month_key = ?5 AND revision = ?6 AND cleared_at IS NULL",
                params![
                    cleared_at,
                    canonical_key.calendar_id,
                    canonical_key.output_dir,
                    canonical_key.studio_name,
                    canonical_key.month_key,
                    request.expected_freshness_revision,
                ],
            )
            .map_err(|_| InvoiceFreshnessError::storage())?;
        if changed != 1 {
            return Err(InvoiceFreshnessError::conflict(Some(row.revision)));
        }
        transaction
            .commit()
            .map_err(|_| InvoiceFreshnessError::storage())?;

        Ok(WriteReFinalizedInvoiceResult::Written {
            output_path: Path::new(&matched.canonical_output_dir)
                .join("Final")
                .join(&matched.final_filename)
                .to_str()
                .ok_or_else(InvoiceFreshnessError::storage)?
                .to_string(),
            filename: matched.final_filename,
        })
    }

    fn prepare_invoice_email_with<F>(
        &self,
        key: &InvoiceFreshnessKey,
        lookup: F,
    ) -> Result<PreparedInvoiceEmail, InvoiceFreshnessError>
    where
        F: FnOnce() -> FinalizedInvoiceLookup,
    {
        let _guard = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        let canonical_key = self.store.canonical_key(key)?;
        let mut connection = self.store.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| InvoiceFreshnessError::storage())?;
        if let Some(row) = select_active_row(&transaction, &canonical_key)? {
            return Err(InvoiceFreshnessError {
                current_revision: Some(row.revision),
                ..InvoiceFreshnessError::new(
                    InvoiceFreshnessErrorCode::Stale,
                    "The finalized invoice is out of date and must be re-finalized before email.",
                )
            });
        }
        let matched = matched_from_lookup(lookup())?;
        let (period_year, period_month) = month_parts(&canonical_key.month_key)
            .ok_or_else(InvoiceFreshnessError::invalid_input)?;
        let pdf_bytes = consume_verified_finalized_invoice(
            &matched.canonical_output_dir,
            &canonical_key.studio_name,
            period_year,
            period_month,
            &matched.final_filename,
            &matched.invoice_number,
            &matched.file_revision,
        )
        .map_err(verified_file_error)?;
        transaction
            .commit()
            .map_err(|_| InvoiceFreshnessError::storage())?;
        Ok(PreparedInvoiceEmail {
            key: InvoiceFreshnessKey {
                output_dir: matched.canonical_output_dir,
                ..canonical_key
            },
            final_filename: matched.final_filename,
            invoice_number: matched.invoice_number,
            file_revision: matched.file_revision,
            pdf_bytes,
        })
    }
}

fn validate_key_fields(key: &InvoiceFreshnessKey) -> Result<(), InvoiceFreshnessError> {
    if key.calendar_id.trim().is_empty()
        || key.studio_name.trim().is_empty()
        || month_parts(&key.month_key).is_none()
    {
        return Err(InvoiceFreshnessError::invalid_input());
    }
    Ok(())
}

fn validate_mark(
    request: &InvoiceFreshnessMark,
    canonical_key: &InvoiceFreshnessKey,
) -> Result<(), InvoiceFreshnessError> {
    if request.reason.trim().is_empty()
        || request
            .operation_id
            .as_ref()
            .is_some_and(|operation_id| operation_id.trim().is_empty())
    {
        return Err(InvoiceFreshnessError::invalid_input());
    }
    let (period_year, period_month) =
        month_parts(&canonical_key.month_key).ok_or_else(InvoiceFreshnessError::invalid_input)?;
    let slug = crate::invoice_files::studio_slug(&canonical_key.studio_name);
    if invoice_number_for_filename(&request.final_filename, &slug, period_year, period_month)
        .as_deref()
        != Some(request.invoice_number.as_str())
    {
        return Err(InvoiceFreshnessError::invalid_input());
    }
    Ok(())
}

fn month_parts(month_key: &str) -> Option<(&str, &str)> {
    let bytes = month_key.as_bytes();
    if bytes.len() != 7
        || bytes[4] != b'-'
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..].iter().all(u8::is_ascii_digit)
        || !(b'0'..=b'1').contains(&bytes[5])
        || (bytes[5] == b'0' && !(b'1'..=b'9').contains(&bytes[6]))
        || (bytes[5] == b'1' && !(b'0'..=b'2').contains(&bytes[6]))
    {
        return None;
    }
    Some((&month_key[..4], &month_key[5..]))
}

fn canonical_output_dir(output_dir: &str) -> Result<Option<String>, InvoiceFreshnessError> {
    if output_dir.is_empty() {
        return Ok(None);
    }
    let path = Path::new(output_dir);
    let canonical = match std::fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(InvoiceFreshnessError::new(
                InvoiceFreshnessErrorCode::Unreadable,
                "The invoice output folder could not be read.",
            ))
        }
    };
    if !canonical.is_dir() {
        return Err(InvoiceFreshnessError::new(
            InvoiceFreshnessErrorCode::Unreadable,
            "The invoice output folder could not be read.",
        ));
    }
    canonical
        .to_str()
        .map(|path| Some(path.to_string()))
        .ok_or_else(|| {
            InvoiceFreshnessError::new(
                InvoiceFreshnessErrorCode::Unreadable,
                "The invoice output folder could not be read.",
            )
        })
}

fn invoice_freshness_row(row: &Row<'_>) -> rusqlite::Result<InvoiceFreshnessRow> {
    Ok(InvoiceFreshnessRow {
        key: InvoiceFreshnessKey {
            calendar_id: row.get(0)?,
            output_dir: row.get(1)?,
            studio_name: row.get(2)?,
            month_key: row.get(3)?,
        },
        invoice_number: row.get(4)?,
        final_filename: row.get(5)?,
        stale_at: row.get(6)?,
        reason: row.get(7)?,
        cleared_at: row.get(8)?,
        revision: row.get(9)?,
        last_operation_id: row.get(10)?,
    })
}

fn select_row(
    transaction: &Transaction<'_>,
    key: &InvoiceFreshnessKey,
) -> Result<Option<InvoiceFreshnessRow>, InvoiceFreshnessError> {
    transaction
        .query_row(
            "SELECT calendar_id, output_dir, studio_name, month_key, invoice_number,
                    final_filename, stale_at, reason, cleared_at, revision, last_operation_id
             FROM invoice_freshness
             WHERE calendar_id = ?1 AND output_dir = ?2 AND studio_name = ?3 AND month_key = ?4",
            params![
                key.calendar_id,
                key.output_dir,
                key.studio_name,
                key.month_key
            ],
            invoice_freshness_row,
        )
        .optional()
        .map_err(|_| InvoiceFreshnessError::storage())
}

fn select_active_row(
    transaction: &Transaction<'_>,
    key: &InvoiceFreshnessKey,
) -> Result<Option<InvoiceFreshnessRow>, InvoiceFreshnessError> {
    Ok(select_row(transaction, key)?.filter(|row| row.cleared_at.is_none()))
}

fn operation_was_recorded(
    transaction: &Transaction<'_>,
    key: &InvoiceFreshnessKey,
    operation_id: &str,
) -> Result<bool, InvoiceFreshnessError> {
    transaction
        .query_row(
            "SELECT 1 FROM invoice_freshness_operations
             WHERE calendar_id = ?1 AND output_dir = ?2 AND studio_name = ?3
               AND month_key = ?4 AND operation_id = ?5",
            params![
                key.calendar_id,
                key.output_dir,
                key.studio_name,
                key.month_key,
                operation_id
            ],
            |_| Ok(()),
        )
        .optional()
        .map(|recorded| recorded.is_some())
        .map_err(|_| InvoiceFreshnessError::storage())
}

fn matched_from_lookup(
    lookup: FinalizedInvoiceLookup,
) -> Result<MatchedInvoice, InvoiceFreshnessError> {
    match lookup {
        FinalizedInvoiceLookup::NotFound => Err(InvoiceFreshnessError::new(
            InvoiceFreshnessErrorCode::NotFound,
            "No finalized invoice was found.",
        )),
        FinalizedInvoiceLookup::Ambiguous { filenames } => Err(InvoiceFreshnessError {
            filenames: Some(filenames),
            ..InvoiceFreshnessError::new(
                InvoiceFreshnessErrorCode::Ambiguous,
                "Multiple finalized invoices match this studio and month.",
            )
        }),
        FinalizedInvoiceLookup::Unreadable { message } => Err(InvoiceFreshnessError::new(
            InvoiceFreshnessErrorCode::Unreadable,
            &message,
        )),
        FinalizedInvoiceLookup::OneMatch {
            canonical_output_dir,
            final_filename,
            invoice_number,
            pdf_path: _,
            file_revision,
        } => Ok(MatchedInvoice {
            canonical_output_dir,
            final_filename,
            invoice_number,
            file_revision,
        }),
    }
}

fn verified_file_error(error: VerifiedFinalizedInvoiceError) -> InvoiceFreshnessError {
    match error {
        VerifiedFinalizedInvoiceError::NotFound => InvoiceFreshnessError::new(
            InvoiceFreshnessErrorCode::NotFound,
            "No finalized invoice was found.",
        ),
        VerifiedFinalizedInvoiceError::Ambiguous { filenames } => InvoiceFreshnessError {
            filenames: Some(filenames),
            ..InvoiceFreshnessError::new(
                InvoiceFreshnessErrorCode::Ambiguous,
                "Multiple finalized invoices match this studio and month.",
            )
        },
        VerifiedFinalizedInvoiceError::Unreadable => InvoiceFreshnessError::new(
            InvoiceFreshnessErrorCode::Unreadable,
            "The finalized invoice could not be read safely.",
        ),
        VerifiedFinalizedInvoiceError::Conflict => InvoiceFreshnessError::conflict(None),
    }
}

fn timestamp_now() -> String {
    let system_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64;
    format_timestamp(monotonic_timestamp_nanos(
        &LAST_TIMESTAMP_NANOS,
        system_nanos,
    ))
}

fn monotonic_timestamp_nanos(last: &AtomicU64, system_nanos: u64) -> u64 {
    let previous = last
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |previous| {
            Some(system_nanos.max(previous.saturating_add(1)))
        })
        .unwrap_or_else(|previous| previous);
    system_nanos.max(previous.saturating_add(1)).min(u64::MAX)
}

fn format_timestamp(unix_nanos: u64) -> String {
    let unix_seconds = unix_nanos / 1_000_000_000;
    let fractional = unix_nanos % 1_000_000_000;
    let days = (unix_seconds / 86_400) as i64;
    let seconds_of_day = unix_seconds % 86_400;
    let (year, month, day) = civil_date_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = seconds_of_day % 3_600 / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fractional:09}Z")
}

fn civil_date_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[tauri::command]
pub fn list_active_invoice_freshness(
    service: State<'_, InvoiceFreshnessService>,
    calendar_id: String,
    output_dir: String,
) -> Result<Vec<InvoiceFreshnessRow>, InvoiceFreshnessError> {
    service.list_active(&calendar_id, &output_dir)
}

#[tauri::command]
pub fn prepare_re_finalization(
    service: State<'_, InvoiceFreshnessService>,
    key: InvoiceFreshnessKey,
    expected_revision: i64,
) -> Result<PreparedReFinalization, InvoiceFreshnessError> {
    service.prepare_re_finalization(&key, expected_revision)
}

#[tauri::command]
pub fn prepare_invoice_email(
    service: State<'_, InvoiceFreshnessService>,
    key: InvoiceFreshnessKey,
) -> Result<PreparedInvoiceEmail, InvoiceFreshnessError> {
    service.prepare_invoice_email(&key)
}

#[tauri::command]
pub fn write_re_finalized_invoice(
    service: State<'_, InvoiceFreshnessService>,
    request: WriteReFinalizedInvoiceRequest,
) -> Result<WriteReFinalizedInvoiceResult, InvoiceFreshnessError> {
    service.write_re_finalized_invoice(&request)
}

#[tauri::command]
pub fn mark_invoice_freshness(
    service: State<'_, InvoiceFreshnessService>,
    request: InvoiceFreshnessMark,
) -> Result<InvoiceFreshnessRow, InvoiceFreshnessError> {
    service.mark_stale(&request)
}

#[tauri::command]
pub fn clear_invoice_freshness(
    service: State<'_, InvoiceFreshnessService>,
    key: InvoiceFreshnessKey,
    expected_revision: i64,
) -> Result<ClearInvoiceFreshnessResult, InvoiceFreshnessError> {
    service.clear(&key, expected_revision)
}

#[cfg(test)]
mod tests {
    use super::{
        monotonic_timestamp_nanos, ClearInvoiceFreshnessResult, InvoiceFreshnessError,
        InvoiceFreshnessErrorCode, InvoiceFreshnessKey, InvoiceFreshnessMark,
        InvoiceFreshnessService, InvoiceFreshnessStore, WriteReFinalizedInvoiceRequest,
        WriteReFinalizedInvoiceResult,
    };
    use crate::calendar_store::CalendarStore;
    use rusqlite::Connection;
    use std::sync::atomic::AtomicU64;
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;

    fn output_dir(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        let output = root.join(name);
        std::fs::create_dir_all(&output).unwrap();
        output
    }

    #[test]
    fn timestamp_sequence_advances_when_the_wall_clock_repeats_or_moves_backwards() {
        let last = AtomicU64::new(0);
        assert_eq!(monotonic_timestamp_nanos(&last, 100), 100);
        assert_eq!(monotonic_timestamp_nanos(&last, 100), 101);
        assert_eq!(monotonic_timestamp_nanos(&last, 99), 102);
    }

    fn key(
        calendar_id: &str,
        output_dir: &std::path::Path,
        studio_name: &str,
        month_key: &str,
    ) -> InvoiceFreshnessKey {
        InvoiceFreshnessKey {
            calendar_id: calendar_id.to_string(),
            output_dir: output_dir.to_str().unwrap().to_string(),
            studio_name: studio_name.to_string(),
            month_key: month_key.to_string(),
        }
    }

    fn slug(name: &str) -> String {
        crate::invoice_files::studio_slug(name)
    }

    fn mark(key: InvoiceFreshnessKey, operation_id: &str, reason: &str) -> InvoiceFreshnessMark {
        let (period_year, period_month) = key.month_key.split_once('-').unwrap();
        InvoiceFreshnessMark {
            final_filename: format!(
                "8-2026-{}-{period_year}-{period_month}.pdf",
                slug(&key.studio_name)
            ),
            invoice_number: "8/2026".to_string(),
            key,
            reason: reason.to_string(),
            operation_id: Some(operation_id.to_string()),
        }
    }

    fn write_final(key: &InvoiceFreshnessKey, filename: &str) {
        let final_dir = std::path::Path::new(&key.output_dir).join("Final");
        std::fs::create_dir_all(&final_dir).unwrap();
        std::fs::write(final_dir.join(filename), b"pdf").unwrap();
    }

    fn write_request(
        prepared: &super::PreparedReFinalization,
        pdf_bytes: &[u8],
    ) -> WriteReFinalizedInvoiceRequest {
        WriteReFinalizedInvoiceRequest {
            key: prepared.key.clone(),
            final_filename: prepared.final_filename.clone(),
            invoice_number: prepared.invoice_number.clone(),
            expected_freshness_revision: prepared.freshness_revision,
            expected_file_revision: prepared.file_revision.clone(),
            pdf_bytes: pdf_bytes.to_vec(),
        }
    }

    #[test]
    fn migration_creates_exact_separate_schema() {
        let root = tempfile::tempdir().unwrap();
        let freshness_path = root.path().join("invoice-freshness.sqlite");
        InvoiceFreshnessStore::open(freshness_path.clone()).unwrap();

        assert!(!root.path().join("calendar-cache.sqlite").exists());
        let connection = Connection::open(freshness_path).unwrap();
        let mut statement = connection
            .prepare("PRAGMA table_info(invoice_freshness)")
            .unwrap();
        let columns = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![
                ("calendar_id".to_string(), "TEXT".to_string(), 1, 1),
                ("output_dir".to_string(), "TEXT".to_string(), 1, 2),
                ("studio_name".to_string(), "TEXT".to_string(), 1, 3),
                ("month_key".to_string(), "TEXT".to_string(), 1, 4),
                ("invoice_number".to_string(), "TEXT".to_string(), 1, 0),
                ("final_filename".to_string(), "TEXT".to_string(), 1, 0),
                ("stale_at".to_string(), "TEXT".to_string(), 1, 0),
                ("reason".to_string(), "TEXT".to_string(), 1, 0),
                ("cleared_at".to_string(), "TEXT".to_string(), 0, 0),
                ("revision".to_string(), "INTEGER".to_string(), 1, 0),
                ("last_operation_id".to_string(), "TEXT".to_string(), 0, 0),
            ]
        );

        let ledger_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoice_freshness_operations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(ledger_sql.contains(
            "PRIMARY KEY (calendar_id, output_dir, studio_name, month_key, operation_id)"
        ));
    }

    #[test]
    fn migration_adds_the_operation_ledger_idempotently_to_an_existing_database() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("freshness.sqlite");
        let output = output_dir(root.path(), "output").canonicalize().unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE invoice_freshness (
                    calendar_id TEXT NOT NULL,
                    output_dir TEXT NOT NULL,
                    studio_name TEXT NOT NULL,
                    month_key TEXT NOT NULL,
                    invoice_number TEXT NOT NULL,
                    final_filename TEXT NOT NULL,
                    stale_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    cleared_at TEXT,
                    revision INTEGER NOT NULL,
                    last_operation_id TEXT,
                    PRIMARY KEY (calendar_id, output_dir, studio_name, month_key)
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO invoice_freshness (
                    calendar_id, output_dir, studio_name, month_key, invoice_number,
                    final_filename, stale_at, reason, cleared_at, revision, last_operation_id
                 ) VALUES ('calendar', ?1, 'Yoga', '2026-01', '8/2026',
                    '8-2026-yoga-2026-01.pdf', 'earlier', 'edited', NULL, 1, 'legacy-operation')",
                [output.to_str().unwrap()],
            )
            .unwrap();
        drop(connection);

        InvoiceFreshnessStore::open(path.clone()).unwrap();
        InvoiceFreshnessStore::open(path.clone()).unwrap();

        let connection = Connection::open(path).unwrap();
        let ledger_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'invoice_freshness_operations'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
        let migrated_operation: String = connection
            .query_row(
                "SELECT operation_id FROM invoice_freshness_operations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migrated_operation, "legacy-operation");
    }

    #[test]
    fn active_rows_are_isolated_by_calendar_output_studio_and_month() {
        let root = tempfile::tempdir().unwrap();
        let output_a = output_dir(root.path(), "output-a");
        let output_b = output_dir(root.path(), "output-b");
        let store = InvoiceFreshnessStore::open(root.path().join("freshness.sqlite")).unwrap();
        let keys = [
            key("calendar-a", &output_a, "Yoga", "2026-01"),
            key("calendar-b", &output_a, "Yoga", "2026-01"),
            key("calendar-a", &output_b, "Yoga", "2026-01"),
            key("calendar-a", &output_a, "Pilates", "2026-01"),
            key("calendar-a", &output_a, "Yoga", "2026-02"),
        ];
        for (index, freshness_key) in keys.iter().cloned().enumerate() {
            store
                .mark_stale(&mark(
                    freshness_key,
                    &format!("operation-{index}"),
                    "edited",
                ))
                .unwrap();
        }

        let rows = store
            .list_active("calendar-a", output_a.to_str().unwrap())
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows.iter()
                .map(|row| (row.key.studio_name.as_str(), row.key.month_key.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("Pilates", "2026-01"),
                ("Yoga", "2026-01"),
                ("Yoga", "2026-02")
            ]
        );
        assert_eq!(
            store
                .list_active("calendar-b", output_a.to_str().unwrap())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_active("calendar-a", output_b.to_str().unwrap())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn canonical_output_path_is_stored_and_used_as_the_key() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let nested = output_dir(&output, "nested");
        let aliased = nested.join("..");
        let store = InvoiceFreshnessStore::open(root.path().join("freshness.sqlite")).unwrap();

        let row = store
            .mark_stale(&mark(
                key("calendar", &aliased, "Yoga", "2026-01"),
                "operation",
                "edited",
            ))
            .unwrap();
        assert_eq!(
            row.key.output_dir,
            output.canonicalize().unwrap().to_str().unwrap()
        );
        assert_eq!(
            store
                .list_active("calendar", output.to_str().unwrap())
                .unwrap(),
            vec![row]
        );
    }

    #[test]
    fn operation_replay_is_a_true_no_op_and_new_operation_reopens_with_new_revision() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let store = InvoiceFreshnessStore::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");

        let first = store
            .mark_stale(&mark(freshness_key.clone(), "operation-1", "first reason"))
            .unwrap();
        assert_eq!(first.revision, 1);
        let cleared = store.clear(&freshness_key, 1).unwrap();
        let ClearInvoiceFreshnessResult::Cleared { row: cleared } = cleared else {
            panic!("expected cleared result");
        };
        assert_eq!(cleared.revision, 2);
        assert!(cleared.cleared_at.is_some());

        let replayed = store
            .mark_stale(&mark(
                freshness_key.clone(),
                "operation-1",
                "replacement reason",
            ))
            .unwrap();
        assert_eq!(replayed, cleared);

        let reopened = store
            .mark_stale(&mark(freshness_key, "operation-2", "second reason"))
            .unwrap();
        assert_eq!(reopened.revision, 3);
        assert_eq!(reopened.reason, "second reason");
        assert!(reopened.cleared_at.is_none());
        assert_ne!(reopened.stale_at, first.stale_at);
    }

    #[test]
    fn an_older_operation_replay_after_a_newer_clear_cannot_resurrect_the_row() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let store = InvoiceFreshnessStore::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");

        store
            .mark_stale(&mark(freshness_key.clone(), "operation-1", "first reason"))
            .unwrap();
        let second = store
            .mark_stale(&mark(freshness_key.clone(), "operation-2", "second reason"))
            .unwrap();
        let ClearInvoiceFreshnessResult::Cleared { row: cleared } =
            store.clear(&freshness_key, second.revision).unwrap()
        else {
            panic!("expected clear");
        };

        let replayed = store
            .mark_stale(&mark(
                freshness_key.clone(),
                "operation-1",
                "replayed reason",
            ))
            .unwrap();

        assert_eq!(replayed, cleared);
        assert!(store
            .list_active("calendar", output.to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn concurrent_store_handles_record_one_durable_operation() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let path = root.path().join("freshness.sqlite");
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let barrier = Arc::new(Barrier::new(3));

        let handles = (0..2)
            .map(|_| {
                let store = InvoiceFreshnessStore::open(path.clone()).unwrap();
                let request = mark(freshness_key.clone(), "operation-1", "edited");
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    store.mark_stale(&request).unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let rows = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rows[0], rows[1]);
        assert_eq!(rows[0].revision, 1);

        let connection = Connection::open(path).unwrap();
        let ledger_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM invoice_freshness_operations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
    }

    #[test]
    fn conflicts_serialize_current_revision_in_camel_case() {
        assert_eq!(
            serde_json::to_value(ClearInvoiceFreshnessResult::Conflict {
                current_revision: 7
            })
            .unwrap(),
            serde_json::json!({ "status": "conflict", "currentRevision": 7 })
        );
        assert_eq!(
            serde_json::to_value(InvoiceFreshnessError::conflict(Some(7))).unwrap(),
            serde_json::json!({
                "code": "conflict",
                "message": "The invoice freshness record changed. Reload and try again.",
                "currentRevision": 7
            })
        );
    }

    #[test]
    fn compare_and_set_clear_rejects_an_older_revision_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let store = InvoiceFreshnessStore::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        store
            .mark_stale(&mark(freshness_key.clone(), "operation-1", "first"))
            .unwrap();
        let current = store
            .mark_stale(&mark(freshness_key.clone(), "operation-2", "second"))
            .unwrap();

        assert_eq!(
            store.clear(&freshness_key, 1).unwrap(),
            ClearInvoiceFreshnessResult::Conflict {
                current_revision: 2
            }
        );
        assert_eq!(
            store
                .list_active("calendar", output.to_str().unwrap())
                .unwrap(),
            vec![current]
        );
    }

    #[test]
    fn clearing_calendar_cache_cannot_touch_freshness() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let store =
            InvoiceFreshnessStore::open(root.path().join("invoice-freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let row = store
            .mark_stale(&mark(freshness_key, "operation", "edited"))
            .unwrap();
        let cache = CalendarStore::open(root.path().join("calendar-cache.sqlite")).unwrap();

        cache.clear_calendar("calendar").unwrap();

        assert_eq!(
            store
                .list_active("calendar", output.to_str().unwrap())
                .unwrap(),
            vec![row]
        );
    }

    #[test]
    fn mark_validates_month_filename_number_and_nonempty_fields() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let store = InvoiceFreshnessStore::open(root.path().join("freshness.sqlite")).unwrap();
        let valid_key = key("calendar", &output, "Yoga", "2026-01");

        for invalid in [
            InvoiceFreshnessMark {
                key: key("calendar", &output, "Yoga", "2026-1"),
                ..mark(valid_key.clone(), "operation-1", "edited")
            },
            InvoiceFreshnessMark {
                final_filename: "9-2026-yoga-2026-01.pdf".to_string(),
                ..mark(valid_key.clone(), "operation-2", "edited")
            },
            InvoiceFreshnessMark {
                reason: String::new(),
                ..mark(valid_key.clone(), "operation-3", "edited")
            },
        ] {
            assert_eq!(
                store.mark_stale(&invalid).unwrap_err().code,
                InvoiceFreshnessErrorCode::InvalidInput
            );
        }
    }

    #[test]
    fn email_preparation_distinguishes_file_outcomes_and_active_stale_state() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");

        assert_eq!(
            service
                .prepare_invoice_email(&freshness_key)
                .unwrap_err()
                .code,
            InvoiceFreshnessErrorCode::NotFound
        );
        write_final(&freshness_key, "8-2026-yoga-2026-01.pdf");
        let prepared = service.prepare_invoice_email(&freshness_key).unwrap();
        assert_eq!(prepared.invoice_number, "8/2026");
        assert_eq!(prepared.final_filename, "8-2026-yoga-2026-01.pdf");
        assert_eq!(prepared.pdf_bytes, b"pdf");
        let serialized = serde_json::to_value(&prepared).unwrap();
        assert!(serialized.get("pdfBytes").is_some());
        assert!(serialized.get("pdfPath").is_none());
        assert!(serialized.get("canonicalOutputDir").is_none());

        write_final(&freshness_key, "9-2026-yoga-2026-01.pdf");
        assert_eq!(
            service
                .prepare_invoice_email(&freshness_key)
                .unwrap_err()
                .code,
            InvoiceFreshnessErrorCode::Ambiguous
        );
        std::fs::remove_file(
            std::path::Path::new(&freshness_key.output_dir).join("Final/9-2026-yoga-2026-01.pdf"),
        )
        .unwrap();
        service
            .mark_stale(&mark(freshness_key.clone(), "operation", "edited"))
            .unwrap();
        assert_eq!(
            service
                .prepare_invoice_email(&freshness_key)
                .unwrap_err()
                .code,
            InvoiceFreshnessErrorCode::Stale
        );
    }

    #[test]
    fn calendar_edits_mark_only_an_existing_finalized_invoice_stale() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let january = key("calendar", &output, "Yoga", "2026-01");
        let february = key("calendar", &output, "Yoga", "2026-02");
        let missing_output = key("calendar", &root.path().join("missing"), "Yoga", "2026-03");
        write_final(&january, "8-2026-yoga-2026-01.pdf");

        let marked = service
            .mark_finalized_invoice_stale(
                &january,
                "Calendar lesson changed",
                "calendar-edit:event:etag-2",
            )
            .unwrap()
            .expect("existing finalized invoice must be marked");
        assert_eq!(marked.invoice_number, "8/2026");
        assert_eq!(marked.final_filename, "8-2026-yoga-2026-01.pdf");
        assert_eq!(marked.reason, "Calendar lesson changed");

        assert_eq!(
            service
                .mark_finalized_invoice_stale(
                    &february,
                    "Calendar lesson changed",
                    "calendar-edit:event:etag-2",
                )
                .unwrap(),
            None
        );
        assert_eq!(
            service
                .mark_finalized_invoice_stale(
                    &missing_output,
                    "Calendar lesson changed",
                    "calendar-edit:event:etag-2",
                )
                .unwrap(),
            None
        );
        assert_eq!(
            service
                .list_active("calendar", output.to_str().unwrap())
                .unwrap(),
            vec![marked]
        );
    }

    #[cfg(unix)]
    #[test]
    fn email_preparation_rejects_a_final_symlink_swap_after_strict_lookup() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let outside = output_dir(root.path(), "outside");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let filename = "8-2026-yoga-2026-01.pdf";
        write_final(&freshness_key, filename);
        std::fs::write(outside.join(filename), b"outside-pdf").unwrap();

        let error = service
            .prepare_invoice_email_with(&freshness_key, || {
                let lookup = crate::invoice_files::lookup_finalized_invoice(
                    &freshness_key.output_dir,
                    &freshness_key.studio_name,
                    "2026",
                    "01",
                );
                std::fs::rename(output.join("Final"), output.join("Final-original")).unwrap();
                symlink(&outside, output.join("Final")).unwrap();
                lookup
            })
            .unwrap_err();

        assert_eq!(error.code, InvoiceFreshnessErrorCode::Unreadable);
        assert_eq!(
            std::fs::read(outside.join(filename)).unwrap(),
            b"outside-pdf"
        );
        assert_eq!(
            std::fs::read(output.join("Final-original").join(filename)).unwrap(),
            b"pdf"
        );
    }

    #[test]
    fn email_consumption_blocks_when_another_exact_match_appears_after_lookup() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        write_final(&freshness_key, "8-2026-yoga-2026-01.pdf");

        let error = service
            .prepare_invoice_email_with(&freshness_key, || {
                let lookup = crate::invoice_files::lookup_finalized_invoice(
                    &freshness_key.output_dir,
                    &freshness_key.studio_name,
                    "2026",
                    "01",
                );
                write_final(&freshness_key, "9-2026-yoga-2026-01.pdf");
                lookup
            })
            .unwrap_err();

        assert_eq!(error.code, InvoiceFreshnessErrorCode::Ambiguous);
        assert_eq!(
            error.filenames,
            Some(vec![
                "8-2026-yoga-2026-01.pdf".to_string(),
                "9-2026-yoga-2026-01.pdf".to_string(),
            ])
        );
    }

    #[test]
    fn email_consumption_reports_not_found_when_the_expected_match_is_removed_after_lookup() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let filename = "8-2026-yoga-2026-01.pdf";
        write_final(&freshness_key, filename);

        let error = service
            .prepare_invoice_email_with(&freshness_key, || {
                let lookup = crate::invoice_files::lookup_finalized_invoice(
                    &freshness_key.output_dir,
                    &freshness_key.studio_name,
                    "2026",
                    "01",
                );
                std::fs::remove_file(output.join("Final").join(filename)).unwrap();
                lookup
            })
            .unwrap_err();

        assert_eq!(error.code, InvoiceFreshnessErrorCode::NotFound);
    }

    #[test]
    fn email_consumption_reports_not_found_when_the_expected_match_is_renamed_after_lookup() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let filename = "8-2026-yoga-2026-01.pdf";
        write_final(&freshness_key, filename);

        let error = service
            .prepare_invoice_email_with(&freshness_key, || {
                let lookup = crate::invoice_files::lookup_finalized_invoice(
                    &freshness_key.output_dir,
                    &freshness_key.studio_name,
                    "2026",
                    "01",
                );
                std::fs::rename(
                    output.join("Final").join(filename),
                    output.join("Final").join("renamed.pdf"),
                )
                .unwrap();
                lookup
            })
            .unwrap_err();

        assert_eq!(error.code, InvoiceFreshnessErrorCode::NotFound);
    }

    #[test]
    fn email_consumption_reports_unreadable_when_final_stops_being_a_directory_after_lookup() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        write_final(&freshness_key, "8-2026-yoga-2026-01.pdf");

        let error = service
            .prepare_invoice_email_with(&freshness_key, || {
                let lookup = crate::invoice_files::lookup_finalized_invoice(
                    &freshness_key.output_dir,
                    &freshness_key.studio_name,
                    "2026",
                    "01",
                );
                std::fs::rename(output.join("Final"), output.join("Final-original")).unwrap();
                std::fs::write(output.join("Final"), b"not a directory").unwrap();
                lookup
            })
            .unwrap_err();

        assert_eq!(error.code, InvoiceFreshnessErrorCode::Unreadable);
    }

    #[test]
    fn unreadable_file_state_and_refinalization_conflicts_are_typed() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        service
            .mark_stale(&mark(freshness_key.clone(), "operation", "edited"))
            .unwrap();

        assert_eq!(
            service
                .prepare_re_finalization(&freshness_key, 0)
                .unwrap_err()
                .code,
            InvoiceFreshnessErrorCode::Conflict
        );
        std::fs::write(output.join("Final"), b"not a directory").unwrap();
        assert_eq!(
            service
                .prepare_re_finalization(&freshness_key, 1)
                .unwrap_err()
                .code,
            InvoiceFreshnessErrorCode::Unreadable
        );
    }

    #[test]
    fn strict_refinalization_reuses_the_recorded_exact_file_and_number() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let row = service
            .mark_stale(&mark(freshness_key.clone(), "operation", "edited"))
            .unwrap();
        write_final(&freshness_key, &row.final_filename);

        let prepared = service
            .prepare_re_finalization(&freshness_key, row.revision)
            .unwrap();
        assert_eq!(prepared.invoice_number, row.invoice_number);
        assert_eq!(prepared.final_filename, row.final_filename);
        assert_eq!(prepared.freshness_revision, row.revision);
        let serialized = serde_json::to_value(&prepared).unwrap();
        assert!(serialized.get("pdfPath").is_none());
        assert!(serialized.get("canonicalOutputDir").is_none());
    }

    #[test]
    fn guarded_refinalization_writes_the_recorded_file_then_clears_the_exact_revision() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2025-11");
        let stale = service
            .mark_stale(&InvoiceFreshnessMark {
                key: freshness_key.clone(),
                invoice_number: "42/2025".to_string(),
                final_filename: "42-2025-yoga-2025-11.pdf".to_string(),
                reason: "edited".to_string(),
                operation_id: Some("operation".to_string()),
            })
            .unwrap();
        write_final(&freshness_key, &stale.final_filename);
        let prepared = service
            .prepare_re_finalization(&freshness_key, stale.revision)
            .unwrap();

        let result = service
            .write_re_finalized_invoice(&write_request(&prepared, b"replacement-pdf"))
            .unwrap();

        assert_eq!(
            result,
            WriteReFinalizedInvoiceResult::Written {
                output_path: std::path::Path::new(&prepared.key.output_dir)
                    .join("Final/42-2025-yoga-2025-11.pdf")
                    .to_str()
                    .unwrap()
                    .to_string(),
                filename: "42-2025-yoga-2025-11.pdf".to_string(),
            }
        );
        assert_eq!(
            std::fs::read(output.join("Final/42-2025-yoga-2025-11.pdf")).unwrap(),
            b"replacement-pdf"
        );
        assert!(service
            .list_active("calendar", output.to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn guarded_refinalization_rejects_changed_file_and_keeps_freshness_active() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service = InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap();
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        let stale = service
            .mark_stale(&mark(freshness_key.clone(), "operation", "edited"))
            .unwrap();
        write_final(&freshness_key, &stale.final_filename);
        let prepared = service
            .prepare_re_finalization(&freshness_key, stale.revision)
            .unwrap();
        std::fs::write(
            output.join("Final").join(&stale.final_filename),
            b"changed-after-prepare",
        )
        .unwrap();

        let error = service
            .write_re_finalized_invoice(&write_request(&prepared, b"replacement-pdf"))
            .unwrap_err();

        assert_eq!(error.code, InvoiceFreshnessErrorCode::Conflict);
        assert_eq!(
            std::fs::read(output.join("Final").join(&stale.final_filename)).unwrap(),
            b"changed-after-prepare"
        );
        assert_eq!(
            service
                .list_active("calendar", output.to_str().unwrap())
                .unwrap(),
            vec![stale]
        );
    }

    #[test]
    fn email_preparation_and_stale_mark_are_linearized_by_one_service_gate() {
        let root = tempfile::tempdir().unwrap();
        let output = output_dir(root.path(), "output");
        let service =
            Arc::new(InvoiceFreshnessService::open(root.path().join("freshness.sqlite")).unwrap());
        let freshness_key = key("calendar", &output, "Yoga", "2026-01");
        write_final(&freshness_key, "8-2026-yoga-2026-01.pdf");
        let lookup_entered = Arc::new(Barrier::new(2));
        let release_lookup = Arc::new(Barrier::new(2));

        let prepare_thread = {
            let service = Arc::clone(&service);
            let freshness_key = freshness_key.clone();
            let lookup_entered = Arc::clone(&lookup_entered);
            let release_lookup = Arc::clone(&release_lookup);
            std::thread::spawn(move || {
                service.prepare_invoice_email_with(&freshness_key, || {
                    lookup_entered.wait();
                    release_lookup.wait();
                    crate::invoice_files::lookup_finalized_invoice(
                        &freshness_key.output_dir,
                        &freshness_key.studio_name,
                        "2026",
                        "01",
                    )
                })
            })
        };
        lookup_entered.wait();

        let (started_tx, started_rx) = mpsc::channel();
        let (marked_tx, marked_rx) = mpsc::channel();
        let mark_thread = {
            let service = Arc::clone(&service);
            let request = mark(freshness_key, "operation", "edited");
            std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                let result = service.mark_stale(&request);
                marked_tx.send(result).unwrap();
            })
        };
        started_rx.recv().unwrap();
        assert!(matches!(
            marked_rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));

        release_lookup.wait();
        assert!(prepare_thread.join().unwrap().is_ok());
        assert!(marked_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        mark_thread.join().unwrap();
    }
}
