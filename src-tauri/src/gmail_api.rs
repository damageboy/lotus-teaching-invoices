use reqwest::StatusCode;
use serde::Serialize;
use tauri::State;
use url::Url;

pub(crate) const PRODUCTION_GMAIL_API_BASE: &str = "https://gmail.googleapis.com/gmail/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GmailApiErrorCode {
    Unauthorized,
    Forbidden,
    RateLimited,
    ServerError,
    RequestFailed,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GmailApiError {
    pub(crate) code: GmailApiErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    pub(crate) message: String,
}

fn api_error(code: GmailApiErrorCode, status: Option<u16>, message: &str) -> GmailApiError {
    GmailApiError {
        code,
        status,
        message: message.to_string(),
    }
}

pub(crate) fn map_gmail_status(status: StatusCode) -> GmailApiError {
    match status {
        StatusCode::UNAUTHORIZED => api_error(
            GmailApiErrorCode::Unauthorized,
            Some(status.as_u16()),
            "Google authorization expired. Please try again.",
        ),
        StatusCode::FORBIDDEN => api_error(
            GmailApiErrorCode::Forbidden,
            Some(status.as_u16()),
            "Gmail did not allow this draft to be created.",
        ),
        StatusCode::TOO_MANY_REQUESTS => api_error(
            GmailApiErrorCode::RateLimited,
            Some(status.as_u16()),
            "Gmail is temporarily busy. Please try again.",
        ),
        status if status.is_server_error() => api_error(
            GmailApiErrorCode::ServerError,
            Some(status.as_u16()),
            "Gmail is temporarily unavailable. Please try again.",
        ),
        _ => api_error(
            GmailApiErrorCode::RequestFailed,
            Some(status.as_u16()),
            "Gmail could not create the draft.",
        ),
    }
}

#[cfg(any(test, feature = "webdriver"))]
pub(crate) fn validate_webdriver_gmail_base(raw: Option<&str>) -> Result<Url, String> {
    let raw = raw.ok_or("LOTUS_E2E_GMAIL_API_BASE is required")?;
    let parsed = Url::parse(raw).map_err(|_| "Invalid E2E Gmail API base URL".to_string())?;
    let is_loopback = match parsed.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    let accepted = parsed.scheme() == "http"
        && is_loopback
        && parsed.port().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.path() == "/gmail/v1"
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    if !accepted {
        return Err(
            "E2E Gmail API base must be loopback HTTP at /gmail/v1 without credentials".to_string(),
        );
    }
    Ok(parsed)
}

pub(crate) struct GmailClient {
    http: reqwest::Client,
    api_base: Url,
}

impl GmailClient {
    pub(crate) fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            api_base: Url::parse(PRODUCTION_GMAIL_API_BASE).expect("fixed Gmail API URL is valid"),
        }
    }

    #[cfg(feature = "webdriver")]
    pub(crate) fn new_for_webdriver(api_base: Url) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_base,
        }
    }

    #[cfg(test)]
    fn new_for_test(api_base: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_base: Url::parse(&api_base).expect("test Gmail API URL is valid"),
        }
    }

    #[cfg(test)]
    fn api_base(&self) -> &Url {
        &self.api_base
    }

    fn drafts_url(&self) -> Result<Url, GmailApiError> {
        let mut url = self.api_base.clone();
        url.path_segments_mut()
            .map_err(|_| {
                api_error(
                    GmailApiErrorCode::RequestFailed,
                    None,
                    "Gmail could not create the draft.",
                )
            })?
            .pop_if_empty()
            .extend(["users", "me", "drafts"]);
        Ok(url)
    }

    pub(crate) async fn create_draft(
        &self,
        access_token: &str,
        raw_message: &str,
    ) -> Result<(), GmailApiError> {
        let response = self
            .http
            .post(self.drafts_url()?)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "message": { "raw": raw_message } }))
            .send()
            .await
            .map_err(|_| {
                api_error(
                    GmailApiErrorCode::Offline,
                    None,
                    "Gmail could not be reached. Check your connection and try again.",
                )
            })?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(map_gmail_status(response.status()))
        }
    }
}

