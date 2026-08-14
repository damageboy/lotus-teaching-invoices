use crate::calendar_api::{
    CalendarApi, CalendarApiError, CalendarApiErrorCode, CalendarEventPatch, GoogleCalendarEvent,
};
use crate::calendar_store::{CalendarStore, StoredCalendarEvent};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventIdentity {
    pub calendar_id: String,
    pub event_id: String,
    pub recurring_event_id: Option<String>,
    pub original_start_time: Option<String>,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceStudioEditRequest {
    pub identity: CalendarEventIdentity,
    pub studio_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceStudioEditPreflight {
    pub identity: CalendarEventIdentity,
    pub current_summary: String,
    pub proposed_summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStudioEditRequest {
    pub selected_identity: CalendarEventIdentity,
    pub studio_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStudioEditPreflight {
    pub calendar_id: String,
    pub selected_event_id: String,
    pub master_event_id: String,
    pub master_etag: String,
    pub current_summary: String,
    pub proposed_summary: String,
    pub instance_count: usize,
    pub title_exception_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStudioEditApplied {
    pub calendar_id: String,
    pub master_event_id: String,
    pub proposed_summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStudioEditResult {
    pub applied: SeriesStudioEditApplied,
    pub reconciliation_pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum OccurrenceValueEditOperation {
    SetStudents {
        #[serde(rename = "studentCount")]
        student_count: u64,
    },
    SetEuroOverride {
        #[serde(rename = "studentCount")]
        student_count: u64,
        #[serde(rename = "euroOverride")]
        euro_override: String,
    },
    UseConfiguredRate {
        #[serde(rename = "studentCount")]
        student_count: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceValueEditRequest {
    pub identity: CalendarEventIdentity,
    #[serde(flatten)]
    pub operation: OccurrenceValueEditOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceValueEditPreflight {
    pub identity: CalendarEventIdentity,
    pub current_description: String,
    pub proposed_description: String,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEditedEvent {
    pub identity: CalendarEventIdentity,
    pub summary: String,
    pub description: String,
    pub start: String,
    pub end: String,
    pub status: String,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarEditErrorCode {
    InvalidRequest,
    ReadOnly,
    NotFound,
    Conflict,
    Unauthorized,
    PermissionDenied,
    RateLimited,
    Network,
    GoogleError,
    LocalError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEditCommandError {
    pub code: CalendarEditErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl CalendarEditCommandError {
    fn new(code: CalendarEditErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

impl From<CalendarApiError> for CalendarEditCommandError {
    fn from(error: CalendarApiError) -> Self {
        let (code, retryable) = match error.code {
            CalendarApiErrorCode::Unauthorized => (CalendarEditErrorCode::Unauthorized, false),
            CalendarApiErrorCode::PermissionDenied
            | CalendarApiErrorCode::ForbiddenForNonOrganizer
            | CalendarApiErrorCode::Forbidden => (CalendarEditErrorCode::PermissionDenied, false),
            CalendarApiErrorCode::RateLimited => (CalendarEditErrorCode::RateLimited, true),
            CalendarApiErrorCode::NotFound => (CalendarEditErrorCode::NotFound, false),
            CalendarApiErrorCode::Conflict => (CalendarEditErrorCode::Conflict, true),
            CalendarApiErrorCode::Network | CalendarApiErrorCode::Server => {
                (CalendarEditErrorCode::Network, true)
            }
            CalendarApiErrorCode::SyncTokenExpired | CalendarApiErrorCode::InvalidResponse => {
                (CalendarEditErrorCode::GoogleError, false)
            }
        };
        Self::new(code, error.message, retryable)
    }
}

fn rewrite_studio_summary(
    summary: &str,
    studio_name: &str,
) -> Result<String, CalendarEditCommandError> {
    let parts = summary.split('/').collect::<Vec<_>>();
    let studio_name = studio_name.trim();
    if !matches!(parts.len(), 2 | 3)
        || parts.iter().any(|part| part.trim().is_empty())
        || studio_name.is_empty()
        || studio_name.contains('/')
    {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::InvalidRequest,
            "This event title is not in a supported studio/class format",
            false,
        ));
    }
    let slash = summary
        .find('/')
        .expect("validated summary contains a slash");
    let whitespace = summary[..slash]
        .chars()
        .rev()
        .take_while(|character| character.is_whitespace())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Ok(format!("{studio_name}{whitespace}{}", &summary[slash..]))
}

fn validate_identity(identity: &CalendarEventIdentity) -> Result<&str, CalendarEditCommandError> {
    if identity.calendar_id.trim().is_empty() || identity.event_id.trim().is_empty() {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::InvalidRequest,
            "This lesson is missing its Google Calendar identity",
            false,
        ));
    }
    identity
        .etag
        .as_deref()
        .filter(|etag| !etag.trim().is_empty())
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::InvalidRequest,
                "Refresh the calendar before editing this lesson",
                false,
            )
        })
}

fn supported_description_override(description: &str) -> Option<Option<&str>> {
    let trimmed = description.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(None);
    }
    let (students, override_part) = trimmed.split_once('/')?;
    if students.trim().is_empty()
        || !students.trim().bytes().all(|byte| byte.is_ascii_digit())
        || override_part.contains('/')
    {
        return None;
    }
    let override_part = override_part.trim();
    if override_part.len() < 4
        || !override_part[override_part.len() - 3..].eq_ignore_ascii_case("EUR")
    {
        return None;
    }
    let amount = override_part[..override_part.len() - 3].trim();
    let mut pieces = amount.split('.');
    let whole = pieces.next().unwrap_or_default();
    let fraction = pieces.next();
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.is_some_and(|value| {
            value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit())
        })
        || pieces.next().is_some()
    {
        return None;
    }
    Some(Some(amount))
}

fn valid_student_count(student_count: u64) -> Result<u64, CalendarEditCommandError> {
    if student_count == 0 || student_count > 9_007_199_254_740_991 {
        Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::InvalidRequest,
            "Students must be a positive whole number",
            false,
        ))
    } else {
        Ok(student_count)
    }
}

fn canonical_euro_override(value: &str) -> Result<String, CalendarEditCommandError> {
    let mut pieces = value.split('.');
    let whole = pieces.next().unwrap_or_default();
    let fraction = pieces.next();
    let valid_whole = whole == "0"
        || (!whole.starts_with('0') && whole.bytes().all(|byte| byte.is_ascii_digit()));
    let valid_fraction = fraction.map_or(true, |part| {
        matches!(part.len(), 1 | 2) && part.bytes().all(|byte| byte.is_ascii_digit())
    });
    if !valid_whole || whole.is_empty() || !valid_fraction || pieces.next().is_some() {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::InvalidRequest,
            "Euros must be a non-negative amount with at most two decimals",
            false,
        ));
    }
    let raw_fraction = fraction.unwrap_or_default();
    let canonical_fraction = raw_fraction.trim_end_matches('0');
    let canonical = if canonical_fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{canonical_fraction}")
    };
    let cents_fraction = match raw_fraction.len() {
        0 => "00".to_string(),
        1 => format!("{raw_fraction}0"),
        _ => raw_fraction.to_string(),
    };
    let cents = format!("{whole}{cents_fraction}");
    if cents
        .parse::<u64>()
        .map_or(true, |value| value > 9_007_199_254_740_991)
    {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::InvalidRequest,
            "Euro amount is too large",
            false,
        ));
    }
    Ok(canonical)
}

