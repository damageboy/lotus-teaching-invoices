use async_trait::async_trait;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, error::Error as StdError, fmt, time::Duration};
use url::Url;

#[cfg(not(feature = "webdriver"))]
const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const MAX_RATE_LIMIT_RETRIES: usize = 2;
const RATE_LIMIT_BACKOFF_BASE_MS: u64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarApiErrorCode {
    Unauthorized,
    RateLimited,
    PermissionDenied,
    ForbiddenForNonOrganizer,
    Forbidden,
    NotFound,
    Conflict,
    SyncTokenExpired,
    Network,
    InvalidResponse,
    Server,
}

#[derive(Debug)]
pub struct CalendarApiError {
    pub code: CalendarApiErrorCode,
    pub message: String,
}

impl CalendarApiError {
    fn new(code: CalendarApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn preserves_capability(&self) -> bool {
        !matches!(
            self.code,
            CalendarApiErrorCode::Unauthorized | CalendarApiErrorCode::PermissionDenied
        )
    }
}

impl fmt::Display for CalendarApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl StdError for CalendarApiError {}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarListEntry {
    pub id: String,
    #[serde(default)]
    pub summary: String,
    pub access_role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarEvent {
    pub id: String,
    pub etag: Option<String>,
    pub recurring_event_id: Option<String>,
    pub original_start_time: Option<GoogleEventDateTime>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub start: Option<GoogleEventDateTime>,
    pub end: Option<GoogleEventDateTime>,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventDateTime {
    #[serde(rename = "dateTime")]
    pub date_time: Option<String>,
    pub date: Option<String>,
}

impl GoogleEventDateTime {
    pub fn identity_value(&self) -> Option<String> {
        self.date_time.clone().or_else(|| self.date.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarEventsPage {
    #[serde(default)]
    pub items: Vec<GoogleCalendarEvent>,
    pub next_page_token: Option<String>,
    pub next_sync_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalendarEventPatch {
    Summary(String),
    Description(String),
}

impl CalendarEventPatch {
    fn body(&self) -> serde_json::Value {
        match self {
            Self::Summary(summary) => serde_json::json!({ "summary": summary }),
            Self::Description(description) => {
                serde_json::json!({ "description": description })
            }
        }
    }
}

#[async_trait]
pub trait CalendarApi: Send + Sync {
    async fn list_events_page(
        &self,
        access_token: &str,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<GoogleCalendarEventsPage, CalendarApiError>;

    async fn list_calendars(
        &self,
        access_token: &str,
    ) -> Result<Vec<GoogleCalendarListEntry>, CalendarApiError>;

    async fn get_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<GoogleCalendarEvent, CalendarApiError>;

    async fn patch_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
        etag: &str,
        patch: CalendarEventPatch,
    ) -> Result<GoogleCalendarEvent, CalendarApiError>;
}

pub struct GoogleCalendarClient {
    client: reqwest::Client,
    base_url: Url,
}

impl GoogleCalendarClient {
    pub fn new() -> Self {
        #[cfg(feature = "webdriver")]
        {
            let override_value = std::env::var(crate::e2e_support::CALENDAR_API_BASE_ENV).ok();
            Self::new_for_webdriver_override(override_value.as_deref())
                .expect("webdriver Calendar API base was validated during app setup")
        }
        #[cfg(not(feature = "webdriver"))]
        Self {
            client: reqwest::Client::new(),
            base_url: Url::parse(CALENDAR_API_BASE).expect("fixed Calendar API URL is valid"),
        }
    }

    #[cfg(feature = "webdriver")]
    pub(crate) fn new_for_webdriver_override(raw: Option<&str>) -> Result<Self, String> {
        let base_url = crate::e2e_support::validate_calendar_api_base(
            raw.ok_or("LOTUS_E2E_CALENDAR_API_BASE is required")?,
        )?;
        Ok(Self {
            client: reqwest::Client::new(),
            base_url,
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(base_url: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: Url::parse(&base_url).expect("test Calendar API URL is valid"),
        }
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, CalendarApiError> {
        let mut url = self.base_url.clone();
        url.path_segments_mut()
            .map_err(|_| {
                CalendarApiError::new(
                    CalendarApiErrorCode::InvalidResponse,
                    "Calendar API base URL cannot be a base",
                )
            })?
            .extend(segments);
        Ok(url)
    }

    async fn send_with_rate_limit_retry<F>(
        &self,
        make_request: F,
        incremental_event_list: bool,
    ) -> Result<Response, CalendarApiError>
    where
        F: Fn() -> RequestBuilder,
    {
        let mut retries = 0;
        loop {
            let response = make_request().send().await.map_err(|error| {
                CalendarApiError::new(
                    CalendarApiErrorCode::Network,
                    error.without_url().to_string(),
                )
            })?;
            if response.status().is_success() {
                return Ok(response);
            }

            let error = response_error(response, incremental_event_list).await;
            if error.code != CalendarApiErrorCode::RateLimited || retries == MAX_RATE_LIMIT_RETRIES
            {
                return Err(error);
            }
            retries += 1;
            let delay = Duration::from_millis(RATE_LIMIT_BACKOFF_BASE_MS * (1 << (retries - 1)));
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
        }
    }

    async fn decode<T: for<'de> Deserialize<'de>>(
        response: Response,
    ) -> Result<T, CalendarApiError> {
        response.json().await.map_err(|error| {
            CalendarApiError::new(CalendarApiErrorCode::InvalidResponse, error.to_string())
        })
    }
}

impl Default for GoogleCalendarClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCalendarListPage {
    #[serde(default)]
    items: Vec<GoogleCalendarListEntry>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorEnvelope {
    error: Option<GoogleErrorBody>,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorBody {
    message: Option<String>,
    #[serde(default)]
    errors: Vec<GoogleErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorDetail {
    reason: Option<String>,
}

async fn response_error(response: Response, incremental_event_list: bool) -> CalendarApiError {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<GoogleErrorEnvelope>(&body).ok();
    let message = parsed
        .as_ref()
        .and_then(|envelope| envelope.error.as_ref())
        .and_then(|error| error.message.clone())
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| format!("Google Calendar request failed ({status})"));
    let reasons = parsed
        .as_ref()
        .and_then(|envelope| envelope.error.as_ref())
        .map(|error| {
            error
                .errors
                .iter()
                .filter_map(|detail| detail.reason.as_deref())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let code = if status == StatusCode::UNAUTHORIZED {
        CalendarApiErrorCode::Unauthorized
    } else if status == StatusCode::TOO_MANY_REQUESTS
        || (status == StatusCode::FORBIDDEN
            && reasons.iter().any(|reason| {
                matches!(
                    *reason,
                    "userRateLimitExceeded" | "rateLimitExceeded" | "quotaExceeded"
                )
            }))
    {
        CalendarApiErrorCode::RateLimited
    } else if status == StatusCode::FORBIDDEN && reasons.contains(&"forbiddenForNonOrganizer") {
        CalendarApiErrorCode::ForbiddenForNonOrganizer
    } else if status == StatusCode::FORBIDDEN
        && reasons.iter().any(|reason| {
            matches!(
                *reason,
                "insufficientPermissions" | "permissionDenied" | "required"
            )
        })
    {
        CalendarApiErrorCode::PermissionDenied
    } else if status == StatusCode::FORBIDDEN {
        CalendarApiErrorCode::Forbidden
    } else if status == StatusCode::NOT_FOUND {
        CalendarApiErrorCode::NotFound
    } else if status == StatusCode::CONFLICT || status == StatusCode::PRECONDITION_FAILED {
        CalendarApiErrorCode::Conflict
    } else if status == StatusCode::GONE && incremental_event_list {
        CalendarApiErrorCode::SyncTokenExpired
    } else if status.is_server_error() {
        CalendarApiErrorCode::Server
    } else {
        CalendarApiErrorCode::InvalidResponse
    };

    CalendarApiError::new(code, message)
}

#[async_trait]
impl CalendarApi for GoogleCalendarClient {
    async fn list_events_page(
        &self,
        access_token: &str,
        calendar_id: &str,
        sync_token: Option<&str>,
        page_token: Option<&str>,
    ) -> Result<GoogleCalendarEventsPage, CalendarApiError> {
        let mut url = self.endpoint(&["calendars", calendar_id, "events"])?;
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
        let response = self
            .send_with_rate_limit_retry(
                || self.client.get(url.clone()).bearer_auth(access_token),
                sync_token.is_some(),
            )
            .await?;
        Self::decode(response).await
    }

    async fn list_calendars(
        &self,
        access_token: &str,
    ) -> Result<Vec<GoogleCalendarListEntry>, CalendarApiError> {
        let mut calendars = Vec::new();
        let mut page_token: Option<String> = None;
        let mut seen_page_tokens = HashSet::new();
        loop {
            let mut url = self.endpoint(&["users", "me", "calendarList"])?;
            if let Some(token) = page_token.as_deref() {
                url.query_pairs_mut().append_pair("pageToken", token);
            }
            let response = self
                .send_with_rate_limit_retry(
                    || self.client.get(url.clone()).bearer_auth(access_token),
                    false,
                )
                .await?;
            let page: GoogleCalendarListPage = Self::decode(response).await?;
            calendars.extend(page.items);
            page_token = match page.next_page_token {
                None => return Ok(calendars),
                Some(token) if token.trim().is_empty() => {
                    return Err(CalendarApiError::new(
                        CalendarApiErrorCode::InvalidResponse,
                        "Google Calendar calendar-list response contained a blank page token",
                    ));
                }
                Some(token) if !seen_page_tokens.insert(token.clone()) => {
                    return Err(CalendarApiError::new(
                        CalendarApiErrorCode::InvalidResponse,
                        "Google Calendar calendar-list response repeated a page token",
                    ));
                }
                Some(token) => Some(token),
            };
        }
    }

    async fn get_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<GoogleCalendarEvent, CalendarApiError> {
        let url = self.endpoint(&["calendars", calendar_id, "events", event_id])?;
        let response = self
            .send_with_rate_limit_retry(
                || self.client.get(url.clone()).bearer_auth(access_token),
                false,
            )
            .await?;
        Self::decode(response).await
    }

    async fn patch_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
        etag: &str,
        patch: CalendarEventPatch,
    ) -> Result<GoogleCalendarEvent, CalendarApiError> {
        let url = self.endpoint(&["calendars", calendar_id, "events", event_id])?;
        let body = patch.body();
        let response = self
            .send_with_rate_limit_retry(
                || {
                    self.client
                        .patch(url.clone())
                        .bearer_auth(access_token)
                        .header(reqwest::header::IF_MATCH, etag)
                        .json(&body)
                },
                false,
            )
            .await?;
        Self::decode(response).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use httpmock::Method::PATCH;
    use serde_json::json;

    fn client(server: &MockServer) -> GoogleCalendarClient {
        GoogleCalendarClient::new_for_test(format!("{}/calendar/v3", server.base_url()))
    }

    #[cfg(feature = "webdriver")]
    #[test]
    fn webdriver_constructor_accepts_only_the_guarded_loopback_base() {
        let client = GoogleCalendarClient::new_for_webdriver_override(Some(
            "http://127.0.0.1:43127/calendar/v3",
        ))
        .unwrap();
        assert_eq!(
            client.base_url.as_str(),
            "http://127.0.0.1:43127/calendar/v3"
        );
        assert!(GoogleCalendarClient::new_for_webdriver_override(Some(
            "https://www.googleapis.com/calendar/v3"
        ))
        .is_err());
        assert!(GoogleCalendarClient::new_for_webdriver_override(None).is_err());
    }

    fn google_error(reason: &str) -> serde_json::Value {
        json!({
            "error": {
                "code": 403,
                "message": "Google rejected the request",
                "errors": [{ "reason": reason }],
                "status": "PERMISSION_DENIED"
            }
        })
    }

    #[tokio::test]
    async fn event_pages_encode_calendar_ids_and_keep_sync_token_during_pagination() {
        let server = MockServer::start_async().await;
        let time_min = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/work%20%2F%20cal/events")
                    .query_param_exists("timeMin");
                then.status(400);
            })
            .await;
        let time_max = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/work%20%2F%20cal/events")
                    .query_param_exists("timeMax");
                then.status(400);
            })
            .await;
        let second = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/work%20%2F%20cal/events")
                    .query_param("singleEvents", "true")
                    .query_param("maxResults", "250")
                    .query_param("syncToken", "sync + token")
                    .query_param("pageToken", "page + two");
                then.status(200).json_body(json!({
                    "items": [{ "id": "second" }],
                    "nextSyncToken": "next-sync"
                }));
            })
            .await;
        let first = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/work%20%2F%20cal/events")
                    .query_param("singleEvents", "true")
                    .query_param("maxResults", "250")
                    .query_param("syncToken", "sync + token")
                    .header("authorization", "Bearer access-token");
                then.status(200).json_body(json!({
                    "items": [{ "id": "first" }],
                    "nextPageToken": "page + two"
                }));
            })
            .await;

        let client = client(&server);
        let first_page = client
            .list_events_page("access-token", "work / cal", Some("sync + token"), None)
            .await
            .unwrap();
        let second_page = client
            .list_events_page(
                "access-token",
                "work / cal",
                Some("sync + token"),
                first_page.next_page_token.as_deref(),
            )
            .await
            .unwrap();

        assert_eq!(first_page.items[0].id, "first");
        assert_eq!(second_page.items[0].id, "second");
        assert_eq!(second_page.next_sync_token.as_deref(), Some("next-sync"));
        first.assert_async().await;
        second.assert_async().await;
        assert_eq!(time_min.hits_async().await, 0);
        assert_eq!(time_max.hits_async().await, 0);
    }

    #[tokio::test]
    async fn calendar_list_preserves_access_role_and_follows_pages() {
        let server = MockServer::start_async().await;
        let second = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/users/me/calendarList")
                    .query_param("pageToken", "page-2");
                then.status(200).json_body(json!({
                    "items": [{
                        "id": "cal-reader",
                        "summary": "Reader calendar",
                        "accessRole": "reader"
                    }]
                }));
            })
            .await;
        let first = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/users/me/calendarList");
                then.status(200).json_body(json!({
                    "items": [{
                        "id": "cal-owner",
                        "summary": "Owner calendar",
                        "accessRole": "owner"
                    }],
                    "nextPageToken": "page-2"
                }));
            })
            .await;

        let calendars = client(&server)
            .list_calendars("access-token")
            .await
            .unwrap();

        assert_eq!(
            calendars,
            vec![
                GoogleCalendarListEntry {
                    id: "cal-owner".to_string(),
                    summary: "Owner calendar".to_string(),
                    access_role: "owner".to_string(),
                },
                GoogleCalendarListEntry {
                    id: "cal-reader".to_string(),
                    summary: "Reader calendar".to_string(),
                    access_role: "reader".to_string(),
                },
            ]
        );
        first.assert_async().await;
        second.assert_async().await;
    }

    #[tokio::test]
    async fn calendar_list_rejects_a_blank_next_page_token_without_looping() {
        let server = MockServer::start_async().await;
        let request = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/users/me/calendarList");
                then.status(200)
                    .delay(Duration::from_millis(5))
                    .json_body(json!({ "nextPageToken": " " }));
            })
            .await;

