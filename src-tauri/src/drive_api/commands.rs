use super::client::DriveClient;
use super::models::{
    CreateFileRequest, CreateFolderRequest, DownloadFileRequest, DriveApiError, DriveApiErrorCode,
    DriveDownload, DriveFileDto, DriveListPage, GenerateFileIdsRequest, GetFileRequest,
    ListFilesRequest, ListSharedDrivesRequest, PatchMetadataRequest, SharedDriveDto,
    UpdateFileRequest,
};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveApiCommandError {
    pub code: DriveApiErrorCode,
    pub message: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub file_id: Option<String>,
}

impl From<DriveApiError> for DriveApiCommandError {
    fn from(error: DriveApiError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            status: error.status,
            retryable: error.retryable,
            file_id: error.file_id,
        }
    }
}

#[tauri::command]
pub async fn list_shared_drives(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: ListSharedDrivesRequest,
) -> Result<DriveListPage<SharedDriveDto>, DriveApiCommandError> {
    client
        .list_shared_drives(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn list_files(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: ListFilesRequest,
) -> Result<DriveListPage<DriveFileDto>, DriveApiCommandError> {
    client
        .list_files(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn get_file(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: GetFileRequest,
) -> Result<DriveFileDto, DriveApiCommandError> {
    client
        .get_file(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn download_file(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: DownloadFileRequest,
) -> Result<DriveDownload, DriveApiCommandError> {
    client
        .download_file(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn generate_file_ids(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: GenerateFileIdsRequest,
) -> Result<Vec<String>, DriveApiCommandError> {
    client
        .generate_file_ids(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_folder(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: CreateFolderRequest,
) -> Result<DriveFileDto, DriveApiCommandError> {
    client
        .create_folder(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn create_file(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: CreateFileRequest,
) -> Result<DriveFileDto, DriveApiCommandError> {
    client
        .create_file(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn update_file(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: UpdateFileRequest,
) -> Result<DriveFileDto, DriveApiCommandError> {
    client
        .update_file(&access_token, request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn patch_metadata(
    client: tauri::State<'_, DriveClient>,
    access_token: String,
    request: PatchMetadataRequest,
) -> Result<DriveFileDto, DriveApiCommandError> {
    client
        .patch_metadata(&access_token, request)
        .await
        .map_err(Into::into)
}
