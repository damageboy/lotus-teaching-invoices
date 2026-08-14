use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use std::{collections::BTreeMap, error::Error as StdError, fmt, path::PathBuf};

pub const EVENT_IDENTITY_SCHEMA_VERSION: i64 = 1;
const DATABASE_SCHEMA_VERSION: i64 = 2;

#[derive(Debug)]
pub enum CalendarStoreError {
    Database(Box<rusqlite::Error>),
    StageNotActive {
        stage_id: i64,
        calendar_id: String,
    },
    SyncStateChanged {
        calendar_id: String,
    },
    IncrementalEventWrongCalendar {
        calendar_id: String,
        event_id: String,
        event_calendar_id: String,
    },
    InvalidFullSyncToken,
    InvalidExpectedSyncToken,
    InvalidIncrementalSyncToken,
    InvalidSyncedAt,
}

impl fmt::Display for CalendarStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => error.fmt(formatter),
            Self::StageNotActive {
                stage_id,
                calendar_id,
            } => write!(
                formatter,
                "staged full sync {stage_id} is not active for calendar {calendar_id}"
            ),
            Self::SyncStateChanged { calendar_id } => {
                write!(formatter, "calendar sync state changed for {calendar_id}")
            }
            Self::IncrementalEventWrongCalendar {
                calendar_id,
                event_id,
                event_calendar_id,
            } => write!(
                formatter,
                "incremental event {event_id} belongs to calendar {event_calendar_id}, not {calendar_id}"
            ),
            Self::InvalidFullSyncToken => write!(formatter, "full sync token must not be empty"),
            Self::InvalidExpectedSyncToken => {
                write!(formatter, "expected sync token must not be empty")
            }
            Self::InvalidIncrementalSyncToken => {
                write!(formatter, "incremental sync token must not be empty")
            }
            Self::InvalidSyncedAt => write!(formatter, "sync timestamp must not be empty"),
        }
    }
}

impl StdError for CalendarStoreError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Database(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for CalendarStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(Box::new(error))
    }
}

