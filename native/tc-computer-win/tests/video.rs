//! Live video (docs/computer-protocol.md §30) through the handlers, over a fake desktop whose capture the test
//! feeds and whose encoder writes tiny access units, with the bytes pipe in memory. The real capture and
//! encoder are proven in the rig (scripts/e2e-computer-win.ts).

mod common;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Pipe, Wire};
use serde_json::{json, Value};
use tc_computer_win::desktop::{fail, Acted, Desktop, Win};
use tc_computer_win::service::Service;
use tc_computer_win::text::RawWindow;
use tc_computer_win::video::picture::Picture;
use tc_computer_win::video::wire::{ack_record, Record, RecordReader, FRAME_TYPE, KEYFRAME_FLAG};
use tc_computer_win::video::{mono_us, CaptureEnd, Encoded, EncoderSpec, VideoEncoder, WindowCapture};
use tc_computer_win::wire::*;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SPS: [u8; 8] = [0, 0, 0, 1, 0x67, 0x64, 0, 0x1f];
const PPS: [u8; 7] = [0, 0, 0, 1, 0x68, 0xee, 0x3c];

/// What the fake desktop shares with the test.
#[derive(Default)]
struct Shared {
    log: Mutex<Vec<String>>,
    /// what the capture gives next, per call of `next`
    feed: Mutex<VecDeque<Result<Picture, CaptureEnd>>>,
    pixels: Mutex<(usize, usize)>,
    minimized: Mutex<bool>,
    /// the encoder gives a P-frame for the next forced keyframe, as an encoder that dropped one would
    skip_key: Mutex<bool>,
    /// bytes in each access unit's slice
    unit_bytes: Mutex<usize>,
}

impl Shared {
    fn log(&self, line: impl Into<String>) {
        self.log.lock().unwrap().push(line.into());
    }
    fn count(&self, prefix: &str) -> usize {
        self.log.lock().unwrap().iter().filter(|l| l.starts_with(prefix)).count()
    }
}

#[derive(Clone)]
struct Fake(Arc<Shared>);

struct FakeCapture(Arc<Shared>);

impl WindowCapture for FakeCapture {
    fn pixels(&self) -> (usize, usize) {
        *self.0.pixels.lock().unwrap()
    }
    fn next(&mut self, wait: Duration) -> Result<Option<Picture>, CaptureEnd> {
        let next = self.0.feed.lock().unwrap().pop_front();
        match next {
            Some(Ok(p)) => Ok(Some(p)),
            Some(Err(e)) => Err(e),
            None => {
                std::thread::sleep(wait.min(Duration::from_millis(2)));
                Ok(None)
            }
        }
    }
    fn kind(&self) -> String {
        "fake".into()
    }
}

impl Drop for FakeCapture {
    fn drop(&mut self) {
        self.0.log("stopVideo");
    }
}

struct FakeEncoder(Arc<Shared>, (usize, usize));

impl VideoEncoder for FakeEncoder {
    fn size(&self) -> (usize, usize) {
        self.1
    }
    fn encode(&mut self, nv12: &[u8], at_us: u64, keyframe: bool) -> Result<Vec<Encoded>, String> {
        assert_eq!(nv12.len(), self.1 .0 * self.1 .1 * 3 / 2);
        let key = keyframe && !std::mem::take(&mut *self.0.skip_key.lock().unwrap());
        self.0.log(format!("encode{}", if keyframe { " key" } else { "" }));
        let n = (*self.0.unit_bytes.lock().unwrap()).max(1);
        let mut au = if key { [&SPS[..], &PPS[..]].concat() } else { vec![] };
        au.extend([0, 0, 0, 1, if key { 0x65 } else { 0x41 }]);
        au.extend(std::iter::repeat_n(0x88, n));
        Ok(vec![Encoded { access_unit: au, keyframe: key, at_us }])
    }
    fn set_bitrate(&mut self, bps: u32) {
        self.0.log(format!("setBitrate {bps}"));
    }
    fn kind(&self) -> String {
        "fake".into()
    }
}

