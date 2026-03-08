use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

pub struct OAuthListener(pub Mutex<Option<TcpListener>>);

#[tauri::command]
pub fn start_oauth_server(state: State<OAuthListener>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(listener);
    Ok(port)
}

#[tauri::command]
pub fn wait_oauth_code(
    state: State<OAuthListener>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let listener = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("No OAuth server running")?
    };

    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120));
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;

    // Use SO_RCVTIMEO for accept timeout
    let raw_fd = {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            listener.as_raw_fd()
        }
    };
    #[cfg(unix)]
    unsafe {
        let tv = libc::timeval {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_usec: 0,
        };
        libc::setsockopt(
            raw_fd,
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            &tv as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::timeval>() as libc::socklen_t,
        );
    }

    let (mut stream, _) = listener
        .accept()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut
            {
                "OAuth timed out — no response from browser".to_string()
            } else {
                e.to_string()
            }
        })?;

    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| e.to_string())?;

    // Parse "GET /callback?code=AUTH_CODE&scope=... HTTP/1.1"
    let code = request_line
        .split_whitespace()
        .nth(1) // the path
        .and_then(|path| {
            url::Url::parse(&format!("http://localhost{}", path)).ok()
        })
        .and_then(|url| {
            url.query_pairs()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.into_owned())
        })
        .ok_or("No authorization code found in callback")?;

    // Send a simple HTML response
    let body = "<html><body><h2>Authorization successful</h2><p>You can close this tab and return to the app.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    Ok(code)
}
