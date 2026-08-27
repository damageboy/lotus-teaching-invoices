use app_lib::drive_api::{
    CreateFileRequest, DownloadFileRequest, DriveApiError, DriveApiErrorCode, DriveClient,
    DriveFileDto, GenerateFileIdsRequest, GetFileRequest, PatchMetadataRequest, TrashFileRequest,
    UpdateFileRequest,
};
use std::collections::HashMap;
use std::env;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

const PDF_V1: &[u8] = b"%PDF-1.4\n% Lotus disposable live test v1\n";
const PDF_V2: &[u8] = b"%PDF-1.4\n% Lotus disposable live test v2\n";

#[tokio::test]
#[ignore = "requires explicit desktop and Android tokens plus a disposable My Drive parent"]
async fn real_drive_honors_etag_preconditions_across_oauth_clients() {
    let desktop_token = required_env("LOTUS_DRIVE_LIVE_DESKTOP_TOKEN");
    let android_token = required_env("LOTUS_DRIVE_LIVE_ANDROID_TOKEN");
    let parent_id = required_env("LOTUS_DRIVE_LIVE_PARENT_ID");
    let client = DriveClient::new();
    let reservation = reserve_disposable_file(&client, &desktop_token, "root", false, PDF_V1)
        .await
        .unwrap_or_else(|error| panic!("could not reserve disposable root-level file: {error}"));
    let create_result = client
        .create_file(&desktop_token, reservation.request)
        .await;
    let created = complete_create_or_cleanup(
        &client,
        &desktop_token,
        &reservation.file_id,
        false,
        create_result,
    )
    .await
    .unwrap_or_else(|error| panic!("could not create disposable My Drive file: {error}"));
    eprintln!("created disposable My Drive file ID: {}", created.id);

    let outcome = async {
        let desktop = get_exact(&client, &desktop_token, &created.id, false).await?;
        let android = get_exact(&client, &android_token, &created.id, false).await?;
        if android.id != desktop.id {
            return Err("desktop and Android clients did not resolve the same file ID".to_string());
        }
        for (client_name, file) in [("desktop", &desktop), ("Android", &android)] {
            if file.properties.get("lotusSchema").map(String::as_str) != Some("1") {
                return Err(format!(
                    "{client_name} client did not observe the standard lotusSchema property"
                ));
            }
        }

        let android_etag = required_etag(&android)?;
        let mut android_properties = android.properties.clone();
        android_properties.insert("lotusLiveWriter".to_string(), "android".to_string());
        let updated = client
            .patch_metadata(
                &android_token,
                property_patch(&android.id, &android_etag, android_properties, false),
            )
            .await
            .map_err(error_text)?;
        if updated
            .properties
            .get("lotusLiveWriter")
            .map(String::as_str)
            != Some("android")
        {
            return Err(
                "Android conditional property patch was not visible in its response".into(),
            );
        }

        let replaced = client
            .update_file(
                &android_token,
                UpdateFileRequest {
                    file_id: updated.id.clone(),
                    name: Some(updated.name.clone()),
                    parents: vec![parent_id.clone()],
                    mime_type: "application/pdf".to_string(),
                    properties: updated.properties.clone(),
                    bytes: PDF_V2.to_vec(),
                    if_match: required_etag(&updated)?,
                    supports_all_drives: false,
                },
            )
            .await
            .map_err(error_text)?;
        if replaced.parents != [parent_id.clone()] {
            return Err(format!(
                "v2 multipart replacement left the file in parents {:?} instead of the selected folder",
                replaced.parents
            ));
        }
        if replaced
            .properties
            .get("lotusLiveWriter")
            .map(String::as_str)
            != Some("android")
        {
            return Err("v2 multipart replacement lost the public Drive properties".into());
        }
        let downloaded = client
            .download_file(
                &desktop_token,
                DownloadFileRequest {
                    file_id: replaced.id.clone(),
                    supports_all_drives: false,
                },
            )
            .await
            .map_err(error_text)?;
        if downloaded.bytes != PDF_V2 {
            return Err("v2 multipart replacement did not preserve the new bytes".into());
        }

        let desktop_etag = required_etag(&desktop)?;
        let mut stale_properties = desktop.properties.clone();
        stale_properties.insert("lotusLiveWriter".to_string(), "desktop".to_string());
        match client
            .patch_metadata(
                &desktop_token,
                property_patch(&desktop.id, &desktop_etag, stale_properties, false),
            )
            .await
        {
            Err(error) if error.code == DriveApiErrorCode::Conflict => Ok(()),
            Err(error) => Err(format!(
                "stale desktop patch returned {:?}, expected Conflict: {}",
                error.code, error.message
            )),
            Ok(_) => Err("stale desktop ETag unexpectedly overwrote the Android patch".into()),
        }
    }
    .await;

    finish_after_cleanup(
        outcome,
        trash_created(&client, &desktop_token, &created, false).await,
    );
}

