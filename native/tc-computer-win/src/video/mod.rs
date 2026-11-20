//! Live video of one window (docs/computer-protocol.md §30) as the Windows
//! service serves it: `capture.video.start` and `capture.video.stop`, one
//! capture per window shared by its streams, one encoder per stream, each on
//! a thread of its own. A stream paces the capture's pictures to its fps,
//! keeps screen-relay's flow (`crate::flow`: frames sent and not acked, the
//! pause, the bitrate, three seconds without an ack), sends a still picture
//! again to sharpen it, and writes each access unit to the bytes pipe as one
//! record. The capture and the encoder are the desktop's (`WindowCapture`,
//! `VideoEncoder`); `platform::video` has Windows' and the tests a fake.
//! `Video.swift` is the Mac's.

pub mod annexb;
pub mod pacing;
pub mod picture;
pub mod pipe;
pub mod wire;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::desktop::{fail, Desktop};
use crate::flow::FlowControl;
use crate::generated::contract::video as limits;
use crate::locks::guard;
use crate::server::RpcError;
use crate::service::Service;
use crate::wire::*;
use pacing::{FramePacer, StillWindow};
use picture::{picture_size, to_nv12, Picture};
use pipe::VideoPipe;
use wire::{frame_record, Frame, Record, ACK_TYPE};

/// The service's monotonic clock in µs, as frames carry it: never 0.
pub fn mono_us() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_micros() as u64 + 1
}

/// Why a capture ended on its own.
#[derive(Debug, Clone, PartialEq)]
pub enum CaptureEnd {
    WindowClosed,
    Error(String),
}

/// One window's running capture. Made, read and dropped on the window's capture thread.
pub trait WindowCapture {
    /// The window's own pixels now.
    fn pixels(&self) -> (usize, usize);
    /// The next new picture, waiting at most `wait`; None when nothing new came. An end is for good.
    fn next(&mut self, wait: Duration) -> Result<Option<Picture>, CaptureEnd>;
    /// What captures, for the log and the proof (`wgc`, `printwindow`).
    fn kind(&self) -> String;
}

/// What one stream asks of its encoder.
#[derive(Debug, Clone, PartialEq)]
pub struct EncoderSpec {
    pub width: usize,
    pub height: usize,
    pub fps: usize,
    pub mode: VideoMode,
    /// bits a second to start at
    pub bitrate: u32,
}

/// One access unit out of an encoder: Annex B, a keyframe's led by its SPS and PPS (`annexb::Normalizer`).
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub access_unit: Vec<u8>,
    pub keyframe: bool,
    /// the capture time of the picture it encodes
    pub at_us: u64,
}

/// One stream's encoder. Made, fed and dropped on the stream's thread.
pub trait VideoEncoder {
    /// The picture size it takes (the spec's).
    fn size(&self) -> (usize, usize);
    /// One picture in NV12 at `size()`; `keyframe` forces one. What came out, perhaps for an earlier picture.
    fn encode(&mut self, nv12: &[u8], at_us: u64, keyframe: bool) -> Result<Vec<Encoded>, String>;
    /// `budget`: the bitrate the flow asks for now.
    fn set_bitrate(&mut self, bits_per_second: u32);
    /// What encodes, for the log and the proof (`software …`, `hardware …`).
    fn kind(&self) -> String;
}

/// The service's video: the pipe, whether the host asked for it, the streams and the windows' captures.
#[derive(Default)]
pub struct VideoState {
    pipe: Mutex<Option<Arc<VideoPipe>>>,
    /// `video` was named at initialize: the two calls exist
    pub(crate) on: AtomicBool,
    streams: Mutex<HashMap<u32, Arc<VideoStream>>>,
    windows: Mutex<HashMap<i64, Arc<WindowEntry>>>,
    next: AtomicU32,
}

impl VideoState {
    /// The service has a pipe for video (it may say `video` at initialize).
    pub fn has_pipe(&self) -> bool {
        guard(&self.pipe).is_some()
    }
}

