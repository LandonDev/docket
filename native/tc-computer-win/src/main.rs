//! `tc-computer` on Windows (docs/computer-protocol.md §29).
//!
//!   tc-computer serve                      the wire on stdin and stdout, as the host spawns it
//!   tc-computer serve --listen 127.0.0.1:N --token-file FILE
//!                                          the door (src/door.rs): a host on another machine, through
//!                                          an SSH forward, knocks with the file's token and gets a
//!                                          fresh `serve` child on stdio, one host at a time, with live
//!                                          video's bytes on a second connection
//!   tc-computer hold-lock clipboard|session MS
//!   tc-computer version
//!
//! stdout carries frames and nothing else while serving; stderr is the log. With
//! TC_COMPUTER_VIDEO_PIPE and TC_COMPUTER_VIDEO_TOKEN set, `serve` dials that pipe
//! before it reads a line and writes the token first: live video's bytes (§30).

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
            eprintln!("usage: tc-computer serve [--listen 127.0.0.1:PORT --token-file FILE] | hold-lock clipboard|session MS | version");
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
    let path = tc_computer_win::locks::machine_lock_path(&tc_computer_win::locks::user_temp(), which);
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

#[cfg(not(windows))]
fn serve(args: &[String]) -> i32 {
    if !args.is_empty() {
        return listen(args);
    }
    eprintln!("tc-computer serves the wire on Windows only");
    64
}

/// `serve --listen ADDR --token-file FILE`: the address and the token checked before anything listens.
fn door_args(args: &[String]) -> Result<(std::net::SocketAddr, Vec<u8>), String> {
    let [a, addr, b, file] = args else { return Err("serve --listen takes 127.0.0.1:PORT --token-file FILE".into()) };
    if a != "--listen" || b != "--token-file" {
        return Err("serve --listen takes 127.0.0.1:PORT --token-file FILE".into());
    }
    Ok((tc_computer_win::door::loopback(addr)?, tc_computer_win::door::read_token(std::path::Path::new(file))?))
}

#[cfg(windows)]
fn listen(args: &[String]) -> i32 {
    let (addr, token) = match door_args(args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return 64;
        }
    };
    let listener = match std::net::TcpListener::bind(addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{addr}: {e}");
            return 70;
        }
    };
    eprintln!("listening on {addr}");
    // the logon task starts the door in a console, which Windows Terminal shows on tcuser's desktop, in front of
    // the apps a thread opens and where a key meant for them could land: let it go once the door listens
    let _ = unsafe { windows::Win32::System::Console::FreeConsole() };
    match tc_computer_win::door::run(listener, token, Default::default(), host) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("door: {e}");
            70
        }
    }
}

/// One host let in by the door: a fresh `serve` on stdio, its stdin and stdout carried to the host's wire, and
/// its bytes pipe to the host's bytes connection, until the wire closes or the child ends.
#[cfg(windows)]
fn host(h: tc_computer_win::door::Host) {
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tc_computer_win::platform::video::{pipe_server, poke};
    static N: AtomicU64 = AtomicU64::new(0);

    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = Command::new(exe);
    cmd.arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    cmd.env_remove("TC_COMPUTER_VIDEO_PIPE").env_remove("TC_COMPUTER_VIDEO_TOKEN");
    // a host through the door drives a machine nobody sits at (the VM): see Service::without_person
    cmd.env("TC_COMPUTER_NO_PERSON", "1");
    let mut bytes = None;
    if let Some(b) = h.bytes {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let name = format!(r"\\.\pipe\tc-computer-video-{}-{nanos:x}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
        match pipe_server(&name) {
            Ok(pipe) => {
                cmd.env("TC_COMPUTER_VIDEO_PIPE", &name).env("TC_COMPUTER_VIDEO_TOKEN", &b.video_token);
                bytes = Some((name, std::thread::spawn(move || pipe.splice(b.stream))));
            }
            Err(e) => eprintln!("door: the video pipe {name}: {e}; no video"),
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("door: serve did not start: {e}");
            if let Some((name, _)) = &bytes {
                poke(name);
            }
            return;
        }
    };
    eprintln!("door: a host is in; serve is pid {}", child.id());
    let (mut stdin, mut stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
    let (mut wire_in, mut wire_out) = (h.wire.try_clone().expect("a socket clones"), h.wire);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut stdout, &mut wire_out);
        let _ = wire_out.shutdown(std::net::Shutdown::Both);
    });
    // the host's lines to the child until the wire closes; then the child's stdin closes and it exits (§1)
    let _ = std::io::copy(&mut wire_in, &mut stdin);
    drop(stdin);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if matches!(child.try_wait(), Ok(None)) {
        eprintln!("door: serve did not end after the host left; killed");
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = up.join();
    if let Some((name, splice)) = bytes {
        poke(&name);
        let _ = splice.join();
    }
    eprintln!("door: the host left");
}

#[cfg(not(windows))]
fn listen(args: &[String]) -> i32 {
    if let Err(e) = door_args(args) {
        eprintln!("{e}");
        return 64;
    }
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

    if !args.is_empty() {
        return listen(args);
    }
    // frames in physical pixels on every monitor
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let desktop = match WindowsDesktop::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("UI Automation is not available: {}", e.message());
            return 70;
        }
    };
    let service = Service::new(desktop, VERSION);
    // the door's child: nobody sits at this desktop (a VM)
    let service = Arc::new(if std::env::var("TC_COMPUTER_NO_PERSON").as_deref() == Ok("1") { service.without_person() } else { service });
    // live video's bytes pipe (§30): dialed before any line is read, so before initialize is answered
    if let (Ok(name), Ok(token)) = (std::env::var("TC_COMPUTER_VIDEO_PIPE"), std::env::var("TC_COMPUTER_VIDEO_TOKEN")) {
        match tc_computer_win::platform::video::dial(&name) {
            Ok((reader, writer)) => service.attach_video_pipe(reader, writer, token.as_bytes()),
            Err(e) => eprintln!("video: the pipe {name} did not answer ({e}); no video"),
        }
    }
    serve(service, std::io::stdin(), Box::new(std::io::stdout())).0
}
