//! The service over its stdio framing with a fake desktop: the init gate,
//! the refusals, the methods' shapes, element indices, the `ax` tier's
//! steps and their effect. The real desktop is proven in the rig (M42.md).

mod common;

use std::sync::Mutex;
use std::time::Instant;

use common::{init, Wire};
use serde_json::{json, Value};
use tc_computer_win::desktop::{fail, Acted, Desktop};
use tc_computer_win::text::{RawNode, RawWindow};
use tc_computer_win::wire::*;

#[derive(Default)]
struct Fake {
    /// the text field's value
    value: Mutex<String>,
    /// the save button exists
    save: Mutex<bool>,
    /// a read panics, as a UIA fault would
    panics: bool,
}

impl Desktop for Fake {
    type Handle = &'static str;
    fn os(&self) -> (String, String) {
        ("Windows 10.0.26200".into(), "x86_64".into())
    }
    fn displays(&self) -> Vec<DisplayInfo> {
        vec![DisplayInfo { id: 1, frame: Rect { x: 0.0, y: 0.0, w: 1280.0, h: 800.0 }, scale: 1.0 }]
    }
    fn apps(&self, windows: bool) -> Result<Vec<AppInfo>, ComputerError> {
        let window = WindowInfo { id: 70, title: "Untitled - Notepad".into(), frame: Rect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 }, main: true, focused: true, on_screen: true, space: WindowSpace::Current, ..Default::default() };
        Ok(vec![
            AppInfo { pid: 10, bundle_id: Some("notepad.exe".into()), name: "Notepad".into(), active: true, hidden: false, windows: windows.then(|| vec![window]) },
            AppInfo { pid: 11, bundle_id: Some("msedge.exe".into()), name: "Microsoft Edge".into(), active: false, hidden: false, windows: None },
        ])
    }
    fn read(&self, pid: i64, window: Option<&WindowRef>, from: Option<&&'static str>, _deadline: Instant) -> Result<RawWindow<&'static str>, ComputerError> {
        if self.panics {
            panic!("the reader fell over");
        }
        if pid != 10 {
            return Err(fail(ComputerErrorKind::WindowNotFound, "no window"));
        }
        if window.and_then(|w| w.title.as_deref()).is_some_and(|t| !t.contains("Notepad")) {
            return Err(ComputerError { candidates: Some(vec!["Untitled - Notepad".into()]), ..fail(ComputerErrorKind::WindowNotFound, "no such window") });
        }
        let field = RawNode { handle: "field", key: vec![2], role: "text area".into(), name: Some("Text editor".into()), value: Some(self.value.lock().unwrap().clone()), states: vec!["focused"], ..Default::default() };
        let mut children = vec![field.clone()];
        if *self.save.lock().unwrap() {
            children.push(RawNode { handle: "save", key: vec![3], role: "button".into(), name: Some("Save".into()), ..Default::default() });
        }
        let root = RawNode { handle: "window", key: vec![1], role: "window".into(), name: Some("Untitled - Notepad".into()), children, ..Default::default() };
        let root = if from == Some(&"field") { field } else { root };
        Ok(RawWindow { pid, app_name: "Notepad".into(), bundle_id: Some("notepad.exe".into()), window_id: 70, title: "Untitled - Notepad".into(), frame: Rect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 }, others: vec![], root, partial: false, read_ms: 1 })
    }
    fn act(&self, _pid: i64, element: &&'static str, action: &ComputerAction) -> Result<Acted, ComputerError> {
        match (*element, action.action) {
            ("field", ComputerActionName::SetValue) => {
                *self.value.lock().unwrap() = action.value.clone().unwrap_or_default();
                *self.save.lock().unwrap() = false;
                Ok(Acted { value: action.value.clone(), via: None })
            }
            ("save", ComputerActionName::LeftClick) => Ok(Acted::default()),
            _ => Err(fail(ComputerErrorKind::ActionUnsupported, "no")),
        }
    }
}