/// One window's capture and the streams on it. `holds` counts its streams and the starts that wait for it,
/// changed only under the windows' lock: the last to let go stops the capture.
struct WindowEntry {
    window: i64,
    holds: Mutex<usize>,
    streams: Mutex<Vec<Arc<VideoStream>>>,
    /// the capture's start: the window's pixels and what captures, or why it could not start
    ready: (Mutex<Option<Result<((usize, usize), String), ComputerError>>>, Condvar),
    stop: AtomicBool,
    over: AtomicBool,
}

struct StreamState {
    flow: FlowControl,
    generation: u32,
    /// no frame goes out until a keyframe: at the start, in a new generation, after a frame the flow refused
    need_key: bool,
}

pub(crate) struct VideoStream {
    pub id: u32,
    pub session: String,
    entry: Arc<WindowEntry>,
    state: Mutex<StreamState>,
    /// the newest picture from the capture not yet taken; a newer one takes its place
    mailbox: (Mutex<Option<Picture>>, Condvar),
    over: AtomicBool,
}

impl VideoStream {
    fn offer(&self, p: &Picture) {
        *guard(&self.mailbox.0) = Some(p.clone());
        self.mailbox.1.notify_one();
    }

    fn take(&self, wait: Duration) -> Option<Picture> {
        let mut slot = guard(&self.mailbox.0);
        if slot.is_none() && !self.over.load(Ordering::SeqCst) {
            slot = self.mailbox.1.wait_timeout(slot, wait).map(|(s, _)| s).unwrap_or_else(|e| e.into_inner().0);
        }
        slot.take()
    }

    /// An ack from the host: of this generation, for the oldest frame out. An ack for a later frame credits every
    /// frame before it too, so a viewer that skipped one does not stall the stream.
    fn ack(&self, r: &Record) {
        let mut st = guard(&self.state);
        if self.over.load(Ordering::SeqCst) || r.generation != st.generation {
            return;
        }
        let (now, wait) = (mono_us(), r.ack_wait_us());
        while let Some(oldest) = st.flow.frames.front() {
            if !(oldest.sent && oldest.sequence < r.sequence) {
                break;
            }
            let seq = oldest.sequence;
            if !st.flow.ack(seq, now, wait) {
                break;
            }
        }
        st.flow.ack(r.sequence, now, wait);
    }

    /// Frames sent and acked, for the tests.
    pub fn counts(&self) -> (u64, u64) {
        let st = guard(&self.state);
        (st.flow.encoded, st.flow.acknowledged)
    }
}

/// What a stream's thread measured, for its closing log line.
#[derive(Default)]
struct Stats {
    frames: u64,
    keyframes: u64,
    bytes: u64,
    encode_us: Vec<u32>,
    first_us: u64,
    last_us: u64,
    generations: u32,
}

impl Stats {
    fn line(&self, id: u32, capture: &str, encoder: &str) -> String {
        let mut t = self.encode_us.clone();
        t.sort_unstable();
        let pct = |p: f64| t.get(((t.len() as f64 - 1.0) * p).round() as usize).map_or(0.0, |v| *v as f64 / 1000.0);
        let secs = (self.last_us.saturating_sub(self.first_us)) as f64 / 1e6;
        let fps = if secs > 0.0 { (self.frames.saturating_sub(1)) as f64 / secs } else { 0.0 };
        let kbps = if secs > 0.0 { self.bytes as f64 * 8.0 / secs / 1000.0 } else { 0.0 };
        format!(
            "video {id}: frames={} keyframes={} generations={} secs={secs:.2} fps={fps:.1} kbps={kbps:.0} encode_p50_ms={:.2} encode_p95_ms={:.2} capture={capture} encoder={encoder}",
            self.frames,
            self.keyframes,
            self.generations,
            pct(0.5),
            pct(0.95)
        )
    }
}

impl<D: Desktop> Service<D> {
    /// The bytes pipe: dialed by main before serving, the token written first. Without one the service never names `video`.
    pub fn attach_video_pipe(self: &Arc<Self>, reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, token: &[u8]) {
        let (acks, lost) = (Arc::downgrade(self), Arc::downgrade(self));
        let pipe = VideoPipe::start(
            reader,
            writer,
            token,
            move |r| {
                if let Some(me) = acks.upgrade() {
                    me.video_record(r);
                }
            },
            move |why| {
                if let Some(me) = lost.upgrade() {
                    eprintln!("video: {why}; every video stream ends");
                    let ids: Vec<u32> = guard(&me.video.streams).keys().copied().collect();
                    for id in ids {
                        me.end_video(id, Some(CaptureVideoEndedNotificationParamsReason::Error), true);
                    }
                }
            },
        );
        *guard(&self.video.pipe) = Some(pipe);
    }

