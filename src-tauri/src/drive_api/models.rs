use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveCapabilitiesDto {
    #[serde(default)]
    pub can_list_children: bool,
    #[serde(default)]
    pub can_add_children: bool,
    #[serde(default)]
    pub can_edit: bool,
    #[serde(default)]
    pub can_download: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileDto {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    #[serde(default)]
    pub parents: Vec<String>,
    pub drive_id: Option<String>,
    #[serde(default)]
    pub owned_by_me: bool,
    pub trashed: bool,
    #[serde(default)]
    pub version: String,
    pub size: Option<String>,
    pub md5_checksum: Option<String>,
    pub sha256_checksum: Option<String>,
    #[serde(default)]
    pub properties: HashMap<String, String>,
    #[serde(default)]
    pub capabilities: DriveCapabilitiesDto,
    #[serde(default)]
    pub etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedDriveDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveListPage<T> {
    pub items: Vec<T>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveDownload {
    pub file: DriveFileDto,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DriveApiErrorCode {
    Authorization,
    Offline,
    NotFound,
    Permission,
    Conflict,
    RateLimited,
    Server,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveApiError {
    pub code: DriveApiErrorCode,
    pub message: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub file_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListSharedDrivesRequest {
    pub page_size: Option<u16>,
    pub page_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListFilesRequest {
    pub query: Option<String>,
    pub drive_id: Option<String>,
    pub corpora: String,
    pub include_items_from_all_drives: bool,
    pub supports_all_drives: bool,
    pub page_size: Option<u16>,
    pub page_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetFileRequest {
    pub file_id: String,
    pub supports_all_drives: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadFileRequest {
    pub file_id: String,
    pub supports_all_drives: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateFileIdsRequest {
    pub count: u16,
    pub space: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolderRequest {
    pub name: String,
    pub parent_id: String,
    #[serde(default)]
    pub properties: HashMap<String, String>,
    pub supports_all_drives: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFileRequest {
    pub file_id: String,
    pub name: String,
    pub parents: Vec<String>,
    pub mime_type: String,
    #[serde(default)]
    pub properties: HashMap<String, String>,
    pub bytes: Vec<u8>,
    pub supports_all_drives: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateFileRequest {
    pub file_id: String,
    pub name: Option<String>,
    pub parents: Vec<String>,
    pub mime_type: String,
    #[serde(default)]
    pub properties: HashMap<String, String>,
    pub bytes: Vec<u8>,
    pub if_match: String,
    pub supports_all_drives: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchMetadataRequest {
    pub file_id: String,
    pub name: Option<String>,
    pub properties: Option<HashMap<String, String>>,
    pub add_parents: Option<String>,
    pub remove_parents: Option<String>,
    pub if_match: String,
    pub supports_all_drives: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashFileRequest {
    pub file_id: String,
    pub if_match: String,
    pub supports_all_drives: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesListResponse {
    #[serde(default)]
    pub files: Vec<DriveFileDto>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedDrivesListResponse {
    #[serde(default)]
    pub drives: Vec<SharedDriveDto>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GeneratedIdsResponse {
    #[serde(default)]
    pub ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::{CreateFileRequest, DriveFileDto, PatchMetadataRequest, UpdateFileRequest};
    use serde_json::json;

    #[test]
    fn drive_file_requires_explicit_trashed_state() {
        let without_trashed = json!({
            "id": "file-1",
            "name": "invoice.pdf",
            "mimeType": "application/pdf",
            "parents": ["folder-1"],
            "driveId": null,
            "ownedByMe": true,
            "version": "1",
            "size": "3",
            "md5Checksum": null,
            "sha256Checksum": "sha256",
            "properties": {},
            "capabilities": {
                "canListChildren": false,
                "canAddChildren": false,
                "canEdit": true,
                "canDownload": true
            },
            "etag": null
        });
        assert!(serde_json::from_value::<DriveFileDto>(without_trashed.clone()).is_err());

        let mut with_trashed = without_trashed;
        with_trashed
            .as_object_mut()
            .unwrap()
            .insert("trashed".to_string(), json!(false));
        let parsed = serde_json::from_value::<DriveFileDto>(with_trashed).unwrap();
        assert!(!parsed.trashed);
    }

    #[test]
    fn create_file_accepts_file_id_and_parents_but_rejects_parent_id() {
        let planned = json!({
            "fileId": "reserved-file-1",
            "name": "invoice.pdf",
            "parents": ["folder-1"],
            "mimeType": "application/pdf",
            "properties": {"lotusSchema": "1"},
            "bytes": [0, 255, 42],
            "supportsAllDrives": true
        });
        let request = serde_json::from_value::<CreateFileRequest>(planned).unwrap();
        assert_eq!(request.file_id, "reserved-file-1");
        assert_eq!(request.parents, ["folder-1"]);

        let old_shape = json!({
            "fileId": "reserved-file-1",
            "name": "invoice.pdf",
            "parentId": "folder-1",
            "mimeType": "application/pdf",
            "properties": {},
            "bytes": [],
            "supportsAllDrives": true
        });
        assert!(serde_json::from_value::<CreateFileRequest>(old_shape).is_err());
    }

    #[test]
    fn update_file_accepts_if_match_but_rejects_etag() {
        let planned = json!({
            "fileId": "file-1",
            "name": "invoice.pdf",
            "parents": ["folder-1"],
            "mimeType": "application/pdf",
            "properties": {},
            "bytes": [1, 2, 3],
            "ifMatch": "\"file-v3\"",
            "supportsAllDrives": true
        });
        let request = serde_json::from_value::<UpdateFileRequest>(planned).unwrap();
        assert_eq!(request.parents, ["folder-1"]);

        let wrong_name = json!({
            "fileId": "file-1",
            "name": null,
            "parents": ["folder-1"],
            "mimeType": "application/pdf",
            "properties": {},
            "bytes": [],
            "etag": "\"file-v3\"",
            "supportsAllDrives": true
        });
        assert!(serde_json::from_value::<UpdateFileRequest>(wrong_name).is_err());
    }

    #[test]
    fn patch_metadata_accepts_if_match_but_rejects_etag() {
        let planned = json!({
            "fileId": "file-1",
            "name": "renamed.pdf",
            "properties": {"lotusSchema": "1"},
            "addParents": "folder-2",
            "removeParents": "folder-1",
            "ifMatch": "\"file-v3\"",
            "supportsAllDrives": true
        });
        assert!(serde_json::from_value::<PatchMetadataRequest>(planned).is_ok());

        let wrong_name = json!({
            "fileId": "file-1",
            "name": null,
            "properties": null,
            "addParents": null,
            "removeParents": null,
            "etag": "\"file-v3\"",
            "supportsAllDrives": true
        });
        assert!(serde_json::from_value::<PatchMetadataRequest>(wrong_name).is_err());
    }
}
