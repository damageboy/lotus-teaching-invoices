use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

struct PendingOAuth {
    listener: TcpListener,
    expected_state: String,
}

enum OAuthLifecycle {
    Idle,
    Pending(PendingOAuth),
    Waiting,
}

pub struct OAuthListener(Mutex<OAuthLifecycle>);

impl Default for OAuthListener {
    fn default() -> Self {
        Self(Mutex::new(OAuthLifecycle::Idle))
    }
}

struct ResetOAuthOnDrop<'a> {
    listener: &'a OAuthListener,
}

impl Drop for ResetOAuthOnDrop<'_> {
    fn drop(&mut self) {
        let mut lifecycle = self
            .listener
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *lifecycle = OAuthLifecycle::Idle;
    }
}

impl OAuthListener {
    fn start_flow(&self, expected_state: String) -> Result<u16, String> {
        if expected_state.len() < 32 || expected_state.len() > 256 {
            return Err("Invalid OAuth state".to_string());
        }

        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let mut lifecycle = self.0.lock().map_err(|error| error.to_string())?;
        if !matches!(*lifecycle, OAuthLifecycle::Idle) {
            return Err("An OAuth authorization is already in progress".to_string());
        }
        *lifecycle = OAuthLifecycle::Pending(PendingOAuth {
            listener,
            expected_state,
        });
        Ok(port)
    }

    fn cancel_pending(&self) -> Result<(), String> {
        let mut lifecycle = self.0.lock().map_err(|error| error.to_string())?;
        match &*lifecycle {
            OAuthLifecycle::Idle => Ok(()),
            OAuthLifecycle::Pending(_) => {
                *lifecycle = OAuthLifecycle::Idle;
                Ok(())
            }
            OAuthLifecycle::Waiting => {
                Err("OAuth authorization is already being awaited".to_string())
            }
        }
    }

