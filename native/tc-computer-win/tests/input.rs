//! The event tiers, capture and the clipboard over a fake desktop that
//! records what the service posts (docs/computer-protocol.md §5, §6, §29.4):
//! which tier a step takes, the session's space and the agent cursor, the
//! session hold and the person stopping it, typing by keys or by paste, the
//! clipboard put back, screenshots, zoom and the stream. The real desktop
//! is proven in the rig (M43.md).

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{init, Wire};
use serde_json::{json, Value};
use tc_computer_win::capture::Image;
use tc_computer_win::desktop::{fail, Acted, Clip, Desktop, Event, KeyPhase, PersonInput, Win};
use tc_computer_win::input::{Key, INPUT_TAG};
use tc_computer_win::text::{RawNode, RawWindow};
use tc_computer_win::wire::*;

type Watcher = Arc<Mutex<Option<Box<dyn Fn(PersonInput) + Send + Sync>>>>;

#[derive(Default, Clone)]
struct Fake {
    posted: Arc<Mutex<Vec<(Tier, Event)>>>,
    /// the field's text, as typed or pasted into it
    value: Arc<Mutex<String>>,
    clip: Arc<Mutex<(i64, String)>>,
    front: Arc<Mutex<Option<(i64, i64)>>>,
    pointer: Arc<Mutex<(f64, f64)>>,
    locked: Arc<Mutex<bool>>,
    watcher: Watcher,
    /// the person types while a session step runs
    person_types: Arc<Mutex<bool>>,
    /// a frame counter, so a stream sees new pixels
    frames: Arc<Mutex<u8>>,
    /// the person moves the pointer while a session step runs
    person_moves: Arc<Mutex<bool>>,
}

const FRAME: Rect = Rect { x: 100.0, y: 50.0, w: 800.0, h: 600.0 };