async fn require_writable_calendar(
    api: &impl CalendarApi,
    access_token: &str,
    calendar_id: &str,
) -> Result<(), CalendarEditCommandError> {
    let calendars = api.list_calendars(access_token).await?;
    let role = calendars
        .iter()
        .find(|calendar| calendar.id == calendar_id)
        .map(|calendar| calendar.access_role.as_str());
    if matches!(role, Some("owner" | "writer")) {
        Ok(())
    } else {
        Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::ReadOnly,
            "You only have read access to this calendar",
            false,
        ))
    }
}

pub async fn preflight_occurrence_studio_edit(
    store: &CalendarStore,
    api: &impl CalendarApi,
    access_token: &str,
    request: OccurrenceStudioEditRequest,
) -> Result<OccurrenceStudioEditPreflight, CalendarEditCommandError> {
    let requested_etag = validate_identity(&request.identity)?;
    require_writable_calendar(api, access_token, &request.identity.calendar_id).await?;
    let cached = store
        .event(&request.identity.calendar_id, &request.identity.event_id)
        .map_err(|error| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::LocalError,
                error.to_string(),
                true,
            )
        })?
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::NotFound,
                "This lesson is no longer in the calendar cache",
                false,
            )
        })?;
    if cached.etag.as_deref() != Some(requested_etag) {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::Conflict,
            "This lesson changed. Refresh the calendar and try again.",
            true,
        ));
    }
    let proposed_summary = rewrite_studio_summary(&cached.summary, &request.studio_name)?;
    Ok(OccurrenceStudioEditPreflight {
        identity: request.identity,
        current_summary: cached.summary,
        proposed_summary,
    })
}