pub type CalendarStoreResult<T> = Result<T, CalendarStoreError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCalendarEvent {
    pub calendar_id: String,
    pub event_id: String,
    pub recurring_event_id: Option<String>,
    pub original_start_time: Option<String>,
    pub etag: Option<String>,
    pub summary: String,
    pub description: String,
    pub start_ts: String,
    pub end_ts: String,
    pub updated_ts: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncrementalEventChange {
    Upsert(Box<StoredCalendarEvent>),
    Delete(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalendarStoreSyncStats {
    pub upserted: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarSyncState {
    pub calendar_id: String,
    pub sync_token: Option<String>,
    pub last_synced_at: String,
    pub last_full_sync_at: Option<String>,
    pub identity_schema_version: i64,
}

pub struct CalendarStore {
    path: PathBuf,
}

impl CalendarStore {
    pub fn open(path: PathBuf) -> rusqlite::Result<Self> {
        let store = Self { path };
        store.migrate()?;
        Ok(store)
    }

    fn connect(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        Ok(conn)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS calendar_sync_state (
              calendar_id TEXT PRIMARY KEY NOT NULL,
              sync_token TEXT,
              last_synced_at TEXT NOT NULL,
              last_full_sync_at TEXT
            );

            CREATE TABLE IF NOT EXISTS calendar_events (
              calendar_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              summary TEXT NOT NULL,
              description TEXT NOT NULL,
              start_ts TEXT NOT NULL,
              end_ts TEXT NOT NULL,
              updated_ts TEXT,
              status TEXT NOT NULL,
              PRIMARY KEY (calendar_id, event_id)
            );
            ",
        )?;

        let user_version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let event_identity_columns = [
            ("recurring_event_id", "TEXT"),
            ("original_start_time", "TEXT"),
            ("etag", "TEXT"),
        ];
        for (column, definition) in event_identity_columns {
            if !Self::column_exists(&tx, "calendar_events", column)? {
                tx.execute(
                    &format!("ALTER TABLE calendar_events ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        if !Self::column_exists(&tx, "calendar_sync_state", "identity_schema_version")? {
            tx.execute(
                "ALTER TABLE calendar_sync_state
                 ADD COLUMN identity_schema_version INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !Self::staging_schema_is_current(&tx)? {
            tx.execute_batch(
                "
                DROP TABLE IF EXISTS calendar_events_staging;
                DROP TABLE IF EXISTS calendar_full_sync_stages;
                ",
            )?;
        }
        tx.execute_batch(Self::staging_schema_sql())?;
        if user_version < DATABASE_SCHEMA_VERSION {
            tx.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            if row.get::<_, String>(1)? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
    }

    fn has_unique_index(
        conn: &Connection,
        table: &str,
        expected_columns: &[&str],
    ) -> rusqlite::Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA index_list({table})"))?;
        let indexes = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, bool>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (index_name, unique) in indexes {
            if !unique {
                continue;
            }
            let escaped_name = index_name.replace('"', "\"\"");
            let mut index_stmt = conn.prepare(&format!("PRAGMA index_info(\"{escaped_name}\")"))?;
            let columns = index_stmt
                .query_map([], |row| row.get::<_, String>(2))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if columns
                .iter()
                .map(String::as_str)
                .eq(expected_columns.iter().copied())
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn has_staging_foreign_key(conn: &Connection) -> rusqlite::Result<bool> {
        let mut stmt = conn.prepare("PRAGMA foreign_key_list(calendar_events_staging)")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.iter().any(|first| {
            first.1 == 0
                && first.2 == "calendar_full_sync_stages"
                && first.3 == "stage_id"
                && first.4 == "stage_id"
                && first.5.eq_ignore_ascii_case("cascade")
                && rows.iter().any(|second| {
                    second.0 == first.0
                        && second.1 == 1
                        && second.2 == "calendar_full_sync_stages"
                        && second.3 == "calendar_id"
                        && second.4 == "calendar_id"
                        && second.5.eq_ignore_ascii_case("cascade")
                })
        }))
    }

    fn staging_schema_is_current(conn: &Connection) -> rusqlite::Result<bool> {
        if !Self::table_exists(conn, "calendar_full_sync_stages")?
            || !Self::table_exists(conn, "calendar_events_staging")?
        {
            return Ok(false);
        }
        Ok(
            Self::has_unique_index(conn, "calendar_full_sync_stages", &["calendar_id"])?
                && Self::has_unique_index(
                    conn,
                    "calendar_full_sync_stages",
                    &["stage_id", "calendar_id"],
                )?
                && Self::has_staging_foreign_key(conn)?,
        )
    }

    fn staging_schema_sql() -> &'static str {
        "
        CREATE TABLE IF NOT EXISTS calendar_full_sync_stages (
          stage_id INTEGER PRIMARY KEY AUTOINCREMENT,
          calendar_id TEXT NOT NULL UNIQUE,
          UNIQUE (stage_id, calendar_id)
        );

        CREATE TABLE IF NOT EXISTS calendar_events_staging (
          stage_id INTEGER NOT NULL,
          calendar_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          recurring_event_id TEXT,
          original_start_time TEXT,
          etag TEXT,
          summary TEXT NOT NULL,
          description TEXT NOT NULL,
          start_ts TEXT NOT NULL,
          end_ts TEXT NOT NULL,
          updated_ts TEXT,
          status TEXT NOT NULL,
          PRIMARY KEY (stage_id, event_id),
          FOREIGN KEY (stage_id, calendar_id)
            REFERENCES calendar_full_sync_stages (stage_id, calendar_id)
            ON DELETE CASCADE
        );
        "
    }

    fn stored_event_from_row(row: &Row<'_>) -> rusqlite::Result<StoredCalendarEvent> {
        Ok(StoredCalendarEvent {
            calendar_id: row.get(0)?,
            event_id: row.get(1)?,
            recurring_event_id: row.get(2)?,
            original_start_time: row.get(3)?,
            etag: row.get(4)?,
            summary: row.get(5)?,
            description: row.get(6)?,
            start_ts: row.get(7)?,
            end_ts: row.get(8)?,
            updated_ts: row.get(9)?,
            status: row.get(10)?,
        })
    }

    pub fn list_events(&self, calendar_id: &str) -> rusqlite::Result<Vec<StoredCalendarEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "
            SELECT calendar_id, event_id, recurring_event_id, original_start_time, etag,
                   summary, description, start_ts, end_ts, updated_ts, status
            FROM calendar_events
            WHERE calendar_id = ?
            ORDER BY start_ts ASC, event_id ASC
            ",
        )?;
        let rows = stmt.query_map([calendar_id], Self::stored_event_from_row)?;
        rows.collect()
    }

    pub fn event(
        &self,
        calendar_id: &str,
        event_id: &str,
    ) -> rusqlite::Result<Option<StoredCalendarEvent>> {
        let conn = self.connect()?;
        conn.query_row(
            "
            SELECT calendar_id, event_id, recurring_event_id, original_start_time, etag,
                   summary, description, start_ts, end_ts, updated_ts, status
            FROM calendar_events
            WHERE calendar_id = ? AND event_id = ?
            ",
            params![calendar_id, event_id],
            Self::stored_event_from_row,
        )
        .optional()
    }

    pub fn list_series_instances(
        &self,
        calendar_id: &str,
        recurring_event_id: &str,
    ) -> rusqlite::Result<Vec<StoredCalendarEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "
            SELECT calendar_id, event_id, recurring_event_id, original_start_time, etag,
                   summary, description, start_ts, end_ts, updated_ts, status
            FROM calendar_events
            WHERE calendar_id = ? AND recurring_event_id = ?
            ORDER BY start_ts ASC, event_id ASC
            ",
        )?;
        let rows = stmt.query_map(
            params![calendar_id, recurring_event_id],
            Self::stored_event_from_row,
        )?;
        rows.collect()
    }

    pub fn upsert_event(&self, event: &StoredCalendarEvent) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "
            INSERT INTO calendar_events (
              calendar_id, event_id, recurring_event_id, original_start_time, etag,
              summary, description, start_ts, end_ts, updated_ts, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(calendar_id, event_id) DO UPDATE SET
              recurring_event_id = excluded.recurring_event_id,
              original_start_time = excluded.original_start_time,
              etag = excluded.etag,
              summary = excluded.summary,
              description = excluded.description,
              start_ts = excluded.start_ts,
              end_ts = excluded.end_ts,
              updated_ts = excluded.updated_ts,
              status = excluded.status
            ",
            params![
                event.calendar_id,
                event.event_id,
                event.recurring_event_id,
                event.original_start_time,
                event.etag,
                event.summary,
                event.description,
                event.start_ts,
                event.end_ts,
                event.updated_ts,
                event.status
            ],
        )?;
        Ok(())
    }

    pub fn begin_staged_full_sync(&self, calendar_id: &str) -> rusqlite::Result<i64> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM calendar_full_sync_stages WHERE calendar_id = ?",
            [calendar_id],
        )?;
        tx.execute(
            "INSERT INTO calendar_full_sync_stages (calendar_id) VALUES (?)",
            [calendar_id],
        )?;
        let stage_id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(stage_id)
    }

    pub fn stage_event(
        &self,
        stage_id: i64,
        event: &StoredCalendarEvent,
    ) -> CalendarStoreResult<()> {
        let conn = self.connect()?;
        let changed = conn.execute(
            "
            INSERT INTO calendar_events_staging (
              stage_id, calendar_id, event_id, recurring_event_id, original_start_time, etag,
              summary, description, start_ts, end_ts, updated_ts, status
            )
            SELECT ?, stage.calendar_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM calendar_full_sync_stages AS stage
            WHERE stage.stage_id = ? AND stage.calendar_id = ?
            ON CONFLICT(stage_id, event_id) DO UPDATE SET
              recurring_event_id = excluded.recurring_event_id,
              original_start_time = excluded.original_start_time,
              etag = excluded.etag,
              summary = excluded.summary,
              description = excluded.description,
              start_ts = excluded.start_ts,
              end_ts = excluded.end_ts,
              updated_ts = excluded.updated_ts,
              status = excluded.status
            ",
            params![
                stage_id,
                event.event_id,
                event.recurring_event_id,
                event.original_start_time,
                event.etag,
                event.summary,
                event.description,
                event.start_ts,
                event.end_ts,
                event.updated_ts,
                event.status,
                stage_id,
                event.calendar_id
            ],
        )?;
        if changed != 1 {
            return Err(CalendarStoreError::StageNotActive {
                stage_id,
                calendar_id: event.calendar_id.clone(),
            });
        }
        Ok(())
    }

    pub fn discard_staged_full_sync(&self, stage_id: i64) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM calendar_full_sync_stages WHERE stage_id = ?",
            [stage_id],
        )?;
        Ok(())
    }

    pub fn commit_staged_full_sync(
        &self,
        stage_id: i64,
        calendar_id: &str,
        next_sync_token: &str,
        synced_at: &str,
    ) -> CalendarStoreResult<CalendarStoreSyncStats> {
        if next_sync_token.trim().is_empty() {
            return Err(CalendarStoreError::InvalidFullSyncToken);
        }
        if synced_at.trim().is_empty() {
            return Err(CalendarStoreError::InvalidSyncedAt);
        }
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stage_calendar: Option<String> = tx
            .query_row(
                "SELECT calendar_id FROM calendar_full_sync_stages WHERE stage_id = ?",
                [stage_id],
                |row| row.get(0),
            )
            .optional()?;
        if stage_calendar.as_deref() != Some(calendar_id) {
            return Err(CalendarStoreError::StageNotActive {
                stage_id,
                calendar_id: calendar_id.to_string(),
            });
        }

        let upserted = tx.query_row(
            "SELECT COUNT(*) FROM calendar_events_staging
             WHERE stage_id = ? AND calendar_id = ?",
            params![stage_id, calendar_id],
            |row| row.get(0),
        )?;
        let deleted = tx.query_row(
            "
            SELECT COUNT(*)
            FROM calendar_events AS live
            WHERE live.calendar_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM calendar_events_staging AS staged
                WHERE staged.stage_id = ?
                  AND staged.calendar_id = ?
                  AND staged.event_id = live.event_id
              )
            ",
            params![calendar_id, stage_id, calendar_id],
            |row| row.get(0),
        )?;

        tx.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ?",
            [calendar_id],
        )?;
        tx.execute(
            "
            INSERT INTO calendar_events (
              calendar_id, event_id, recurring_event_id, original_start_time, etag,
              summary, description, start_ts, end_ts, updated_ts, status
            )
            SELECT calendar_id, event_id, recurring_event_id, original_start_time, etag,
                   summary, description, start_ts, end_ts, updated_ts, status
            FROM calendar_events_staging
            WHERE stage_id = ? AND calendar_id = ?
            ",
            params![stage_id, calendar_id],
        )?;
        tx.execute(
            "
            INSERT INTO calendar_sync_state (
              calendar_id, sync_token, last_synced_at, last_full_sync_at,
              identity_schema_version
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(calendar_id) DO UPDATE SET
              sync_token = excluded.sync_token,
              last_synced_at = excluded.last_synced_at,
              last_full_sync_at = excluded.last_full_sync_at,
              identity_schema_version = excluded.identity_schema_version
            ",
            params![
                calendar_id,
                next_sync_token,
                synced_at,
                synced_at,
                EVENT_IDENTITY_SCHEMA_VERSION
            ],
        )?;
        tx.execute(
            "DELETE FROM calendar_events_staging WHERE stage_id = ?",
            [stage_id],
        )?;
        tx.execute(
            "DELETE FROM calendar_full_sync_stages WHERE stage_id = ?",
            [stage_id],
        )?;
        tx.commit()?;
        Ok(CalendarStoreSyncStats { upserted, deleted })
    }

    #[cfg(test)]
    pub fn delete_event(&self, calendar_id: &str, event_id: &str) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ? AND event_id = ?",
            params![calendar_id, event_id],
        )?;
        Ok(())
    }

    pub fn clear_calendar(&self, calendar_id: &str) -> rusqlite::Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM calendar_full_sync_stages WHERE calendar_id = ?",
            [calendar_id],
        )?;
        tx.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ?",
            [calendar_id],
        )?;
        tx.execute(
            "DELETE FROM calendar_sync_state WHERE calendar_id = ?",
            [calendar_id],
        )?;
        tx.commit()
    }

    pub fn sync_state(&self, calendar_id: &str) -> rusqlite::Result<Option<CalendarSyncState>> {
        let conn = self.connect()?;
        conn.query_row(
            "
            SELECT calendar_id, sync_token, last_synced_at, last_full_sync_at,
                   identity_schema_version
            FROM calendar_sync_state
            WHERE calendar_id = ?
            ",
            [calendar_id],
            |row| {
                Ok(CalendarSyncState {
                    calendar_id: row.get(0)?,
                    sync_token: row.get(1)?,
                    last_synced_at: row.get(2)?,
                    last_full_sync_at: row.get(3)?,
                    identity_schema_version: row.get(4)?,
                })
            },
        )
        .optional()
    }

    pub fn apply_incremental_sync(
        &self,
        calendar_id: &str,
        expected_sync_token: &str,
        changes: &[IncrementalEventChange],
        next_sync_token: &str,
        synced_at: &str,
    ) -> CalendarStoreResult<CalendarStoreSyncStats> {
        if expected_sync_token.trim().is_empty() {
            return Err(CalendarStoreError::InvalidExpectedSyncToken);
        }
        if next_sync_token.trim().is_empty() {
            return Err(CalendarStoreError::InvalidIncrementalSyncToken);
        }
        if synced_at.trim().is_empty() {
            return Err(CalendarStoreError::InvalidSyncedAt);
        }

        let mut final_changes = BTreeMap::new();
        for change in changes {
            let event_id = match change {
                IncrementalEventChange::Upsert(event) => {
                    if event.calendar_id != calendar_id {
                        return Err(CalendarStoreError::IncrementalEventWrongCalendar {
                            calendar_id: calendar_id.to_string(),
                            event_id: event.event_id.clone(),
                            event_calendar_id: event.calendar_id.clone(),
                        });
                    }
                    event.event_id.as_str()
                }
                IncrementalEventChange::Delete(event_id) => event_id.as_str(),
            };
            final_changes.insert(event_id, change);
        }

        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current_token: Option<String> = tx
            .query_row(
                "SELECT sync_token FROM calendar_sync_state WHERE calendar_id = ?",
                [calendar_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if current_token.as_deref() != Some(expected_sync_token) {
            return Err(CalendarStoreError::SyncStateChanged {
                calendar_id: calendar_id.to_string(),
            });
        }

        let mut stats = CalendarStoreSyncStats {
            upserted: 0,
            deleted: 0,
        };
        for change in final_changes.values() {
            match change {
                IncrementalEventChange::Upsert(event) => {
                    tx.execute(
                        "
                        INSERT INTO calendar_events (
                          calendar_id, event_id, recurring_event_id, original_start_time, etag,
                          summary, description, start_ts, end_ts, updated_ts, status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(calendar_id, event_id) DO UPDATE SET
                          recurring_event_id = excluded.recurring_event_id,
                          original_start_time = excluded.original_start_time,
                          etag = excluded.etag,
                          summary = excluded.summary,
                          description = excluded.description,
                          start_ts = excluded.start_ts,
                          end_ts = excluded.end_ts,
                          updated_ts = excluded.updated_ts,
                          status = excluded.status
                        ",
                        params![
                            event.calendar_id,
                            event.event_id,
                            event.recurring_event_id,
                            event.original_start_time,
                            event.etag,
                            event.summary,
                            event.description,
                            event.start_ts,
                            event.end_ts,
                            event.updated_ts,
                            event.status
                        ],
                    )?;
                    stats.upserted += 1;
                }
                IncrementalEventChange::Delete(event_id) => {
                    stats.deleted += tx.execute(
                        "DELETE FROM calendar_events WHERE calendar_id = ? AND event_id = ?",
                        params![calendar_id, event_id],
                    )?;
                }
            }
        }
        let updated = tx.execute(
            "
            UPDATE calendar_sync_state
            SET sync_token = ?, last_synced_at = ?
            WHERE calendar_id = ? AND sync_token = ?
            ",
            params![next_sync_token, synced_at, calendar_id, expected_sync_token],
        )?;
        if updated != 1 {
            return Err(CalendarStoreError::SyncStateChanged {
                calendar_id: calendar_id.to_string(),
            });
        }
        tx.commit()?;
        Ok(stats)
    }

    #[cfg(test)]
    pub fn replace_sync_state(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        synced_at: &str,
        full_sync: bool,
    ) -> rusqlite::Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(Option<String>, i64)> = tx
            .query_row(
                "SELECT last_full_sync_at, identity_schema_version
                 FROM calendar_sync_state WHERE calendar_id = ?",
                [calendar_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let last_full_sync_at = if full_sync {
            Some(synced_at.to_string())
        } else {
            existing
                .as_ref()
                .and_then(|(timestamp, _)| timestamp.clone())
        };
        let identity_schema_version = if full_sync {
            EVENT_IDENTITY_SCHEMA_VERSION
        } else {
            existing.map(|(_, version)| version).unwrap_or_default()
        };
        tx.execute(
            "
            INSERT INTO calendar_sync_state (
              calendar_id, sync_token, last_synced_at, last_full_sync_at,
              identity_schema_version
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(calendar_id) DO UPDATE SET
              sync_token = excluded.sync_token,
              last_synced_at = excluded.last_synced_at,
              last_full_sync_at = excluded.last_full_sync_at,
              identity_schema_version = excluded.identity_schema_version
            ",
            params![
                calendar_id,
                sync_token,
                synced_at,
                last_full_sync_at,
                identity_schema_version
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_store() -> (tempfile::TempDir, CalendarStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        (dir, store)
    }

    fn two_stores() -> (tempfile::TempDir, CalendarStore, CalendarStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar-cache.sqlite");
        let first = CalendarStore::open(path.clone()).unwrap();
        let second = CalendarStore::open(path).unwrap();
        (dir, first, second)
    }

    fn event(id: &str, summary: &str) -> StoredCalendarEvent {
        StoredCalendarEvent {
            calendar_id: "cal-1".to_string(),
            event_id: id.to_string(),
            recurring_event_id: None,
            original_start_time: None,
            etag: None,
            summary: summary.to_string(),
            description: "8".to_string(),
            start_ts: "2026-01-10T09:00:00+01:00".to_string(),
            end_ts: "2026-01-10T10:00:00+01:00".to_string(),
            updated_ts: Some("2026-01-09T12:00:00.000Z".to_string()),
            status: "confirmed".to_string(),
        }
    }

    fn create_legacy_database(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "
            CREATE TABLE calendar_sync_state (
              calendar_id TEXT PRIMARY KEY NOT NULL,
              sync_token TEXT,
              last_synced_at TEXT NOT NULL,
              last_full_sync_at TEXT
            );

            CREATE TABLE calendar_events (
              calendar_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              summary TEXT NOT NULL,
              description TEXT NOT NULL,
              start_ts TEXT NOT NULL,
              end_ts TEXT NOT NULL,
              updated_ts TEXT,
              status TEXT NOT NULL,
              PRIMARY KEY (calendar_id, event_id)
            );

            INSERT INTO calendar_sync_state (
              calendar_id, sync_token, last_synced_at, last_full_sync_at
            ) VALUES (
              'legacy-cal', 'legacy-token', '2026-01-11T00:00:00Z',
              '2026-01-10T00:00:00Z'
            );

            INSERT INTO calendar_events (
              calendar_id, event_id, summary, description, start_ts, end_ts, updated_ts, status
            ) VALUES (
              'legacy-cal', 'legacy-event', 'Studio A / Flow', '8',
              '2026-01-10T09:00:00+01:00', '2026-01-10T10:00:00+01:00',
              '2026-01-09T12:00:00.000Z', 'confirmed'
            );
            ",
        )
        .unwrap();
    }

    fn table_columns(path: &Path, table: &str) -> Vec<String> {
        let conn = Connection::open(path).unwrap();
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        stmt.query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn migration_adds_identity_columns_without_losing_legacy_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar-cache.sqlite");
        create_legacy_database(&path);

        let store = CalendarStore::open(path.clone()).unwrap();

        let event_columns = table_columns(&path, "calendar_events");
        assert!(event_columns.contains(&"recurring_event_id".to_string()));
        assert!(event_columns.contains(&"original_start_time".to_string()));
        assert!(event_columns.contains(&"etag".to_string()));
        let sync_columns = table_columns(&path, "calendar_sync_state");
        assert!(sync_columns.contains(&"identity_schema_version".to_string()));

        let events = store.list_events("legacy-cal").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, "legacy-event");
        assert_eq!(events[0].summary, "Studio A / Flow");
        assert_eq!(events[0].recurring_event_id, None);
        assert_eq!(events[0].original_start_time, None);
        assert_eq!(events[0].etag, None);

        let state = store.sync_state("legacy-cal").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("legacy-token"));
        assert_eq!(state.identity_schema_version, 0);
    }

    #[test]
    fn migration_identity_fields_round_trip() {
        let (_dir, store) = test_store();
        let mut recurring = event("instance-1", "Studio A / Flow");
        recurring.recurring_event_id = Some("series-1".to_string());
        recurring.original_start_time = Some("2026-01-10T09:00:00+01:00".to_string());
        recurring.etag = Some("etag-1".to_string());

        store.upsert_event(&recurring).unwrap();

        assert_eq!(store.list_events("cal-1").unwrap(), vec![recurring]);
    }

    #[test]
    fn migration_repeated_open_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar-cache.sqlite");
        create_legacy_database(&path);

        CalendarStore::open(path.clone()).unwrap();
        let store = CalendarStore::open(path.clone()).unwrap();

        let event_columns = table_columns(&path, "calendar_events");
        assert_eq!(
            event_columns
                .iter()
                .filter(|column| column.as_str() == "recurring_event_id")
                .count(),
            1
        );
        assert_eq!(store.list_events("legacy-cal").unwrap().len(), 1);
        let conn = Connection::open(path).unwrap();
        let user_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(user_version, DATABASE_SCHEMA_VERSION);
    }

    #[test]
    fn migration_preserves_newer_user_version_while_repairing_missing_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar-cache.sqlite");
        create_legacy_database(&path);
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 7).unwrap();
        drop(conn);

        CalendarStore::open(path.clone()).unwrap();

        assert!(table_columns(&path, "calendar_events").contains(&"etag".to_string()));
        let conn = Connection::open(path).unwrap();
        let user_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(user_version, 7);
    }

    #[test]
    fn migration_invalidates_legacy_stages_before_adding_ownership_constraints() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar-cache.sqlite");
        create_legacy_database(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "
            CREATE TABLE calendar_full_sync_stages (
              stage_id INTEGER PRIMARY KEY AUTOINCREMENT,
              calendar_id TEXT NOT NULL
            );
            CREATE TABLE calendar_events_staging (
              stage_id INTEGER NOT NULL,
              calendar_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              recurring_event_id TEXT,
              original_start_time TEXT,
              etag TEXT,
              summary TEXT NOT NULL,
              description TEXT NOT NULL,
              start_ts TEXT NOT NULL,
              end_ts TEXT NOT NULL,
              updated_ts TEXT,
              status TEXT NOT NULL,
              PRIMARY KEY(stage_id, event_id)
            );
            INSERT INTO calendar_full_sync_stages (calendar_id) VALUES ('legacy-cal');
            INSERT INTO calendar_events_staging (
              stage_id, calendar_id, event_id, summary, description,
              start_ts, end_ts, status
            ) VALUES (
              1, 'legacy-cal', 'staged-event', 'Studio A / Staged', '8',
              '2026-01-10T09:00:00+01:00', '2026-01-10T10:00:00+01:00',
              'confirmed'
            );
            PRAGMA user_version = 1;
            ",
        )
        .unwrap();
        drop(conn);

        CalendarStore::open(path.clone()).unwrap();

        let conn = Connection::open(path).unwrap();
        let stages: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_full_sync_stages",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let staged_events: i64 = conn
            .query_row("SELECT COUNT(*) FROM calendar_events_staging", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((stages, staged_events), (0, 0));
    }

    #[test]
    fn staged_full_sync_events_stay_hidden_until_commit() {
        let (_dir, store) = test_store();
        store
            .upsert_event(&event("live-event", "Studio A / Live"))
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();

        let events = store.list_events("cal-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, "live-event");
    }

    #[test]
    fn stage_event_rejects_an_event_from_another_calendar() {
        let (_dir, store) = test_store();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        let mut wrong_calendar = event("staged-event", "Studio B / Staged");
        wrong_calendar.calendar_id = "cal-2".to_string();

        let error = store.stage_event(stage_id, &wrong_calendar).unwrap_err();
        assert!(matches!(
            error,
            CalendarStoreError::StageNotActive {
                stage_id: actual_stage_id,
                ref calendar_id,
            } if actual_stage_id == stage_id && calendar_id == "cal-2"
        ));
    }

    #[test]
    fn competing_stage_invalidates_the_older_stage_across_store_instances() {
        let (_dir, first, second) = two_stores();
        first
            .upsert_event(&event("live-event", "Studio A / Live"))
            .unwrap();
        first
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let old_stage_id = first.begin_staged_full_sync("cal-1").unwrap();
        first
            .stage_event(old_stage_id, &event("old-stage", "Studio A / Old stage"))
            .unwrap();

        let current_stage_id = second.begin_staged_full_sync("cal-1").unwrap();

        assert_ne!(old_stage_id, current_stage_id);
        assert!(first
            .stage_event(old_stage_id, &event("late-event", "Studio A / Late"))
            .is_err());
        assert!(first
            .commit_staged_full_sync(old_stage_id, "cal-1", "stale-token", "stale-sync",)
            .is_err());
        let replacement = event("new-event", "Studio A / Current");
        second.stage_event(current_stage_id, &replacement).unwrap();
        second
            .commit_staged_full_sync(current_stage_id, "cal-1", "current-token", "current-sync")
            .unwrap();
        assert_eq!(first.list_events("cal-1").unwrap(), vec![replacement]);
        assert_eq!(
            first
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("current-token")
        );
    }

    #[test]
    fn discard_then_stage_reports_that_the_stage_is_no_longer_active() {
        let (_dir, first, second) = two_stores();
        let stage_id = first.begin_staged_full_sync("cal-1").unwrap();

        second.discard_staged_full_sync(stage_id).unwrap();
        let error = first
            .stage_event(stage_id, &event("late-event", "Studio A / Late"))
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarStoreError::StageNotActive {
                stage_id: actual_stage_id,
                ref calendar_id,
            } if actual_stage_id == stage_id && calendar_id == "cal-1"
        ));
        assert!(error.to_string().contains("not active for calendar cal-1"));
    }

    #[test]
    fn store_connections_enforce_staging_foreign_key_and_cascade() {
        let (_dir, store) = test_store();
        let conn = store.connect().unwrap();
        let foreign_keys: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);

        let orphan_result = conn.execute(
            "
            INSERT INTO calendar_events_staging (
              stage_id, calendar_id, event_id, summary, description,
              start_ts, end_ts, status
            ) VALUES (
              999, 'cal-1', 'orphan', 'Studio A / Orphan', '8',
              '2026-01-10T09:00:00+01:00', '2026-01-10T10:00:00+01:00',
              'confirmed'
            )
            ",
            [],
        );
        assert!(orphan_result.is_err());

        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();
        store.discard_staged_full_sync(stage_id).unwrap();
        let staged_events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_events_staging WHERE stage_id = ?",
                [stage_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(staged_events, 0);
    }

    #[test]
    fn clear_invalidates_target_stage_without_touching_another_calendar() {
        let (_dir, first, second) = two_stores();
        first
            .upsert_event(&event("live-event", "Studio A / Live"))
            .unwrap();
        first
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let stage_id = first.begin_staged_full_sync("cal-1").unwrap();
        first
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();

        let mut other_live = event("other-live", "Studio B / Live");
        other_live.calendar_id = "cal-2".to_string();
        first.upsert_event(&other_live).unwrap();
        first
            .replace_sync_state("cal-2", Some("other-token"), "other-sync", true)
            .unwrap();
        let other_stage_id = first.begin_staged_full_sync("cal-2").unwrap();
        let mut other_replacement = event("other-new", "Studio B / New");
        other_replacement.calendar_id = "cal-2".to_string();
        first
            .stage_event(other_stage_id, &other_replacement)
            .unwrap();

        second.clear_calendar("cal-1").unwrap();

        assert!(first
            .commit_staged_full_sync(stage_id, "cal-1", "revived-token", "revived-sync",)
            .is_err());
        assert!(first.list_events("cal-1").unwrap().is_empty());
        assert!(first.sync_state("cal-1").unwrap().is_none());
        first
            .commit_staged_full_sync(other_stage_id, "cal-2", "other-new-token", "other-new-sync")
            .unwrap();
        assert_eq!(first.list_events("cal-2").unwrap(), vec![other_replacement]);
    }

    #[test]
    fn failed_clear_rolls_back_live_and_staged_calendar_data() {
        let (dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();
        let conn = Connection::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        conn.execute_batch(
            "
            CREATE TRIGGER reject_sync_state_delete
            BEFORE DELETE ON calendar_sync_state
            BEGIN
              SELECT RAISE(ABORT, 'injected clear failure');
            END;
            ",
        )
        .unwrap();
        drop(conn);

        assert!(store.clear_calendar("cal-1").is_err());

        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
        store
            .stage_event(stage_id, &event("later-event", "Studio A / Later"))
            .unwrap();
    }

    #[test]
    fn current_stage_survives_store_reopen() {
        let (dir, store) = test_store();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        let staged = event("staged-event", "Studio A / Staged");
        store.stage_event(stage_id, &staged).unwrap();
        drop(store);

        let reopened = CalendarStore::open(dir.path().join("calendar-cache.sqlite")).unwrap();

        reopened
            .commit_staged_full_sync(stage_id, "cal-1", "next-token", "new-sync")
            .unwrap();
        assert_eq!(reopened.list_events("cal-1").unwrap(), vec![staged]);
    }

    #[test]
    fn discarded_stage_preserves_live_events_and_sync_state() {
        let (dir, store) = test_store();
        store
            .upsert_event(&event("live-event", "Studio A / Live"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();

        store.discard_staged_full_sync(stage_id).unwrap();

        assert_eq!(
            store.list_events("cal-1").unwrap(),
            vec![event("live-event", "Studio A / Live")]
        );
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
        let conn = Connection::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        let header_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_full_sync_stages WHERE stage_id = ?",
                [stage_id],
                |row| row.get(0),
            )
            .unwrap();
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_events_staging WHERE stage_id = ?",
                [stage_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((header_count, event_count), (0, 0));
    }

    #[test]
    fn staged_full_sync_failed_commit_preserves_live_events_and_sync_state() {
        let (dir, store) = test_store();
        store
            .upsert_event(&event("live-event", "Studio A / Live"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();
        let conn = Connection::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        conn.execute_batch(
            "
            CREATE TRIGGER reject_sync_state_update
            BEFORE UPDATE ON calendar_sync_state
            BEGIN
              SELECT RAISE(ABORT, 'injected sync-state failure');
            END;
            ",
        )
        .unwrap();
        drop(conn);

        let result = store.commit_staged_full_sync(stage_id, "cal-1", "new-token", "new-sync");

        assert!(result.is_err());
        assert_eq!(
            store.list_events("cal-1").unwrap(),
            vec![event("live-event", "Studio A / Live")]
        );
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn empty_full_sync_token_is_rejected_before_live_data_changes() {
        let (_dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();

        let error = store
            .commit_staged_full_sync(stage_id, "cal-1", "", "new-sync")
            .unwrap_err();

        assert!(matches!(error, CalendarStoreError::InvalidFullSyncToken));
        assert!(error.to_string().contains("token must not be empty"));
        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn empty_full_sync_timestamp_is_rejected_before_live_data_changes() {
        let (_dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        store
            .stage_event(stage_id, &event("staged-event", "Studio A / Staged"))
            .unwrap();

        let error = store
            .commit_staged_full_sync(stage_id, "cal-1", "next-token", "")
            .unwrap_err();

        assert!(matches!(error, CalendarStoreError::InvalidSyncedAt));
        assert!(error.to_string().contains("timestamp must not be empty"));
        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn missing_stage_is_rejected_before_live_data_changes() {
        let (_dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let error = store
            .commit_staged_full_sync(999, "cal-1", "next-token", "new-sync")
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarStoreError::StageNotActive {
                stage_id: 999,
                ref calendar_id,
            } if calendar_id == "cal-1"
        ));
        assert!(error.to_string().contains("not active for calendar cal-1"));
        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn staged_full_sync_commit_replaces_only_selected_calendar_and_state_atomically() {
        let (dir, store) = test_store();
        store
            .upsert_event(&event("old-event", "Studio A / Old"))
            .unwrap();
        let mut other_event = event("other-event", "Studio B / Other");
        other_event.calendar_id = "cal-2".to_string();
        store.upsert_event(&other_event).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        store
            .replace_sync_state("cal-2", Some("other-token"), "other-sync", true)
            .unwrap();
        let stage_id = store.begin_staged_full_sync("cal-1").unwrap();
        let mut replacement = event("new-event", "Studio A / New");
        replacement.etag = Some("new-etag".to_string());
        store.stage_event(stage_id, &replacement).unwrap();

        let stats = store
            .commit_staged_full_sync(stage_id, "cal-1", "new-token", "new-sync")
            .unwrap();

        assert_eq!(
            stats,
            CalendarStoreSyncStats {
                upserted: 1,
                deleted: 1,
            }
        );
        assert_eq!(store.list_events("cal-1").unwrap(), vec![replacement]);
        assert_eq!(store.list_events("cal-2").unwrap(), vec![other_event]);
        let state = store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("new-token"));
        assert_eq!(state.last_synced_at, "new-sync");
        assert_eq!(state.last_full_sync_at.as_deref(), Some("new-sync"));
        assert_eq!(state.identity_schema_version, EVENT_IDENTITY_SCHEMA_VERSION);
        assert_eq!(
            store
                .sync_state("cal-2")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("other-token")
        );
        let conn = Connection::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        let staged_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_events_staging WHERE stage_id = ?",
                [stage_id],
                |row| row.get(0),
            )
            .unwrap();
        let stage_headers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_full_sync_stages WHERE stage_id = ?",
                [stage_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((stage_headers, staged_rows), (0, 0));
    }

    #[test]
    fn event_returns_one_calendar_event_by_identity() {
        let (_dir, store) = test_store();
        let expected = event("evt-1", "Studio A / Flow");
        store.upsert_event(&expected).unwrap();

        assert_eq!(store.event("cal-1", "evt-1").unwrap(), Some(expected));
        assert_eq!(store.event("cal-2", "evt-1").unwrap(), None);
        assert_eq!(store.event("cal-1", "missing").unwrap(), None);
    }

    #[test]
    fn list_series_instances_returns_only_matching_calendar_and_series() {
        let (_dir, store) = test_store();
        let mut first = event("instance-1", "Studio A / Flow");
        first.recurring_event_id = Some("series-1".to_string());
        let mut second = event("instance-2", "Studio A / Flow");
        second.recurring_event_id = Some("series-1".to_string());
        second.start_ts = "2026-01-11T09:00:00+01:00".to_string();
        let mut other_series = event("instance-3", "Studio A / Flow");
        other_series.recurring_event_id = Some("series-2".to_string());
        let mut other_calendar = event("instance-4", "Studio B / Flow");
        other_calendar.calendar_id = "cal-2".to_string();
        other_calendar.recurring_event_id = Some("series-1".to_string());
        for cached in [&second, &other_series, &other_calendar, &first] {
            store.upsert_event(cached).unwrap();
        }

        assert_eq!(
            store.list_series_instances("cal-1", "series-1").unwrap(),
            vec![first, second]
        );
    }

    #[test]
    fn migration_creates_empty_tables() {
        let (_dir, store) = test_store();

        assert!(store.list_events("cal-1").unwrap().is_empty());
        assert!(store.sync_state("cal-1").unwrap().is_none());
    }

    #[test]
    fn upsert_event_is_idempotent() {
        let (_dir, store) = test_store();

        store
            .upsert_event(&event("evt-1", "Studio A / Flow"))
            .unwrap();
        store
            .upsert_event(&event("evt-1", "Studio A / Flow Updated"))
            .unwrap();

        let events = store.list_events("cal-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "Studio A / Flow Updated");
    }

    #[test]
    fn delete_event_removes_cached_row() {
        let (_dir, store) = test_store();

        store
            .upsert_event(&event("evt-1", "Studio A / Flow"))
            .unwrap();
        store.delete_event("cal-1", "evt-1").unwrap();

        assert!(store.list_events("cal-1").unwrap().is_empty());
    }

    #[test]
    fn sync_state_replaces_token_per_calendar() {
        let (_dir, store) = test_store();

        store
            .replace_sync_state("cal-1", Some("token-1"), "2026-06-01T10:00:00Z", true)
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("token-2"), "2026-06-01T11:00:00Z", false)
            .unwrap();

        let state = store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("token-2"));
        assert_eq!(state.last_synced_at, "2026-06-01T11:00:00Z");
        assert_eq!(
            state.last_full_sync_at.as_deref(),
            Some("2026-06-01T10:00:00Z")
        );
    }

    #[test]
    fn incremental_changes_and_next_token_commit_atomically() {
        let (_dir, store) = test_store();
        store
            .upsert_event(&event("removed", "Studio A / Removed"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let replacement = event("replacement", "Studio A / Replacement");

        let applied = store
            .apply_incremental_sync(
                "cal-1",
                "old-token",
                &[
                    IncrementalEventChange::Delete("removed".to_string()),
                    IncrementalEventChange::Upsert(Box::new(replacement.clone())),
                ],
                "next-token",
                "next-sync",
            )
            .unwrap();

        assert_eq!(
            applied,
            CalendarStoreSyncStats {
                upserted: 1,
                deleted: 1,
            }
        );
        assert_eq!(store.list_events("cal-1").unwrap(), vec![replacement]);
        let state = store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("next-token"));
        assert_eq!(state.last_synced_at, "next-sync");
        assert_eq!(state.last_full_sync_at.as_deref(), Some("old-sync"));
        assert_eq!(state.identity_schema_version, EVENT_IDENTITY_SCHEMA_VERSION);
    }

    #[test]
    fn stale_incremental_work_cannot_overwrite_a_newer_full_sync() {
        let (_dir, stale_store, current_store) = two_stores();
        stale_store
            .upsert_event(&event("old-event", "Studio A / Old"))
            .unwrap();
        stale_store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let stale_changes = vec![IncrementalEventChange::Upsert(Box::new(event(
            "stale-event",
            "Studio A / Stale",
        )))];
        let replacement = event("new-event", "Studio A / Current");
        let stage_id = current_store.begin_staged_full_sync("cal-1").unwrap();
        current_store.stage_event(stage_id, &replacement).unwrap();
        current_store
            .commit_staged_full_sync(stage_id, "cal-1", "current-token", "current-sync")
            .unwrap();

        let error = stale_store
            .apply_incremental_sync(
                "cal-1",
                "old-token",
                &stale_changes,
                "stale-token",
                "stale-sync",
            )
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarStoreError::SyncStateChanged { ref calendar_id }
                if calendar_id == "cal-1"
        ));
        let message = error.to_string();
        assert!(!message.contains("old-token"));
        assert!(!message.contains("stale-token"));
        assert_eq!(stale_store.list_events("cal-1").unwrap(), vec![replacement]);
        let state = stale_store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("current-token"));
        assert_eq!(state.last_synced_at, "current-sync");
        assert_eq!(state.last_full_sync_at.as_deref(), Some("current-sync"));
    }

    #[test]
    fn failed_incremental_state_update_rolls_back_event_changes() {
        let (dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        Connection::open(dir.path().join("calendar-cache.sqlite"))
            .unwrap()
            .execute_batch(
                "
                CREATE TRIGGER reject_incremental_state_update
                BEFORE UPDATE ON calendar_sync_state
                BEGIN
                  SELECT RAISE(ABORT, 'reject incremental state update');
                END;
                ",
            )
            .unwrap();

        let result = store.apply_incremental_sync(
            "cal-1",
            "old-token",
            &[
                IncrementalEventChange::Delete("live-event".to_string()),
                IncrementalEventChange::Upsert(Box::new(event("new-event", "Studio A / New"))),
            ],
            "next-token",
            "next-sync",
        );

        assert!(result.is_err());
        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn ignored_incremental_state_update_returns_typed_conflict_and_rolls_back() {
        let (dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        Connection::open(dir.path().join("calendar-cache.sqlite"))
            .unwrap()
            .execute_batch(
                "
                CREATE TRIGGER ignore_incremental_state_update
                BEFORE UPDATE ON calendar_sync_state
                BEGIN
                  SELECT RAISE(IGNORE);
                END;
                ",
            )
            .unwrap();

        let error = store
            .apply_incremental_sync(
                "cal-1",
                "old-token",
                &[
                    IncrementalEventChange::Delete("live-event".to_string()),
                    IncrementalEventChange::Upsert(Box::new(event("new-event", "Studio A / New"))),
                ],
                "next-token",
                "next-sync",
            )
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarStoreError::SyncStateChanged { ref calendar_id }
                if calendar_id == "cal-1"
        ));
        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("old-token")
        );
    }

    #[test]
    fn incremental_sync_rejects_blank_boundary_values_without_mutation() {
        let (_dir, store) = test_store();
        let live = event("live-event", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let blank_expected = store
            .apply_incremental_sync("cal-1", " ", &[], "next-token", "next-sync")
            .unwrap_err();
        assert!(matches!(
            blank_expected,
            CalendarStoreError::InvalidExpectedSyncToken
        ));

        let blank_next = store
            .apply_incremental_sync("cal-1", "old-token", &[], "\t", "next-sync")
            .unwrap_err();
        assert!(matches!(
            blank_next,
            CalendarStoreError::InvalidIncrementalSyncToken
        ));

        let blank_timestamp = store
            .apply_incremental_sync("cal-1", "old-token", &[], "next-token", "\n")
            .unwrap_err();
        assert!(matches!(
            blank_timestamp,
            CalendarStoreError::InvalidSyncedAt
        ));

        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        let state = store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("old-token"));
        assert_eq!(state.last_synced_at, "old-sync");
    }

    #[test]
    fn incremental_sync_rejects_cross_calendar_upsert_without_mutation() {
        let (_dir, store) = test_store();
        let first = event("first", "Studio A / Live");
        let mut second = event("second", "Studio B / Live");
        second.calendar_id = "cal-2".to_string();
        store.upsert_event(&first).unwrap();
        store.upsert_event(&second).unwrap();
        store
            .replace_sync_state("cal-1", Some("token-1"), "sync-1", true)
            .unwrap();
        store
            .replace_sync_state("cal-2", Some("token-2"), "sync-2", true)
            .unwrap();
        let mut foreign = event("foreign", "Studio B / Foreign");
        foreign.calendar_id = "cal-2".to_string();

        let error = store
            .apply_incremental_sync(
                "cal-1",
                "token-1",
                &[IncrementalEventChange::Upsert(Box::new(foreign))],
                "next-token",
                "next-sync",
            )
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarStoreError::IncrementalEventWrongCalendar {
                ref calendar_id,
                ref event_id,
                ref event_calendar_id,
            } if calendar_id == "cal-1"
                && event_id == "foreign"
                && event_calendar_id == "cal-2"
        ));
        assert_eq!(store.list_events("cal-1").unwrap(), vec![first]);
        assert_eq!(store.list_events("cal-2").unwrap(), vec![second]);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("token-1")
        );
        assert_eq!(
            store
                .sync_state("cal-2")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("token-2")
        );
    }

    #[test]
    fn incremental_sync_uses_last_change_per_event_and_reports_unique_stats() {
        let (_dir, store) = test_store();
        store
            .upsert_event(&event("removed", "Studio A / Removed"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        let mut first_upsert = event("updated", "Studio A / First");
        let final_upsert = event("updated", "Studio A / Final");
        first_upsert.description = "7".to_string();
        let revived = event("revived", "Studio A / Revived");

        let stats = store
            .apply_incremental_sync(
                "cal-1",
                "old-token",
                &[
                    IncrementalEventChange::Upsert(Box::new(first_upsert)),
                    IncrementalEventChange::Upsert(Box::new(final_upsert.clone())),
                    IncrementalEventChange::Delete("removed".to_string()),
                    IncrementalEventChange::Delete("removed".to_string()),
                    IncrementalEventChange::Upsert(Box::new(event(
                        "transient",
                        "Studio A / Transient",
                    ))),
                    IncrementalEventChange::Delete("transient".to_string()),
                    IncrementalEventChange::Delete("revived".to_string()),
                    IncrementalEventChange::Upsert(Box::new(revived.clone())),
                ],
                "next-token",
                "next-sync",
            )
            .unwrap();

        assert_eq!(
            stats,
            CalendarStoreSyncStats {
                upserted: 2,
                deleted: 1,
            }
        );
        assert_eq!(
            store.list_events("cal-1").unwrap(),
            vec![revived, final_upsert]
        );
    }
}