impl Desktop for Fake {
    type Handle = &'static str;
    fn os(&self) -> (String, String) {
        ("Windows 10.0.26200".into(), "x86_64".into())
    }
    fn displays(&self) -> Vec<DisplayInfo> {
        vec![DisplayInfo { id: 1, frame: Rect { x: 0.0, y: 0.0, w: 1280.0, h: 800.0 }, scale: 1.0 }]
    }
    fn apps(&self, windows: bool) -> Result<Vec<AppInfo>, ComputerError> {
        let window = WindowInfo { id: 70, title: "Untitled - Notepad".into(), frame: FRAME, main: true, focused: true, on_screen: true, space: WindowSpace::Current, ..Default::default() };
        Ok(vec![
            AppInfo { pid: 10, bundle_id: Some("notepad.exe".into()), name: "Notepad".into(), active: self.front.lock().unwrap().is_some_and(|(p, _)| p == 10), hidden: false, windows: windows.then(|| vec![window]) },
            AppInfo { pid: 20, bundle_id: Some("explorer.exe".into()), name: "Windows Explorer".into(), active: false, hidden: false, windows: None },
        ])
    }
    fn read(&self, pid: i64, _window: Option<&WindowRef>, _from: Option<&&'static str>, _deadline: Instant) -> Result<RawWindow<&'static str>, ComputerError> {
        let field = RawNode { handle: "field", key: vec![2], role: "text area".into(), name: Some("Text editor".into()), value: Some(self.value.lock().unwrap().clone()), frame: Some(Rect { x: 200.0, y: 150.0, w: 400.0, h: 300.0 }), ..Default::default() };
        let save = RawNode { handle: "save", key: vec![3], role: "button".into(), name: Some("Save".into()), frame: Some(Rect { x: 700.0, y: 600.0, w: 80.0, h: 30.0 }), ..Default::default() };
        let root = RawNode { handle: "window", key: vec![1], role: "window".into(), name: Some("Untitled - Notepad".into()), children: vec![field, save], ..Default::default() };
        Ok(RawWindow { pid, app_name: "Notepad".into(), bundle_id: Some("notepad.exe".into()), window_id: 70, title: "Untitled - Notepad".into(), frame: FRAME, others: vec![], root, partial: false, read_ms: 1 })
    }
    fn act(&self, _pid: i64, element: &&'static str, a: &ComputerAction) -> Result<Acted, ComputerError> {
        match (*element, a.action) {
            ("field", ComputerActionName::Type) if self.value.lock().unwrap().is_empty() => {
                *self.value.lock().unwrap() = a.text.clone().unwrap_or_default();
                Ok(Acted { via: Some(InputVia::AxValue), value: a.text.clone() })
            }
            _ => Err(fail(ComputerErrorKind::ActionUnsupported, "not without the pointer")),
        }
    }
    fn window(&self, pid: i64, _window: Option<&WindowRef>) -> Result<Win, ComputerError> {
        Ok(Win { id: 70, pid, title: "Untitled - Notepad".into(), frame: FRAME, minimized: false })
    }
    fn frame_of(&self, element: &&'static str) -> Option<Rect> {
        match *element {
            "field" => Some(Rect { x: 200.0, y: 150.0, w: 400.0, h: 300.0 }),
            "save" => Some(Rect { x: 700.0, y: 600.0, w: 80.0, h: 30.0 }),
            _ => None,
        }
    }
    fn focus(&self, _element: &&'static str) -> Result<(), ComputerError> {
        Ok(())
    }
    fn post(&self, _win: &Win, _element: Option<&&'static str>, tier: Tier, e: &Event) -> Result<(), ComputerError> {
        if tier == Tier::Session && *self.person_moves.lock().unwrap() && matches!(e, Event::Button { down: true, .. }) {
            if let Some(f) = self.watcher.lock().unwrap().as_ref() {
                f(PersonInput::Pointer);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if tier == Tier::Session && *self.person_types.lock().unwrap() {
            if let Some(f) = self.watcher.lock().unwrap().as_ref() {
                f(PersonInput::Key);
            }
            // the watch's thread needs a moment, as Windows' hook thread would
            std::thread::sleep(Duration::from_millis(20));
        }
        match e {
            Event::Text(t) => self.value.lock().unwrap().push_str(t),
            Event::Paste => {
                let c = self.clip.lock().unwrap().1.clone();
                self.value.lock().unwrap().push_str(&c);
            }
            Event::Move { at } | Event::Click { at, .. } if tier == Tier::Session => *self.pointer.lock().unwrap() = *at,
            _ => {}
        }
        self.posted.lock().unwrap().push((tier, e.clone()));
        Ok(())
    }
    fn front(&self) -> Option<(i64, i64)> {
        *self.front.lock().unwrap()
    }
    fn raise(&self, window_id: i64) -> bool {
        *self.front.lock().unwrap() = Some((if window_id == 70 { 10 } else { 20 }, window_id));
        true
    }
    fn pointer(&self) -> (f64, f64) {
        *self.pointer.lock().unwrap()
    }
    fn set_pointer(&self, at: (f64, f64)) {
        *self.pointer.lock().unwrap() = at;
    }
    fn locked(&self) -> bool {
        *self.locked.lock().unwrap()
    }
    fn watch_person(&self, f: Box<dyn Fn(PersonInput) + Send + Sync>) {
        *self.watcher.lock().unwrap() = Some(f);
    }
    fn grab(&self, _window_id: i64) -> Result<Image, ComputerError> {
        let mut img = Image::new(FRAME.w as usize, FRAME.h as usize);
        let mut n = self.frames.lock().unwrap();
        *n = n.wrapping_add(1);
        img.bgr[0] = *n;
        Ok(img)
    }
    fn encode(&self, img: &Image, format: ShotFormat, _q: f32) -> Result<Vec<u8>, ComputerError> {
        // PNG smaller than JPEG for this flat picture, so the format by content keeps PNG
        Ok(vec![if format == ShotFormat::Png { b'P' } else { b'J' }; if format == ShotFormat::Png { img.width } else { img.width * 2 }])
    }
    fn alive(&self, _window_id: i64) -> bool {
        true
    }
    fn clip_seq(&self) -> i64 {
        self.clip.lock().unwrap().0
    }
    fn clip_save(&self) -> Result<Clip, ComputerError> {
        Ok(Clip(vec![(13, self.clip.lock().unwrap().1.clone().into_bytes())]))
    }
    fn clip_put(&self, text: &str, _html: Option<&str>) -> Result<(), ComputerError> {
        let mut c = self.clip.lock().unwrap();
        *c = (c.0 + 1, text.to_string());
        Ok(())
    }
    fn clip_restore(&self, clip: &Clip) -> Result<(), ComputerError> {
        let mut c = self.clip.lock().unwrap();
        *c = (c.0 + 1, String::from_utf8(clip.0[0].1.clone()).unwrap());
        Ok(())
    }
    fn launch(&self, exe: &str, _args: &[String]) -> Result<i64, ComputerError> {
        if exe == "calc.exe" { Ok(30) } else { Err(fail(ComputerErrorKind::AppNotFound, "no such app")) }
    }
}

fn start(fake: &Fake) -> (Wire, String) {
    let mut w = Wire::start(fake.clone());
    let epoch = init(&mut w)["epoch"].as_str().unwrap().to_string();
    w.ok("session.open", json!({ "session": "s" }));
    w.ok("state.get", json!({ "session": "s", "app": { "app": "Notepad" }, "screenshot": "never" }));
    (w, epoch)
}

fn act(epoch: &str, tiers: Value, a: Value) -> Value {
    json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "action": a, "tiers": tiers, "observe": { "screenshot": "never" } })
}

#[test]
fn a_click_at_a_coordinate_posts_at_the_pixels_centre_and_moves_the_agent_cursor() {
    let fake = Fake::default();
    let (mut w, epoch) = start(&fake);
    let r = w.ok("action.run", act(&epoch, json!(["ax", "process", "session"]), json!({ "action": "left_click", "coordinate": [10, 20] })));
    assert_eq!(r["step"]["tier"], json!("process"), "{r}");
    assert_eq!(r["step"]["cursor"], json!([10, 20]));
    let posted = fake.posted.lock().unwrap().clone();
    assert_eq!(posted, vec![(Tier::Process, Event::Click { at: (110.5, 70.5), button: tc_computer_win::desktop::Button::Left, count: 1, hold: Duration::ZERO, mods: Default::default() })]);
    let c = w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "cursor_position" })));
    assert_eq!(c["step"]["text"], json!("X=10, Y=20"));
    // neither element nor coordinate: at the agent cursor
    w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "double_click" })));
    assert!(matches!(fake.posted.lock().unwrap().last(), Some((_, Event::Click { at: (x, y), count: 2, .. })) if (*x, *y) == (110.5, 70.5)));
    let out = w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "left_click", "coordinate": [800, 0] })));
    assert_eq!(out["step"]["error"]["kind"], json!("out_of_bounds"));
    assert_eq!(out["step"]["error"]["space"], json!({ "width": 800, "height": 600, "scale": 1.0 }));
}

