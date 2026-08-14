use crate::{
    calendar_api::{
        CalendarApi, CalendarApiError, CalendarApiErrorCode, GoogleCalendarClient,
        GoogleCalendarEvent, GoogleEventDateTime,
    },
    calendar_store::{
        CalendarStore, CalendarStoreError, IncrementalEventChange, StoredCalendarEvent,
        EVENT_IDENTITY_SCHEMA_VERSION,
    },
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    error::Error as StdError,
    fmt,
};

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub full_sync: bool,
    pub fetched: usize,
    pub upserted: usize,
    pub deleted: usize,
    pub sync_token: Option<String>,
}

#[derive(Debug)]
pub(crate) enum CalendarSyncError {
    Api(Box<CalendarApiError>),
    Store(Box<CalendarStoreError>),
    InvalidEventTime { event_id: String },
    InvalidFullPageToken,
    InvalidIncrementalPageToken,
    MissingFullSyncToken,
    MissingIncrementalSyncToken,
    Clock(String),
}

impl fmt::Display for CalendarSyncError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api(error) => error.fmt(formatter),
            Self::Store(error) => error.fmt(formatter),
            Self::InvalidEventTime { event_id } => {
                write!(
                    formatter,
                    "Calendar event {event_id} has invalid start/end boundaries"
                )
            }
            Self::InvalidFullPageToken => {
                write!(
                    formatter,
                    "full Calendar sync returned an invalid page token"
                )
            }
            Self::InvalidIncrementalPageToken => {
                write!(
                    formatter,
                    "incremental Calendar sync returned an invalid page token"
                )
            }
            Self::MissingFullSyncToken => {
                write!(
                    formatter,
                    "full Calendar sync did not return a final sync token"
                )
            }
            Self::MissingIncrementalSyncToken => write!(
                formatter,
                "incremental Calendar sync did not return a final sync token"
            ),
            Self::Clock(message) => formatter.write_str(message),
        }
    }
}

impl StdError for CalendarSyncError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Api(error) => Some(error.as_ref()),
            Self::Store(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

impl From<CalendarApiError> for CalendarSyncError {
    fn from(error: CalendarApiError) -> Self {
        Self::Api(Box::new(error))
    }
}

impl From<CalendarStoreError> for CalendarSyncError {
    fn from(error: CalendarStoreError) -> Self {
        Self::Store(Box::new(error))
    }
}

enum EventTime {
    Timed(String),
    AllDay,
}

enum MappedEvent {
    Timed(Box<StoredCalendarEvent>),
    AllDay,
}

fn event_time(value: Option<&GoogleEventDateTime>) -> Option<EventTime> {
    let value = value?;
    match (&value.date_time, &value.date) {
        (Some(date_time), None) if !date_time.trim().is_empty() => {
            Some(EventTime::Timed(date_time.clone()))
        }
        (None, Some(date)) if !date.trim().is_empty() => Some(EventTime::AllDay),
        _ => None,
    }
}

fn stored_event(
    calendar_id: &str,
    event: &GoogleCalendarEvent,
) -> Result<MappedEvent, CalendarSyncError> {
    let (start_ts, end_ts) = match (
        event_time(event.start.as_ref()),
        event_time(event.end.as_ref()),
    ) {
        (Some(EventTime::Timed(start)), Some(EventTime::Timed(end))) => (start, end),
        (Some(EventTime::AllDay), Some(EventTime::AllDay)) => return Ok(MappedEvent::AllDay),
        _ => {
            return Err(CalendarSyncError::InvalidEventTime {
                event_id: event.id.clone(),
            });
        }
    };
    Ok(MappedEvent::Timed(Box::new(StoredCalendarEvent {
        calendar_id: calendar_id.to_string(),
        event_id: event.id.clone(),
        recurring_event_id: event.recurring_event_id.clone(),
        original_start_time: event
            .original_start_time
            .as_ref()
            .and_then(|start| start.identity_value()),
        etag: event.etag.clone(),
        summary: event.summary.clone().unwrap_or_default(),
        description: event.description.clone().unwrap_or_default(),
        start_ts,
        end_ts,
        updated_ts: event.updated.clone(),
        status: event
            .status
            .clone()
            .unwrap_or_else(|| "confirmed".to_string()),
    })))
}

fn synced_at() -> Result<String, CalendarSyncError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .map_err(|error| CalendarSyncError::Clock(error.to_string()))
}

