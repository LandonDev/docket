//! The service over its stdio framing, for the tests: a pipe in, a sink out, calls and their answers, and
//! the notifications seen on the way.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tc_computer_win::desktop::Desktop;
use tc_computer_win::server::serve;
use tc_computer_win::service::Service;

pub struct Pipe(pub Receiver<Vec<u8>>, pub Vec<u8>);
impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.1.is_empty() {
            match self.0.recv() {
                Ok(b) => self.1 = b,
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.1.len());
        buf[..n].copy_from_slice(&self.1[..n]);
        self.1.drain(..n);
        Ok(n)
    }
}

#[derive(Clone)]
pub struct Sink(Arc<Mutex<Vec<u8>>>);
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct Wire {
    pub notes: Vec<Value>,
    send: Sender<Vec<u8>>,
    out: Arc<Mutex<Vec<u8>>>,
    next: i64,
    seen: usize,
}

impl Wire {
    pub fn start<D: Desktop>(fake: D) -> Wire {
        Self::start_with(fake, |_| {})
    }

    /// As `start`, with `before` run on the service before it serves (a test attaches its video pipe there).
    pub fn start_with<D: Desktop>(fake: D, before: impl FnOnce(&Arc<Service<D>>)) -> Wire {
        let (send, recv) = channel();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = Sink(out.clone());
        let service = Arc::new(Service::new(fake, "test"));
        before(&service);
        std::thread::spawn(move || serve(service, Pipe(recv, Vec::new()), Box::new(sink)));
        Wire { notes: Vec::new(), send, out, next: 1, seen: 0 }
    }

    pub fn raw(&mut self, line: &str) {
        self.send.send(format!("{line}\n").into_bytes()).unwrap();
    }

    /// The next frame the service writes.
    pub fn frame(&mut self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            {
                let out = self.out.lock().unwrap();
                if let Some(end) = out[self.seen..].iter().position(|b| *b == b'\n') {
                    let line = out[self.seen..self.seen + end].to_vec();
                    self.seen += end + 1;
                    let v: Value = serde_json::from_slice(&line).unwrap();
                    if v.get("method").is_some() {
                        self.notes.push(v); // a notification
                        continue;
                    }
                    return v;
                }
            }
            assert!(Instant::now() < deadline, "no answer");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.raw(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string());
        let f = self.frame();
        assert_eq!(f["id"], json!(id));
        assert_eq!(f["jsonrpc"], json!("2.0"));
        f
    }

    pub fn ok(&mut self, method: &str, params: Value) -> Value {
        let f = self.call(method, params);
        assert!(f.get("result").is_some(), "{method}: {f}");
        f["result"].clone()
    }

    pub fn kind(&mut self, method: &str, params: Value) -> String {
        let f = self.call(method, params);
        f["error"]["data"]["kind"].as_str().unwrap_or_else(|| panic!("{method}: {f}")).to_string()
    }
}

pub fn init(w: &mut Wire) -> Value {
    static RUN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let run = RUN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tc-wire-{}-{run}", std::process::id()));
    w.ok("initialize", json!({ "protocol": 1, "client": { "name": "test", "version": "1" }, "dataDir": dir.to_string_lossy() }))
}


impl Wire {
    /// Waits up to 5 s for a notification of `method` (one already seen counts), and takes it.
    pub fn note(&mut self, method: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(i) = self.notes.iter().position(|n| n["method"] == json!(method)) {
                return self.notes.remove(i);
            }
            {
                let out = self.out.lock().unwrap();
                if let Some(end) = out[self.seen..].iter().position(|b| *b == b'\n') {
                    let line = out[self.seen..self.seen + end].to_vec();
                    self.seen += end + 1;
                    drop(out);
                    let v: Value = serde_json::from_slice(&line).unwrap();
                    assert!(v.get("method").is_some(), "an answer nobody asked for: {v}");
                    self.notes.push(v);
                    continue;
                }
            }
            assert!(Instant::now() < deadline, "no {method}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
