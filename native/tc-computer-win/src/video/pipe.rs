//! The bytes pipe on the service's side (docs/computer-protocol.md §30): the
//! host's named pipe, dialed before `initialize` is answered, the token's 64
//! characters written first, then records both ways. Records go out whole and
//! in order on a writer thread of their own, so a slow host holds up neither a
//! capture nor stdout; acks come in on a reader thread. The transport is any
//! reader and writer (`platform::video` dials the named pipe; the tests use an
//! in-memory one). A failed write, the host closing its end, or a record that
//! cannot be placed loses the pipe for good.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

use super::wire::{Record, RecordReader};
use crate::locks::guard;

pub struct VideoPipe {
    tx: Mutex<Option<Sender<Vec<u8>>>>,
    lost: AtomicBool,
}

impl VideoPipe {
    /// Starts the writer (the token first) and the reader. `on_record` gets each record the host writes; `on_lost`
    /// is called once, from either thread, when the pipe is lost.
    pub fn start(
        mut reader: Box<dyn Read + Send>,
        mut writer: Box<dyn Write + Send>,
        token: &[u8],
        on_record: impl Fn(Record) + Send + 'static,
        on_lost: impl Fn(String) + Send + Sync + 'static,
    ) -> std::sync::Arc<VideoPipe> {
        let (tx, rx) = channel::<Vec<u8>>();
        let pipe = std::sync::Arc::new(VideoPipe { tx: Mutex::new(Some(tx)), lost: AtomicBool::new(false) });
        let on_lost = std::sync::Arc::new(on_lost);
        let token = token.to_vec();
        {
            let (pipe, on_lost) = (std::sync::Arc::downgrade(&pipe), on_lost.clone());
            std::thread::spawn(move || {
                let mut failed = writer.write_all(&token).and_then(|_| writer.flush()).err();
                while failed.is_none() {
                    let Ok(record) = rx.recv() else { return };
                    failed = writer.write_all(&record).and_then(|_| writer.flush()).err();
                }
                if let (Some(p), Some(e)) = (pipe.upgrade(), failed) {
                    p.lose(&*on_lost, format!("a write to the video pipe failed: {e}"));
                }
            });
        }
        {
            let pipe = std::sync::Arc::downgrade(&pipe);
            std::thread::spawn(move || {
                let mut records = RecordReader::default();
                let mut buf = vec![0u8; 64 * 1024];
                let why = loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) => break "the host closed the video pipe".to_string(),
                        Err(e) => break format!("a read of the video pipe failed: {e}"),
                        Ok(n) => n,
                    };
                    match records.push(&buf[..n]) {
                        Ok(rs) => rs.into_iter().for_each(&on_record),
                        Err(e) => break e.0,
                    }
                };
                if let Some(p) = pipe.upgrade() {
                    p.lose(&*on_lost, why);
                }
            });
        }
        pipe
    }

    fn lose(&self, on_lost: &dyn Fn(String), why: String) {
        if !self.lost.swap(true, Ordering::SeqCst) {
            guard(&self.tx).take();
            on_lost(why);
        }
    }

    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }

    /// Queues one whole record; nothing once the pipe is lost.
    pub fn write(&self, record: Vec<u8>) {
        if let Some(tx) = guard(&self.tx).as_ref() {
            let _ = tx.send(record);
        }
    }
}