impl Desktop for Fake {
    type Handle = ();
    fn os(&self) -> (String, String) {
        ("Windows 10.0.26200".into(), "x86_64".into())
    }
    fn displays(&self) -> Vec<DisplayInfo> {
        vec![]
    }
    fn apps(&self, _windows: bool) -> Result<Vec<AppInfo>, ComputerError> {
        Ok(vec![AppInfo { pid: 500, bundle_id: Some("doc.exe".into()), name: "Doc".into(), active: true, hidden: false, windows: None }])
    }
    fn read(&self, _pid: i64, _window: Option<&WindowRef>, _from: Option<&()>, _deadline: Instant) -> Result<RawWindow<()>, ComputerError> {
        Err(fail(ComputerErrorKind::WindowNotFound, "no tree here"))
    }
    fn act(&self, _pid: i64, _element: &(), _action: &ComputerAction) -> Result<Acted, ComputerError> {
        Err(fail(ComputerErrorKind::ActionUnsupported, "no"))
    }
    fn window(&self, pid: i64, _window: Option<&WindowRef>) -> Result<Win, ComputerError> {
        let (w, h) = *self.0.pixels.lock().unwrap();
        Ok(Win { id: 7, pid, title: "Doc".into(), frame: Rect { x: 0.0, y: 0.0, w: w as f64, h: h as f64 }, minimized: *self.0.minimized.lock().unwrap() })
    }
    fn video_capture(&self, window_id: i64, fps: usize) -> Result<Box<dyn WindowCapture>, ComputerError> {
        self.0.log(format!("startVideo {window_id} {fps}"));
        Ok(Box::new(FakeCapture(self.0.clone())))
    }
    fn video_encoder(&self, spec: &EncoderSpec) -> Result<Box<dyn VideoEncoder>, ComputerError> {
        self.0.log(format!("addEncoder {}x{} {} {}", spec.width, spec.height, spec.mode.as_str(), spec.bitrate));
        Ok(Box::new(FakeEncoder(self.0.clone(), (spec.width, spec.height))))
    }
}

/// The host's end of the bytes pipe in memory: what the service wrote, and a way to write acks.
#[derive(Clone)]
struct HostEnd(Arc<Mutex<Vec<u8>>>);

impl Write for HostEnd {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Rig {
    w: Wire,
    fake: Arc<Shared>,
    service: Arc<Service<Fake>>,
    written: Arc<Mutex<Vec<u8>>>,
    to_service: Option<Sender<Vec<u8>>>,
}

impl Rig {
    /// A service with the pipe attached (or not), initialized with the host's `features`, a session `s1` open.
    fn new(pipe: bool, features: &[&str], setup: impl FnOnce(&Shared)) -> Rig {
        let fake = Arc::new(Shared::default());
        *fake.pixels.lock().unwrap() = (640, 400);
        *fake.unit_bytes.lock().unwrap() = 16;
        setup(&fake);
        let written = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = channel::<Vec<u8>>();
        let mut held = None;
        let w = Wire::start_with(Fake(fake.clone()), |s| {
            if pipe {
                s.attach_video_pipe(Box::new(Pipe(rx, Vec::new())) as Box<dyn Read + Send>, Box::new(HostEnd(written.clone())), TOKEN.as_bytes());
            }
            held = Some(s.clone());
        });
        let mut rig = Rig { w, fake, service: held.unwrap(), written, to_service: Some(tx) };
        let dir = std::env::temp_dir().join(format!("tc-video-{}-{}", std::process::id(), next_dir()));
        let init = rig.w.ok("initialize", json!({ "protocol": 1, "client": { "name": "t", "version": "0" }, "dataDir": dir.to_string_lossy(), "features": features }));
        assert!(init["features"].is_array());
        rig.w.ok("session.open", json!({ "session": "s1" }));
        rig
    }

    fn ready() -> Rig {
        Rig::new(true, &["video"], |_| {})
    }

    fn start(&mut self, extra: Value) -> Value {
        let mut p = json!({ "session": "s1", "app": { "app": "Doc" }, "maxEdge": 3840, "mode": "quality" });
        p.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        self.w.call("capture.video.start", p)
    }

    fn stream(&mut self, extra: Value) -> u32 {
        let f = self.start(extra);
        f["result"]["stream"].as_u64().unwrap_or_else(|| panic!("{f}")) as u32
    }