#[test]
fn an_element_click_the_ax_tier_cannot_take_goes_to_its_centre_at_the_next_tier() {
    let fake = Fake::default();
    let (mut w, epoch) = start(&fake);
    let r = w.ok("action.run", act(&epoch, json!(["ax", "process"]), json!({ "action": "left_click", "element": 3 })));
    assert_eq!(r["step"]["tier"], json!("process"), "{r}");
    assert!(matches!(fake.posted.lock().unwrap()[0], (Tier::Process, Event::Click { at: (740.0, 615.0), .. })));
    // the element's point in the session's space
    assert_eq!(r["step"]["cursor"], json!([640, 565]));
}

#[test]
fn a_modified_key_needs_the_session_tier_which_holds_the_pc_and_records_what_it_changed() {
    let fake = Fake::default();
    *fake.front.lock().unwrap() = Some((20, 99));
    *fake.pointer.lock().unwrap() = (5.0, 5.0);
    let (mut w, epoch) = start(&fake);
    let r = w.ok("action.run", act(&epoch, json!(["ax", "process", "front"]), json!({ "action": "key", "text": "ctrl+s" })));
    assert_eq!(r["step"]["error"]["kind"], json!("needs_tier"));
    assert_eq!(r["step"]["error"]["needed"], json!("session"));
    assert!(fake.posted.lock().unwrap().is_empty(), "nothing was posted");
    let r = w.ok("action.run", act(&epoch, json!(["ax", "process", "session"]), json!({ "action": "key", "text": "ctrl+s" })));
    assert_eq!(r["step"]["tier"], json!("session"), "{r}");
    let session = &r["step"]["session"];
    assert_eq!(session["frontmost"]["before"]["bundleId"], json!("explorer.exe"));
    assert_eq!(session["frontmost"]["after"]["bundleId"], json!("notepad.exe"));
    assert_eq!(session["restorable"], json!(true));
    let posted = fake.posted.lock().unwrap().clone();
    assert!(matches!(posted[0], (Tier::Session, Event::Key { combo, phase: KeyPhase::Tap }) if combo.mods.ctrl && combo.key == Key::Vk(b'S' as u16)));
    // restore: the person's front window and pointer come back
    let back = w.ok("input.restoreSession", json!({}));
    assert_eq!(back["frontmost"], json!("restored"));
    assert_eq!(*fake.front.lock().unwrap(), Some((20, 99)));
    assert_eq!(*fake.pointer.lock().unwrap(), (5.0, 5.0));
    // the screen locked: refused
    *fake.locked.lock().unwrap() = true;
    let r = w.ok("action.run", act(&epoch, json!(["session"]), json!({ "action": "key", "text": "ctrl+s" })));
    assert_eq!(r["step"]["error"]["kind"], json!("session_unavailable"));
    assert_eq!(r["step"]["error"]["reason"], json!("locked"));
}