        let error = tokio::time::timeout(
            Duration::from_secs(1),
            client(&server).list_calendars("access-token"),
        )
        .await
        .expect("blank pagination must stop without another request")
        .unwrap_err();

        assert_eq!(error.code, CalendarApiErrorCode::InvalidResponse);
        assert_eq!(request.hits_async().await, 1);
    }

    #[tokio::test]
    async fn calendar_list_rejects_a_repeated_next_page_token_without_looping() {
        let server = MockServer::start_async().await;
        let repeated = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/users/me/calendarList")
                    .query_param("pageToken", "page-2");
                then.status(200)
                    .delay(Duration::from_millis(5))
                    .json_body(json!({ "nextPageToken": "page-2" }));
            })
            .await;
        let first = server
            .mock_async(|when, then| {
                when.method(GET).path("/calendar/v3/users/me/calendarList");
                then.status(200)
                    .json_body(json!({ "nextPageToken": "page-2" }));
            })
            .await;

        let error = tokio::time::timeout(
            Duration::from_secs(1),
            client(&server).list_calendars("access-token"),
        )
        .await
        .expect("repeated pagination must stop without a third request")
        .unwrap_err();

        assert_eq!(error.code, CalendarApiErrorCode::InvalidResponse);
        assert_eq!(first.hits_async().await, 1);
        assert_eq!(repeated.hits_async().await, 1);
    }

    #[tokio::test]
    async fn get_event_loads_the_encoded_master_event() {
        let server = MockServer::start_async().await;
        let request = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/work%20cal/events/master%2Fid")
                    .header("authorization", "Bearer access-token");
                then.status(200).json_body(json!({
                    "id": "master/id",
                    "etag": "etag-master",
                    "summary": "Studio A / Pilates"
                }));
            })
            .await;

        let event = client(&server)
            .get_event("access-token", "work cal", "master/id")
            .await
            .unwrap();

        assert_eq!(event.id, "master/id");
        assert_eq!(event.etag.as_deref(), Some("etag-master"));
        request.assert_async().await;
    }

    #[tokio::test]
    async fn patch_summary_sends_only_summary_and_the_exact_etag() {
        let server = MockServer::start_async().await;
        let request = server
            .mock_async(|when, then| {
                when.method(PATCH)
                    .path("/calendar/v3/calendars/cal-1/events/event-1")
                    .header("if-match", "\"etag exact\"")
                    .header("content-type", "application/json")
                    .json_body(json!({ "summary": "Studio B / Pilates" }));
                then.status(200).json_body(json!({
                    "id": "event-1",
                    "etag": "etag-new",
                    "summary": "Studio B / Pilates"
                }));
            })
            .await;

        client(&server)
            .patch_event(
                "access-token",
                "cal-1",
                "event-1",
                "\"etag exact\"",
                CalendarEventPatch::Summary("Studio B / Pilates".to_string()),
            )
            .await
            .unwrap();

        request.assert_async().await;
    }

    #[tokio::test]
    async fn patch_description_sends_only_description() {
        let server = MockServer::start_async().await;
        let request = server
            .mock_async(|when, then| {
                when.method(PATCH)
                    .path("/calendar/v3/calendars/cal-1/events/event-1")
                    .json_body(json!({ "description": "12/30EUR" }));
                then.status(200).json_body(json!({
                    "id": "event-1",
                    "etag": "etag-new",
                    "description": "12/30EUR"
                }));
            })
            .await;

        client(&server)
            .patch_event(
                "access-token",
                "cal-1",
                "event-1",
                "etag-old",
                CalendarEventPatch::Description("12/30EUR".to_string()),
            )
            .await
            .unwrap();

        request.assert_async().await;
    }

    #[tokio::test]
    async fn maps_auth_permission_and_not_found_errors() {
        let cases = [
            (401, json!({}), CalendarApiErrorCode::Unauthorized, false),
            (
                403,
                google_error("insufficientPermissions"),
                CalendarApiErrorCode::PermissionDenied,
                false,
            ),
            (
                403,
                google_error("forbiddenForNonOrganizer"),
                CalendarApiErrorCode::ForbiddenForNonOrganizer,
                true,
            ),
            (404, json!({}), CalendarApiErrorCode::NotFound, true),
        ];

        for (status, body, expected_code, preserves_capability) in cases {
            let server = MockServer::start_async().await;
            server
                .mock_async(|when, then| {
                    when.method(GET)
                        .path("/calendar/v3/calendars/cal/events/event");
                    then.status(status).json_body(body.clone());
                })
                .await;

            let error = client(&server)
                .get_event("token", "cal", "event")
                .await
                .unwrap_err();

            assert_eq!(error.code, expected_code);
            assert_eq!(error.preserves_capability(), preserves_capability);
        }
    }

    #[tokio::test]
    async fn maps_literal_permission_denied_reason_to_permission_denied() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal/events/event");
                then.status(403).json_body(google_error("permissionDenied"));
            })
            .await;

        let error = client(&server)
            .get_event("token", "cal", "event")
            .await
            .unwrap_err();

        assert_eq!(error.code, CalendarApiErrorCode::PermissionDenied);
    }

    #[tokio::test]
    async fn maps_conflicts_without_retrying() {
        for status in [409, 412] {
            let server = MockServer::start_async().await;
            let request = server
                .mock_async(|when, then| {
                    when.method(PATCH)
                        .path("/calendar/v3/calendars/cal/events/event");
                    then.status(status).json_body(json!({}));
                })
                .await;

            let error = client(&server)
                .patch_event(
                    "token",
                    "cal",
                    "event",
                    "etag",
                    CalendarEventPatch::Summary("changed".to_string()),
                )
                .await
                .unwrap_err();

            assert_eq!(error.code, CalendarApiErrorCode::Conflict);
            assert_eq!(request.hits_async().await, 1);
        }
    }

    #[tokio::test]
    async fn retries_only_explicit_rate_and_quota_errors_with_a_bound() {
        for (status, body) in [
            (403, google_error("userRateLimitExceeded")),
            (403, google_error("rateLimitExceeded")),
            (403, google_error("quotaExceeded")),
            (429, json!({})),
        ] {
            let server = MockServer::start_async().await;
            let request = server
                .mock_async(|when, then| {
                    when.method(GET)
                        .path("/calendar/v3/calendars/cal/events/event");
                    then.status(status).json_body(body.clone());
                })
                .await;

            let error = client(&server)
                .get_event("token", "cal", "event")
                .await
                .unwrap_err();

            assert_eq!(error.code, CalendarApiErrorCode::RateLimited);
            assert!(error.preserves_capability());
            assert_eq!(request.hits_async().await, 3);
        }
    }

    #[tokio::test]
    async fn quota_reason_does_not_override_non_forbidden_status_or_trigger_retry() {
        for (status, expected_code) in [
            (404, CalendarApiErrorCode::NotFound),
            (500, CalendarApiErrorCode::Server),
        ] {
            let server = MockServer::start_async().await;
            let request = server
                .mock_async(|when, then| {
                    when.method(GET)
                        .path("/calendar/v3/calendars/cal/events/event");
                    then.status(status).json_body(google_error("quotaExceeded"));
                })
                .await;

            let error = client(&server)
                .get_event("token", "cal", "event")
                .await
                .unwrap_err();

            assert_eq!(request.hits_async().await, 1);
            assert_eq!(error.code, expected_code);
        }
    }

    #[tokio::test]
    async fn maps_incremental_410_to_sync_token_expired() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/calendar/v3/calendars/cal/events")
                    .query_param("syncToken", "old-token");
                then.status(410).json_body(json!({}));
            })
            .await;

        let error = client(&server)
            .list_events_page("token", "cal", Some("old-token"), None)
            .await
            .unwrap_err();

        assert_eq!(error.code, CalendarApiErrorCode::SyncTokenExpired);
    }

    #[tokio::test]
    async fn maps_transport_failure_to_network_without_application_retry() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_millis(100);
            let mut extra_connections = 0;
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        extra_connections += 1;
                        drop(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::yield_now();
                    }
                    Err(error) => panic!("failed to observe retry connections: {error}"),
                }
            }
            1 + extra_connections
        });
        let base_url = format!("http://{address}/calendar/v3");
        let client = GoogleCalendarClient::new_for_test(base_url.clone());

        let error = client
            .list_events_page(
                "access-token",
                "cal",
                Some("secret-sync-token"),
                Some("secret-page-token"),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, CalendarApiErrorCode::Network);
        let message = error.to_string();
        assert!(!message.contains("secret-sync-token"));
        assert!(!message.contains("secret-page-token"));
        assert!(!message.contains("syncToken"));
        assert!(!message.contains("pageToken"));
        assert!(!message.contains(&base_url));
        assert_eq!(accepted.join().unwrap(), 1);
    }
}
