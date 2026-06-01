use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCalendarEvent {
    pub calendar_id: String,
    pub event_id: String,
    pub summary: String,
    pub description: String,
    pub start_ts: String,
    pub end_ts: String,
    pub updated_ts: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarSyncState {
    pub calendar_id: String,
    pub sync_token: Option<String>,
    pub last_synced_at: String,
    pub last_full_sync_at: Option<String>,
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
        Connection::open(&self.path)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute_batch(
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
        Ok(())
    }

    pub fn list_events(&self, calendar_id: &str) -> rusqlite::Result<Vec<StoredCalendarEvent>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "
            SELECT calendar_id, event_id, summary, description, start_ts, end_ts, updated_ts, status
            FROM calendar_events
            WHERE calendar_id = ?
            ORDER BY start_ts ASC, event_id ASC
            ",
        )?;
        let rows = stmt.query_map([calendar_id], |row| {
            Ok(StoredCalendarEvent {
                calendar_id: row.get(0)?,
                event_id: row.get(1)?,
                summary: row.get(2)?,
                description: row.get(3)?,
                start_ts: row.get(4)?,
                end_ts: row.get(5)?,
                updated_ts: row.get(6)?,
                status: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_event(&self, event: &StoredCalendarEvent) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "
            INSERT INTO calendar_events (
              calendar_id, event_id, summary, description, start_ts, end_ts, updated_ts, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(calendar_id, event_id) DO UPDATE SET
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

    pub fn delete_event(&self, calendar_id: &str, event_id: &str) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ? AND event_id = ?",
            params![calendar_id, event_id],
        )?;
        Ok(())
    }

    pub fn clear_calendar(&self, calendar_id: &str) -> rusqlite::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ?",
            [calendar_id],
        )?;
        conn.execute(
            "DELETE FROM calendar_sync_state WHERE calendar_id = ?",
            [calendar_id],
        )?;
        Ok(())
    }

    pub fn sync_state(&self, calendar_id: &str) -> rusqlite::Result<Option<CalendarSyncState>> {
        let conn = self.connect()?;
        conn.query_row(
            "
            SELECT calendar_id, sync_token, last_synced_at, last_full_sync_at
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
                })
            },
        )
        .optional()
    }

    pub fn replace_sync_state(
        &self,
        calendar_id: &str,
        sync_token: Option<&str>,
        synced_at: &str,
        full_sync: bool,
    ) -> rusqlite::Result<()> {
        let existing_full_sync = self
            .sync_state(calendar_id)?
            .and_then(|state| state.last_full_sync_at);
        let last_full_sync_at = if full_sync {
            Some(synced_at.to_string())
        } else {
            existing_full_sync
        };
        let conn = self.connect()?;
        conn.execute(
            "
            INSERT INTO calendar_sync_state (
              calendar_id, sync_token, last_synced_at, last_full_sync_at
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(calendar_id) DO UPDATE SET
              sync_token = excluded.sync_token,
              last_synced_at = excluded.last_synced_at,
              last_full_sync_at = excluded.last_full_sync_at
            ",
            params![calendar_id, sync_token, synced_at, last_full_sync_at],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (tempfile::TempDir, CalendarStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        (dir, store)
    }

    fn event(id: &str, summary: &str) -> StoredCalendarEvent {
        StoredCalendarEvent {
            calendar_id: "cal-1".to_string(),
            event_id: id.to_string(),
            summary: summary.to_string(),
            description: "8".to_string(),
            start_ts: "2026-01-10T09:00:00+01:00".to_string(),
            end_ts: "2026-01-10T10:00:00+01:00".to_string(),
            updated_ts: Some("2026-01-09T12:00:00.000Z".to_string()),
            status: "confirmed".to_string(),
        }
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
}
