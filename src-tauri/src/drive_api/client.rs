use super::models::{
    CreateFileRequest, CreateFolderRequest, DownloadFileRequest, DriveApiError, DriveApiErrorCode,
    DriveDownload, DriveFileDto, DriveListPage, FilesListResponse, GenerateFileIdsRequest,
    GeneratedIdsResponse, GetFileRequest, ListFilesRequest, ListSharedDrivesRequest,
    PatchMetadataRequest, SharedDriveDto, SharedDrivesListResponse, TrashFileRequest,
    UpdateFileRequest,
};
use reqwest::header::{CONTENT_TYPE, ETAG, IF_MATCH, RETRY_AFTER};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE: &str = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS: &str = "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)";
static MULTIPART_BOUNDARY_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct TrashMetadataDto {
    trashed: bool,
}

#[derive(Clone)]
pub struct DriveClient {
    client: reqwest::Client,
    api_base: Url,
    upload_base: Url,
}

impl Default for DriveClient {
    fn default() -> Self {
        Self::new()
    }
}

impl DriveClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            api_base: Url::parse(DRIVE_API_BASE).expect("fixed Drive API URL is valid"),
            upload_base: Url::parse(DRIVE_UPLOAD_BASE).expect("fixed Drive upload URL is valid"),
        }
    }

    #[cfg(feature = "webdriver")]
    pub(crate) fn new_for_webdriver(api_base: Url, upload_base: Url) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_base,
            upload_base,
        }
    }

    #[cfg(test)]
    fn new_for_test(api_base: String, upload_base: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_base: Url::parse(&api_base).expect("test Drive API URL is valid"),
            upload_base: Url::parse(&upload_base).expect("test Drive upload URL is valid"),
        }
    }

    fn endpoint(base: &Url, segments: &[&str]) -> Result<Url, DriveApiError> {
        let mut url = base.clone();
        url.path_segments_mut()
            .map_err(|_| invalid_response(None))?
            .extend(segments);
        Ok(url)
    }

    async fn request_with_retry<F>(
        &self,
        file_id: Option<&str>,
        build: F,
    ) -> Result<Response, DriveApiError>
    where
        F: Fn() -> RequestBuilder,
    {
        for attempt in 0..3 {
            let response = build().send().await.map_err(|_| DriveApiError {
                code: DriveApiErrorCode::Offline,
                message: "Drive request could not reach the service".to_string(),
                status: None,
                retryable: true,
                file_id: file_id.map(str::to_string),
            })?;
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }
            if is_retryable_status(status) && attempt < 2 {
                let jitter = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(Duration::ZERO, |duration| {
                        retry_jitter(duration.subsec_nanos())
                    });
                tokio::time::sleep(retry_delay(response.headers(), attempt, jitter)).await;
                continue;
            }
            return Err(status_error(status, file_id));
        }
        unreachable!("three-attempt retry loop always returns")
    }

    async fn request_once(
        &self,
        file_id: Option<&str>,
        request: RequestBuilder,
    ) -> Result<Response, DriveApiError> {
        let response = request.send().await.map_err(|_| DriveApiError {
            code: DriveApiErrorCode::Offline,
            message: "Drive request could not reach the service".to_string(),
            status: None,
            retryable: true,
            file_id: file_id.map(str::to_string),
        })?;
        let status = response.status();
        if status.is_success() {
            Ok(response)
        } else {
            Err(status_error(status, file_id))
        }
    }

    async fn json_response<T: DeserializeOwned>(
        response: Response,
        file_id: Option<&str>,
    ) -> Result<T, DriveApiError> {
        response
            .json::<T>()
            .await
            .map_err(|_| invalid_response(file_id))
    }

    async fn file_response(
        response: Response,
        file_id: Option<&str>,
    ) -> Result<DriveFileDto, DriveApiError> {
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut file = Self::json_response::<DriveFileDto>(response, file_id).await?;
        file.etag = etag;
        Ok(file)
    }

    pub async fn list_shared_drives(
        &self,
        access_token: &str,
        request: ListSharedDrivesRequest,
    ) -> Result<DriveListPage<SharedDriveDto>, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["drives"])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("fields", "nextPageToken,drives(id,name)");
            if let Some(page_size) = request.page_size {
                query.append_pair("pageSize", &page_size.to_string());
            }
            if let Some(page_token) = request.page_token.as_deref() {
                query.append_pair("pageToken", page_token);
            }
        }
        let response = self
            .request_with_retry(None, || {
                self.client.get(url.clone()).bearer_auth(access_token)
            })
            .await?;
        let page = Self::json_response::<SharedDrivesListResponse>(response, None).await?;
        Ok(DriveListPage {
            items: page.drives,
            next_page_token: page.next_page_token,
        })
    }

    pub async fn list_files(
        &self,
        access_token: &str,
        request: ListFilesRequest,
    ) -> Result<DriveListPage<DriveFileDto>, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["files"])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("fields", &format!("nextPageToken,files({FILE_FIELDS})"));
            query.append_pair("corpora", &request.corpora);
            query.append_pair(
                "includeItemsFromAllDrives",
                &request.include_items_from_all_drives.to_string(),
            );
            query.append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            );
            if let Some(filter) = request.query.as_deref() {
                query.append_pair("q", filter);
            }
            if let Some(drive_id) = request.drive_id.as_deref() {
                query.append_pair("driveId", drive_id);
            }
            if let Some(page_size) = request.page_size {
                query.append_pair("pageSize", &page_size.to_string());
            }
            if let Some(page_token) = request.page_token.as_deref() {
                query.append_pair("pageToken", page_token);
            }
        }
        let response = self
            .request_with_retry(None, || {
                self.client.get(url.clone()).bearer_auth(access_token)
            })
            .await?;
        let mut page = Self::json_response::<FilesListResponse>(response, None).await?;
        for file in &mut page.files {
            file.etag = None;
        }
        Ok(DriveListPage {
            items: page.files,
            next_page_token: page.next_page_token,
        })
    }

    pub async fn get_file(
        &self,
        access_token: &str,
        request: GetFileRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["files", &request.file_id])?;
        url.query_pairs_mut()
            .append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            )
            .append_pair("fields", FILE_FIELDS);
        let response = self
            .request_with_retry(Some(&request.file_id), || {
                self.client.get(url.clone()).bearer_auth(access_token)
            })
            .await?;
        Self::file_response(response, Some(&request.file_id)).await
    }

    pub async fn download_file(
        &self,
        access_token: &str,
        request: DownloadFileRequest,
    ) -> Result<DriveDownload, DriveApiError> {
        let mut file = self
            .get_file(
                access_token,
                GetFileRequest {
                    file_id: request.file_id.clone(),
                    supports_all_drives: request.supports_all_drives,
                },
            )
            .await?;
        let mut url = Self::endpoint(&self.api_base, &["files", &request.file_id])?;
        url.query_pairs_mut()
            .append_pair("alt", "media")
            .append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            );
        let response = self
            .request_with_retry(Some(&request.file_id), || {
                self.client.get(url.clone()).bearer_auth(access_token)
            })
            .await?;
        file.etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .await
            .map_err(|_| invalid_response(Some(&request.file_id)))?
            .to_vec();
        Ok(DriveDownload { file, bytes })
    }

    pub async fn generate_file_ids(
        &self,
        access_token: &str,
        request: GenerateFileIdsRequest,
    ) -> Result<Vec<String>, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["files", "generateIds"])?;
        url.query_pairs_mut()
            .append_pair("count", &request.count.to_string())
            .append_pair("space", &request.space);
        let response = self
            .request_with_retry(None, || {
                self.client.get(url.clone()).bearer_auth(access_token)
            })
            .await?;
        Ok(Self::json_response::<GeneratedIdsResponse>(response, None)
            .await?
            .ids)
    }

    pub async fn create_folder(
        &self,
        access_token: &str,
        request: CreateFolderRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["files"])?;
        url.query_pairs_mut()
            .append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            )
            .append_pair("fields", FILE_FIELDS);
        let metadata = json!({
            "name": request.name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [request.parent_id],
            "properties": request.properties,
        });
        let response = self
            .request_once(
                None,
                self.client
                    .post(url)
                    .bearer_auth(access_token)
                    .json(&metadata),
            )
            .await?;
        Self::file_response(response, None).await
    }

    pub async fn create_file(
        &self,
        access_token: &str,
        request: CreateFileRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        validate_mime_type(&request.mime_type)?;
        let parent_id = exactly_one_parent(&request.parents, Some(&request.file_id))?;
        let mut url = Self::endpoint(&self.upload_base, &["files"])?;
        url.query_pairs_mut()
            .append_pair("uploadType", "multipart")
            .append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            )
            .append_pair("fields", FILE_FIELDS);
        let metadata = json!({
            "id": request.file_id,
            "name": request.name,
            "mimeType": request.mime_type,
            "parents": [parent_id],
            "properties": request.properties,
        })
        .to_string();
        let mime_type = request.mime_type;
        let bytes = request.bytes;
        let (content_type, body) = multipart_related_body(&metadata, &mime_type, &bytes);
        let response = self
            .request_with_retry(None, || {
                self.client
                    .post(url.clone())
                    .bearer_auth(access_token)
                    .header(CONTENT_TYPE, &content_type)
                    .body(body.clone())
            })
            .await?;
        Self::file_response(response, None).await
    }

    pub async fn update_file(
        &self,
        access_token: &str,
        request: UpdateFileRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        validate_mime_type(&request.mime_type)?;
        exactly_one_parent(&request.parents, Some(&request.file_id))?;
        let mut url = Self::endpoint(&self.upload_base, &["files", &request.file_id])?;
        url.query_pairs_mut()
            .append_pair("uploadType", "multipart")
            .append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            )
            .append_pair("fields", FILE_FIELDS);
        let metadata = json!({
            "name": request.name,
            "mimeType": request.mime_type,
            "properties": request.properties,
        })
        .to_string();
        let file_id = request.file_id;
        let if_match = request.if_match;
        let mime_type = request.mime_type;
        let bytes = request.bytes;
        let (content_type, body) = multipart_related_body(&metadata, &mime_type, &bytes);
        let response = self
            .request_with_retry(Some(&file_id), || {
                self.client
                    .patch(url.clone())
                    .bearer_auth(access_token)
                    .header(IF_MATCH, &if_match)
                    .header(CONTENT_TYPE, &content_type)
                    .body(body.clone())
            })
            .await?;
        Self::file_response(response, Some(&file_id)).await
    }

    pub async fn patch_metadata(
        &self,
        access_token: &str,
        request: PatchMetadataRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["files", &request.file_id])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            );
            query.append_pair("fields", FILE_FIELDS);
            if let Some(add_parents) = request.add_parents.as_deref() {
                query.append_pair("addParents", add_parents);
            }
            if let Some(remove_parents) = request.remove_parents.as_deref() {
                query.append_pair("removeParents", remove_parents);
            }
        }
        let mut metadata = Map::new();
        if let Some(name) = request.name {
            metadata.insert("name".to_string(), Value::String(name));
        }
        if let Some(properties) = request.properties {
            metadata.insert("properties".to_string(), json!(properties));
        }
        let file_id = request.file_id;
        let if_match = request.if_match;
        let response = self
            .request_with_retry(Some(&file_id), || {
                self.client
                    .patch(url.clone())
                    .bearer_auth(access_token)
                    .header(IF_MATCH, &if_match)
                    .json(&metadata)
            })
            .await?;
        Self::file_response(response, Some(&file_id)).await
    }

    pub async fn trash_file(
        &self,
        access_token: &str,
        request: TrashFileRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        let mut url = Self::endpoint(&self.api_base, &["files", &request.file_id])?;
        url.query_pairs_mut()
            .append_pair(
                "supportsAllDrives",
                &request.supports_all_drives.to_string(),
            )
            .append_pair("fields", FILE_FIELDS);
        let file_id = request.file_id;
        let if_match = request.if_match;
        let response = self
            .request_with_retry(Some(&file_id), || {
                self.client
                    .patch(url.clone())
                    .bearer_auth(access_token)
                    .header(IF_MATCH, &if_match)
                    .json(&TrashMetadataDto { trashed: true })
            })
            .await?;
        Self::file_response(response, Some(&file_id)).await
    }
}

