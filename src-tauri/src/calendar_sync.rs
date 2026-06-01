use crate::calendar_store::{CalendarStore, StoredCalendarEvent};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;

const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const SYNC_TOKEN_EXPIRED: &str = "__SYNC_TOKEN_EXPIRED__";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ApplyStats {
    pub upserted: usize,
    pub deleted: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub full_sync: bool,
    pub fetched: usize,
    pub upserted: usize,
    pub deleted: usize,
    pub sync_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventsResponse {
    #[serde(default)]
    items: Vec<GoogleCalendarEvent>,
    next_page_token: Option<String>,
    next_sync_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarEvent {
    pub id: String,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub start: Option<GoogleEventDateTime>,
    pub end: Option<GoogleEventDateTime>,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventDateTime {
    #[serde(rename = "dateTime")]
    pub date_time: Option<String>,
}

pub fn build_events_url(
    calendar_id: &str,
    sync_token: Option<&str>,
    page_token: Option<&str>,
) -> Result<Url, String> {
    let mut url = Url::parse(CALENDAR_API_BASE).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Calendar API base URL cannot be a base".to_string())?
        .push("calendars")
        .push(calendar_id)
        .push("events");

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("singleEvents", "true");
        query.append_pair("maxResults", "250");
        if let Some(token) = sync_token {
            query.append_pair("syncToken", token);
        }
        if let Some(token) = page_token {
            query.append_pair("pageToken", token);
        }
    }

    Ok(url)
}

pub fn apply_event(
    store: &CalendarStore,
    calendar_id: &str,
    event: &GoogleCalendarEvent,
) -> Result<ApplyStats, String> {
    if event.status.as_deref() == Some("cancelled") {
        store
            .delete_event(calendar_id, &event.id)
            .map_err(|e| e.to_string())?;
        return Ok(ApplyStats {
            upserted: 0,
            deleted: 1,
        });
    }

    let Some(start_ts) = event
        .start
        .as_ref()
        .and_then(|start| start.date_time.clone())
    else {
        return Ok(ApplyStats::default());
    };
    let Some(end_ts) = event.end.as_ref().and_then(|end| end.date_time.clone()) else {
        return Ok(ApplyStats::default());
    };

    let stored = StoredCalendarEvent {
        calendar_id: calendar_id.to_string(),
        event_id: event.id.clone(),
        summary: event.summary.clone().unwrap_or_default(),
        description: event.description.clone().unwrap_or_default(),
        start_ts,
        end_ts,
        updated_ts: event.updated.clone(),
        status: event
            .status
            .clone()
            .unwrap_or_else(|| "confirmed".to_string()),
    };
    store.upsert_event(&stored).map_err(|e| e.to_string())?;
    Ok(ApplyStats {
        upserted: 1,
        deleted: 0,
    })
}

async fn run_sync(
    store: &CalendarStore,
    calendar_id: &str,
    access_token: &str,
    sync_token: Option<String>,
) -> Result<SyncResult, String> {
    let client = reqwest::Client::new();
    let full_sync = sync_token.is_none();
    let mut page_token: Option<String> = None;
    let mut fetched = 0;
    let mut upserted = 0;
    let mut deleted = 0;
    let mut next_sync_token: Option<String> = None;

    loop {
        let url = build_events_url(calendar_id, sync_token.as_deref(), page_token.as_deref())?;
        let response = client
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == StatusCode::GONE && sync_token.is_some() {
            return Err(SYNC_TOKEN_EXPIRED.to_string());
        }

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Calendar sync failed ({status}): {body}"));
        }

        let page: GoogleEventsResponse = response.json().await.map_err(|e| e.to_string())?;
        fetched += page.items.len();
        for event in &page.items {
            let stats = apply_event(store, calendar_id, event)?;
            upserted += stats.upserted;
            deleted += stats.deleted;
        }

        page_token = page.next_page_token;
        next_sync_token = page.next_sync_token.or(next_sync_token);
        if page_token.is_none() {
            break;
        }
    }

    let synced_at = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs()
    );
    store
        .replace_sync_state(
            calendar_id,
            next_sync_token.as_deref(),
            &synced_at,
            full_sync,
        )
        .map_err(|e| e.to_string())?;

    Ok(SyncResult {
        full_sync,
        fetched,
        upserted,
        deleted,
        sync_token: next_sync_token,
    })
}

pub async fn sync_calendar(
    store: &CalendarStore,
    calendar_id: &str,
    access_token: &str,
) -> Result<SyncResult, String> {
    let state = store.sync_state(calendar_id).map_err(|e| e.to_string())?;
    match run_sync(
        store,
        calendar_id,
        access_token,
        state.and_then(|state| state.sync_token),
    )
    .await
    {
        Err(e) if e == SYNC_TOKEN_EXPIRED => {
            store
                .clear_calendar(calendar_id)
                .map_err(|e| e.to_string())?;
            run_sync(store, calendar_id, access_token, None).await
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar_store::CalendarStore;

    #[test]
    fn full_sync_url_uses_single_events_without_date_window() {
        let url = build_events_url("cal id", None, None).unwrap();

        assert!(url
            .as_str()
            .starts_with("https://www.googleapis.com/calendar/v3/calendars/cal%20id/events?"));
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "singleEvents")
                .unwrap()
                .1,
            "true"
        );
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "maxResults")
                .unwrap()
                .1,
            "250"
        );
        assert!(url
            .query_pairs()
            .all(|(k, _)| k != "timeMin" && k != "timeMax"));
        assert!(url.query_pairs().all(|(k, _)| k != "syncToken"));
    }

    #[test]
    fn incremental_sync_url_uses_sync_token() {
        let url = build_events_url("cal-1", Some("sync-token"), Some("page-token")).unwrap();

        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "syncToken").unwrap().1,
            "sync-token"
        );
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "pageToken").unwrap().1,
            "page-token"
        );
    }

    #[test]
    fn applying_events_upserts_timed_events_and_deletes_cancelled_events() {
        let dir = tempfile::tempdir().unwrap();
        let store = CalendarStore::open(dir.path().join("calendar-cache.sqlite")).unwrap();
        let existing = GoogleCalendarEvent {
            id: "evt-1".to_string(),
            summary: Some("Studio A / Old".to_string()),
            description: Some("8".to_string()),
            status: Some("confirmed".to_string()),
            start: Some(GoogleEventDateTime {
                date_time: Some("2026-01-10T09:00:00+01:00".to_string()),
            }),
            end: Some(GoogleEventDateTime {
                date_time: Some("2026-01-10T10:00:00+01:00".to_string()),
            }),
            updated: Some("2026-01-09T12:00:00.000Z".to_string()),
        };
        apply_event(&store, "cal-1", &existing).unwrap();

        let cancelled = GoogleCalendarEvent {
            status: Some("cancelled".to_string()),
            ..existing
        };
        let stats = apply_event(&store, "cal-1", &cancelled).unwrap();

        assert_eq!(stats.deleted, 1);
        assert!(store.list_events("cal-1").unwrap().is_empty());
    }
}