#[tokio::test]
#[ignore = "requires explicit tokens plus LOTUS_DRIVE_LIVE_SHARED_PARENT_ID"]
async fn real_shared_drive_downloads_and_conditionally_replaces_multipart_bytes() {
    let Some(parent_id) = optional_env("LOTUS_DRIVE_LIVE_SHARED_PARENT_ID") else {
        eprintln!("SKIP: LOTUS_DRIVE_LIVE_SHARED_PARENT_ID was not supplied");
        return;
    };
    let desktop_token = required_env("LOTUS_DRIVE_LIVE_DESKTOP_TOKEN");
    let android_token = required_env("LOTUS_DRIVE_LIVE_ANDROID_TOKEN");
    let client = DriveClient::new();
    let reservation = reserve_disposable_file(&client, &desktop_token, &parent_id, true, PDF_V1)
        .await
        .unwrap_or_else(|error| panic!("could not reserve disposable Shared Drive file: {error}"));
    let create_result = client
        .create_file(&desktop_token, reservation.request)
        .await;
    let created = complete_create_or_cleanup(
        &client,
        &desktop_token,
        &reservation.file_id,
        true,
        create_result,
    )
    .await
    .unwrap_or_else(|error| panic!("could not create disposable Shared Drive file: {error}"));
    eprintln!("created disposable Shared Drive file ID: {}", created.id);

    let outcome = async {
        let exact = get_exact(&client, &desktop_token, &created.id, true).await?;
        let downloaded = client
            .download_file(
                &android_token,
                DownloadFileRequest {
                    file_id: created.id.clone(),
                    supports_all_drives: true,
                },
            )
            .await
            .map_err(error_text)?;
        if downloaded.bytes != PDF_V1 {
            return Err("Android client downloaded different initial bytes".into());
        }

        let mut properties = exact.properties.clone();
        properties.insert("lotusLiveWriter".to_string(), "android".to_string());
        client
            .update_file(
                &android_token,
                UpdateFileRequest {
                    file_id: exact.id.clone(),
                    name: Some(exact.name.clone()),
                    parents: vec![parent_id.clone()],
                    mime_type: "application/pdf".to_string(),
                    properties,
                    bytes: PDF_V2.to_vec(),
                    if_match: required_etag(&exact)?,
                    supports_all_drives: true,
                },
            )
            .await
            .map_err(error_text)?;

        let replaced = client
            .download_file(
                &desktop_token,
                DownloadFileRequest {
                    file_id: created.id.clone(),
                    supports_all_drives: true,
                },
            )
            .await
            .map_err(error_text)?;
        if replaced.file.id != created.id || replaced.bytes != PDF_V2 {
            return Err(
                "desktop client did not download the replacement from the same file ID".into(),
            );
        }
        if replaced
            .file
            .properties
            .get("lotusLiveWriter")
            .map(String::as_str)
            != Some("android")
        {
            return Err("desktop client did not observe replacement properties".into());
        }
        Ok(())
    }
    .await;

    finish_after_cleanup(
        outcome,
        trash_created(&client, &desktop_token, &created, true).await,
    );
}

struct DisposableFileReservation {
    file_id: String,
    request: CreateFileRequest,
}

async fn reserve_disposable_file(
    client: &DriveClient,
    token: &str,
    parent_id: &str,
    supports_all_drives: bool,
    bytes: &[u8],
) -> Result<DisposableFileReservation, String> {
    let ids = client
        .generate_file_ids(
            token,
            GenerateFileIdsRequest {
                count: 1,
                space: "drive".to_string(),
            },
        )
        .await
        .map_err(error_text)?;
    let [file_id] = ids.as_slice() else {
        return Err(format!(
            "Drive generated {} IDs instead of exactly one",
            ids.len()
        ));
    };
    Ok(disposable_file_reservation(
        file_id,
        parent_id,
        supports_all_drives,
        bytes,
    ))
}

fn disposable_file_reservation(
    file_id: &str,
    parent_id: &str,
    supports_all_drives: bool,
    bytes: &[u8],
) -> DisposableFileReservation {
    DisposableFileReservation {
        file_id: file_id.to_string(),
        request: CreateFileRequest {
            file_id: file_id.to_string(),
            name: unique_file_name(),
            parents: vec![parent_id.to_string()],
            mime_type: "application/pdf".to_string(),
            properties: HashMap::from([
                ("lotusSchema".to_string(), "1".to_string()),
                ("lotusLiveTest".to_string(), "disposable".to_string()),
            ]),
            bytes: bytes.to_vec(),
            supports_all_drives,
        },
    }
}