fn multipart_related_body(metadata: &str, mime_type: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = multipart_boundary(metadata.as_bytes(), bytes);
    let mut body = Vec::with_capacity(metadata.len() + bytes.len() + 256);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(metadata.as_bytes());
    body.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/related; boundary={boundary}"), body)
}

fn multipart_boundary(metadata: &[u8], bytes: &[u8]) -> String {
    loop {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let sequence = MULTIPART_BOUNDARY_COUNTER.fetch_add(1, Ordering::Relaxed);
        let boundary = format!("lotus-drive-{timestamp:x}-{sequence:x}");
        let collides = |content: &[u8]| {
            content
                .windows(boundary.len())
                .any(|window| window == boundary.as_bytes())
        };
        if !collides(metadata) && !collides(bytes) {
            return boundary;
        }
    }
}

fn validate_mime_type(mime_type: &str) -> Result<(), DriveApiError> {
    reqwest::multipart::Part::bytes(Vec::new())
        .mime_str(mime_type)
        .map(|_| ())
        .map_err(|_| invalid_response(None))
}

fn exactly_one_parent<'a>(
    parents: &'a [String],
    file_id: Option<&str>,
) -> Result<&'a str, DriveApiError> {
    match parents {
        [parent] => Ok(parent),
        _ => Err(invalid_response(file_id)),
    }
}

