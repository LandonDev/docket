//! `tc-computer` on Windows (docs/computer-protocol.md §29).
//!
//!   tc-computer serve                      the wire on stdin and stdout, as the host spawns it
//!   tc-computer serve --listen 127.0.0.1:N one loopback connection instead of stdio, for the rig's
//!                                          proof only (TC_COMPUTER_PROOF=1): a service started on
//!                                          the desktop by the Task Scheduler has no pipe to the host
//!   tc-computer hold-lock clipboard|session MS
//!   tc-computer version
//!
//! stdout carries frames and nothing else while serving; stderr is the log.

use std::time::Duration;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("version") => {
            println!("{VERSION}");
            0
        }
        Some("serve") => serve(&args[1..]),
        Some("hold-lock") => hold_lock(&args[1..]),
        _ => {
            eprintln!("usage: tc-computer serve [--listen 127.0.0.1:PORT] | hold-lock clipboard|session MS | version");
            64
        }
    };
    std::process::exit(code);
}

fn hold_lock(args: &[String]) -> i32 {
    let (Some(which), Some(ms)) = (args.first(), args.get(1).and_then(|m| m.parse::<u64>().ok())) else { return 64 };
    if which != "clipboard" && which != "session" {
        return 64;
    }
    let path = tc_computer_win::locks::machine_lock_path(&user_temp(), which);
    match tc_computer_win::locks::lock_file(&path, Duration::from_secs(5)) {
        Ok(Some(_held)) => {
            println!("{{\"held\":true}}");
            std::thread::sleep(Duration::from_millis(ms));
            0
        }
        Ok(None) => {
            println!("{{\"held\":false}}");
            1
        }
        Err(e) => {
            eprintln!("{e}");
            70
        }
    }
}

/// The signed-in user's own temporary folder: `%LOCALAPPDATA%\Temp`, never a `TMP` a caller set.
fn user_temp() -> std::path::PathBuf {
    match std::env::var_os("LOCALAPPDATA") {
        Some(l) if cfg!(windows) => std::path::PathBuf::from(l).join("Temp"),
        _ => std::env::temp_dir(),
    }
}

#[cfg(not(windows))]
fn serve(_args: &[String]) -> i32 {
    eprintln!("tc-computer serves the wire on Windows only");
    64
}

#[cfg(windows)]
fn serve(args: &[String]) -> i32 {
    use std::sync::Arc;
    use tc_computer_win::platform::windows::WindowsDesktop;
    use tc_computer_win::server::serve;
    use tc_computer_win::service::Service;
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

    // frames in physical pixels on every monitor
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let desktop = match WindowsDesktop::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("UI Automation is not available: {}", e.message());
            return 70;
        }
    };
    let service = Arc::new(Service::new(desktop, VERSION));
    match args {
        [flag, addr] if flag == "--listen" => {
            if std::env::var("TC_COMPUTER_PROOF").as_deref() != Ok("1") {
                eprintln!("--listen is for the rig's proof only (TC_COMPUTER_PROOF=1)");
                return 64;
            }
            let Ok(addr) = addr.parse::<std::net::SocketAddr>() else { return 64 };
            if !addr.ip().is_loopback() {
                eprintln!("--listen takes a loopback address");
                return 64;
            }
            let listener = match std::net::TcpListener::bind(addr) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("{e}");
                    return 70;
                }
            };
            eprintln!("listening on {addr}");
            let Ok((stream, _)) = listener.accept() else { return 70 };
            let reader = stream.try_clone().expect("a socket clones");
            serve(service, reader, Box::new(stream)).0
        }
        [] => serve(service, std::io::stdin(), Box::new(std::io::stdout())).0,
        _ => 64,
    }
}
