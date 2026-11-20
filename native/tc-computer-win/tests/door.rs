//! The door of `serve --listen` (§29.1) over real loopback sockets: the address, the token file, the knock,
//! the token compared, one host at a time, and the bytes connection handed to the host that asked for video.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

use tc_computer_win::door::{self, Knock, Timing, BUSY_LINE};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";
const VT: &str = "feedfacefeedfacefeedfacefeedface";

#[test]
fn listens_on_loopback_only() {
    assert!(door::loopback("127.0.0.1:47820").is_ok());
    assert!(door::loopback("[::1]:47820").is_ok());
    for addr in ["0.0.0.0:47820", "10.0.2.15:47820", "192.168.1.4:1", "[::]:47820", "localhost:47820", "127.0.0.1", ""] {
        assert!(door::loopback(addr).is_err(), "{addr} was let through");
    }
}

#[test]
fn reads_the_token_file() {
    let dir = std::env::temp_dir().join(format!("tc-door-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("token");
    std::fs::write(&f, format!("{TOKEN}\r\n")).unwrap();
    assert_eq!(door::read_token(&f).unwrap(), TOKEN.as_bytes());
    std::fs::write(&f, "short\n").unwrap();
    assert!(door::read_token(&f).is_err());
    std::fs::write(&f, format!("{} {}", &TOKEN[..20], &TOKEN[20..])).unwrap();
    assert!(door::read_token(&f).is_err(), "a space inside the token");
    assert!(door::read_token(&dir.join("missing")).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn knocks_are_judged_by_the_token() {
    let t = TOKEN.as_bytes();
    assert_eq!(door::parse_knock(TOKEN.as_bytes(), t), Some(Knock::Host { video: false }));
    assert_eq!(door::parse_knock(format!("{TOKEN}\r").as_bytes(), t), Some(Knock::Host { video: false }));
    assert_eq!(door::parse_knock(format!("{TOKEN} video").as_bytes(), t), Some(Knock::Host { video: true }));
    assert_eq!(door::parse_knock(format!("{TOKEN} bytes {VT}").as_bytes(), t), Some(Knock::Bytes { video_token: VT.into() }));
    for bad in [
        String::new(),
        TOKEN[..TOKEN.len() - 1].to_string(),
        format!("{TOKEN}0"),
        format!("x{}", &TOKEN[1..]),
        format!("{TOKEN} bytes"),
        format!("{TOKEN} bytes not-hex-not-hex-not-hex"),
        format!("{TOKEN} bytes abc"),
        format!("{TOKEN} shell"),
        format!("{} video", &TOKEN[1..]),
    ] {
        assert_eq!(door::parse_knock(bad.as_bytes(), t), None, "{bad:?}");
    }
    assert!(door::same(b"abc", b"abc") && !door::same(b"abc", b"abd") && !door::same(b"abc", b"abcd") && !door::same(b"", b"a"));
}

/// A door on a free loopback port whose hosts echo their wire line by line until it closes, and report
/// to `seen` each host's video token (or "") as it is let in.
fn echo_door(timing: Timing) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    std::thread::spawn(move || {
        door::run(listener, TOKEN.as_bytes().to_vec(), timing, move |host| {
            let vt = host.bytes.as_ref().map_or(String::new(), |b| b.video_token.clone());
            if let Some(mut b) = host.bytes {
                let _ = b.stream.write_all(vt.as_bytes());
            }
            tx.lock().unwrap().send(vt).unwrap();
            let mut out = host.wire.try_clone().unwrap();
            for line in BufReader::new(host.wire).lines() {
                let Ok(line) = line else { break };
                if writeln!(out, "echo {line}").is_err() {
                    break;
                }
            }
        })
        .unwrap();
    });
    (port, rx)
}

fn fast() -> Timing {
    Timing { knock: Duration::from_millis(500), bytes_wait: Duration::from_millis(800), bytes_fresh: Duration::from_secs(5) }
}

fn knock(port: u16, line: &str) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(line.as_bytes()).unwrap();
    s
}

fn line_of(s: &TcpStream) -> Option<String> {
    let mut l = String::new();
    match BufReader::new(s).read_line(&mut l) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(l),
    }
}

/// Reads until the far end closes; true when it closed with nothing sent.
fn closed_silent(mut s: TcpStream) -> bool {
    let mut buf = Vec::new();
    matches!(s.read_to_end(&mut buf), Ok(0)) || (buf.is_empty())
}

#[test]
fn the_token_lets_a_host_in_and_the_wire_follows_the_knock() {
    let (port, seen) = echo_door(fast());
    // the knock and the first frame in one write: nothing past the knock's line feed is lost
    let s = knock(port, &format!("{TOKEN}\n{{\"id\":1}}\n"));
    assert_eq!(line_of(&s).as_deref(), Some("echo {\"id\":1}\n"));
    assert_eq!(seen.recv_timeout(Duration::from_secs(2)).unwrap(), "");
}

#[test]
fn a_wrong_or_missing_token_closes_the_connection() {
    let (port, seen) = echo_door(fast());
    for line in [format!("{}x\nhello\n", &TOKEN[..TOKEN.len() - 1]), "\nhello\n".into(), "hello\n".into()] {
        assert!(closed_silent(knock(port, &line)), "{line:?}");
    }
    // no line at all within the knock's time
    assert!(closed_silent(knock(port, "")));
    // a line longer than a knock may be
    assert!(closed_silent(knock(port, &format!("{}\n", "a".repeat(600)))));
    assert!(seen.recv_timeout(Duration::from_millis(300)).is_err(), "a host was let in");
}

#[test]
fn one_host_at_a_time() {
    let (port, seen) = echo_door(fast());
    let mut first = knock(port, &format!("{TOKEN}\n"));
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    // a second, even with the token, is answered busy and closed
    let second = knock(port, &format!("{TOKEN}\nhello\n"));
    assert_eq!(line_of(&second).as_deref(), Some(BUSY_LINE));
    assert!(seen.recv_timeout(Duration::from_millis(300)).is_err());
    // a bytes connection while the host is in is closed too
    assert!(closed_silent(knock(port, &format!("{TOKEN} bytes {VT}\n"))));
    // the first still works; once it closes the next host is let in
    first.write_all(b"still\n").unwrap();
    assert_eq!(line_of(&first).as_deref(), Some("echo still\n"));
    drop(first);
    std::thread::sleep(Duration::from_millis(100));
    let third = knock(port, &format!("{TOKEN}\nagain\n"));
    assert_eq!(line_of(&third).as_deref(), Some("echo again\n"));
}

#[test]
fn the_bytes_connection_goes_to_the_host_that_asks_for_video() {
    let (port, seen) = echo_door(fast());
    // bytes first, then the host
    let mut bytes = knock(port, &format!("{TOKEN} bytes {VT}\n"));
    std::thread::sleep(Duration::from_millis(100));
    let wire = knock(port, &format!("{TOKEN} video\nhi\n"));
    assert_eq!(seen.recv_timeout(Duration::from_secs(2)).unwrap(), VT);
    let mut got = vec![0u8; VT.len()];
    bytes.read_exact(&mut got).unwrap();
    assert_eq!(got, VT.as_bytes());
    assert_eq!(line_of(&wire).as_deref(), Some("echo hi\n"));
    drop((wire, bytes));
    std::thread::sleep(Duration::from_millis(100));

    // the host first: it waits for the bytes
    let wire = knock(port, &format!("{TOKEN} video\n"));
    std::thread::sleep(Duration::from_millis(200));
    let _bytes = knock(port, &format!("{TOKEN} bytes {VT}\n"));
    assert_eq!(seen.recv_timeout(Duration::from_secs(2)).unwrap(), VT);
    drop(wire);
    std::thread::sleep(Duration::from_millis(100));

    // asked for video and none came: let in without
    let _wire = knock(port, &format!("{TOKEN} video\n"));
    assert_eq!(seen.recv_timeout(Duration::from_secs(3)).unwrap(), "");
}