    fn video_record(&self, r: Record) {
        if r.kind != ACK_TYPE {
            return;
        }
        let stream = guard(&self.video.streams).get(&r.stream).cloned();
        if let Some(s) = stream {
            s.ack(&r);
        }
    }

    /// A stream's frames sent and acked (tests).
    pub fn video_counts(&self, id: u32) -> Option<(u64, u64)> {
        guard(&self.video.streams).get(&id).map(|s| s.counts())
    }

    /// `capture.video.start`: a stream with its own encoder on the window's one capture.
    pub(crate) fn video_start(self: &Arc<Self>, p: CaptureVideoStartParams) -> Result<CaptureVideoStartResult, ComputerError> {
        let pipe = guard(&self.video.pipe).clone();
        let pipe = pipe.filter(|p| !p.is_lost()).ok_or_else(|| fail(ComputerErrorKind::CaptureFailed, "the bytes pipe for video is closed; restart the service"))?;
        let app = self.resolve(&p.app)?;
        let win = self.desktop.window(app.pid, p.window.as_ref())?;
        if win.minimized {
            return Err(fail(ComputerErrorKind::WindowMinimized, "the window is minimized"));
        }
        let fps = p.fps.unwrap_or(limits::DEFAULT_FPS).clamp(limits::MIN_FPS, limits::MAX_FPS) as usize;
        let edge_cap = if p.mode == VideoMode::Budget { limits::LINK_MAX_EDGE } else { limits::MAX_MAX_EDGE };
        let max_edge = p.max_edge.clamp(limits::MIN_MAX_EDGE, edge_cap) as usize;
        let bitrate = match p.mode {
            VideoMode::Budget => p.bitrate.unwrap_or(limits::START_BITRATE).clamp(limits::MIN_BITRATE, limits::MAX_BITRATE),
            _ => limits::QUALITY_BITRATE,
        } as u32;

        let entry = self.hold_window(win.id, fps);
        let (pixels, capture_kind) = match wait_ready(&entry) {
            Ok(r) => r,
            Err(e) => {
                self.release_window(&entry);
                return Err(e);
            }
        };
        let id = self.video.next.fetch_add(1, Ordering::SeqCst) + 1;
        let stream = Arc::new(VideoStream {
            id,
            session: p.session.clone(),
            entry: entry.clone(),
            state: Mutex::new(StreamState { flow: FlowControl::default(), generation: 0, need_key: true }),
            mailbox: (Mutex::new(None), Condvar::new()),
            over: AtomicBool::new(false),
        });
        let (tx, rx) = channel();
        let spec = EncoderSpec { width: 0, height: 0, fps, mode: p.mode, bitrate };
        {
            let (me, stream, pipe) = (self.clone(), stream.clone(), pipe.clone());
            std::thread::spawn(move || me.run_video(stream, pipe, spec, max_edge, pixels, capture_kind, tx));
        }
        let size = match rx.recv() {
            Ok(Ok(size)) => size,
            Ok(Err(e)) => {
                self.release_window(&entry);
                return Err(e);
            }
            Err(_) => {
                self.release_window(&entry);
                return Err(fail(ComputerErrorKind::CaptureFailed, "the stream's encoder did not start"));
            }
        };
        // a close that came while the stream started fences it out, and so does the capture's own end
        let kept = {
            let windows = guard(&self.video.windows);
            let open = self.session_open(&p.session);
            if !open {
                Err(fail(ComputerErrorKind::UnknownSession, format!("no session {}", p.session)))
            } else if entry.over.load(Ordering::SeqCst) || !windows.get(&win.id).is_some_and(|e| Arc::ptr_eq(e, &entry)) {
                Err(fail(ComputerErrorKind::WindowNotFound, "the window's capture ended while the stream started"))
            } else {
                guard(&self.video.streams).insert(id, stream.clone());
                guard(&entry.streams).push(stream.clone());
                Ok(())
            }
        };
        if let Err(e) = kept {
            stream.over.store(true, Ordering::SeqCst);
            stream.mailbox.1.notify_one();
            self.release_window(&entry);
            return Err(e);
        }
        Ok(CaptureVideoStartResult { stream: id as i64, width: size.0 as i64, height: size.1 as i64 })
    }