fn validate_page_token(
    token: String,
    seen: &mut HashSet<String>,
    full_sync: bool,
) -> Result<String, CalendarSyncError> {
    if token.trim().is_empty() || !seen.insert(token.clone()) {
        return Err(if full_sync {
            CalendarSyncError::InvalidFullPageToken
        } else {
            CalendarSyncError::InvalidIncrementalPageToken
        });
    }
    Ok(token)
}

pub(crate) async fn full_sync_calendar_with_client<A: CalendarApi>(
    store: &CalendarStore,
    client: &A,
    calendar_id: &str,
    access_token: &str,
) -> Result<SyncResult, CalendarSyncError> {
    let stage_id = store
        .begin_staged_full_sync(calendar_id)
        .map_err(CalendarStoreError::from)?;
    let mut page_token: Option<String> = None;
    let mut seen_page_tokens = HashSet::new();
    let mut fetched = 0;
    let result = async {
        let next_sync_token = loop {
            let page = client
                .list_events_page(access_token, calendar_id, None, page_token.as_deref())
                .await?;
            fetched += page.items.len();
            for event in &page.items {
                if event.status.as_deref() == Some("cancelled") {
                    continue;
                }
                if let MappedEvent::Timed(stored) = stored_event(calendar_id, event)? {
                    store.stage_event(stage_id, &stored)?;
                }
            }

            if let Some(next_page_token) = page.next_page_token {
                page_token = Some(validate_page_token(
                    next_page_token,
                    &mut seen_page_tokens,
                    true,
                )?);
                continue;
            }
            break page
                .next_sync_token
                .filter(|token| !token.trim().is_empty())
                .ok_or(CalendarSyncError::MissingFullSyncToken)?;
        };

        let timestamp = synced_at()?;
        let stats =
            store.commit_staged_full_sync(stage_id, calendar_id, &next_sync_token, &timestamp)?;
        Ok(SyncResult {
            full_sync: true,
            fetched,
            upserted: stats.upserted,
            deleted: stats.deleted,
            sync_token: Some(next_sync_token),
        })
    }
    .await;

    if result.is_err() {
        let _ = store.discard_staged_full_sync(stage_id);
    }
    result
}

async fn run_incremental_sync<A: CalendarApi>(
    store: &CalendarStore,
    client: &A,
    calendar_id: &str,
    access_token: &str,
    expected_sync_token: &str,
) -> Result<SyncResult, CalendarSyncError> {
    let mut page_token: Option<String> = None;
    let mut seen_page_tokens = HashSet::new();
    let mut changes = BTreeMap::new();
    let mut fetched = 0;
    let next_sync_token = loop {
        let page = client
            .list_events_page(
                access_token,
                calendar_id,
                Some(expected_sync_token),
                page_token.as_deref(),
            )
            .await?;
        fetched += page.items.len();
        for event in &page.items {
            let change = if event.status.as_deref() == Some("cancelled") {
                IncrementalEventChange::Delete(event.id.clone())
            } else {
                match stored_event(calendar_id, event)? {
                    MappedEvent::Timed(stored) => IncrementalEventChange::Upsert(stored),
                    MappedEvent::AllDay => IncrementalEventChange::Delete(event.id.clone()),
                }
            };
            changes.insert(event.id.clone(), change);
        }

        if let Some(next_page_token) = page.next_page_token {
            page_token = Some(validate_page_token(
                next_page_token,
                &mut seen_page_tokens,
                false,
            )?);
            continue;
        }
        break page
            .next_sync_token
            .filter(|token| !token.trim().is_empty())
            .ok_or(CalendarSyncError::MissingIncrementalSyncToken)?;
    };

    let timestamp = synced_at()?;
    let changes = changes.into_values().collect::<Vec<_>>();
    let stats = store.apply_incremental_sync(
        calendar_id,
        expected_sync_token,
        &changes,
        &next_sync_token,
        &timestamp,
    )?;

    Ok(SyncResult {
        full_sync: false,
        fetched,
        upserted: stats.upserted,
        deleted: stats.deleted,
        sync_token: Some(next_sync_token),
    })
}