    /// A picture from the capture, taken by the capture's thread before this returns.
    fn picture(&self, at_us: u64, size: (usize, usize)) {
        self.fake.feed.lock().unwrap().push_back(Ok(Picture::solid(size.0, size.1, [40, 80, 120, 255], at_us)));
        assert!(eventually(|| self.fake.feed.lock().unwrap().is_empty()));
        // and its stream's thread has had it
        std::thread::sleep(Duration::from_millis(40));
    }

    /// Every record the service wrote after the token.
    fn records(&self) -> Vec<Record> {
        let bytes = self.written.lock().unwrap().clone();
        assert!(bytes.len() >= 64);
        assert_eq!(&bytes[..64], TOKEN.as_bytes(), "the token goes first");
        RecordReader::default().push(&bytes[64..]).unwrap()
    }

    fn ack(&self, stream: u32, generation: u32, sequence: u32) {
        if let Some(tx) = &self.to_service {
            tx.send(ack_record(stream, generation, sequence, Some(2000))).unwrap();
        }
    }

    fn acked(&self, stream: u32, n: u64) -> bool {
        eventually(|| self.service.video_counts(stream).is_some_and(|c| c.1 == n))
    }

    /// The notifications so far (a call flushes the ones before it).
    fn ended(&mut self) -> Vec<Value> {
        self.w.call("permissions.get", json!({}));
        self.w.notes.iter().filter(|n| n["method"] == "capture/videoEnded").map(|n| n["params"].clone()).collect()
    }
}

fn next_dir() -> usize {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn eventually(mut f: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    f()
}

#[test]
fn video_is_named_only_with_a_pipe_and_asked_only_when_the_host_offers_it() {
    let mut piped = Rig::ready();
    piped.stream(json!({}));
    assert_eq!(piped.fake.count("startVideo"), 1);

    let mut bare = Rig::new(false, &["video"], |_| {});
    assert_eq!(bare.start(json!({}))["error"]["code"], json!(-32601));

    // a pipe, but a host that never offered the feature: the calls are unknown
    let mut unasked = Rig::new(true, &["front"], |_| {});
    assert_eq!(unasked.start(json!({}))["error"]["code"], json!(-32601));
    assert_eq!(unasked.w.call("capture.video.stop", json!({ "stream": 1 }))["error"]["code"], json!(-32601));
    assert_eq!(unasked.fake.count("startVideo"), 0);
}

#[test]
fn initialize_names_video_only_with_the_pipe_and_the_offer() {
    for (pipe, offered, named) in [(true, true, true), (false, true, false), (true, false, false)] {
        let fake = Arc::new(Shared::default());
        let (_tx, rx) = channel::<Vec<u8>>();
        let mut w = Wire::start_with(Fake(fake), |s| {
            if pipe {
                s.attach_video_pipe(Box::new(Pipe(rx, Vec::new())), Box::new(HostEnd(Arc::default())), TOKEN.as_bytes());
            }
        });
        let dir = std::env::temp_dir().join(format!("tc-video-init-{}-{}", std::process::id(), next_dir()));
        let features = if offered { json!(["video", "front"]) } else { json!(["front"]) };
        let r = w.ok("initialize", json!({ "protocol": 1, "client": { "name": "t", "version": "0" }, "dataDir": dir.to_string_lossy(), "features": features }));
        assert_eq!(r["features"], if named { json!(["video"]) } else { json!([]) }, "pipe {pipe} offered {offered}");
    }
}

#[test]
fn start_answers_an_even_picture_that_fits_max_edge() {
    let mut rig = Rig::new(true, &["video"], |f| *f.pixels.lock().unwrap() = (2560, 1600));
    let q = rig.start(json!({ "maxEdge": 1001 }))["result"].clone();
    assert_eq!((q["stream"].as_i64(), q["width"].as_i64(), q["height"].as_i64()), (Some(1), Some(1000), Some(624)));
    let whole = rig.start(json!({}))["result"].clone();
    assert_eq!((whole["stream"].as_i64(), whole["width"].as_i64(), whole["height"].as_i64()), (Some(2), Some(2560), Some(1600)));
    // budget is held to the link's edge whatever it asks, and starts at its bitrate; quality asks 20 Mbit/s
    let budget = rig.start(json!({ "mode": "budget", "maxEdge": 3000, "bitrate": 5_000_000 }))["result"].clone();
    assert_eq!((budget["width"].as_i64(), budget["height"].as_i64()), (Some(1280), Some(800)));
    let added: Vec<String> = rig.fake.log.lock().unwrap().iter().filter(|l| l.starts_with("addEncoder")).cloned().collect();
    assert_eq!(added, ["addEncoder 1000x624 quality 20000000", "addEncoder 2560x1600 quality 20000000", "addEncoder 1280x800 budget 5000000"]);
    let budget_default = rig.start(json!({ "mode": "budget", "maxEdge": 1280 }))["result"].clone();
    assert!(budget_default["stream"].is_number());
    assert!(rig.fake.log.lock().unwrap().iter().any(|l| l == "addEncoder 1280x800 budget 8000000"));

    let mut odd = Rig::new(true, &["video"], |f| *f.pixels.lock().unwrap() = (1001, 333));
    let fitted = odd.start(json!({}))["result"].clone();
    assert_eq!((fitted["width"].as_i64(), fitted["height"].as_i64()), (Some(1000), Some(332)));
}

#[test]
fn streams_of_one_window_share_the_capture_and_the_last_stops_it() {
    let mut rig = Rig::ready();
    let first = rig.stream(json!({}));
    let second = rig.stream(json!({ "mode": "budget", "maxEdge": 1280 }));
    assert_ne!(first, second);
    assert_eq!(rig.fake.count("startVideo"), 1);
    assert_eq!(rig.fake.count("addEncoder"), 2);
    assert_eq!(rig.w.ok("capture.video.stop", json!({ "stream": first })), json!({}));
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(rig.fake.count("stopVideo"), 0, "one stream still watches");
    rig.w.ok("capture.video.stop", json!({ "stream": second }));
    assert!(eventually(|| rig.fake.count("stopVideo") == 1));
    // a stop ends silently, and a stream the service does not know is no error
    assert_eq!(rig.w.ok("capture.video.stop", json!({ "stream": 99 })), json!({}));
    assert!(rig.ended().is_empty());
    // a new stream on the window starts a new capture
    rig.stream(json!({}));
    assert_eq!(rig.fake.count("startVideo"), 2);
}

#[test]
fn frames_go_out_in_order_and_the_acks_open_the_window() {
    let mut rig = Rig::ready();
    let stream = rig.stream(json!({ "maxEdge": 320 }));
    let t0 = mono_us() + 100_000;
    rig.picture(t0, (640, 400));
    // before any ack the window is one frame
    rig.picture(t0 + 10_000, (640, 400));
    assert!(eventually(|| rig.records().len() == 1));
    let first = rig.records()[0].clone();
    assert_eq!((first.stream, first.kind, first.generation, first.sequence, first.flags), (stream, FRAME_TYPE, 1, 1, KEYFRAME_FLAG));
    assert_eq!(&first.payload[..4], &[0x01, 0x40, 0x00, 0xc8], "320 × 200");
    assert_eq!(u64::from_be_bytes(first.payload[4..12].try_into().unwrap()), t0);
    assert_eq!(&first.payload[12..20], &SPS, "a keyframe leads with its SPS");
    rig.ack(stream, 1, 1);
    assert!(rig.acked(stream, 1));
    rig.picture(t0 + 20_000, (640, 400));
    rig.ack(stream, 1, 2);
    assert!(rig.acked(stream, 2));
    rig.picture(t0 + 30_000, (640, 400));
    assert!(eventually(|| rig.records().len() == 3));
    let records = rig.records();
    assert_eq!(records.iter().map(|r| r.sequence).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(records.iter().map(|r| r.flags).collect::<Vec<_>>(), [1, 0, 0]);
    // an ack of another generation is not this stream's
    rig.ack(stream, 9, 3);
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(rig.service.video_counts(stream).unwrap().1, 2);
    // an ack for a later frame credits the ones before it
    rig.picture(t0 + 40_000, (640, 400));
    std::thread::sleep(Duration::from_millis(30));
    let sent = rig.records().len() as u32;
    rig.ack(stream, 1, sent);
    assert!(rig.acked(stream, sent as u64));
}

#[test]
fn a_new_generation_starts_at_sequence_one_with_a_keyframe() {
    let mut rig = Rig::ready();
    let stream = rig.stream(json!({}));
    let t0 = mono_us() + 100_000;
    rig.picture(t0, (640, 400));
    rig.ack(stream, 1, 1);
    assert!(rig.acked(stream, 1));
    rig.picture(t0 + 10_000, (640, 400));
    rig.ack(stream, 1, 2);
    assert!(rig.acked(stream, 2));
    // the window changed size: a new encoder
    rig.picture(t0 + 20_000, (480, 300));
    assert!(eventually(|| rig.records().len() == 3));
    let last = rig.records()[2].clone();
    assert_eq!((last.generation, last.sequence, last.flags), (2, 1, KEYFRAME_FLAG));
    assert_eq!(&last.payload[..4], &[0x01, 0xe0, 0x01, 0x2c], "480 × 300");
    assert_eq!(rig.fake.count("addEncoder 480x300"), 1);
    // the new generation's acks open its window; the old one's do nothing
    rig.ack(stream, 1, 3);
    std::thread::sleep(Duration::from_millis(30));
    rig.picture(t0 + 30_000, (480, 300));
    assert_eq!(rig.records().len(), 3);
    rig.ack(stream, 2, 1);
    assert!(rig.acked(stream, 1));
    rig.picture(t0 + 40_000, (480, 300));
    assert!(eventually(|| rig.records().len() == 4));
    assert_eq!((rig.records()[3].generation, rig.records()[3].sequence), (2, 2));
}

#[test]
fn no_frame_goes_out_until_a_keyframe() {
    let mut rig = Rig::new(true, &["video"], |f| *f.skip_key.lock().unwrap() = true);
    let stream = rig.stream(json!({}));
    let t0 = mono_us() + 100_000;
    // the encoder dropped its forced keyframe: the P-frame that came is not sent, and the next picture asks again
    rig.picture(t0, (640, 400));
    assert_eq!(rig.fake.count("encode key"), 1);
    assert!(rig.records().is_empty());
    rig.picture(t0 + 10_000, (640, 400));
    assert_eq!(rig.fake.count("encode key"), 2);
    assert!(eventually(|| rig.records().len() == 1));
    assert_eq!((rig.records()[0].sequence, rig.records()[0].flags), (1, KEYFRAME_FLAG));
    rig.ack(stream, 1, 1);
    assert!(rig.acked(stream, 1));
    rig.picture(t0 + 20_000, (640, 400));
    assert_eq!(rig.fake.log.lock().unwrap().last().unwrap(), "encode", "once a keyframe went, no more are forced");
}

#[test]
fn a_still_window_is_sent_again_and_the_repeats_skip_the_pacing() {
    let mut rig = Rig::ready();
    let stream = rig.stream(json!({}));
    rig.picture(mono_us(), (640, 400));
    rig.ack(stream, 1, 1);
    assert!(rig.acked(stream, 1));
    // 150 ms at rest: the last picture again, as a frame of its own, without a new picture
    assert!(eventually(|| rig.records().len() == 2));
    let (one, two) = (rig.records()[0].clone(), rig.records()[1].clone());
    assert_eq!(two.sequence, 2);
    assert!(u64::from_be_bytes(two.payload[4..12].try_into().unwrap()) > u64::from_be_bytes(one.payload[4..12].try_into().unwrap()) + 100_000);
    // acked, the rest of the four come; then nothing
    for seq in 2..=5 {
        assert!(eventually(|| rig.records().len() >= seq as usize));
        rig.ack(stream, 1, seq);
        assert!(rig.acked(stream, seq as u64));
    }
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(rig.records().len(), 5);
}

#[test]
fn a_window_that_ends_on_its_own_says_why() {
    for (end, word) in [(CaptureEnd::WindowClosed, "window-closed"), (CaptureEnd::Error("gone".into()), "error")] {
        let mut rig = Rig::ready();
        let one = rig.stream(json!({}));
        let two = rig.stream(json!({}));
        rig.fake.feed.lock().unwrap().push_back(Err(end));
        let a = rig.w.note("capture/videoEnded");
        let b = rig.w.note("capture/videoEnded");
        let mut ids = vec![a["params"]["stream"].as_u64().unwrap() as u32, b["params"]["stream"].as_u64().unwrap() as u32];
        ids.sort();
        assert_eq!(ids, [one, two]);
        assert!([a, b].iter().all(|n| n["params"]["reason"] == word));
        assert!(eventually(|| rig.fake.count("stopVideo") == 1));
        // the next start makes a capture of its own
        rig.stream(json!({}));
        assert_eq!(rig.fake.count("startVideo"), 2);
    }
}

#[test]
fn session_close_ends_its_streams_with_no_notice() {
    let mut rig = Rig::ready();
    rig.stream(json!({}));
    rig.w.ok("session.close", json!({ "session": "s1" }));
    assert!(eventually(|| rig.fake.count("stopVideo") == 1));
    std::thread::sleep(Duration::from_millis(50));
    assert!(rig.ended().is_empty());
}

#[test]
fn no_ack_for_three_seconds_ends_the_stream_with_error() {
    let mut rig = Rig::ready();
    let stream = rig.stream(json!({}));
    rig.picture(mono_us(), (640, 400));
    let started = Instant::now();
    let ended = rig.w.note("capture/videoEnded");
    assert_eq!((ended["params"]["stream"].as_u64(), ended["params"]["reason"].as_str()), (Some(stream as u64), Some("error")));
    assert!(started.elapsed() >= Duration::from_millis(2500), "{:?}", started.elapsed());
    assert!(eventually(|| rig.fake.count("stopVideo") == 1));
}

#[test]
fn a_record_that_cannot_be_placed_ends_every_stream() {
    let mut rig = Rig::ready();
    rig.stream(json!({}));
    rig.stream(json!({}));
    rig.to_service.as_ref().unwrap().send(vec![0x58; 32]).unwrap();
    let a = rig.w.note("capture/videoEnded");
    let b = rig.w.note("capture/videoEnded");
    assert!([a, b].iter().all(|n| n["params"]["reason"] == "error"));
    assert_eq!(rig.start(json!({}))["error"]["data"]["kind"], "capture_failed");
}

#[test]
fn the_host_closing_its_end_ends_every_stream() {
    let mut rig = Rig::ready();
    rig.stream(json!({}));
    rig.to_service.take();
    assert_eq!(rig.w.note("capture/videoEnded")["params"]["reason"], "error");
    assert_eq!(rig.start(json!({}))["error"]["data"]["kind"], "capture_failed");
}

#[test]
fn start_passes_the_guard_every_picture_path_does() {
    let mut minimized = Rig::new(true, &["video"], |f| *f.minimized.lock().unwrap() = true);
    assert_eq!(minimized.start(json!({}))["error"]["data"]["kind"], "window_minimized");
    assert_eq!(minimized.fake.count("startVideo"), 0);
    let mut rig = Rig::ready();
    assert_eq!(rig.w.call("capture.video.start", json!({ "session": "nope", "app": { "app": "Doc" }, "maxEdge": 1280, "mode": "quality" }))["error"]["data"]["kind"], "unknown_session");
    assert_eq!(rig.start(json!({ "app": { "app": "Nothing" } }))["error"]["data"]["kind"], "app_not_found");
}

#[test]
fn budget_follows_the_flow_and_quality_keeps_its_rate() {
    let mut rig = Rig::new(true, &["video"], |f| *f.unit_bytes.lock().unwrap() = 100_000);
    let budget = rig.stream(json!({ "mode": "budget", "maxEdge": 1280 }));
    let t0 = mono_us() + 100_000;
    rig.picture(t0, (640, 400));
    rig.ack(budget, 1, 1);
    assert!(rig.acked(budget, 1));
    // two large frames the viewer never acks: the queue stands, and the flow cuts the rate by a quarter
    rig.picture(t0 + 10_000, (640, 400));
    rig.picture(t0 + 20_000, (640, 400));
    assert_eq!(rig.records().len(), 3);
    assert!(eventually(|| rig.fake.count("setBitrate 6000000") == 1), "{:?}", rig.fake.log.lock().unwrap());

    let mut quality = Rig::new(true, &["video"], |f| *f.unit_bytes.lock().unwrap() = 100_000);
    let q = quality.stream(json!({}));
    quality.picture(t0, (640, 400));
    quality.ack(q, 1, 1);
    quality.picture(t0 + 10_000, (640, 400));
    quality.picture(t0 + 20_000, (640, 400));
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(quality.fake.count("setBitrate"), 0);
}