    /// The window's capture, started by the first stream and shared by the rest; one more hold on it.
    fn hold_window(self: &Arc<Self>, window: i64, fps: usize) -> Arc<WindowEntry> {
        let mut windows = guard(&self.video.windows);
        if let Some(e) = windows.get(&window) {
            *guard(&e.holds) += 1;
            return e.clone();
        }
        let entry = Arc::new(WindowEntry {
            window,
            holds: Mutex::new(1),
            streams: Mutex::default(),
            ready: (Mutex::new(None), Condvar::new()),
            stop: AtomicBool::new(false),
            over: AtomicBool::new(false),
        });
        windows.insert(window, entry.clone());
        let (me, e) = (self.clone(), entry.clone());
        std::thread::spawn(move || me.run_capture(e, fps));
        entry
    }

    /// One hold let go; the last stops the window's capture.
    fn release_window(&self, entry: &Arc<WindowEntry>) {
        let mut windows = guard(&self.video.windows);
        let mut holds = guard(&entry.holds);
        *holds = holds.saturating_sub(1);
        if *holds == 0 {
            entry.stop.store(true, Ordering::SeqCst);
            if windows.get(&entry.window).is_some_and(|e| Arc::ptr_eq(e, entry)) {
                windows.remove(&entry.window);
            }
        }
    }

    /// The window's capture thread: it hands each new picture to every stream on the window.
    fn run_capture(self: Arc<Self>, entry: Arc<WindowEntry>, fps: usize) {
        let mut capture = match self.desktop.video_capture(entry.window, fps) {
            Ok(c) => c,
            Err(e) => {
                let mut windows = guard(&self.video.windows);
                entry.over.store(true, Ordering::SeqCst);
                if windows.get(&entry.window).is_some_and(|x| Arc::ptr_eq(x, &entry)) {
                    windows.remove(&entry.window);
                }
                drop(windows);
                *guard(&entry.ready.0) = Some(Err(e));
                entry.ready.1.notify_all();
                return;
            }
        };
        *guard(&entry.ready.0) = Some(Ok((capture.pixels(), capture.kind())));
        entry.ready.1.notify_all();
        let end = loop {
            if entry.stop.load(Ordering::SeqCst) {
                break None;
            }
            match capture.next(Duration::from_millis(20)) {
                Ok(Some(p)) => guard(&entry.streams).iter().for_each(|s| s.offer(&p)),
                Ok(None) => {}
                Err(end) => break Some(end),
            }
        };
        drop(capture);
        let Some(end) = end else { return };
        // the capture ended on its own: every stream on it ends with its reason
        let streams: Vec<u32> = {
            let mut windows = guard(&self.video.windows);
            entry.over.store(true, Ordering::SeqCst);
            if windows.get(&entry.window).is_some_and(|e| Arc::ptr_eq(e, &entry)) {
                windows.remove(&entry.window);
            }
            let ids = guard(&entry.streams).iter().map(|s| s.id).collect();
            ids
        };
        let reason = match &end {
            CaptureEnd::WindowClosed => CaptureVideoEndedNotificationParamsReason::WindowClosed,
            CaptureEnd::Error(why) => {
                eprintln!("video: the capture of window {} failed: {why}", entry.window);
                CaptureVideoEndedNotificationParamsReason::Error
            }
        };
        for id in streams {
            self.end_video(id, Some(reason), true);
        }
    }