async fn sync_calendar_with_client<A: CalendarApi>(
    store: &CalendarStore,
    client: &A,
    calendar_id: &str,
    access_token: &str,
) -> Result<SyncResult, CalendarSyncError> {
    let state = store
        .sync_state(calendar_id)
        .map_err(CalendarStoreError::from)?;
    let Some(state) = state else {
        return full_sync_calendar_with_client(store, client, calendar_id, access_token).await;
    };
    if state.identity_schema_version != EVENT_IDENTITY_SCHEMA_VERSION {
        return full_sync_calendar_with_client(store, client, calendar_id, access_token).await;
    }
    let Some(sync_token) = state.sync_token else {
        return full_sync_calendar_with_client(store, client, calendar_id, access_token).await;
    };

    match run_incremental_sync(store, client, calendar_id, access_token, &sync_token).await {
        Err(CalendarSyncError::Api(error))
            if error.code == CalendarApiErrorCode::SyncTokenExpired =>
        {
            full_sync_calendar_with_client(store, client, calendar_id, access_token).await
        }
        result => result,
    }
}

pub async fn sync_calendar(
    store: &CalendarStore,
    calendar_id: &str,
    access_token: &str,
) -> Result<SyncResult, String> {
    sync_calendar_with_client(
        store,
        &GoogleCalendarClient::new(),
        calendar_id,
        access_token,
    )
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        calendar_api::GoogleCalendarClient,
        calendar_store::{CalendarStore, EVENT_IDENTITY_SCHEMA_VERSION},
    };
    use httpmock::prelude::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn timed_event(id: &str, summary: &str) -> serde_json::Value {
        json!({
            "id": id,
            "etag": format!("etag-{id}"),
            "summary": summary,
            "description": "8",
            "status": "confirmed",
            "start": { "dateTime": "2026-01-10T09:00:00+01:00" },
            "end": { "dateTime": "2026-01-10T10:00:00+01:00" },
            "updated": "2026-01-09T12:00:00.000Z"
        })
    }

    fn all_day_event(id: &str, summary: &str) -> serde_json::Value {
        json!({
            "id": id,
            "summary": summary,
            "status": "confirmed",
            "start": { "date": "2026-01-10" },
            "end": { "date": "2026-01-11" }
        })
    }

    fn cached_event(id: &str, summary: &str) -> StoredCalendarEvent {
        StoredCalendarEvent {
            calendar_id: "cal-1".to_string(),
            event_id: id.to_string(),
            recurring_event_id: None,
            original_start_time: None,
            etag: Some(format!("etag-{id}")),
            summary: summary.to_string(),
            description: "8".to_string(),
            start_ts: "2026-01-10T09:00:00+01:00".to_string(),
            end_ts: "2026-01-10T10:00:00+01:00".to_string(),
            updated_ts: Some("2026-01-09T12:00:00.000Z".to_string()),
            status: "confirmed".to_string(),
        }
    }

    fn test_store() -> (tempfile::TempDir, std::path::PathBuf, CalendarStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("calendar-cache.sqlite");
        let store = CalendarStore::open(path.clone()).unwrap();
        (dir, path, store)
    }

    fn client(server: &MockServer) -> GoogleCalendarClient {
        GoogleCalendarClient::new_for_test(format!("{}/calendar/v3", server.base_url()))
    }

    #[tokio::test]
    async fn full_sync_maps_recurrence_identity_and_ignores_all_day_events() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                let mut date_identity = timed_event("instance-date", "Studio A / Flow");
                date_identity["recurringEventId"] = json!("master-1");
                date_identity["originalStartTime"] = json!({ "date": "2026-01-10" });
                let mut datetime_identity = timed_event("instance-datetime", "Studio A / Flow");
                datetime_identity["recurringEventId"] = json!("master-1");
                datetime_identity["originalStartTime"] =
                    json!({ "dateTime": "2026-01-11T09:00:00+01:00" });
                then.status(200).json_body(json!({
                    "items": [
                        date_identity,
                        datetime_identity,
                        {
                            "id": "all-day",
                            "summary": "Studio A / Holiday",
                            "start": { "date": "2026-01-12" },
                            "end": { "date": "2026-01-13" }
                        }
                    ],
                    "nextSyncToken": "full-token"
                }));
            })
            .await;
        let (_dir, _path, store) = test_store();

        let result = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert!(result.full_sync);
        assert_eq!(result.fetched, 3);
        assert_eq!(result.upserted, 2);
        let events = store.list_events("cal-1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].recurring_event_id.as_deref(), Some("master-1"));
        assert_eq!(events[0].original_start_time.as_deref(), Some("2026-01-10"));
        assert_eq!(events[0].etag.as_deref(), Some("etag-instance-date"));
        assert_eq!(
            events[1].original_start_time.as_deref(),
            Some("2026-01-11T09:00:00+01:00")
        );
    }

    #[tokio::test]
    async fn multipage_full_sync_replaces_live_rows_only_after_a_final_sync_token() {
        let server = MockServer::start_async().await;
        let second_failure = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("pageToken", "page-2");
                then.status(200).json_body(json!({
                    "items": [timed_event("second", "Studio A / Second")]
                }));
            })
            .await;
        let first_page = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(200).json_body(json!({
                    "items": [timed_event("first", "Studio A / First")],
                    "nextPageToken": "page-2"
                }));
            })
            .await;
        let (_dir, path, store) = test_store();
        let live = cached_event("live", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE calendar_sync_state SET identity_schema_version = 0 WHERE calendar_id = ?",
                ["cal-1"],
            )
            .unwrap();

        assert!(
            sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
                .await
                .is_err()
        );
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

        first_page.delete_async().await;
        second_failure.delete_async().await;
        let second_success = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("pageToken", "page-2");
                then.status(200).json_body(json!({
                    "items": [timed_event("second", "Studio A / Second")],
                    "nextSyncToken": "replacement-token"
                }));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(200).json_body(json!({
                    "items": [timed_event("first", "Studio A / First")],
                    "nextPageToken": "page-2"
                }));
            })
            .await;

        sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert_eq!(
            store
                .list_events("cal-1")
                .unwrap()
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .sync_token
                .as_deref(),
            Some("replacement-token")
        );
        second_success.assert_async().await;
    }

    #[tokio::test]
    async fn full_sync_reports_unique_rows_and_rows_actually_removed() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(200).json_body(json!({
                    "items": [
                        timed_event("retained", "Studio A / First value"),
                        timed_event("retained", "Studio A / Final value"),
                        timed_event("new", "Studio A / New")
                    ],
                    "nextSyncToken": "replacement-token"
                }));
            })
            .await;
        let (_dir, path, store) = test_store();
        store
            .upsert_event(&cached_event("removed", "Studio A / Removed"))
            .unwrap();
        store
            .upsert_event(&cached_event("retained", "Studio A / Old value"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE calendar_sync_state SET identity_schema_version = 0 WHERE calendar_id = ?",
                ["cal-1"],
            )
            .unwrap();

        let result = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert_eq!((result.fetched, result.upserted, result.deleted), (3, 2, 1));
        assert_eq!(
            store.event("cal-1", "retained").unwrap().unwrap().summary,
            "Studio A / Final value"
        );
        assert!(store.event("cal-1", "removed").unwrap().is_none());
    }

    #[tokio::test]
    async fn successful_identity_upgrade_returns_to_incremental_sync() {
        let server = MockServer::start_async().await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(200).json_body(json!({
                    "items": [timed_event("full-event", "Studio A / Full")],
                    "nextSyncToken": "upgraded-token"
                }));
            })
            .await;
        let (_dir, path, store) = test_store();
        store
            .replace_sync_state("cal-1", Some("legacy-token"), "legacy-sync", true)
            .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE calendar_sync_state SET identity_schema_version = 0 WHERE calendar_id = ?",
                ["cal-1"],
            )
            .unwrap();

        let upgrade = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();
        assert!(upgrade.full_sync);
        assert_eq!(
            store
                .sync_state("cal-1")
                .unwrap()
                .unwrap()
                .identity_schema_version,
            EVENT_IDENTITY_SCHEMA_VERSION
        );

        full.delete_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "upgraded-token");
                then.status(200).json_body(json!({
                    "items": [timed_event("incremental", "Studio A / Incremental")],
                    "nextSyncToken": "incremental-token"
                }));
            })
            .await;

        let incremental = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert!(!incremental.full_sync);
        assert_eq!(incremental.sync_token.as_deref(), Some("incremental-token"));
    }

    #[tokio::test]
    async fn incremental_sync_atomically_upserts_deletes_and_remains_idempotent() {
        let server = MockServer::start_async().await;
        let first = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(200).json_body(json!({
                    "items": [
                        { "id": "removed", "status": "cancelled" },
                        timed_event("upserted", "Studio A / Updated"),
                        {
                            "id": "all-day",
                            "start": { "date": "2026-01-12" },
                            "end": { "date": "2026-01-13" }
                        }
                    ],
                    "nextSyncToken": "next-token"
                }));
            })
            .await;
        let (_dir, _path, store) = test_store();
        store
            .upsert_event(&cached_event("removed", "Studio A / Removed"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let result = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert!(!result.full_sync);
        assert_eq!((result.fetched, result.upserted, result.deleted), (3, 1, 1));
        assert_eq!(
            store.list_events("cal-1").unwrap(),
            vec![cached_event("upserted", "Studio A / Updated")]
        );

        first.delete_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "next-token");
                then.status(200).json_body(json!({
                    "items": [
                        { "id": "removed", "status": "cancelled" },
                        timed_event("upserted", "Studio A / Updated")
                    ],
                    "nextSyncToken": "last-token"
                }));
            })
            .await;

        sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert_eq!(
            store.list_events("cal-1").unwrap(),
            vec![cached_event("upserted", "Studio A / Updated")]
        );
    }

    #[tokio::test]
    async fn incremental_timed_to_all_day_transition_deletes_cached_lesson_and_advances_token() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(200).json_body(json!({
                    "items": [all_day_event("lesson", "Studio A / Holiday")],
                    "nextSyncToken": "next-token"
                }));
            })
            .await;
        let (_dir, _path, store) = test_store();
        store
            .upsert_event(&cached_event("lesson", "Studio A / Flow"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let result = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert_eq!((result.fetched, result.upserted, result.deleted), (1, 0, 1));
        assert!(store.list_events("cal-1").unwrap().is_empty());
        let state = store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("next-token"));
        assert_ne!(state.last_synced_at, "old-sync");
    }

    #[tokio::test]
    async fn malformed_incremental_event_preserves_cached_lesson_and_token() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(200).json_body(json!({
                    "items": [{
                        "id": "lesson",
                        "summary": "Studio A / Malformed",
                        "start": { "dateTime": "2026-01-10T09:00:00+01:00" },
                        "end": { "date": "2026-01-11" }
                    }],
                    "nextSyncToken": "next-token"
                }));
            })
            .await;
        let (_dir, _path, store) = test_store();
        let live = cached_event("lesson", "Studio A / Flow");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let error = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarSyncError::InvalidEventTime { ref event_id } if event_id == "lesson"
        ));
        assert_eq!(store.list_events("cal-1").unwrap(), vec![live]);
        let state = store.sync_state("cal-1").unwrap().unwrap();
        assert_eq!(state.sync_token.as_deref(), Some("old-token"));
        assert_eq!(state.last_synced_at, "old-sync");
    }

    #[tokio::test]
    async fn incremental_sync_uses_last_http_change_per_event_for_results() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(200).json_body(json!({
                    "items": [
                        timed_event("updated", "Studio A / First"),
                        timed_event("updated", "Studio A / Final"),
                        { "id": "removed", "status": "cancelled" },
                        { "id": "removed", "status": "cancelled" }
                    ],
                    "nextSyncToken": "next-token"
                }));
            })
            .await;
        let (_dir, _path, store) = test_store();
        store
            .upsert_event(&cached_event("removed", "Studio A / Removed"))
            .unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let result = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert_eq!((result.fetched, result.upserted, result.deleted), (4, 1, 1));
        assert_eq!(
            store.event("cal-1", "updated").unwrap().unwrap().summary,
            "Studio A / Final"
        );
    }

    #[tokio::test]
    async fn full_sync_rejects_blank_page_token_and_discards_staging() {
        let server = MockServer::start_async().await;
        let request = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(200)
                    .delay(std::time::Duration::from_millis(5))
                    .json_body(json!({
                        "items": [timed_event("staged", "Studio A / Staged")],
                        "nextPageToken": " "
                    }));
            })
            .await;
        let (_dir, path, store) = test_store();
        let live = cached_event("live", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE calendar_sync_state SET identity_schema_version = 0 WHERE calendar_id = ?",
                ["cal-1"],
            )
            .unwrap();

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            sync_calendar_with_client(&store, &client(&server), "cal-1", "token"),
        )
        .await
        .expect("blank full-sync pagination must stop")
        .unwrap_err();

        assert!(matches!(error, CalendarSyncError::InvalidFullPageToken));
        assert_eq!(request.hits_async().await, 1);
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
        let conn = Connection::open(path).unwrap();
        let staging_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM calendar_events_staging", [], |row| {
                row.get(0)
            })
            .unwrap();
        let stages: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM calendar_full_sync_stages",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((stages, staging_rows), (0, 0));
    }

    #[tokio::test]
    async fn incremental_sync_rejects_repeated_page_token_without_mutation() {
        let server = MockServer::start_async().await;
        let repeated = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token")
                    .query_param("pageToken", "page-2");
                then.status(200)
                    .delay(std::time::Duration::from_millis(5))
                    .json_body(json!({
                        "items": [timed_event("later", "Studio A / Later")],
                        "nextPageToken": "page-2"
                    }));
            })
            .await;
        let first = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(200).json_body(json!({
                    "items": [timed_event("first", "Studio A / First")],
                    "nextPageToken": "page-2"
                }));
            })
            .await;
        let (_dir, _path, store) = test_store();
        let live = cached_event("live", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            sync_calendar_with_client(&store, &client(&server), "cal-1", "token"),
        )
        .await
        .expect("repeated incremental pagination must stop")
        .unwrap_err();

        assert!(matches!(
            error,
            CalendarSyncError::InvalidIncrementalPageToken
        ));
        assert_eq!(first.hits_async().await, 1);
        assert_eq!(repeated.hits_async().await, 1);
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

    #[tokio::test]
    async fn incremental_410_remains_a_typed_api_error_until_recovery() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(410).json_body(json!({}));
            })
            .await;
        let (_dir, _path, store) = test_store();

        let error = run_incremental_sync(&store, &client(&server), "cal-1", "token", "old-token")
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            CalendarSyncError::Api(ref api_error)
                if api_error.code == CalendarApiErrorCode::SyncTokenExpired
        ));
    }

    #[tokio::test]
    async fn incremental_transport_error_does_not_surface_request_url_or_sync_token() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
        });
        let base_url = format!("http://{address}/calendar/v3");
        let client = GoogleCalendarClient::new_for_test(base_url.clone());
        let (_dir, _path, store) = test_store();
        store
            .replace_sync_state("cal-1", Some("secret-incremental-token"), "old-sync", true)
            .unwrap();

        let error = sync_calendar_with_client(&store, &client, "cal-1", "access-token")
            .await
            .unwrap_err();

        let message = error.to_string();
        assert!(!message.contains("secret-incremental-token"));
        assert!(!message.contains("syncToken"));
        assert!(!message.contains(&base_url));
        accepted.join().unwrap();
    }

    #[tokio::test]
    async fn expired_incremental_token_retains_live_cache_until_replacement_succeeds() {
        let server = MockServer::start_async().await;
        let expired = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(410).json_body(json!({}));
            })
            .await;
        let replacement_failure = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(500).json_body(json!({}));
            })
            .await;
        let (_dir, _path, store) = test_store();
        let live = cached_event("live", "Studio A / Live");
        store.upsert_event(&live).unwrap();
        store
            .replace_sync_state("cal-1", Some("old-token"), "old-sync", true)
            .unwrap();

        assert!(
            sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
                .await
                .is_err()
        );
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

        expired.delete_async().await;
        replacement_failure.delete_async().await;
        let expired_again = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal-1/events")
                    .query_param("syncToken", "old-token");
                then.status(410).json_body(json!({}));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/calendars/cal-1/events");
                then.status(200).json_body(json!({
                    "items": [timed_event("replacement", "Studio A / Replacement")],
                    "nextSyncToken": "replacement-token"
                }));
            })
            .await;

        let result = sync_calendar_with_client(&store, &client(&server), "cal-1", "token")
            .await
            .unwrap();

        assert!(result.full_sync);
        assert_eq!(
            store.list_events("cal-1").unwrap(),
            vec![cached_event("replacement", "Studio A / Replacement")]
        );
        expired_again.assert_async().await;
    }
}