    fn wait_with<T>(
        &self,
        timeout: Duration,
        wait: impl FnOnce(PendingOAuth, Duration) -> Result<T, String>,
    ) -> Result<T, String> {
        let pending = {
            let mut lifecycle = self.0.lock().map_err(|error| error.to_string())?;
            match std::mem::replace(&mut *lifecycle, OAuthLifecycle::Waiting) {
                OAuthLifecycle::Pending(pending) => pending,
                OAuthLifecycle::Idle => {
                    *lifecycle = OAuthLifecycle::Idle;
                    return Err("No OAuth server running".to_string());
                }
                OAuthLifecycle::Waiting => {
                    *lifecycle = OAuthLifecycle::Waiting;
                    return Err("OAuth authorization is already being awaited".to_string());
                }
            }
        };

        let _reset = ResetOAuthOnDrop { listener: self };
        wait(pending, timeout)
    }
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OAuthCallbackOutcome {
    Success { code: String },
    AccessDenied,
    Timeout,
    MalformedCallback,
    OAuthError { error: String },
}

#[tauri::command]
pub fn start_oauth_server(
    state: State<OAuthListener>,
    expected_state: String,
) -> Result<u16, String> {
    state.start_flow(expected_state)
}

#[tauri::command]
pub fn cancel_oauth_server(state: State<OAuthListener>) -> Result<(), String> {
    state.cancel_pending()
}

pub(crate) fn parse_oauth_callback_path(path: &str, expected_state: &str) -> OAuthCallbackOutcome {
    if !path.starts_with('/') {
        return OAuthCallbackOutcome::MalformedCallback;
    }

    let Ok(url) = url::Url::parse(&format!("http://localhost{path}")) else {
        return OAuthCallbackOutcome::MalformedCallback;
    };

    let codes: Vec<String> = url
        .query_pairs()
        .filter(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .collect();
    let errors: Vec<String> = url
        .query_pairs()
        .filter(|(key, _)| key == "error")
        .map(|(_, value)| value.into_owned())
        .collect();
    let states: Vec<String> = url
        .query_pairs()
        .filter(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .collect();

    if states.as_slice() != [expected_state] {
        return OAuthCallbackOutcome::MalformedCallback;
    }

    if !codes.is_empty() && !errors.is_empty() {
        return OAuthCallbackOutcome::MalformedCallback;
    }

    match (codes.as_slice(), errors.as_slice()) {
        ([code], []) if !code.is_empty() => OAuthCallbackOutcome::Success { code: code.clone() },
        ([], [error]) if error == "access_denied" => OAuthCallbackOutcome::AccessDenied,
        ([], [error]) if !error.is_empty() => OAuthCallbackOutcome::OAuthError {
            error: error.clone(),
        },
        _ => OAuthCallbackOutcome::MalformedCallback,
    }
}

fn parse_oauth_request_line(request_line: &str, expected_state: &str) -> OAuthCallbackOutcome {
    let mut parts = request_line.split_whitespace();
    let Some(method) = parts.next() else {
        return OAuthCallbackOutcome::MalformedCallback;
    };
    let Some(path) = parts.next() else {
        return OAuthCallbackOutcome::MalformedCallback;
    };
    let Some(version) = parts.next() else {
        return OAuthCallbackOutcome::MalformedCallback;
    };
    if method != "GET" || !version.starts_with("HTTP/") || parts.next().is_some() {
        return OAuthCallbackOutcome::MalformedCallback;
    }
    parse_oauth_callback_path(path, expected_state)
}

fn send_browser_response(stream: &mut TcpStream, outcome: &OAuthCallbackOutcome) {
    let message = match outcome {
        OAuthCallbackOutcome::Success { .. } => {
            "Authorization response received. You can close this tab and return to the app."
        }
        OAuthCallbackOutcome::AccessDenied => {
            "Authorization was not granted. You can close this tab and return to the app."
        }
        OAuthCallbackOutcome::MalformedCallback | OAuthCallbackOutcome::OAuthError { .. } => {
            "Authorization could not be completed. You can close this tab and return to the app."
        }
        OAuthCallbackOutcome::Timeout => return,
    };
    let body = format!("<html><body><h2>Google authorization</h2><p>{message}</p></body></html>");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[tauri::command]
pub fn wait_oauth_code(
    state: State<OAuthListener>,
    timeout_secs: Option<u64>,
) -> Result<OAuthCallbackOutcome, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120));
    state.wait_with(timeout, wait_for_oauth_callback)
}

fn wait_for_oauth_callback(
    pending: PendingOAuth,
    timeout: Duration,
) -> Result<OAuthCallbackOutcome, String> {
    let listener = pending.listener;
    let expected_state = pending.expected_state;

    listener.set_nonblocking(false).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    unsafe {
        use std::os::unix::io::AsRawFd;
        let tv = libc::timeval {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_usec: 0,
        };
        let result = libc::setsockopt(
            listener.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            &tv as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::timeval>() as libc::socklen_t,
        );
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }

    let (mut stream, _) = match listener.accept() {
        Ok(connection) => connection,
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.kind() == std::io::ErrorKind::TimedOut =>
        {
            return Ok(OAuthCallbackOutcome::Timeout);
        }
        Err(error) => return Err(error.to_string()),
    };

    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    let outcome = match reader.read_line(&mut request_line) {
        Ok(0) => OAuthCallbackOutcome::MalformedCallback,
        Ok(_) => parse_oauth_request_line(&request_line, &expected_state),
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.kind() == std::io::ErrorKind::TimedOut =>
        {
            OAuthCallbackOutcome::Timeout
        }
        Err(error) => return Err(error.to_string()),
    };

    send_browser_response(&mut stream, &outcome);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_oauth_callback_path, parse_oauth_request_line, OAuthCallbackOutcome, OAuthListener,
    };
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    fn oauth_state(label: &str) -> String {
        format!("{label}-{}", "x".repeat(64))
    }

    #[test]
    fn second_start_does_not_replace_the_pending_flow() {
        let state = OAuthListener::default();
        let first_state = oauth_state("first");

        state.start_flow(first_state.clone()).unwrap();
        assert!(state.start_flow(oauth_state("second")).is_err());

        let observed_state = state
            .wait_with(Duration::from_secs(1), |pending, _| {
                Ok(pending.expected_state)
            })
            .unwrap();
        assert_eq!(observed_state, first_state);
    }

    #[test]
    fn cancelling_a_pending_flow_returns_the_listener_to_idle() {
        let state = OAuthListener::default();
        state.start_flow(oauth_state("abandoned")).unwrap();

        state.cancel_pending().unwrap();
        state.start_flow(oauth_state("retry")).unwrap();
    }