#[test]
fn the_gate_and_the_standard_refusals() {
    let mut w = Wire::start(Fake::default());
    w.raw("not json");
    assert_eq!(w.frame()["error"]["code"], json!(-32700));
    assert_eq!(w.kind("apps.list", json!({})), "not_initialized");
    assert_eq!(w.call("nope", json!({}))["error"]["code"], json!(-32601));
    assert_eq!(w.call("state.get", json!({ "app": {} }))["error"]["code"], json!(-32602));
    assert_eq!(w.kind("initialize", json!({ "protocol": 2, "client": { "name": "t", "version": "1" }, "dataDir": "/tmp/x" })), "protocol_mismatch");
    let first = init(&mut w);
    assert_eq!(first["protocol"], json!(1));
    assert_eq!(first["os"]["arch"], json!("x86_64"));
    assert_eq!(first["features"], json!([]));
    assert_eq!(w.ok("permissions.get", json!({})), json!({ "accessibility": true, "screenRecording": true }));
    assert!(w.ok("clipboard.state", json!({}))["watchingSince"].is_number());
}

#[test]
fn apps_sessions_and_an_observation() {
    let mut w = Wire::start(Fake::default());
    let epoch = init(&mut w)["epoch"].as_str().unwrap().to_string();
    let apps = w.ok("apps.list", json!({ "windows": true }));
    assert_eq!(apps["apps"][0]["bundleId"], json!("notepad.exe"));
    assert_eq!(apps["apps"][0]["windows"][0]["space"], json!("current"));
    assert!(apps["apps"][1].get("windows").is_none());
    assert_eq!(w.kind("state.get", json!({ "session": "s", "app": { "app": "notepad" } })), "unknown_session");
    w.ok("session.open", json!({ "session": "s" }));
    w.ok("session.open", json!({ "session": "s" }));
    let o = w.ok("state.get", json!({ "session": "s", "app": { "app": "Notepad" } }));
    assert_eq!(o["kind"], json!("full"));
    assert_eq!(o["seq"], json!(1));
    assert_eq!(o["epoch"], json!(epoch));
    assert_eq!(o["text"], json!("app \"Notepad\" · window \"Untitled - Notepad\" · 800×600 · focused [2]\n[1] window \"Untitled - Notepad\"\n  [2] text area \"Text editor\" focused"));
    assert_eq!(o["stats"]["elements"], json!(2));
    let sub = w.ok("state.get", json!({ "session": "s", "app": { "app": "notepad.exe" }, "element": 2, "epoch": epoch }));
    assert_eq!(sub["kind"], json!("subtree"));
    assert_eq!(sub["seq"], json!(1), "a subtree leaves seq where it was");
    let missing = w.call("state.get", json!({ "session": "s", "app": { "app": "Calc" } }));
    assert_eq!(missing["error"]["data"]["kind"], json!("app_not_found"));
    assert_eq!(missing["error"]["data"]["candidates"], json!(["Notepad", "Microsoft Edge"]));
    assert_eq!(w.ok("apps.launch", json!({ "app": "micro" }))["pid"], json!(11), "a unique prefix");
    assert_eq!(w.kind("state.get", json!({ "session": "s", "app": { "app": "Notepad" }, "window": { "title": "Other" } })), "window_not_found");
    assert_eq!(w.kind("state.get", json!({ "session": "s", "app": { "app": "Notepad" }, "element": 2, "epoch": "old" })), "stale_element");
    let launch = w.ok("apps.launch", json!({ "app": "Notepad" }));
    assert_eq!(launch, json!({ "pid": 10, "launched": false }));
    assert_eq!(w.kind("apps.launch", json!({ "app": "Paint" })), "app_not_found");
    w.ok("session.close", json!({ "session": "s" }));
    assert_eq!(w.kind("state.get", json!({ "session": "s", "app": { "app": "Notepad" } })), "unknown_session");
}