#[test]
fn the_person_typing_stops_a_session_step_and_escape_is_told_while_watched() {
    let fake = Fake::default();
    *fake.person_types.lock().unwrap() = true;
    let (mut w, epoch) = start(&fake);
    let r = w.ok("action.run", act(&epoch, json!(["session"]), json!({ "action": "type", "text": "one two three" })));
    // the first chunk went; the person's key stopped the rest
    assert_eq!(r["step"]["error"]["kind"], json!("interrupted"), "{r}");
    assert_eq!(r["step"]["error"]["by"], json!("person"));
    assert!(r["step"]["error"]["session"].is_object());
    assert_eq!(w.note("session/interrupted")["params"]["by"], json!("person"));
    // Escape: told only while the watch's lease runs
    let tell = |p| fake.watcher.lock().unwrap().as_ref().unwrap()(p);
    tell(PersonInput::Escape);
    w.ok("escape.watch", json!({ "on": true, "leaseMs": 5000 }));
    tell(PersonInput::Escape);
    let pressed = w.note("escape/pressed");
    assert!(pressed["params"]["at"].as_f64().unwrap() > 0.0);
    w.ok("escape.watch", json!({ "on": false }));
    tell(PersonInput::Escape);
    std::thread::sleep(Duration::from_millis(50));
    w.ok("clipboard.state", json!({}));
    assert!(!w.notes.iter().any(|n| n["method"] == json!("escape/pressed")), "no Escape after the watch ended");
}