pub async fn apply_occurrence_studio_edit(
    store: &CalendarStore,
    api: &impl CalendarApi,
    access_token: &str,
    preflight: OccurrenceStudioEditPreflight,
) -> Result<CalendarEditedEvent, CalendarEditCommandError> {
    let etag = validate_identity(&preflight.identity)?;
    require_writable_calendar(api, access_token, &preflight.identity.calendar_id).await?;
    let cached = store
        .event(
            &preflight.identity.calendar_id,
            &preflight.identity.event_id,
        )
        .map_err(|error| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::LocalError,
                error.to_string(),
                true,
            )
        })?
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::NotFound,
                "This lesson is no longer in the calendar cache",
                false,
            )
        })?;
    if cached.etag.as_deref() != Some(etag) || cached.summary != preflight.current_summary {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::Conflict,
            "This lesson changed. Refresh the calendar and try again.",
            true,
        ));
    }

    let response = api
        .patch_event(
            access_token,
            &preflight.identity.calendar_id,
            &preflight.identity.event_id,
            etag,
            CalendarEventPatch::Summary(preflight.proposed_summary),
        )
        .await?;
    let stored = stored_event_from_google(&preflight.identity.calendar_id, response)?;
    if stored.event_id != preflight.identity.event_id {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::GoogleError,
            "Google Calendar returned a different lesson",
            false,
        ));
    }
    store.upsert_event(&stored).map_err(|error| {
        CalendarEditCommandError::new(CalendarEditErrorCode::LocalError, error.to_string(), true)
    })?;
    Ok(edited_event(stored))
}

pub async fn preflight_series_studio_edit(
    store: &CalendarStore,
    api: &impl CalendarApi,
    access_token: &str,
    request: SeriesStudioEditRequest,
) -> Result<SeriesStudioEditPreflight, CalendarEditCommandError> {
    let selected_etag = validate_identity(&request.selected_identity)?;
    let master_event_id = request
        .selected_identity
        .recurring_event_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::InvalidRequest,
                "This lesson is not part of a recurring series",
                false,
            )
        })?;
    require_writable_calendar(api, access_token, &request.selected_identity.calendar_id).await?;
    let selected = store
        .event(
            &request.selected_identity.calendar_id,
            &request.selected_identity.event_id,
        )
        .map_err(|error| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::LocalError,
                error.to_string(),
                true,
            )
        })?
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::NotFound,
                "This lesson is no longer in the calendar cache",
                false,
            )
        })?;
    if selected.etag.as_deref() != Some(selected_etag)
        || selected.recurring_event_id.as_deref() != Some(master_event_id)
    {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::Conflict,
            "This lesson changed. Refresh the calendar and try again.",
            true,
        ));
    }
    let instances = store
        .list_series_instances(&request.selected_identity.calendar_id, master_event_id)
        .map_err(|error| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::LocalError,
                error.to_string(),
                true,
            )
        })?;
    if instances.is_empty() {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::NotFound,
            "No loaded lessons belong to this recurring series",
            false,
        ));
    }
    let master = api
        .get_event(
            access_token,
            &request.selected_identity.calendar_id,
            master_event_id,
        )
        .await?;
    let master_etag = master
        .etag
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::GoogleError,
                "Google Calendar returned a series without an ETag",
                false,
            )
        })?;
    if master.id != master_event_id {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::GoogleError,
            "Google Calendar returned a different recurring series",
            false,
        ));
    }
    let current_summary = master.summary.ok_or_else(|| {
        CalendarEditCommandError::new(
            CalendarEditErrorCode::GoogleError,
            "Google Calendar returned a series without a title",
            false,
        )
    })?;
    let proposed_summary = rewrite_studio_summary(&current_summary, &request.studio_name)?;
    let title_exception_count = instances
        .iter()
        .filter(|instance| instance.summary != current_summary)
        .count();
    Ok(SeriesStudioEditPreflight {
        calendar_id: request.selected_identity.calendar_id,
        selected_event_id: request.selected_identity.event_id,
        master_event_id: master_event_id.to_string(),
        master_etag,
        current_summary,
        proposed_summary,
        instance_count: instances.len(),
        title_exception_count,
    })
}

