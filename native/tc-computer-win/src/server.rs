//! The stdio server (docs/computer-protocol.md §1, §16.1, §16.2): one
//! JSON-RPC 2.0 frame per line, at most 16 MiB; the init gate; at most 32
//! requests running, a slot freed only once its answer is written, 256
//! waiting, then `overloaded`; `$/cancel`; `permissions.get`,
//! `clipboard.state` and `shutdown` answered on the reading thread, never
//! behind work; the exits of §16.2. The methods are service.rs's.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::desktop::Desktop;
use crate::generated::contract::{rpc_error, service as limits};
use crate::service::Service;
use crate::wire::{ComputerError, ComputerErrorKind};

/// A request's failure: a standard code with no data, or `computer` with a ComputerError.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<ComputerError>,
}

impl RpcError {
    pub fn std(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), data: None }
    }
}

impl From<ComputerError> for RpcError {
    fn from(e: ComputerError) -> Self {
        RpcError { code: rpc_error::COMPUTER, message: e.message.clone(), data: Some(e) }
    }
}

/// Splits a byte stream into lines of at most `max` bytes; a longer line is dropped up to its newline and reported as `Err(())`.
pub struct LineSplitter {
    max: usize,
    buf: Vec<u8>,
    dropping: bool,
}

impl LineSplitter {
    pub fn new(max: usize) -> Self {
        LineSplitter { max, buf: Vec::new(), dropping: false }
    }

    /// Feed bytes; every finished line (or overlong marker) goes to `out`.
    pub fn feed(&mut self, mut bytes: &[u8], out: &mut impl FnMut(Result<Vec<u8>, ()>)) {
        while !bytes.is_empty() {
            let nl = bytes.iter().position(|b| *b == b'\n');
            let (chunk, rest, done) = match nl {
                Some(i) => (&bytes[..i], &bytes[i + 1..], true),
                None => (bytes, &[][..], false),
            };
            if !self.dropping {
                if self.buf.len() + chunk.len() > self.max {
                    self.dropping = true;
                    self.buf.clear();
                } else {
                    self.buf.extend_from_slice(chunk);
                }
            }
            if done {
                if self.dropping {
                    out(Err(()));
                } else {
                    let mut line = std::mem::take(&mut self.buf);
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if !line.is_empty() {
                        out(Ok(line));
                    }
                }
                self.dropping = false;
            }
            bytes = rest;
        }
    }
}

type Out = Arc<Mutex<Box<dyn Write + Send>>>;

/// Writes one frame as one line. A failed write is the host gone: exit 0 (§16.2).
pub fn write_frame(out: &Out, frame: &Value) {
    let mut line = serde_json::to_vec(frame).expect("a frame serializes");
    line.push(b'\n');
    let mut w = out.lock().unwrap();
    if w.write_all(&line).and_then(|_| w.flush()).is_err() {
        std::process::exit(0);
    }
}

struct Job {
    id: Value,
    method: String,
    params: Value,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct Admission {
    running: usize,
    queue: VecDeque<Job>,
}

/// How serving ended: the process's exit code.
pub struct Exit(pub i32);

/// Serves the wire on `input` and `output` until stdin closes, `shutdown`, or the parent goes.
pub fn serve<D: Desktop>(service: Arc<Service<D>>, mut input: impl Read + Send + 'static, output: Box<dyn Write + Send>) -> Exit {
    let out: Out = Arc::new(Mutex::new(output));
    let admission = Arc::new(Mutex::new(Admission::default()));
    let cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> = Arc::default();
    let exit: Arc<(Mutex<Option<i32>>, Condvar)> = Arc::default();

    // the parent watch (§1): polled every 5 s
    {
        let (service, exit) = (service.clone(), exit.clone());
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(limits::PARENT_POLL_MS as u64));
            if !service.desktop().parent_alive() {
                *exit.0.lock().unwrap() = Some(0);
                exit.1.notify_all();
                return;
            }
        });
    }
    service.start_watch(out.clone());

    // stdin, read by its own thread; the main thread waits for an exit
    {
        let (service, out, exit) = (service.clone(), out.clone(), exit.clone());
        std::thread::spawn(move || {
            let mut split = LineSplitter::new(limits::LINE_MAX_BYTES as usize);
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match input.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut stop = false;
                split.feed(&buf[..n], &mut |line| {
                    if stop {
                        return;
                    }
                    match line {
                        Err(()) => write_frame(&out, &error_frame(&Value::Null, &RpcError::std(rpc_error::PARSE_ERROR, "line too long"))),
                        Ok(line) => stop = on_line(&service, &out, &admission, &cancels, &line),
                    }
                });
                if stop {
                    *exit.0.lock().unwrap() = Some(0);
                    exit.1.notify_all();
                    return;
                }
            }
            // stdin EOF (§1)
            *exit.0.lock().unwrap() = Some(0);
            exit.1.notify_all();
        });
    }

    let mut code = exit.0.lock().unwrap();
    while code.is_none() {
        code = exit.1.wait(code).unwrap();
    }
    Exit(code.unwrap())
}