#[test]
fn typing_goes_in_by_value_when_empty_then_by_keys_and_long_text_by_paste_with_the_clipboard_put_back() {
    let fake = Fake::default();
    *fake.clip.lock().unwrap() = (5, "the person's copy".into());
    let (mut w, epoch) = start(&fake);
    let r = w.ok("action.run", act(&epoch, json!(["ax", "process"]), json!({ "action": "type", "element": 2, "text": "Hi" })));
    assert_eq!((r["step"]["tier"].clone(), r["step"]["input"]["via"].clone()), (json!("ax"), json!("ax-value")), "{r}");
    let r = w.ok("action.run", act(&epoch, json!(["ax", "process"]), json!({ "action": "type", "element": 2, "text": " there\nfriend" })));
    assert_eq!((r["step"]["tier"].clone(), r["step"]["input"]["via"].clone()), (json!("process"), json!("keys")), "{r}");
    assert!(matches!(fake.posted.lock().unwrap()[1], (Tier::Process, Event::Key { combo, .. }) if combo.key == Key::Vk(0x0D)));
    assert_eq!(*fake.value.lock().unwrap(), "Hi therefriend");
    // the watch's start counts as a copy: a paste right after it waits
    let long = "x".repeat(2500);
    let quiet = |text: &str| json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "action": { "action": "type", "text": text }, "tiers": ["process"], "pasteQuietMs": 5000, "observe": { "mode": "none" } });
    let r = w.ok("action.run", quiet(&long));
    assert_eq!(r["step"]["error"]["kind"], json!("clipboard_busy"), "{r}");
    assert_eq!(r["step"]["error"]["reason"], json!("recent-copy"));
    let r = w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "type", "text": long })));
    assert_eq!(r["step"]["input"], json!({ "via": "paste", "clipboard": "restored" }), "{r}");
    assert!(fake.value.lock().unwrap().ends_with(&long));
    assert_eq!(fake.clip.lock().unwrap().1, "the person's copy");
    let state = w.ok("clipboard.state", json!({}));
    assert!(state["foreignChangeAt"].is_null(), "the service's own writes are not the person's: {state}");
}

#[test]
fn a_held_button_keeps_its_tier_and_is_let_go_when_the_session_closes() {
    let fake = Fake::default();
    let (mut w, epoch) = start(&fake);
    w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "mouse_move", "coordinate": [50, 50] })));
    let r = w.ok("action.run", act(&epoch, json!(["process", "session"]), json!({ "action": "left_mouse_down" })));
    assert_eq!(r["step"]["tier"], json!("process"));
    let r = w.ok("action.run", act(&epoch, json!(["session"]), json!({ "action": "mouse_move", "coordinate": [60, 60] })));
    assert_eq!(r["step"]["error"]["needed"], json!("process"), "{r}");
    w.ok("session.close", json!({ "session": "s" }));
    assert!(matches!(fake.posted.lock().unwrap().last(), Some((Tier::Process, Event::Button { down: false, .. }))));
}

#[test]
fn a_screenshot_sets_the_space_and_a_zoom_never_does() {
    let fake = Fake::default();
    let (mut w, epoch) = start(&fake);
    let r = w.ok("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "action": { "action": "screenshot" }, "tiers": ["process"], "observe": { "screenshot": "never", "maxEdge": 600 } }));
    let shot = &r["step"]["shot"];
    assert_eq!((shot["width"].clone(), shot["height"].clone(), shot["format"].clone()), (json!(600), json!(450), json!("png")), "{r}");
    assert!(shot["path"].as_str().unwrap().replace('\\', "/").ends_with("shots/s/0001-screenshot.png"));
    assert!(std::path::Path::new(shot["path"].as_str().unwrap()).exists());
    assert_eq!(r["observation"]["space"], json!({ "width": 600, "height": 450, "scale": 0.75 }));
    // a coordinate in the new space
    w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "left_click", "coordinate": [300, 300] })));
    assert!(matches!(fake.posted.lock().unwrap().last(), Some((_, Event::Click { at, .. })) if (at.0 - (100.0 + 300.5 / 0.75)).abs() < 1e-9));
    let z = w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "zoom", "region": [0, 0, 300, 150] })));
    assert_eq!(z["step"]["shot"]["region"], json!([0, 0, 300, 150]), "{z}");
    assert_eq!(z["step"]["shot"]["width"], json!(400), "the region at full resolution");
    assert_eq!(z["observation"]["space"]["width"], json!(600));
    let bad = w.ok("action.run", act(&epoch, json!(["process"]), json!({ "action": "zoom", "region": [0, 0, 900, 10] })));
    assert_eq!(bad["step"]["error"]["kind"], json!("out_of_bounds"));
    let s = w.ok("capture.screenshot", json!({ "session": "s", "app": { "app": "Notepad" }, "format": "jpeg" }));
    assert_eq!(s["format"], json!("jpeg"));
    assert!(s["path"].as_str().unwrap().ends_with("0003-screenshot.jpg"), "{s}");
}