#[test]
fn the_ax_tier_sets_a_value_and_names_what_it_cannot_do() {
    let fake = Fake::default();
    *fake.save.lock().unwrap() = true;
    let mut w = Wire::start(fake);
    let epoch = init(&mut w)["epoch"].as_str().unwrap().to_string();
    w.ok("session.open", json!({ "session": "s" }));
    w.ok("state.get", json!({ "session": "s", "app": { "app": "Notepad" } }));
    let target = |a: Value| json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "action": a, "tiers": ["ax", "process"] });
    let r = w.ok("action.run", target(json!({ "action": "set_value", "element": 2, "value": "hello" })));
    assert_eq!(r["step"]["status"], json!("ok"));
    assert_eq!(r["step"]["tier"], json!("ax"));
    assert_eq!(r["step"]["effect"], json!("changed"));
    assert_eq!(r["step"]["element"], json!({ "index": 2, "line": "text area \"Text editor\" = \"hello\" focused" }));
    assert!(r["observation"]["text"].as_str().unwrap().contains("= \"hello\""));
    // the save button went with the write: acting on it now is stale
    let gone = w.ok("action.run", target(json!({ "action": "left_click", "element": 3 })));
    assert_eq!(gone["step"]["error"]["kind"], json!("stale_element"));
    assert_eq!(gone["step"]["error"]["reason"], json!("gone"));
    let never = w.ok("action.run", target(json!({ "action": "left_click", "element": 99 })));
    assert_eq!(never["step"]["error"]["kind"], json!("no_such_element"));
    let key = w.ok("action.run", target(json!({ "action": "key", "text": "Return" })));
    assert_eq!(key["step"]["error"]["kind"], json!("action_unsupported"));
    let no_ax = w.ok("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "action": { "action": "set_value", "element": 2, "value": "x" }, "tiers": ["process"] }));
    assert_eq!(no_ax["step"]["error"]["needed"], json!("ax"));
    let batch = w.ok(
        "action.batch",
        json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "tiers": ["ax"], "actions": [
            { "action": "set_value", "element": 2, "value": "one" },
            { "action": "key", "text": "Return" },
            { "action": "set_value", "element": 2, "value": "two" }
        ], "wait": { "minMs": 0, "quietMs": 20, "maxMs": 200, "busyMaxMs": 200 } }),
    );
    let statuses: Vec<&str> = batch["steps"].as_array().unwrap().iter().map(|s| s["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["ok", "failed", "not-run"]);
    assert_eq!(batch["waited"]["reason"], json!("quiet"));
    assert!(batch["observation"]["text"].as_str().unwrap().contains("= \"one\""));
    assert_eq!(w.kind("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": "old", "action": { "action": "set_value", "element": 2, "value": "x" }, "tiers": ["ax"] })), "stale_element");
    let none = w.ok("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": epoch, "action": { "action": "set_value", "element": 2, "value": "z" }, "tiers": ["ax"], "observe": { "mode": "none" } }));
    assert!(none.get("observation").is_none());
    assert_eq!(none["step"]["element"]["line"], json!("text area \"Text editor\" = \"one\" focused"));
}

#[test]
fn shutdown_is_answered_then_the_service_ends() {
    let mut w = Wire::start(Fake::default());
    init(&mut w);
    assert_eq!(w.ok("shutdown", json!({})), json!({}));
}

#[test]
fn shutdown_before_initialize_is_answered() {
    let mut w = Wire::start(Fake::default());
    assert_eq!(w.ok("shutdown", json!({})), json!({}));
}

#[test]
fn an_empty_batch_and_no_tiers_are_bad_params_and_an_old_epoch_under_expect_focus_is_stale() {
    let mut w = Wire::start(Fake::default());
    init(&mut w);
    w.ok("session.open", json!({ "session": "s" }));
    let empty = w.call("action.batch", json!({ "session": "s", "app": { "app": "Notepad" }, "actions": [], "tiers": ["ax"] }));
    assert_eq!(empty["error"]["code"], json!(-32602));
    let no_tiers = w.call("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "action": { "action": "wait", "duration": 0.1 }, "tiers": [] }));
    assert_eq!(no_tiers["error"]["code"], json!(-32602));
    let kind = w.kind("action.run", json!({ "session": "s", "app": { "app": "Notepad" }, "epoch": "old", "expectFocus": 2, "action": { "action": "wait", "duration": 0.1 }, "tiers": ["ax"] }));
    assert_eq!(kind, "stale_element");
}

#[test]
fn a_handler_that_panics_is_answered_and_frees_its_slot() {
    let mut w = Wire::start(Fake { panics: true, ..Default::default() });
    init(&mut w);
    w.ok("session.open", json!({ "session": "s" }));
    for _ in 0..40 {
        let f = w.call("state.get", json!({ "session": "s", "app": { "app": "Notepad" } }));
        assert_eq!(f["error"]["code"], json!(-32603), "{f}");
        assert!(f["error"]["message"].as_str().unwrap().contains("the reader fell over"));
    }
    assert_eq!(w.ok("apps.list", json!({}))["apps"][0]["name"], json!("Notepad"), "40 faults later the service still answers");
}