fn retry_delay(headers: &reqwest::header::HeaderMap, attempt: usize, jitter: Duration) -> Duration {
    let base = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds.min(5)))
        .unwrap_or_else(|| Duration::from_millis(if attempt == 0 { 200 } else { 400 }));
    base + jitter
}

fn retry_jitter(nanos: u32) -> Duration {
    Duration::from_millis(u64::from(nanos % 101))
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

fn status_error(status: StatusCode, file_id: Option<&str>) -> DriveApiError {
    let (code, message) = match status.as_u16() {
        401 => (
            DriveApiErrorCode::Authorization,
            "Drive authorization failed",
        ),
        403 => (DriveApiErrorCode::Permission, "Drive permission was denied"),
        404 => (DriveApiErrorCode::NotFound, "Drive file was not found"),
        412 => (DriveApiErrorCode::Conflict, "Drive file changed remotely"),
        429 => (
            DriveApiErrorCode::RateLimited,
            "Drive rate limit was reached",
        ),
        500..=599 => (DriveApiErrorCode::Server, "Drive service failed"),
        _ => (
            DriveApiErrorCode::InvalidResponse,
            "Drive request was rejected",
        ),
    };
    DriveApiError {
        code,
        message: message.to_string(),
        status: Some(status.as_u16()),
        retryable: is_retryable_status(status),
        file_id: file_id.map(str::to_string),
    }
}

fn invalid_response(file_id: Option<&str>) -> DriveApiError {
    DriveApiError {
        code: DriveApiErrorCode::InvalidResponse,
        message: "Drive returned an invalid response".to_string(),
        status: None,
        retryable: false,
        file_id: file_id.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use httpmock::Method::PATCH;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    static APPLIED_FOLDER_COUNT: AtomicUsize = AtomicUsize::new(0);

    fn record_applied_folder(_: &HttpMockRequest) -> bool {
        APPLIED_FOLDER_COUNT.fetch_add(1, Ordering::SeqCst);
        true
    }

    fn file_json(id: &str, version: &str) -> Value {
        json!({
            "id": id,
            "name": format!("invoice-{version}.pdf"),
            "mimeType": "application/pdf",
            "parents": ["folder-1"],
            "driveId": "drive-1",
            "ownedByMe": false,
            "trashed": false,
            "version": version,
            "size": "1234",
            "md5Checksum": "md5",
            "sha256Checksum": "sha256",
            "properties": { "lotusSchema": "1" },
            "capabilities": {
                "canListChildren": false,
                "canAddChildren": false,
                "canEdit": true,
                "canDownload": true
            }
        })
    }

    fn test_client(server: &MockServer) -> DriveClient {
        DriveClient::new_for_test(
            format!("{}/drive/v3", server.base_url()),
            format!("{}/upload/drive/v3", server.base_url()),
        )
    }

    fn list_request() -> ListFilesRequest {
        ListFilesRequest {
            query: Some("'folder-1' in parents and trashed = false".to_string()),
            drive_id: Some("drive-1".to_string()),
            corpora: "drive".to_string(),
            include_items_from_all_drives: true,
            supports_all_drives: true,
            page_size: Some(25),
            page_token: Some("page-2".to_string()),
        }
    }

    fn update_request(file_id: &str, etag: &str) -> UpdateFileRequest {
        UpdateFileRequest {
            file_id: file_id.to_string(),
            name: Some("invoice-updated.pdf".to_string()),
            parents: vec!["folder-1".to_string()],
            mime_type: "application/pdf".to_string(),
            properties: HashMap::from([("lotusSchema".to_string(), "1".to_string())]),
            bytes: vec![0, 254, 13, 10, 129, 43],
            if_match: etag.to_string(),
            supports_all_drives: true,
        }
    }

    fn matches_multipart_related(
        request: &HttpMockRequest,
        expected_metadata: &Value,
        expected_media_type: &str,
        expected_bytes: &[u8],
    ) -> bool {
        let Some(content_type) = request.headers.as_ref().and_then(|headers| {
            headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                .map(|(_, value)| value.as_str())
        }) else {
            return false;
        };
        let Some(boundary) = content_type.strip_prefix("multipart/related; boundary=") else {
            return false;
        };
        if boundary.is_empty() {
            return false;
        }
        let Some(body) = request.body.as_deref() else {
            return false;
        };
        let metadata_prefix =
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n");
        if !body.starts_with(metadata_prefix.as_bytes()) {
            return false;
        }
        let media_separator =
            format!("\r\n--{boundary}\r\nContent-Type: {expected_media_type}\r\n\r\n");
        let Some(separator_offset) = body
            .windows(media_separator.len())
            .position(|window| window == media_separator.as_bytes())
        else {
            return false;
        };
        let metadata_bytes = &body[metadata_prefix.len()..separator_offset];
        if serde_json::from_slice::<Value>(metadata_bytes)
            .ok()
            .as_ref()
            != Some(expected_metadata)
        {
            return false;
        }
        let media_start = separator_offset + media_separator.len();
        let closing = format!("\r\n--{boundary}--\r\n");
        body.get(media_start..) == Some([expected_bytes, closing.as_bytes()].concat().as_slice())
    }

    fn matches_invoice_multipart_related(request: &HttpMockRequest) -> bool {
        matches_multipart_related(
            request,
            &json!({
                "id": "reserved-file-1",
                "name": "invoice.pdf",
                "mimeType": "application/pdf",
                "parents": ["folder-1"],
                "properties": {"lotusSchema": "1"}
            }),
            "application/pdf",
            &[0, 255, 13, 10, 128, 42],
        )
    }

    fn matches_update_multipart_related(request: &HttpMockRequest) -> bool {
        matches_multipart_related(
            request,
            &json!({
                "name": "invoice-updated.pdf",
                "mimeType": "application/pdf",
                "properties": {"lotusSchema": "1"}
            }),
            "application/pdf",
            &[0, 254, 13, 10, 129, 43],
        )
    }

    #[tokio::test]
    async fn list_files_sends_pagination_shared_drive_flags_and_metadata_fields() {
        let server = MockServer::start();
        let list = server.mock(|when, then| {
            when.method(GET)
                .path("/drive/v3/files")
                .query_param("q", "'folder-1' in parents and trashed = false")
                .query_param("driveId", "drive-1")
                .query_param("corpora", "drive")
                .query_param("includeItemsFromAllDrives", "true")
                .query_param("supportsAllDrives", "true")
                .query_param("pageSize", "25")
                .query_param("pageToken", "page-2")
                .query_param(
                    "fields",
                    "nextPageToken,files(id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload))",
                )
                .header("authorization", "Bearer token");
            then.status(200).json_body(json!({
                "files": [file_json("file-1", "3")],
                "nextPageToken": "page-3"
            }));
        });

        let result = test_client(&server)
            .list_files("token", list_request())
            .await
            .unwrap();

        list.assert();
        assert_eq!(result.next_page_token.as_deref(), Some("page-3"));
        assert_eq!(result.items[0].id, "file-1");
        assert_eq!(result.items[0].properties["lotusSchema"], "1");
        assert!(!result.items[0].trashed);
        assert!(result.items[0].capabilities.can_edit);
        assert_eq!(result.items[0].etag, None);
    }

    #[tokio::test]
    async fn list_shared_drives_sends_pagination_and_returns_page() {
        let server = MockServer::start();
        let list = server.mock(|when, then| {
            when.method(GET)
                .path("/drive/v3/drives")
                .query_param("pageSize", "10")
                .query_param("pageToken", "drive-page-2")
                .query_param("fields", "nextPageToken,drives(id,name)")
                .header("authorization", "Bearer token");
            then.status(200).json_body(json!({
                "drives": [{"id": "drive-1", "name": "Invoices"}],
                "nextPageToken": "drive-page-3"
            }));
        });

        let result = test_client(&server)
            .list_shared_drives(
                "token",
                ListSharedDrivesRequest {
                    page_size: Some(10),
                    page_token: Some("drive-page-2".to_string()),
                },
            )
            .await
            .unwrap();

        list.assert();
        assert_eq!(result.items[0].name, "Invoices");
        assert_eq!(result.next_page_token.as_deref(), Some("drive-page-3"));
    }

    #[tokio::test]
    async fn get_and_download_send_shared_drive_flags_and_capture_http_etags() {
        let server = MockServer::start();
        let get = server.mock(|when, then| {
            when.method(GET)
                .path("/drive/v3/files/file-1")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token");
            then.status(200)
                .header("etag", "\"file-1-v3\"")
                .json_body(file_json("file-1", "3"));
        });
        let download = server.mock(|when, then| {
            when.method(GET)
                .path("/drive/v3/files/file-1")
                .query_param("alt", "media")
                .query_param("supportsAllDrives", "true")
                .header("authorization", "Bearer token");
            then.status(200)
                .header("etag", "\"file-1-v3\"")
                .body("pdf bytes");
        });
        let client = test_client(&server);

        let fetched = client
            .get_file(
                "token",
                GetFileRequest {
                    file_id: "file-1".to_string(),
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap();
        let downloaded = client
            .download_file(
                "token",
                DownloadFileRequest {
                    file_id: "file-1".to_string(),
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap();

        get.assert_hits(2);
        download.assert();
        assert_eq!(fetched.etag.as_deref(), Some("\"file-1-v3\""));
        assert_eq!(downloaded.file.etag.as_deref(), Some("\"file-1-v3\""));
        assert_eq!(downloaded.bytes, b"pdf bytes");
    }

    #[tokio::test]
    async fn generated_ids_include_requested_count_and_drive_space() {
        let server = MockServer::start();
        let generate = server.mock(|when, then| {
            when.method(GET)
                .path("/drive/v3/files/generateIds")
                .query_param("count", "2")
                .query_param("space", "drive")
                .header("authorization", "Bearer token");
            then.status(200).json_body(json!({"ids": ["id-1", "id-2"]}));
        });

        let ids = test_client(&server)
            .generate_file_ids(
                "token",
                GenerateFileIdsRequest {
                    count: 2,
                    space: "drive".to_string(),
                },
            )
            .await
            .unwrap();

        generate.assert();
        assert_eq!(ids, vec!["id-1", "id-2"]);
    }

    #[tokio::test]
    async fn create_folder_sends_metadata_shared_drive_flag_and_captures_etag() {
        let server = MockServer::start();
        let create = server.mock(|when, then| {
            when.method(POST)
                .path("/drive/v3/files")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token")
                .json_body(json!({
                    "name": "August 2026",
                    "mimeType": "application/vnd.google-apps.folder",
                    "parents": ["root-folder"],
                    "properties": {"lotusSchema": "1"}
                }));
            then.status(200)
                .header("etag", "\"folder-v1\"")
                .json_body(file_json("folder-1", "1"));
        });

        let result = test_client(&server)
            .create_folder(
                "token",
                CreateFolderRequest {
                    name: "August 2026".to_string(),
                    parent_id: "root-folder".to_string(),
                    properties: HashMap::from([("lotusSchema".to_string(), "1".to_string())]),
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap();

        create.assert();
        assert_eq!(result.etag.as_deref(), Some("\"folder-v1\""));
    }

    #[tokio::test]
    async fn create_folder_does_not_repeat_an_applied_request_after_ambiguous_503() {
        let server = MockServer::start();
        APPLIED_FOLDER_COUNT.store(0, Ordering::SeqCst);
        let create = server.mock(|when, then| {
            when.method(POST)
                .path("/drive/v3/files")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token")
                .json_body(json!({
                    "name": "August 2026",
                    "mimeType": "application/vnd.google-apps.folder",
                    "parents": ["root-folder"],
                    "properties": {"lotusSchema": "1"}
                }))
                .matches(record_applied_folder);
            then.status(503).header("retry-after", "0");
        });

        let error = tokio::time::timeout(
            Duration::from_secs(2),
            test_client(&server).create_folder(
                "token",
                CreateFolderRequest {
                    name: "August 2026".to_string(),
                    parent_id: "root-folder".to_string(),
                    properties: HashMap::from([("lotusSchema".to_string(), "1".to_string())]),
                    supports_all_drives: true,
                },
            ),
        )
        .await
        .expect("folder create must not enter a retry delay")
        .unwrap_err();

        create.assert_hits(1);
        assert_eq!(APPLIED_FOLDER_COUNT.load(Ordering::SeqCst), 1);
        assert_eq!(error.code, DriveApiErrorCode::Server);
        assert_eq!(error.status, Some(503));
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn create_file_sends_multipart_metadata_content_and_shared_drive_flag() {
        let server = MockServer::start();
        let binary_payload = vec![0, 255, 13, 10, 128, 42];
        let create = server.mock(|when, then| {
            when.method(POST)
                .path("/upload/drive/v3/files")
                .query_param("uploadType", "multipart")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token")
                .matches(matches_invoice_multipart_related);
            then.status(200)
                .header("etag", "\"file-v1\"")
                .json_body(file_json("file-1", "1"));
        });

        let result = test_client(&server)
            .create_file(
                "token",
                CreateFileRequest {
                    file_id: "reserved-file-1".to_string(),
                    name: "invoice.pdf".to_string(),
                    parents: vec!["folder-1".to_string()],
                    mime_type: "application/pdf".to_string(),
                    properties: HashMap::from([("lotusSchema".to_string(), "1".to_string())]),
                    bytes: binary_payload,
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap();

        create.assert();
        assert_eq!(result.etag.as_deref(), Some("\"file-v1\""));
    }

    #[tokio::test]
    async fn create_file_rejects_zero_or_multiple_parents_before_sending() {
        let server = MockServer::start();
        let unexpected = server.mock(|when, then| {
            when.method(POST).path("/upload/drive/v3/files");
            then.status(200)
                .header("etag", "\"unexpected\"")
                .json_body(file_json("unexpected", "1"));
        });
        let client = test_client(&server);

        for parents in [vec![], vec!["folder-1".to_string(), "folder-2".to_string()]] {
            let error = client
                .create_file(
                    "token",
                    CreateFileRequest {
                        file_id: "reserved-file-1".to_string(),
                        name: "invoice.pdf".to_string(),
                        parents,
                        mime_type: "application/pdf".to_string(),
                        properties: HashMap::new(),
                        bytes: vec![1, 2, 3],
                        supports_all_drives: true,
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, DriveApiErrorCode::InvalidResponse);
            assert_eq!(error.file_id.as_deref(), Some("reserved-file-1"));
        }
        unexpected.assert_hits(0);
    }

    #[tokio::test]
    async fn conditional_update_sends_if_match_and_returns_response_etag() {
        let server = MockServer::start();
        let update = server.mock(|when, then| {
            when.method(PATCH)
                .path("/upload/drive/v3/files/file-1")
                .query_param("uploadType", "multipart")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token")
                .header("if-match", "\"file-1-v3\"")
                .matches(matches_update_multipart_related);
            then.status(200)
                .header("etag", "\"file-1-v4\"")
                .json_body(file_json("file-1", "4"));
        });
        let result = test_client(&server)
            .update_file("token", update_request("file-1", "\"file-1-v3\""))
            .await
            .unwrap();

        update.assert();
        assert_eq!(result.etag.as_deref(), Some("\"file-1-v4\""));
    }

    #[tokio::test]
    async fn update_file_rejects_zero_or_multiple_parents_before_sending() {
        let server = MockServer::start();
        let unexpected = server.mock(|when, then| {
            when.method(PATCH).path("/upload/drive/v3/files/file-1");
            then.status(200)
                .header("etag", "\"unexpected\"")
                .json_body(file_json("file-1", "4"));
        });
        let client = test_client(&server);

        for parents in [vec![], vec!["folder-1".to_string(), "folder-2".to_string()]] {
            let mut request = update_request("file-1", "\"file-1-v3\"");
            request.parents = parents;
            let error = client.update_file("token", request).await.unwrap_err();
            assert_eq!(error.code, DriveApiErrorCode::InvalidResponse);
            assert_eq!(error.file_id.as_deref(), Some("file-1"));
        }
        unexpected.assert_hits(0);
    }

    #[tokio::test]
    async fn patch_metadata_sends_if_match_parent_changes_and_shared_drive_flag() {
        let server = MockServer::start();
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/drive/v3/files/file-1")
                .query_param("addParents", "folder-2")
                .query_param("removeParents", "folder-1")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token")
                .header("if-match", "\"file-1-v3\"")
                .json_body(json!({
                    "name": "renamed.pdf",
                    "properties": {"lotusSchema": "1"}
                }));
            then.status(200)
                .header("etag", "\"file-1-v4\"")
                .json_body(file_json("file-1", "4"));
        });

        let result = test_client(&server)
            .patch_metadata(
                "token",
                PatchMetadataRequest {
                    file_id: "file-1".to_string(),
                    name: Some("renamed.pdf".to_string()),
                    properties: Some(HashMap::from([(
                        "lotusSchema".to_string(),
                        "1".to_string(),
                    )])),
                    add_parents: Some("folder-2".to_string()),
                    remove_parents: Some("folder-1".to_string()),
                    if_match: "\"file-1-v3\"".to_string(),
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap();

        patch.assert();
        assert_eq!(result.etag.as_deref(), Some("\"file-1-v4\""));
    }

    #[tokio::test]
    async fn trash_file_sends_only_trashed_with_if_match_and_shared_drive_flag() {
        let server = MockServer::start();
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/drive/v3/files/file-1")
                .query_param("supportsAllDrives", "true")
                .query_param(
                    "fields",
                    "id,name,mimeType,parents,driveId,ownedByMe,trashed,version,size,md5Checksum,sha256Checksum,properties,capabilities(canListChildren,canAddChildren,canEdit,canDownload)",
                )
                .header("authorization", "Bearer token")
                .header("if-match", "\"file-1-v3\"")
                .json_body(json!({"trashed": true}));
            then.status(200)
                .header("etag", "\"file-1-v4\"")
                .json_body(file_json("file-1", "4"));
        });

        let result = test_client(&server)
            .trash_file(
                "token",
                TrashFileRequest {
                    file_id: "file-1".to_string(),
                    if_match: "\"file-1-v3\"".to_string(),
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap();

        patch.assert();
        assert_eq!(result.etag.as_deref(), Some("\"file-1-v4\""));
    }

    #[tokio::test]
    async fn maps_non_retryable_http_statuses_without_retrying() {
        for (status, expected_code) in [
            (401, DriveApiErrorCode::Authorization),
            (403, DriveApiErrorCode::Permission),
            (404, DriveApiErrorCode::NotFound),
            (412, DriveApiErrorCode::Conflict),
        ] {
            let server = MockServer::start();
            let failure = server.mock(|when, then| {
                when.method(GET).path("/drive/v3/files/file-1");
                then.status(status);
            });

            let error = test_client(&server)
                .get_file(
                    "token",
                    GetFileRequest {
                        file_id: "file-1".to_string(),
                        supports_all_drives: true,
                    },
                )
                .await
                .unwrap_err();

            failure.assert_hits(1);
            assert_eq!(error.code, expected_code);
            assert_eq!(error.status, Some(status));
            assert_eq!(error.file_id.as_deref(), Some("file-1"));
            assert!(!error.retryable);
        }
    }

    #[tokio::test]
    async fn retries_rate_limits_and_retryable_server_failures_only_three_attempts() {
        for (status, expected_code) in [
            (429, DriveApiErrorCode::RateLimited),
            (500, DriveApiErrorCode::Server),
            (502, DriveApiErrorCode::Server),
            (503, DriveApiErrorCode::Server),
            (504, DriveApiErrorCode::Server),
        ] {
            let server = MockServer::start();
            let failure = server.mock(|when, then| {
                when.method(GET).path("/drive/v3/files/file-1");
                then.status(status).header("retry-after", "0");
            });

            let error = tokio::time::timeout(
                Duration::from_secs(2),
                test_client(&server).get_file(
                    "token",
                    GetFileRequest {
                        file_id: "file-1".to_string(),
                        supports_all_drives: true,
                    },
                ),
            )
            .await
            .expect("retry delay must remain bounded")
            .unwrap_err();

            failure.assert_hits(3);
            assert_eq!(error.code, expected_code);
            assert_eq!(error.status, Some(status));
            assert!(error.retryable);
        }
    }

    #[test]
    fn retry_delay_uses_200_and_400_ms_fallbacks_plus_supplied_jitter() {
        let headers = reqwest::header::HeaderMap::new();
        assert_eq!(
            retry_delay(&headers, 0, Duration::from_millis(17)),
            Duration::from_millis(217)
        );
        assert_eq!(
            retry_delay(&headers, 1, Duration::from_millis(17)),
            Duration::from_millis(417)
        );
    }

    #[test]
    fn retry_after_is_capped_at_five_seconds_before_jitter() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(RETRY_AFTER, "9".parse().unwrap());
        assert_eq!(
            retry_delay(&headers, 0, Duration::from_millis(100)),
            Duration::from_millis(5_100)
        );
    }

    #[test]
    fn retry_jitter_is_always_between_zero_and_100_ms() {
        for nanos in [0, 1, 99, 100, 101, 10_001, u32::MAX] {
            assert!(retry_jitter(nanos) <= Duration::from_millis(100));
        }
        assert_eq!(retry_jitter(0), Duration::ZERO);
        assert_eq!(retry_jitter(100), Duration::from_millis(100));
        assert_eq!(retry_jitter(101), Duration::ZERO);
    }

    #[tokio::test]
    async fn transport_errors_redact_bearer_tokens_and_custom_bases() {
        let api_base = "http://127.0.0.1:9/private-drive-base";
        let upload_base = "http://127.0.0.1:9/private-upload-base";
        let token = "secret-bearer-token";
        let client = DriveClient::new_for_test(api_base.to_string(), upload_base.to_string());

        let error = client
            .get_file(
                token,
                GetFileRequest {
                    file_id: "file-1".to_string(),
                    supports_all_drives: true,
                },
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, DriveApiErrorCode::Offline);
        assert!(!error.message.contains(token));
        assert!(!error.message.contains(api_base));
        assert!(!error.message.contains(upload_base));
    }
}