    #[test]
    fn start_and_second_wait_are_rejected_while_a_wait_is_active() {
        let state = Arc::new(OAuthListener::default());
        state.start_flow(oauth_state("first")).unwrap();
        let waiting_state = Arc::clone(&state);
        let (waiting_tx, waiting_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let wait_thread = thread::spawn(move || {
            waiting_state.wait_with(Duration::from_secs(1), |_, _| {
                waiting_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|error| error.to_string())?;
                Ok(OAuthCallbackOutcome::Timeout)
            })
        });
        waiting_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let attempt_state = Arc::clone(&state);
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let attempt_thread = thread::spawn(move || {
            let start_rejected = attempt_state.start_flow(oauth_state("second")).is_err();
            let second_wait_rejected = attempt_state
                .wait_with(Duration::from_secs(1), |_, _| {
                    Ok(OAuthCallbackOutcome::Timeout)
                })
                .is_err();
            let cancel_rejected = attempt_state.cancel_pending().is_err();
            attempt_tx
                .send((start_rejected, second_wait_rejected, cancel_rejected))
                .unwrap();
        });
        let attempts = attempt_rx.recv_timeout(Duration::from_secs(2));
        release_tx.send(()).unwrap();
        wait_thread.join().unwrap().unwrap();
        attempt_thread.join().unwrap();

        assert_eq!(
            attempts.expect("start/wait attempt blocked on the lifecycle mutex"),
            (true, true, true)
        );
        state.start_flow(oauth_state("after-wait")).unwrap();
    }

    #[test]
    fn every_wait_result_returns_the_listener_to_idle() {
        let state = OAuthListener::default();
        let outcomes = [
            OAuthCallbackOutcome::Success {
                code: "code".to_string(),
            },
            OAuthCallbackOutcome::AccessDenied,
            OAuthCallbackOutcome::Timeout,
            OAuthCallbackOutcome::MalformedCallback,
            OAuthCallbackOutcome::OAuthError {
                error: "server_error".to_string(),
            },
        ];

        for (index, expected) in outcomes.into_iter().enumerate() {
            state
                .start_flow(oauth_state(&format!("flow-{index}")))
                .unwrap();
            state
                .wait_with(Duration::from_secs(1), |_, _| Ok(expected))
                .unwrap();
        }

        state.start_flow(oauth_state("io-error")).unwrap();
        assert_eq!(
            state
                .wait_with(Duration::from_secs(1), |_, _| {
                    Err::<OAuthCallbackOutcome, _>("injected I/O error".to_string())
                })
                .unwrap_err(),
            "injected I/O error"
        );
        state.start_flow(oauth_state("after-error")).unwrap();
    }

    #[test]
    fn parses_authorization_code_callback() {
        assert_eq!(
            parse_oauth_callback_path(
                "/callback?code=authorization%20code&scope=scope&state=expected-state",
                "expected-state"
            ),
            OAuthCallbackOutcome::Success {
                code: "authorization code".to_string()
            }
        );
    }

    #[test]
    fn parses_access_denied_callback() {
        assert_eq!(
            parse_oauth_callback_path(
                "/callback?error=access_denied&state=expected-state",
                "expected-state"
            ),
            OAuthCallbackOutcome::AccessDenied
        );
    }

    #[test]
    fn rejects_callback_without_code_or_error() {
        assert_eq!(
            parse_oauth_callback_path(
                "/callback?scope=scope&state=expected-state",
                "expected-state"
            ),
            OAuthCallbackOutcome::MalformedCallback
        );
    }

    #[test]
    fn rejects_empty_duplicate_or_conflicting_callback_values() {
        for path in [
            "/callback?code=&state=expected-state",
            "/callback?code=one&code=two&state=expected-state",
            "/callback?code=one&error=access_denied&state=expected-state",
            "not-a-relative-callback",
        ] {
            assert_eq!(
                parse_oauth_callback_path(path, "expected-state"),
                OAuthCallbackOutcome::MalformedCallback,
                "path: {path}"
            );
        }
    }

    #[test]
    fn preserves_other_explicit_oauth_errors() {
        assert_eq!(
            parse_oauth_callback_path(
                "/callback?error=server_error&state=expected-state",
                "expected-state"
            ),
            OAuthCallbackOutcome::OAuthError {
                error: "server_error".to_string()
            }
        );
    }

    #[test]
    fn rejects_malformed_http_request_line() {
        for line in [
            "POST /callback?code=one HTTP/1.1",
            "GET /callback?code=one",
            "GET /callback?code=one HTTP/1.1 extra",
        ] {
            assert_eq!(
                parse_oauth_request_line(line, "expected-state"),
                OAuthCallbackOutcome::MalformedCallback,
                "request line: {line}"
            );
        }
    }

    #[test]
    fn rejects_missing_or_mismatched_oauth_state() {
        for path in [
            "/callback?code=one",
            "/callback?code=one&state=wrong-state",
            "/callback?code=one&state=expected-state&state=expected-state",
        ] {
            assert_eq!(
                parse_oauth_callback_path(path, "expected-state"),
                OAuthCallbackOutcome::MalformedCallback,
                "path: {path}"
            );
        }
    }
}