fn error_frame(id: &Value, e: &RpcError) -> Value {
    let mut error = json!({ "code": e.code, "message": e.message });
    if let Some(data) = &e.data {
        error["data"] = serde_json::to_value(data).unwrap();
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn answer_frame(id: &Value, r: Result<Value, RpcError>) -> Value {
    match r {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(e) => error_frame(id, &e),
    }
}

/// One line from the host. Returns true when the service should exit (after `shutdown` is answered).
fn on_line<D: Desktop>(
    service: &Arc<Service<D>>,
    out: &Out,
    admission: &Arc<Mutex<Admission>>,
    cancels: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    line: &[u8],
) -> bool {
    let frame: Value = match serde_json::from_slice(line) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            write_frame(out, &error_frame(&Value::Null, &RpcError::std(rpc_error::PARSE_ERROR, "parse error")));
            return false;
        }
    };
    let method = frame.get("method").and_then(Value::as_str).map(str::to_string);
    let id = frame.get("id").cloned();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    let Some(method) = method else {
        if let Some(id) = id {
            write_frame(out, &error_frame(&id, &RpcError::std(rpc_error::INVALID_REQUEST, "no method")));
        }
        return false;
    };
    let Some(id) = id.filter(|i| !i.is_null()) else {
        // the host's notifications
        if method == "$/cancel" {
            if let Some(target) = params.get("id") {
                if let Some(flag) = cancels.lock().unwrap().get(&target.to_string()) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
        return false;
    };
    // never behind work (§1)
    if matches!(method.as_str(), "permissions.get" | "clipboard.state" | "shutdown") {
        let reply = service.handle(&method, params, &AtomicBool::new(false));
        write_frame(out, &answer_frame(&id, reply.clone()));
        return method == "shutdown" && reply.is_ok();
    }
    let cancel = Arc::new(AtomicBool::new(false));
    cancels.lock().unwrap().insert(id.to_string(), cancel.clone());
    let job = Job { id, method, params, cancel };
    let mut adm = admission.lock().unwrap();
    if adm.running < limits::MAX_IN_FLIGHT as usize {
        adm.running += 1;
        drop(adm);
        let (service, out, admission, cancels) = (service.clone(), out.clone(), admission.clone(), cancels.clone());
        std::thread::spawn(move || run_jobs(service, out, admission, cancels, job));
    } else if adm.queue.len() < limits::MAX_QUEUED as usize {
        adm.queue.push_back(job);
    } else {
        drop(adm);
        cancels.lock().unwrap().remove(&job.id.to_string());
        let msg = format!("overloaded: {} requests waiting", limits::MAX_QUEUED);
        write_frame(out, &error_frame(&job.id, &RpcError::std(rpc_error::INTERNAL_ERROR, msg)));
    }
    false
}

/// Runs a job, writes its answer, then takes the next waiting one; the slot frees only once the answer is written.
fn run_jobs<D: Desktop>(
    service: Arc<Service<D>>,
    out: Out,
    admission: Arc<Mutex<Admission>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    mut job: Job,
) {
    loop {
        let reply = if job.cancel.load(Ordering::SeqCst) {
            Err(ComputerError { kind: ComputerErrorKind::Cancelled, message: "cancelled".into(), ..Default::default() }.into())
        } else {
            service.handle(&job.method, job.params, &job.cancel)
        };
        write_frame(&out, &answer_frame(&job.id, reply));
        cancels.lock().unwrap().remove(&job.id.to_string());
        let mut adm = admission.lock().unwrap();
        match adm.queue.pop_front() {
            Some(next) => job = next,
            None => {
                adm.running -= 1;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_and_drops_an_overlong_one_up_to_its_newline() {
        let mut s = LineSplitter::new(8);
        let mut got = Vec::new();
        s.feed(b"{\"a\":1}\r\n{\"b\"", &mut |l| got.push(l));
        s.feed(b":2}\n0123456789", &mut |l| got.push(l));
        s.feed(b"abc\n{}\n", &mut |l| got.push(l));
        assert_eq!(got, vec![Ok(b"{\"a\":1}".to_vec()), Ok(b"{\"b\":2}".to_vec()), Err(()), Ok(b"{}".to_vec())]);
    }
}