    /// Ends one stream: its thread stops, its hold on the capture goes, and `capture/videoEnded` is sent when
    /// `tell` (an end of its own).
    pub(crate) fn end_video(&self, id: u32, reason: Option<CaptureVideoEndedNotificationParamsReason>, tell: bool) {
        let Some(stream) = guard(&self.video.streams).remove(&id) else { return };
        if stream.over.swap(true, Ordering::SeqCst) {
            return;
        }
        stream.mailbox.1.notify_one();
        guard(&stream.entry.streams).retain(|s| s.id != id);
        self.release_window(&stream.entry);
        if let (true, Some(reason)) = (tell, reason) {
            self.notify("capture/videoEnded", json!({ "stream": id, "reason": reason.as_str() }));
        }
    }

    /// Every stream of the session, or every stream, ended without a notice.
    pub(crate) fn end_videos(&self, session: Option<&str>) {
        let ids: Vec<u32> = guard(&self.video.streams).values().filter(|s| session.is_none_or(|x| s.session == x)).map(|s| s.id).collect();
        for id in ids {
            self.end_video(id, None, false);
        }
    }

    /// One stream's thread: its encoder, the pacing, the flow's clock, the still window, the records.
    #[allow(clippy::too_many_arguments)]
    fn run_video(
        self: Arc<Self>,
        s: Arc<VideoStream>,
        pipe: Arc<VideoPipe>,
        mut spec: EncoderSpec,
        max_edge: usize,
        pixels: (usize, usize),
        capture_kind: String,
        ready: Sender<Result<(usize, usize), ComputerError>>,
    ) {
        (spec.width, spec.height) = picture_size(pixels.0, pixels.1, max_edge);
        let mut encoder = match self.desktop.video_encoder(&spec) {
            Ok(e) => Some(e),
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let encoder_kind = encoder.as_ref().map(|e| e.kind()).unwrap_or_default();
        let _ = ready.send(Ok(encoder.as_ref().map_or((spec.width, spec.height), |e| e.size())));
        let budget = spec.mode == VideoMode::Budget;
        let mut bitrate = spec.bitrate;
        {
            let mut st = guard(&s.state);
            st.flow.configure(limits::MIN_BITRATE as u64, bitrate as u64, limits::MAX_BITRATE as u64, spec.fps as u32);
            st.generation = 1;
        }
        let mut pacer = FramePacer::new(spec.fps);
        let mut still = StillWindow::new(spec.fps);
        let mut last: Option<Picture> = None;
        let mut failures = 0;
        // pictures handed to the encoder and not yet out: they hold places in the flow's window
        let mut in_encoder = 0usize;
        let mut stats = Stats { generations: 1, ..Default::default() };
        let tick = Duration::from_micros(FlowControl::SAMPLE_INTERVAL_US);
        let ended = loop {
            let fresh = s.take(tick);
            if s.over.load(Ordering::SeqCst) {
                break None;
            }
            let now = mono_us();
            // the clock: the flow's own update, the bitrate it asks for, the three seconds without an ack
            let wanted = {
                let mut st = guard(&s.state);
                if st.flow.timed_out(now) {
                    break Some("no ack for 3 s".to_string());
                }
                st.flow.update(now);
                budget.then(|| st.flow.frame_bitrate().clamp(limits::MIN_BITRATE as u64, limits::MAX_BITRATE as u64) as u32)
            };
            if let Some(w) = wanted.filter(|w| *w != bitrate) {
                bitrate = w;
                if let Some(e) = encoder.as_mut() {
                    e.set_bitrate(w);
                }
            }
            let (pic, at, again) = match fresh {
                Some(p) => {
                    still.picture(p.at_us);
                    last = Some(p.clone());
                    if !pacer.take(p.at_us) {
                        continue;
                    }
                    let at = p.at_us;
                    (p, at, false)
                }
                None => match &last {
                    // a repeat skips the pacer but not the flow, as a frame of the moment it is encoded
                    Some(p) if still.due(now) => (p.clone(), now, true),
                    _ => continue,
                },
            };
            {
                let st = guard(&s.state);
                if st.flow.paused(now) || st.flow.frames.len() + in_encoder >= st.flow.window as usize {
                    continue;
                }
            }
            if again {
                still.repeated();
            }
            // a picture of another size, or an encoder that failed: a new encoder, a new generation
            let want = picture_size(pic.width, pic.height, max_edge);
            if encoder.as_ref().is_none_or(|e| e.size() != want) {
                (spec.width, spec.height, spec.bitrate) = (want.0, want.1, bitrate);
                encoder = None;
                match self.desktop.video_encoder(&spec) {
                    Ok(e) => encoder = Some(e),
                    Err(e) => {
                        failures += 1;
                        if failures > 3 {
                            break Some(format!("the encoder could not be made again: {}", e.message));
                        }
                        continue;
                    }
                }
                in_encoder = 0;
                stats.generations += 1;
                let mut st = guard(&s.state);
                // the flow starts again at sequence 1, keeping the bitrate it learned
                let rate = st.flow.target_bitrate;
                st.flow.reset();
                st.flow.target_bitrate = rate;
                st.generation += 1;
                st.need_key = true;
            }
            let Some(enc) = encoder.as_mut() else { continue };
            let (w, h) = enc.size();
            let started = Instant::now();
            let nv12 = to_nv12(&pic, w, h);
            let force = guard(&s.state).need_key;
            in_encoder += 1;
            match enc.encode(&nv12, at, force) {
                Err(why) => {
                    eprintln!("video {}: the encoder failed: {why}", s.id);
                    failures += 1;
                    if failures > 3 {
                        break Some(format!("the encoder failed {failures} times: {why}"));
                    }
                    encoder = None;
                }
                Ok(units) => {
                    failures = 0;
                    stats.encode_us.push(started.elapsed().as_micros().min(u32::MAX as u128) as u32);
                    in_encoder = in_encoder.saturating_sub(units.len());
                    for u in units {
                        if let Some(record) = self.frame_of(&s, (w, h), u, &mut stats) {
                            pipe.write(record);
                        }
                    }
                }
            }
        };
        if let Some(why) = ended {
            eprintln!("video {}: {why}", s.id);
            self.end_video(s.id, Some(CaptureVideoEndedNotificationParamsReason::Error), true);
        }
        eprintln!("{}", stats.line(s.id, &capture_kind, &encoder_kind));
    }

    /// One access unit as the record that goes out, or None when it may not: before a keyframe, or refused by the flow.
    fn frame_of(&self, s: &VideoStream, size: (usize, usize), u: Encoded, stats: &mut Stats) -> Option<Vec<u8>> {
        let mut st = guard(&s.state);
        if s.over.load(Ordering::SeqCst) {
            return None;
        }
        // a frame that leans on one never sent waits for the next keyframe, which the next picture asks for
        if st.need_key && !u.keyframe {
            return None;
        }
        let now = mono_us();
        let seq = st.flow.last_encoded.wrapping_add(1);
        if !st.flow.enqueue(seq, u.access_unit.len(), u.at_us, now) {
            st.need_key = true;
            return None;
        }
        st.need_key = false;
        st.flow.sent(seq, now);
        let frame = Frame { generation: st.generation, sequence: seq, keyframe: u.keyframe, width: size.0 as u32, height: size.1 as u32, capture_us: u.at_us, access_unit: &u.access_unit };
        let record = frame_record(s.id, &frame).ok()?;
        stats.frames += 1;
        stats.keyframes += u.keyframe as u64;
        stats.bytes += u.access_unit.len() as u64;
        if stats.first_us == 0 {
            stats.first_us = now;
        }
        stats.last_us = now;
        Some(record)
    }
}

fn wait_ready(entry: &WindowEntry) -> Result<((usize, usize), String), ComputerError> {
    let mut ready = guard(&entry.ready.0);
    let deadline = Instant::now() + Duration::from_secs(10);
    while ready.is_none() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(fail(ComputerErrorKind::CaptureFailed, "the window's capture did not start in 10 s"));
        }
        ready = entry.ready.1.wait_timeout(ready, left).map(|(r, _)| r).unwrap_or_else(|e| e.into_inner().0);
    }
    ready.clone().unwrap()
}

/// `capture.video.start` and `capture.video.stop` answer as an unknown method does unless `video` was named.
pub(crate) fn unknown(method: &str) -> RpcError {
    RpcError::std(crate::generated::contract::rpc_error::METHOD_NOT_FOUND, format!("no method {method}"))
}