#[test]
fn a_thin_read_with_auto_carries_a_picture_and_says_so() {
    let fake = Fake::default();
    let (mut w, _) = start(&fake);
    let o = w.ok("state.get", json!({ "session": "s", "app": { "app": "Notepad" } }));
    assert!(o["text"].as_str().unwrap().lines().next().unwrap().ends_with("thin tree, see the screenshot"), "{o}");
    assert!(o["shot"]["path"].as_str().unwrap().contains("observe"));
}

#[test]
fn the_stream_sends_new_frames_two_at_a_time_and_ends_when_stopped() {
    let fake = Fake::default();
    let (mut w, _) = start(&fake);
    let r = w.ok("capture.stream.start", json!({ "session": "s", "app": { "app": "Notepad" }, "stream": "p1", "fps": 15, "maxEdge": 400 }));
    assert_eq!((r["width"].clone(), r["height"].clone()), (json!(400), json!(300)));
    let f1 = w.note("capture/frame");
    let f2 = w.note("capture/frame");
    assert_eq!((f1["params"]["seq"].clone(), f2["params"]["seq"].clone()), (json!(1), json!(2)));
    assert_eq!(f1["params"]["format"], json!("jpeg"));
    // two out, none acked: no third until an ack
    std::thread::sleep(Duration::from_millis(300));
    w.ok("clipboard.state", json!({}));
    assert!(!w.notes.iter().any(|n| n["method"] == json!("capture/frame")), "{:?}", w.notes);
    w.raw(&json!({ "jsonrpc": "2.0", "method": "capture.stream.ack", "params": { "stream": "p1", "seq": 2 } }).to_string());
    assert_eq!(w.note("capture/frame")["params"]["seq"], json!(3));
    // a click on the window marks the stream
    w.ok("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "action": { "action": "left_click", "coordinate": [400, 300] }, "tiers": ["process"], "observe": { "mode": "none" } }));
    let click = w.note("capture/click");
    assert_eq!(click["params"]["at"], json!([200, 150]));
    w.ok("capture.stream.stop", json!({ "stream": "p1" }));
    assert_eq!(w.note("capture/streamEnded")["params"]["reason"], json!("stopped"));
}

#[test]
fn launch_starts_an_app_that_is_not_running_and_refuses_programs_as_items() {
    let fake = Fake::default();
    let (mut w, _) = start(&fake);
    let running = w.ok("apps.launch", json!({ "app": "notepad" }));
    assert_eq!(running, json!({ "pid": 10, "launched": false }));
    assert_eq!(w.kind("apps.launch", json!({ "app": "notepad", "open": ["C:\\Users\\me\\run.bat"] })), "open_refused");
    assert_eq!(w.kind("apps.launch", json!({ "app": "notepad", "refuse": ["notepad.exe"] })), "open_refused");
    assert_eq!(w.kind("apps.launch", json!({ "app": "nothing-here" })), "app_not_found");
    assert_eq!(INPUT_TAG, 0x7463_6370);
}

#[test]
fn a_step_the_person_stops_lets_go_of_what_it_pressed_and_a_held_session_button_goes_when_they_move() {
    let fake = Fake::default();
    *fake.person_moves.lock().unwrap() = true;
    let (mut w, epoch) = start(&fake);
    // a drag stopped after its down: the down is let go at once
    let r = w.ok("action.run", act(&epoch, json!(["session"]), json!({ "action": "left_click_drag", "start_coordinate": [10, 10], "coordinate": [200, 10], "text": "shift" })));
    assert_eq!(r["step"]["error"]["kind"], json!("interrupted"), "{r}");
    let last = fake.posted.lock().unwrap().last().cloned();
    assert!(matches!(last, Some((Tier::Session, Event::Button { down: false, mods, .. })) if mods.shift), "{last:?}");
    // a session-tier down kept between calls is let go, at the session tier, when the person acts
    *fake.person_moves.lock().unwrap() = false;
    w.ok("action.run", act(&epoch, json!(["session"]), json!({ "action": "mouse_move", "coordinate": [50, 50] })));
    let r = w.ok("action.run", act(&epoch, json!(["session"]), json!({ "action": "left_mouse_down" })));
    assert_eq!(r["step"]["tier"], json!("session"), "{r}");
    fake.watcher.lock().unwrap().as_ref().unwrap()(PersonInput::Pointer);
    std::thread::sleep(Duration::from_millis(50));
    let last = fake.posted.lock().unwrap().last().cloned();
    assert!(matches!(last, Some((Tier::Session, Event::Button { down: false, .. }))), "{last:?}");
}

#[test]
fn a_click_held_for_a_duration_is_cut_short_by_a_cancel_and_still_released() {
    let fake = Fake::default();
    let (mut w, epoch) = start(&fake);
    w.raw(&json!({ "jsonrpc": "2.0", "id": 900, "method": "action.run", "params": act(&epoch, json!(["process"]), json!({ "action": "left_click", "coordinate": [10, 10], "duration": 8 })) }).to_string());
    std::thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    w.raw(&json!({ "jsonrpc": "2.0", "method": "$/cancel", "params": { "id": 900 } }).to_string());
    let f = w.frame();
    assert!(started.elapsed() < Duration::from_secs(3), "the hold ran on");
    assert_eq!(f["result"]["step"]["error"]["kind"], json!("cancelled"), "{f}");
    let last = fake.posted.lock().unwrap().last().cloned();
    assert!(matches!(last, Some((Tier::Process, Event::Button { down: false, .. }))), "{last:?}");
}

#[test]
fn closing_a_session_with_a_live_stream_answers_and_a_restarted_stream_keeps_its_id() {
    let fake = Fake::default();
    let (mut w, _) = start(&fake);
    let start_stream = json!({ "session": "s", "app": { "app": "Notepad" }, "stream": "p1", "fps": 15 });
    w.ok("capture.stream.start", start_stream.clone());
    w.note("capture/frame");
    // started again under its id: the first ends quietly, the second is the one stop ends
    w.ok("capture.stream.start", start_stream);
    std::thread::sleep(Duration::from_millis(300));
    w.ok("clipboard.state", json!({}));
    assert!(!w.notes.iter().any(|n| n["method"] == json!("capture/streamEnded")), "{:?}", w.notes);
    w.ok("session.close", json!({ "session": "s" }));
    assert_eq!(w.note("capture/streamEnded")["params"]["reason"], json!("stopped"));
}

#[test]
fn a_launch_named_by_a_path_is_refused_by_its_file_name() {
    let fake = Fake::default();
    let (mut w, _) = start(&fake);
    assert_eq!(w.kind("apps.launch", json!({ "app": "C:\\Windows\\System32\\consent.exe", "refuse": ["consent.exe"] })), "open_refused");
    assert_eq!(w.kind("apps.launch", json!({ "app": "consent", "refuse": ["consent.exe"] })), "open_refused");
}