async fn get_exact(
    client: &DriveClient,
    token: &str,
    file_id: &str,
    supports_all_drives: bool,
) -> Result<DriveFileDto, String> {
    client
        .get_file(
            token,
            GetFileRequest {
                file_id: file_id.to_string(),
                supports_all_drives,
            },
        )
        .await
        .map_err(error_text)
}

fn property_patch(
    file_id: &str,
    if_match: &str,
    properties: HashMap<String, String>,
    supports_all_drives: bool,
) -> PatchMetadataRequest {
    PatchMetadataRequest {
        file_id: file_id.to_string(),
        name: None,
        properties: Some(properties),
        add_parents: None,
        remove_parents: None,
        if_match: if_match.to_string(),
        supports_all_drives,
    }
}

async fn trash_created(
    client: &DriveClient,
    token: &str,
    created: &DriveFileDto,
    supports_all_drives: bool,
) -> Result<(), String> {
    trash_exact_id(
        client,
        token,
        &created.id,
        supports_all_drives,
        created.etag.as_deref(),
    )
    .await
}

trait CleanupClient {
    async fn cleanup_get_file(
        &self,
        token: &str,
        file_id: &str,
        supports_all_drives: bool,
    ) -> Result<DriveFileDto, DriveApiError>;

    async fn cleanup_trash_file(
        &self,
        token: &str,
        request: TrashFileRequest,
    ) -> Result<DriveFileDto, DriveApiError>;
}

impl CleanupClient for DriveClient {
    async fn cleanup_get_file(
        &self,
        token: &str,
        file_id: &str,
        supports_all_drives: bool,
    ) -> Result<DriveFileDto, DriveApiError> {
        self.get_file(
            token,
            GetFileRequest {
                file_id: file_id.to_string(),
                supports_all_drives,
            },
        )
        .await
    }

    async fn cleanup_trash_file(
        &self,
        token: &str,
        request: TrashFileRequest,
    ) -> Result<DriveFileDto, DriveApiError> {
        self.trash_file(token, request).await
    }
}

async fn complete_create_or_cleanup<C: CleanupClient>(
    client: &C,
    token: &str,
    reserved_file_id: &str,
    supports_all_drives: bool,
    create_result: Result<DriveFileDto, DriveApiError>,
) -> Result<DriveFileDto, String> {
    match create_result {
        Ok(created) => Ok(created),
        Err(create_error) => {
            let create_error = error_text(create_error);
            let cleanup =
                trash_exact_id(client, token, reserved_file_id, supports_all_drives, None).await;
            match cleanup {
                Ok(()) => Err(format!(
                    "{create_error}; cleanup of reserved file ID {reserved_file_id} succeeded"
                )),
                Err(cleanup_error) => Err(format!(
                    "{create_error}; cleanup of reserved file ID {reserved_file_id} also failed: {cleanup_error}"
                )),
            }
        }
    }
}

async fn trash_exact_id<C: CleanupClient>(
    client: &C,
    token: &str,
    file_id: &str,
    supports_all_drives: bool,
    fallback_etag: Option<&str>,
) -> Result<(), String> {
    let exact = client
        .cleanup_get_file(token, file_id, supports_all_drives)
        .await;
    let if_match = exact
        .as_ref()
        .ok()
        .and_then(|file| file.etag.clone())
        .or_else(|| fallback_etag.map(str::to_string))
        .unwrap_or_default();
    let first = client
        .cleanup_trash_file(
            token,
            TrashFileRequest {
                file_id: file_id.to_string(),
                if_match,
                supports_all_drives,
            },
        )
        .await;
    match first {
        Ok(_) => Ok(()),
        Err(error) if error.code == DriveApiErrorCode::Conflict => {
            let fresh = client
                .cleanup_get_file(token, file_id, supports_all_drives)
                .await
                .map_err(error_text)?;
            client
                .cleanup_trash_file(
                    token,
                    TrashFileRequest {
                        file_id: file_id.to_string(),
                        if_match: required_etag(&fresh)?,
                        supports_all_drives,
                    },
                )
                .await
                .map(|_| ())
                .map_err(error_text)
        }
        Err(error) => Err(error_text(error)),
    }
}