pub async fn apply_series_studio_edit(
    _store: &CalendarStore,
    api: &impl CalendarApi,
    access_token: &str,
    preflight: SeriesStudioEditPreflight,
) -> Result<SeriesStudioEditApplied, CalendarEditCommandError> {
    require_writable_calendar(api, access_token, &preflight.calendar_id).await?;
    let current = api
        .get_event(
            access_token,
            &preflight.calendar_id,
            &preflight.master_event_id,
        )
        .await?;
    if current.id != preflight.master_event_id
        || current.etag.as_deref() != Some(preflight.master_etag.as_str())
        || current.summary.as_deref() != Some(preflight.current_summary.as_str())
    {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::Conflict,
            "This recurring series changed. Refresh the calendar and try again.",
            true,
        ));
    }
    let response = api
        .patch_event(
            access_token,
            &preflight.calendar_id,
            &preflight.master_event_id,
            &preflight.master_etag,
            CalendarEventPatch::Summary(preflight.proposed_summary.clone()),
        )
        .await?;
    if response.id != preflight.master_event_id
        || response.summary.as_deref() != Some(preflight.proposed_summary.as_str())
    {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::GoogleError,
            "Google Calendar returned an unexpected recurring series",
            false,
        ));
    }
    Ok(SeriesStudioEditApplied {
        calendar_id: preflight.calendar_id,
        master_event_id: preflight.master_event_id,
        proposed_summary: preflight.proposed_summary,
    })
}

pub async fn preflight_occurrence_value_edit(
    store: &CalendarStore,
    api: &impl CalendarApi,
    access_token: &str,
    request: OccurrenceValueEditRequest,
) -> Result<OccurrenceValueEditPreflight, CalendarEditCommandError> {
    let requested_etag = validate_identity(&request.identity)?;
    require_writable_calendar(api, access_token, &request.identity.calendar_id).await?;
    let cached = store
        .event(&request.identity.calendar_id, &request.identity.event_id)
        .map_err(|error| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::LocalError,
                error.to_string(),
                true,
            )
        })?
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::NotFound,
                "This lesson is no longer in the calendar cache",
                false,
            )
        })?;
    if cached.etag.as_deref() != Some(requested_etag) {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::Conflict,
            "This lesson changed. Refresh the calendar and try again.",
            true,
        ));
    }

    let supported = supported_description_override(&cached.description);
    let requires_confirmation = supported.is_none();
    let proposed_description = match request.operation {
        OccurrenceValueEditOperation::SetStudents { student_count } => {
            let student_count = valid_student_count(student_count)?;
            match supported.flatten() {
                Some(euros) => format!("{student_count}/{euros}EUR"),
                None => student_count.to_string(),
            }
        }
        OccurrenceValueEditOperation::SetEuroOverride {
            student_count,
            euro_override,
        } => format!(
            "{}/{}EUR",
            valid_student_count(student_count)?,
            canonical_euro_override(&euro_override)?
        ),
        OccurrenceValueEditOperation::UseConfiguredRate { student_count } => {
            valid_student_count(student_count)?.to_string()
        }
    };

    Ok(OccurrenceValueEditPreflight {
        identity: request.identity,
        current_description: cached.description,
        proposed_description,
        requires_confirmation,
    })
}

