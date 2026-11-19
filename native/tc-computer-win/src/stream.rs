//! The preview stream on Windows (docs/computer-protocol.md §6, §29.6): one
//! thread per stream grabs the window at `fps`, fits it to `maxEdge`, and
//! sends a `capture/frame` only for new pixels, at most two unacked, pausing
//! while a frame waits 5 s for its ack; it ends with `capture/streamEnded`
//! when stopped or when the window goes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::capture::{self, fingerprint, fitted, FrameGate, Image, FRAME_JPEG_MAX, FRAME_QUALITIES};
use crate::desktop::{fail, Desktop, Win};
use crate::generated::contract::preview;
use crate::locks::guard;
use crate::service::{now_ms, Service};
use crate::wire::*;

pub struct Stream {
    pub id: String,
    pub session: String,
    pub window: i64,
    stop: AtomicBool,
    gate: Mutex<FrameGate>,
    /// the newest frame's size
    size: Mutex<(usize, usize)>,
}

impl Stream {
    pub fn size(&self) -> (usize, usize) {
        *guard(&self.size)
    }
}

impl<D: Desktop> Service<D> {
    pub(crate) fn streams_on(&self, session: &str, window: i64) -> Vec<Arc<Stream>> {
        guard(&self.streams).values().filter(|s| s.session == session && s.window == window).cloned().collect()
    }

    /// `capture.stream.start`: the window's size inside the frames, then frames on their own thread.
    pub(crate) fn stream_start(self: &Arc<Self>, p: CaptureStreamStartParams) -> Result<CaptureStreamStartResult, ComputerError> {
        let app = self.resolve(&p.app)?;
        let win = self.desktop.window(app.pid, p.window.as_ref())?;
        if win.minimized {
            return Err(fail(ComputerErrorKind::WindowMinimized, "the window is minimized"));
        }
        let first = self.desktop.grab(win.id)?;
        let size = fitted(first.width, first.height, p.max_edge);
        if let Some(old) = guard(&self.streams).remove(&p.stream) {
            old.stop.store(true, Ordering::SeqCst);
        }
        let stream = Arc::new(Stream { id: p.stream.clone(), session: p.session.clone(), window: win.id, stop: AtomicBool::new(false), gate: Mutex::default(), size: Mutex::new(size) });
        guard(&self.streams).insert(p.stream.clone(), stream.clone());
        let fps = p.fps.unwrap_or(preview::DEFAULT_FPS).clamp(preview::MIN_FPS, preview::MAX_FPS) as u64;
        let me = self.clone();
        let max_edge = p.max_edge;
        std::thread::spawn(move || me.run_stream(stream, win, Some(first), fps, max_edge));
        Ok(CaptureStreamStartResult { stream: p.stream, width: size.0 as i64, height: size.1 as i64 })
    }

    pub(crate) fn stream_stop(&self, id: &str) {
        if let Some(s) = guard(&self.streams).get(id) {
            s.stop.store(true, Ordering::SeqCst);
        }
    }

    /// `capture.stream.ack` from the host: covers its frame and every earlier one.
    pub(crate) fn stream_ack(&self, id: &str, seq: i64) {
        if let Some(s) = guard(&self.streams).get(id) {
            guard(&s.gate).ack(seq);
        }
    }

    fn run_stream(&self, s: Arc<Stream>, win: Win, mut first: Option<Image>, fps: u64, max_edge: Option<i64>) {
        let period = Duration::from_millis(1000 / fps);
        let mut last: Option<u64> = None;
        let reason = loop {
            let tick = Instant::now();
            if s.stop.load(Ordering::SeqCst) {
                break CaptureStreamEndedNotificationParamsReason::Stopped;
            }
            if !self.desktop.alive(win.id) {
                break CaptureStreamEndedNotificationParamsReason::WindowClosed;
            }
            let starved = guard(&s.gate).starved(tick);
            if !starved {
                let img = match first.take().map(Ok).unwrap_or_else(|| self.desktop.grab(win.id)) {
                    Ok(i) => i,
                    Err(_) if !self.desktop.alive(win.id) => break CaptureStreamEndedNotificationParamsReason::WindowClosed,
                    // minimized or mid-resize: try again next tick
                    Err(_) => {
                        std::thread::sleep(period);
                        continue;
                    }
                };
                let (w, h) = fitted(img.width, img.height, max_edge);
                let pic = img.scaled(w, h);
                let print = fingerprint(&pic);
                if last != Some(print) {
                    if let Some(seq) = guard(&s.gate).take(tick) {
                        match self.frame_jpeg(&pic) {
                            Some(jpeg) => {
                                last = Some(print);
                                *guard(&s.size) = (w, h);
                                let cursor = self.cursor_in_frame(&s, &win, w, h);
                                let mut params = json!({ "stream": s.id, "seq": seq, "ts": now_ms(), "width": w, "height": h, "format": "jpeg", "data": capture::base64(&jpeg) });
                                if let Some(c) = cursor {
                                    params["cursor"] = json!(c);
                                }
                                self.notify("capture/frame", params);
                            }
                            None => {
                                // over the cap at every quality: dropped once, with a log line, until the pixels change
                                guard(&s.gate).drop_frame(seq);
                                last = Some(print);
                                eprintln!("stream {}: a frame stayed over {} bytes and was dropped", s.id, FRAME_JPEG_MAX);
                            }
                        }
                    }
                }
            }
            std::thread::sleep(period.saturating_sub(tick.elapsed()));
        };
        // a stream started again under its id has replaced this one: the new one keeps the id, and no end is told for it
        let mine = {
            let mut streams = guard(&self.streams);
            let mine = streams.get(&s.id).is_some_and(|x| Arc::ptr_eq(x, &s));
            if mine {
                streams.remove(&s.id);
            }
            mine
        };
        if mine {
            self.notify("capture/streamEnded", json!({ "stream": s.id, "reason": reason.as_str() }));
        }
    }

    fn frame_jpeg(&self, pic: &Image) -> Option<Vec<u8>> {
        FRAME_QUALITIES.iter().find_map(|q| self.desktop.encode(pic, ShotFormat::Jpeg, *q).ok().filter(|b| b.len() <= FRAME_JPEG_MAX))
    }

    /// The agent cursor of the stream's session on its window, in the frame's own pixels.
    fn cursor_in_frame(&self, s: &Stream, win: &Win, w: usize, h: usize) -> Option<Vec<i64>> {
        let st = guard(&self.state);
        let (_, p) = st.cursors.iter().find(|((sess, _), (wid, _))| *sess == s.session && *wid == win.id).map(|(_, v)| *v)?;
        let space = st.spaces.get(&(s.session.clone(), win.id)).cloned().unwrap_or_else(|| capture::geometry(win.frame.w, win.frame.h, None));
        Some(vec![p.0 * w as i64 / space.width.max(1), p.1 * h as i64 / space.height.max(1)])
    }
}