fn finish_after_cleanup(outcome: Result<(), String>, cleanup: Result<(), String>) {
    match (outcome, cleanup) {
        (Ok(()), Ok(())) => {}
        (Err(error), Ok(())) => panic!("live Drive assertion failed after cleanup: {error}"),
        (Ok(()), Err(cleanup)) => {
            panic!("live Drive assertions passed, but cleanup failed: {cleanup}")
        }
        (Err(error), Err(cleanup)) => {
            panic!("live Drive assertion failed: {error}; cleanup also failed: {cleanup}")
        }
    }
}

fn required_etag(file: &DriveFileDto) -> Result<String, String> {
    file.etag
        .clone()
        .ok_or_else(|| format!("Drive omitted the HTTP ETag for file {}", file.id))
}

fn required_env(name: &str) -> String {
    optional_env(name).unwrap_or_else(|| panic!("{name} must be explicitly supplied"))
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn unique_file_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_nanos();
    format!("lotus-drive-live-disposable-{nanos}-{}.pdf", process::id())
}

fn error_text(error: DriveApiError) -> String {
    format!(
        "{:?}: {} (status={:?}, file_id={:?})",
        error.code, error.message, error.status, error.file_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_lib::drive_api::DriveCapabilitiesDto;
    use std::sync::Mutex;

    #[derive(Debug, PartialEq, Eq)]
    enum CleanupCall {
        Get {
            file_id: String,
            supports_all_drives: bool,
        },
        Trash {
            file_id: String,
            if_match: String,
            supports_all_drives: bool,
        },
    }

    #[derive(Default)]
    struct RecordingCleanupClient {
        calls: Mutex<Vec<CleanupCall>>,
    }

    impl CleanupClient for RecordingCleanupClient {
        async fn cleanup_get_file(
            &self,
            _token: &str,
            file_id: &str,
            supports_all_drives: bool,
        ) -> Result<DriveFileDto, DriveApiError> {
            self.calls.lock().unwrap().push(CleanupCall::Get {
                file_id: file_id.to_string(),
                supports_all_drives,
            });
            Ok(file(file_id, Some("\"fresh-etag\"")))
        }

        async fn cleanup_trash_file(
            &self,
            _token: &str,
            request: TrashFileRequest,
        ) -> Result<DriveFileDto, DriveApiError> {
            self.calls.lock().unwrap().push(CleanupCall::Trash {
                file_id: request.file_id.clone(),
                if_match: request.if_match,
                supports_all_drives: request.supports_all_drives,
            });
            Ok(file(&request.file_id, Some("\"trashed-etag\"")))
        }
    }

    #[tokio::test]
    async fn ambiguous_create_failure_cleans_the_exact_reserved_id_for_my_and_shared_drive() {
        for (file_id, supports_all_drives) in [
            ("reserved-my-drive-id", false),
            ("reserved-shared-drive-id", true),
        ] {
            let client = RecordingCleanupClient::default();
            let reservation = disposable_file_reservation(
                file_id,
                "explicit-parent",
                supports_all_drives,
                PDF_V1,
            );
            assert_eq!(reservation.file_id, file_id);
            assert_eq!(reservation.request.file_id, file_id);
            assert_eq!(reservation.request.supports_all_drives, supports_all_drives);
            let captured_generated_id = reservation.file_id;

            let error = complete_create_or_cleanup(
                &client,
                "desktop-token",
                &captured_generated_id,
                supports_all_drives,
                Err(ambiguous_create_error(&captured_generated_id)),
            )
            .await
            .unwrap_err();

            assert!(error.contains("Drive create response was ambiguous"));
            assert_eq!(
                *client.calls.lock().unwrap(),
                [
                    CleanupCall::Get {
                        file_id: captured_generated_id.clone(),
                        supports_all_drives,
                    },
                    CleanupCall::Trash {
                        file_id: captured_generated_id,
                        if_match: "\"fresh-etag\"".to_string(),
                        supports_all_drives,
                    },
                ]
            );
        }
    }

    fn file(file_id: &str, etag: Option<&str>) -> DriveFileDto {
        DriveFileDto {
            id: file_id.to_string(),
            name: "lotus-drive-live-disposable-test.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            parents: vec!["explicit-parent".to_string()],
            drive_id: None,
            owned_by_me: true,
            trashed: false,
            version: "1".to_string(),
            size: Some("1".to_string()),
            md5_checksum: None,
            sha256_checksum: None,
            properties: HashMap::new(),
            capabilities: DriveCapabilitiesDto::default(),
            etag: etag.map(str::to_string),
        }
    }

    fn ambiguous_create_error(file_id: &str) -> DriveApiError {
        DriveApiError {
            code: DriveApiErrorCode::Offline,
            message: "Drive create response was ambiguous".to_string(),
            status: None,
            retryable: true,
            file_id: Some(file_id.to_string()),
        }
    }
}