pub async fn apply_occurrence_value_edit(
    store: &CalendarStore,
    api: &impl CalendarApi,
    access_token: &str,
    preflight: OccurrenceValueEditPreflight,
    confirm_unsupported_replacement: bool,
) -> Result<CalendarEditedEvent, CalendarEditCommandError> {
    let etag = validate_identity(&preflight.identity)?;
    if preflight.requires_confirmation && !confirm_unsupported_replacement {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::InvalidRequest,
            "Confirm replacement of the existing calendar description",
            false,
        ));
    }
    require_writable_calendar(api, access_token, &preflight.identity.calendar_id).await?;
    let cached = store
        .event(
            &preflight.identity.calendar_id,
            &preflight.identity.event_id,
        )
        .map_err(|error| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::LocalError,
                error.to_string(),
                true,
            )
        })?
        .ok_or_else(|| {
            CalendarEditCommandError::new(
                CalendarEditErrorCode::NotFound,
                "This lesson is no longer in the calendar cache",
                false,
            )
        })?;
    if cached.etag.as_deref() != Some(etag) || cached.description != preflight.current_description {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::Conflict,
            "This lesson changed. Refresh the calendar and try again.",
            true,
        ));
    }

    let response = api
        .patch_event(
            access_token,
            &preflight.identity.calendar_id,
            &preflight.identity.event_id,
            etag,
            CalendarEventPatch::Description(preflight.proposed_description),
        )
        .await?;
    let stored = stored_event_from_google(&preflight.identity.calendar_id, response)?;
    if stored.event_id != preflight.identity.event_id {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::GoogleError,
            "Google Calendar returned a different lesson",
            false,
        ));
    }
    store.upsert_event(&stored).map_err(|error| {
        CalendarEditCommandError::new(CalendarEditErrorCode::LocalError, error.to_string(), true)
    })?;
    Ok(edited_event(stored))
}

fn stored_event_from_google(
    calendar_id: &str,
    event: GoogleCalendarEvent,
) -> Result<StoredCalendarEvent, CalendarEditCommandError> {
    let start = event.start.and_then(|value| value.date_time);
    let end = event.end.and_then(|value| value.date_time);
    let summary = event.summary;
    let etag = event.etag;
    if event.id.trim().is_empty()
        || start.is_none()
        || end.is_none()
        || summary.is_none()
        || etag
            .as_deref()
            .map_or(true, |value| value.trim().is_empty())
    {
        return Err(CalendarEditCommandError::new(
            CalendarEditErrorCode::GoogleError,
            "Google Calendar returned an incomplete lesson",
            false,
        ));
    }
    Ok(StoredCalendarEvent {
        calendar_id: calendar_id.to_string(),
        event_id: event.id,
        recurring_event_id: event.recurring_event_id,
        original_start_time: event
            .original_start_time
            .and_then(|value| value.identity_value()),
        etag,
        summary: summary.expect("validated summary"),
        description: event.description.unwrap_or_default(),
        start_ts: start.expect("validated start"),
        end_ts: end.expect("validated end"),
        updated_ts: event.updated,
        status: event.status.unwrap_or_else(|| "confirmed".to_string()),
    })
}

