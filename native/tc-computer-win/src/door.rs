//! The service's door (docs/computer-protocol.md §29.1): `serve --listen 127.0.0.1:PORT --token-file FILE`,
//! for a host on another machine that reaches the guest's loopback through an SSH forward. Platform-free:
//! main.rs gives `run` what to do with each host (on Windows, a fresh `serve` child on stdio).
//!
//! - The address must be loopback; any other is refused before anything listens.
//! - The token is the file's text with its surrounding whitespace dropped, 32 printable characters at least.
//! - The first line a connection sends is its knock, at most 512 bytes within 5 s:
//!   `TOKEN` (the host's wire), `TOKEN video` (the wire, and the bytes connection is coming), or
//!   `TOKEN bytes VIDEO_TOKEN` (live video's bytes, §30, VIDEO_TOKEN 16 to 128 hex digits). The token is
//!   compared in constant time; a wrong or missing one closes the connection with nothing written.
//! - One host at a time: a wire knock while a host is connected is answered with one JSON-RPC error line
//!   and closed. A bytes knock waits for the next host that asks for video (10 s at most); one asking waits
//!   3 s for it.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const TOKEN_MIN: usize = 32;
pub const KNOCK_MAX: usize = 512;

/// The line a second host gets before its connection is closed.
pub const BUSY_LINE: &str = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"another host is connected\"}}\n";

/// A loopback address to listen on, or why not.
pub fn loopback(addr: &str) -> Result<SocketAddr, String> {
    let a: SocketAddr = addr.parse().map_err(|_| format!("--listen takes an address and a port, not '{addr}'"))?;
    if !a.ip().is_loopback() {
        return Err(format!("--listen takes a loopback address, not {}", a.ip()));
    }
    Ok(a)
}

/// The token in a file: its text without surrounding whitespace.
pub fn read_token(path: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("the token file {}: {e}", path.display()))?;
    let t = raw.trim_ascii().to_vec();
    if t.len() < TOKEN_MIN || !t.iter().all(|b| b.is_ascii_graphic()) {
        return Err(format!("the token file {} must hold one token of {TOKEN_MIN} printable characters at least", path.display()));
    }
    Ok(t)
}

/// Equal bytes, in a time that depends only on the lengths.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() != b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

#[derive(Debug, PartialEq, Eq)]
pub enum Knock {
    Host { video: bool },
    Bytes { video_token: String },
}

/// A knock line (without its line feed) read against the token, or None.
pub fn parse_knock(line: &[u8], token: &[u8]) -> Option<Knock> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let mut words = line.split(|b| *b == b' ');
    let given = words.next()?;
    let ok = same(given, token);
    let rest: Vec<&[u8]> = words.collect();
    if !ok {
        return None;
    }
    match rest.as_slice() {
        [] => Some(Knock::Host { video: false }),
        [w] if *w == b"video" => Some(Knock::Host { video: true }),
        [w, vt] if *w == b"bytes" && (16..=128).contains(&vt.len()) && vt.iter().all(u8::is_ascii_hexdigit) => {
            Some(Knock::Bytes { video_token: String::from_utf8_lossy(vt).into_owned() })
        }
        _ => None,
    }
}

/// The bytes connection of live video, with the token the service writes first on it.
pub struct Bytes {
    pub stream: TcpStream,
    pub video_token: String,
}

/// A host let in: its wire, and its bytes when it asked for video and they came.
pub struct Host {
    pub wire: TcpStream,
    pub bytes: Option<Bytes>,
}

/// The door's times; `Door::default()` is the service's.
#[derive(Clone, Copy)]
pub struct Timing {
    pub knock: Duration,
    pub bytes_wait: Duration,
    pub bytes_fresh: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { knock: Duration::from_secs(5), bytes_wait: Duration::from_secs(3), bytes_fresh: Duration::from_secs(10) }
    }
}

#[derive(Default)]
struct State {
    host: bool,
    /// the host let in is waiting for its bytes connection
    waiting: bool,
    bytes: Option<(Bytes, Instant)>,
}

struct Door {
    token: Vec<u8>,
    timing: Timing,
    state: Mutex<State>,
    came: Condvar,
}

fn guard(m: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The first line, read a byte at a time so nothing past its line feed is taken from the wire.
fn read_knock(s: &mut TcpStream, timing: &Timing) -> Option<Vec<u8>> {
    s.set_read_timeout(Some(timing.knock)).ok()?;
    let deadline = Instant::now() + timing.knock;
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    loop {
        if Instant::now() > deadline {
            return None;
        }
        match s.read(&mut b) {
            Ok(1) if b[0] == b'\n' => break,
            Ok(1) if line.len() < KNOCK_MAX => line.push(b[0]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            _ => return None,
        }
    }
    s.set_read_timeout(None).ok()?;
    Some(line)
}

/// Serves every connection to `listener` until it fails: each knock on its own thread, `serve` once per host
/// let in, on that host's thread, and the next host let in only after `serve` returns.
pub fn run<F>(listener: TcpListener, token: Vec<u8>, timing: Timing, serve: F) -> io::Result<()>
where
    F: Fn(Host) + Send + Sync + 'static,
{
    let door = Arc::new(Door { token, timing, state: Mutex::default(), came: Condvar::new() });
    let serve = Arc::new(serve);
    for conn in listener.incoming() {
        let s = match conn {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::Interrupted || e.kind() == io::ErrorKind::ConnectionAborted => continue,
            Err(e) => return Err(e),
        };
        let (door, serve) = (door.clone(), serve.clone());
        std::thread::spawn(move || admit(&door, s, &*serve));
    }
    Ok(())
}

fn admit(door: &Door, mut s: TcpStream, serve: &dyn Fn(Host)) {
    if !s.peer_addr().is_ok_and(|a| a.ip().is_loopback()) {
        return;
    }
    let Some(line) = read_knock(&mut s, &door.timing) else { return };
    let _ = s.set_nodelay(true);
    match parse_knock(&line, &door.token) {
        None => eprintln!("door: a connection knocked without the token; closed"),
        Some(Knock::Bytes { video_token }) => {
            let mut st = guard(&door.state);
            if st.host && !st.waiting {
                eprintln!("door: a bytes connection came while a host is connected; closed");
                return;
            }
            st.bytes = Some((Bytes { stream: s, video_token }, Instant::now()));
            door.came.notify_all();
        }
        Some(Knock::Host { video }) => {
            let mut st = guard(&door.state);
            if st.host {
                drop(st);
                eprintln!("door: a second host knocked; refused");
                let _ = s.write_all(BUSY_LINE.as_bytes());
                return;
            }
            st.host = true;
            let mut bytes = None;
            if video {
                st.waiting = true;
                let until = Instant::now() + door.timing.bytes_wait;
                loop {
                    if let Some((b, at)) = st.bytes.take() {
                        if at.elapsed() <= door.timing.bytes_fresh {
                            bytes = Some(b);
                            break;
                        }
                    }
                    let left = until.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        eprintln!("door: the host asked for video and no bytes connection came");
                        break;
                    }
                    st = door.came.wait_timeout(st, left).unwrap_or_else(|e| e.into_inner()).0;
                }
                st.waiting = false;
            }
            drop(st);
            serve(Host { wire: s, bytes });
            guard(&door.state).host = false;
        }
    }
}