#[tauri::command]
pub(crate) async fn gmail_create_draft(
    client: State<'_, GmailClient>,
    access_token: String,
    raw_message: String,
) -> Result<(), GmailApiError> {
    client.create_draft(&access_token, &raw_message).await
}

#[cfg(test)]
mod tests {
    use super::{
        map_gmail_status, validate_webdriver_gmail_base, GmailApiErrorCode, GmailClient,
        PRODUCTION_GMAIL_API_BASE,
    };
    use httpmock::prelude::*;
    use reqwest::StatusCode;

    #[test]
    fn maps_google_statuses_to_typed_redacted_errors() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, GmailApiErrorCode::Unauthorized),
            (StatusCode::FORBIDDEN, GmailApiErrorCode::Forbidden),
            (
                StatusCode::TOO_MANY_REQUESTS,
                GmailApiErrorCode::RateLimited,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                GmailApiErrorCode::ServerError,
            ),
            (StatusCode::IM_A_TEAPOT, GmailApiErrorCode::RequestFailed),
        ] {
            let error = map_gmail_status(status);
            assert_eq!(error.code, expected);
            assert_eq!(error.status, Some(status.as_u16()));
            assert!(!error.message.contains(status.as_str()));
        }
    }

    #[test]
    fn production_base_is_fixed_and_webdriver_requires_an_exact_loopback_base() {
        assert_eq!(
            GmailClient::new().api_base().as_str(),
            PRODUCTION_GMAIL_API_BASE
        );
        assert_eq!(
            validate_webdriver_gmail_base(Some("http://127.0.0.1:43129/gmail/v1"))
                .unwrap()
                .as_str(),
            "http://127.0.0.1:43129/gmail/v1"
        );
        for rejected in [
            None,
            Some("https://127.0.0.1:43129/gmail/v1"),
            Some("http://192.0.2.10:43129/gmail/v1"),
            Some("http://user:secret@127.0.0.1:43129/gmail/v1"),
            Some("http://127.0.0.1/gmail/v1"),
            Some("http://127.0.0.1:43129/gmail/v1/"),
            Some("http://127.0.0.1:43129/drive/v3"),
            Some("http://127.0.0.1:43129/gmail/v1?access_token=secret"),
        ] {
            assert!(
                validate_webdriver_gmail_base(rejected).is_err(),
                "accepted {rejected:?}"
            );
        }
    }

    #[tokio::test]
    async fn posts_only_the_supplied_token_and_raw_message() {
        let server = MockServer::start();
        let request = server.mock(|when, then| {
            when.method(POST)
                .path("/gmail/v1/users/me/drafts")
                .header("authorization", "Bearer exact-access-token")
                .json_body(serde_json::json!({ "message": { "raw": "exact-raw-message" } }));
            then.status(200)
                .json_body(serde_json::json!({ "id": "draft-1" }));
        });
        let client = GmailClient::new_for_test(format!("{}/gmail/v1", server.base_url()));

        client
            .create_draft("exact-access-token", "exact-raw-message")
            .await
            .unwrap();

        request.assert_hits(1);
    }

    #[tokio::test]
    async fn remote_and_transport_details_are_not_exposed() {
        let server = MockServer::start();
        let secret_body = "remote said token=secret raw=secret";
        server.mock(|when, then| {
            when.method(POST).path("/gmail/v1/users/me/drafts");
            then.status(403).body(secret_body);
        });
        let api_base = format!("{}/gmail/v1", server.base_url());
        let client = GmailClient::new_for_test(api_base.clone());

        let error = client
            .create_draft("access-secret", "raw-secret")
            .await
            .unwrap_err();

        assert_eq!(error.code, GmailApiErrorCode::Forbidden);
        assert!(!error.message.contains(secret_body));
        assert!(!error.message.contains("access-secret"));
        assert!(!error.message.contains("raw-secret"));
        assert!(!error.message.contains(&api_base));
    }
}