fn edited_event(event: StoredCalendarEvent) -> CalendarEditedEvent {
    CalendarEditedEvent {
        identity: CalendarEventIdentity {
            calendar_id: event.calendar_id,
            event_id: event.event_id,
            recurring_event_id: event.recurring_event_id,
            original_start_time: event.original_start_time,
            etag: event.etag,
        },
        summary: event.summary,
        description: event.description,
        start: event.start_ts,
        end: event.end_ts,
        status: event.status,
        updated: event.updated_ts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar_api::{
        CalendarApi, CalendarApiError, CalendarEventPatch, GoogleCalendarEvent,
        GoogleCalendarEventsPage, GoogleCalendarListEntry, GoogleEventDateTime,
    };
    use crate::calendar_store::{CalendarStore, StoredCalendarEvent};
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct FakeCalendarApi {
        calendars: Vec<GoogleCalendarListEntry>,
        patched: Mutex<Vec<(String, String, String, CalendarEventPatch)>>,
    }

    #[async_trait]
    impl CalendarApi for FakeCalendarApi {
        async fn list_events_page(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _sync_token: Option<&str>,
            _page_token: Option<&str>,
        ) -> Result<GoogleCalendarEventsPage, CalendarApiError> {
            unreachable!()
        }

        async fn list_calendars(
            &self,
            _access_token: &str,
        ) -> Result<Vec<GoogleCalendarListEntry>, CalendarApiError> {
            Ok(self.calendars.clone())
        }

        async fn get_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            event_id: &str,
        ) -> Result<GoogleCalendarEvent, CalendarApiError> {
            assert_eq!(event_id, "series-master");
            Ok(GoogleCalendarEvent {
                id: event_id.to_string(),
                etag: Some("master-etag".to_string()),
                recurring_event_id: None,
                original_start_time: None,
                summary: Some("Old Studio / Flow".to_string()),
                description: Some("8".to_string()),
                status: Some("confirmed".to_string()),
                start: Some(GoogleEventDateTime {
                    date_time: Some("2026-08-16T09:00:00+02:00".to_string()),
                    date: None,
                }),
                end: Some(GoogleEventDateTime {
                    date_time: Some("2026-08-16T10:00:00+02:00".to_string()),
                    date: None,
                }),
                updated: Some("2026-08-15T12:00:00Z".to_string()),
            })
        }

        async fn patch_event(
            &self,
            _access_token: &str,
            calendar_id: &str,
            event_id: &str,
            etag: &str,
            patch: CalendarEventPatch,
        ) -> Result<GoogleCalendarEvent, CalendarApiError> {
            self.patched.lock().unwrap().push((
                calendar_id.to_string(),
                event_id.to_string(),
                etag.to_string(),
                patch.clone(),
            ));
            let (summary, description) = match patch {
                CalendarEventPatch::Summary(summary) => (summary, "5".to_string()),
                CalendarEventPatch::Description(description) => {
                    ("Old Studio / Flow".to_string(), description)
                }
            };
            Ok(GoogleCalendarEvent {
                id: event_id.to_string(),
                etag: Some("etag-new".to_string()),
                recurring_event_id: None,
                original_start_time: None,
                summary: Some(summary),
                description: Some(description),
                status: Some("confirmed".to_string()),
                start: Some(GoogleEventDateTime {
                    date_time: Some("2026-08-16T09:00:00+02:00".to_string()),
                    date: None,
                }),
                end: Some(GoogleEventDateTime {
                    date_time: Some("2026-08-16T10:00:00+02:00".to_string()),
                    date: None,
                }),
                updated: Some("2026-08-15T12:00:00Z".to_string()),
            })
        }
    }

    fn store() -> CalendarStore {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "lotus-calendar-edit-{}-{id}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        CalendarStore::open(path).unwrap()
    }

    fn cached_event() -> StoredCalendarEvent {
        StoredCalendarEvent {
            calendar_id: "calendar-1".to_string(),
            event_id: "instance-1".to_string(),
            recurring_event_id: None,
            original_start_time: None,
            etag: Some("etag-old".to_string()),
            summary: "Old Studio / Flow".to_string(),
            description: "5".to_string(),
            start_ts: "2026-08-16T09:00:00+02:00".to_string(),
            end_ts: "2026-08-16T10:00:00+02:00".to_string(),
            updated_ts: Some("2026-08-01T12:00:00Z".to_string()),
            status: "confirmed".to_string(),
        }
    }

    fn api(access_role: &str) -> FakeCalendarApi {
        FakeCalendarApi {
            calendars: vec![GoogleCalendarListEntry {
                id: "calendar-1".to_string(),
                summary: "Teaching".to_string(),
                access_role: access_role.to_string(),
            }],
            patched: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn occurrence_studio_update_targets_the_instance_and_exact_etag() {
        let store = store();
        store.upsert_event(&cached_event()).unwrap();
        let api = api("owner");
        let request = OccurrenceStudioEditRequest {
            identity: CalendarEventIdentity {
                calendar_id: "calendar-1".to_string(),
                event_id: "instance-1".to_string(),
                recurring_event_id: None,
                original_start_time: None,
                etag: Some("etag-old".to_string()),
            },
            studio_name: "New Studio".to_string(),
        };

        let preflight = preflight_occurrence_studio_edit(&store, &api, "token", request)
            .await
            .unwrap();
        assert_eq!(preflight.current_summary, "Old Studio / Flow");
        assert_eq!(preflight.proposed_summary, "New Studio / Flow");

        let saved = apply_occurrence_studio_edit(&store, &api, "token", preflight)
            .await
            .unwrap();

        assert_eq!(saved.summary, "New Studio / Flow");
        assert_eq!(saved.identity.event_id, "instance-1");
        assert_eq!(saved.identity.etag.as_deref(), Some("etag-new"));
        assert_eq!(
            api.patched.into_inner().unwrap(),
            vec![(
                "calendar-1".to_string(),
                "instance-1".to_string(),
                "etag-old".to_string(),
                CalendarEventPatch::Summary("New Studio / Flow".to_string()),
            )]
        );
        assert_eq!(
            store
                .event("calendar-1", "instance-1")
                .unwrap()
                .unwrap()
                .summary,
            "New Studio / Flow"
        );
    }

    #[tokio::test]
    async fn occurrence_studio_preflight_rejects_a_read_only_calendar() {
        let store = store();
        store.upsert_event(&cached_event()).unwrap();
        let error = preflight_occurrence_studio_edit(
            &store,
            &api("reader"),
            "token",
            OccurrenceStudioEditRequest {
                identity: CalendarEventIdentity {
                    calendar_id: "calendar-1".to_string(),
                    event_id: "instance-1".to_string(),
                    recurring_event_id: None,
                    original_start_time: None,
                    etag: Some("etag-old".to_string()),
                },
                studio_name: "New Studio".to_string(),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, CalendarEditErrorCode::ReadOnly);
        assert!(api("reader").patched.into_inner().unwrap().is_empty());
    }

    #[tokio::test]
    async fn occurrence_student_update_preserves_override_and_uses_exact_etag() {
        let store = store();
        let mut event = cached_event();
        event.description = "5 / 30.50 eur".to_string();
        store.upsert_event(&event).unwrap();
        let api = api("writer");

        let preflight = preflight_occurrence_value_edit(
            &store,
            &api,
            "token",
            OccurrenceValueEditRequest {
                identity: CalendarEventIdentity {
                    calendar_id: "calendar-1".to_string(),
                    event_id: "instance-1".to_string(),
                    recurring_event_id: None,
                    original_start_time: None,
                    etag: Some("etag-old".to_string()),
                },
                operation: OccurrenceValueEditOperation::SetStudents { student_count: 12 },
            },
        )
        .await
        .unwrap();

        assert_eq!(preflight.current_description, "5 / 30.50 eur");
        assert_eq!(preflight.proposed_description, "12/30.50EUR");
        assert!(!preflight.requires_confirmation);

        let saved = apply_occurrence_value_edit(&store, &api, "token", preflight, false)
            .await
            .unwrap();
        assert_eq!(saved.description, "12/30.50EUR");
        assert_eq!(
            api.patched.into_inner().unwrap(),
            vec![(
                "calendar-1".to_string(),
                "instance-1".to_string(),
                "etag-old".to_string(),
                CalendarEventPatch::Description("12/30.50EUR".to_string()),
            )]
        );
    }

    #[tokio::test]
    async fn unsupported_description_requires_explicit_confirmation() {
        let store = store();
        let mut event = cached_event();
        event.description = "students: 5".to_string();
        store.upsert_event(&event).unwrap();
        let api = api("owner");

        let preflight = preflight_occurrence_value_edit(
            &store,
            &api,
            "token",
            OccurrenceValueEditRequest {
                identity: CalendarEventIdentity {
                    calendar_id: "calendar-1".to_string(),
                    event_id: "instance-1".to_string(),
                    recurring_event_id: None,
                    original_start_time: None,
                    etag: Some("etag-old".to_string()),
                },
                operation: OccurrenceValueEditOperation::SetStudents { student_count: 9 },
            },
        )
        .await
        .unwrap();
        assert_eq!(preflight.proposed_description, "9");
        assert!(preflight.requires_confirmation);

        let error = apply_occurrence_value_edit(&store, &api, "token", preflight.clone(), false)
            .await
            .unwrap_err();
        assert_eq!(error.code, CalendarEditErrorCode::InvalidRequest);
        assert!(api.patched.lock().unwrap().is_empty());

        apply_occurrence_value_edit(&store, &api, "token", preflight, true)
            .await
            .unwrap();
        assert_eq!(api.patched.into_inner().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn euro_override_and_configured_rate_are_canonical() {
        let store = store();
        store.upsert_event(&cached_event()).unwrap();
        let api = api("owner");
        let identity = CalendarEventIdentity {
            calendar_id: "calendar-1".to_string(),
            event_id: "instance-1".to_string(),
            recurring_event_id: None,
            original_start_time: None,
            etag: Some("etag-old".to_string()),
        };

        let euro = preflight_occurrence_value_edit(
            &store,
            &api,
            "token",
            OccurrenceValueEditRequest {
                identity: identity.clone(),
                operation: OccurrenceValueEditOperation::SetEuroOverride {
                    student_count: 5,
                    euro_override: "30.50".to_string(),
                },
            },
        )
        .await
        .unwrap();
        assert_eq!(euro.proposed_description, "5/30.5EUR");

        let configured = preflight_occurrence_value_edit(
            &store,
            &api,
            "token",
            OccurrenceValueEditRequest {
                identity,
                operation: OccurrenceValueEditOperation::UseConfiguredRate { student_count: 5 },
            },
        )
        .await
        .unwrap();
        assert_eq!(configured.proposed_description, "5");
    }

    #[tokio::test]
    async fn series_studio_edit_uses_master_etag_and_reports_title_exceptions() {
        let store = store();
        for (event_id, summary) in [
            ("instance-1", "Old Studio / Flow"),
            ("instance-2", "Cover Studio / Flow"),
        ] {
            let mut event = cached_event();
            event.event_id = event_id.to_string();
            event.recurring_event_id = Some("series-master".to_string());
            event.summary = summary.to_string();
            store.upsert_event(&event).unwrap();
        }
        let api = api("owner");
        let preflight = preflight_series_studio_edit(
            &store,
            &api,
            "token",
            SeriesStudioEditRequest {
                selected_identity: CalendarEventIdentity {
                    calendar_id: "calendar-1".to_string(),
                    event_id: "instance-1".to_string(),
                    recurring_event_id: Some("series-master".to_string()),
                    original_start_time: Some("2026-08-16T09:00:00+02:00".to_string()),
                    etag: Some("etag-old".to_string()),
                },
                studio_name: "New Studio".to_string(),
            },
        )
        .await
        .unwrap();

        assert_eq!(preflight.master_event_id, "series-master");
        assert_eq!(preflight.master_etag, "master-etag");
        assert_eq!(preflight.proposed_summary, "New Studio / Flow");
        assert_eq!(preflight.instance_count, 2);
        assert_eq!(preflight.title_exception_count, 1);

        apply_series_studio_edit(&store, &api, "token", preflight)
            .await
            .unwrap();
        assert_eq!(
            api.patched.into_inner().unwrap(),
            vec![(
                "calendar-1".to_string(),
                "series-master".to_string(),
                "master-etag".to_string(),
                CalendarEventPatch::Summary("New Studio / Flow".to_string()),
            )]
        );
    }
}
